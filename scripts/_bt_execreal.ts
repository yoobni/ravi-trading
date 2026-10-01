/**
 * 체결 현실을 넣은 청산 재검증 (2026-10-01).
 *
 * 왜: 지금까지의 모든 `_bt_*` 는 스톱/목표 '가격'에 정산한다. 그러려면 거래소에
 *   예약 스톱 주문이 걸려 있어야 하는데, 업비트 Open API 는 스톱 주문을 지원하지 않는다
 *   (limit/price/market/best 만). 즉 SL·TRAIL 은 폴링 후 시장가로 나가는 수밖에 없고,
 *   페이퍼 실측에서 그 격차가 TRAIL 기준 평균 −5% 였다.
 *   → "1h 청산 관리 기각(PF 1.76→1.54)" 판정이 그 가정 위에 있었으므로 다시 돌린다.
 *
 * 설계: 신호·진입은 전부 동일(4h F6, 다음 4h봉 시가). 공정성을 위해 동시보유 제약 없이
 *   신호마다 독립 거래로 센다 → 차이는 전부 '청산 처리'에서만 나온다.
 *
 * 3축:
 *   polling  — 청산을 몇 시간마다 확인하나 (4h / 1h)
 *   offset   — 봉마감 기준 몇 시간 뒤에 확인하나 (0h=정렬 / 3h=현행 미정렬 크론)
 *   settle   — stop: 트리거 '가격'에 체결(기존 가정) / market: 확인 시점 종가에 체결(현실)
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005;
const H = 3600_000;
/** 왕복 마찰: 매수 슬리피지+수수료, 매도 슬리피지+수수료 */
const FR = (1 - FEE) ** 2 * (1 - SLIP) / (1 + SLIP);

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }

