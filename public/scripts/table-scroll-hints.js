// Adds directional chevron cues to horizontally scrollable tables.
// Cues are shown only when overflow exists and update with scroll position.
(function () {
  const scrollers = Array.from(document.querySelectorAll('.table-scroll'));
  if (!scrollers.length) return;

  // Use a tiny SVG chevron instead of text glyphs to avoid font-dependent
  // baseline/centering drift across browsers.
  const createChevronIcon = () => {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'table-scroll-cue-icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', 'M6 4 L10 8 L6 12');
    svg.appendChild(path);

    return svg;
  };

  const ensureFrame = (scroller) => {
    const parent = scroller.parentElement;
    if (parent && parent.classList.contains('table-scroll-frame')) return parent;
    // Cues are anchored to a non-scrolling frame so they stay fixed at the
    // viewport edge while table content scrolls underneath.
    const frame = document.createElement('div');
    frame.className = 'table-scroll-frame';
    scroller.parentNode.insertBefore(frame, scroller);
    frame.appendChild(scroller);
    return frame;
  };

  const ensureCues = (frame) => {
    let leftCue = frame.querySelector('.table-scroll-cue--left');
    let rightCue = frame.querySelector('.table-scroll-cue--right');

    if (!leftCue) {
      leftCue = document.createElement('span');
      leftCue.className = 'table-scroll-cue table-scroll-cue--left';
      leftCue.setAttribute('aria-hidden', 'true');
      leftCue.appendChild(createChevronIcon());
      frame.appendChild(leftCue);
    }

    if (!rightCue) {
      rightCue = document.createElement('span');
      rightCue.className = 'table-scroll-cue table-scroll-cue--right';
      rightCue.setAttribute('aria-hidden', 'true');
      rightCue.appendChild(createChevronIcon());
      frame.appendChild(rightCue);
    }
  };

  const updateScroller = (scroller) => {
    const frame = scroller.parentElement;
    if (!frame || !frame.classList.contains('table-scroll-frame')) return;
    const leftCue = frame.querySelector('.table-scroll-cue--left');
    const rightCue = frame.querySelector('.table-scroll-cue--right');
    if (!leftCue || !rightCue) return;

    // Only show cues when horizontal overflow exists, and hide the cue at the
    // boundary the user has already reached.
    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    const hasOverflow = maxScrollLeft > 1;
    const isAtStart = scroller.scrollLeft <= 1;
    const isAtEnd = scroller.scrollLeft >= maxScrollLeft - 1;

    frame.classList.toggle('has-scroll-cues', hasOverflow);
    leftCue.classList.toggle('is-visible', hasOverflow && !isAtStart);
    rightCue.classList.toggle('is-visible', hasOverflow && !isAtEnd);
  };

  const updateAll = () => {
    scrollers.forEach(updateScroller);
  };

  scrollers.forEach((scroller) => {
    const frame = ensureFrame(scroller);
    ensureCues(frame);
    // Keep cue visibility in sync with horizontal scroll position.
    scroller.addEventListener('scroll', () => updateScroller(scroller), { passive: true });
  });

  window.addEventListener('resize', updateAll);

  if ('ResizeObserver' in window) {
    // React to content/layout changes that alter overflow without a viewport resize.
    const observer = new ResizeObserver(updateAll);
    scrollers.forEach((scroller) => {
      observer.observe(scroller);
      const table = scroller.querySelector('table');
      if (table) observer.observe(table);
    });
  }

  updateAll();
})();
