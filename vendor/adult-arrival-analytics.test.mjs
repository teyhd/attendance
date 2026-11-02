import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdultArrivalAnalytics } from './adult-arrival-analytics.mjs';
import { buildAnalyticsRange } from './attendance-analytics-contract.mjs';

const lesson = (extra = {}) => ({ teacher_id: '10', lesson_date: '2026-09-07', start_time: '10:00:00', end_time: '10:40:00', subject_name: 'Математика', ...extra });
const event = (time, extra = {}) => ({ student_id: '10', attendance_date: '2026-09-07', occurred_at: `2026-09-07 ${time}`, event_type: 'arrival', ...extra });
const build = (extra = {}) => buildAdultArrivalAnalytics({ range: buildAnalyticsRange('2026-09-07', '2026-09-09'), people: [{ student_id: '10' }], scheduleRows: [lesson()], publishedSchoolDays: ['2026-09-07', '2026-09-08'], now: '2026-09-08 12:00:00', ...extra });

test('first arrival, exact start, repeat entries and cancelled entries', () => {
  const result = build({ presenceEvents: [event('11:00:00'), event('10:00:00'), event('09:00:00', { cancelled_at: '2026-09-08' }), event('18:00:00', { event_type: 'departure' })] }).people[0];
  assert.equal(result.days[0].arrival_time, '10:00:00');
  assert.equal(result.days[0].departure_time, '18:00:00');
  assert.equal(result.days[0].status, 'on_time');
  assert.equal(result.arrival_days, 1);
});
test('lateness is relative to this teacher earliest lesson, rounded upward', () => {
  const result = build({ presenceEvents: [event('10:00:01')], scheduleRows: [lesson({ teacher_id: '11', start_time: '09:00:00' }), lesson({ start_time: '11:00:00', end_time: '11:40:00' }), lesson(), lesson()] }).people[0];
  assert.equal(result.days[0].late_minutes, 1);
  assert.equal(result.late_days, 1);
  assert.equal(result.total_late_minutes, 1);
});
test('second half of an individual lesson uses effective start', () => {
  const result = build({ scheduleRows: [lesson({ slot_part: 'H2', student_id: '500' })], presenceEvents: [event('10:15:00')] }).people[0];
  assert.equal(result.days[0].lesson_time, '10:20:00');
  assert.equal(result.days[0].status, 'on_time');
});
test('missing arrival, no assigned lessons and future are distinct and not late', () => {
  const result = build().people[0];
  assert.deepEqual(result.days.map(day => day.status), ['no_arrival', 'no_lessons', 'future']);
  assert.equal(result.late_days, 0);
});
test('missing publication is not on time; departure alone is not an arrival', () => {
  assert.equal(build({ publishedSchoolDays: [], presenceEvents: [event('09:00:00')] }).people[0].days[0].status, 'no_schedule');
  assert.equal(build({ presenceEvents: [event('11:00:00', { event_type: 'departure' })] }).people[0].arrival_days, 0);
});
test('today before first lesson is pending and future events ignored', () => {
  const result = build({ now: '2026-09-07 09:00:00', presenceEvents: [event('10:10:00')] }).people[0];
  assert.equal(result.days[0].status, 'expected');
  assert.equal(result.late_days, 0);
});
test('days cover a selected period spanning months', () => {
  const result = build({ range: buildAnalyticsRange('2026-08-31', '2026-09-02') }).people[0];
  assert.deepEqual(result.days.map(day => day.date), ['2026-08-31', '2026-09-01', '2026-09-02']);
});

test('arrival is compared with first onsite lesson after an earlier online lesson', () => {
  const person = build({ scheduleRows: [lesson({ start_time: '08:00:00', end_time: '08:40:00', is_online: 1 }), lesson()], presenceEvents: [event('09:54:53')] }).people[0];
  assert.equal(person.days[0].lesson_time, '10:00:00');
  assert.equal(person.days[0].status, 'on_time');
  assert.equal(person.late_days, 0);
  assert.equal(person.total_late_minutes, 0);
});

test('actual lateness excludes time since a remote lesson', () => {
  const person = build({ scheduleRows: [lesson({ start_time: '08:00:00', end_time: '08:40:00', is_online: true }), lesson()], presenceEvents: [event('10:04:01')] }).people[0];
  assert.equal(person.days[0].status, 'late');
  assert.equal(person.total_late_minutes, 5);
});

test('online-only day is not an onsite absence or lateness, even if employee visits school', () => {
  for (const presenceEvents of [[], [event('11:00:00')]]) {
    const person = build({ scheduleRows: [lesson({ is_online: '1' })], presenceEvents }).people[0];
    assert.equal(person.days[0].status, 'online_only');
    assert.equal(person.days[0].lesson_time, '—');
    assert.equal(person.late_days, 0);
    assert.equal(person.no_arrival_days, 0);
    assert.equal(person.on_time_days, 0);
    assert.equal(person.arrival_days, presenceEvents.length);
  }
});

test('online flag false and duplicate group/student assignments retain onsite lesson', () => {
  const person = build({ scheduleRows: [lesson({ is_online: 1 }), lesson({ is_online: '0', student_id: '1' }), lesson({ is_online: false, student_id: '2' })], presenceEvents: [event('10:01:00')] }).people[0];
  assert.equal(person.days[0].status, 'late');
  assert.equal(person.late_days, 1);
  assert.equal(person.total_late_minutes, 1);
});

test('replacement teacher is evaluated only against lessons assigned to that teacher', () => {
  const result = build({ people: [{ student_id: '10' }, { student_id: '11' }], scheduleRows: [lesson({ teacher_id: '11' })], presenceEvents: [event('10:01:00'), event('09:59:00', { student_id: '11' })] });
  assert.equal(result.people[0].days[0].status, 'no_lessons');
  assert.equal(result.people[1].days[0].status, 'on_time');
  assert.equal(result.late_days, 0);
});

