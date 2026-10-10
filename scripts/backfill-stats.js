// stats 백필 — 기존 events 전체로 stats/{yyyy-MM-dd}(KST)를 한 번 채운다(1회 실행용).
// 서버(api/reports.js action:'backfill')가 events를 다시 합산해 stats 문서를 **덮어쓰므로** 재실행해도 중복 증가 없음.
//
// 실행(PowerShell):
//   $env:ZI_ADMIN_PW = "<관리자 비밀번호>"; node scripts/backfill-stats.js; Remove-Item Env:ZI_ADMIN_PW
// 비밀번호는 환경변수로만 받음 — 인자·파일·로그에 남기지 않음.

const BASE = process.env.ZI_SITE || 'https://www.ziai.app';
const pw = process.env.ZI_ADMIN_PW;
if (!pw) {
  console.error('ZI_ADMIN_PW 환경변수가 필요해요.');
  process.exit(1);
}

(async () => {
  const r = await fetch(BASE + '/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw, action: 'backfill' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('실패', r.status, j.error || '');
    process.exit(1);
  }
  console.log(`완료 — events ${j.scanned}건 스캔, stats ${j.days}일 기록 (${j.from} ~ ${j.to})`);
})();
