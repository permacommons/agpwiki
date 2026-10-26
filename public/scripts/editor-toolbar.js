// Formatting buttons above the edit form's text. Each inserts Markdown at the
// cursor, so newcomers don't have to remember it. Without this script the
// toolbar stays hidden and the form works as before.
(function () {
  document.querySelectorAll('[data-editor-toolbar]').forEach(function (toolbar) {
    var textarea = document.getElementById(toolbar.dataset.target);
    if (!textarea) return;
    var search = toolbar.querySelector('[data-citation-search]');
    var searchInput = search.querySelector('input');
    var results = search.querySelector('ul');

    function changed() {
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
    }

    function replaceSelection(before, after, placeholder) {
      var start = textarea.selectionStart;
      var end = textarea.selectionEnd;
      var selected = textarea.value.slice(start, end) || placeholder || '';
      textarea.setRangeText(before + selected + after, start, end, 'end');
      textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
      changed();
    }

    // Applies a prefix to every line touched by the selection.
    function prefixLines(prefix) {
      var value = textarea.value;
      var start = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
      var endIndex = value.indexOf('\n', textarea.selectionEnd);
      var end = endIndex === -1 ? value.length : endIndex;
      var lines = value.slice(start, end).split('\n').map(function (line) {
        return line.indexOf(prefix) === 0 ? line : prefix + line;
      });
      textarea.setRangeText(lines.join('\n'), start, end, 'end');
      changed();
    }

    function insertAtCursor(text) {
      textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
      changed();
    }

    var timer = null;
    function runSearch() {
      var query = searchInput.value.trim();
      if (query.length < 2) {
        results.innerHTML = '';
        return;
      }
      fetch(toolbar.dataset.citationEndpoint + '?q=' + encodeURIComponent(query), {
        headers: { Accept: 'application/json' },
      })
        .then(function (response) {
          return response.ok ? response.json() : { results: [] };
        })
        .then(function (data) {
          results.innerHTML = '';
          if (!data.results.length) {
            var none = document.createElement('li');
            none.textContent = toolbar.dataset.citationNone;
            none.setAttribute('aria-disabled', 'true');
            results.appendChild(none);
            return;
          }
          data.results.forEach(function (item) {
            var li = document.createElement('li');
            li.textContent = item.label;
            li.dataset.key = item.key;
            li.tabIndex = 0;
            li.setAttribute('role', 'option');
            results.appendChild(li);
          });
        })
        .catch(function () {
          results.innerHTML = '';
        });
    }

    function pick(li) {
      if (!li || !li.dataset.key) return;
      search.hidden = true;
      searchInput.value = '';
      results.innerHTML = '';
      insertAtCursor('[@' + li.dataset.key + ']');
    }

    toolbar.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]');
      if (button) {
        var action = button.dataset.action;
        if (action === 'bold') replaceSelection('**', '**', '');
        else if (action === 'italic') replaceSelection('*', '*', '');
        else if (action === 'heading') prefixLines('## ');
        else if (action === 'list') prefixLines('- ');
        else if (action === 'link') {
          var address = window.prompt(toolbar.dataset.linkPrompt);
          if (address) replaceSelection('[', '](/' + address.trim().replace(/^\/+/, '') + ')', address.trim());
        } else if (action === 'citation') {
          search.hidden = !search.hidden;
          if (!search.hidden) searchInput.focus();
        }
        return;
      }
      pick(event.target.closest('li'));
    });

    results.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        pick(event.target.closest('li'));
      }
    });

    searchInput.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 250);
    });

    searchInput.addEventListener('keydown', function (event) {
      // Enter must not submit the edit form from the search box.
      if (event.key === 'Enter') {
        event.preventDefault();
        pick(results.querySelector('li[data-key]'));
      }
      if (event.key === 'Escape') {
        search.hidden = true;
        textarea.focus();
      }
    });
  });
})();
