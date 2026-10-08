/* Free-book lead form + instant download. No dependencies.
   Used by /prompt-book/ (bartenders) and /bcb/ (spirits brands). Per-page settings live on the <form>:
     data-endpoint        Apps Script /exec URL (saves the lead, sends the email; empty = "email Andreas" message;
                          mock on localhost)
     data-pdf             the PDF on this site (unlisted path) — the download button links straight to it
     data-book            sent as `book` to the backend (omitted for the bartender book, as in v1)
     data-event           Plausible event name, fired on the download-button tap (default "Prompt Book Download")
     data-submit-label    submit button text              (default "Get the free PDF")
     data-filename        download file name
     data-src-key         sessionStorage key for ?src=    (default "pb_src")
   Optional fields (city, phone, brand) are only validated/sent when the form has them.
   Flow: valid submit -> confirmation view + download button at once; the POST goes once in the background
   (it saves the lead and sends the email with the link). It is never resent automatically. */
(function () {
  'use strict';
  /* iPhone/iPad (every iOS browser and in-app browser is WebKit): a plain link that opens the PDF in a new
     tab (Safari's viewer, then Share > Save to Files). Elsewhere: same link with the download attribute. */
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function armLink(a, url, filename) {
    a.href = url;
    a.setAttribute('rel', 'nofollow');
    a.removeAttribute('aria-disabled');
    a.hidden = false;
    if (IOS) {
      a.removeAttribute('download');
      a.setAttribute('target', '_blank');
      a.textContent = 'Open the PDF';
    } else {
      a.setAttribute('download', filename);
      a.removeAttribute('target');
      a.textContent = 'Download the PDF';
    }
  }
  window.DBNBook = { armLink: armLink, isIOS: IOS };
})();

