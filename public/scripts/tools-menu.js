// Tools menu in the site header. It is a <details> element, so it opens on
// click or tap and with the keyboard without JavaScript. This adds opening on
// hover for mouse users, and closing on Escape or a click elsewhere.
(() => {
  const menus = document.querySelectorAll('[data-tools-menu]');
  if (!menus.length) return;

  for (const menu of menus) {
    let closeTimer = null;
    let openedByHover = false;
    menu.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse') return;
      clearTimeout(closeTimer);
      if (!menu.open) openedByHover = true;
      menu.open = true;
    });
    menu.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'mouse') return;
      closeTimer = setTimeout(() => {
        menu.open = false;
        openedByHover = false;
      }, 200);
    });
    // A click right after hovering would otherwise close the menu it just
    // opened; keep it open instead.
    menu.querySelector('summary')?.addEventListener('click', event => {
      if (openedByHover) {
        event.preventDefault();
        openedByHover = false;
      }
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    });
  }

  document.addEventListener('click', event => {
    for (const menu of menus) {
      if (menu.open && !menu.contains(event.target)) menu.open = false;
    }
  });
})();
