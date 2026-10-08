/**
 * Drinks by Neat — free-book lead capture (Google Apps Script web app).  v3
 *
 * Two books share this one script, one Google Sheet and one set of Script Properties:
 *   bartender (default)  /prompt-book/  "The Bartender's AI Prompt Book"      -> tab "Bar Book"     (was "Leads")
 *   bcb                  /bcb/          "Running a Spirits Brand with AI"     -> tab "Spirits Book" (was "BCB Leads")
 * A request without a `book` field is the bartender book, exactly as in v1.
 * Old tab names are renamed in place (rows kept) the first time the script touches them.
 *
 * What it does
 *   POST  (JSON body, optional book)          -> validates the form, appends a row to that book's tab with a
 *                                                personal download token (30 days, 20 downloads), and ALWAYS
 *                                                emails a "Download your copy" link. The PDF is attached too
 *                                                when Drive allows; if not, the same email goes out without it.
 *                                                If anything fails, sani@ gets a short alert.
 *   GET   ?action=pdf&t=<token>[&part=<n>][&book=<id>]
 *                                             -> returns the PDF as base64 JSON. The token row knows the book
 *                                                (`book` is only a hint for which tab to search first).
 *                                                Without `part`: the whole file (v1 behaviour).
 *                                                With `part`: one chunk + `parts` total.
 *   GET   ?action=export&key=<secret>[&book=bcb] -> CSV export of one book's tab.
 *   POST  {action:"delete", key, email}       -> erases every row for that email in BOTH tabs (GDPR helper).
 *   GET   (no action)                         -> health check.
 *
 * Editor functions: setup(), selfTest() (read-only check, sends nothing), deleteLeadsByEmail(email),
 * resendBookEmail(email, book) (re-sends the link email to one person, on purpose only).
 *
 * The PDFs are never public: they sit unshared in the owner's Google Drive and are only returned
 * to a browser holding a valid token issued by a real submission.
 *
 * One-time setup: see README.md next to this file.
 */

var CONFIG = {
  SPREADSHEET_TITLE: 'Drinks by Neat — Prompt Book Leads',
  FROM_NAME: 'Andreas Sanidiotis · Drinks by Neat',
  REPLY_TO: 'sani@drinksbyneat.com',
  ALERT_TO: 'sani@drinksbyneat.com',   // gets a short note when a delivery has a problem
  SITE_URL: 'https://drinksbyneat.com',
  TOKEN_TTL_SECONDS: 1800,          // fast-path cache for the instant download right after the form
  TOKEN_MAX_USES: 5,                // v2 short tokens: downloads per 30 minutes
  LINK_TTL_DAYS: 30,                // personal email link lifetime
  LINK_MAX_USES: 20,                // personal link: downloads in total (counted per download, not per chunk)
  PDF_CHUNK_BYTES: 196608,          // 192 KB raw (multiple of 3, so each base64 chunk decodes on its own)
  MIN_FILL_MS: 2500,                // faster than this = bot
  MAX_SUBMITS_PER_EMAIL_10MIN: 3    // stops someone email-bombing a stranger
};

// v1 names kept so nothing that referenced them breaks. v3 columns are appended at the END,
// so existing columns never move; setup()/sheet_() add missing trailing headers to existing tabs.
var HEADERS = [
  'lead_id', 'submitted_at', 'name', 'email', 'role', 'company', 'city', 'phone', 'src',
  'consent_book', 'consent_book_at', 'marketing_opt_in', 'marketing_opt_in_at',
  'privacy_version', 'email_status', 'downloads', 'last_download_at', 'page', 'user_agent',
  'download_token', 'download_token_expires'
];

var BCB_HEADERS = [
  'lead_id', 'submitted_at', 'name', 'email', 'role', 'company', 'brand', 'phone', 'src',
  'consent_book', 'consent_book_at', 'marketing_opt_in', 'marketing_opt_in_at',
  'privacy_version', 'email_status', 'downloads', 'last_download_at', 'page', 'user_agent',
  'download_token', 'download_token_expires'
];

