// The bell opens a panel with the latest notifications. Without this script
// the bell is a plain link to the notifications page.
(function () {
  var bell = document.querySelector('[data-notification-bell]');
  var panel = document.querySelector('[data-notification-panel]');
  if (!bell || !panel) return;
  var list = panel.querySelector('[data-notification-list]');
  var status = panel.querySelector('[data-notification-status]');
  var readAll = panel.querySelector('[data-notification-read-all]');

  function setStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }

  function setUnread(count) {
    var badge = bell.querySelector('.notification-bell-count');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'notification-bell-count';
        bell.appendChild(badge);
      }
      badge.textContent = String(count);
    } else if (badge) {
      badge.remove();
    }
    bell.classList.toggle('notification-bell--unread', count > 0);
    readAll.hidden = count === 0;
  }

  function render(data) {
    list.innerHTML = '';
    data.items.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'notification-panel-item' + (item.unread ? ' notification-panel-item--unread' : '');
      // The text is built and escaped on the server, like on the notifications page.
      var text = document.createElement('div');
      text.innerHTML = item.html;
      li.appendChild(text);
      if (item.excerpt) {
        var excerpt = document.createElement('p');
        excerpt.className = 'notification-panel-excerpt';
        excerpt.dir = 'auto';
        excerpt.textContent = item.excerpt;
        li.appendChild(excerpt);
      }
      var meta = document.createElement('div');
      meta.className = 'notification-panel-meta';
      meta.textContent = item.date + (item.unread ? ' · ' + panel.dataset.newLabel : '');
      li.appendChild(meta);
      list.appendChild(li);
    });
    setStatus(data.items.length ? '' : panel.dataset.empty);
    setUnread(data.unreadCount);
  }

  function load() {
    setStatus(panel.dataset.loading);
    fetch(panel.dataset.endpoint, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(render)
      .catch(function () {
        setStatus(panel.dataset.error);
      });
  }

  function isOpen() {
    return !panel.hidden;
  }

  function open() {
    panel.hidden = false;
    bell.setAttribute('aria-expanded', 'true');
    load();
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    panel.hidden = true;
    bell.setAttribute('aria-expanded', 'false');
    if (returnFocus) bell.focus();
  }

  bell.addEventListener('click', function (event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (isOpen()) close(false);
    else open();
  });

  readAll.addEventListener('click', function () {
    readAll.disabled = true;
    fetch(panel.dataset.readEndpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      credentials: 'same-origin',
      body: '',
    })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function () {
        var bar = document.querySelector('.notification-bar');
        if (bar) bar.remove();
        load();
      })
      .catch(function () {
        setStatus(panel.dataset.error);
      })
      .finally(function () {
        readAll.disabled = false;
      });
  });

  document.addEventListener('click', function (event) {
    if (!isOpen()) return;
    if (panel.contains(event.target) || bell.contains(event.target)) return;
    close(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && isOpen()) close(true);
  });
})();
