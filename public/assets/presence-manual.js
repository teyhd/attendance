(() => {
  const root = document.querySelector('[data-presence-root]');
  if (!root) return;

  const buttons = Array.from(root.querySelectorAll('[data-presence-button]'));
  const buttonsById = new Map(buttons.map((button) => [button.dataset.studentId, button]));
  const syncBanner = root.querySelector('[data-presence-sync]');
  const syncText = root.querySelector('[data-presence-sync-text]');
  const retryButton = root.querySelector('[data-presence-retry]');
  const dismissExpiredButton = root.querySelector('[data-presence-dismiss-expired]');
  const reloadButton = root.querySelector('[data-presence-reload]');
  const flash = root.querySelector('[data-presence-flash]');
  const flashText = root.querySelector('[data-presence-flash-text]');
  const cancelButton = root.querySelector('[data-presence-cancel]');
  const classList = root.querySelector('[data-presence-class-list]');
  const classPicker = root.querySelector('[data-manual-class-picker]');
  const classKeys = root.querySelector('[data-manual-class-keys]');
  const search = root.querySelector('[data-manual-search]');
  const searchEmpty = root.querySelector('[data-manual-search-empty]');
  const classes = Array.from(root.querySelectorAll('[data-presence-class]'));
  const presentTotal = root.querySelector('[data-manual-present]');
  classPicker?.addEventListener('change', () => {
    if (search?.value) {
      search.value = '';
      filterCards();
    }
    const target = document.getElementById(classPicker.value);
    target?.scrollIntoView({ block: 'start' });
  });
  (classKeys || classList)?.addEventListener('click', (event) => {
    if (!event.target.closest('a') || !search?.value) return;
    search.value = '';
    filterCards();
  });
  if (classKeys) {
    const toolbar = root.querySelector('[data-manual-toolbar]');
    const updateScrollMargin = () => root.style.setProperty('--manual-scroll-margin', `${toolbar.offsetHeight + 16}px`);
    const updateCurrentClass = () => {
      for (const link of classKeys.querySelectorAll('a')) {
        if (link.hash === window.location.hash) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      }
    };
    updateScrollMargin();
    new ResizeObserver(updateScrollMargin).observe(toolbar);
    updateCurrentClass();
    window.addEventListener('hashchange', updateCurrentClass);
  }
  search?.addEventListener('input', filterCards);
  const historyDialog = root.parentElement?.querySelector('[data-presence-history-dialog]');
  const historyTitle = historyDialog?.querySelector('[data-presence-history-title]');
  const historyContent = historyDialog?.querySelector('.manual-history-content');
  const historyEvents = historyDialog?.querySelector('[data-presence-history-events]');
  const historyError = historyDialog?.querySelector('[data-history-error]');
  const fullHistory = historyDialog?.querySelector('[data-full-history]');
  const historyData = parseJsonScript('presence-history-data');
  let historyStudentId;
  const flashBase = 'flex items-center gap-3 rounded-md border px-3 py-2 text-sm shadow-sm';

  const syncClassListLayout = () => {
    if (!classList) return;
    classList.classList.remove('is-two-rows');
    classList.classList.toggle('is-two-rows', classList.scrollWidth > classList.clientWidth + 1);
  };
  window.requestAnimationFrame(syncClassListLayout);
  window.addEventListener('resize', syncClassListLayout);

  const eventLabel = (type) => type === 'departure' ? 'Ушёл' : 'Присутствует';
  const cardToneClasses = [
    'border-red-300', 'bg-red-50', 'hover:bg-red-100',
    'border-amber-300', 'bg-amber-50', 'hover:bg-amber-100',
    'border-emerald-600', 'bg-emerald-50', 'hover:bg-emerald-100',
    'border-slate-300', 'bg-slate-50', 'hover:bg-slate-100',
    'border-gray-300', 'bg-white', 'hover:bg-gray-50',
  ];
  const statusToneClasses = [
    'bg-red-100', 'text-red-800',
    'bg-amber-100', 'text-amber-800',
    'bg-emerald-100', 'text-emerald-800',
    'bg-slate-200', 'text-slate-700',
    'bg-gray-100', 'text-gray-600',
  ];
  const cardTone = {
    conflict: ['border-red-300', 'bg-red-50', 'hover:bg-red-100'],
    absent: ['border-red-300', 'bg-red-50', 'hover:bg-red-100'],
    late: ['border-amber-300', 'bg-amber-50', 'hover:bg-amber-100'],
    present: ['border-emerald-600', 'bg-emerald-50', 'hover:bg-emerald-100'],
    departed: ['border-slate-300', 'bg-slate-50', 'hover:bg-slate-100'],
    none: ['border-gray-300', 'bg-white', 'hover:bg-gray-50'],
  };
  const statusTone = {
    conflict: ['bg-red-100', 'text-red-800'],
    absent: ['bg-red-100', 'text-red-800'],
    late: ['bg-amber-100', 'text-amber-800'],
    present: ['bg-emerald-100', 'text-emerald-800'],
    departed: ['bg-slate-200', 'text-slate-700'],
    none: ['bg-gray-100', 'text-gray-600'],
  };
  const newKey = () => window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { date, actorId, audience } = root.dataset;
  const schoolDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' });
  const captureLabel = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium' });
  const maxClockElapsed = 12 * 60 * 60 * 1000;
  const storagePrefix = `attendance:manual:v1:${actorId}:${audience}:`;
  const commands = new Map();
  const storedKeys = new Set();
  const failures = new Map();
  const awaitingRefresh = new Set();
  const rejected = new Map();
  const snapshots = new Map();
  const maxAttempts = 6;
  let etag = '';
  let pollRequest;
  let pollTimer;
  let sendTimer;
  let sending = false;
  let generation = 0;
  let pollFailures = 0;
  const navigation = performance.getEntriesByType('navigation')[0];
  const navigationDelay = navigation ? navigation.responseStart - navigation.requestStart : Infinity;
  let serverClock = navigation?.requestStart > 0 && navigationDelay >= 0 && navigationDelay <= 2000
    ? clockAnchor(root.dataset.clockToken, navigation.responseStart)
    : null;
  let clockHint = '';
  let captureDialogs = 0;
  let boardReady = false;
  let blocked = '';
  const expiredKeys = new Set();
  let inaccessible = 0;

  const retryDelay = (attempts) => Math.min(60_000, 1500 * 2 ** Math.min(attempts, 6)) * (0.75 + Math.random() * 0.5);
  const nextPollDelay = () => pollFailures ? retryDelay(pollFailures) : 6000 + Math.random() * 3000;

  function clockAnchor(token, monotonicAt) {
    if (!/^\d{13}\.[\w-]{43}$/.test(token || '')) return null;
    return { token, time: Number(token.slice(0, 13)), monotonicAt };
  }

  function captureTime() {
    if (!serverClock) return null;
    const elapsedMs = Math.round(performance.now() - serverClock.monotonicAt);
    if (elapsedMs < 0 || elapsedMs > maxClockElapsed) return null;
    if (schoolDate.format(serverClock.time + elapsedMs) !== date) return null;
    return { token: serverClock.token, elapsedMs };
  }

  function commandTime(command) {
    const capture = command.capture;
    const anchor = clockAnchor(capture?.token, 0);
    if (!anchor || !Number.isSafeInteger(capture.elapsedMs) || capture.elapsedMs < 0 || capture.elapsedMs > maxClockElapsed) return '';
    return captureLabel.format(anchor.time + capture.elapsedMs);
  }

  function filterCards() {
    const normalize = (value) => value.toLocaleLowerCase('ru').replaceAll('ё', 'е').trim();
    const words = normalize(search.value).split(/\s+/).filter(Boolean);
    let count = 0;
    for (const section of classes) {
      let matches = 0;
      for (const card of section.querySelectorAll('.manual-presence-card')) {
        const name = normalize(card.querySelector('[data-presence-name]').textContent);
        card.hidden = !words.every((word) => name.includes(word));
        if (!card.hidden) matches += 1;
      }
      section.hidden = matches === 0;
      count += matches;
    }
    searchEmpty.hidden = count > 0;
  }

  function parseJsonScript(id) {
    const source = document.getElementById(id);
    if (!source) return [];
    try {
      const parsed = JSON.parse(source.textContent || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  const studentsById = new Map(historyData.flatMap(({ students }) => students.map((student) => [String(student.id), student])));

  function findStudent(studentId) {
    return studentsById.get(String(studentId));
  }

  function historyEventLabel(event) {
    if (event.source === 'mentor_manual_late') return 'Опоздал · вручную';
    if (event.source === 'face') return event.event_type === 'departure' ? 'Ушёл · камера' : 'Пришёл · камера';
    return event.event_type === 'departure' ? 'Ушёл · вручную' : 'Пришёл · вручную';
  }

  function renderHistory(student, preserve = false) {
    if (!historyTitle || !historyEvents || !student) return;
    historyTitle.textContent = `${student.name} · История за сегодня`;
    if (!preserve) historyError.hidden = true;
    const previousScroll = preserve ? historyContent.scrollTop : 0;
    const selectedEvent = preserve ? document.activeElement?.dataset.presenceHistoryCancel : '';
    if (fullHistory) fullHistory.href = '/attendance/analytics?' + new URLSearchParams({ class: student.classId, student: student.id, tab: 'history' });
    historyEvents.replaceChildren();
    const events = Array.isArray(student.presence_events) ? student.presence_events : [];
    if (!events.length) {
      const empty = document.createElement('div');
      empty.className = 'rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500';
      empty.textContent = 'За сегодня отметок пока нет.';
      historyEvents.append(empty);
      return;
    }

    for (const event of events) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2';
      const details = document.createElement('div');
      const time = document.createElement('div');
      time.className = 'text-sm font-medium text-gray-900';
      time.textContent = event.occurred_time || event.occurred_label || event.occurred_at || '';
      const label = document.createElement('div');
      label.className = 'mt-0.5 text-xs text-gray-600';
      label.textContent = historyEventLabel(event);
      details.append(time, label);
      row.append(details);

      if ((event.can_cancel ?? event.can_edit) && event.source !== 'face') {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.dataset.presenceHistoryCancel = event.id || '';
        cancel.dataset.expectedUpdatedAt = event.expected_updated_at || '';
        cancel.className = 'shrink-0 rounded border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60';
        cancel.textContent = 'Отменить';
        row.append(cancel);
        if (cancel.dataset.presenceHistoryCancel === selectedEvent) cancel.dataset.restoreFocus = '';
      }
      historyEvents.append(row);
    }
    historyContent.scrollTop = previousScroll;
    historyEvents.querySelector('[data-restore-focus]')?.focus({ preventScroll: true });
  }

  function closeHistoryDialog() {
    if (!historyDialog) return;
    if (typeof historyDialog.close === 'function') historyDialog.close();
    else historyDialog.removeAttribute('open');
  }

  function setFlash(text, { kind = 'ok', eventId = '' } = {}) {
    if (!flash || !flashText) return;
    const kindClass = kind === 'error'
      ? 'border-red-200 bg-red-50 text-red-900'
      : 'border-emerald-200 bg-emerald-50 text-emerald-900';
    flash.className = `${flashBase} ${kindClass}`;
    flashText.textContent = text;
    if (cancelButton) {
      cancelButton.dataset.eventId = eventId;
      cancelButton.classList.toggle('hidden', !eventId);
    }
  }

  async function postJson(url, body = {}) {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || response.redirected || response.status === 200 && !Object.keys(payload).length) {
      const error = new Error(payload.message || payload.error || 'Не удалось сохранить');
      error.status = response.redirected ? 401 : response.ok ? 503 : response.status;
      throw error;
    }
    return payload;
  }

  function applyState(button, state) {
    const status = button.querySelector('[data-presence-status]');
    const detail = button.querySelector('[data-presence-detail]');
    const next = button.querySelector('[data-presence-next]');
    const statusCode = state?.status_code || (state?.is_present ? 'present' : 'none');
    const conflictId = state?.conflict_id || '';
    const name = button.querySelector('[data-presence-name]').textContent;
    button.dataset.lastEventId = state?.last_event_id || '';
    button.dataset.lastEventRevision = state?.last_event_revision || 0;
    button.dataset.lastEventType = state?.last_event_type || '';
    button.dataset.statusCode = statusCode;
    button.dataset.conflictId = conflictId;
    next.textContent = state?.next_action_label || 'Отметить приход';
    next.classList.toggle('hidden', Boolean(conflictId));
    button.setAttribute('aria-label', [name, state?.status_label || 'Нет отметки', conflictId ? '' : next.textContent].filter(Boolean).join(' · '));

    status.textContent = state?.is_late ? state.status_label : state?.status_badge_label || state?.status_word || state?.current_status_label || 'Нет отметки';
    if (detail) detail.textContent = state?.status_detail || state?.status_time || '';
    const card = button.parentElement;
    card.classList.remove(...cardToneClasses);
    card.classList.add(...(cardTone[statusCode] || cardTone.none));
    card.querySelector('[data-conflict-actions]').classList.toggle('hidden', !conflictId);
    card.querySelectorAll('[data-conflict-resolve]').forEach((control) => { control.dataset.conflictId = conflictId; });
    status.classList.remove(...statusToneClasses);
    status.classList.add(...(statusTone[statusCode] || statusTone.none));
  }

  function updatePhoneLabel(button, phoneCheck) {
    const label = button.querySelector('[data-phone-answer]');
    if (!label) return;
    const afterNotice = Boolean(phoneCheck?.submitted_after_notice_at);
    const submitted = phoneCheck?.submitted;
    const pickup = phoneCheck?.picked_up;
    label.textContent = afterNotice ? 'сдал после замечания' : submitted === true ? 'сдал' : submitted === false ? 'не сдал' : 'нет отметки';
    label.classList.toggle('text-amber-800', afterNotice);
    label.classList.toggle('text-emerald-800', !afterNotice && submitted === true);
    label.classList.toggle('text-red-800', !afterNotice && submitted === false);
    button.querySelector('[data-phone-pickup]').textContent = pickup === true ? ' · забрал' : pickup === false ? ' · не забрал' : '';
    const notice = button.parentElement.querySelector('[data-phone-after-notice]');
    if (notice) {
      notice.hidden = phoneCheck?.submitted !== false || Boolean(phoneCheck?.submitted_after_notice_at);
      notice.classList.toggle('hidden', notice.hidden);
    }
  }

  function updateTotal() {
    presentTotal.textContent = buttons.filter((item) => ['present', 'late'].includes(item.dataset.statusCode)).length;
  }

  function updateQueueStatus() {
    const pendingStudents = new Set([...commands.values()].map((command) => command.studentId));
    for (const button of buttons) {
      const pending = pendingStudents.has(button.dataset.studentId);
      const disabled = Boolean(blocked || pending || awaitingRefresh.has(button.dataset.studentId));
      const indicator = button.querySelector('[data-presence-pending]');
      const rejection = rejected.get(button.dataset.studentId);
      const indicatorText = pending ? 'Ожидает отправки' : rejection || '';
      if (indicator.textContent !== indicatorText) indicator.textContent = indicatorText;
      if (indicator.hidden === Boolean(indicatorText)) indicator.hidden = !indicatorText;
      indicator.classList.toggle('text-red-800', !pending && Boolean(rejection));
      if (button.disabled !== disabled) button.disabled = disabled;
      const ariaDisabled = String(disabled || Boolean(button.dataset.conflictId));
      if (button.getAttribute('aria-disabled') !== ariaDisabled) button.setAttribute('aria-disabled', ariaDisabled);
    }
    const messages = [];
    if (blocked) messages.push(blocked);
    else if (!navigator.onLine || pollFailures) messages.push('Нет связи с сервером.');
    if (clockHint && !blocked) messages.push(clockHint);
    if (commands.size) messages.push(`Ожидают отправки: ${commands.size}.`);
    const exhausted = [...failures.values()].some((failure) => failure.attempts >= maxAttempts);
    if (exhausted && !blocked) messages.push('Автоматические попытки закончились.');
    else if (failures.size && !blocked && navigator.onLine && !pollFailures) messages.push('Не удалось отправить отметку. Попробуем снова.');
    if (expiredKeys.size) messages.push(`Отметки требуют проверки: ${expiredKeys.size}. Они больше не отправляются.`);
    if (inaccessible) messages.push(`Отметки для людей вне доступного списка не отправлены: ${inaccessible}.`);
    const message = messages.join(' ');
    if (syncText.textContent !== message) syncText.textContent = message;
    syncBanner.hidden = !message;
    retryButton.hidden = !exhausted || Boolean(blocked);
    reloadButton.hidden = !blocked;
    dismissExpiredButton.hidden = expiredKeys.size === 0;
  }

  function forgetCommand(key) {
    commands.delete(key);
    failures.delete(key);
    if (!storedKeys.has(key)) return;
    try {
      localStorage.removeItem(storagePrefix + key);
      storedKeys.delete(key);
    } catch {
      setFlash('Не удалось очистить локальную очередь.', { kind: 'error' });
    }
  }

  function loadOutbox() {
    if (!actorId) return;
    try {
      const visibleKeys = new Set();
      expiredKeys.clear();
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(storagePrefix)) continue;
        const command = JSON.parse(localStorage.getItem(key) || 'null');
        if (!command || command.expectedActorId !== actorId || command.audience !== audience
          || key !== storagePrefix + command.idempotencyKey) continue;
        if (command.review || (command.expectedDate < date && !command.capture)) {
          expiredKeys.add(key);
          const time = commandTime(command);
          if (time) rejected.set(command.studentId, 'Проверьте отметку за ' + time);
          continue;
        }
        if (command.expectedDate > date) continue;
        visibleKeys.add(command.idempotencyKey);
        storedKeys.add(command.idempotencyKey);
        commands.set(command.idempotencyKey, command);
      }
      for (const key of storedKeys) {
        if (visibleKeys.has(key)) continue;
        const command = commands.get(key);
        if (command) awaitingRefresh.add(command.studentId);
        commands.delete(key);
        failures.delete(key);
        storedKeys.delete(key);
      }
    } catch {
      setFlash('Локальная очередь недоступна. Отметки можно отправлять, пока эта страница открыта.', { kind: 'error' });
    }
  }

  function retainForReview(command) {
    const key = command.idempotencyKey;
    commands.delete(key);
    failures.delete(key);
    storedKeys.delete(key);
    try {
      localStorage.setItem(storagePrefix + key, JSON.stringify({ ...command, review: true }));
      expiredKeys.add(storagePrefix + key);
    } catch {
      // The original queue item, if saved, remains available for review.
    }
  }

  function queueCommand(command) {
    if (!actorId) throw new Error('Не удалось определить пользователя. Обновите страницу.');
    commands.set(command.idempotencyKey, command);
    rejected.delete(command.studentId);
    let persisted = false;
    try {
      localStorage.setItem(storagePrefix + command.idempotencyKey, JSON.stringify(command));
      storedKeys.add(command.idempotencyKey);
      persisted = true;
    } catch {
      // An online attempt is still possible when storage is disabled or full.
    }
    const name = findStudent(command.studentId)?.name || '';
    setFlash(persisted ? `${name}: отметка в очереди на отправку` : `${name}: отметка ожидает отправки. Не закрывайте страницу.`, { kind: persisted ? 'ok' : 'error' });
    updateQueueStatus();
    if (boardReady) void drainOutbox();
    else void poll();
  }

  function setBlocked(message, hideCards = false) {
    blocked = message;
    boardReady = false;
    clearTimeout(pollTimer);
    clearTimeout(sendTimer);
    if (hideCards) {
      for (const section of classes) section.hidden = true;
      if (historyDialog?.open) closeHistoryDialog();
      if (flash) flash.className = 'hidden';
    }
    updateQueueStatus();
  }

  function canSendToday() {
    if (blocked) return false;
    if (serverClock && schoolDate.format(serverClock.time + performance.now() - serverClock.monotonicAt) > date) {
      clockHint = 'Начался новый день. Подключитесь к сети для обновления страницы.';
      updateQueueStatus();
      return false;
    }
    return true;
  }

  function updateSnapshot(button, student) {
    const local = findStudent(student.id);
    if (!local) return;
    const previous = snapshots.get(String(student.id));
    const state = JSON.stringify(student.state);
    const phone = JSON.stringify(student.phone_check);
    const events = JSON.stringify(student.presence_events);
    if (previous?.state !== state) applyState(button, student.state);
    if (previous?.phone !== phone) {
      local.phone_check = student.phone_check;
      updatePhoneLabel(button, student.phone_check);
    }
    if (previous?.events !== events) {
      local.presence_events = student.presence_events || [];
      if (historyDialog?.open && historyStudentId === String(student.id)) renderHistory(local, true);
    }
    snapshots.set(String(student.id), { state, phone, events });
  }

  function schedulePoll(delay = nextPollDelay()) {
    clearTimeout(pollTimer);
    if (!blocked && !document.hidden && navigator.onLine) pollTimer = setTimeout(poll, delay);
  }

  async function pullState() {
    const started = generation;
    const requestStarted = performance.now();
    try {
      const headers = { Accept: 'application/json' };
      if (etag) headers['If-None-Match'] = etag;
      const response = await fetch(`/api/attendance/presence/manual-state?audience=${encodeURIComponent(audience)}`, {
        credentials: 'same-origin', headers, cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if ([401, 403].includes(response.status) || response.redirected) {
        setBlocked('Доступ изменился. Войдите снова или обновите страницу.', true);
        return false;
      }
      const receivedAt = performance.now();
      const serverWork = Number(response.headers.get('X-Attendance-Processing-Ms'));
      const networkTime = Math.max(0, receivedAt - requestStarted - serverWork);
      if (started !== generation || blocked || document.hidden) return false;
      if (response.status !== 304) {
        if (!response.ok) throw new Error('Ошибка синхронизации');
        const payload = await response.json();
        if (started !== generation || blocked) return false;
        if (payload.actor_id !== actorId) {
          setBlocked('Пользователь изменился. Войдите в прежнюю учётную запись, чтобы отправить её отметки.', true);
          return false;
        }
        if (payload.date !== date) {
          if (captureDialogs) {
            clockHint = 'Начался новый день. Завершите текущую отметку, чтобы обновить страницу.';
            boardReady = false;
          } else {
            window.location.reload();
          }
          return false;
        }
        if (payload.audience !== audience || !Array.isArray(payload.students)) throw new Error('Ошибка синхронизации');
        if (payload.students.length !== buttons.length || payload.students.some((student) =>
          buttonsById.get(String(student.id))?.dataset.classId !== String(student.class_id))) {
          setBlocked('Список изменился. Обновите страницу перед новой отметкой.', true);
          return false;
        }
        for (const student of payload.students) updateSnapshot(buttonsById.get(String(student.id)), student);
        updateTotal();
        etag = response.headers.get('ETag') || '';
      }
      if (networkTime <= 2000) {
        const sampledClock = clockAnchor(response.headers.get('X-Attendance-Clock'), receivedAt - networkTime / 2);
        if (sampledClock) {
          serverClock = sampledClock;
          clockHint = '';
        }
      }
      boardReady = true;
      pollFailures = 0;
      awaitingRefresh.clear();
      return true;
    } catch {
      pollFailures += 1;
      return false;
    } finally {
      updateQueueStatus();
    }
  }

  function poll() {
    if (blocked || document.hidden || !navigator.onLine) return Promise.resolve(false);
    if (!pollRequest) {
      pollRequest = pullState().finally(() => {
        pollRequest = null;
        schedulePoll();
        void drainOutbox();
      });
    }
    return pollRequest;
  }

  async function refreshAfterMutation() {
    generation += 1;
    etag = '';
    if (pollRequest) await pollRequest;
    return poll();
  }

  async function drainOutbox() {
    if (sending) return;
    clearTimeout(sendTimer);
    sendTimer = null;
    if (document.hidden || !navigator.onLine || !boardReady || blocked) return;
    const queue = [...commands.values()].filter(({ idempotencyKey }) => (failures.get(idempotencyKey)?.attempts || 0) < maxAttempts);
    const now = performance.now();
    const command = queue.find(({ idempotencyKey }) => (failures.get(idempotencyKey)?.retryAt || 0) <= now);
    if (!command) {
      if (queue.length) sendTimer = setTimeout(drainOutbox, Math.max(0, Math.min(...queue.map(({ idempotencyKey }) => failures.get(idempotencyKey).retryAt)) - now));
      return;
    }

    const { idempotencyKey, studentId } = command;
    const button = buttonsById.get(studentId);
    const student = findStudent(studentId);
    if (!button || button.dataset.classId !== command.classId) {
      inaccessible += 1;
      if (command.capture) retainForReview(command);
      else forgetCommand(idempotencyKey);
      setFlash('Отметка не отправлена: изменился список доступных людей.', { kind: 'error' });
      updateQueueStatus();
      void drainOutbox();
      return;
    }
    sending = true;
    try {
      if (navigator.locks && storedKeys.has(idempotencyKey)) {
        const processed = await navigator.locks.request(storagePrefix, { ifAvailable: true }, async (lock) => {
          if (!lock) return false;
          if (localStorage.getItem(storagePrefix + idempotencyKey)) await sendCommand(command, button, student);
          else loadOutbox();
          return true;
        });
        if (!processed) sendTimer = setTimeout(drainOutbox, 1000 + Math.random() * 500);
      } else {
        await sendCommand(command, button, student);
      }
    } catch {
      await sendCommand(command, button, student);
    } finally {
      sending = false;
      updateQueueStatus();
      if (!sendTimer) void drainOutbox();
    }
  }

  async function sendCommand(command, button, student) {
    if (blocked || document.hidden) return;
    const { idempotencyKey, studentId } = command;
    const name = student.name;
    try {
      const payload = await postJson('/api/attendance/presence/toggle', command);
      const event = payload.event;
      if (!event?.id || (!payload.duplicate && event.attendance_date !== command.expectedDate)) {
        throw new Error('Не удалось подтвердить сохранение');
      }
      forgetCommand(idempotencyKey);
      if (command.expectedDate !== date) {
        const when = commandTime(command) || command.expectedDate;
        setFlash(name + ': подтверждена отметка за ' + when);
        return;
      }
      awaitingRefresh.add(studentId);
      const baselineMatches = button.dataset.lastEventId === command.expectedLastEventId
        && Number(button.dataset.lastEventRevision || 0) === command.expectedLastEventRevision;
      if (!blocked && !payload.duplicate && baselineMatches && payload.state?.last_event_id) {
        applyState(button, payload.state);
        if (payload.phone_check !== undefined) {
          student.phone_check = payload.phone_check;
          updatePhoneLabel(button, payload.phone_check);
        }
        updateTotal();
      }
      snapshots.delete(studentId);
      setFlash(`${event.student_name || name}: ${event.event_label || eventLabel(event.event_type)} ${event.occurred_label || event.occurred_time || ''}`.trim(), { eventId: payload.duplicate ? '' : event.id });
      void refreshAfterMutation();
    } catch (error) {
      if (error.status === 401) {
        setBlocked('Сеанс завершён или пользователь изменился. Войдите снова, чтобы отправить отметки.', true);
      } else if (error.status === 403) {
        setBlocked('Нет доступа для отправки отметок. Проверьте права и обновите страницу.', true);
      } else if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
        awaitingRefresh.add(studentId);
        if (command.capture) retainForReview(command);
        else forgetCommand(idempotencyKey);
        const when = commandTime(command);
        rejected.set(studentId, when ? 'Проверьте отметку за ' + when : 'Отметка не сохранена');
        setFlash(name + ': отметка не сохранена. ' + error.message, { kind: 'error' });
        void refreshAfterMutation();
      } else if (commands.has(idempotencyKey)) {
        const attempts = (failures.get(idempotencyKey)?.attempts || 0) + 1;
        failures.set(idempotencyKey, { attempts, retryAt: performance.now() + retryDelay(attempts) });
      }
    }
  }

  buttons.forEach((button) => {
    const student = findStudent(button.dataset.studentId);
    updatePhoneLabel(button, student?.phone_check);
    let marking = false;
    const notice = button.parentElement.querySelector('[data-phone-after-notice]');
    notice?.addEventListener('click', async () => {
      if (marking || !canSendToday() || student?.phone_check?.submitted !== false || student.phone_check.submitted_after_notice_at) return;
      marking = true;
      notice.disabled = true;
      try {
        const result = await window.savePresencePhoneDay(student.id, root.dataset.date, { submitted_after_notice: true }, student.phone_check.revision);
        student.phone_check = result.day;
        updatePhoneLabel(button, result.day);
        snapshots.delete(String(student.id));
        void refreshAfterMutation();
        if (notice.hidden) button.focus({ preventScroll: true });
        setFlash(result.conflict ? result.message : `${student.name}: сдал телефон после замечания`, { kind: result.conflict ? 'error' : 'ok' });
      } catch (err) {
        setFlash(err.message || 'Не удалось сохранить отметку о телефоне', { kind: 'error' });
      } finally {
        marking = false;
        notice.disabled = false;
      }
    });
    button.addEventListener('click', async () => {
      if (button.disabled || marking || !canSendToday()) return;
      if (button.dataset.conflictId) {
        setFlash('Сначала выберите, какую из двух отметок оставить', { kind: 'error' });
        return;
      }
      const capture = captureTime();
      if (!capture) {
        clockHint = 'Не удалось сверить время. Подключитесь к сети, чтобы сделать отметку.';
        updateQueueStatus();
        void poll();
        return;
      }
      marking = true;
      captureDialogs += 1;
      const command = {
        capture,
        studentId: button.dataset.studentId,
        classId: button.dataset.classId,
        audience,
        idempotencyKey: newKey(),
        expectedDate: date,
        expectedActorId: actorId,
        expectedLastEventId: button.dataset.lastEventId || '',
        expectedLastEventRevision: Number(button.dataset.lastEventRevision || 0),
        expectedEventType: button.dataset.lastEventType === 'arrival' ? 'departure' : 'arrival',
      };
      try {
        const phone = audience === 'children' ? await window.choosePresencePhoneAnswer({
          name: student.name,
          departure: command.expectedEventType === 'departure',
          current: student.phone_check,
          studentId: student.id,
          date,
          useCurrent: true,
        }) : {};
        if (phone && !button.disabled && !blocked) queueCommand({ ...command, ...phone });
      } catch (err) {
        setFlash(err.message || 'Не удалось подготовить отметку', { kind: 'error' });
      } finally {
        captureDialogs -= 1;
        marking = false;
      }
    });
  });

  root.querySelectorAll('[data-conflict-resolve]').forEach((button) => {
    button.addEventListener('click', async () => {
      const conflictId = button.dataset.conflictId || '';
      if (!conflictId || button.disabled || !canSendToday()) return;
      const resolution = button.dataset.conflictResolve || '';
      button.disabled = true;
      try {
        await postJson(`/api/attendance/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
          audience: root.dataset.audience || 'children',
          resolution,
        });
        const card = button.closest('.manual-presence-card').querySelector('[data-presence-button]');
        const synced = await refreshAfterMutation();
        setFlash(synced ? 'Отметки согласованы' : 'Отметки согласованы. Обновите страницу, чтобы увидеть текущее состояние.');
        if (synced && !card.dataset.conflictId) card.focus({ preventScroll: true });
      } catch (err) {
        setFlash(err.message || 'Не удалось разрешить конфликт', { kind: 'error' });
      } finally {
        button.disabled = false;
      }
    });
  });

  root.querySelectorAll('[data-manual-phone]').forEach((trigger) => {
    trigger.addEventListener('click', async () => {
      const student = findStudent(trigger.dataset.studentId);
      if (!student || trigger.disabled || !canSendToday()) return;
      const card = trigger.closest('.manual-presence-card').querySelector('[data-presence-button]');
      const date = root.dataset.date;
      trigger.disabled = true;
      try {
        const oldPhone = student.phone_check;
        const phone = await window.getPresencePhoneDay(student.id, date);
        if (student.phone_check === oldPhone) student.phone_check = phone;
        updatePhoneLabel(card, student.phone_check);
        trigger.disabled = false;
        const saved = await window.editPresencePhone({
          name: student.name, current: student.phone_check, trigger,
          async save(answers, expectedRevision) {
            if (!canSendToday()) throw new Error('Дата изменилась. Обновите страницу.');
            const result = await window.savePresencePhoneDay(student.id, date, answers, expectedRevision);
            student.phone_check = result.day;
            updatePhoneLabel(card, result.day);
            snapshots.delete(String(student.id));
            void refreshAfterMutation();
            return result;
          },
        });
        if (saved) setFlash(`${student.name}: отметки о телефоне сохранены`);
      } catch (error) {
        setFlash(error.message || 'Не удалось открыть отметки о телефоне', { kind: 'error' });
      } finally {
        trigger.disabled = false;
      }
    });
  });

  root.querySelectorAll('[data-presence-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const student = findStudent(button.dataset.studentId);
      if (!student || !historyDialog) return;
      historyStudentId = String(student.id);
      renderHistory(student);
      if (typeof historyDialog.showModal === 'function') historyDialog.showModal();
      else historyDialog.setAttribute('open', '');
    });
  });

  historyDialog?.querySelector('[data-presence-history-close]')?.addEventListener('click', closeHistoryDialog);
  historyDialog?.addEventListener('click', (event) => {
    if (event.target === historyDialog) closeHistoryDialog();
  });
  historyEvents?.addEventListener('click', async (event) => {
    const cancel = event.target.closest('[data-presence-history-cancel]');
    const eventId = cancel?.dataset.presenceHistoryCancel || '';
    if (!eventId || !canSendToday() || !window.confirm('Отменить эту ручную отметку?')) return;
    cancel.disabled = true;
    historyError.hidden = true;
    try {
      await postJson(`/api/attendance/presence/events/${encodeURIComponent(eventId)}/cancel`, {
        audience: root.dataset.audience || 'children',
        expectedUpdatedAt: cancel.dataset.expectedUpdatedAt || undefined,
      });
      closeHistoryDialog();
      const synced = await refreshAfterMutation();
      setFlash(synced ? 'Ручная отметка отменена' : 'Ручная отметка отменена. Обновите страницу, чтобы увидеть текущее состояние.');
    } catch (err) {
      cancel.disabled = false;
      historyError.textContent = err.message || 'Не удалось отменить отметку.';
      historyError.hidden = false;
    }
  });

  cancelButton?.addEventListener('click', async () => {
    const eventId = cancelButton.dataset.eventId || '';
    if (!eventId || !canSendToday()) return;
    cancelButton.disabled = true;
    try {
      const payload = await postJson(`/api/attendance/presence/events/${encodeURIComponent(eventId)}/cancel`, {
        audience: root.dataset.audience || 'children',
      });
      const event = payload.event || {};
      const synced = await refreshAfterMutation();
      const label = `Отменено: ${event.student_name || ''}`.trim();
      setFlash(synced ? label : `${label}. Обновите страницу, чтобы увидеть текущее состояние.`);
    } catch (err) {
      setFlash(err.message || 'Не удалось отменить', { kind: 'error' });
    } finally {
      cancelButton.disabled = false;
    }
  });

  function catchUp() {
    if (document.hidden) {
      clearTimeout(pollTimer);
      clearTimeout(sendTimer);
    } else {
      void poll();
    }
    updateQueueStatus();
  }

  dismissExpiredButton.addEventListener('click', () => {
    try {
      for (const key of expiredKeys) localStorage.removeItem(key);
      expiredKeys.clear();
      rejected.clear();
      updateQueueStatus();
    } catch {
      setFlash('Не удалось убрать отметки из списка проверки.', { kind: 'error' });
    }
  });
  reloadButton.addEventListener('click', () => window.location.reload());
  retryButton.addEventListener('click', () => {
    failures.clear();
    catchUp();
  });
  function invalidateClock() {
    serverClock = null;
    generation += 1;
    etag = '';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) invalidateClock();
    catchUp();
  });
  document.addEventListener('freeze', invalidateClock);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      invalidateClock();
      catchUp();
    }
  });
  window.addEventListener('focus', catchUp);
  window.addEventListener('online', catchUp);
  window.addEventListener('offline', updateQueueStatus);
  window.addEventListener('storage', (event) => {
    if (event.key && !event.key.startsWith(storagePrefix)) return;
    loadOutbox();
    updateQueueStatus();
    void refreshAfterMutation();
  });
  loadOutbox();
  updateQueueStatus();
  schedulePoll(commands.size ? Math.random() * 1000 : 1500 + Math.random() * 3500);
})();
