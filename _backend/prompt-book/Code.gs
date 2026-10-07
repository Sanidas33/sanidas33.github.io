/**
 * Drinks by Neat — free-book lead capture (Google Apps Script web app).
 *
 * Two books share this one script, one Google Sheet and one set of Script Properties:
 *   bartender (default)  /prompt-book/  "The Bartender's AI Prompt Book"      -> tab "Leads"
 *   bcb                  /bcb/          "Running a Spirits Brand with AI"     -> tab "BCB Leads"
 * A request without a `book` field is the bartender book, exactly as in v1.
 *
 * What it does
 *   POST  (JSON body, optional book)          -> validates the form, appends a row to that book's tab,
 *                                                emails that book's PDF (as an attachment) from the
 *                                                deploying account, returns a short-lived download token.
 *   GET   ?action=pdf&t=<token>[&part=<n>]    -> returns the PDF as base64 JSON. The token remembers the book.
 *                                                Without `part`: the whole file (v1 behaviour).
 *                                                With `part`: one chunk + `parts` total, so a browser never
 *                                                has to pull a 1 MB+ response through Google's redirect.
 *   GET   ?action=export&key=<secret>[&book=bcb] -> CSV export of one book's tab.
 *   POST  {action:"delete", key, email}       -> erases every row for that email in BOTH tabs (GDPR helper).
 *   GET   (no action)                         -> health check.
 *
 * The PDFs are never public: they sit unshared in the owner's Google Drive and are only returned
 * to a browser holding a fresh token issued by a valid submission.
 *
 * One-time setup: see README.md next to this file (run setup(), then Deploy > Web app).
 */

var CONFIG = {
  SPREADSHEET_TITLE: 'Drinks by Neat — Prompt Book Leads',
  FROM_NAME: 'Andreas Sanidiotis · Drinks by Neat',
  REPLY_TO: 'sani@drinksbyneat.com',
  TOKEN_TTL_SECONDS: 1800,          // download link lives 30 minutes
  TOKEN_MAX_USES: 5,                // counted per download (part 0 / whole file), not per chunk
  PDF_CHUNK_BYTES: 196608,          // 192 KB raw (multiple of 3, so each base64 chunk decodes on its own)
  MIN_FILL_MS: 2500,                // faster than this = bot
  MAX_SUBMITS_PER_EMAIL_10MIN: 3    // stops someone email-bombing a stranger
};

// v1 names kept so nothing that referenced them breaks.
var HEADERS = [
  'lead_id', 'submitted_at', 'name', 'email', 'role', 'company', 'city', 'phone', 'src',
  'consent_book', 'consent_book_at', 'marketing_opt_in', 'marketing_opt_in_at',
  'privacy_version', 'email_status', 'downloads', 'last_download_at', 'page', 'user_agent'
];

var BCB_HEADERS = [
  'lead_id', 'submitted_at', 'name', 'email', 'role', 'company', 'brand', 'phone', 'src',
  'consent_book', 'consent_book_at', 'marketing_opt_in', 'marketing_opt_in_at',
  'privacy_version', 'email_status', 'downloads', 'last_download_at', 'page', 'user_agent'
];

var BOOKS = {
  bartender: {
    id: 'bartender',
    tab: 'Leads',
    headers: HEADERS,
    pdfProp: 'PDF_FILE_ID',
    pdfNameContains: 'Prompt Book',
    downloadFilename: 'The-Bartenders-AI-Prompt-Book-Drinks-by-Neat.pdf',
    exportFilename: 'prompt-book-leads.csv',
    privacyVersion: '2026-09-30',
    roles: ['Bartender', 'Head Bartender', 'Bar Manager', 'Beverage Director', 'Owner', 'F&B Manager', 'Other'],
    requireCity: true,
    rateKeyPrefix: 'rate:'          // v1 key, unchanged
  },
  bcb: {
    id: 'bcb',
    tab: 'BCB Leads',
    headers: BCB_HEADERS,
    pdfProp: 'BCB_PDF_FILE_ID',
    pdfNameContains: 'Spirits Brand',
    downloadFilename: 'Running-a-Spirits-Brand-with-AI-Drinks-by-Neat.pdf',
    exportFilename: 'bcb-leads.csv',
    privacyVersion: '2026-10-07',
    roles: ['Founder / Owner', 'Brand Manager', 'Marketing', 'Sales / Trade', 'Brand Ambassador', 'Distributor / Importer', 'Other'],
    requireCity: false,
    rateKeyPrefix: 'rate:bcb:'
  }
};

