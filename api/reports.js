// zi 이벤트 조회/관리 — 관리자 전용(ADMIN_PASSWORD). reports.html이 호출.
//   POST { password, action:'list' }        → 최근 이벤트 500건(최신순)
//   POST { password, action:'fix',    id }  → status='fixed'
//   POST { password, action:'delete', id }  → 삭제
// 필터/집계는 reports.html(클라)에서 — Firestore 복합 인덱스 회피.

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용' });
  const d = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { password, action, id } = d;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '비밀번호가 틀렸어요' });

  const db = admin.firestore();
  try {
    if (action === 'delete') {
      if (!id) return res.status(400).json({ error: 'id 없음' });
      await db.collection('events').doc(id).delete();
      return res.status(200).json({ ok: true });
    }
    if (action === 'fix') {
      if (!id) return res.status(400).json({ error: 'id 없음' });
      await db.collection('events').doc(id).update({ status: 'fixed' });
      return res.status(200).json({ ok: true });
    }
    const snap = await db.collection('events').orderBy('createdAt', 'desc').limit(500).get();
    const items = snap.docs.map((x) => {
      const v = x.data();
      const c = v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : (v.clientTs || null);
      return { id: x.id, ...v, createdAt: c };
    });
    return res.status(200).json({ ok: true, items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
