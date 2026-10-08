/* Free-book lead form, gated download, Plausible event. No dependencies.
   Used by /prompt-book/ (bartenders) and /bcb/ (spirits brands). Per-page settings live on the <form>:
     data-endpoint        Apps Script /exec URL (empty = friendly "email Andreas" message; mock on localhost)
     data-book            sent as `book` to the backend (omitted for the bartender book, as in v1)
     data-event           Plausible event name            (default "Prompt Book Download")
     data-submit-label    submit button text              (default "Get the free PDF")
     data-filename        fallback download file name
     data-src-key         sessionStorage key for ?src=    (default "pb_src")
   Optional fields (city, phone, brand) are only validated/sent when the form has them.
   window.DBNBook.loadPdf(endpoint, token, book) is shared with the /…/download/ pages (email links). */
(function () {
  'use strict';
  /* ---------------------------------------------------------------- download
     Apps Script answers every request with a 302 to a one-time script.googleusercontent.com/macros/echo
     URL, and each PDF request has to read the file from Drive, which is sometimes slow (we have seen a
     request take 11 s and end on an echo 404, and others not answer for 30 s+). So we:
       1. ask for the PDF in 192 KB chunks (&part=0,1,…), part 0 first, then up to 3 chunks at a time
          (a backend that predates chunking ignores `part` and returns the whole file, which still works),
       2. never send cookies (credentials:'omit') and never reuse a cached echo response (cache:'no-store'),
       3. give every request a hard timeout (20 s) and treat timeouts, HTML/404 pages and network errors as
          retryable (2 retries with backoff), but never retry a real answer like {"error":"expired"},
       4. stop the whole thing after 2 minutes, so a page can never sit on "Preparing" forever. */
  var REQUEST_TIMEOUT_MS = 20000;
  var TOTAL_TIMEOUT_MS = 120000;
  var PARALLEL = 3;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function retryable(msg) { var e = new Error(msg); e.retry = true; return e; }
  function getJSON(url) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { if (ctl) ctl.abort(); reject(retryable('timeout')); }, REQUEST_TIMEOUT_MS);
    });
    var opts = { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'follow' };
    if (ctl) opts.signal = ctl.signal;
    var req = fetch(url, opts)
      .then(function (r) {
        if (!r.ok) throw retryable('http_' + r.status);
        return r.text();
      })
      .then(function (t) {
        try { return JSON.parse(t); } catch (err) { throw retryable('not_json'); }
      }, function (err) { if (err && err.retry === undefined) err.retry = true; throw err; });
    return Promise.race([req, timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (err) { clearTimeout(timer); throw err; });
  }
  function withRetry(fn, delays) {
    return fn().catch(function (err) {
      if (!err || !err.retry || !delays.length) throw err;
      return sleep(delays[0]).then(function () { return withRetry(fn, delays.slice(1)); });
    });
  }
  /** loadPdf(endpoint, token, book, onProgress(done, total)) -> Promise<{ filename, blob }> */
  function loadPdf(endpoint, token, book, onProgress) {
    var base = endpoint + (endpoint.indexOf('?') > -1 ? '&' : '?') + 'action=pdf&t=' + encodeURIComponent(token) +
      (book ? '&book=' + encodeURIComponent(book) : '');
    var attempt = 0;
    var progress = function (done, total) { try { if (onProgress) onProgress(done, total); } catch (err) {} };
    var part = function (n) {
      return withRetry(function () { attempt++; return getJSON(base + '&part=' + n + '&r=' + attempt); }, [1200, 2500])
        .then(function (d) {
          if (!d || !d.ok) { var e = new Error((d && d.error) || 'bad_response'); e.retry = false; throw e; }
          if (d.parts && d.part !== n) throw new Error('bad_part');
          return d;
        });
    };
    var work = part(0).then(function (first) {
      var total = first.parts || 1;          // no `parts` = backend sent the whole file
      var chunks = [first.data];
      var done = 1;
      progress(done, total);
      var next = 1;
      function worker() {
        if (next >= total) return Promise.resolve();
        var n = next++;
        return part(n).then(function (d) { chunks[n] = d.data; done++; progress(done, total); return worker(); });
      }
      var pool = [];
      for (var w = 0; w < Math.min(PARALLEL, total - 1); w++) pool.push(worker());
      return Promise.all(pool).then(function () {
        var arrays = chunks.map(function (b64) {
          var bin = atob(b64);
          var bytes = new Uint8Array(bin.length);
          for (var j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
          return bytes;
        });
        if (first.bytes && arrays.reduce(function (s, a) { return s + a.length; }, 0) !== first.bytes) throw new Error('size_mismatch');
        return { filename: first.filename, blob: new Blob(arrays, { type: 'application/pdf' }) };
      });
    });
    var overall;
    var guard = new Promise(function (_, reject) { overall = setTimeout(function () { reject(new Error('timeout')); }, TOTAL_TIMEOUT_MS); });
    return Promise.race([work, guard]).then(
      function (v) { clearTimeout(overall); return v; },
      function (err) { clearTimeout(overall); throw err; });
  }

  /* iPhone/iPad (every iOS browser and in-app browser is WebKit). There, a scripted click on a blob
     download is unreliable, so we never auto-download: the visitor taps a button, and we open the PDF in
     Safari's viewer (Share > Save to Files), with the share sheet as a second option. */
  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /** Turns an <a> into the right "save" button for this device. Returns the label it set. */
  function armButton(a, blob, filename) {
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.removeAttribute('aria-disabled');
    a.hidden = false;
    if (IOS) {
      a.removeAttribute('download');
      a.setAttribute('target', '_blank');   // no rel=noopener: the new tab must be able to read our blob: URL
      a.textContent = 'Open the PDF';
    } else {
      a.setAttribute('download', filename);
      a.removeAttribute('target');
      a.textContent = 'Download the PDF';
    }
    return a.textContent;
  }

  /** Native share sheet with the file (iOS: "Save to Files"), when the browser supports it. */
  function canShareFile(blob, filename) {
    try {
      var f = new File([blob], filename, { type: 'application/pdf' });
      return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [f] })) ? f : null;
    } catch (err) { return null; }
  }

  window.DBNBook = { loadPdf: loadPdf, armButton: armButton, canShareFile: canShareFile, isIOS: IOS };
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

  form.addEventListener('submit', function (e) {
    e.preventDefault();
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
    payload.elapsed_ms = Date.now() - startedAt;
    payload.page = location.pathname + location.search;
    payload.user_agent = navigator.userAgent;
    if (BOOK) payload.book = BOOK;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    // text/plain body = "simple" CORS request: no preflight, which Apps Script can't answer.
    fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow', credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) return showSuccess(payload, res);
        if (res && res.error === 'validation' && res.fields) {
          Object.keys(res.fields).forEach(function (n) { if (form.elements[n]) setInvalid(n, true); });
          return fail('Please check the highlighted fields.');
        }
        if (res && res.error === 'rate_limited') return fail('You’ve already requested the book a few times — check your inbox, or try again in 10 minutes.');
        fail('Something went wrong on our side. Try again, or email sani@drinksbyneat.com.');
      })
      .catch(function () { fail('Couldn’t reach the server. Check your connection and try again.'); });
  });

  function showSuccess(payload, res) {
    try { window.plausible(EVENT, { props: { src: src || 'direct' } }); } catch (err) {}

    var first = (res.firstName || payload.name.split(/\s+/)[0] || '').slice(0, 40);
    document.getElementById('pbFirst').textContent = first ? ', ' + first : '';
    document.getElementById('pbEmail').textContent = payload.email;
    if (res.emailed === false) {
      document.getElementById('pbEmailLine').textContent = 'We saved your details. Grab your download below. If no email arrives in a few minutes, email sani@drinksbyneat.com.';
    }
    form.hidden = true;
    var success = document.getElementById('pbSuccess');
    success.hidden = false;
    success.focus({ preventScroll: true });
    document.getElementById('pbCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

    var btn = document.getElementById('pbDownload');
    var note = document.getElementById('pbDownloadNote');
    var noteDefault = note.textContent;
    if (!res.token) { // honeypot/spam path or no token issued
      btn.hidden = true;
      note.textContent = 'Your copy is on its way by email.';
      return;
    }
    // Fetch the PDF now so the button tap is an instant, same-gesture download (or "Open the PDF" on iPhone).
    window.DBNBook.loadPdf(ENDPOINT, res.token, BOOK, function (done, total) {
      if (total > 1 && done < total) btn.textContent = 'Preparing your PDF… ' + done + ' of ' + total;
    })
      .then(function (d) {
        window.DBNBook.armButton(btn, d.blob, d.filename || FILENAME);
        note.textContent = window.DBNBook.isIOS ? noteDefault + ' · opens in a new tab, then Share > Save to Files' : noteDefault;
      })
      .catch(function () {
        btn.hidden = true;
        note.textContent = res.emailed === false
          ? 'We saved your details. If no email arrives in a few minutes, email sani@drinksbyneat.com.'
          : res.linkEmailed
            ? 'The instant download didn’t load. Your download link is in your inbox too. Check Promotions or spam if it hides.'
            : 'Got it. Your copy is on its way to your inbox. If it hasn’t arrived in five minutes, email sani@drinksbyneat.com.';
      });
  }
})();
