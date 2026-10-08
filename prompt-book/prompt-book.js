/* Free-book lead form, gated download, Plausible event. No dependencies.
   Used by /prompt-book/ (bartenders) and /bcb/ (spirits brands). Per-page settings live on the <form>:
     data-endpoint        Apps Script /exec URL (empty = friendly "email Andreas" message; mock on localhost)
     data-book            sent as `book` to the backend (omitted for the bartender book, as in v1)
     data-event           Plausible event name            (default "Prompt Book Download")
     data-submit-label    submit button text              (default "Get the free PDF")
     data-filename        fallback download file name
     data-src-key         sessionStorage key for ?src=    (default "pb_src")
   Optional fields (city, phone, brand) are only validated/sent when the form has them. */
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

  /* ---------------------------------------------------------------- download
     Why this is more careful than a single fetch: Apps Script answers every request with a 302 to a
     one-time script.googleusercontent.com/macros/echo URL. A ~0.8–1.5 MB base64 JSON body coming
     back through that hop is what failed in headless Chromium (echo -> 302 -> exec -> 302 -> echo 404),
     while small JSON replies through the same hop work. So we:
       1. ask for the PDF in chunks (&part=0,1,…; a backend that predates chunking ignores `part`
          and returns the whole file, which still works),
       2. never send cookies (credentials:'omit') and never reuse a cached echo response (cache:'no-store'),
       3. treat anything that isn't JSON (HTML 404 page, network error) as retryable, with backoff,
          but never retry a real answer like {"error":"expired"}. */
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function getJSON(url) {
    return fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'follow' })
      .then(function (r) {
        if (!r.ok) { var e = new Error('http_' + r.status); e.retry = true; throw e; }
        return r.text();
      })
      .then(function (t) {
        try { return JSON.parse(t); } catch (err) { var e = new Error('not_json'); e.retry = true; throw e; }
      }, function (err) { if (err && err.retry === undefined) err.retry = true; throw err; });
  }
  function withRetry(fn, delays) {
    return fn().catch(function (err) {
      if (!err || !err.retry || !delays.length) throw err;
      return sleep(delays[0]).then(function () { return withRetry(fn, delays.slice(1)); });
    });
  }
  function loadPdf(token) {
    var base = ENDPOINT + (ENDPOINT.indexOf('?') > -1 ? '&' : '?') + 'action=pdf&t=' + encodeURIComponent(token);
    var attempt = 0;
    var part = function (n) {
      return withRetry(function () { attempt++; return getJSON(base + '&part=' + n + '&r=' + attempt); }, [1200, 2500])
        .then(function (d) {
          if (!d || !d.ok) { var e = new Error((d && d.error) || 'bad_response'); e.retry = false; throw e; }
          if (d.parts && d.part !== n) throw new Error('bad_part');
          return d;
        });
    };
    return part(0).then(function (first) {
      var total = first.parts || 1;          // no `parts` = backend sent the whole file
      var chunks = [first.data];
      var seq = Promise.resolve();
      for (var i = 1; i < total; i++) {
        (function (n) { seq = seq.then(function () { return part(n); }).then(function (d) { chunks[n] = d.data; }); })(i);
      }
      return seq.then(function () {
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
  }

  function showSuccess(payload, res) {
    try { window.plausible(EVENT, { props: { src: src || 'direct' } }); } catch (err) {}

    var first = (res.firstName || payload.name.split(/\s+/)[0] || '').slice(0, 40);
    document.getElementById('pbFirst').textContent = first ? ', ' + first : '';
    document.getElementById('pbEmail').textContent = payload.email;
    if (res.emailed === false) {
      document.getElementById('pbEmailLine').textContent = 'Grab your download below. Our email service is busy right now, so Andreas will send your copy to ' + payload.email + ' by hand.';
    }
    form.hidden = true;
    var success = document.getElementById('pbSuccess');
    success.hidden = false;
    success.focus({ preventScroll: true });
    document.getElementById('pbCard').scrollIntoView({ behavior: 'smooth', block: 'start' });

    var btn = document.getElementById('pbDownload');
    var note = document.getElementById('pbDownloadNote');
    if (!res.token) { // honeypot/spam path or no token issued
      btn.hidden = true;
      note.textContent = 'Your copy is on its way by email.';
      return;
    }
    // Fetch the PDF now (token expires in 30 min) so the button click is an instant, same-gesture download.
    loadPdf(res.token)
      .then(function (d) {
        btn.href = URL.createObjectURL(d.blob);
        btn.setAttribute('download', d.filename || FILENAME);
        btn.removeAttribute('aria-disabled');
        btn.textContent = 'Download the PDF';
      })
      .catch(function () {
        btn.hidden = true;
        note.textContent = res.emailed === false
          ? 'The instant download didn’t load. Andreas will email your copy to you by hand.'
          : 'Got it. Your copy is on its way to your inbox. If it hasn’t arrived in five minutes, email sani@drinksbyneat.com.';
      });
  }
})();
