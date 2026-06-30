/**
 * R16 FUNDING_CARRY — delta-neutral funding harvest.
 *
 * 가정:
 *   - Binance BTCUSDT perp (SHORT) + Binance BTC spot (LONG) → delta neutral
 *   - 펀딩 양수일 때 SHORT가 funding 받음
 *   - 가격 변동 hedge → net price PnL ≈ 0 (basis 변동만 잔존)
 *
 * 룰:
 *   매 8h funding 이벤트 평가
 *     funding > entry_threshold: 포지션 진입 (없으면)
 *     funding < exit_threshold:  포지션 청산 (있으면)
 *   포지션 보유 동안 funding rate 누적 (받음)
 *
 * Cost: 진입 + 청산 = 왕복 0.2% (perp + spot 합)
 *
 * 검증:
 *   - 1년 (2025-06-09 ~ 2026-06-09) 월별
 *   - 5년 전체 (2019-09 ~ 2026-06)
 *   - cycle 수, cycle당 평균 funding 수익, total
 *   - entry/exit threshold sweep
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');

const COST_RT = 0.002; // 진입+청산 왕복 0.2% (perp+spot 합)

interface FundingPoint { ts: number; date: string; rate: number; }

function fmt(n: number, sign = true) { return `${sign && n >= 0 ? '+' : ''}${n.toFixed(3)}%`; }
function pad(s: string, w: number) { return s.length >= w ? s : s + ' '.repeat(w - s.length); }
function padS(s: string, w: number) { return s.length >= w ? s : ' '.repeat(w - s.length) + s; }

interface Cycle {
  entryTs: number; entryDate: string;
  exitTs: number; exitDate: string;
  fundingAccrued: number;  // 받은 funding 합 (%)
  durationHours: number;
  fundingEvents: number;
}

function runCarry(
  funding: FundingPoint[],
  entryThresh: number,   // funding > 이 값일 때 진입
  exitThresh: number,    // funding < 이 값일 때 청산
  startTs: number,
  endTs: number,
): { cycles: Cycle[]; totalFunding: number; totalCost: number; totalNet: number } {
  let position: { entryTs: number; entryDate: string; accrued: number; eventCount: number } | null = null;
  const cycles: Cycle[] = [];

  for (const f of funding) {
    if (f.ts < startTs || f.ts > endTs) continue;

    if (position) {
      // 보유 중: funding 받음 (rate 그대로 = positive number when rate > 0)
      position.accrued += f.rate;
      position.eventCount += 1;
      // 청산 조건
      if (f.rate < exitThresh) {
        cycles.push({
          entryTs: position.entryTs, entryDate: position.entryDate,
          exitTs: f.ts, exitDate: f.date,
          fundingAccrued: position.accrued,
          durationHours: (f.ts - position.entryTs) / 3600_000,
          fundingEvents: position.eventCount,
        });
        position = null;
      }
    } else {
      // 진입 조건
      if (f.rate > entryThresh) {
        position = { entryTs: f.ts, entryDate: f.date, accrued: 0, eventCount: 0 };
      }
    }
  }

  // 마지막에 보유 중이면 강제 청산
  if (position) {
    const last = funding[funding.length - 1];
    cycles.push({
      entryTs: position.entryTs, entryDate: position.entryDate,
      exitTs: last.ts, exitDate: last.date,
      fundingAccrued: position.accrued,
      durationHours: (last.ts - position.entryTs) / 3600_000,
      fundingEvents: position.eventCount,
    });
  }

  const totalFunding = cycles.reduce((s, c) => s + c.fundingAccrued, 0);
  const totalCost = cycles.length * COST_RT * 100;
  const totalNet = totalFunding - totalCost;
  return { cycles, totalFunding, totalCost, totalNet };
}

function monthList(start: string, end: string): string[] {
  const out: string[] = [];
  let y = parseInt(start.slice(0, 4));
  let m = parseInt(start.slice(5, 7));
  const endY = parseInt(end.slice(0, 4));
  const endM = parseInt(end.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${m.toString().padStart(2, '0')}`); m++;
    if (m > 12) { y++; m = 1; }
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const funding: FundingPoint[] = JSON.parse(
    fs.readFileSync(path.join(CACHE_DIR, 'BINANCE_BTCUSDT_funding.json'), 'utf-8'),
  ).sort((a: FundingPoint, b: FundingPoint) => a.ts - b.ts);
  console.log(`Funding events: ${funding.length} (${funding[0].date} ~ ${funding[funding.length - 1].date})`);

  // Funding distribution
  const allRates = funding.map((f) => f.rate);
  const sorted = [...allRates].sort((a, b) => a - b);
  const mean = allRates.reduce((s, v) => s + v, 0) / allRates.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const posCount = allRates.filter((r) => r > 0).length;
  const negCount = allRates.filter((r) => r < 0).length;
  console.log(`\nFunding rate distribution (per 8h event):`);
  console.log(`  mean=${fmt(mean)}, median=${fmt(median)}`);
  console.log(`  positive ${posCount}/${allRates.length} (${(posCount/allRates.length*100).toFixed(1)}%)`);
  console.log(`  negative ${negCount}/${allRates.length} (${(negCount/allRates.length*100).toFixed(1)}%)`);

  const L: string[] = [];
  L.push('='.repeat(140));
  L.push(`R16 FUNDING_CARRY — delta-neutral funding harvest`);
  L.push(`Rule: funding > entry_thresh → SHORT perp + LONG spot (hedged). funding 누적.`);
  L.push(`Cost ${(COST_RT*100).toFixed(1)}% round-trip per cycle (perp + spot 합).`);
  L.push('='.repeat(140));
  L.push(`\nFunding (per 8h event):`);
  L.push(`  total events: ${funding.length}`);
  L.push(`  mean=${fmt(mean)}, median=${fmt(median)}`);
  L.push(`  positive ${posCount}/${allRates.length} (${(posCount/allRates.length*100).toFixed(1)}%)`);

  // 1년
  const oneYearStart = new Date('2025-06-09T00:00:00Z').getTime();
  const oneYearEnd = new Date('2026-06-09T00:00:00Z').getTime();

  // Threshold sweep
  const thresholdConfigs = [
    { name: 'always_in (entry>any pos, exit<0)', entry: -Infinity, exit: 0 },
    { name: 'entry>0 / exit<0', entry: 0, exit: 0 },
    { name: 'entry>0.005 / exit<0', entry: 0.005, exit: 0 },
    { name: 'entry>0.01 / exit<0', entry: 0.01, exit: 0 },
    { name: 'entry>0.005 / exit<-0.005', entry: 0.005, exit: -0.005 },
    { name: 'entry>0.01 / exit<-0.01', entry: 0.01, exit: -0.01 },
  ];

  // ─── 1년 ───
  L.push(`\n## 1년 (2025-06-09 ~ 2026-06-09)\n`);
  L.push(`${pad('config', 38)} | ${padS('cycles', 6)} | ${padS('avgHours', 9)} | ${padS('totalFund', 9)} | ${padS('totalCost', 9)} | ${padS('NET', 8)}`);
  L.push('-'.repeat(95));
  for (const cfg of thresholdConfigs) {
    const r = runCarry(funding, cfg.entry, cfg.exit, oneYearStart, oneYearEnd);
    const avgH = r.cycles.length ? r.cycles.reduce((s, c) => s + c.durationHours, 0) / r.cycles.length : 0;
    L.push(`${pad(cfg.name, 38)} | ${padS(String(r.cycles.length), 6)} | ${padS(avgH.toFixed(1)+'h', 9)} | ${padS(fmt(r.totalFunding), 9)} | ${padS(fmt(-r.totalCost), 9)} | ${padS(fmt(r.totalNet), 8)}`);
  }

  // 1년 best config 월별
  let bestCfg = thresholdConfigs[0]; let bestNet = -Infinity;
  for (const cfg of thresholdConfigs) {
    const r = runCarry(funding, cfg.entry, cfg.exit, oneYearStart, oneYearEnd);
    if (r.totalNet > bestNet) { bestNet = r.totalNet; bestCfg = cfg; }
  }

  L.push(`\n### 1년 월별 (best config: ${bestCfg.name})\n`);
  L.push(`${pad('month', 8)} | ${padS('cycles', 6)} | ${padS('fundEvents', 11)} | ${padS('fundAccrued', 11)} | ${padS('cost', 7)} | ${padS('mNet', 7)} | ${padS('cumNet', 7)}`);
  L.push('-'.repeat(80));
  const bestRes = runCarry(funding, bestCfg.entry, bestCfg.exit, oneYearStart, oneYearEnd);
  // 월별 분배: cycle exit 기준
  const byMonth = new Map<string, { cycles: number; fundEvents: number; funding: number; cost: number }>();
  for (const c of bestRes.cycles) {
    const mk = c.exitDate.slice(0, 7);
    if (!byMonth.has(mk)) byMonth.set(mk, { cycles: 0, fundEvents: 0, funding: 0, cost: 0 });
    const m = byMonth.get(mk)!;
    m.cycles += 1;
    m.fundEvents += c.fundingEvents;
    m.funding += c.fundingAccrued;
    m.cost += COST_RT * 100;
  }
  let cum = 0;
  for (const mk of monthList('2025-06', '2026-06')) {
    const m = byMonth.get(mk);
    if (!m) {
      L.push(`${pad(mk, 8)} | ${padS('-', 6)} | ${padS('-', 11)} | ${padS('-', 11)} | ${padS('-', 7)} | ${padS(fmt(0), 7)} | ${padS(fmt(cum), 7)}`);
      continue;
    }
    const net = m.funding - m.cost;
    cum += net;
    L.push(`${pad(mk, 8)} | ${padS(String(m.cycles), 6)} | ${padS(String(m.fundEvents), 11)} | ${padS(fmt(m.funding), 11)} | ${padS(fmt(-m.cost), 7)} | ${padS(fmt(net), 7)} | ${padS(fmt(cum), 7)}`);
  }

  // ─── 5년 ───
  const fiveYearStart = new Date('2020-01-01T00:00:00Z').getTime();
  const fiveYearEnd = new Date('2026-06-09T00:00:00Z').getTime();
  L.push(`\n\n## 5년+ (2020-01 ~ 2026-06)\n`);
  L.push(`${pad('config', 38)} | ${padS('cycles', 6)} | ${padS('avgHours', 9)} | ${padS('totalFund', 9)} | ${padS('totalCost', 9)} | ${padS('NET', 8)} | ${padS('annualized', 11)}`);
  L.push('-'.repeat(110));
  const totalYears = (fiveYearEnd - fiveYearStart) / (365 * 86400_000);
  for (const cfg of thresholdConfigs) {
    const r = runCarry(funding, cfg.entry, cfg.exit, fiveYearStart, fiveYearEnd);
    const avgH = r.cycles.length ? r.cycles.reduce((s, c) => s + c.durationHours, 0) / r.cycles.length : 0;
    const annualized = r.totalNet / totalYears;
    L.push(`${pad(cfg.name, 38)} | ${padS(String(r.cycles.length), 6)} | ${padS(avgH.toFixed(1)+'h', 9)} | ${padS(fmt(r.totalFunding), 9)} | ${padS(fmt(-r.totalCost), 9)} | ${padS(fmt(r.totalNet), 8)} | ${padS(fmt(annualized) + '/y', 11)}`);
  }

  // ─── 연도별 ───
  L.push(`\n### 연도별 NET (best config: ${bestCfg.name})\n`);
  L.push(`${pad('year', 6)} | ${padS('cycles', 6)} | ${padS('funding', 9)} | ${padS('cost', 7)} | ${padS('NET', 8)}`);
  L.push('-'.repeat(55));
  for (const year of [2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    const startTs = new Date(`${year}-01-01T00:00:00Z`).getTime();
    const endTs = new Date(`${year + 1}-01-01T00:00:00Z`).getTime();
    const r = runCarry(funding, bestCfg.entry, bestCfg.exit, startTs, endTs);
    L.push(`${pad(String(year), 6)} | ${padS(String(r.cycles.length), 6)} | ${padS(fmt(r.totalFunding), 9)} | ${padS(fmt(-r.totalCost), 7)} | ${padS(fmt(r.totalNet), 8)}`);
  }

  console.log(L.join('\n'));
  const outFile = path.join(OUT_DIR, `${stamp}_R16_FUNDING_CARRY.txt`);
  fs.writeFileSync(outFile, L.join('\n'));
  console.log(`\nSaved: ${outFile}`);
  process.exit(0);
})();
