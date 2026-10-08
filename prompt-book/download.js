/* /bcb/download/ and /prompt-book/download/ — the personal link from the book email.
   Settings live on #dlApp: data-endpoint (Apps Script /exec), data-book (bcb | bartender),
   data-filename (fallback name), data-event (Plausible event). Needs /prompt-book/prompt-book.js first
   (window.DBNBook: chunked, retrying, time-limited, cookie-free PDF fetch + device-aware save button).
   The token comes from ?t=…; the inline script in <head> saves it to sessionStorage and only then strips it
   from the address bar, so a reload still works.
   Desktop/Android: the download starts by itself, then "Download again".
   iPhone/iPad: no scripted download (unreliable there); the visitor taps "Open the PDF" (Safari's viewer,
   then Share > Save to Files), or "Save or share" (native share sheet) where supported. */
(function () {
  'use strict';
  var app = document.getElementById('dlApp');
  if (!app) return;
  var btn = document.getElementById('dlButton');
  var retry = document.getElementById('dlRetry');
  var share = document.getElementById('dlShare');
  var status = document.getElementById('dlStatus');
  var HELP = 'email sani@drinksbyneat.com and Andreas will send it to you.';
  var say = function (msg) { status.textContent = msg; };
  var stop = function (msg, canRetry) {
    btn.hidden = true;
    if (share) share.hidden = true;
    say(msg);
    retry.hidden = !canRetry;
  };

  if (!window.DBNBook || !window.DBNBook.loadPdf) {   // e.g. an old cached script
    stop('The download didn’t load. Reload the page, or ' + HELP, false);
    return;
  }
  var ENDPOINT = app.getAttribute('data-endpoint') || '';
  var BOOK = app.getAttribute('data-book') || '';
  var FILENAME = app.getAttribute('data-filename') || 'Drinks-by-Neat.pdf';
  var EVENT = app.getAttribute('data-event') || 'Book Link Download';
  var stored = '';
  try { stored = sessionStorage.getItem('dl_t_' + BOOK) || ''; } catch (err) {}
  var fromUrl = '';
  try { fromUrl = new URLSearchParams(location.search).get('t') || ''; } catch (err) {}
  var token = String(window.__dbnToken || fromUrl || stored).toLowerCase().replace(/[^a-f0-9]/g, '');

  if (!ENDPOINT || token.length < 32 || token.length > 64) {
    stop('This download link is incomplete. Open the link from your email again, or ' + HELP, false);
    return;
  }

  var tracked = false;
  var running = false;
  function start() {
    if (running) return;
    running = true;
    retry.hidden = true;
    if (share) share.hidden = true;
    btn.hidden = false;
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('download');
    btn.removeAttribute('target');
    btn.href = '#';
    btn.textContent = 'Preparing your PDF…';
    say('Getting your copy ready. This can take up to a minute.');
    window.DBNBook.loadPdf(ENDPOINT, token, BOOK, function (done, total) {
      if (total > 1 && done < total) btn.textContent = 'Preparing your PDF… ' + done + ' of ' + total;
    })
      .then(function (d) {
        running = false;
        var name = d.filename || FILENAME;
        window.DBNBook.armButton(btn, d.blob, name);
        if (!tracked) { tracked = true; try { window.plausible(EVENT, { props: { book: BOOK } }); } catch (err) {} }
        if (window.DBNBook.isIOS) {
          say('Your copy is ready. Tap the button to open it, then use Share > Save to Files to keep it.');
          var file = share && window.DBNBook.canShareFile(d.blob, name);
          if (file) {
            share.hidden = false;
            share.onclick = function () { navigator.share({ files: [file], title: name }).catch(function () {}); };
          }
        } else {
          say('Your download should start now. If it didn’t, use the button below.');
          try { btn.click(); } catch (err) {}
          btn.textContent = 'Download again';
        }
      })
      .catch(function (err) {
        running = false;
        var code = err && err.message;
        if (code === 'expired' || code === 'bad_token') {
          stop('This download link has expired or isn’t valid any more. To get a copy, ' + HELP, false);
        } else if (code === 'limit') {
          stop('This link has reached its download limit. To get another copy, ' + HELP, false);
        } else {
          stop('The download didn’t load. Try again in a minute, or ' + HELP, true);
        }
      });
  }
  retry.addEventListener('click', start);
  start();
})();