var BOOKS = {
  bartender: {
    id: 'bartender',
    title: 'The Bartender\'s AI Prompt Book',
    tab: 'Bar Book',
    legacyTabs: ['Leads'],          // renamed in place to `tab` on first touch (rows kept)
    headers: HEADERS,
    pdfProp: 'PDF_FILE_ID',
    pdfNameContains: ['Prompt Book'],
    downloadFilename: 'The-Bartenders-AI-Prompt-Book-Drinks-by-Neat.pdf',
    downloadPath: '/prompt-book/download/',
    exportFilename: 'prompt-book-leads.csv',
    privacyVersion: '2026-09-30',
    roles: ['Bartender', 'Head Bartender', 'Bar Manager', 'Beverage Director', 'Owner', 'F&B Manager', 'Other'],
    requireCity: true,
    rateKeyPrefix: 'rate:'          // v1 key, unchanged
  },
  bcb: {
    id: 'bcb',
    title: 'Running a Spirits Brand with AI',
    tab: 'Spirits Book',
    legacyTabs: ['BCB Leads'],
    headers: BCB_HEADERS,
    pdfProp: 'BCB_PDF_FILE_ID',
    pdfNameContains: ['Spirits Brand', 'spirits-ai', 'Spirits'],
    downloadFilename: 'Running-a-Spirits-Brand-with-AI-Drinks-by-Neat.pdf',
    downloadPath: '/bcb/download/',
    exportFilename: 'bcb-leads.csv',
    privacyVersion: '2026-10-07',
    roles: ['Founder / Owner', 'Brand Manager', 'Marketing', 'Sales / Trade', 'Brand Ambassador', 'Distributor / Importer', 'Other'],
    requireCity: false,
    rateKeyPrefix: 'rate:bcb:'
  }
};

