import test from 'node:test';
import assert from 'node:assert/strict';
import { issuePresenceClock, readPresenceCapture, verifiedPresenceTime } from './presence-clock.mjs';

const secret = 'fixture';
const epoch = Date.parse('2026-11-17T20:57:00Z');
const token = issuePresenceClock('99', 'children', secret, epoch);

test('clock proof is bound to the actor and audience and time is anchor plus elapsed', () => {
  const clock = { token, elapsedMs: 45_123 };
  assert.equal(readPresenceCapture(clock, 99, 'children', secret), epoch + 45_123);
  assert.equal(readPresenceCapture(clock, 100, 'children', secret), null);
  assert.equal(readPresenceCapture(clock, 99, 'adults', secret), null);
  assert.equal(readPresenceCapture(clock, 99, 'children', 'other key'), null);
});

test('untrusted elapsed values or a modified signed time are rejected', () => {
  for (const elapsedMs of [-1, NaN, Infinity, 1.5, '10', 43_200_001]) {
    assert.equal(readPresenceCapture({token, elapsedMs}, 99, 'children', secret), null);
  }
  assert.equal(readPresenceCapture({token: token.replace(String(epoch), String(epoch + 1000)), elapsedMs: 0}, 99, 'children', secret), null);
  assert.equal(readPresenceCapture({token: 'bad', elapsedMs: 0}, 99, 'children', secret), null);
});

test('delayed delivery keeps the original Moscow date and time after midnight', () => {
  const capturedAt = epoch + 45_123;
  const receivedAt = Date.parse('2026-11-17T21:10:00Z');
  assert.equal(verifiedPresenceTime(capturedAt, '2026-11-17', receivedAt), '2026-11-17 23:57:45');
  assert.equal(verifiedPresenceTime(capturedAt, '2026-11-18', receivedAt), '');
  assert.equal(verifiedPresenceTime(capturedAt, '2026-11-17', capturedAt + 86_400_001), '');
});

test('small estimation error never stores a future time or a mark for a future date', () => {
  assert.equal(verifiedPresenceTime(epoch + 1900, '2026-11-17', epoch), '2026-11-17 23:57:00');
  assert.equal(verifiedPresenceTime(epoch + 2100, '2026-11-17', epoch), '');
  const midnight = Date.parse('2026-11-17T21:00:00Z');
  assert.equal(verifiedPresenceTime(midnight + 5, '2026-11-18', midnight - 5), '');
});
