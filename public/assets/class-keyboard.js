(() => {
  function enhance(select) {
    const keyboard = document.createElement('div');
    keyboard.className = 'class-keyboard';
    keyboard.setAttribute('role', 'group');
    keyboard.setAttribute('aria-label', select.dataset.classKeyboard);

    function updateSelection() {
      for (const key of keyboard.children) {
        key.setAttribute('aria-pressed', String(key.value === select.value));
      }
    }

    function renderKeys() {
      const focusedValue = keyboard.contains(document.activeElement) ? document.activeElement.value : null;
      const keys = Array.from(select.options, (option) => {
        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'class-keyboard-key';
        key.value = option.value;
        key.textContent = option.label;
        return key;
      });
      keyboard.replaceChildren(...keys);
      updateSelection();
      if (focusedValue !== null) {
        keys.find((key) => key.value === focusedValue)?.focus({ preventScroll: true });
      }
    }

    keyboard.addEventListener('click', (event) => {
      const key = event.target.closest('button');
      if (!key || select.value === key.value) return;
      select.value = key.value;
      updateSelection();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    select.addEventListener('input', updateSelection);
    new MutationObserver(renderKeys).observe(select, { childList: true });
    renderKeys();
    select.after(keyboard);
    select.hidden = true;
  }

  function initialize() {
    document.querySelectorAll('select[data-class-keyboard]:not([hidden])').forEach(enhance);
  }

  initialize();
  document.addEventListener('attendance:analytics-refreshed', initialize);
})();
