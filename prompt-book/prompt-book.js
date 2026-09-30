/* /prompt-book/ — lead form, gated download, Plausible event. No dependencies. */
(function () {
  'use strict';
  var form = document.getElementById('pbForm');
  if (!form) return;

  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var ENDPOINT = form.getAttribute('data-endpoint') || (isLocal ? '/__mock_backend' : '');
  var startedAt = Date.now();
  var submitBtn = document.getElementById('pbSubmit');
  var statusEl = document.getElementById('pbStatus');
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PHONE_RE = /^[0-9+()\/.\s-]{5,40}$/;

  // ?src=berlin-seminar -> hidden field (kept for the session so a reload doesn't lose it)
  var params = new URLSearchParams(location.search);
  var src = (params.get('src') || sessionStorage.getItem('pb_src') || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60);
  if (src) sessionStorage.setItem('pb_src', src);
  document.getElementById('pb-src').value = src;
  if (/berlin/.test(src)) document.getElementById('pbWelcome').hidden = false;

  function fieldWrap(el) { return el.closest('.pb-field') || el.closest('.pb-check'); }
  function setInvalid(name, bad) {
    var el = form.elements[name];
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
    var v = function (n) { return form.elements[n].value.trim(); };
    var checks = {
      name: !!v('name'),
      email: EMAIL_RE.test(v('email')),
      role: !!v('role'),
      company: !!v('company'),
      city: !!v('city'),
      phone: !v('phone') || PHONE_RE.test(v('phone')),
      consent_book: form.elements.consent_book.checked
    };
    var firstBad = null;
    Object.keys(checks).forEach(function (n) {
      setInvalid(n, !checks[n]);
      if (!checks[n] && !firstBad) firstBad = form.elements[n];
    });
    return firstBad;
  }
  // Clear an error as soon as the field is fixed
  form.addEventListener('input', function (e) { if (e.target.name && fieldWrap(e.target) && fieldWrap(e.target).classList.contains('is-invalid')) validate(); });
  form.addEventListener('change', function (e) { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') { if (fieldWrap(e.target).classList.contains('is-invalid')) validate(); } });

  function fail(msg) {
    statusEl.textContent = msg;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Get the free PDF';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    statusEl.textContent = '';
    var bad = validate();
    if (bad) { bad.focus(); return; }
    if (!ENDPOINT) { fail('Downloads open shortly. In the meantime, email sani@drinksbyneat.com and Andreas will send the book.'); return; }

    var payload = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      role: form.elements.role.value,
      company: form.elements.company.value.trim(),
      city: form.elements.city.value.trim(),
      phone: form.elements.phone.value.trim(),
      src: src,
      consent_book: form.elements.consent_book.checked,
      marketing_opt_in: form.elements.marketing_opt_in.checked,
      website: form.elements.website.value,          // honeypot
      elapsed_ms: Date.now() - startedAt,
      page: location.pathname + location.search,
      user_agent: navigator.userAgent
    };

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    // text/plain body = "simple" CORS request: no preflight, which Apps Script can't answer.
    fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' })
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
    try { window.plausible('Prompt Book Download', { props: { src: src || 'direct' } }); } catch (err) {}

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
    fetch(ENDPOINT + (ENDPOINT.indexOf('?') > -1 ? '&' : '?') + 'action=pdf&t=' + encodeURIComponent(res.token))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error(d && d.error);
        var bin = atob(d.data);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        btn.href = url;
        btn.setAttribute('download', d.filename || 'The-Bartenders-AI-Prompt-Book.pdf');
        btn.removeAttribute('aria-disabled');
        btn.textContent = 'Download the PDF';
      })
      .catch(function () {
        btn.hidden = true;
        note.textContent = 'The instant download didn’t load — your copy is attached to the email we just sent.';
      });
  }
})();
