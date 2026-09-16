// zi 이벤트 수집 수신 — Vercel 서버리스 함수
// 앱에서 사용자 선택(별/열기/신고/무반응)마다 POST → Firestore "events".
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

const ALLOWED_ACTIONS = ['star', 'open', 'report', 'ignore'];

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
    return res.status(400).json({ error: 'action 필요(star/open/report/ignore)' });
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
    status: 'new',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  try {
    const ref = await admin.firestore().collection('events').add(doc);
    return res.status(200).json({ ok: true, id: ref.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
