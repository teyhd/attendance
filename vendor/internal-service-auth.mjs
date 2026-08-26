import crypto from 'node:crypto';

export const INTERNAL_REQUEST_MAX_SKEW_MS = 5 * 60 * 1000;

export function verifyInternalServiceRequest({
  serviceName,
  timestamp,
  signature,
  rawBody,
  serviceKey,
  now = Date.now(),
  maxSkewMs = INTERNAL_REQUEST_MAX_SKEW_MS,
} = {}) {
  if (!serviceKey) return { ok: false, status: 503, error: 'service_not_configured' };
  if (serviceName !== 'progress') return { ok: false, status: 403, error: 'service_forbidden' };
  if (!/^\d{13}$/.test(String(timestamp || ''))) {
    return { ok: false, status: 401, error: 'invalid_timestamp' };
  }
  if (Math.abs(now - Number(timestamp)) > maxSkewMs) {
    return { ok: false, status: 401, error: 'expired_request' };
  }
  if (!/^[a-f0-9]{64}$/i.test(String(signature || ''))) {
    return { ok: false, status: 401, error: 'invalid_signature' };
  }

  const expected = crypto
    .createHmac('sha256', serviceKey)
    .update(`${timestamp}\n${String(rawBody || '')}`)
    .digest('hex');
  const providedBuffer = Buffer.from(String(signature).toLowerCase(), 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const matches = providedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
  return matches
    ? { ok: true }
    : { ok: false, status: 401, error: 'invalid_signature' };
}
