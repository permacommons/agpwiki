// Progressive enhancement for page TOCs: collapse open TOC blocks by default
// on narrow viewports so article content is immediately visible.
(function () {
  if (window.matchMedia('(max-width: 900px)').matches) {
    document.querySelectorAll('.page-toc[open]').forEach(function (el) {
      el.removeAttribute('open');
    });
  }
})();

// A link to a collapsed sidebar box (for example the History tab) opens it.
(function () {
  function openTarget() {
    if (!location.hash) return;
    var target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (target && target.tagName === 'DETAILS') target.open = true;
  }
  openTarget();
  window.addEventListener('hashchange', openTarget);
  // Following the same link twice fires no hashchange, but the box may have been closed since.
  document.addEventListener('click', function (event) {
    if (event.target.closest && event.target.closest('a[href^="#"]')) setTimeout(openTarget, 0);
  });
})();
