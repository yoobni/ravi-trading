/**
 * cron 정렬 검증 — "봉 마감 직후 진입" vs "봉 마감 +Nh 뒤 진입".
 *
 * 배경: Upbit 4h 봉은 UTC 00/04/08/12/16/20 (= KST 09/13/17/21/01/05) 에 마감되는데
 *       F6 cron 은 KST 00/04/08/12/16/20 +1분 에 돈다 → 매 tick 이 3시간 전에 마감된 봉으로 판단하고,
 *       라이브 진입가는 진입봉 시가가 아니라 그 봉이 3시간 진행된 시점의 가격이다.
 *       (backfill 은 진입봉 시가를 쓰므로 offset 0 과 동일 — 즉 라이브만 다르다.)
 *
 * 방법: 1h 캐시(28코인, 캐시 보유 전 구간)를 4h 로 합성(UTC 정렬).
 *       신호는 동일하게 4h 확정봉에서 평가하고, 진입가만
 *         offset 0h = 진입봉 시가 (정렬된 cron / backfill)
 *         offset 1~3h = 진입봉 시작 후 Nh 시점 1h 봉의 시가 (지연된 cron)
 *       청산은 두 경우 모두 진입봉 다음 4h 확정봉부터 동일 규칙 → 진입가 차이만 격리해서 본다.
 *
 * 실행: npx tsx scripts/_bt_tickoffset.ts
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];

const FEE = 0.0005, SLIP = 0.0005;
/** 왕복 비용 계수 — 진입 슬리피지/수수료 + 청산 슬리피지/수수료 */
const FR = (1 - FEE) * (1 - FEE) * (1 - SLIP) / (1 + SLIP);

const HOUR = 3600_000;
const FROM = Date.parse('2024-06-10T00:00:00Z');

// F6 파라미터 (4h)
const LB = 42, VW = 30, MAXB = 84;
const TP = 5.0, SL = -2.0;          // F6
const V2_TP = 7.0, V2_SL = -2.5;    // F6_v2
const TRAIL_ACT = 2.0, TRAIL_GAP = 2.0, TRAIL_SL = -2.0; // F6_v5/v6 A2

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }

function load1h(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter((f) => f.startsWith(m + '_60m_'));
  if (!files.length) return null;
  let best: Bar[] | null = null;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[];
    if (!best || d.length > best.length) best = d;
  }
  return best!.filter((b) => b.ts >= FROM).sort((a, b) => a.ts - b.ts);
}

/**
 * 1h → 4h (UTC 4h 경계 기준). 1h 봉 4개가 다 있는 창만 채택한다
 * (거래 정지 등으로 빠진 창은 버리므로 인덱스 기반 lookback/MAXB 창이 그만큼 실제 시간보다 짧아질 수 있음 —
 *  두 offset 비교에는 동일하게 적용되니 상대 비교에는 영향 없음).
 */
function to4h(h1: Bar[]) {
  const buckets = new Map<number, Bar[]>();
  for (const b of h1) {
    const key = Math.floor(b.ts / (4 * HOUR)) * 4 * HOUR;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(b);
  }
  const bars: Bar[] = [];
  const subByBarTs = new Map<number, Bar[]>();
  for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
    const s = buckets.get(key)!.sort((a, b) => a.ts - b.ts);
    if (s.length !== 4) continue;
    bars.push({
      ts: key,
      open: s[0].open,
      high: Math.max(...s.map((x) => x.high)),
      low: Math.min(...s.map((x) => x.low)),
      close: s[3].close,
      volume: s.reduce((a, x) => a + x.volume, 0),
    });
    subByBarTs.set(key, s);
  }
  return { bars, subByBarTs };
}

