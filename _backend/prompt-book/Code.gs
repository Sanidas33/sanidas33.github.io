/**
 * Drinks by Neat — Prompt Book lead capture (Google Apps Script web app).
 *
 * What it does
 *   POST  (JSON body)                 -> validates the form, appends a row to the "Leads" sheet,
 *                                        emails the PDF (as an attachment) from the deploying
 *                                        account, returns a short-lived download token.
 *   GET   ?action=pdf&t=<token>       -> returns the PDF as base64 JSON (token expires, limited uses).
 *   GET   ?action=export&key=<secret> -> CSV export of every lead (secret lives in Script Properties).
 *   POST  {action:"delete", key, email} -> erases every row for that email (GDPR erasure helper).
 *   GET   (no action)                 -> health check.
 *
 * The PDF is never public: it sits unshared in the owner's Google Drive and is only returned
 * to a browser holding a fresh token issued by a valid submission.
 *
 * One-time setup: see README.md next to this file (run setup(), then Deploy > Web app).
 */

var CONFIG = {
  SHEET_TAB: 'Leads',
  SPREADSHEET_TITLE: 'Drinks by Neat — Prompt Book Leads',
  PDF_NAME_CONTAINS: 'Prompt Book',
  DOWNLOAD_FILENAME: 'The-Bartenders-AI-Prompt-Book-Drinks-by-Neat.pdf',
  FROM_NAME: 'Andreas Sanidiotis · Drinks by Neat',
  REPLY_TO: 'sani@drinksbyneat.com',
  TOKEN_TTL_SECONDS: 1800,          // download link lives 30 minutes
  TOKEN_MAX_USES: 5,
  MIN_FILL_MS: 2500,                // faster than this = bot
  MAX_SUBMITS_PER_EMAIL_10MIN: 3,   // stops someone email-bombing a stranger
  PRIVACY_VERSION: '2026-09-30',
  ROLES: ['Bartender', 'Head Bartender', 'Bar Manager', 'Beverage Director', 'Owner', 'F&B Manager', 'Other']
};

var HEADERS = [
  'lead_id', 'submitted_at', 'name', 'email', 'role', 'company', 'city', 'phone', 'src',
  'consent_book', 'consent_book_at', 'marketing_opt_in', 'marketing_opt_in_at',
  'privacy_version', 'email_status', 'downloads', 'last_download_at', 'page', 'user_agent'
];

/* ------------------------------------------------------------------ setup */