// v1 compatibility shim (some editor snippets used CONFIG.SHEET_TAB / CONFIG.ROLES). SHEET_TAB is the new name.
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
 * with all headers (adds missing v3 columns at the end), finds both PDFs, creates the export secret.
 * Never touches existing rows. A missing PDF is logged with instructions instead of stopping setup,
 * so one book's problem never leaves the other book half-configured.
 */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var problems = [];

  var ssId = props.getProperty('SHEET_ID');
  var ss;
  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
  } else {
    ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_TITLE);
    props.setProperty('SHEET_ID', ss.getId());
  }
  // Bartender tab: v1 renamed the first sheet; keep doing that on a brand-new spreadsheet
  // (only when neither the new nor an old bartender tab exists, and the first sheet is an empty non-book tab).
  if (!tabFor_(ss, BOOKS.bartender)) {
    var first = ss.getSheets()[0];
    if (first.getLastRow() === 0 && allTabNames_().indexOf(first.getName()) === -1) first.setName(BOOKS.bartender.tab);
  }
  Object.keys(BOOKS).forEach(function (k) {
    var added = [];
    ensureTab_(ss, BOOKS[k], added);
    if (added.length) Logger.log('Added columns to "' + BOOKS[k].tab + '": ' + added.join(', '));
  });

  if (!props.getProperty('EXPORT_KEY')) {
    props.setProperty('EXPORT_KEY', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  }

  Object.keys(BOOKS).forEach(function (k) {
    var b = BOOKS[k];
    try {
      var id = props.getProperty(b.pdfProp);
      if (!id) {
        id = findPdf_(b, props);
        if (!id) {
          problems.push(b.id + ': no PDF found. ' + pdfHelp_(b));
          return;
        }
        props.setProperty(b.pdfProp, id);
      }
      var pdf = DriveApp.getFileById(id);
      Logger.log(b.id + ' PDF: ' + pdf.getName() + ' (' + pdf.getSize() + ' bytes) — keep it unshared.');
    } catch (err) {
      problems.push(b.id + ': ' + b.pdfProp + ' is set but this account can\'t open that file (' + errText_(err) + '). ' + pdfHelp_(b));
    }
  });
  var a = props.getProperty(BOOKS.bartender.pdfProp), c = props.getProperty(BOOKS.bcb.pdfProp);
  if (a && c && a === c) problems.push('PDF_FILE_ID and BCB_PDF_FILE_ID point at the same file. Fix BCB_PDF_FILE_ID in Script Properties.');

  Logger.log('Leads sheet: ' + ss.getUrl() + ' (tabs: ' + BOOKS.bartender.tab + ', ' + BOOKS.bcb.tab + ')');
  Logger.log('Mail quota left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('CSV export key is in Project Settings > Script Properties > EXPORT_KEY.');
  if (problems.length) {
    Logger.log('SETUP NEEDS ONE MORE STEP:\n- ' + problems.join('\n- ') +
      '\nSign-ups still get their email with a download link meanwhile; the PDF attachment and downloads start working once this is fixed. Then run selfTest.');
  } else {
    Logger.log('Setup complete. Run selfTest to double-check.');
  }
  return problems;
}

function findPdf_(b, props) {
  for (var i = 0; i < b.pdfNameContains.length; i++) {
    var files = DriveApp.searchFiles(
      "title contains '" + b.pdfNameContains[i].replace(/'/g, "\\'") + "' and mimeType = 'application/pdf' and trashed = false");
    while (files.hasNext()) {
      var f = files.next();
      // never let one book pick up the other book's PDF
      var taken = Object.keys(BOOKS).some(function (o) { return o !== b.id && props.getProperty(BOOKS[o].pdfProp) === f.getId(); });
      if (!taken) return f.getId();
    }
  }
  return '';
}

function pdfHelp_(b) {
  return 'Upload the PDF to My Drive of the account that owns this script (don\'t share it), then open it in Drive ' +
    'and copy its ID from the address bar (the part between /d/ and /view). In Project Settings > Script Properties, ' +
    'add or edit ' + b.pdfProp + ' = that ID, and save. Or name the file so it contains "' + b.pdfNameContains[0] +
    '" and run setup again.';
}

/**
 * Read-only health check, run from the editor. Logs whether the sheet, columns, both PDFs and the mail quota
 * are OK. Sends no email, writes nothing.
 */
function selfTest() {
  var props = PropertiesService.getScriptProperties();
  var report = [];
  var ok = true;
  var line = function (good, msg) { report.push((good ? 'OK   ' : 'FIX  ') + msg); if (!good) ok = false; };

  try {
    var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
    line(true, 'Spreadsheet opens: ' + ss.getUrl());
    Object.keys(BOOKS).forEach(function (k) {
      var b = BOOKS[k];
      var sh = ss.getSheetByName(b.tab);
      var old = legacyTab_(ss, b);
      if (sh && old) line(true, 'Both "' + b.tab + '" and the old "' + old.getName() + '" exist. The script uses "' + b.tab +
        '". Move any rows you need from "' + old.getName() + '" by hand, then delete it.');
      if (!sh && old) {
        line(true, 'Tab is still called "' + old.getName() + '". setup (or the next sign-up) renames it to "' + b.tab + '", keeping every row.');
        sh = old;
      }
      if (!sh) { line(false, 'Tab "' + b.tab + '" is missing. Run setup.'); return; }
      var have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String) : [];
      var missing = b.headers.filter(function (h) { return have.indexOf(h) === -1; });
      line(!missing.length, 'Tab "' + sh.getName() + '" ' + (missing.length
        ? 'is missing columns ' + missing.join(', ') + '. Run setup (it adds them at the end; nothing moves).'
        : 'has all columns (' + Math.max(0, sh.getLastRow() - 1) + ' rows).'));
    });
  } catch (err) {
    line(false, 'Leads sheet: ' + errText_(err));
  }

  Object.keys(BOOKS).forEach(function (k) {
    var b = BOOKS[k];
    var id = props.getProperty(b.pdfProp);
    if (!id) { line(false, b.id + ' PDF: ' + b.pdfProp + ' is not set. ' + pdfHelp_(b)); return; }
    try {
      var f = DriveApp.getFileById(id);
      var n = f.getBlob().getBytes().length;
      var mime = f.getMimeType ? f.getMimeType() : 'application/pdf';
      line(n > 0 && mime === 'application/pdf',
        b.id + ' PDF readable: ' + f.getName() + ' (' + n + ' bytes, ' + mime + ')');
    } catch (err) {
      line(false, b.id + ' PDF: ' + b.pdfProp + ' = ' + id + ' but this account can\'t read it (' + errText_(err) + '). ' + pdfHelp_(b));
    }
  });
  var a = props.getProperty(BOOKS.bartender.pdfProp), c = props.getProperty(BOOKS.bcb.pdfProp);
  if (a && c) line(a !== c, a !== c ? 'The two books use different PDFs.' : 'Both books point at the same PDF. Fix BCB_PDF_FILE_ID.');

  try {
    var q = MailApp.getRemainingDailyQuota();
    line(q > 0, 'Mail quota left today: ' + q);
  } catch (err) {
    line(false, 'Mail quota check failed (' + errText_(err) + '). Re-authorise the script.');
  }
  line(!!props.getProperty('EXPORT_KEY'), 'EXPORT_KEY ' + (props.getProperty('EXPORT_KEY') ? 'is set.' : 'is missing. Run setup.'));

  Logger.log('selfTest (no emails sent):\n' + report.join('\n'));
  Logger.log(ok ? 'All good.' : 'Fix the FIX lines above, then run selfTest again.');
  return { ok: ok, report: report };
}

/**
 * Creates a missing tab with headers, or adds any missing headers to the END of an existing tab's
 * first row (so no existing column ever moves). `added` (optional array) collects what was added.
 */
function ensureTab_(ss, b, added) {
  var sheet = tabFor_(ss, b);              // renames an old-name tab instead of creating a duplicate
  if (!sheet) sheet = ss.insertSheet(b.tab);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(b.headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, b.headers.length).setFontWeight('bold');
  } else {
    ensureHeaders_(sheet, b, added);
  }
  delete HDR_CACHE_[sheet.getName()];
  return sheet;
}

function ensureHeaders_(sheet, b, added) {
  var width = sheet.getLastColumn();
  var have = width ? sheet.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
  var missing = b.headers.filter(function (h) { return have.indexOf(h) === -1; });
  if (!missing.length) return 0;
  if (typeof sheet.getMaxColumns === 'function' && width + missing.length > sheet.getMaxColumns()) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width + missing.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, width + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  if (added) Array.prototype.push.apply(added, missing);
  delete HDR_CACHE_[sheet.getName()];
  return missing.length;
}

/* ------------------------------------------------------------------ http */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'pdf') return pdfResponse_(p.t, p.part, p.book);
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

  var now = new Date();
  var leadId = Utilities.getUuid();
  var token = newToken_();
  var expires = new Date(now.getTime() + CONFIG.LINK_TTL_DAYS * 86400000).toISOString();
  var values = {
    lead_id: leadId, submitted_at: now.toISOString(), name: lead.name, email: lead.email, role: lead.role,
    company: lead.company, city: lead.city, brand: lead.brand, phone: lead.phone, src: lead.src || 'direct',
    consent_book: true, consent_book_at: now.toISOString(), marketing_opt_in: lead.marketing,
    marketing_opt_in_at: lead.marketing ? now.toISOString() : '',
    privacy_version: b.privacyVersion, email_status: 'pending', downloads: 0, last_download_at: '',
    page: lead.page, user_agent: lead.ua, download_token: token, download_token_expires: expires
  };

  var sheet = sheet_(b);
  withLock_(function () { sheet.appendRow(rowFor_(sheet, b, values).map(safeCell_)); });

  var url = downloadUrl_(b, token);
  var result = sendBookEmail_(b, lead, url);
  try { setCell_(sheet, b, leadId, 'email_status', result.status); } catch (err) { console.error(err); }
  if (result.problems.length) alertOwner_(b, lead, url, result);

  // Same token works for the instant download (fast path via cache) and for the 30-day email link.
  cache.put('dl:' + token, JSON.stringify({ leadId: leadId, uses: 0, book: b.id, p: true }), CONFIG.TOKEN_TTL_SECONDS);

  var emailed = result.status === 'sent' || result.status === 'sent_link_only';
  return json_({ ok: true, token: token, emailed: emailed, linkEmailed: emailed, firstName: lead.name.split(/\s+/)[0] });
}

