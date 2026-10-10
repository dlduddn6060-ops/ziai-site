// zi 이벤트 수집 수신 — Vercel 서버리스 함수
// 앱에서 사용자 선택(별/열기/신고/추천)마다 POST → Firestore "events".
// 무반응은 앱이 하루 1회 (앱, 판정)별 개수로 묶어 보냄(action=ignore_daily, count, day).
// 저장과 동시에 stats/{yyyy-MM-dd}(KST) 집계 문서를 FieldValue.increment로 갱신 — 대시보드는 stats만 읽음.
// ⚠️ 라벨만 저장. 알림 원문(제목·본문·발신자·인증번호·금액·메모)은 방어적 allowlist로 절대 저장 안 함.
//
// 환경변수(Vercel → Settings → Environment Variables):
//  - FIREBASE_SERVICE_ACCOUNT : Firebase 서비스 계정 키 JSON 전체(문자열)
//  - REPORT_KEY (선택)        : 스팸 방지 공유키. 설정 시 앱이 같은 값을 보내야 접수.

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const stats = require('./_stats');
const { isTransient } = require('./_errors');

// 'ignore'(건별)는 구버전 앱 호환용으로 계속 받음.
const ALLOWED_ACTIONS = ['star', 'open', 'report', 'ignore', 'ignore_daily', 'suggest_open', 'suggest_dismiss'];

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용' });

  const d = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  if (process.env.REPORT_KEY && d.key !== process.env.REPORT_KEY) {
    return res.status(401).json({ error: 'bad key' });
  }

  const action = (d.action || '').toString();
  if (!ALLOWED_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'action 필요(' + ALLOWED_ACTIONS.join('/') + ')' });
  }
  let count = null;
  let day = null;
  if (action === 'ignore_daily') {
    count = Number(d.count);
    if (!Number.isInteger(count) || count < 1 || count > 10000) {
      return res.status(400).json({ error: 'ignore_daily: count는 1~10000 정수' });
    }
    day = (d.day || '').toString();
    if (!stats.isValidDay(day)) return res.status(400).json({ error: 'ignore_daily: day는 yyyy-MM-dd' });
  }

  // 라벨 allowlist — 이 필드만 저장. 원문류(title/body/summary/sender/memo)는 와도 버림.
  const doc = {
    action,                                                 // 사용자 반응
    app: (d.app || '').toString().slice(0, 200),            // packageName or 앱label (출처)
    ziVerdict: (d.ziVerdict || '').toString().slice(0, 60), // zi 판정(bucket): IMPORTANT/CONTACT/INFO/NOISE/AD...
    signals: (d.signals || '').toString().slice(0, 500),    // 왜 그 판정: canReply,isGroup,category 등
    installId: (d.installId || '').toString().slice(0, 64), // 익명 설치ID(재설치 리셋)
    appVersion: (d.appVersion || '').toString().slice(0, 60),
    clientTs: Number(d.ts) || null,
    ...(action === 'ignore_daily' ? { count, day } : {}),
    status: 'new',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const db = admin.firestore();
    const ref = db.collection('events').doc();
    const statsRef = db.collection('stats').doc(stats.statsDay(doc, Date.now()));
    const batch = db.batch();
    batch.set(ref, doc);
    batch.set(statsRef, stats.incrementDoc(admin.firestore.FieldValue, doc, stats.weight(doc)), { merge: true });
    await batch.commit();
    return res.status(200).json({ ok: true, id: ref.id });
  } catch (e) {
    // 충돌·일시 오류(ABORTED/RESOURCE_EXHAUSTED/UNAVAILABLE) = 503 → 앱이 같은 날 백오프 재시도. 그 외 500.
    if (isTransient(e)) return res.status(503).json({ error: 'temporarily unavailable', code: String(e.code) });
    return res.status(500).json({ error: e.message });
  }
};
