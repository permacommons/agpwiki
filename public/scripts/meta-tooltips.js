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

  const positionTooltip = (el) => {
    const rect = el.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const left = rect.left + scrollX;
    const top = rect.top + scrollY - 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
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
