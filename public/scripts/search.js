// Progressive enhancement for page search inputs: fetches and renders live
// suggestions from /api/search while the user types.
//
// This script currently serves two distinct UIs:
// 1. The global header search form, which links directly to matching pages.
// 2. Forum page pickers, which populate a hidden canonical slug field from
//    the selected suggestion and can request category-specific search scopes.
//
// Keep those two call sites in mind when changing shared behavior here.
(function () {
  const initSearchRoot = ({
    root,
    input,
    suggestions,
    renderSuggestions,
    beforeFetch,
    searchScope,
  }) => {
    if (!root || !input || !suggestions) return;
    let timer;

    const clearSuggestions = () => {
      suggestions.innerHTML = '';
      suggestions.style.display = 'none';
    };

    input.addEventListener('input', () => {
      const query = input.value.trim();
      if (typeof beforeFetch === 'function') {
        beforeFetch(query);
      }
      if (!query) {
        clearSuggestions();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        const params = new URLSearchParams({ q: query });
        if (searchScope) {
          params.set('scope', searchScope);
        }
        fetch(`/api/search?${params.toString()}`)
          .then((res) => res.json())
          .then((data) => {
            const items = (data && data.results) || [];
            renderSuggestions(items, clearSuggestions);
          })
          .catch(() => clearSuggestions());
      }, 200);
    });

    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) {
        clearSuggestions();
      }
    });
  };

  const headerForm = document.querySelector('.search-form');
  if (headerForm) {
    // Header search remains an ordinary page search without scope filters or
    // hidden-field selection behavior.
    initSearchRoot({
      root: headerForm,
      input: headerForm.querySelector('.search-input'),
      suggestions: headerForm.querySelector('.search-suggestions'),
      renderSuggestions: (items) => {
        const suggestions = headerForm.querySelector('.search-suggestions');
        suggestions.innerHTML = items
          .map((item) => `<li><a href="/${item.slug}">${item.title}</a></li>`)
          .join('');
        suggestions.style.display = items.length ? 'block' : 'none';
      },
    });
  }

  document.querySelectorAll('[data-page-search-root]').forEach((root) => {
    if (!(root instanceof HTMLElement)) return;
    // Forum page pickers use the same live suggestions, but selection writes
    // the canonical slug into a hidden field for form submission.
    const input = root.querySelector('[data-page-search-input]');
    const suggestions = root.querySelector('[data-page-search-suggestions]');
    const hiddenSlug = root.querySelector('[data-page-search-slug]');
    if (
      !(input instanceof HTMLInputElement) ||
      !(suggestions instanceof HTMLElement) ||
      !(hiddenSlug instanceof HTMLInputElement)
    ) {
      return;
    }

    initSearchRoot({
      root,
      input,
      suggestions,
      searchScope: root.getAttribute('data-page-search-scope') || '',
      beforeFetch: () => {
        hiddenSlug.value = '';
      },
      renderSuggestions: (items, clearSuggestions) => {
        suggestions.innerHTML = items
          .map(
            (item) =>
              `<li><button type="button" class="search-suggestion-button" data-page-search-select="${item.slug}" data-page-search-title="${item.title}">${item.title}</button></li>`
          )
          .join('');
        suggestions.style.display = items.length ? 'block' : 'none';

        suggestions.querySelectorAll('[data-page-search-select]').forEach((button) => {
          button.addEventListener('click', () => {
            if (!(button instanceof HTMLElement)) return;
            hiddenSlug.value = button.getAttribute('data-page-search-select') || '';
            input.value = button.getAttribute('data-page-search-title') || '';
            clearSuggestions();
          });
        });
      },
    });
  });
})();
