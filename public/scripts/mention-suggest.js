// Typing @ and the start of a name in a comment box suggests matching
// usernames. Choosing one (click, Enter or Tab) completes the mention.
(() => {
  const script = document.currentScript;
  const endpoint = script?.dataset.endpoint;
  if (!endpoint) return;
  const label = script.dataset.label || '';

  // Same rule as the server: @ not after a word character, then the name.
  const TYPED_MENTION = /(?:^|[^\p{L}\p{N}\p{M}_@./[-])@([\p{L}\p{N}\p{M}._-]{1,64})$/u;
  const NAME_ONLY = /^[\p{L}\p{N}\p{M}._-]+$/u;
  const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

  let list = null;
  let field = null;
  let typed = null;
  let items = [];
  let active = -1;
  let timer = null;
  let requestId = 0;

  const close = () => {
    if (list) list.hidden = true;
    if (field) {
      field.removeAttribute('aria-activedescendant');
      field.setAttribute('aria-expanded', 'false');
    }
    items = [];
    active = -1;
  };

  const ensureList = () => {
    if (list) return list;
    list = document.createElement('ul');
    list.className = 'mention-suggestions';
    list.id = 'mention-suggestions';
    list.setAttribute('role', 'listbox');
    if (label) list.setAttribute('aria-label', label);
    list.hidden = true;
    // Keep the focus in the text box while choosing with the mouse.
    list.addEventListener('mousedown', event => event.preventDefault());
    list.addEventListener('click', event => {
      const option = event.target.closest('[data-index]');
      if (option) choose(Number(option.dataset.index));
    });
    document.body.append(list);
    return list;
  };

  const highlight = index => {
    active = index;
    list.querySelectorAll('[role="option"]').forEach((option, i) => {
      option.setAttribute('aria-selected', i === index ? 'true' : 'false');
    });
    if (index >= 0) field.setAttribute('aria-activedescendant', `mention-suggestion-${index}`);
  };

  const place = () => {
    const box = field.getBoundingClientRect();
    list.style.left = `${box.left + window.scrollX}px`;
    list.style.top = `${box.bottom + window.scrollY}px`;
    list.style.minWidth = `${Math.min(box.width, 320)}px`;
  };

  const show = users => {
    ensureList();
    items = users;
    if (!users.length) {
      close();
      return;
    }
    list.replaceChildren(
      ...users.map((user, index) => {
        const option = document.createElement('li');
        option.id = `mention-suggestion-${index}`;
        option.setAttribute('role', 'option');
        option.dataset.index = String(index);
        const name = document.createElement('span');
        name.className = 'mention-suggestion-name';
        name.textContent = user.name;
        const username = document.createElement('span');
        username.className = 'mention-suggestion-username';
        username.textContent = `@${user.username}`;
        option.append(name, ' ', username);
        return option;
      })
    );
    place();
    list.hidden = false;
    field.setAttribute('aria-controls', list.id);
    field.setAttribute('aria-expanded', 'true');
    highlight(0);
  };

  // The display name reads better in the text when it is a valid mention of
  // the same account; otherwise the username is used.
  const mentionText = user =>
    NAME_ONLY.test(user.name) && normalize(user.name) === user.username ? user.name : user.username;

  const choose = index => {
    const user = items[index];
    if (!user || !field || !typed) return;
    const { start, end } = typed;
    const insert = `@${mentionText(user)} `;
    field.setRangeText(insert, start, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    close();
    field.focus();
  };

  const lookup = textarea => {
    const caret = textarea.selectionStart;
    if (caret !== textarea.selectionEnd) return close();
    const match = TYPED_MENTION.exec(textarea.value.slice(0, caret));
    if (!match) return close();
    field = textarea;
    field.setAttribute('aria-autocomplete', 'list');
    typed = { start: caret - match[1].length - 1, end: caret };
    const query = match[1];
    const id = ++requestId;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const response = await fetch(`${endpoint}?q=${encodeURIComponent(query)}`, {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        if (!response.ok || id !== requestId) return;
        const data = await response.json();
        if (id === requestId) show(Array.isArray(data.users) ? data.users : []);
      } catch {
        close();
      }
    }, 150);
  };

  document.addEventListener('input', event => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement && target.hasAttribute('data-mention-suggest')) lookup(target);
  });

  document.addEventListener(
    'keydown',
    event => {
      if (!list || list.hidden || event.target !== field || !items.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        highlight((active + step + items.length) % items.length);
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        if (active < 0) return;
        event.preventDefault();
        choose(active);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    },
    true
  );

  document.addEventListener('focusout', event => {
    if (event.target === field) close();
  });
  window.addEventListener('resize', () => {
    if (list && !list.hidden) place();
  });
})();