function newToken_() {
  // 'd' + 63 hex chars: still hex (the pages strip anything else), and never looks like a number to Sheets.
  return ('d' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '')).slice(0, 64);
}

function downloadUrl_(b, token) {
  return CONFIG.SITE_URL + b.downloadPath + '?t=' + token;
}

function readPdf_(b) {
  return DriveApp.getFileById(prop_(b.pdfProp)).getBlob();
}

/**
 * Always tries to get an email out:
 *   1. PDF attached + download link   -> 'sent'
 *   2. same email, link only          -> 'sent_link_only'  (PDF unreadable, or sending with attachment failed)
 *   3. MailApp quota used up / throws -> 'failed_quota' / 'failed'
 * Returns { status, attached, problems[] }. Never throws.
 */
function sendBookEmail_(b, lead, url) {
  var out = { status: 'failed', attached: false, problems: [] };
  var first = lead.name.split(/\s+/)[0];
  var send = function (attached, blob) {
    var mail = b.id === 'bcb' ? bcbEmail_(first, lead, url, attached) : bartenderEmail_(first, lead, url, attached);
    var msg = {
      to: lead.email,
      subject: mail.subject,
      body: mail.text,
      htmlBody: mail.html,
      name: CONFIG.FROM_NAME,
      replyTo: CONFIG.REPLY_TO
    };
    if (blob) msg.attachments = [blob];
    MailApp.sendEmail(msg);
  };

  try {
    if (MailApp.getRemainingDailyQuota() < 1) {
      out.status = 'failed_quota';
      out.problems.push('The daily email quota is used up, so no email went out.');
      return out;
    }
  } catch (err) { console.error('quota check failed', err); /* try sending anyway */ }

  var blob = null;
  try {
    blob = readPdf_(b).setName(b.downloadFilename);
  } catch (err) {
    console.error('pdf read failed', err);
    out.problems.push('Could not read the PDF from Drive (' + errText_(err) + '). Run selfTest in Apps Script.');
  }
  if (blob) {
    try {
      send(true, blob);
      out.status = 'sent';
      out.attached = true;
      return out;
    } catch (err) {
      console.error('mail with attachment failed', err);
      out.problems.push('Sending with the PDF attached failed (' + errText_(err) + ').');
    }
  }
  try {
    send(false, null);
    out.status = 'sent_link_only';
  } catch (err) {
    console.error('mail failed', err);
    out.status = 'failed';
    out.problems.push('The email to them failed (' + errText_(err) + ').');
  }
  return out;
}

