/** 업비트 공지 전체 이력 수집 → data/research-ext/announcements.json (2026-10-02, 축 C 리서치) */
import fs from 'fs';
const OUT = 'data/research-ext/announcements.json';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() {
  for (;;) { const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
    const hot = [0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58 || [1, 5, 9, 11, 13, 17, 21].includes(h) && m < 3;
    if (!hot) return; await sleep(20000); }
}
(async () => {
  const all: any[] = [];
  for (let p = 1; ; p++) {
    await yieldTicks();
    let j: any = null;
    for (let t = 0; t < 4 && !j; t++) { try { const r = await fetch(`https://api-manager.upbit.com/api/v1/announcements?os=web&page=${p}&per_page=20&category=all`); j = await r.json(); } catch { await sleep(2000); } }
    const n = j?.data?.notices || [];
    if (!n.length) break;
    all.push(...n);
    if (p % 25 === 0) console.log(p, all.length, n[n.length - 1].first_listed_at);
    if (p >= (j.data.total_pages || 0)) break;
    await sleep(400);
  }
  fs.writeFileSync(OUT, JSON.stringify(all));
  console.log('DONE', all.length, all[all.length - 1]?.first_listed_at);
})();
