document.documentElement.classList.add('js');

const debounce = (fn, delay) => {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
};

const updateQuoteButtons = () => {
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
};

const updatePreviewRoots = () => {
  document.querySelectorAll('[data-markdown-preview-root]').forEach(root => {
    if (!(root instanceof HTMLElement) || root.dataset.previewBound === 'true') return;
    root.dataset.previewBound = 'true';

    const endpoint = root.dataset.markdownPreviewEndpoint;
    const inputId = root.dataset.markdownPreviewInput;
    const outputId = root.dataset.markdownPreviewOutput;
    const emptyText = root.dataset.markdownPreviewEmpty ?? '';
    const loadingText = root.dataset.markdownPreviewLoading ?? 'Loading preview...';
    const errorText = root.dataset.markdownPreviewError ?? 'Preview unavailable.';
    const input = inputId ? document.getElementById(inputId) : null;
    const output = outputId ? document.getElementById(outputId) : null;

    if (!(input instanceof HTMLTextAreaElement) || !(output instanceof HTMLElement) || !endpoint) {
      return;
    }

    let requestId = 0;
    const renderPreview = debounce(async () => {
      const source = input.value;
      if (source.trim().length === 0) {
        output.innerHTML = `<p class="markdown-preview-empty">${emptyText}</p>`;
        return;
      }

      const currentRequestId = ++requestId;
      output.innerHTML = `<p class="markdown-preview-status">${loadingText}</p>`;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ source }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (currentRequestId !== requestId) return;
        output.innerHTML = payload.html?.trim()
          ? payload.html
          : `<p class="markdown-preview-empty">${emptyText}</p>`;
      } catch (_error) {
        if (currentRequestId !== requestId) return;
        output.innerHTML = `<p class="markdown-preview-status">${errorText}</p>`;
      }
    }, 250);

    input.addEventListener('input', renderPreview);
  });
};

updateQuoteButtons();
updatePreviewRoots();
