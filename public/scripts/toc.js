// Progressive enhancement for page TOCs: collapse open TOC blocks by default
// on narrow viewports so article content is immediately visible.
(function () {
  if (window.matchMedia('(max-width: 900px)').matches) {
    document.querySelectorAll('.page-toc[open]').forEach(function (el) {
      el.removeAttribute('open');
    });
  }
})();
