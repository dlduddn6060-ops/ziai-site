// stats 집계 공용 헬퍼 — report.js(실시간 증가)·reports.js(조회·백필)가 같이 씀.
// stats/{yyyy-MM-dd} 문서 = { total, action:{..}, verdict:{..}, app:{..} } (KST 날짜 기준).
// 라벨만 집계 — 원문 0.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Firestore 맵 키로 안전하게: '.'→'_'(지시서), 그 외 필드경로 특수문자도 '_'. 빈 값은 '(없음)'.
function key(v) {
  const s = (v == null ? '' : String(v)).trim();
  if (!s) return '(없음)';
  return s.replace(/[.~*/\[\]`]/g, '_').slice(0, 200);
}

// KST(UTC+9) 날짜 문자열.
function kstDay(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// "yyyy-MM-dd" KST 하루 시작 → epoch ms.
function kstStartMs(day) {
  return Date.parse(day + 'T00:00:00+09:00');
}

function isValidDay(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const ms = Date.parse(day + 'T00:00:00Z');
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}

// 이벤트 1건이 stats에 더하는 양 — ignore_daily는 count만큼, 나머지는 1.
function weight(ev) {
  if (ev.action === 'ignore_daily') {
    const n = Number(ev.count);
    return Number.isInteger(n) && n > 0 ? n : 0;
  }
  return 1;
}

// 이벤트가 속하는 stats 날짜 — ignore_daily는 앱이 보낸 집계 날짜(day), 나머지는 수신 시각(KST).
function statsDay(ev, createdMs) {
  if (ev.action === 'ignore_daily' && isValidDay(ev.day)) return ev.day;
  return kstDay(createdMs);
}

// 순수 합산(메모리) — 백필·조회 공용. into = { total, action, verdict, app }.
function addTo(into, ev, n) {
  into.total = (into.total || 0) + n;
  for (const [field, val] of [['action', ev.action], ['verdict', ev.ziVerdict], ['app', ev.app]]) {
    into[field] = into[field] || {};
    const k = key(val);
    into[field][k] = (into[field][k] || 0) + n;
  }
  return into;
}

// 실시간 증가용 — set(merge)에 넣을 FieldValue.increment 중첩 객체.
function incrementDoc(FieldValue, ev, n) {
  return {
    total: FieldValue.increment(n),
    action: { [key(ev.action)]: FieldValue.increment(n) },
    verdict: { [key(ev.ziVerdict)]: FieldValue.increment(n) },
    app: { [key(ev.app)]: FieldValue.increment(n) },
  };
}

// stats 문서 여러 개 합산.
function mergeStats(docs) {
  const out = { total: 0, action: {}, verdict: {}, app: {} };
  for (const s of docs) {
    out.total += Number(s.total) || 0;
    for (const f of ['action', 'verdict', 'app']) {
      for (const [k, v] of Object.entries(s[f] || {})) out[f][k] = (out[f][k] || 0) + (Number(v) || 0);
    }
  }
  return out;
}

module.exports = { key, kstDay, kstStartMs, isValidDay, weight, statsDay, addTo, incrementDoc, mergeStats };