/** Run once from the editor. Creates the sheet, finds the PDF, creates the export secret. */
function setup() {
  var props = PropertiesService.getScriptProperties();

  var ssId = props.getProperty('SHEET_ID');
  var ss;
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_TITLE);
    props.setProperty('SHEET_ID', ss.getId());
  }
  var sheet = ss.getSheetByName(CONFIG.SHEET_TAB);
  if (!sheet) {
    sheet = ss.getSheets()[0];
    sheet.setName(CONFIG.SHEET_TAB);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }

  var pdfId = props.getProperty('PDF_FILE_ID');
  if (!pdfId) {
    var files = DriveApp.searchFiles(
      "title contains '" + CONFIG.PDF_NAME_CONTAINS + "' and mimeType = 'application/pdf' and trashed = false");
    if (!files.hasNext()) {
      throw new Error('Upload the Prompt Book PDF to this account\'s Google Drive first ' +
        '(file name containing "' + CONFIG.PDF_NAME_CONTAINS + '"), or set PDF_FILE_ID in Script Properties.');
    }
    pdfId = files.next().getId();
    props.setProperty('PDF_FILE_ID', pdfId);
  }
  var pdf = DriveApp.getFileById(pdfId);

  if (!props.getProperty('EXPORT_KEY')) {
    props.setProperty('EXPORT_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }

  Logger.log('Leads sheet: ' + ss.getUrl());
  Logger.log('PDF: ' + pdf.getName() + ' (' + pdf.getSize() + ' bytes) — keep it unshared.');
  Logger.log('Mail quota left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('CSV export key is in Project Settings > Script Properties > EXPORT_KEY.');
}

/* ------------------------------------------------------------------ http */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'pdf') return pdfResponse_(p.t);
    if (p.action === 'export') return exportCsv_(p.key);
    return json_({ ok: true, service: 'prompt-book' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server_error' });
  }
}

function doPost(e) {
  try {
    var data = parseBody_(e);
    if (data.action === 'delete') return deleteByEmail_(data.key, data.email);
    return handleLead_(data);
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server_error' });
  }
}

/* ------------------------------------------------------------------ lead */

function handleLead_(d) {
  // Spam: honeypot filled or form submitted inhumanly fast. Pretend success, store nothing.
  var elapsed = Number(d.elapsed_ms || 0);
  if (clean_(d.website, 200) || (elapsed && elapsed < CONFIG.MIN_FILL_MS)) {
    return json_({ ok: true, token: null });
  }

  var lead = {
    name: clean_(d.name, 100),
    email: clean_(d.email, 254).toLowerCase(),
    role: clean_(d.role, 40),
    company: clean_(d.company, 120),
    city: clean_(d.city, 80),
    phone: clean_(d.phone, 40),
    src: String(d.src || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60),
    consentBook: d.consent_book === true || d.consent_book === 'true' || d.consent_book === 'on',
    marketing: d.marketing_opt_in === true || d.marketing_opt_in === 'true' || d.marketing_opt_in === 'on',
    page: clean_(d.page, 300),
    ua: clean_(d.user_agent, 300)
  };

  var errors = {};
  if (!lead.name) errors.name = 'required';
  if (!isEmail_(lead.email)) errors.email = 'invalid';
  if (CONFIG.ROLES.indexOf(lead.role) === -1) errors.role = 'invalid';
  if (!lead.company) errors.company = 'required';
  if (!lead.city) errors.city = 'required';
  if (lead.phone && !/^[0-9+()\/.\s-]{5,40}$/.test(lead.phone)) errors.phone = 'invalid';
  if (!lead.consentBook) errors.consent_book = 'required';
  if (Object.keys(errors).length) return json_({ ok: false, error: 'validation', fields: errors });

  var cache = CacheService.getScriptCache();
  var rateKey = 'rate:' + Utilities.base64EncodeWebSafe(lead.email).slice(0, 200);
  var count = Number(cache.get(rateKey) || 0);
  if (count >= CONFIG.MAX_SUBMITS_PER_EMAIL_10MIN) return json_({ ok: false, error: 'rate_limited' });
  cache.put(rateKey, String(count + 1), 600);

  var now = new Date().toISOString();
  var leadId = Utilities.getUuid();
  var row = [
    leadId, now, lead.name, lead.email, lead.role, lead.company, lead.city, lead.phone, lead.src || 'direct',
    true, now, lead.marketing, lead.marketing ? now : '',
    CONFIG.PRIVACY_VERSION, 'pending', 0, '', lead.page, lead.ua
  ];

  var sheet = sheet_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet.appendRow(row.map(safeCell_));
  } finally {
    lock.releaseLock();
  }

  var emailStatus = sendBookEmail_(lead);
  setCell_(sheet, leadId, 'email_status', emailStatus);

  var token = Utilities.getUuid().replace(/-/g, '');
  cache.put('dl:' + token, JSON.stringify({ leadId: leadId, uses: 0 }), CONFIG.TOKEN_TTL_SECONDS);

  return json_({ ok: true, token: token, emailed: emailStatus === 'sent', firstName: lead.name.split(/\s+/)[0] });
}

function sendBookEmail_(lead) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) return 'quota_exceeded';
    var first = lead.name.split(/\s+/)[0];
    var pdf = DriveApp.getFileById(prop_('PDF_FILE_ID')).getBlob().setName(CONFIG.DOWNLOAD_FILENAME);
    var text = [
      'Hi ' + first + ',',
      '',
      'Thanks for grabbing The Bartender\'s AI Prompt Book. Your copy is attached.',
      '',
      'Start with the Bar Context File on page 5. It takes ten minutes, and it makes every answer fit your bar. Then pick one of the eight guided builds and run it start to finish in one chat.',
      '',
      'If something clicks, or doesn\'t, just reply. I read everything.',
      '',
      'Pour something good,',
      'Andreas',
      '',
      '—',
      'Andreas Sanidiotis · Drinks by Neat',
      'drinksbyneat.com · sani@drinksbyneat.com',
      '',
      'You\'re getting this because you asked for the book at drinksbyneat.com/prompt-book/.',
      lead.marketing
        ? 'You also opted in to occasional Drinks by Neat emails. Reply "unsubscribe" any time.'
        : 'This is a one-off email. We won\'t add you to a newsletter.',
      'Privacy and deletion: https://drinksbyneat.com/prompt-book/privacy/'
    ].join('\n');
    var html =
      '<div style="font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#111;max-width:560px">' +
      '<p>Hi ' + esc_(first) + ',</p>' +
      '<p>Thanks for grabbing <em>The Bartender\'s AI Prompt Book</em>. Your copy is attached.</p>' +
      '<p>Start with the <strong>Bar Context File</strong> on page 5. It takes ten minutes, and it makes every answer fit your bar. ' +
      'Then pick one of the eight guided builds and run it start to finish in one chat.</p>' +
      '<p>If something clicks, or doesn\'t, just reply. I read everything.</p>' +
      '<p>Pour something good,<br>Andreas</p>' +
      '<p style="font-family:Arial,sans-serif;font-size:13px;color:#4a4a4a;border-top:1px solid #ddd;padding-top:12px;margin-top:24px">' +
      'Andreas Sanidiotis · Drinks by Neat<br>' +
      '<a href="https://drinksbyneat.com" style="color:#6B6E14">drinksbyneat.com</a> · ' +
      '<a href="mailto:sani@drinksbyneat.com" style="color:#6B6E14">sani@drinksbyneat.com</a><br><br>' +
      'You\'re getting this because you asked for the book at drinksbyneat.com/prompt-book/. ' +
      (lead.marketing
        ? 'You also opted in to occasional Drinks by Neat emails. Reply "unsubscribe" any time. '
        : 'This is a one-off email. We won\'t add you to a newsletter. ') +
      '<a href="https://drinksbyneat.com/prompt-book/privacy/" style="color:#6B6E14">Privacy &amp; deletion</a>.</p>' +
      '</div>';
    MailApp.sendEmail({
      to: lead.email,
      subject: 'Your copy: The Bartender\'s AI Prompt Book',
      body: text,
      htmlBody: html,
      name: CONFIG.FROM_NAME,
      replyTo: CONFIG.REPLY_TO,
      attachments: [pdf]
    });
    return 'sent';
  } catch (err) {
    console.error('mail failed', err);
    return 'failed';
  }
}

