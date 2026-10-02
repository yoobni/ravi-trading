/**
 * 마이크로구조 알파 스캔 (2026-10-02) — data/microstructure 1분 호가·체결 스냅샷 전담 분석.
 *
 * 실행: npx tsx scripts/_an_micro.ts [pred|exec|jump|f6|all]
 *   pred — 특성(takerImb·호가불균형·대형체결·스프레드·누적흐름)이 향후 5/15/60/240분 mid 수익을 예측하나
 *   exec — 코인별 스프레드·호가깊이 → 330만/3300만원 시장가 충격, 지정가 체결 대리지표
 *   jump — 1분 mid 점프 분포 + 실시간 감시 손절의 관통(overshoot) 시뮬
 *   f6   — F6 신호 시점(15m 캐시로 4h 합성)의 마이크로구조가 승패를 가르나 (표본 작음)
 *
 * 주의: 호가는 15단계까지만 수집돼 넓은 밴드(0.5/1.0%)는 포화된다(유동성 큰 코인일수록).
 *       truncated=true 행의 체결 지표(buyKrw/sellKrw/takerImb/maxKrw)는 버린다.
 *       맥 수면 결손이 있으므로 미래 수익은 해당 시각±2분에 실제 행이 있을 때만 쓴다.
 * 읽기 전용. API 호출 없음.
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const DIR = path.resolve(process.cwd(), 'data', 'microstructure');
const MIN = 60_000;

interface Row {
  t: number;          // 분 단위 정수 (floor(ts/60s))
  mid: number; sp: number;
  bid: number[]; ask: number[]; imb: number[];
  totBid: number; totAsk: number;
  buy: number; sell: number; n: number; maxK: number; tImb: number; trunc: boolean;
}

async function load(): Promise<Map<string, Row[]>> {
  const files = fs.readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  const by = new Map<string, Map<number, Row>>();
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(path.join(DIR, f)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      if (!o.mid) continue;
      const t = Math.floor(o.ts / MIN);
      if (!by.has(o.m)) by.set(o.m, new Map());
      by.get(o.m)!.set(t, { t, mid: o.mid, sp: o.spreadBps, bid: o.bid, ask: o.ask, imb: o.imb, totBid: o.totBid, totAsk: o.totAsk,
        buy: o.buyKrw, sell: o.sellKrw, n: o.nTrades, maxK: o.maxKrw, tImb: o.takerImb, trunc: !!o.truncated });
    }
  }
  const out = new Map<string, Row[]>();
  for (const [m, mp] of by) out.set(m, [...mp.values()].sort((a, b) => a.t - b.t));
  return out;
}

const q = (xs: number[], p: number) => { if (!xs.length) return NaN; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const maxOf = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
function rank(xs: number[]): number[] {
  const idx = xs.map((x, i) => [x, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const v = (i + j) / 2; for (let k = i; k <= j; k++) r[idx[k][1]] = v; i = j + 1; }
  return r;
}
const pearson = (a: number[], b: number[]) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb || 1); };
const spearman = (a: number[], b: number[]) => pearson(rank(a), rank(b));
const bps = (x: number) => (x >= 0 ? '+' : '') + (x * 1e4).toFixed(1);

/** 미래 mid: t+h 분(±2분 허용)의 행 */
function fwdIndex(rows: Row[], i: number, h: number): number {
  const target = rows[i].t + h;
  let lo = i, hi = rows.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t < target) lo = mid + 1; else hi = mid; }
  for (const k of [lo, lo - 1]) if (k > i && k < rows.length && Math.abs(rows[k].t - target) <= 2) return k;
  return -1;
}