/** F6 신호: 직전봉이 7일 신고가 + 당봉 양봉·직전고점 돌파 + 거래량 z ≥ 0.5 */
function signal(b: Bar[], i: number): boolean {
  if (i < LB + 1 || i < VW) return false;
  let pm = -Infinity;
  for (let j = i - LB; j < i - 1; j++) if (b[j].high > pm) pm = b[j].high;
  if (!(b[i - 1].high > pm)) return false;
  if (!(b[i].close > b[i].open)) return false;
  if (!(b[i].close > b[i - 1].high)) return false;
  let s = 0, s2 = 0;
  for (let j = i - VW; j < i; j++) { s += b[j].volume; s2 += b[j].volume * b[j].volume; }
  const mn = s / VW, sd = Math.sqrt(Math.max(s2 / VW - mn * mn, 1e-12));
  return (sd > 0 ? (b[i].volume - mn) / sd : 0) >= 0.5;
}

interface Trade { exitTs: number; ret: number }

type ExitKind = 'TPSL' | 'TRAIL';

/** offsetH 시간만큼 늦게 진입했을 때의 성과. offsetH=0 이면 진입봉 시가. */
function sim(kind: ExitKind, tp: number, sl: number, offsetH: number, data: Map<string, ReturnType<typeof to4h>>): Trade[] {
  const out: Trade[] = [];
  for (const [, { bars, subByBarTs }] of data) {
    let entryIdx = -1, entryPrice = 0, peak = 0, trailSl = 0, armed = false;
    for (let i = LB + 1; i < bars.length; i++) {
      if (entryIdx >= 0) {
        if (i <= entryIdx) continue;
        const bar = bars[i];
        let exitPrice = 0, done = false;
        if (kind === 'TPSL') {
          const tpLvl = entryPrice * (1 + tp / 100), slLvl = entryPrice * (1 + sl / 100);
          if (bar.low <= slLvl) { exitPrice = slLvl; done = true; }
          else if (bar.high >= tpLvl) { exitPrice = tpLvl; done = true; }
        } else {
          if (bar.low <= trailSl) { exitPrice = trailSl; done = true; }
          else {
            peak = Math.max(peak, bar.high);
            if (!armed && peak >= entryPrice * (1 + TRAIL_ACT / 100)) armed = true;
            if (armed) trailSl = Math.max(trailSl, peak * (1 - TRAIL_GAP / 100));
          }
        }
        if (!done && (i - entryIdx) >= MAXB) { exitPrice = bar.close; done = true; }
        if (done) {
          out.push({ exitTs: bar.ts, ret: FR * (exitPrice / entryPrice) - 1 });
          entryIdx = -1;
        }
        continue;
      }
      if (i >= bars.length - 1 || !signal(bars, i)) continue;
      const entryBar = bars[i + 1];
      let raw: number;
      if (offsetH === 0) raw = entryBar.open;
      else {
        const sub = subByBarTs.get(entryBar.ts);
        const s = sub?.find((x) => x.ts === entryBar.ts + offsetH * HOUR);
        if (!s) continue;               // 1h 결손 → 이 신호는 건너뜀
        raw = s.open;
      }
      entryIdx = i + 1;
      entryPrice = raw * (1 + SLIP);
      peak = entryPrice;
      trailSl = entryPrice * (1 + TRAIL_SL / 100);
      armed = false;
    }
  }
  return out;
}

function stats(T: Trade[]) {
  if (!T.length) return null;
  const wins = T.filter((t) => t.ret > 0);
  const gw = wins.reduce((a, t) => a + t.ret, 0);
  const gl = Math.abs(T.filter((t) => t.ret <= 0).reduce((a, t) => a + t.ret, 0));
  const seq = [...T].sort((a, b) => a.exitTs - b.exitTs);
  let eq = 0, pk = 0, mdd = 0;
  for (const t of seq) { eq += t.ret; pk = Math.max(pk, eq); mdd = Math.max(mdd, pk - eq); }
  return { n: T.length, wr: wins.length / T.length * 100, pf: gl > 0 ? gw / gl : 99, total: eq * 100, mdd: mdd * 100 };
}

