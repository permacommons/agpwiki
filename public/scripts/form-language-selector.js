document.querySelectorAll('.form-language-menu').forEach(menu => {
  const summary = menu.querySelector('summary');
  const label = menu.querySelector('.lang-menu-label');

  menu.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches('.form-language-radio') || !input.checked) {
      return;
    }
    if (label) label.textContent = input.value;
    menu.open = false;
    summary?.focus();
  });
});
