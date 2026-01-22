// Progressive enhancement: collapse TOC on mobile by default
(function () {
  if (window.matchMedia('(max-width: 900px)').matches) {
    document.querySelectorAll('.page-toc[open]').forEach(function (el) {
      el.removeAttribute('open');
    });
  }
})();
