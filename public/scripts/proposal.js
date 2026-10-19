(function () {
  document.querySelectorAll('[data-proposal-status-form]').forEach(function (form) {
    const select = form.querySelector('select[name="status"]');
    if (!select) return;
    function updateFields() {
      form.querySelectorAll('[data-proposal-statuses]').forEach(function (field) {
        const relevant = field.dataset.proposalStatuses.split(' ').includes(select.value);
        field.hidden = !relevant;
        field.querySelectorAll('input, textarea, select').forEach(function (control) {
          control.disabled = !relevant;
        });
      });
    }
    select.addEventListener('change', updateFields);
    updateFields();
  });
})();