// ───────────────────────── pred ─────────────────────────
function pred(data: Map<string, Row[]>) {
  console.log('\n═══ ① 예측력: 특성 → 향후 mid 수익 ═══');
  const H = [5, 15, 60, 240];
  type Feat = { name: string; f: (rows: Row[], i: number) => number | null };
  const flowN = (rows: Row[], i: number, n: number) => {
    // 직전 n분 누적 체결 불균형 (연속 행·비절단만)
    let b = 0, s = 0;
    for (let k = i; k > i - n; k--) { if (k < 0 || rows[k].trunc || rows[i].t - rows[k].t >= n) return null; b += rows[k].buy; s += rows[k].sell; }
    return b + s > 0 ? (b - s) / (b + s) : null;
  };
  const FEATS: Feat[] = [
    { name: 'takerImb 1분', f: (r, i) => (r[i].trunc || r[i].buy + r[i].sell <= 0 ? null : r[i].tImb) },
    { name: '체결흐름 5분', f: (r, i) => flowN(r, i, 5) },
    { name: '체결흐름 15분', f: (r, i) => flowN(r, i, 15) },
    { name: '호가불균형 0.1%', f: (r, i) => r[i].imb?.[0] ?? null },
    { name: '호가불균형 0.3%', f: (r, i) => r[i].imb?.[1] ?? null },
    { name: '호가불균형 전체', f: (r, i) => (r[i].totBid + r[i].totAsk > 0 ? (r[i].totBid - r[i].totAsk) / (r[i].totBid + r[i].totAsk) : null) },
    { name: '대형체결(log max)', f: (r, i) => (r[i].trunc || !r[i].maxK ? null : Math.log(r[i].maxK)) },
    { name: '체결대금(log)', f: (r, i) => (r[i].trunc || r[i].buy + r[i].sell <= 0 ? null : Math.log(r[i].buy + r[i].sell)) },
    { name: '스프레드(bps)', f: (r, i) => r[i].sp },
    { name: '직전15분 수익(대조)', f: (r, i) => { const k = i - 15; return k >= 0 && r[i].t - r[k].t === 15 ? r[i].mid / r[k].mid - 1 : null; } },
  ];
  const allT = [...data.values()].flatMap((r) => r.map((x) => x.t));
  const tSplit = q(allT, 0.5);
  console.log(`  표본: ${data.size}코인, ${allT.length.toLocaleString()}행, 반분 경계 ${new Date(tSplit * MIN + 9 * 3600e3).toISOString().slice(0, 16)} KST`);
  console.log('  지표: 코인별 Spearman 평균(IC) · 코인 내 z 표준화 5분위 평균 미래수익(bps, Q1→Q5) · Q5−Q1 · 비중첩 표본 t');
  console.log('  비용 기준: 왕복 수수료 10bps + 스프레드 절반×2 (코인 중앙값) ≈ 아래 "비용" 열\n');

  const medSp = mean([...data.values()].map((r) => q(r.map((x) => x.sp), 0.5)));
  const cost = 10 + medSp; // 왕복: 수수료 0.05%×2 + 진입·청산 각 스프레드 절반
  for (const ft of FEATS) {
    console.log(`  ▸ ${ft.name}`);
    for (const h of H) {
      const row: string[] = [];
      for (const half of ['전반', '후반', '전체'] as const) {
        const ics: number[] = [];
        const pool: Array<[number, number]> = [];
        const nonOv: Array<[number, number]> = [];
        for (const [, rows] of data) {
          const xs: number[] = [], ys: number[] = [], ts: number[] = [];
          for (let i = 0; i < rows.length; i++) {
            if (half === '전반' && rows[i].t >= tSplit) continue;
            if (half === '후반' && rows[i].t < tSplit) continue;
            const x = ft.f(rows, i); if (x == null || !Number.isFinite(x)) continue;
            const j = fwdIndex(rows, i, h); if (j < 0) continue;
            xs.push(x); ys.push(rows[j].mid / rows[i].mid - 1); ts.push(rows[i].t);
          }
          if (xs.length < 200) continue;
          ics.push(spearman(xs, ys));
          const m = mean(xs), s = sd(xs) || 1;
          let lastT = -1e18;
          for (let k = 0; k < xs.length; k++) {
            pool.push([(xs[k] - m) / s, ys[k]]);
            if (ts[k] - lastT >= h) { nonOv.push([(xs[k] - m) / s, ys[k]]); lastT = ts[k]; }
          }
        }
        if (!pool.length) { row.push(`${half} n/a`); continue; }
        pool.sort((a, b) => a[0] - b[0]);
        const qs = [0, 1, 2, 3, 4].map((k) => mean(pool.slice(Math.floor(k * pool.length / 5), Math.floor((k + 1) * pool.length / 5)).map((p) => p[1])));
        nonOv.sort((a, b) => a[0] - b[0]);
        const lo = nonOv.slice(0, Math.floor(nonOv.length / 5)).map((p) => p[1]);
        const hi = nonOv.slice(Math.floor(4 * nonOv.length / 5)).map((p) => p[1]);
        const tstat = (mean(hi) - mean(lo)) / Math.sqrt(sd(hi) ** 2 / Math.max(hi.length, 1) + sd(lo) ** 2 / Math.max(lo.length, 1));
        if (half === '전체') row.push(`전체 IC ${mean(ics).toFixed(3)} Q ${qs.map(bps).join('/')} Q5−Q1 ${bps(qs[4] - qs[0])} t ${tstat.toFixed(1)}`);
        else row.push(`${half} IC ${mean(ics).toFixed(3)} Q5−Q1 ${bps(qs[4] - qs[0])}`);
      }
      console.log(`     ${String(h).padStart(3)}분 | ${row.join(' | ')}`);
    }
  }
  console.log(`\n  비용(왕복) ≈ ${cost.toFixed(1)}bps (수수료 10 + 코인 중앙 스프레드 평균 ${medSp.toFixed(1)})`);

  // 극단 꼬리: 상·하위 1% 에서만 쓰는 경우 (트레이딩은 꼬리에서만 한다)
  console.log('\n  ▸ 꼬리 검사 — 코인 내 상위/하위 1% 특성값일 때 평균 미래수익(bps, 전반/후반)');
  for (const ft of FEATS.filter((f) => /takerImb|흐름|0\.1%|대형/.test(f.name))) {
    const parts: string[] = [];
    for (const h of [15, 60, 240]) {
      const res: string[] = [];
      for (const half of ['전반', '후반']) {
        const top: number[] = [], bot: number[] = [];
        for (const [, rows] of data) {
          const xs: Array<[number, number]> = [];
          for (let i = 0; i < rows.length; i++) {
            if ((half === '전반') !== (rows[i].t < tSplit)) continue;
            const x = ft.f(rows, i); if (x == null || !Number.isFinite(x)) continue;
            const j = fwdIndex(rows, i, h); if (j < 0) continue;
            xs.push([x, rows[j].mid / rows[i].mid - 1]);
          }
          if (xs.length < 500) continue;
          xs.sort((a, b) => a[0] - b[0]);
          const k = Math.floor(xs.length * 0.01);
          bot.push(...xs.slice(0, k).map((p) => p[1])); top.push(...xs.slice(-k).map((p) => p[1]));
        }
        res.push(`${half} 상${bps(mean(top))}/하${bps(mean(bot))}`);
      }
      parts.push(`${h}분 ${res.join(' ')}`);
    }
    console.log(`     ${ft.name.padEnd(16)} ${parts.join(' | ')}`);
  }
}