(function () {
  'use strict';
  var form = document.getElementById('pbForm');
  if (!form) return;

  var cfg = function (k, d) { var v = form.getAttribute('data-' + k); return v == null || v === '' ? d : v; };
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var ENDPOINT = cfg('endpoint', isLocal ? '/__mock_backend' : '');
  var BOOK = cfg('book', '');
  var EVENT = cfg('event', 'Prompt Book Download');
  var SUBMIT_LABEL = cfg('submit-label', 'Get the free PDF');
  var FILENAME = cfg('filename', 'The-Bartenders-AI-Prompt-Book.pdf');
  var SRC_KEY = cfg('src-key', 'pb_src');
  var startedAt = Date.now();
  var PDF_URL = cfg('pdf', '');      // static, unlisted PDF on this site (opens instantly)
  var POST_TIMEOUT_MS = 25000;
  var MIN_FILL_MS = 2700;            // backend treats < 2500 ms as a bot; small margin
  var emailLineEl = document.getElementById('pbEmailLine');
  var noteEl = document.getElementById('pbDownloadNote');
  var submitBtn = document.getElementById('pbSubmit');
  var statusEl = document.getElementById('pbStatus');
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^[0-9+()\/.\s-]{5,40}$/;
  var has = function (n) { return !!form.elements[n]; };

  // ?src=berlin-seminar -> hidden field (kept for the session so a reload doesn't lose it)
  var params = new URLSearchParams(location.search);
  var src = (params.get('src') || sessionStorage.getItem(SRC_KEY) || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60);
  if (src) sessionStorage.setItem(SRC_KEY, src);
  document.getElementById('pb-src').value = src;
  var welcome = document.getElementById('pbWelcome');
  if (welcome && /berlin/.test(src)) welcome.hidden = false;

  function fieldWrap(el) { return el.closest('.pb-field') || el.closest('.pb-check'); }
  function setInvalid(name, bad) {
    var el = form.elements[name];
    if (!el) return;
    var wrap = fieldWrap(el);
    if (wrap) wrap.classList.toggle('is-invalid', bad);
    el.setAttribute('aria-invalid', bad ? 'true' : 'false');
    var msg = form.querySelector('.pb-error[data-for="' + name + '"]');
    if (msg) {
      msg.id = msg.id || 'err-' + name;
      msg.classList.toggle('is-shown', bad);
      if (bad) el.setAttribute('aria-describedby', msg.id); else el.removeAttribute('aria-describedby');
    }
  }
  function validate() {
    var v = function (n) { return has(n) ? form.elements[n].value.trim() : ''; };
    var checks = {
      name: !!v('name'),
      email: EMAIL_RE.test(v('email')),
      role: !!v('role'),
      company: !!v('company')
    };
    if (has('city') && form.elements.city.required) checks.city = !!v('city');
    if (has('phone')) checks.phone = !v('phone') || PHONE_RE.test(v('phone'));
    checks.consent_book = form.elements.consent_book.checked;
    var firstBad = null;
    Object.keys(checks).forEach(function (n) {
      setInvalid(n, !checks[n]);
      if (!checks[n] && !firstBad) firstBad = form.elements[n];
    });
    return firstBad;
  }
  // Clear an error as soon as the field is fixed
  form.addEventListener('input', function (e) { if (e.target.name && fieldWrap(e.target) && fieldWrap(e.target).classList.contains('is-invalid')) validate(); });
  form.addEventListener('change', function (e) { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') { if (fieldWrap(e.target) && fieldWrap(e.target).classList.contains('is-invalid')) validate(); } });

  function fail(msg, info) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('is-info', !!info);
    submitBtn.disabled = false;
    submitBtn.textContent = SUBMIT_LABEL;
  }

  var successEl = document.getElementById('pbSuccess');
  var firstEl = document.getElementById('pbFirst');
  var btn = document.getElementById('pbDownload');
  var NOTE_DEFAULT = noteEl ? noteEl.textContent : '';
  var inFlight = false;

  // Plausible conversion: the tap on the download button (once per page view).
  var tracked = false;
  btn.addEventListener('click', function () {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    if (tracked) return;
    tracked = true;
    try { window.plausible(EVENT, { props: { src: src || 'direct' } }); } catch (err) {}
  });

  function setEmailLine(first, email) {
    // "Thanks, Mara. Your book is on its way to <strong>mara@…</strong>. Check your inbox (and Promotions or spam)."
    emailLineEl.textContent = '';
    emailLineEl.appendChild(document.createTextNode('Thanks' + (first ? ', ' + first : '') + '. Your book is on its way to '));
    var strong = document.createElement('strong'); strong.id = 'pbEmail'; strong.textContent = email;
    emailLineEl.appendChild(strong);
    emailLineEl.appendChild(document.createTextNode('. Check your inbox (and Promotions or spam).'));
  }

  /** Confirmation view with the download button, shown the moment a valid form is submitted. */
  function showConfirmation(payload) {
    var first = (payload.name.split(/\s+/)[0] || '').slice(0, 40);
    firstEl.textContent = first ? ', ' + first : '';
    setEmailLine(first, payload.email);
    if (PDF_URL) {
      window.DBNBook.armLink(btn, PDF_URL, FILENAME);
      noteEl.textContent = window.DBNBook.isIOS ? NOTE_DEFAULT + ' · opens in a new tab, then Share > Save to Files' : NOTE_DEFAULT;
    } else {
      btn.hidden = true;
      noteEl.textContent = 'Your download link is in the email.';
    }
    form.hidden = true;
    successEl.hidden = false;
    try { successEl.focus({ preventScroll: true }); } catch (err) {}
    document.getElementById('pbCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** Back to the form (server said no, or the request never left the phone). The visitor decides to resend. */
  function backToForm(msg) {
    successEl.hidden = true;
    form.hidden = false;
    fail(msg);
    document.getElementById('pbCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (inFlight) return;
    statusEl.textContent = '';
    var bad = validate();
    if (bad) { bad.focus(); return; }
    if (!ENDPOINT) { fail('The download isn’t open yet. Email sani@drinksbyneat.com and Andreas will send you the book.', true); return; }

    var val = function (n) { return has(n) ? form.elements[n].value.trim() : ''; };
    var payload = {
      name: val('name'),
      email: val('email'),
      role: form.elements.role.value,
      company: val('company')
    };
    if (has('city')) payload.city = val('city');
    if (has('brand')) payload.brand = val('brand');
    payload.phone = val('phone');
    payload.src = src;
    payload.consent_book = form.elements.consent_book.checked;
    payload.marketing_opt_in = has('marketing_opt_in') ? form.elements.marketing_opt_in.checked : false;
    payload.website = form.elements.website.value;   // honeypot
    payload.page = location.pathname + location.search;
    payload.user_agent = navigator.userAgent;
    if (BOOK) payload.book = BOOK;

    inFlight = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    showConfirmation(payload);                 // instant; the request goes in the background

    // Spam rule: the backend ignores forms filled faster than MIN_FILL_MS. A quick human still sees the
    // confirmation at once; we just wait out the remainder before sending.
    var wait = Math.max(0, MIN_FILL_MS - (Date.now() - startedAt));
    setTimeout(function () { send(payload); }, wait);
  });

  /* The POST is sent exactly once and never retried (a retry would mean a second email). It saves the lead
     and sends the email; the page only reacts to a real "no" (validation, rate limit) or a request that never
     left the phone. A slow, missing or unreadable answer changes nothing: the button already works.
     text/plain body = "simple" CORS request: no preflight, which Apps Script can't answer. */
  function send(payload) {
    payload.elapsed_ms = Date.now() - startedAt;
    var settled = false;
    var sentAt = Date.now();
    var timer = setTimeout(function () { settled = true; }, POST_TIMEOUT_MS);   // later answers can't undo the view

    fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow', credentials: 'omit' })
      .then(function (r) {
        return r.text().then(function (t) {
          try { return JSON.parse(t); } catch (err) { return { ok: false, error: 'unreadable' }; }
        });
      })
      .then(function (res) {
        var late = settled;
        settled = true;
        clearTimeout(timer);
        if (res && res.ok) {
          if (res.emailed === false) {
            var first = (res.firstName || payload.name.split(/\s+/)[0] || '').slice(0, 40);
            emailLineEl.textContent = 'Thanks' + (first ? ', ' + first : '') + '. We saved your details, but the email didn’t go out this time. ' +
              'Use the button below, or email sani@drinksbyneat.com.';
          }
          return;
        }
        if (late) return;
        if (res && res.error === 'validation' && res.fields) {
          inFlight = false;
          Object.keys(res.fields).forEach(function (n) { if (form.elements[n]) setInvalid(n, true); });
          return backToForm('Please check the highlighted fields.');
        }
        if (res && res.error === 'rate_limited') {
          inFlight = false;
          return backToForm('You’ve already requested the book a few times. Check your inbox, or try again in 10 minutes.');
        }
        // Server error or unreadable answer: the request reached Google, so the sign-up probably went through.
      })
      .catch(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Failed fast or offline = it never left the phone: let them try again.
        if (navigator.onLine === false || Date.now() - sentAt < 1500) {
          inFlight = false;
          backToForm('Couldn’t reach the server. Check your connection and try again.');
        }
      });
  }
})();
