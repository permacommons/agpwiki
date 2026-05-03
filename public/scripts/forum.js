document.querySelectorAll('[data-forum-quote-button]').forEach(button => {
  if (button.dataset.quoteBound === 'true') return;
  button.dataset.quoteBound = 'true';
  button.addEventListener('click', () => {
    const targetId = button.getAttribute('data-forum-quote-target');
    const markdown = button.getAttribute('data-forum-quote-markdown') ?? '';
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!(target instanceof HTMLTextAreaElement)) return;
    const separator = target.value.trim().length > 0 ? '\n' : '';
    target.value = `${target.value}${separator}${markdown}`;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);
  });
});