// ───────────────────────── exec ─────────────────────────
function exec(data: Map<string, Row[]>) {
  console.log('\n═══ ③ 실행 품질: 스프레드·깊이·시장가 충격 ═══');
  console.log('  깊이 = mid±밴드 안 누적 원화(15호가 한도). 충격 = 주문액을 다 채우는 데 필요한 최소 밴드(그 밴드 안이면 평균 충격은 그 이하)');
  console.log('  코인        스프레드 p50/p90 | 매수깊이0.1% p50 | 0.3% p50 | 15호가 전체 p50 | 330만 ≤0.1% | 3300만 ≤0.1% / ≤0.3% / ≤1.0% / 15호가 초과');
  const rowsOut: Array<{ m: string; sp: number; line: string }> = [];
  for (const [m, rows] of data) {
    const sp = rows.map((r) => r.sp);
    const a1 = rows.map((r) => r.ask?.[0] ?? 0), a3 = rows.map((r) => r.ask?.[1] ?? 0), tot = rows.map((r) => r.totAsk);
    const fit = (amt: number, band: number) => 100 * rows.filter((r) => (r.ask?.[band] ?? 0) >= amt).length / rows.length;
    const over = 100 * rows.filter((r) => r.totAsk < 33e6).length / rows.length;
    rowsOut.push({ m, sp: q(sp, 0.5), line: `  ${m.replace('KRW-', '').padEnd(6)} ${q(sp, 0.5).toFixed(1).padStart(6)}/${q(sp, 0.9).toFixed(1).padStart(5)}bps | ${(q(a1, 0.5) / 1e6).toFixed(0).padStart(7)}백만 | ${(q(a3, 0.5) / 1e6).toFixed(0).padStart(6)}백만 | ${(q(tot, 0.5) / 1e6).toFixed(0).padStart(7)}백만 | ${fit(3.3e6, 0).toFixed(0).padStart(5)}% | ${fit(33e6, 0).toFixed(0).padStart(5)}% / ${fit(33e6, 1).toFixed(0).padStart(3)}% / ${fit(33e6, 3).toFixed(0).padStart(3)}% / ${over.toFixed(0).padStart(3)}%` });
  }
  rowsOut.sort((a, b) => a.sp - b.sp).forEach((r) => console.log(r.line));

  console.log('\n  지정가 체결 대리지표 — 매수 지정가가 best bid 근처에 걸렸을 때, 그 앞 대기열(0.1% 밴드 매수잔량)을');
  console.log('  매도 공격 체결이 소진하는 데 걸리는 시간(분) = (0이 아닌 가장 좁은 밴드 매수잔량) / (분당 매도공격액 평균). 짧을수록 지정가가 잘 체결된다.');
  const lines: Array<[number, string]> = [];
  for (const [m, rows] of data) {
    const ok = rows.filter((r) => !r.trunc);
    const sellPerMin = mean(ok.map((r) => r.sell));
    const buyPerMin = mean(ok.map((r) => r.buy));
    const firstBand = (r: Row) => (r.bid || []).find((v) => v > 0) ?? r.totBid;
    const ttl = rows.map((r) => firstBand(r) / Math.max(sellPerMin, 1));
    lines.push([q(ttl, 0.5), `  ${m.replace('KRW-', '').padEnd(6)} 분당 매도공격 ${(sellPerMin / 1e6).toFixed(1).padStart(6)}백만 · 매수공격 ${(buyPerMin / 1e6).toFixed(1).padStart(6)}백만 · 대기열 소진 p50 ${q(ttl, 0.5).toFixed(1).padStart(6)}분 p90 ${q(ttl, 0.9).toFixed(1).padStart(6)}분 · 절단율 ${(100 * (1 - ok.length / rows.length)).toFixed(1)}%`]);
  }
  lines.sort((a, b) => a[0] - b[0]).forEach((l) => console.log(l[1]));
}

