(function () {
  const SHOW_DELAY_MS = 500;
  const targets = Array.from(document.querySelectorAll('a[data-wiki-link="true"]'));
  if (!targets.length) return;

  const {
    wikiLinkPreviewEndpoint,
    wikiLinkPreviewIntroHtml,
    wikiLinkPreviewMissingLoading,
    wikiLinkPreviewToken,
    wikiLinkPreviewWikipediaAttributionHtml,
    wikiLinkPreviewWikipediaHeading,
    wikiLinkPreviewWikipediaLinkLabel,
  } = document.body.dataset;

  if (!wikiLinkPreviewEndpoint || !wikiLinkPreviewToken) return;

  const card = document.createElement('div');
  card.className = 'wiki-link-preview-popover';
  card.hidden = true;
  document.body.appendChild(card);

  const cache = new Map();
  const inflight = new Map();
  let activeTarget = null;
  let pendingTarget = null;
  let hideTimer = 0;
  let showTimer = 0;
  let activationToken = 0;

  const escapeHtml = (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const buildBodyHtml = (preview, loadingText) => {
    if (preview && preview.kind === 'local' && preview.local) {
      return `<section class="wiki-link-preview-popover__local">
        <h3 class="wiki-link-preview-popover__title"><a href="${encodeURI(preview.local.url)}">${escapeHtml(preview.local.title)}</a></h3>
        ${preview.local.html || ''}
      </section>`;
    }

    const parts = [];

    if (wikiLinkPreviewIntroHtml) {
      parts.push(`<p class="wiki-link-preview-popover__intro">${wikiLinkPreviewIntroHtml}</p>`);
    }

    if (loadingText) {
      parts.push(`<p class="wiki-link-preview-popover__loading">${escapeHtml(loadingText)}</p>`);
      return parts.join('');
    }

    if (!preview || preview.kind !== 'missing' || !preview.wikipedia || !preview.wikipedia.html || !preview.wikipedia.url) {
      return parts.join('');
    }

    parts.push(
      `<section class="wiki-link-preview-popover__wikipedia">
        ${
          wikiLinkPreviewWikipediaHeading
            ? `<div class="wiki-link-preview-popover__label">${escapeHtml(wikiLinkPreviewWikipediaHeading)}</div>`
            : ''
        }
        <div class="wiki-link-preview-popover__extract">${preview.wikipedia.html}</div>
        ${
          wikiLinkPreviewWikipediaLinkLabel
            ? `<p class="wiki-link-preview-popover__more"><a href="${encodeURI(preview.wikipedia.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(wikiLinkPreviewWikipediaLinkLabel)}</a></p>`
            : ''
        }
        ${
          wikiLinkPreviewWikipediaAttributionHtml
            ? `<p class="wiki-link-preview-popover__attribution">${wikiLinkPreviewWikipediaAttributionHtml}</p>`
            : ''
        }
      </section>`
    );

    return parts.join('');
  };

  const positionCard = (target) => {
    const rect = target.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    const maxWidth = Math.min(420, window.innerWidth - 24);
    card.style.maxWidth = `${maxWidth}px`;
    card.style.left = `${Math.max(12, rect.left + scrollX)}px`;
    card.style.top = `${rect.bottom + scrollY + 10}px`;
  };

  const showCard = (target) => {
    activeTarget = target;
    pendingTarget = target;
    card.hidden = false;
    card.classList.add('is-visible');
    positionCard(target);
  };

  const hideCard = () => {
    activeTarget = null;
    pendingTarget = null;
    card.classList.remove('is-visible');
    card.hidden = true;
  };

  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      const targetStillHot =
        (activeTarget && activeTarget.matches(':hover, :focus')) ||
        (pendingTarget && pendingTarget.matches(':hover, :focus'));

      if (!card.matches(':hover') && !targetStillHot) {
        window.clearTimeout(showTimer);
        activationToken += 1;
        hideCard();
      }
    }, 120);
  };

  const loadPreview = async (slug) => {
    if (cache.has(slug)) return cache.get(slug);
    if (inflight.has(slug)) return inflight.get(slug);

    const request = fetch(`${wikiLinkPreviewEndpoint}?slug=${encodeURIComponent(slug)}`, {
      headers: {
        Accept: 'application/json',
        'X-Wiki-Link-Preview-Token': wikiLinkPreviewToken,
        'X-Wiki-Link-Preview-Page-Path': window.location.pathname,
      },
      credentials: 'same-origin',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const preview = payload && payload.kind ? payload : null;
        cache.set(slug, preview);
        return preview;
      })
      .catch(() => {
        cache.set(slug, null);
        return null;
      })
      .finally(() => {
        inflight.delete(slug);
      });

    inflight.set(slug, request);
    return request;
  };

  const activateTarget = async (target) => {
    const normalizedSlug = target.dataset.wikiLinkSlug;
    if (!normalizedSlug) return;
    const token = ++activationToken;
    const loadingText = target.classList.contains('wiki-red-link')
      ? wikiLinkPreviewMissingLoading || ''
      : '';

    window.clearTimeout(hideTimer);
    window.clearTimeout(showTimer);
    if (activeTarget && activeTarget !== target) {
      hideCard();
    }
    pendingTarget = target;

    card.innerHTML = buildBodyHtml(null, loadingText);
    showTimer = window.setTimeout(() => {
      if (token !== activationToken || pendingTarget !== target) return;
      showCard(target);
    }, SHOW_DELAY_MS);

    const preview = await loadPreview(normalizedSlug);
    if (token !== activationToken) return;
    card.innerHTML = buildBodyHtml(preview, false);
    if (activeTarget === target && !card.hidden) {
      positionCard(target);
    }
  };

  targets.forEach((target) => {
    target.addEventListener('mouseenter', () => {
      window.clearTimeout(hideTimer);
      void activateTarget(target);
    });
    target.addEventListener('focus', () => {
      window.clearTimeout(hideTimer);
      void activateTarget(target);
    });
    target.addEventListener('mouseleave', scheduleHide);
    target.addEventListener('blur', scheduleHide);
  });

  card.addEventListener('mouseenter', () => {
    window.clearTimeout(hideTimer);
  });
  card.addEventListener('mouseleave', scheduleHide);

  window.addEventListener('scroll', () => {
    if (activeTarget && !card.hidden) {
      positionCard(activeTarget);
    }
  });
  window.addEventListener('resize', () => {
    if (activeTarget && !card.hidden) {
      positionCard(activeTarget);
    }
  });
})();