function row(label: string, s: ReturnType<typeof stats>) {
  if (!s) { console.log(`  ${label.padEnd(22)}| 거래부족`); return; }
  console.log(
    `  ${label.padEnd(22)}| n=${String(s.n).padStart(4)} WR ${s.wr.toFixed(1).padStart(5)}% ` +
    `PF ${s.pf.toFixed(2).padStart(5)} 총 ${(s.total.toFixed(0) + '%').padStart(7)} ` +
    `MDD ${(s.mdd.toFixed(0) + '%').padStart(5)} 수익/MDD ${(s.mdd > 0 ? s.total / s.mdd : 0).toFixed(2).padStart(5)}`,
  );
}

(() => {
  const data = new Map<string, ReturnType<typeof to4h>>();
  for (const m of COINS) {
    const h1 = load1h(m);
    if (!h1 || h1.length < 500) continue;
    data.set(m, to4h(h1));
  }
  const totalBars = [...data.values()].reduce((a, v) => a + v.bars.length, 0);
  const allTs = [...data.values()].flatMap((v) => [v.bars[0]?.ts, v.bars[v.bars.length - 1]?.ts]).filter(Boolean) as number[];
  const range = `${new Date(Math.min(...allTs)).toISOString().slice(0, 7)}~${new Date(Math.max(...allTs)).toISOString().slice(0, 7)}`;
  console.log(`=== cron 진입 지연 검증 (1h 캐시 → 4h 합성, ${data.size}코인, 4h봉 ${totalBars.toLocaleString()}개, ${range}) ===`);
  console.log('offset 0h = 봉 마감 직후 진입(정렬된 cron·backfill) / 3h = 현행 라이브 cron\n');

  const VARIANTS: Array<[string, ExitKind, number, number]> = [
    ['F6 (TP+5/SL-2)', 'TPSL', TP, SL],
    ['F6_v2 (TP+7/SL-2.5)', 'TPSL', V2_TP, V2_SL],
    ['F6_v5 (TRAIL A2)', 'TRAIL', 0, 0],
  ];
  for (const [name, kind, tp, sl] of VARIANTS) {
    console.log(`◆ ${name}`);
    for (const off of [0, 1, 2, 3]) {
      row(`offset ${off}h${off === 3 ? ' (현행)' : off === 0 ? ' (정렬)' : ''}`, stats(sim(kind, tp, sl, off, data)));
    }
    console.log('');
  }

  // 기간 분할 — 한 구간의 우연인지 확인 (offset 0 vs 3 만)
  const PERIODS: Array<[string, string, string]> = [
    ['2024H2', '2024-06-10', '2025-01-01'],
    ['2025H1', '2025-01-01', '2025-07-01'],
    ['2025H2', '2025-07-01', '2026-01-01'],
    ['2026H1', '2026-01-01', '2026-06-11'],
  ];
  console.log('◆ 기간 분할 (offset 0h 정렬 → 3h 현행)');
  for (const [name, kind, tp, sl] of VARIANTS) {
    const t0 = sim(kind, tp, sl, 0, data), t3 = sim(kind, tp, sl, 3, data);
    console.log(`  ${name}`);
    for (const [label, from, to] of PERIODS) {
      const f = Date.parse(from + 'T00:00:00Z'), t = Date.parse(to + 'T00:00:00Z');
      const a = stats(t0.filter((x) => x.exitTs >= f && x.exitTs < t));
      const b = stats(t3.filter((x) => x.exitTs >= f && x.exitTs < t));
      if (!a || !b) { console.log(`    ${label}: 거래부족`); continue; }
      console.log(
        `    ${label}: PF ${a.pf.toFixed(2)} → ${b.pf.toFixed(2)}   ` +
        `총 ${a.total.toFixed(0)}% → ${b.total.toFixed(0)}%   n ${a.n}/${b.n}`,
      );
    }
  }
})();
