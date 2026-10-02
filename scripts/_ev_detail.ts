/** 축 C: 이벤트 공지 본문 수집 → data/research-ext/ann-detail.json */
import fs from 'fs';
const a = JSON.parse(fs.readFileSync('data/research-ext/announcements.json', 'utf8'));
const RX = /신규 거래지원|마켓 디지털 자산 추가|마켓 추가|유의 ?종목|거래지원 종료|유의 촉구/;
const ev = a.filter((x: any) => RX.test(x.title));
const OUT = 'data/research-ext/ann-detail.json';
const done: Record<string, any> = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function yieldTicks() { for (;;) { const k = new Date(Date.now() + 9 * 3600e3); const h = k.getUTCHours(), m = k.getUTCMinutes();
  if (!([0, 4, 8, 10, 12, 16, 20].includes(h) && m >= 58 || [1, 5, 9, 11, 13, 17, 21].includes(h) && m < 3)) return; await sleep(20000); } }
(async () => {
  console.log('events', ev.length);
  let n = 0;
  for (const x of ev) {
    if (done[x.id]) continue;
    await yieldTicks();
    try { const j = await (await fetch(`https://api-manager.upbit.com/api/v1/announcements/${x.id}`)).json(); done[x.id] = { ...x, body: j?.data?.body ?? '' }; } catch { }
    if (++n % 50 === 0) { fs.writeFileSync(OUT, JSON.stringify(done)); console.log(n); }
    await sleep(350);
  }
  fs.writeFileSync(OUT, JSON.stringify(done)); console.log('DONE', Object.keys(done).length);
})();
