import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { verifyInternalServiceRequest } from './internal-service-auth.mjs';

test('verifyInternalServiceRequest accepts a current signed Progress request', () => {
  const serviceKey = 'test-key';
  const timestamp = '1787745600000';
  const rawBody = '{"periodStart":"2026-08-01","assignments":[]}';
  const signature = crypto.createHmac('sha256', serviceKey)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');

  assert.deepEqual(verifyInternalServiceRequest({
    serviceName: 'progress', timestamp, signature, rawBody, serviceKey,
    now: Number(timestamp),
  }), { ok: true });
});

test('verifyInternalServiceRequest rejects stale and modified requests', () => {
  const timestamp = '1787745600000';
  const common = {
    serviceName: 'progress', timestamp, signature: '0'.repeat(64), rawBody: '{}', serviceKey: 'test-key',
  };
  assert.equal(verifyInternalServiceRequest({ ...common, now: Number(timestamp) + 300001 }).error, 'expired_request');
  assert.equal(verifyInternalServiceRequest({ ...common, now: Number(timestamp) }).error, 'invalid_signature');
});

test('verifyInternalServiceRequest accepts Diary only when the caller is explicitly allowed', () => {
  const serviceKey = 'diary-test-key';
  const timestamp = '1787745600000';
  const rawBody = '{"requests":[]}';
  const signature = crypto.createHmac('sha256', serviceKey)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');
  const request = { serviceName: 'diary', timestamp, signature, rawBody, serviceKey, now: Number(timestamp) };

  assert.equal(verifyInternalServiceRequest(request).error, 'service_forbidden');
  assert.deepEqual(verifyInternalServiceRequest({ ...request, allowedServices: ['diary'] }), { ok: true });
});
