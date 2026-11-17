(() => {
  let dialog;
  let editor;

  window.presencePhoneDayUrl = (studentId, date) => `/api/attendance/students/${encodeURIComponent(studentId)}/phone-handover/${encodeURIComponent(date)}`;

  window.getPresencePhoneDay = async function (studentId, date) {
    const response = await fetch(window.presencePhoneDayUrl(studentId, date), {
      credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.day === undefined) {
      throw new Error(payload.message || 'Не удалось проверить отметку о сдаче телефона.');
    }
    return payload.day;
  };

  window.savePresencePhoneDay = async function (studentId, date, answers, expectedRevision) {
    const response = await fetch(window.presencePhoneDayUrl(studentId, date), {
      method: 'PATCH', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, expectedRevision }),
    });
    const payload = await response.json().catch(() => ({}));
    const conflict = response.status === 409;
    if (!response.ok && !conflict) throw new Error(payload.message || 'Не удалось сохранить отметки о телефоне.');
    const day = conflict && payload.day === undefined ? await window.getPresencePhoneDay(studentId, date) : payload.day;
    if (day === undefined) throw new Error('Не удалось получить сохранённые отметки о телефоне.');
    return { day, conflict, message: payload.message || 'Отметки уже изменились. Проверьте значения и повторите правку.' };
  };

  window.choosePresencePhoneAnswer = async function ({ name, departure, current, studentId, date, useCurrent = false }) {
    if (departure) {
      if (!useCurrent) current = await window.getPresencePhoneDay(studentId, date);
      const handedIn = current?.submitted === true || Boolean(current?.submitted_after_notice_at);
      if (!handedIn || current.picked_up === true) return { phoneRevision: current?.revision || 0 };
    }
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'w-[calc(100%-2rem)] max-w-sm rounded-lg border border-slate-200 bg-white p-0 shadow-xl backdrop:bg-black/30';
      dialog.setAttribute('aria-labelledby', 'presence-phone-title');
      dialog.setAttribute('aria-describedby', 'presence-phone-student');
      dialog.innerHTML = `
        <form method="dialog" class="space-y-4 p-4 sm:p-5">
          <p id="presence-phone-student" class="text-sm font-medium text-slate-600"></p>
          <h2 id="presence-phone-title" class="text-xl font-semibold text-slate-950"></h2>
          <div class="grid grid-cols-2 gap-2">
            <button value="yes" class="min-h-11 rounded-lg border border-emerald-300 bg-emerald-100 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-200">Да</button>
            <button value="no" class="min-h-11 rounded-lg border border-red-300 bg-red-100 px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-200">Нет</button>
          </div>
          <button value="cancel" autofocus class="workspace-link min-h-11 w-full text-sm">Отмена</button>
        </form>`;
      document.body.append(dialog);
    }
    if (dialog.open || editor?.open) return null;
    dialog.querySelector('#presence-phone-student').textContent = `${name} · ${departure ? 'Уход' : 'Приход'}`;
    dialog.querySelector('#presence-phone-title').textContent = departure ? 'Забрал телефон?' : 'Сдал телефон?';
    const yes = dialog.querySelector('[value="yes"]');
    yes.textContent = departure ? 'Забрал' : 'Да';
    yes.classList.toggle('col-span-2', departure);
    dialog.querySelector('[value="no"]').classList.toggle('hidden', departure);
    dialog.returnValue = 'cancel';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        const answer = dialog.returnValue;
        if (answer === 'yes' || (!departure && answer === 'no')) {
          resolve({ phoneSubmitted: answer === 'yes', phoneAction: departure ? 'pickup' : 'handover', phoneRevision: current?.revision || 0 });
        } else resolve(null);
      }, { once: true });
      dialog.showModal();
    });
  };

  window.editPresencePhone = function ({ name, current, trigger, save }) {
    if (!editor) {
      editor = document.createElement('dialog');
      editor.className = 'w-[calc(100%-2rem)] max-w-sm rounded-xl border border-slate-200 bg-white p-0 text-slate-950 shadow-xl backdrop:bg-slate-950/30';
      editor.setAttribute('aria-labelledby', 'presence-phone-edit-title');
      editor.setAttribute('aria-describedby', 'presence-phone-edit-student');
      editor.innerHTML = `
        <form class="space-y-4 p-4 sm:p-5">
          <div>
            <p id="presence-phone-edit-student" class="text-sm font-medium text-slate-600"></p>
            <h2 id="presence-phone-edit-title" class="text-xl font-semibold">Телефон за сегодня</h2>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="min-w-0 text-sm font-medium"><span id="presence-phone-submitted-label" class="mb-1 block">Сдача</span>
              <select name="submitted" aria-labelledby="presence-phone-submitted-label" autofocus class="min-h-11 w-full rounded-md border border-slate-300 bg-white px-2">
                <option value="unset">Нет отметки</option>
                <option value="yes">Сдал</option>
                <option value="no">Не сдал</option>
              </select>
            </label>
            <label class="min-w-0 text-sm font-medium"><span id="presence-phone-pickup-label" class="mb-1 block">Получение</span>
              <select name="picked_up" aria-labelledby="presence-phone-pickup-label" class="min-h-11 w-full rounded-md border border-slate-300 bg-white px-2">
                <option value="unset">Нет отметки</option>
                <option value="yes">Забрал</option>
                <option value="no">Не забрал</option>
              </select>
            </label>
          </div>
          <div data-phone-notice-section class="rounded-md border border-slate-200 p-3" hidden>
            <p data-phone-notice-status class="mb-1 text-sm text-amber-800" hidden></p>
            <button type="button" data-phone-notice-action class="workspace-secondary min-h-11 w-full disabled:opacity-50"></button>
          </div>
          <p data-phone-editor-message role="alert" class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" hidden></p>
          <div class="flex flex-wrap justify-end gap-2">
            <button type="button" data-phone-editor-cancel class="workspace-secondary min-h-11">Отмена</button>
            <button type="submit" class="workspace-primary min-h-11 disabled:opacity-50">Сохранить</button>
          </div>
        </form>`;
      document.body.append(editor);
    }
    if (editor.open || dialog?.open) return Promise.resolve(false);

    const form = editor.querySelector('form');
    const message = editor.querySelector('[data-phone-editor-message]');
    const cancel = form.querySelector('[data-phone-editor-cancel]');
    const submit = form.querySelector('[type="submit"]');
    const noticeSection = form.querySelector('[data-phone-notice-section]');
    const noticeStatus = form.querySelector('[data-phone-notice-status]');
    const noticeAction = form.querySelector('[data-phone-notice-action]');
    const fields = ['submitted', 'picked_up'];
    let baseline = current;
    let busy = false;
    let saved = false;
    const valueFor = (value) => value === true ? 'yes' : value === false ? 'no' : 'unset';
    const answerFor = (value) => value === 'unset' ? null : value === 'yes';
    const hasChanges = () => fields.some((field) => form.elements[field].value !== valueFor(baseline?.[field]));
    const showMessage = (text) => { message.textContent = text; message.hidden = !text; };
    function syncForm() {
      for (const field of fields) form.elements[field].value = valueFor(baseline?.[field]);
      const marked = Boolean(baseline?.submitted_after_notice_at);
      form.elements.submitted.disabled = marked;
      noticeSection.hidden = baseline?.submitted !== false;
      noticeStatus.textContent = marked ? `Сдал после замечания · ${baseline.submitted_after_notice_at.slice(11, 16)}` : '';
      noticeStatus.hidden = !marked;
      noticeAction.textContent = marked ? 'Снять отметку после замечания' : 'Сдал после замечания';
      submit.disabled = true;
    }

    editor.querySelector('#presence-phone-edit-student').textContent = name;
    showMessage('');
    syncForm();
    return new Promise((resolve) => {
      const listeners = new AbortController();
      const { signal } = listeners;
      editor.addEventListener('close', () => {
        listeners.abort();
        trigger?.focus({ preventScroll: true });
        resolve(saved);
      }, { once: true, signal });
      editor.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); }, { signal });
      cancel.addEventListener('click', () => editor.close(), { signal });
      const updateActions = () => {
        form.elements.submitted.disabled = Boolean(baseline?.submitted_after_notice_at);
        submit.disabled = !hasChanges();
        noticeAction.disabled = hasChanges();
      };
      form.addEventListener('change', updateActions, { signal });
      const persist = async (answers) => {
        busy = true;
        showMessage('');
        for (const control of form.elements) control.disabled = true;
        try {
          const result = await save(answers, baseline?.revision || 0);
          if (result.conflict) {
            baseline = result.day;
            syncForm();
            showMessage(result.message);
          } else {
            saved = true;
            editor.close();
          }
        } catch (err) {
          showMessage(err.message || 'Не удалось сохранить отметки о телефоне.');
        } finally {
          busy = false;
          for (const control of form.elements) control.disabled = false;
          updateActions();
          if (editor.open) (form.elements.submitted.disabled ? noticeAction : form.elements.submitted).focus();
        }
      };
      noticeAction.addEventListener('click', () => {
        if (busy || noticeAction.disabled) return;
        persist({ submitted_after_notice: baseline?.submitted_after_notice_at ? null : true });
      }, { signal });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (busy || !hasChanges()) return;
        const answers = Object.fromEntries(fields
          .filter((field) => form.elements[field].value !== valueFor(baseline?.[field]))
          .map((field) => [field, answerFor(form.elements[field].value)]));
        persist(answers);
      }, { signal });
      editor.showModal();
    });
  };
})();
