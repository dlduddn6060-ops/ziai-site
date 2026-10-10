// Firestore 일시 오류 판별 — 충돌·할당량·일시 불가면 503(앱이 재시도 대상으로 인식), 그 외는 500.
// admin SDK 오류의 code는 gRPC 숫자(10/8/14) 또는 문자열('aborted' 등)로 올 수 있어 둘 다 확인.
const TRANSIENT = new Set([10, 8, 14, 'aborted', 'resource-exhausted', 'unavailable', 'ABORTED', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE']);

function isTransient(e) {
  return !!e && TRANSIENT.has(e.code);
}

module.exports = { isTransient };
