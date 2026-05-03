const debounce = (fn, delay) => {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
};

const updatePreviewRoots = () => {
  document.querySelectorAll('[data-markdown-preview-root]').forEach(root => {
    if (!(root instanceof HTMLElement) || root.dataset.previewBound === 'true') return;
    root.dataset.previewBound = 'true';

    const endpoint = root.dataset.markdownPreviewEndpoint;
    const formId = root.dataset.markdownPreviewForm;
    const outputId = root.dataset.markdownPreviewOutput;
    const emptyText = root.dataset.markdownPreviewEmpty ?? '';
    const errorText = root.dataset.markdownPreviewError ?? 'Preview unavailable.';
    const form = formId ? document.getElementById(formId) : null;
    const output = outputId ? document.getElementById(outputId) : null;

    if (!(form instanceof HTMLFormElement) || !(output instanceof HTMLElement) || !endpoint) {
      return;
    }

    const previewFields = [...form.querySelectorAll('[data-markdown-preview-field]')].filter(
      field =>
        field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement
    );

    if (previewFields.length === 0) return;

    let requestId = 0;
    const renderPreview = debounce(async () => {
      const payload = {};
      let hasContent = false;

      previewFields.forEach(field => {
        const name = field.getAttribute('name');
        if (!name) return;
        payload[name] = field.value;
        if (field.value.trim().length > 0) {
          hasContent = true;
        }
      });

      if (!hasContent) {
        output.innerHTML = `<p class="markdown-preview-empty">${emptyText}</p>`;
        return;
      }

      const currentRequestId = ++requestId;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const responsePayload = await response.json();
        if (currentRequestId !== requestId) return;
        output.innerHTML = responsePayload.html?.trim()
          ? responsePayload.html
          : `<p class="markdown-preview-empty">${emptyText}</p>`;
      } catch (_error) {
        if (currentRequestId !== requestId) return;
        output.innerHTML = `<p class="markdown-preview-status">${errorText}</p>`;
      }
    }, 250);

    previewFields.forEach(field => {
      field.addEventListener('input', renderPreview);
      field.addEventListener('change', renderPreview);
    });
  });
};

updatePreviewRoots();
