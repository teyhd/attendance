import test from 'node:test';
import assert from 'node:assert/strict';
import { attendancePermissions } from './auth.mjs';

test('attendance permissions allow teachers to read only', () => {
  assert.deepEqual(attendancePermissions(2), {
    use_attendance: true,
    mark_absence: false,
  });
});

test('attendance permissions allow mentors tutors and admins to manage', () => {
  for (const roleID of [3, 4, 5]) {
    assert.deepEqual(attendancePermissions(roleID), {
      use_attendance: true,
      mark_absence: true,
    });
  }
});

test('attendance permissions deny students, parents, guests, and unknown roles', () => {
  for (const roleID of [0, 1, 6, 99, null, undefined]) {
    assert.deepEqual(attendancePermissions(roleID), {
      use_attendance: false,
      mark_absence: false,
    });
  }
});
