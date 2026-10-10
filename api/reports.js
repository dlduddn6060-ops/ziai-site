// zi 이벤트 조회/관리 — 관리자 전용(ADMIN_PASSWORD). reports.html이 호출.
//   POST { password, action:'stats', from?, to? }                 → 기간 stats/{yyyy-MM-dd}(KST) 합산
//   POST { password, action:'list', cursor?, limit=100, from?, to? } → 최신순 페이지(startAfter), nextCursor
//        + onlyAction:'report' → 그 action만(최대 500, 기간·정렬은 메모리, 페이지 없음, truncated 표시)
//   POST { password, action:'fix',    id }                        → status='fixed'
//   POST { password, action:'delete', id }                        → 삭제
//   POST { password, action:'backfill' }                          → events 전체로 stats 재계산(1회용, 덮어쓰기라 재실행 안전)
// from/to = "yyyy-MM-dd"(KST, 양끝 포함). 없으면 전체. 단일 필드(createdAt·문서ID) 범위만 써서 복합 인덱스 불필요.

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const stats = require('./_stats');

const DAY_MS = 24 * 3600 * 1000;

function toItem(x) {
  const v = x.data();
  const c = v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : (v.clientTs || null);
  return { id: x.id, ...v, createdAt: c };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용' });
  const d = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { password, action, id } = d;
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '비밀번호가 틀렸어요' });

  const from = d.from ? String(d.from) : null;
  const to = d.to ? String(d.to) : null;
  if ((from && !stats.isValidDay(from)) || (to && !stats.isValidDay(to))) {
    return res.status(400).json({ error: 'from/to는 yyyy-MM-dd' });
  }

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

    if (action === 'stats') {
      let q = db.collection('stats');
      const docId = admin.firestore.FieldPath.documentId();
      if (from) q = q.where(docId, '>=', from);
      if (to) q = q.where(docId, '<=', to);
      const snap = await q.get();
      const merged = stats.mergeStats(snap.docs.map((x) => x.data()));
      return res.status(200).json({ ok: true, days: snap.size, ...merged });
    }

    if (action === 'backfill') {
      // events 전체를 페이지로 읽어 날짜별로 다시 합산 → stats 문서 덮어쓰기(set, merge 아님).
      const byDay = {};
      let last = null;
      let scanned = 0;
      for (;;) {
        let q = db.collection('events').orderBy(admin.firestore.FieldPath.documentId()).limit(1000);
        if (last) q = q.startAfter(last);
        const snap = await q.get();
        if (snap.empty) break;
        for (const x of snap.docs) {
          const v = x.data();
          const ms = v.createdAt && v.createdAt.toMillis ? v.createdAt.toMillis() : (Number(v.clientTs) || 0);
          if (!ms && v.action !== 'ignore_daily') continue;
          const day = stats.statsDay(v, ms);
          byDay[day] = stats.addTo(byDay[day] || {}, v, stats.weight(v));
        }
        scanned += snap.size;
        last = snap.docs[snap.docs.length - 1];
      }
      const days = Object.keys(byDay).sort();
      for (let i = 0; i < days.length; i += 400) {
        const batch = db.batch();
        days.slice(i, i + 400).forEach((day) => batch.set(db.collection('stats').doc(day), byDay[day]));
        await batch.commit();
      }
      return res.status(200).json({ ok: true, scanned, days: days.length, from: days[0] || null, to: days[days.length - 1] || null });
    }

    // [수정만] onlyAction — 그 action만. action 등치 + createdAt 범위/정렬은 복합 인덱스가 필요하므로 피하고,
    // 등치 조회만(단일 필드 자동 인덱스) 최대 REPORT_MAX건 → 기간 필터·최신순 정렬은 서버 메모리에서. 페이지 없이 한 번에.
    if (d.onlyAction) {
      const only = String(d.onlyAction);
      const REPORT_MAX = 500;
      const snap = await db.collection('events').where('action', '==', only).limit(REPORT_MAX).get();
      const lo = from ? stats.kstStartMs(from) : -Infinity;
      const hi = to ? stats.kstStartMs(to) + DAY_MS : Infinity;
      const items = snap.docs.map(toItem)
        .filter((x) => (x.createdAt || 0) >= lo && (x.createdAt || 0) < hi)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return res.status(200).json({ ok: true, items, nextCursor: null, truncated: snap.size === REPORT_MAX });
    }

    // 'list'(기본) — 최신순 페이지.
    const limit = Math.min(Math.max(parseInt(d.limit, 10) || 100, 1), 500);
    let q = db.collection('events').orderBy('createdAt', 'desc');
    if (from) q = q.where('createdAt', '>=', admin.firestore.Timestamp.fromMillis(stats.kstStartMs(from)));
    if (to) q = q.where('createdAt', '<', admin.firestore.Timestamp.fromMillis(stats.kstStartMs(to) + DAY_MS));
    if (d.cursor) {
      const cur = await db.collection('events').doc(String(d.cursor)).get();
      if (cur.exists) q = q.startAfter(cur);
    }
    const snap = await q.limit(limit).get();
    const items = snap.docs.map(toItem);
    const nextCursor = snap.size === limit ? snap.docs[snap.size - 1].id : null;
    return res.status(200).json({ ok: true, items, nextCursor });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
