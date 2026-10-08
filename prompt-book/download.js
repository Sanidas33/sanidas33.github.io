/* /bcb/download/ and /prompt-book/download/ — the personal link from the book email.
   Settings live on #dlApp: data-endpoint (Apps Script /exec), data-book (bcb | bartender),
   data-filename (fallback name), data-event (Plausible event). Needs /prompt-book/prompt-book.js first
   (window.DBNBook.loadPdf: chunked, retrying, cookie-free PDF fetch). The token comes from ?t=…; the inline
   script in <head> moves it to sessionStorage and strips it from the address bar before analytics loads. */
(function () {
  'use strict';
  var app = document.getElementById('dlApp');
  if (!app || !window.DBNBook) return;
  var ENDPOINT = app.getAttribute('data-endpoint') || '';
  var BOOK = app.getAttribute('data-book') || '';
  var FILENAME = app.getAttribute('data-filename') || 'Drinks-by-Neat.pdf';
  var EVENT = app.getAttribute('data-event') || 'Book Link Download';
  var btn = document.getElementById('dlButton');
  var retry = document.getElementById('dlRetry');
  var status = document.getElementById('dlStatus');
  var HELP = 'email sani@drinksbyneat.com and Andreas will send it to you.';
  var token = String(window.__dbnToken || sessionStorage.getItem('dl_t_' + BOOK) || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  var say = function (msg) { status.textContent = msg; };

  if (!ENDPOINT || token.length < 32 || token.length > 64) {
    btn.hidden = true;
    say('This download link is incomplete. Open the link from your email again, or ' + HELP);
    return;
  }

  var tracked = false;
  function start() {
    retry.hidden = true;
    btn.hidden = false;
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('download');
    btn.href = '#';
    btn.textContent = 'Preparing your PDF…';
    say('Getting your copy ready. This takes a few seconds.');
    window.DBNBook.loadPdf(ENDPOINT, token, BOOK)
      .then(function (d) {
        btn.href = URL.createObjectURL(d.blob);
        btn.setAttribute('download', d.filename || FILENAME);
        btn.removeAttribute('aria-disabled');
        btn.textContent = 'Download again';
        say('Your download should start now. If it didn’t, use the button below.');
        if (!tracked) { tracked = true; try { window.plausible(EVENT, { props: { book: BOOK } }); } catch (err) {} }
        try { btn.click(); } catch (err) {}
      })
      .catch(function (err) {
        var code = err && err.message;
        btn.hidden = true;
        if (code === 'expired' || code === 'bad_token') {
          say('This download link has expired or isn’t valid any more. To get a copy, ' + HELP);
        } else if (code === 'limit') {
          say('This link has reached its download limit. To get another copy, ' + HELP);
        } else {
          say('The download didn’t load. Try again in a minute, or ' + HELP);
          retry.hidden = false;
        }
      });
  }
  retry.addEventListener('click', start);
  start();
})();