/** Short note to sani@ when a delivery had a problem. Never throws. */
function alertOwner_(b, lead, url, result) {
  try {
    if (MailApp.getRemainingDailyQuota() < 1) { console.error('alert skipped: mail quota used up'); return false; }
    var status = {
      sent: 'sent with the PDF attached',
      sent_link_only: 'sent with the download link only (no attachment)',
      failed_quota: 'NOT sent (daily quota used up)',
      failed: 'NOT sent'
    }[result.status] || result.status;
    var body = [
      'A book sign-up had a delivery problem.',
      '',
      'Name: ' + lead.name,
      'Email: ' + lead.email,
      'Book: ' + b.title + ' (tab "' + b.tab + '")',
      'Email to them: ' + status,
      '',
      'What failed:',
      '- ' + result.problems.join('\n- '),
      '',
      'Their personal download link (works for ' + CONFIG.LINK_TTL_DAYS + ' days): ' + url,
      result.status.indexOf('sent') === 0 ? '' : 'Reply to this email to write to them directly.',
      '',
      'To check the setup: Apps Script > DBN Prompt Book Leads > run selfTest.'
    ].join('\n');
    MailApp.sendEmail({
      to: CONFIG.ALERT_TO,
      subject: 'Book sign-up needs a look: ' + b.title,
      body: body,
      name: 'drinksbyneat.com',
      replyTo: lead.email
    });
    return true;
  } catch (err) {
    console.error('alert failed', err);
    return false;
  }
}

/** Delivery line for the emails. Never says "attached" unless the PDF really is attached. */
function delivery_(attached, url, intro, introHtml) {
  var days = CONFIG.LINK_TTL_DAYS;
  var btn = '<p style="margin:20px 0"><a href="' + esc_(url) + '" style="display:inline-block;background:#111;color:#fff;' +
    'font-family:Arial,sans-serif;font-size:15px;font-weight:bold;text-decoration:none;padding:12px 22px;border-radius:2px">' +
    'Download your copy</a><br><span style="font-family:Arial,sans-serif;font-size:13px;color:#4a4a4a">' +
    'The link works for ' + days + ' days.</span></p>';
  if (attached) {
    return {
      text: [intro + ' Your copy is attached.', '', 'Download your copy (the link works for ' + days + ' days): ' + url],
      html: '<p>' + introHtml + ' Your copy is attached.</p>' + btn
    };
  }
  return {
    text: [intro + ' Download your copy here (the link works for ' + days + ' days):', url],
    html: '<p>' + introHtml + ' Download your copy here:</p>' + btn
  };
}