// ───────────────────────── jump ─────────────────────────
function jump(data: Map<string, Row[]>) {
  console.log('\n═══ ④ 1분 mid 점프 분포 (연속 분만) ═══');
  const all: number[] = [];
  const perCoin: Array<[string, number[]]> = [];
  for (const [m, rows] of data) {
    const d: number[] = [];
    for (let i = 1; i < rows.length; i++) if (rows[i].t - rows[i - 1].t === 1) d.push(rows[i].mid / rows[i - 1].mid - 1);
    all.push(...d); perCoin.push([m, d]);
  }
  const down = all.filter((x) => x < 0).map((x) => -x);
  const P = (x: number) => (x * 100).toFixed(3) + '%';
  console.log(`  전체 ${all.length.toLocaleString()}개 1분 변화 | |Δ| p50 ${P(q(all.map(Math.abs), 0.5))} p90 ${P(q(all.map(Math.abs), 0.9))} p99 ${P(q(all.map(Math.abs), 0.99))} p99.9 ${P(q(all.map(Math.abs), 0.999))} max ${P(maxOf(all.map(Math.abs)))}`);
  console.log(`  하락만 ${down.length.toLocaleString()}개 | p50 ${P(q(down, 0.5))} p90 ${P(q(down, 0.9))} p99 ${P(q(down, 0.99))} p99.9 ${P(q(down, 0.999))} max ${P(maxOf(down))}`);
  console.log('  코인별 하락 1분 p99 / p99.9 (높은 순 상위·하위 5):');
  const pc = perCoin.map(([m, d]) => { const dn = d.filter((x) => x < 0).map((x) => -x); return [m, q(dn, 0.99), q(dn, 0.999)] as [string, number, number]; }).sort((a, b) => b[1] - a[1]);
  for (const [m, a, b] of [...pc.slice(0, 5), ...pc.slice(-5)]) console.log(`     ${m.replace('KRW-', '').padEnd(6)} p99 ${P(a)} p99.9 ${P(b)}`);

  console.log('\n  ▸ 실시간 감시 손절 시뮬 — 매 60분마다 각 코인에 가상 진입(mid), 스톱 = 진입×(1−s).');
  console.log('    1분 스냅샷으로 감시하다 처음 mid ≤ 스톱인 분에 매도 → 관통 = (스톱 − 그 분 mid)/스톱. 체결은 bid 이므로 스프레드 절반을 더한 값도 표시.');
  console.log('    (웹소켓은 틱 단위라 1분 스냅샷보다 빨리 반응한다 → 아래 수치는 상한 쪽 추정. 3일 내 미도달은 제외)');
  for (const s of [0.02, 0.03, 0.05, 0.08]) {
    const ov: number[] = [], ovS: number[] = [];
    for (const [, rows] of data) {
      for (let i = 0; i < rows.length; i += 60) {
        const stop = rows[i].mid * (1 - s);
        for (let k = i + 1; k < rows.length && rows[k].t - rows[i].t <= 3 * 1440; k++) {
          if (rows[k].t - rows[k - 1].t > 3) break; // 결손 구간을 건너뛰면 관통이 부풀려진다 → 그 경로는 버림
          if (rows[k].mid <= stop) { const o = (stop - rows[k].mid) / stop; ov.push(o); ovS.push(o + rows[k].sp / 2 / 1e4); break; }
        }
      }
    }
    console.log(`    스톱 −${(s * 100).toFixed(0)}%: 발동 ${String(ov.length).padStart(5)}건 | 관통 평균 ${P(mean(ov))} p50 ${P(q(ov, 0.5))} p90 ${P(q(ov, 0.9))} p99 ${P(q(ov, 0.99))} max ${P(maxOf(ov))} | +스프레드½ 평균 ${P(mean(ovS))} p90 ${P(q(ovS, 0.9))}`);
  }
  console.log('    대조: 4h 봉마감 폴링이면 스톱 발동 후 봉 종가까지 기다린다 — 같은 경로로 "발동 후 다음 4h 경계(UTC) 시점 mid" 와의 차이:');
  for (const s of [0.02, 0.05]) {
    const gap: number[] = [];
    for (const [, rows] of data) {
      for (let i = 0; i < rows.length; i += 60) {
        const stop = rows[i].mid * (1 - s);
        for (let k = i + 1; k < rows.length && rows[k].t - rows[i].t <= 3 * 1440; k++) {
          if (rows[k].t - rows[k - 1].t > 3) break;
          if (rows[k].mid <= stop) {
            const close = (Math.floor(rows[k].t / 240) + 1) * 240;
            const j = fwdIndex(rows, k, close - rows[k].t);
            if (j > 0) gap.push((stop - rows[j].mid) / stop);
            break;
          }
        }
      }
    }
    console.log(`    스톱 −${(s * 100).toFixed(0)}% 봉마감 체결: ${gap.length}건 | 스톱 대비 평균 ${P(mean(gap))} p50 ${P(q(gap, 0.5))} p90 ${P(q(gap, 0.9))} (양수 = 스톱보다 낮게 팔림)`);
  }
}