// v1 compatibility shim (some editor snippets used CONFIG.SHEET_TAB / CONFIG.ROLES).
CONFIG.SHEET_TAB = BOOKS.bartender.tab;
CONFIG.ROLES = BOOKS.bartender.roles;
CONFIG.DOWNLOAD_FILENAME = BOOKS.bartender.downloadFilename;
CONFIG.PRIVACY_VERSION = BOOKS.bartender.privacyVersion;

/** Missing/empty book = bartender (v1). Unknown non-empty value = null (rejected). */
function book_(id) {
  id = String(id == null ? '' : id).trim().toLowerCase();
  if (!id) return BOOKS.bartender;
  return BOOKS.hasOwnProperty(id) ? BOOKS[id] : null;
}

/* ------------------------------------------------------------------ setup */

/**
 * Run once from the editor (safe to re-run). Creates/opens the sheet, makes sure both tabs exist
 * with headers, finds both PDFs, creates the export secret. Never touches existing rows.
 */
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
  // Bartender tab: v1 renamed the first sheet; keep doing that on a brand-new spreadsheet.
  if (!ss.getSheetByName(BOOKS.bartender.tab)) {
    var first = ss.getSheets()[0];
    if (first.getLastRow() === 0 && first.getName() !== BOOKS.bcb.tab) first.setName(BOOKS.bartender.tab);
  }
  Object.keys(BOOKS).forEach(function (k) { ensureTab_(ss, BOOKS[k]); });

  Object.keys(BOOKS).forEach(function (k) {
    var b = BOOKS[k];
    var id = props.getProperty(b.pdfProp);
    if (!id) {
      var files = DriveApp.searchFiles(
        "title contains '" + b.pdfNameContains + "' and mimeType = 'application/pdf' and trashed = false");
      while (files.hasNext()) {
        var f = files.next();
        // never let one book pick up the other book's PDF
        var taken = Object.keys(BOOKS).some(function (o) { return o !== k && props.getProperty(BOOKS[o].pdfProp) === f.getId(); });
        if (!taken) { id = f.getId(); break; }
      }
      if (!id) {
        throw new Error('Upload the ' + b.id + ' PDF to this account\'s Google Drive first ' +
          '(file name containing "' + b.pdfNameContains + '"), or set ' + b.pdfProp + ' in Script Properties.');
      }
      props.setProperty(b.pdfProp, id);
    }
    var pdf = DriveApp.getFileById(id);
    Logger.log(b.id + ' PDF: ' + pdf.getName() + ' (' + pdf.getSize() + ' bytes) — keep it unshared.');
  });
  if (props.getProperty(BOOKS.bartender.pdfProp) === props.getProperty(BOOKS.bcb.pdfProp)) {
    throw new Error('PDF_FILE_ID and BCB_PDF_FILE_ID point at the same file. Fix one in Script Properties.');
  }

  if (!props.getProperty('EXPORT_KEY')) {
    props.setProperty('EXPORT_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }

  Logger.log('Leads sheet: ' + ss.getUrl() + ' (tabs: ' + BOOKS.bartender.tab + ', ' + BOOKS.bcb.tab + ')');
  Logger.log('Mail quota left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('CSV export key is in Project Settings > Script Properties > EXPORT_KEY.');
}

function ensureTab_(ss, b) {
  var sheet = ss.getSheetByName(b.tab);
  if (!sheet) sheet = ss.insertSheet(b.tab);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(b.headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, b.headers.length).setFontWeight('bold');
  }
  return sheet;
}

/* ------------------------------------------------------------------ http */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'pdf') return pdfResponse_(p.t, p.part);
    if (p.action === 'export') return exportCsv_(p.key, p.book);
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
  var b = book_(d.book);
  if (!b) return json_({ ok: false, error: 'validation', fields: { book: 'invalid' } });

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
    brand: clean_(d.brand, 160),
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
  if (b.roles.indexOf(lead.role) === -1) errors.role = 'invalid';
  if (!lead.company) errors.company = 'required';
  if (b.requireCity && !lead.city) errors.city = 'required';
  if (lead.phone && !/^[0-9+()\/.\s-]{5,40}$/.test(lead.phone)) errors.phone = 'invalid';
  if (!lead.consentBook) errors.consent_book = 'required';
  if (Object.keys(errors).length) return json_({ ok: false, error: 'validation', fields: errors });

  var cache = CacheService.getScriptCache();
  var rateKey = b.rateKeyPrefix + Utilities.base64EncodeWebSafe(lead.email).slice(0, 200);
  var count = Number(cache.get(rateKey) || 0);
  if (count >= CONFIG.MAX_SUBMITS_PER_EMAIL_10MIN) return json_({ ok: false, error: 'rate_limited' });
  cache.put(rateKey, String(count + 1), 600);

  var now = new Date().toISOString();
  var leadId = Utilities.getUuid();
  var values = {
    lead_id: leadId, submitted_at: now, name: lead.name, email: lead.email, role: lead.role,
    company: lead.company, city: lead.city, brand: lead.brand, phone: lead.phone, src: lead.src || 'direct',
    consent_book: true, consent_book_at: now, marketing_opt_in: lead.marketing, marketing_opt_in_at: lead.marketing ? now : '',
    privacy_version: b.privacyVersion, email_status: 'pending', downloads: 0, last_download_at: '',
    page: lead.page, user_agent: lead.ua
  };
  var row = b.headers.map(function (h) { return values.hasOwnProperty(h) ? values[h] : ''; });

  var sheet = sheet_(b);
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    sheet.appendRow(row.map(safeCell_));
  } finally {
    lock.releaseLock();
  }

  var emailStatus = sendBookEmail_(b, lead);
  setCell_(sheet, b, leadId, 'email_status', emailStatus);

  var token = Utilities.getUuid().replace(/-/g, '');
  cache.put('dl:' + token, JSON.stringify({ leadId: leadId, uses: 0, book: b.id }), CONFIG.TOKEN_TTL_SECONDS);

  return json_({ ok: true, token: token, emailed: emailStatus === 'sent', firstName: lead.name.split(/\s+/)[0] });
}