/** v1 email, word for word apart from the delivery line (attachment and/or download link). */
function bartenderEmail_(first, lead, url, attached) {
  var dl = delivery_(attached !== false, url,
    'Thanks for grabbing The Bartender\'s AI Prompt Book.',
    'Thanks for grabbing <em>The Bartender\'s AI Prompt Book</em>.');
  var text = [
    'Hi ' + first + ','
  ].concat([''], dl.text, [
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
  ]).join('\n');
  var html =
    '<div style="font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#111;max-width:560px">' +
    '<p>Hi ' + esc_(first) + ',</p>' +
    dl.html +
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
function bcbEmail_(first, lead, url, attached) {
  var CALL_URL = 'https://drinksbyneat.com/ai/';
  var dl = delivery_(attached !== false, url, 'Thanks for stopping by at BCB.', 'Thanks for stopping by at BCB.');
  var text = [
    'Hi ' + first + ','
  ].concat([''], dl.text, [
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
  ]).join('\n');
  var html =
    '<div style="font-family:Georgia,serif;font-size:17px;line-height:1.6;color:#111;max-width:560px">' +
    '<p>Hi ' + esc_(first) + ',</p>' +
    dl.html +
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

/**
 * Tokens:
 *   v3 personal token (in the sheet's download_token column): valid LINK_TTL_DAYS, LINK_MAX_USES downloads.
 *      Every new download (part 0 / whole file) is checked against the sheet; chunks 1..n use a short cache entry.
 *   v2 short token (cache only, no `p` flag): 30 minutes, TOKEN_MAX_USES downloads, as before.
 */
function pdfResponse_(token, part, bookHint) {
  token = String(token || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!token || token.length < 32 || token.length > 64) return json_({ ok: false, error: 'bad_token' });
  var chunked = part !== undefined && part !== null && part !== '';
  var n = chunked ? Math.floor(Number(part)) : 0;
  if (chunked && !(n >= 0)) return json_({ ok: false, error: 'bad_part' });

  var cache = CacheService.getScriptCache();
  var key = 'dl:' + token;
  var raw = cache.get(key);
  var t = raw ? JSON.parse(raw) : null;
  var firstHit = !chunked || n === 0;          // count one "use" per download, not per chunk
  var b, hit = null;

  if (firstHit) {
    if (t && !t.p) {                            // v2 short-lived token
      if (t.uses >= CONFIG.TOKEN_MAX_USES) return json_({ ok: false, error: 'expired' });
      t.uses += 1;
      cache.put(key, JSON.stringify(t), CONFIG.TOKEN_TTL_SECONDS);
      b = book_(t.book) || BOOKS.bartender;     // v1 tokens have no book -> bartender
    } else {                                    // v3 personal token: the sheet is the source of truth
      hit = findToken_(token, bookHint || (t && t.book));
      if (!hit) return json_({ ok: false, error: 'expired' });
      var exp = toTime_(hit.rec.download_token_expires);
      if (!exp || exp < Date.now()) return json_({ ok: false, error: 'expired' });
      if (Number(hit.rec.downloads || 0) >= CONFIG.LINK_MAX_USES) return json_({ ok: false, error: 'limit' });
      b = hit.book;
      t = { leadId: hit.rec.lead_id, uses: 1, book: b.id, p: true };
      cache.put(key, JSON.stringify(t), CONFIG.TOKEN_TTL_SECONDS);
    }
  } else {
    if (!t || !t.uses) return json_({ ok: false, error: 'bad_part' });  // chunks only after part 0
    b = book_(t.book) || BOOKS.bartender;
  }

  var bytes;
  try {
    bytes = readPdf_(b).getBytes();
  } catch (err) {
    console.error('pdf read failed', err);
    return json_({ ok: false, error: 'unavailable' });
  }

  if (firstHit) {
    try {
      var now = new Date().toISOString();
      if (hit) {
        var dc = col_(hit.sheet, b, 'downloads'), lc = col_(hit.sheet, b, 'last_download_at');
        if (dc) hit.sheet.getRange(hit.row, dc).setValue(Number(hit.rec.downloads || 0) + 1);
        if (lc) hit.sheet.getRange(hit.row, lc).setValue(now);
      } else {
        var sheet = sheet_(b);
        var cur = Number(getCell_(sheet, b, t.leadId, 'downloads') || 0);
        setCell_(sheet, b, t.leadId, 'downloads', cur + 1);
        setCell_(sheet, b, t.leadId, 'last_download_at', now);
      }
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

/** Finds a personal token in the tabs (hinted book first). Returns { book, sheet, row, rec } or null. */
function findToken_(token, hint) {
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var order = Object.keys(BOOKS);
  var h = book_(hint);
  if (hint && h) order = [h.id].concat(order.filter(function (k) { return k !== h.id; }));
  for (var i = 0; i < order.length; i++) {
    var b = BOOKS[order[i]];
    var sheet = tabFor_(ss, b);
    if (!sheet || sheet.getLastRow() < 2) continue;
    var c = col_(sheet, b, 'download_token', true);
    if (!c) continue;
    var found = sheet.getRange(2, c, sheet.getLastRow() - 1, 1).createTextFinder(token).matchEntireCell(true).findNext();
    if (!found) continue;
    var row = found.getRow();
    var hdr = headerMap_(sheet);
    var vals = sheet.getRange(row, 1, 1, hdr.width).getValues()[0];
    var rec = {};
    Object.keys(hdr.map).forEach(function (name) { rec[name] = vals[hdr.map[name] - 1]; });
    if (String(rec.download_token).toLowerCase() !== token) continue;
    return { book: b, sheet: sheet, row: row, rec: rec };
  }
  return null;
}

/* ------------------------------------------------------------------ admin */

/**
 * Editor helper, on purpose only: re-sends the book email (with a fresh 30-day link) to the latest
 * sign-up for that email in that book's tab, e.g. resendBookEmail('name@example.com', 'bcb').
 */
function resendBookEmail(email, bookId) {
  email = String(email || '').trim().toLowerCase();
  var b = book_(bookId);
  if (!email || !b) throw new Error('Usage: resendBookEmail("name@example.com", "bcb" or "bartender")');
  var sheet = sheet_(b);
  var ec = col_(sheet, b, 'email');
  var last = sheet.getLastRow();
  var emails = last > 1 ? sheet.getRange(2, ec, last - 1, 1).getValues() : [];
  var row = 0;
  for (var i = emails.length - 1; i >= 0; i--) {
    if (String(emails[i][0]).trim().toLowerCase() === email) { row = i + 2; break; }
  }
  if (!row) throw new Error('No sign-up for ' + email + ' in tab "' + b.tab + '".');
  var hdr = headerMap_(sheet);
  var vals = sheet.getRange(row, 1, 1, hdr.width).getValues()[0];
  var get = function (h) { return hdr.map[h] ? vals[hdr.map[h] - 1] : ''; };
  var token = newToken_();
  sheet.getRange(row, col_(sheet, b, 'download_token')).setValue(token);
  sheet.getRange(row, col_(sheet, b, 'download_token_expires'))
    .setValue(new Date(Date.now() + CONFIG.LINK_TTL_DAYS * 86400000).toISOString());
  var lead = { name: String(get('name') || ''), email: email, marketing: get('marketing_opt_in') === true || get('marketing_opt_in') === 'TRUE' };
  var url = downloadUrl_(b, token);
  var result = sendBookEmail_(b, lead, url);
  sheet.getRange(row, col_(sheet, b, 'email_status')).setValue(result.status);
  Logger.log('resendBookEmail ' + email + ' (' + b.id + '): ' + result.status +
    (result.problems.length ? ' — ' + result.problems.join(' ') : '') + '\nLink: ' + url);
  return result.status;
}

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
  withLock_(function () {
    Object.keys(BOOKS).forEach(function (k) {
      var b = BOOKS[k];
      var sheet = tabFor_(ss, b);
      out[b.tab] = 0;
      if (!sheet || sheet.getLastRow() < 2) return;
      var col = col_(sheet, b, 'email', true) || (b.headers.indexOf('email') + 1);
      var values = sheet.getRange(1, col, sheet.getLastRow(), 1).getValues();
      for (var i = values.length - 1; i >= 1; i--) {
        if (String(values[i][0]).trim().toLowerCase() === email) { sheet.deleteRow(i + 1); out[b.tab]++; }
      }
    });
  });
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

/**
 * The tab for a book (bartender when omitted). Creates the tab with headers if setup() wasn't re-run,
 * and adds any missing trailing (v3) headers once per execution.
 */
var HDR_CHECKED_ = {};
function sheet_(b) {
  b = b || BOOKS.bartender;
  var ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  var sheet = tabFor_(ss, b);
  if (sheet && sheet.getLastRow() > 0 && HDR_CHECKED_[b.tab]) return sheet;
  if (sheet && sheet.getLastRow() > 0) {
    var hdr = headerMap_(sheet);
    var missing = b.headers.some(function (h) { return !hdr.map[h]; });
    if (!missing) { HDR_CHECKED_[b.tab] = true; return sheet; }
  }
  return withLock_(function () {
    var s = ensureTab_(ss, b);
    HDR_CHECKED_[b.tab] = true;
    return s;
  });
}

/**
 * The book's tab under its current name, or null. If only an old-name tab exists (e.g. "Leads"), it is
 * renamed in place under the script lock, keeping every row, so a duplicate empty tab is never created.
 * If both exist, the new-name tab wins and a warning is logged once per execution.
 */
var TAB_WARNED_ = {};
function tabFor_(ss, b) {
  var sheet = ss.getSheetByName(b.tab);
  if (sheet) {
    var stale = legacyTab_(ss, b);
    if (stale && !TAB_WARNED_[b.tab]) {
      TAB_WARNED_[b.tab] = true;
      var msg = 'Both "' + b.tab + '" and the old "' + stale.getName() + '" tab exist. Using "' + b.tab +
        '". Move any rows you need from "' + stale.getName() + '" by hand, then delete it.';
      console.warn(msg);
      Logger.log('WARNING: ' + msg);
    }
    return sheet;
  }
  if (!legacyTab_(ss, b)) return null;
  return withLock_(function () {
    var now = ss.getSheetByName(b.tab);      // another request may have renamed it while we waited
    if (now) return now;
    var old = legacyTab_(ss, b);
    if (!old) return null;
    var oldName = old.getName();
    old.setName(b.tab);
    delete HDR_CACHE_[oldName];
    delete HDR_CACHE_[b.tab];
    Logger.log('Renamed tab "' + oldName + '" -> "' + b.tab + '" (all rows kept).');
    return old;
  });
}

function legacyTab_(ss, b) {
  var names = b.legacyTabs || [];
  for (var i = 0; i < names.length; i++) {
    var t = ss.getSheetByName(names[i]);
    if (t) return t;
  }
  return null;
}

/** Every current and old book tab name (so setup never renames one of them as "the first sheet"). */
function allTabNames_() {
  var out = [];
  Object.keys(BOOKS).forEach(function (k) { out.push(BOOKS[k].tab); out = out.concat(BOOKS[k].legacyTabs || []); });
  return out;
}

/** Runs fn under the script lock; re-entrant within one execution (nested calls don't wait on themselves). */
var LOCK_DEPTH_ = 0;
function withLock_(fn) {
  if (LOCK_DEPTH_ > 0) return fn();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  LOCK_DEPTH_++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH_--;
    lock.releaseLock();
  }
}

/** Header name -> 1-based column, read from the tab's first row (cached for this execution). */
var HDR_CACHE_ = {};
function headerMap_(sheet) {
  var name = sheet.getName();
  if (HDR_CACHE_[name]) return HDR_CACHE_[name];
  var width = sheet.getLastColumn();
  var row = width ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
  var map = {};
  row.forEach(function (h, i) { h = String(h).trim(); if (h && !map.hasOwnProperty(h)) map[h] = i + 1; });
  HDR_CACHE_[name] = { map: map, width: Math.max(width, 1) };
  return HDR_CACHE_[name];
}

/** Column of a header in this tab; adds missing headers once if needed (unless readOnly). 0 = not there. */
function col_(sheet, b, header, readOnly) {
  var c = headerMap_(sheet).map[header];
  if (c || readOnly) return c || 0;
  withLock_(function () { ensureHeaders_(sheet, b); });
  return headerMap_(sheet).map[header] || 0;
}

/** Row array laid out by the tab's actual header row (so an older tab with extra/missing columns still lines up). */
function rowFor_(sheet, b, values) {
  var hdr = headerMap_(sheet);
  var row = [];
  for (var i = 0; i < hdr.width; i++) row.push('');
  Object.keys(values).forEach(function (k) { if (hdr.map[k]) row[hdr.map[k] - 1] = values[k]; });
  return row;
}

function findRow_(sheet, leadId) {
  var hit = sheet.createTextFinder(leadId).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function getCell_(sheet, b, leadId, header) {
  var r = findRow_(sheet, leadId);
  var c = col_(sheet, b, header, true);
  return r && c ? sheet.getRange(r, c).getValue() : '';
}

function setCell_(sheet, b, leadId, header, value) {
  var r = findRow_(sheet, leadId);
  var c = col_(sheet, b, header);
  if (r && c) sheet.getRange(r, c).setValue(value);
}

function toTime_(v) {
  if (v instanceof Date) return v.getTime();
  var t = Date.parse(String(v || ''));
  return isNaN(t) ? 0 : t;
}

function errText_(err) {
  return String((err && err.message) || err).slice(0, 300);
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