// ───────────────────────── f6 ─────────────────────────
function f6(data: Map<string, Row[]>) {
  console.log('\n═══ ② F6 신호 시점 마이크로구조 (표본 작음 — 참고용) ═══');
  const CC = path.resolve(process.cwd(), 'data', 'candle-cache');
  const files = fs.readdirSync(CC).filter((f) => /_15m_/.test(f));
  interface B { ts: number; open: number; high: number; low: number; close: number; volume: number }
  const four = 4 * 3600e3;
  const sigs: Array<{ m: string; entryTs: number; r3: number; hit6: boolean; mae: number; feat: Record<string, number> }> = [];
  for (const f of files) {
    const m = f.split('_')[0];
    const rows = data.get(m); if (!rows) continue;
    const b15 = JSON.parse(fs.readFileSync(path.join(CC, f), 'utf8')) as B[];
    const map = new Map<number, B>();
    for (const x of b15) {
      const k = Math.floor(x.ts / four) * four;
      const c = map.get(k);
      if (!c) map.set(k, { ts: k, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume });
      else { c.high = Math.max(c.high, x.high); c.low = Math.min(c.low, x.low); c.close = x.close; c.volume += x.volume; }
    }
    const b = [...map.values()].sort((a, z) => a.ts - z.ts).filter((x, i, arr) => i < arr.length - 1); // 마지막(미완성) 버림
    const volZ = (i: number, w = 30) => { if (i < w) return 0; let s = 0, s2 = 0; for (let j = i - w; j < i; j++) { s += b[j].volume; s2 += b[j].volume ** 2; } const mn = s / w, sdv = Math.sqrt(Math.max(s2 / w - mn * mn, 1e-12)); return sdv > 0 ? (b[i].volume - mn) / sdv : 0; };
    const hiOf = (fr: number, to: number) => { let mx = -Infinity; for (let j = fr; j < to; j++) mx = Math.max(mx, b[j].high); return mx; };
    const first = rows[0].t * MIN;
    for (let i = 45; i < b.length - 1; i++) {
      if (b[i].ts + four < first + 60 * MIN) continue;
      const ok = b[i - 1].high > hiOf(i - 42, i - 1) && b[i].close > b[i].open && b[i].close > b[i - 1].high && volZ(i) >= 0.5;
      if (!ok) continue;
      const entryTs = b[i + 1].ts; const ep = b[i + 1].open;
      const end = Math.min(i + 18, b.length - 1);
      let hit6 = false, mae = 0;
      for (let k = i + 1; k <= end; k++) { if (b[k].high >= ep * 1.06) { hit6 = true; break; } mae = Math.min(mae, b[k].low / ep - 1); }
      const r3 = b[end].close / ep - 1;
      // 신호봉 마감 직전 60분 마이크로구조
      const t0 = entryTs / MIN;
      const win = rows.filter((r) => r.t >= t0 - 60 && r.t < t0);
      if (win.length < 40) continue;
      const ok2 = win.filter((r) => !r.trunc);
      const bsum = ok2.reduce((a, r) => a + r.buy, 0), ssum = ok2.reduce((a, r) => a + r.sell, 0);
      const base = rows.filter((r) => r.t >= t0 - 1440 && r.t < t0 - 60 && !r.trunc);
      const baseFlow = mean(base.map((r) => r.buy + r.sell));
      sigs.push({ m, entryTs, r3, hit6, mae, feat: {
        '체결흐름60분': bsum + ssum > 0 ? (bsum - ssum) / (bsum + ssum) : 0,
        '호가불균형0.1%': mean(win.map((r) => r.imb?.[0] ?? 0)),
        '체결대금 배수(60분/24h평균)': baseFlow > 0 ? mean(ok2.map((r) => r.buy + r.sell)) / baseFlow : 1,
        '스프레드': mean(win.map((r) => r.sp)),
        '대형체결 최대(log)': Math.log(Math.max(1, ...ok2.map((r) => r.maxK))),
      } });
    }
  }
  console.log(`  15m 캐시 코인 ${files.length}개, 마이크로구조 구간 내 F6 신호 ${sigs.length}건 (완결 3일 아닌 최근 신호는 남은 봉까지로 r3 계산)`);
  if (sigs.length < 10) { console.log('  표본 부족 — 판정 불가'); return; }
  console.log(`  전체: 3일 수익 평균 ${(mean(sigs.map((s) => s.r3)) * 100).toFixed(2)}%, +6% 도달 ${(100 * sigs.filter((s) => s.hit6).length / sigs.length).toFixed(0)}%`);
  for (const k of Object.keys(sigs[0].feat)) {
    const so = sigs.slice().sort((a, b) => a.feat[k] - b.feat[k]);
    const h = Math.floor(so.length / 2);
    const lo = so.slice(0, h), hi = so.slice(h);
    console.log(`  ${k.padEnd(22)} 하위절반 r3 ${(mean(lo.map((s) => s.r3)) * 100).toFixed(2).padStart(6)}% (+6%도달 ${(100 * lo.filter((s) => s.hit6).length / lo.length).toFixed(0)}%) | 상위절반 r3 ${(mean(hi.map((s) => s.r3)) * 100).toFixed(2).padStart(6)}% (+6%도달 ${(100 * hi.filter((s) => s.hit6).length / hi.length).toFixed(0)}%) | Spearman ${spearman(sigs.map((s) => s.feat[k]), sigs.map((s) => s.r3)).toFixed(2)}`);
  }
}

(async () => {
  const mode = process.argv[2] || 'all';
  const t0 = Date.now();
  const data = await load();
  console.log(`로드 ${data.size}코인 · ${[...data.values()].reduce((a, r) => a + r.length, 0).toLocaleString()}행 · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (mode === 'pred' || mode === 'all') pred(data);
  if (mode === 'exec' || mode === 'all') exec(data);
  if (mode === 'jump' || mode === 'all') jump(data);
  if (mode === 'f6' || mode === 'all') f6(data);
  process.exit(0);
})();
