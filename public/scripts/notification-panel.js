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

  function setUnread(count, label) {
    bell.setAttribute('aria-label', label);
    bell.setAttribute('title', label);
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

  var locale = document.documentElement.lang || undefined;
  var relative = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
    ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
    : null;
  var STEPS = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];

  function timeAgo(iso, fallback) {
    var seconds = (Date.parse(iso) - Date.now()) / 1000;
    if (!relative || Number.isNaN(seconds)) return fallback;
    for (var i = 0; i < STEPS.length; i++) {
      if (Math.abs(seconds) >= STEPS[i][1]) {
        return relative.format(Math.round(seconds / STEPS[i][1]), STEPS[i][0]);
      }
    }
    return relative.format(0, 'minute');
  }

  function render(data) {
    list.innerHTML = '';
    data.items.forEach(function (item) {
      var li = document.createElement('li');
      li.className = 'notification-panel-item' + (item.unread ? ' notification-panel-item--unread' : '');
      li.dataset.url = item.url;
      // The text is built and escaped on the server, like on the notifications page.
      var text = document.createElement('div');
      text.className = 'notification-panel-text';
      text.innerHTML = item.html;
      if (item.unread) {
        var unread = document.createElement('span');
        unread.className = 'visually-hidden';
        unread.textContent = ' (' + panel.dataset.newLabel + ')';
        text.appendChild(unread);
      }
      li.appendChild(text);
      var excerpt = document.createElement('p');
      excerpt.className = 'notification-panel-excerpt';
      excerpt.dir = 'auto';
      excerpt.textContent = item.excerpt || '';
      li.appendChild(excerpt);
      var time = document.createElement('time');
      time.className = 'notification-panel-time';
      time.dateTime = item.createdAt;
      time.title = item.date;
      time.textContent = timeAgo(item.createdAt, item.date);
      li.appendChild(time);
      list.appendChild(li);
    });
    setStatus(data.items.length ? '' : panel.dataset.empty);
    setUnread(data.unreadCount, data.bellLabel);
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
        load();
      })
      .catch(function () {
        setStatus(panel.dataset.error);
      })
      .finally(function () {
        readAll.disabled = false;
      });
  });

  // The whole item opens what it is about, not only the linked words.
  list.addEventListener('click', function (event) {
    var item = event.target.closest('.notification-panel-item');
    if (!item || event.target.closest('a')) return;
    window.location.href = item.dataset.url;
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
