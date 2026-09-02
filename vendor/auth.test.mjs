import test from 'node:test';
import assert from 'node:assert/strict';
import { attendancePermissions, extractServiceRoleID, landingPath } from './auth.mjs';

test('landing routes open the live board first for teachers and tutors', () => {
  assert.equal(landingPath(1), '/attendance/me');
  assert.equal(landingPath(2), '/attendance/presence');
  assert.equal(landingPath(3), '/attendance');
  assert.equal(landingPath(4), '/attendance/presence');
  assert.equal(landingPath(5), '/attendance');
});

test('service role extraction keeps legacy rights scoped to Attendance', () => {
  assert.equal(extractServiceRoleID([
    { srv_id: 9, role_id: 5 },
    { srv_id: 13, role_id: 2 },
    { srv_id: 13, role_id: 3 },
  ], 13), 3);
  assert.equal(extractServiceRoleID([{ srv_id: 9, role_id: 5 }], 13), 0);
});

test('service role extraction accepts scoped SSO role formats only for a trusted audience', () => {
  assert.equal(extractServiceRoleID([2], 13, true), 2);
  assert.equal(extractServiceRoleID(2, 13, true), 2);
  assert.equal(extractServiceRoleID(['2', 5], 13, true), 5);
  assert.equal(extractServiceRoleID([2], 13), 0);
  assert.equal(extractServiceRoleID(2, 13), 0);
});

test('service role extraction rejects malformed and non-positive roles', () => {
  for (const claim of [null, undefined, {}, [], ['bad'], [0], [-1], [{ srv_id: 13, role_id: 'bad' }]]) {
    assert.equal(extractServiceRoleID(claim, 13, true), 0);
  }
});

test('attendance permissions allow teachers to read only', () => {
  assert.deepEqual(attendancePermissions(2), {
    use_attendance: true,
    view_own_attendance: false,
    view_adult_attendance: false,
    mark_absence: false,
    manage_presence: false,
  });
});

test('attendance permissions allow mentors and admins to manage manual presence', () => {
  for (const roleID of [3, 5]) {
    assert.deepEqual(attendancePermissions(roleID), {
      use_attendance: true,
      view_own_attendance: false,
      view_adult_attendance: roleID === 5,
      mark_absence: true,
      manage_presence: true,
    });
  }
});

test('attendance permissions keep tutors out of manual presence', () => {
  assert.deepEqual(attendancePermissions(4), {
    use_attendance: true,
    view_own_attendance: false,
    view_adult_attendance: false,
    mark_absence: true,
    manage_presence: false,
  });
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
