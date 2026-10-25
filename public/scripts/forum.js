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

document.querySelectorAll('[data-comment-edit]').forEach(comment => {
  const link = comment.querySelector('[data-comment-edit-link]');
  const content = comment.querySelector('[data-comment-content]');
  const actions = comment.querySelector('[data-comment-actions]');
  const editor = comment.querySelector('[data-comment-editor]');
  const cancel = editor?.querySelector('[data-comment-edit-cancel]');
  const textarea = editor?.querySelector('textarea');
  if (!link || !content || !actions || !editor || !cancel || !textarea) return;

  const close = () => {
    editor.reset();
    const selectedLanguage = editor.querySelector('input[name="language"]:checked');
    const languageLabel = editor.querySelector('.lang-menu-label');
    if (languageLabel && selectedLanguage) languageLabel.textContent = selectedLanguage.value;
    editor.querySelectorAll('details').forEach(menu => { menu.open = false; });
    editor.hidden = true;
    content.hidden = false;
    actions.hidden = false;
    link.focus();
  };

  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const contentHeight = content.clientHeight;
    content.hidden = true;
    actions.hidden = true;
    editor.hidden = false;
    textarea.style.height = `${Math.max(contentHeight, textarea.scrollHeight)}px`;
    textarea.focus();
  });
  cancel.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    close();
  });
  editor.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || editor.querySelector('details[open]')) return;
    event.preventDefault();
    close();
  });
});
