(async () => {
  const {
    createDiscussionState,
    discussionControls,
    beginDiscussionLoad,
    finishDiscussionLoad,
    readDiscussionSnapshot,
    discussionReadingUrl,
  } = await import(document.currentScript.dataset.stateUrl);

  const isPlainClick = event =>
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

  const bindLanguageMenus = root => {
    root.querySelectorAll('.form-language-menu').forEach(menu => {
      const summary = menu.querySelector('summary');
      const label = menu.querySelector('.lang-menu-label');
      menu.addEventListener('change', event => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.checked) return;
        if (label) label.textContent = input.value;
        menu.open = false;
        summary?.focus();
      });
    });
  };

  const placeThreadAnchor = threadId => {
    const section = threadId ? document.getElementById(`thread-${threadId}`) : null;
    if (!section) return;
    const anchor = document.getElementById('thread') || document.createElement('span');
    anchor.id = 'thread';
    anchor.className = 'discussion-thread-anchor';
    anchor.setAttribute('aria-hidden', 'true');
    section.prepend(anchor);
  };

  // A thread or comment link puts its permanent address in the address bar
  // and copies it, without reloading the page.
  const followPermalink = link => {
    const url = new URL(link.href, window.location.href);
    placeThreadAnchor(url.searchParams.get('thread'));
    window.history.replaceState(window.history.state, '', url);
    document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ block: 'start' });
    navigator.clipboard?.writeText(url.href).then(
      () => {
        link.classList.add('is-copied');
        window.setTimeout(() => link.classList.remove('is-copied'), 1500);
      },
      () => {}
    );
  };

  // One reply form is copied under the comment being answered. Answering a
  // reply adds to the same list and starts with @name.
  const openReplyForm = trigger => {
    const template = document.querySelector('template[data-reply-template]');
    const parentId = trigger.getAttribute('data-reply-to');
    const list = parentId ? document.querySelector(`[data-replies="${CSS.escape(parentId)}"]`) : null;
    if (!(template instanceof HTMLTemplateElement) || !list) return false;
    document.querySelectorAll('[data-reply-form][data-reply-open]').forEach(form => {
      if (!form.querySelector('textarea')?.value.trim()) form.remove();
    });
    const form = template.content.firstElementChild?.cloneNode(true);
    if (!(form instanceof HTMLFormElement)) return false;
    form.dataset.replyOpen = 'true';
    form.action = trigger.getAttribute('data-reply-action') ?? '';
    const fields = JSON.parse(trigger.getAttribute('data-reply-fields') ?? '{}');
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = String(value);
      form.prepend(input);
    }
    const suffix = Math.random().toString(36).slice(2);
    form.querySelectorAll('.form-language-radio').forEach(radio => {
      const label = form.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      radio.id = `${radio.id}-${suffix}`;
      label?.setAttribute('for', radio.id);
    });
    list.append(form);
    bindLanguageMenus(form);
    const textarea = form.querySelector('textarea');
    const mention = trigger.getAttribute('data-reply-mention');
    if (textarea) {
      if (mention) textarea.value = `@${mention} `;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
    return true;
  };

  document.addEventListener('click', event => {
    if (!isPlainClick(event) || !(event.target instanceof Element)) return;
    const permalink = event.target.closest('[data-permalink]');
    if (permalink instanceof HTMLAnchorElement) {
      event.preventDefault();
      followPermalink(permalink);
      return;
    }
    const reply = event.target.closest('[data-reply-to]');
    if (reply && openReplyForm(reply)) {
      event.preventDefault();
      return;
    }
    const cancel = event.target.closest('[data-reply-form][data-reply-open] [data-reply-cancel]');
    if (cancel) {
      event.preventDefault();
      cancel.closest('[data-reply-form]')?.remove();
    }
  });

  // Redirects without a fragment still need to position the requested thread.
  const params = new URLSearchParams(window.location.search);
  const threadId = params.get('thread');
  placeThreadAnchor(threadId);
  const landing = params.get('thread')
    ? `thread-${params.get('thread')}`
    : params.get('position')
      ? `position-${params.get('position')}`
      : null;
  if (landing && !window.location.hash) {
    document.getElementById(landing)?.scrollIntoView({ block: 'start' });
  }

  const bindDiscussionContent = root => {
    window.agpwikiBindCommentEditors?.(root);
    bindLanguageMenus(root);
  };

  const createLoadControl = ({ container, linkSelector, messageSelector, label, boundaryLabel, load }) => {
    const link = container.querySelector(linkSelector);
    let button;
    let message = container.querySelector(messageSelector);
    let state;
    const render = nextState => {
      state = nextState;
      const { exhausted, busy, showBoundary } = state;
      if (!button && !exhausted) {
        button = document.createElement('button');
        button.type = 'button';
        if (link?.isConnected) link.replaceWith(button);
        else container.append(button);
        button.addEventListener('click', load);
        button.addEventListener('blur', () => render(state));
      }
      if (!button && exhausted) link?.remove();
      const focused = button && document.activeElement === button;
      // Removing a focused control would lose the keyboard reader's place.
      if (button) {
        button.hidden = exhausted && !focused;
        button.setAttribute('aria-disabled', String(busy || exhausted));
        button.classList.toggle('discussion-boundary', exhausted);
        button.textContent = exhausted ? boundaryLabel : label;
      }
      if (showBoundary && !message) {
        message = document.createElement('span');
        container.append(message);
      }
      if (message) message.textContent = showBoundary && !focused ? boundaryLabel : '';
    };
    return render;
  };

  const visibleThreadUrl = threads => {
    const visible = [...threads.children].find(section => section.getBoundingClientRect().bottom > 100);
    const link = visible?.querySelector('[data-permalink]');
    if (!link || visible.getBoundingClientRect().top >= innerHeight) return null;
    const fragment = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const bounds = fragment?.getBoundingClientRect();
    const preserveFragment = fragment && visible.contains(fragment) && bounds.bottom > 0 && bounds.top < innerHeight;
    return discussionReadingUrl(link.href, location.href, preserveFragment);
  };

  const createReadingPosition = (path, pageSize) => {
    const previous = history.state?.discussion;
    let snapshotKey = previous?.path === path ? previous.snapshotKey : null;
    let restored = null;
    const navigationType = performance.getEntriesByType('navigation')[0]?.type;
    try {
      const snapshot = snapshotKey ? readDiscussionSnapshot(sessionStorage.getItem(snapshotKey), pageSize, navigationType) : null;
      if (snapshot && Number.isFinite(previous.y) && previous.y >= 0) {
        restored = { ...snapshot, y: previous.y };
      }
    } catch { /* Storage can be unavailable; the permalink still restores the thread. */ }
    const rememberContent = snapshot => {
      try {
        snapshotKey ||= `discussion-${crypto.randomUUID()}`;
        sessionStorage.setItem(snapshotKey, JSON.stringify(snapshot));
      } catch { snapshotKey = null; }
    };
    const save = url => {
      if (url) placeThreadAnchor(url.searchParams.get('thread'));
      const discussion = { path, snapshotKey, y: scrollY };
      try {
        history.replaceState({ ...history.state, discussion }, '', url || location.href);
      } catch { /* The permalink remains usable when history state is unavailable. */ }
    };
    return { restored, rememberContent, save };
  };

  const fetchThreadBatch = async (base, threadIds) => {
    const url = new URL(base);
    url.searchParams.set('batch', threadIds.join(','));
    const response = await fetch(url, { headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error(String(response.status));
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const added = doc.querySelector('[data-discussion-threads]');
    if (!added) throw new Error('Missing discussion');
    const fragment = document.createDocumentFragment();
    for (const section of added.children) {
      if (!document.getElementById(section.id)) fragment.append(document.importNode(section, true));
    }
    return fragment;
  };

  const initializeLoading = (threads, pager, newerNav) => {
    const base = new URL(location.pathname, location.origin);
    const pageSize = Number(pager.dataset.pageSize);
    const position = createReadingPosition(base.pathname, pageSize);
    let state = createDiscussionState({
      threadOrder: JSON.parse(pager.dataset.threadIds || '[]'),
      page: Number(pager.dataset.page),
      pageSize,
    }, position.restored);
    if (position.restored) {
      threads.innerHTML = position.restored.html;
      placeThreadAnchor(threadId);
      bindDiscussionContent(threads);
      requestAnimationFrame(() => window.scrollTo(0, position.restored.y));
    }

    const range = pager.querySelector('[data-discussion-range]');
    const autoLabel = document.createElement('label');
    const autoInput = document.createElement('input');
    autoInput.type = 'checkbox';
    autoLabel.append(autoInput, document.createTextNode(pager.dataset.automaticLabel));
    pager.after(autoLabel);
    const renderNewer = createLoadControl({
      container: newerNav,
      linkSelector: '[data-discussion-newer]',
      messageSelector: '[data-discussion-start]',
      label: pager.dataset.newerLabel,
      boundaryLabel: pager.dataset.noNewerLabel,
      load: () => load('newer'),
    });
    const renderOlder = createLoadControl({
      container: pager,
      linkSelector: '[data-discussion-older]',
      messageSelector: '[data-discussion-end]',
      label: pager.dataset.olderLabel,
      boundaryLabel: pager.dataset.endLabel,
      load: () => load('older'),
    });
    const renderControls = () => {
      const controls = discussionControls(state);
      renderNewer(controls.newer);
      renderOlder(controls.older);
      const rangeText = pager.dataset.rangeLabel
        .replace('{start}', String(controls.rangeStart))
        .replace('{end}', String(controls.rangeEnd))
        .replace('{total}', String(controls.total));
      const loadMessage = state.status === 'loading' ? pager.dataset.loadingLabel
        : state.status === 'error' ? pager.dataset.errorLabel : '';
      const announcement = loadMessage ? `${rangeText} · ${loadMessage}` : rangeText;
      if (range.textContent !== announcement) range.textContent = announcement;
      autoLabel.hidden = !controls.showAutomatic;
      autoInput.checked = state.automatic;
    };
    const rememberContent = () => position.rememberContent({
      threadOrder: state.threadOrder,
      pageSize: state.pageSize,
      loadedStart: state.loadedStart,
      loadedEnd: state.loadedEnd,
      automatic: state.automatic,
      loadedNewer: state.loadedNewer,
      html: threads.innerHTML,
    });
    const insertBatch = (fragment, direction) => {
      const nodes = [...fragment.children];
      const anchor = threads.firstElementChild;
      const before = anchor?.getBoundingClientRect().top;
      if (direction === 'newer') {
        threads.prepend(fragment);
        if (anchor) window.scrollBy(0, anchor.getBoundingClientRect().top - before);
      } else threads.append(fragment);
      nodes.forEach(bindDiscussionContent);
    };
    const load = async direction => {
      const requested = beginDiscussionLoad(state, direction);
      if (!requested) return;
      state = requested;
      threads.setAttribute('aria-busy', 'true');
      renderControls();
      try {
        const fragment = await fetchThreadBatch(base, state.pending.threadIds);
        insertBatch(fragment, direction);
        state = finishDiscussionLoad(state, true);
      } catch {
        state = finishDiscussionLoad(state, false);
      } finally {
        threads.removeAttribute('aria-busy');
        renderControls();
        rememberContent();
        position.save();
      }
    };
    autoInput.addEventListener('change', () => {
      state = { ...state, automatic: autoInput.checked };
      rememberContent();
      position.save();
    });
    renderControls();
    rememberContent();

    // Only scrolling down loads automatically, so the form and footer stay reachable.
    let lastScrollY = scrollY;
    let positionTimer;
    window.addEventListener('scroll', () => {
      const down = scrollY > lastScrollY;
      lastScrollY = scrollY;
      if (down && state.automatic && pager.getBoundingClientRect().top < innerHeight + 300) void load('older');
      clearTimeout(positionTimer);
      positionTimer = setTimeout(() => position.save(visibleThreadUrl(threads)), 120);
    }, { passive: true });
    window.addEventListener('pagehide', () => {
      clearTimeout(positionTimer);
      position.save(visibleThreadUrl(threads));
    });
  };

  const threads = document.querySelector('[data-discussion-threads]');
  const pager = document.querySelector('[data-discussion-pager]');
  const newerNav = document.querySelector('[data-discussion-newer-nav]');
  if (threads && pager && newerNav && window.fetch) initializeLoading(threads, pager, newerNav);
})();
