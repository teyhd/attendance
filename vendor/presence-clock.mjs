import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { schoolSqlNow } from './mentor-work.mjs';

const maxClockElapsed = 12 * 60 * 60 * 1000;
const maxDeliveryDelay = 24 * 60 * 60 * 1000;
const maxFutureSkew = 2000;
const localSecret = randomBytes(32);

function sign(epochMs, actorId, audience, secret) {
  return createHmac('sha256', secret || localSecret)
    .update(JSON.stringify(['manual-presence-time-v1', epochMs, String(actorId), audience]))
    .digest('base64url');
}

export function issuePresenceClock(actorId, audience, secret, epochMs = Date.now()) {
  return epochMs + '.' + sign(epochMs, actorId, audience, secret);
}

// A signature authenticates the reference time, while elapsedMs is a bounded
// estimate supplied by the device, not a proof of when the tap occurred.
export function readPresenceCapture(capture, actorId, audience, secret) {
  const { token, elapsedMs } = capture || {};
  if (typeof token !== 'string' || !/^\d{13}\.[\w-]{43}$/.test(token)
    || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > maxClockElapsed) return null;
  const [epoch, signature] = token.split('.');
  const anchor = Number(epoch);
  const expected = sign(anchor, actorId, audience, secret);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return anchor + elapsedMs;
}

export function verifiedPresenceTime(capturedAt, attendanceDate, nowMs = Date.now()) {
  if (!Number.isSafeInteger(capturedAt) || capturedAt < nowMs - maxDeliveryDelay || capturedAt > nowMs + maxFutureSkew) return '';
  const occurredAt = schoolSqlNow(new Date(capturedAt));
  if (occurredAt.slice(0, 10) !== attendanceDate || attendanceDate > schoolSqlNow(new Date(nowMs)).slice(0, 10)) return '';
  // The estimate may be slightly ahead of the server because of asymmetric
  // network latency. Preserve ordering without storing a future timestamp.
  return capturedAt > nowMs ? schoolSqlNow(new Date(nowMs)) : occurredAt;
}
