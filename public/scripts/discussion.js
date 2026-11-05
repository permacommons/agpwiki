(() => {
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

  // A thread or comment link puts its permanent address in the address bar
  // and copies it, without reloading the page.
  const followPermalink = link => {
    const url = new URL(link.href, window.location.href);
    window.history.replaceState(null, '', url);
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

  // A link to a thread without a fragment (an old thread address, say)
  // still lands on the thread.
  const params = new URLSearchParams(window.location.search);
  const landing = params.get('thread')
    ? `thread-${params.get('thread')}`
    : params.get('position')
      ? `position-${params.get('position')}`
      : null;
  if (landing && !window.location.hash) {
    document.getElementById(landing)?.scrollIntoView({ block: 'start' });
  }

  // The next page of threads loads by itself near the bottom; the plain
  // links stay for readers without JavaScript and for search engines.
  const threads = document.querySelector('[data-discussion-threads]');
  const pager = document.querySelector('[data-discussion-pager]');
  if (!threads || !pager || !('IntersectionObserver' in window)) return;
  let next = pager.querySelector('[data-discussion-next]');
  if (!(next instanceof HTMLAnchorElement)) return;
  // Stays in the layout, empty, so the observer can see it while idle.
  const loading = document.createElement('p');
  loading.className = 'discussion-loading';
  loading.setAttribute('aria-live', 'polite');
  const label = pager.getAttribute('data-loading-label') ?? '';
  pager.before(loading);
  pager.hidden = true;
  let busy = false;
  const observer = new IntersectionObserver(
    async entries => {
      if (busy || !entries.some(entry => entry.isIntersecting) || !(next instanceof HTMLAnchorElement)) return;
      busy = true;
      loading.textContent = label;
      try {
        const response = await fetch(next.href, { headers: { Accept: 'text/html' } });
        if (!response.ok) throw new Error(String(response.status));
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const added = page.querySelector('[data-discussion-threads]');
        const nextPage = page.querySelector('[data-discussion-next]');
        const url = next.href;
        added?.querySelectorAll(':scope > *').forEach(section => {
          const node = document.importNode(section, true);
          threads.append(node);
          window.agpwikiBindCommentEditors?.(node);
          bindLanguageMenus(node);
        });
        window.history.replaceState(null, '', url);
        if (nextPage instanceof HTMLAnchorElement) {
          next.href = nextPage.href;
        } else {
          next = null;
          observer.disconnect();
        }
      } catch {
        // Show the plain links again so the reader can go on by hand.
        observer.disconnect();
        pager.hidden = false;
      } finally {
        loading.textContent = '';
        busy = false;
      }
      // Observing again reports at once if the end is still in view.
      if (next) {
        observer.unobserve(loading);
        observer.observe(loading);
      }
    },
    { rootMargin: '400px 0px' }
  );
  observer.observe(loading);
})();
