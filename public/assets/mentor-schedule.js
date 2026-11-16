(() => {
  const page = document.querySelector('[data-mentor-schedule]');
  const form = page.querySelector('[data-schedule-form]');
  const message = form.querySelector('[data-schedule-message]');
  const publishResult = page.querySelector('[data-publish-result]');
  const publishDialog = page.querySelector('[data-publish-dialog]');
  const publishSummary = publishDialog.querySelector('[data-publish-summary]');
  const dayButtons = [...form.querySelectorAll('[data-select-day]')];
  const mentors = [...form.querySelectorAll('[data-mentor]')].map((row) => ({
    row,
    repeat: row.querySelector('[data-repeat-monday]'),
    totals: [...row.querySelectorAll('[data-week-total]')],
    days: [...row.querySelectorAll('[data-day]')].map((cell) => ({
      cell,
      start: cell.querySelector('[data-start]'),
      end: cell.querySelector('[data-end]'),
      clear: cell.querySelector('[data-clear]'),
      total: cell.querySelector('[data-day-total]'),
    })),
  }));
  let revision = Number(page.dataset.revision);
  let dirty = false;
  let pending = false;

  if (window.history.state?.publishedMentorWeek === page.dataset.week) {
    const { publishedMentorWeek, selectedMentorDay, ...previousState } = window.history.state;
    if (dayButtons.some((button) => button.dataset.selectDay === selectedMentorDay)) selectDay(selectedMentorDay);
    publishResult.textContent = 'График опубликован. Наставники видят свои смены.';
    publishResult.hidden = false;
    window.history.replaceState(previousState, '');
  }

  function selectDay(index) {
    for (const button of dayButtons) button.setAttribute('aria-pressed', String(button.dataset.selectDay === index));
    for (const cell of form.querySelectorAll('[data-day]')) cell.toggleAttribute('data-active-day', cell.dataset.day === index);
  }

  function minutes(value) {
    const [hours, remainder] = value.split(':').map(Number);
    return hours * 60 + remainder;
  }

  function duration(day) {
    return minutes(day.end.value) - minutes(day.start.value) - 30;
  }

  function label(count) {
    const hours = Math.floor(count / 60);
    return count % 60 ? `${hours} ч ${count % 60} мин` : `${hours} ч`;
  }

  function setMessage(text, isError = false) {
    message.textContent = text;
    message.toggleAttribute('data-error', isError);
  }

  function refreshMentor(mentor) {
    let total = 0;
    for (const day of mentor.days) {
      const occupied = Boolean(day.start.value || day.end.value);
      const shift = duration(day);
      if (shift > 0) total += shift;
      day.clear.hidden = !occupied;
      day.total.textContent = shift > 0 ? label(shift) : occupied ? 'Проверьте время' : '—';
      for (const input of [day.start, day.end]) input.setAttribute('aria-invalid', String(occupied && !(shift > 0)));
    }
    mentor.repeat.hidden = !(duration(mentor.days[0]) > 0);
    for (const element of mentor.totals) element.textContent = label(total);
  }

  function changed(mentor) {
    refreshMentor(mentor);
    dirty = true;
    publishResult.hidden = true;
    setMessage('Есть несохранённые изменения.');
  }

  function collect() {
    const rows = {};
    let scheduledMentors = 0;
    for (const mentor of mentors) {
      const days = [];
      for (const day of mentor.days) {
        const { value: start } = day.start;
        const { value: end } = day.end;
        if ((start || end) && !(duration(day) > 0)) {
          selectDay(day.cell.dataset.day);
          (start ? day.end : day.start).focus();
          const context = `${mentor.row.dataset.mentorName}, ${day.cell.dataset.dayName.toLowerCase()}.`;
          setMessage(`${context} ${start && end ? 'Смена должна длиться больше 30 минут.' : 'Укажите и приход, и уход.'}`, true);
          return null;
        }
        days.push(start ? [start, end] : null);
      }
      if (days.some(Boolean)) scheduledMentors++;
      rows[mentor.row.dataset.mentor] = days;
    }
    return { rows, scheduledMentors };
  }

  async function save(publish) {
    if (pending) return;
    const payload = collect();
    if (!payload) return;
    pending = true;
    const controls = [...form.querySelectorAll('input, button')];
    for (const control of controls) control.disabled = true;
    form.setAttribute('aria-busy', 'true');
    setMessage(publish ? 'Публикуем график…' : 'Сохраняем черновик…');
    let saved = false;
    try {
      const response = await fetch(`/api/attendance/mentor-schedule/${page.dataset.week}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ rows: payload.rows, revision, publish }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Не удалось сохранить график. Повторите попытку.');
      revision = result.revision;
      page.querySelector('[data-status]').textContent = result.status;
      dirty = false;
      saved = true;
      setMessage(publish ? 'График опубликован. Наставники видят свои смены.' : 'Черновик сохранён.');
    } catch (error) {
      setMessage(error instanceof TypeError ? 'Нет связи с сервером. Попробуйте ещё раз.' : error.message, true);
    } finally {
      pending = false;
      for (const control of controls) control.disabled = false;
      form.removeAttribute('aria-busy');
    }
    if (publish && saved) {
      const selectedMentorDay = dayButtons.find((button) => button.getAttribute('aria-pressed') === 'true')?.dataset.selectDay;
      window.history.replaceState({ ...window.history.state, publishedMentorWeek: page.dataset.week, selectedMentorDay }, '');
      window.location.reload();
    }
  }

  for (const button of dayButtons) button.addEventListener('click', () => selectDay(button.dataset.selectDay));
  for (const mentor of mentors) {
    for (const day of mentor.days) {
      day.start.addEventListener('input', () => changed(mentor));
      day.end.addEventListener('input', () => changed(mentor));
      day.clear.addEventListener('click', () => {
        day.start.value = '';
        day.end.value = '';
        changed(mentor);
        day.start.focus();
      });
    }
    mentor.repeat.addEventListener('click', () => {
      const [monday, ...otherDays] = mentor.days;
      const different = otherDays.some((day) => (day.start.value || day.end.value)
        && (day.start.value !== monday.start.value || day.end.value !== monday.end.value));
      if (different && !window.confirm('Заменить время в остальных днях временем понедельника?')) return;
      for (const day of otherDays) {
        day.start.value = monday.start.value;
        day.end.value = monday.end.value;
      }
      changed(mentor);
    });
    refreshMentor(mentor);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    save(false);
  });
  form.querySelector('[data-publish]').addEventListener('click', () => {
    const payload = collect();
    if (!payload) return;
    publishSummary.textContent = payload.scheduledMentors
      ? `Наставники увидят свои смены в «Гармонии». Строк со сменами: ${payload.scheduledMentors}.`
      : 'В этой неделе нет смен. После публикации наставники увидят пустой график.';
    publishDialog.returnValue = '';
    publishDialog.showModal();
  });
  publishDialog.addEventListener('close', () => {
    if (publishDialog.returnValue === 'publish') save(true);
  });
  window.addEventListener('beforeunload', (event) => {
    if (!dirty && !pending) return;
    event.preventDefault();
    event.returnValue = '';
  });
})();
