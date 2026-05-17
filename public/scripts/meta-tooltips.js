// Replaces native title tooltips for metadata pills with a custom tooltip
// that supports hover/focus and optional click-to-pin behavior.
(function () {
  const targets = Array.from(document.querySelectorAll('[data-meta="true"]'));
  if (!targets.length) return;

  const tooltip = document.createElement('div');
  tooltip.className = 'meta-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltip);

  let pinned = false;
  let activeEl = null;

  const setTooltipContent = (el) => {
    const text = el.getAttribute('data-title');
    if (!text) return false;
    tooltip.textContent = text;
    return true;
  };

  // Default horizontal position of the arrow apex inside the balloon
  // (px from balloon left). Matches the CSS fallback for
  // --meta-tooltip-arrow-x.
  const ARROW_DEFAULT_X = 16;
  // Keep the arrow apex this far from each balloon edge so the arrow
  // doesn't run into the rounded corners.
  const ARROW_EDGE_PADDING = 14;
  // Margin between the balloon and the viewport edge when clamped.
  const VIEWPORT_MARGIN = 8;

  const positionTooltip = (el) => {
    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const sourceLeft = rect.left + scrollX;
    let left = sourceLeft;
    const top = rect.top + scrollY - 8;

    // Clamp left so the balloon doesn't overflow the viewport. Reading
    // offsetWidth forces a layout, so do it once after content was set
    // by setTooltipContent.
    const tooltipWidth = tooltip.offsetWidth;
    const viewportLeft = scrollX;
    const viewportRight = scrollX + document.documentElement.clientWidth;
    const maxLeft = viewportRight - tooltipWidth - VIEWPORT_MARGIN;
    const minLeft = viewportLeft + VIEWPORT_MARGIN;
    if (left > maxLeft) left = maxLeft;
    if (left < minLeft) left = minLeft;

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;

    // Re-aim the arrow so it still points at the source after clamping.
    // Default arrow apex is ARROW_DEFAULT_X inside the balloon; if the
    // balloon shifted left by `delta`, the arrow shifts right by `delta`
    // inside the balloon to compensate.
    const targetArrowAbsoluteX = sourceLeft + ARROW_DEFAULT_X;
    const rawArrowX = targetArrowAbsoluteX - left;
    const arrowX = Math.max(
      ARROW_EDGE_PADDING,
      Math.min(tooltipWidth - ARROW_EDGE_PADDING, rawArrowX)
    );
    tooltip.style.setProperty('--meta-tooltip-arrow-x', `${arrowX}px`);
  };

  const showTooltip = (el) => {
    if (!setTooltipContent(el)) return;
    positionTooltip(el);
    tooltip.setAttribute('aria-hidden', 'false');
    tooltip.classList.add('is-visible');
    activeEl = el;
  };

  const hideTooltip = () => {
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.classList.remove('is-visible');
    activeEl = null;
  };

  const togglePinned = (el) => {
    if (!activeEl || activeEl !== el) {
      showTooltip(el);
    }
    pinned = !pinned;
    tooltip.classList.toggle('is-pinned', pinned);
  };

  targets.forEach((el) => {
    const title = el.getAttribute('title');
    if (title) {
      el.setAttribute('data-title', title);
      el.setAttribute('aria-label', title);
      el.removeAttribute('title');
    }

    el.addEventListener('mouseenter', () => {
      if (pinned) return;
      showTooltip(el);
    });
    el.addEventListener('mouseleave', () => {
      if (pinned) return;
      hideTooltip();
    });
    el.addEventListener('focus', () => {
      if (pinned) return;
      showTooltip(el);
    });
    el.addEventListener('blur', () => {
      if (pinned) return;
      hideTooltip();
    });
    el.addEventListener('click', (event) => {
      if (event.target.closest('a')) return;
      event.preventDefault();
      togglePinned(el);
    });
  });

  document.addEventListener('click', (event) => {
    if (!pinned) return;
    if (event.target === tooltip || tooltip.contains(event.target)) return;
    if (activeEl && (event.target === activeEl || activeEl.contains(event.target))) return;
    pinned = false;
    tooltip.classList.remove('is-pinned');
    hideTooltip();
  });

  window.addEventListener('scroll', () => {
    if (activeEl) {
      positionTooltip(activeEl);
    }
  });
  window.addEventListener('resize', () => {
    if (activeEl) {
      positionTooltip(activeEl);
    }
  });
})();