function load1h(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(m + '_60m_'));
  let best: Bar[] | null = null;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[];
    if (!best || d.length > best.length) best = d;
  }
  return best ? best.slice().sort((a, b) => a.ts - b.ts) : null;
}
function to4h(h1: Bar[]): Bar[] {
  const bk = new Map<number, Bar[]>();
  for (const b of h1) { const k = Math.floor(b.ts / (4 * H)) * 4 * H; (bk.get(k) ?? bk.set(k, []).get(k)!).push(b); }
  const out: Bar[] = [];
  for (const k of [...bk.keys()].sort((a, b) => a - b)) {
    const s = bk.get(k)!.sort((a, b) => a.ts - b.ts);
    if (s.length !== 4) continue;
    out.push({ ts: k, open: s[0].open, high: Math.max(...s.map(x => x.high)), low: Math.min(...s.map(x => x.low)), close: s[3].close, volume: s.reduce((a, x) => a + x.volume, 0) });
  }
  return out;
}
const volZ = (b: Bar[], i: number, w: number) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hiOf = (b: Bar[], f: number, t: number) => { let m = -Infinity; for (let j = f; j < t; j++) m = Math.max(m, b[j].high); return m; };
const sig4 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hiOf(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;

const DATA: Array<{ m: string; h1: Bar[]; h4: Bar[]; idx1: Map<number, number> }> = [];
for (const m of COINS) {
  const h1 = load1h(m); if (!h1 || h1.length < 2000) continue;
  DATA.push({ m, h1, h4: to4h(h1), idx1: new Map(h1.map((b, i) => [b.ts, i])) });
}

const SL = -2, ACT = 2, GAP = 2, MAX_H = 84 * 4; // TRAIL A2, 14일

/**
 * 폴링 모델. 라이브 코드와 같은 의미:
 *   - 확인 시점(poll)마다 그때까지 확정된 봉 전체를 훑어 peak/스톱을 갱신하고 트리거를 찾는다
 *   - 트리거가 있으면 settle='stop'이면 트리거 가격, 'market'이면 "확인 시점 종가"로 나간다
 *   - 확인 사이에 스톱이 깨져도 다음 확인 전엔 모른다 (= 예약 주문이 없다는 뜻)
 */
function exitSim(h1: Bar[], s1: number, ep: number, pollH: number, offH: number, settle: 'stop' | 'market', mgmtH = 0) {
  // mgmtH > 0 이면 '감지'는 pollH 마다 하되 '스톱 레벨 갱신'은 mgmtH 마다만 한다.
  //   (4h 스톱의 굼뜸 = 노이즈 필터라는 기존 결론을 지키면서 체결 지연만 줄이는 조합)
  const MG = mgmtH || pollH;
  let stop = ep * (1 + SL / 100), peak = ep, armed = false;
  for (let j = s1; j < h1.length && j - s1 < MAX_H; j++) {
    const b = h1[j];
    const isPoll = (((b.ts + H) / H) % pollH + pollH) % pollH === offH % pollH;
    const isMgmt = (((b.ts + H) / H) % MG + MG) % MG === offH % MG;
    // 이번 1h 봉 안에서 '직전 확인 시점의 스톱'이 깨졌는지
    const broke = b.low <= stop;
    if (isPoll) {
      if (broke) {
        const px = settle === 'stop' ? stop : b.close;   // 확인 시점 종가 = 그때 시장가
        return { px, ts: b.ts, hours: j - s1 + 1, reason: 'STOP' as const };
      }
      if (isMgmt) {
        peak = Math.max(peak, hiOf(h1, s1, j + 1));
        if (!armed && peak >= ep * (1 + ACT / 100)) armed = true;
        if (armed) stop = Math.max(stop, peak * (1 - GAP / 100));
      }
    } else if (broke) {
      // 깨졌지만 아직 확인 전 — 다음 확인 시점까지 끌고 간다
      for (let k = j + 1; k < h1.length && k - s1 < MAX_H; k++) {
        const bb = h1[k];
        if ((((bb.ts + H) / H) % pollH + pollH) % pollH === offH % pollH) {
          const px = settle === 'stop' ? stop : bb.close;
          return { px, ts: bb.ts, hours: k - s1 + 1, reason: 'STOP' as const };
        }
      }
      break;
    }
  }
  const last = h1[Math.min(s1 + MAX_H - 1, h1.length - 1)];
  return last ? { px: last.close, ts: last.ts, hours: MAX_H, reason: 'TIME' as const } : null;
}

function run(pollH: number, offH: number, settle: 'stop' | 'market', mgmtH = 0) {
  const rets: number[] = []; let span = [Infinity, -Infinity];
  for (const d of DATA) {
    for (let i = 43; i < d.h4.length - 1; i++) {
      if (!sig4(d.h4, i)) continue;
      const eb = d.h4[i + 1]; const ep = eb.open * (1 + SLIP);
      const s1 = d.idx1.get(eb.ts); if (s1 === undefined) continue;
      const r = exitSim(d.h1, s1 + 4, ep, pollH, offH, settle, mgmtH); if (!r) continue;
      rets.push((r.px / ep) * FR - 1);
      span = [Math.min(span[0], eb.ts), Math.max(span[1], r.ts)];
    }
  }
  const w = rets.filter(x => x > 0), l = rets.filter(x => x <= 0);
  const pf = l.length && Math.abs(l.reduce((a, b) => a + b, 0)) > 0 ? w.reduce((a, b) => a + b, 0) / Math.abs(l.reduce((a, b) => a + b, 0)) : Infinity;
  return { n: rets.length, avg: 100 * rets.reduce((a, b) => a + b, 0) / rets.length, wr: 100 * w.length / rets.length, pf, span };
}

console.log(`코인 ${DATA.length}종 · 1h봉 ${DATA.reduce((a, d) => a + d.h1.length, 0).toLocaleString()}개`);
const probe = run(4, 0, 'stop');
console.log(`기간 ${new Date(probe.span[0]).toISOString().slice(0, 10)} ~ ${new Date(probe.span[1]).toISOString().slice(0, 10)} · 신호 ${probe.n}건\n`);
console.log('조합'.padEnd(26)+' 정산    거래당평균   승률      PF');
const CELLS: Array<[number, number, number, string]> = [
  [4, 0, 0, '현행 격자(정렬)'],
  [4, 3, 0, '현행 격자(미정렬 크론)'],
  [1, 0, 0, '1h 전면(감지+스톱갱신)'],
  [2, 0, 0, '2h 전면'],
  [1, 0, 4, '감지 1h · 스톱갱신 4h  ★'],
  [2, 0, 4, '감지 2h · 스톱갱신 4h'],
];
for (const [pollH, offH, mgmtH, label] of CELLS) {
  for (const settle of ['stop', 'market'] as const) {
    const r = run(pollH, offH, settle, mgmtH);
    console.log(`${label.padEnd(26)} ${settle.padEnd(7)} ${((r.avg >= 0 ? '+' : '') + r.avg.toFixed(3) + '%').padStart(8)} ${(r.wr.toFixed(1) + '%').padStart(6)} ${r.pf.toFixed(3).padStart(7)}`);
  }
}
