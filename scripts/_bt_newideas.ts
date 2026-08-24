/**
 * 신규 전략 스크리닝 — 지금 포트폴리오에 "다른 것"이 될 후보 찾기.
 *
 * 문제의식: 운영 6전략 중 5개가 같은 F6 돌파신호의 청산 변형이고, 나머지 1개(F1F2)는
 *   거래가 2건뿐이다. 즉 분산이 사실상 없다. 새 전략의 목표는 "더 좋은 PF"가 아니라
 *   "F6와 다른 시점에 버는 것" — 그래서 성과와 함께 F6 대비 월별수익 상관을 같이 잰다.
 *
 * 공통 규칙(기존 프로젝트와 동일, lookahead-safe):
 *   신호는 확정봉에서만 평가 → 진입은 다음 4h봉 시가 → 청산 판정은 진입봉 다음 봉부터
 *   수수료 0.05% + 슬리피지 0.05% 왕복
 *
 * 실행: npx tsx scripts/_bt_newideas.ts
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const COINS = ['KRW-BTC','KRW-ETH','KRW-SOL','KRW-XRP','KRW-ADA','KRW-DOGE','KRW-AVAX','KRW-LINK','KRW-DOT','KRW-BCH','KRW-POL','KRW-NEAR','KRW-ATOM','KRW-TRX','KRW-ALGO','KRW-ETC','KRW-XLM','KRW-AAVE','KRW-ARB','KRW-APT','KRW-SUI','KRW-GRT','KRW-IMX','KRW-SAND','KRW-MANA','KRW-CHZ','KRW-AXS','KRW-BAT'];
const FEE = 0.0005, SLIP = 0.0005;
const FR = (1 - FEE) ** 2 * (1 - SLIP) / (1 + SLIP);
const BARS_D = 6;   // 4h봉 하루치

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number }
function load(m: string): Bar[] | null {
  const files = fs.readdirSync(DIR).filter(f => f.startsWith(m + '_240m_'));
  let best: Bar[] | null = null;
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as Bar[];
    if (!best || d.length > best.length) best = d;
  }
  return best;
}
const DATA = new Map<string, Bar[]>();
for (const m of COINS) { const b = load(m); if (b && b.length > 400) DATA.set(m, b); }

interface Trade { entryTs: number; exitTs: number; ret: number }
const volZ = (b: Bar[], i: number, w: number) => {
  if (i < w) return 0;
  let s = 0, s2 = 0;
  for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume * b[j].volume; }
  const mn = s / w, sd = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12));
  return sd > 0 ? (b[i].volume - mn) / sd : 0;
};
const hi = (b: Bar[], from: number, to: number) => { let m = -Infinity; for (let j = from; j < to; j++) m = Math.max(m, b[j].high); return m; };
const lo = (b: Bar[], from: number, to: number) => { let m = Infinity; for (let j = from; j < to; j++) m = Math.min(m, b[j].low); return m; };
const sma = (b: Bar[], i: number, n: number) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += b[j].close; return s / n; };

/** 공통 시뮬레이터: signal(b,i) 가 true 면 i+1 시가 진입, exit 규칙으로 청산 */
type ExitCfg = { tp?: number; sl: number; maxBars: number; trailAct?: number; trailGap?: number };
function simulate(signal: (b: Bar[], i: number) => boolean, exit: ExitCfg, warmup: number): Trade[] {
  const out: Trade[] = [];
  for (const [, b] of DATA) {
    let ei = -1, ep = 0, peak = 0, tsl = 0, armed = false;
    for (let i = warmup; i < b.length - 1; i++) {
      if (ei >= 0) {
        if (i <= ei) continue;
        const bar = b[i];
        let px = 0, done = false;
        if (exit.trailAct != null) {
          if (bar.low <= tsl) { px = tsl; done = true; }
          else {
            peak = Math.max(peak, bar.high);
            if (!armed && peak >= ep * (1 + exit.trailAct / 100)) armed = true;
            if (armed) tsl = Math.max(tsl, peak * (1 - exit.trailGap! / 100));
          }
        } else {
          const slLvl = ep * (1 + exit.sl / 100), tpLvl = ep * (1 + exit.tp! / 100);
          if (bar.low <= slLvl) { px = slLvl; done = true; }
          else if (bar.high >= tpLvl) { px = tpLvl; done = true; }
        }
        if (!done && (i - ei) >= exit.maxBars) { px = bar.close; done = true; }
        if (done) { out.push({ entryTs: b[ei].ts, exitTs: bar.ts, ret: FR * (px / ep) - 1 }); ei = -1; }
        continue;
      }
      if (!signal(b, i)) continue;
      ei = i + 1; ep = b[i + 1].open * (1 + SLIP);
      peak = ep; tsl = ep * (1 + exit.sl / 100); armed = false;
    }
  }
  return out;
}

