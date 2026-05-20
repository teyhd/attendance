import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OTHER_REASON_CODE,
  WITHOUT_REASON_CODE,
  isOtherReasonCode,
  isWithoutReasonCode,
} from './absence-reasons.mjs';

test('absence reason helpers distinguish no reason from other', () => {
  assert.equal(WITHOUT_REASON_CODE, 'without_reason');
  assert.equal(OTHER_REASON_CODE, 'other');
  assert.equal(isWithoutReasonCode('without_reason'), true);
  assert.equal(isWithoutReasonCode('other'), false);
  assert.equal(isOtherReasonCode('other'), true);
  assert.equal(isOtherReasonCode('without_reason'), false);
});
