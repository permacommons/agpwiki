(function () {
  const form = document.querySelector('.search-form');
  if (!form) return;
  const input = form.querySelector('.search-input');
  const suggestions = form.querySelector('.search-suggestions');
  let timer;

  const clearSuggestions = () => {
    suggestions.innerHTML = '';
    suggestions.style.display = 'none';
  };

  const renderSuggestions = (items) => {
    suggestions.innerHTML = items
      .map((item) => `<li><a href="/${item.slug}">${item.title}</a></li>`)
      .join('');
    suggestions.style.display = items.length ? 'block' : 'none';
  };

  input.addEventListener('input', () => {
    const query = input.value.trim();
    if (!query) {
      clearSuggestions();
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((res) => res.json())
        .then((data) => {
          const items = (data && data.results) || [];
          renderSuggestions(items);
        })
        .catch(() => clearSuggestions());
    }, 200);
  });

  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) {
      clearSuggestions();
    }
  });
})();
