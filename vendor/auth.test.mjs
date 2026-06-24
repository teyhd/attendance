import test from 'node:test';
import assert from 'node:assert/strict';
import { attendancePermissions } from './auth.mjs';

test('attendance permissions allow teachers to read only', () => {
  assert.deepEqual(attendancePermissions(2), {
    use_attendance: true,
    view_own_attendance: false,
    view_adult_attendance: false,
    mark_absence: false,
    manage_presence: false,
  });
});

test('attendance permissions allow mentors tutors and admins to manage', () => {
  for (const roleID of [3, 4, 5]) {
    assert.deepEqual(attendancePermissions(roleID), {
      use_attendance: true,
      view_own_attendance: false,
      view_adult_attendance: roleID === 5,
      mark_absence: true,
      manage_presence: roleID === 5,
    });
  }
});

test('attendance permissions allow students to view only own attendance', () => {
  assert.deepEqual(attendancePermissions(1), {
    use_attendance: false,
    view_own_attendance: true,
    view_adult_attendance: false,
    mark_absence: false,
    manage_presence: false,
  });
});

test('attendance permissions deny parents, guests, and unknown roles', () => {
  for (const roleID of [0, 6, 99, null, undefined]) {
    assert.deepEqual(attendancePermissions(roleID), {
      use_attendance: false,
      view_own_attendance: false,
      view_adult_attendance: false,
      mark_absence: false,
      manage_presence: false,
    });
  }
});
