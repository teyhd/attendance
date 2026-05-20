export const WITHOUT_REASON_CODE = 'without_reason';
export const OTHER_REASON_CODE = 'other';

export function isWithoutReasonCode(code) {
  return String(code || '') === WITHOUT_REASON_CODE;
}

export function isOtherReasonCode(code) {
  return String(code || '') === OTHER_REASON_CODE;
}