function stats(T: Trade[]) {
  if (T.length < 20) return null;
  const w = T.filter(t => t.ret > 0);
  const gw = w.reduce((a, t) => a + t.ret, 0), gl = Math.abs(T.filter(t => t.ret <= 0).reduce((a, t) => a + t.ret, 0));
  const seq = [...T].sort((a, b) => a.exitTs - b.exitTs);
  let eq = 0, pk = 0, mdd = 0;
  for (const t of seq) { eq += t.ret; pk = Math.max(pk, eq); mdd = Math.max(mdd, pk - eq); }
  return { n: T.length, wr: w.length / T.length * 100, pf: gl > 0 ? gw / gl : 99, total: eq * 100, mdd: mdd * 100 };
}
/** 월별 수익 시계열 (청산 시점 기준) */
function monthly(T: Trade[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of T) {
    const k = new Date(t.exitTs).toISOString().slice(0, 7);
    m.set(k, (m.get(k) ?? 0) + t.ret);
  }
  return m;
}
function corr(a: Map<string, number>, b: Map<string, number>) {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  if (keys.length < 6) return NaN;
  const x = keys.map(k => a.get(k) ?? 0), y = keys.map(k => b.get(k) ?? 0);
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : NaN;
}

// ── 신호 정의 ──────────────────────────────────────────────
/** F6 (현행): 직전봉 7일 신고가 + 당봉 양봉·직전고점 돌파 + 거래량 z≥0.5 */
const sigF6 = (b: Bar[], i: number) =>
  i >= 43 && b[i - 1].high > hi(b, i - 42, i - 1) && b[i].close > b[i].open &&
  b[i].close > b[i - 1].high && volZ(b, i, 30) >= 0.5;

/** A. 항복 반등: 7일 신저가 + 당봉 급락 + 거래량 폭증 → 다음봉 진입 (돌파의 반대편) */
const sigCapit = (b: Bar[], i: number) =>
  i >= 43 && b[i].low <= lo(b, i - 42, i) && (b[i].close / b[i].open - 1) <= -0.03 && volZ(b, i, 30) >= 2;

/** B. 추세 내 눌림목: 30일선 위 + 최근 3일 저가 갱신 + 당봉 반등 양봉 */
const sigDip = (b: Bar[], i: number) =>
  i >= 181 && b[i].close > sma(b, i, 180) && b[i - 1].low <= lo(b, i - 18, i - 1) &&
  b[i].close > b[i].open && b[i].close > b[i - 1].high;

/** C. 변동성 수축 후 확장: 최근 10봉 레인지가 60봉 평균의 절반 이하 → 상방 이탈 */
const sigSqueeze = (b: Bar[], i: number) => {
  if (i < 61) return false;
  const r10 = (hi(b, i - 10, i) - lo(b, i - 10, i)) / b[i].close;
  let s = 0; for (let j = i - 60; j < i; j++) s += (b[j].high - b[j].low) / b[j].close;
  const avg = s / 60;
  return r10 < avg * 5 && b[i].close > hi(b, i - 10, i) && b[i].close > b[i].open && volZ(b, i, 30) >= 1;
};

const TRAIL: ExitCfg = { sl: -2, maxBars: 84, trailAct: 2, trailGap: 2 };
const TPSL: ExitCfg = { tp: 5, sl: -2, maxBars: 84 };

const f6 = simulate(sigF6, TRAIL, 44);
const f6m = monthly(f6);

const CAND: Array<[string, Trade[]]> = [
  ['F6 (현행·트레일)', f6],
  ['F6 (현행·TP5/SL2)', simulate(sigF6, TPSL, 44)],
  ['A 항복반등 (트레일)', simulate(sigCapit, TRAIL, 44)],
  ['A 항복반등 (TP5/SL3)', simulate(sigCapit, { tp: 5, sl: -3, maxBars: 42 }, 44)],
  ['B 추세눌림목 (트레일)', simulate(sigDip, TRAIL, 182)],
  ['B 추세눌림목 (TP5/SL2)', simulate(sigDip, TPSL, 182)],
  ['C 변동성수축돌파 (트레일)', simulate(sigSqueeze, TRAIL, 62)],
];

const range = (() => {
  const all = [...DATA.values()];
  const s = Math.min(...all.map(b => b[0].ts)), e = Math.max(...all.map(b => b[b.length - 1].ts));
  return `${new Date(s).toISOString().slice(0, 7)}~${new Date(e).toISOString().slice(0, 7)}`;
})();
console.log(`=== 신규 전략 스크리닝 (${DATA.size}코인 4h, ${range}) ===`);
console.log('상관 = F6(트레일) 월별수익과의 상관계수. 낮을수록 분산 효과가 큼\n');
console.log('  전략                        |    n |    WR |    PF |     총익 |   MDD | 수익/MDD | F6상관');
for (const [name, T] of CAND) {
  const s = stats(T);
  if (!s) { console.log(`  ${name.padEnd(26)}| 표본부족 (n=${T.length})`); continue; }
  const c = corr(monthly(T), f6m);
  console.log(
    `  ${name.padEnd(26)}| ${String(s.n).padStart(4)} | ${s.wr.toFixed(1).padStart(4)}% | ${s.pf.toFixed(2).padStart(5)} | ` +
    `${(s.total.toFixed(0) + '%').padStart(8)} | ${(s.mdd.toFixed(0) + '%').padStart(5)} | ${(s.mdd > 0 ? s.total / s.mdd : 0).toFixed(2).padStart(8)} | ${(Number.isNaN(c) ? '-' : c.toFixed(2)).padStart(6)}`,
  );
}
