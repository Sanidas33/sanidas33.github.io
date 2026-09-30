/* Drinks By Neat — Plausible conversion goals.
   Fires "Book Call" on any Calendly booking link and "Email Click" on any mailto link.
   Goals must also be added in Plausible (Site settings → Goals → Custom event). */
(function () {
  window.plausible = window.plausible || function () { (window.plausible.q = window.plausible.q || []).push(arguments); };
  function where(a) {
    if (a.closest('.site-header')) return 'nav';
    if (a.closest('.site-footer')) return 'footer';
    if (a.closest('.cta-band')) return 'cta-band';
    if (a.closest('.hero, .page-hero, .article-hero')) return 'hero';
    return 'inline';
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var props = { props: { position: where(a) } };
    if (/^https:\/\/calendly\.com\/drinksbyneat\//.test(href)) window.plausible('Book Call', props);
    else if (/^mailto:/i.test(href)) window.plausible('Email Click', props);
  }, true);
})();
