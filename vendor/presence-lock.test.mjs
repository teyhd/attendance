import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireToggleLocks, releaseToggleLocks } from './presence-lock.mjs';

function connection(results) {
  const calls = [];
  return { calls, async query(sql, [name]) {
    calls.push([sql, name]);
    const result = results.shift();
    if (result instanceof Error) throw result;
    return [[sql.includes('GET_LOCK') ? { locked: result } : { released: result }]];
  }, release() { calls.push('release'); }, destroy() { calls.push('destroy'); } };
}

test('toggle acquires person then camera day lock and releases in reverse order', async () => {
  const conn = connection([1, 1, 1, 1]);
  const locks = await acquireToggleLocks(conn, 42, '2026-11-17');
  assert.equal(locks.locked, true);
  await releaseToggleLocks(conn, locks.acquired);
  assert.deepEqual(conn.calls.map(call => Array.isArray(call) ? call[1] : call), [
    'attendance:person:42', 'attendance:presence:42:2026-11-17',
    'attendance:presence:42:2026-11-17', 'attendance:person:42', 'release',
  ]);
});

test('camera contention releases person lock; failed release destroys connection', async () => {
  const conn = connection([1, 0, 0]);
  const locks = await acquireToggleLocks(conn, 42, '2026-11-17');
  assert.equal(locks.locked, false);
  await releaseToggleLocks(conn, locks.acquired);
  assert.equal(conn.calls.at(-1), 'destroy');
});

test('uncertain acquisition destroys connection even if known locks release', async () => {
  const conn = connection([1, new Error('connection lost'), 1]);
  let failure;
  try { await acquireToggleLocks(conn, 42, '2026-11-17'); } catch (err) { failure = err; }
  await releaseToggleLocks(conn, failure.presenceLocks, failure.presenceLockUncertain);
  assert.equal(conn.calls.at(-1), 'destroy');
});