/* ------------------------------------------------------------------ download */

function pdfResponse_(token) {
  token = String(token || '').replace(/[^a-f0-9]/g, '');
  if (!token) return json_({ ok: false, error: 'bad_token' });
  var cache = CacheService.getScriptCache();
  var raw = cache.get('dl:' + token);
  if (!raw) return json_({ ok: false, error: 'expired' });
  var t = JSON.parse(raw);
  if (t.uses >= CONFIG.TOKEN_MAX_USES) return json_({ ok: false, error: 'expired' });
  t.uses += 1;
  cache.put('dl:' + token, JSON.stringify(t), CONFIG.TOKEN_TTL_SECONDS);

  var blob = DriveApp.getFileById(prop_('PDF_FILE_ID')).getBlob();
  try {
    var sheet = sheet_();
    var cur = Number(getCell_(sheet, t.leadId, 'downloads') || 0);
    setCell_(sheet, t.leadId, 'downloads', cur + 1);
    setCell_(sheet, t.leadId, 'last_download_at', new Date().toISOString());
  } catch (err) { console.error(err); }

  return json_({
    ok: true,
    filename: CONFIG.DOWNLOAD_FILENAME,
    mime: 'application/pdf',
    data: Utilities.base64Encode(blob.getBytes())
  });
}

/* ------------------------------------------------------------------ admin */

function exportCsv_(key) {
  if (!keyOk_(key)) return json_({ ok: false, error: 'forbidden' });
  var values = sheet_().getDataRange().getValues();
  var csv = values.map(function (r) {
    return r.map(function (v) {
      var s = v instanceof Date ? v.toISOString() : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
  return ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV)
    .downloadAsFile('prompt-book-leads.csv');
}

function deleteByEmail_(key, email) {
  if (!keyOk_(key)) return json_({ ok: false, error: 'forbidden' });
  return json_({ ok: true, deleted: deleteLeadsByEmail(email) });
}

/** Also runnable from the editor: deleteLeadsByEmail('someone@example.com') */
function deleteLeadsByEmail(email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return 0;
  var sheet = sheet_();
  var col = HEADERS.indexOf('email') + 1;
  var deleted = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var values = sheet.getRange(1, col, sheet.getLastRow(), 1).getValues();
    for (var i = values.length - 1; i >= 1; i--) {
      if (String(values[i][0]).trim().toLowerCase() === email) { sheet.deleteRow(i + 1); deleted++; }
    }
  } finally {
    lock.releaseLock();
  }
  return deleted;
}

/* ------------------------------------------------------------------ helpers */

function parseBody_(e) {
  var body = e && e.postData && e.postData.contents;
  if (body) {
    try { return JSON.parse(body); } catch (err) { /* fall through to form params */ }
  }
  return (e && e.parameter) || {};
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(name) {
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Missing Script Property ' + name + ' — run setup() first.');
  return v;
}

function sheet_() {
  return SpreadsheetApp.openById(prop_('SHEET_ID')).getSheetByName(CONFIG.SHEET_TAB);
}

function findRow_(sheet, leadId) {
  var hit = sheet.createTextFinder(leadId).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function getCell_(sheet, leadId, header) {
  var r = findRow_(sheet, leadId);
  return r ? sheet.getRange(r, HEADERS.indexOf(header) + 1).getValue() : '';
}

function setCell_(sheet, leadId, header, value) {
  var r = findRow_(sheet, leadId);
  if (r) sheet.getRange(r, HEADERS.indexOf(header) + 1).setValue(value);
}

function keyOk_(key) {
  var expected = PropertiesService.getScriptProperties().getProperty('EXPORT_KEY') || '';
  key = String(key || '');
  if (!expected || key.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Stop spreadsheet formula injection (=, +, -, @ at the start of a cell). */
function safeCell_(v) {
  return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v;
}

function isEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