function sendBookEmail_(b, lead) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) return 'quota_exceeded';
    var first = lead.name.split(/\s+/)[0];
    var pdf = DriveApp.getFileById(prop_(b.pdfProp)).getBlob().setName(b.downloadFilename);
    var mail = b.id === 'bcb' ? bcbEmail_(first, lead) : bartenderEmail_(first, lead);
    MailApp.sendEmail({
      to: lead.email,
      subject: mail.subject,
      body: mail.text,
      htmlBody: mail.html,
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

/** v1 email, word for word. */
function bartenderEmail_(first, lead) {
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
  return { subject: 'Your copy: The Bartender\'s AI Prompt Book', text: text, html: html };
}

/**
 * BCB email (copy from DBN Content). The call-link sentence only goes to people who ticked the
 * marketing opt-in; everyone else gets a plain delivery email.
 */
function bcbEmail_(first, lead) {
  var CALL_URL = 'https://drinksbyneat.com/ai/';
  var text = [
    'Hi ' + first + ',',
    '',
    'Thanks for stopping by at BCB. Your copy is attached.',
    '',
    'Start with "Your brand, loaded," the one page that makes every answer fit your brand. The rule inside is simple: use it yourself when only you see the output, and bring someone in when customers, reps, or your data are involved.',
    '',
    lead.marketing
      ? 'If you want help with that part, reply here or book a 15-minute call: ' + CALL_URL
      : 'If you have questions, just reply.',
    '',
    'Andreas',
    '',
    '—',
    'Andreas Sanidiotis · Drinks by Neat',
    'drinksbyneat.com · sani@drinksbyneat.com',
    '',
    'You\'re getting this because you asked for the book at drinksbyneat.com/bcb/.',
    lead.marketing
      ? 'You also opted in to hear from Drinks by Neat about AI for spirits brands. Reply "unsubscribe" any time.'
      : 'This is a one-off email. We won\'t add you to a mailing list.',
    'Privacy and deletion: https://drinksbyneat.com/bcb/privacy/'
  ].join('\n');
  var html =
    '<div style="font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#111;max-width:560px">' +
    '<p>Hi ' + esc_(first) + ',</p>' +
    '<p>Thanks for stopping by at BCB. Your copy is attached.</p>' +
    '<p>Start with <strong>“Your brand, loaded,”</strong> the one page that makes every answer fit your brand. ' +
    'The rule inside is simple: use it yourself when only you see the output, and bring someone in when customers, reps, or your data are involved.</p>' +
    (lead.marketing
      ? '<p>If you want help with that part, reply here or <a href="' + CALL_URL + '" style="color:#6B6E14">book a 15-minute call</a>.</p>'
      : '<p>If you have questions, just reply.</p>') +
    '<p>Andreas</p>' +
    '<p style="font-family:Arial,sans-serif;font-size:13px;color:#4a4a4a;border-top:1px solid #ddd;padding-top:12px;margin-top:24px">' +
    'Andreas Sanidiotis · Drinks by Neat<br>' +
    '<a href="https://drinksbyneat.com" style="color:#6B6E14">drinksbyneat.com</a> · ' +
    '<a href="mailto:sani@drinksbyneat.com" style="color:#6B6E14">sani@drinksbyneat.com</a><br><br>' +
    'You\'re getting this because you asked for the book at drinksbyneat.com/bcb/. ' +
    (lead.marketing
      ? 'You also opted in to hear from Drinks by Neat about AI for spirits brands. Reply "unsubscribe" any time. '
      : 'This is a one-off email. We won\'t add you to a mailing list. ') +
    '<a href="https://drinksbyneat.com/bcb/privacy/" style="color:#6B6E14">Privacy &amp; deletion</a>.</p>' +
    '</div>';
  return { subject: 'Your copy: Running a Spirits Brand with AI', text: text, html: html };
}

/* ------------------------------------------------------------------ download */

function pdfResponse_(token, part) {
  token = String(token || '').replace(/[^a-f0-9]/g, '');
  if (!token) return json_({ ok: false, error: 'bad_token' });
  var chunked = part !== undefined && part !== null && part !== '';
  var n = chunked ? Math.floor(Number(part)) : 0;
  if (chunked && !(n >= 0)) return json_({ ok: false, error: 'bad_part' });

  var cache = CacheService.getScriptCache();
  var raw = cache.get('dl:' + token);
  if (!raw) return json_({ ok: false, error: 'expired' });
  var t = JSON.parse(raw);
  var b = book_(t.book) || BOOKS.bartender;   // v1 tokens have no book -> bartender
  var firstHit = !chunked || n === 0;          // count one "use" per download, not per chunk
  if (firstHit) {
    if (t.uses >= CONFIG.TOKEN_MAX_USES) return json_({ ok: false, error: 'expired' });
    t.uses += 1;
    cache.put('dl:' + token, JSON.stringify(t), CONFIG.TOKEN_TTL_SECONDS);
  } else if (!t.uses) {
    return json_({ ok: false, error: 'bad_part' });  // chunks only after part 0
  }

  var bytes = DriveApp.getFileById(prop_(b.pdfProp)).getBlob().getBytes();
  if (firstHit) {
    try {
      var sheet = sheet_(b);
      var cur = Number(getCell_(sheet, b, t.leadId, 'downloads') || 0);
      setCell_(sheet, b, t.leadId, 'downloads', cur + 1);
      setCell_(sheet, b, t.leadId, 'last_download_at', new Date().toISOString());
    } catch (err) { console.error(err); }
  }

  if (!chunked) {
    return json_({ ok: true, filename: b.downloadFilename, mime: 'application/pdf', data: Utilities.base64Encode(bytes) });
  }
  var size = CONFIG.PDF_CHUNK_BYTES;
  var parts = Math.max(1, Math.ceil(bytes.length / size));
  if (n >= parts) return json_({ ok: false, error: 'bad_part' });
  return json_({
    ok: true,
    filename: b.downloadFilename,
    mime: 'application/pdf',
    part: n,
    parts: parts,
    bytes: bytes.length,
    data: Utilities.base64Encode(bytes.slice(n * size, (n + 1) * size))
  });
}

/* ------------------------------------------------------------------ admin */

function exportCsv_(key, bookId) {
  if (!keyOk_(key)) return json_({ ok: false, error: 'forbidden' });
  var b = book_(bookId);
  if (!b) return json_({ ok: false, error: 'bad_book' });
  var values = sheet_(b).getDataRange().getValues();
  var csv = values.map(function (r) {
    return r.map(function (v) {
      var s = v instanceof Date ? v.toISOString() : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
  return ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV)
    .downloadAsFile(b.exportFilename);
}

function deleteByEmail_(key, email) {
  if (!keyOk_(key)) return json_({ ok: false, error: 'forbidden' });
  var byTab = deleteLeadsByEmailDetailed_(email);
  var total = 0;
  Object.keys(byTab).forEach(function (k) { total += byTab[k]; });
  return json_({ ok: true, deleted: total, by_tab: byTab });
}

/** Also runnable from the editor: deleteLeadsByEmail('someone@example.com') — clears BOTH tabs, returns the total. */
function deleteLeadsByEmail(email) {
  var byTab = deleteLeadsByEmailDetailed_(email);
  var total = 0;
  Object.keys(byTab).forEach(function (k) { total += byTab[k]; });
  return total;
}

function deleteLeadsByEmailDetailed_(email) {
  email = String(email || '').trim().toLowerCase();
  var out = {};
  if (!email) return out;
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    Object.keys(BOOKS).forEach(function (k) {
      var b = BOOKS[k];
      var sheet = ss.getSheetByName(b.tab);
      out[b.tab] = 0;
      if (!sheet || sheet.getLastRow() < 2) return;
      var col = b.headers.indexOf('email') + 1;
      var values = sheet.getRange(1, col, sheet.getLastRow(), 1).getValues();
      for (var i = values.length - 1; i >= 1; i--) {
        if (String(values[i][0]).trim().toLowerCase() === email) { sheet.deleteRow(i + 1); out[b.tab]++; }
      }
    });
  } finally {
    lock.releaseLock();
  }
  return out;
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

/** The tab for a book (bartender when omitted). Creates the tab with headers if setup() wasn't re-run. */
function sheet_(b) {
  b = b || BOOKS.bartender;
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var sheet = ss.getSheetByName(b.tab);
  if (sheet && sheet.getLastRow() > 0) return sheet;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return ensureTab_(ss, b);
  } finally {
    lock.releaseLock();
  }
}

function findRow_(sheet, leadId) {
  var hit = sheet.createTextFinder(leadId).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function getCell_(sheet, b, leadId, header) {
  var r = findRow_(sheet, leadId);
  return r ? sheet.getRange(r, b.headers.indexOf(header) + 1).getValue() : '';
}

function setCell_(sheet, b, leadId, header, value) {
  var r = findRow_(sheet, leadId);
  if (r) sheet.getRange(r, b.headers.indexOf(header) + 1).setValue(value);
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
