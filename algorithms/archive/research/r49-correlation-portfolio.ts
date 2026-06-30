/**
 * R49 — F1F2(일봉 펀딩 역추세) ↔ F6 계열(4h 모멘텀) 상관 + 합성 포트폴리오.
 *
 * 질문: 두 알파가 성격이 다르면 상관이 낮아, 합치면 equity curve가 더 매끄럽고 MDD가 줄어드는가?
 *   - regime 타이밍(R46 실패)보다 분산이 진짜 리스크 감소책인지 검증.
 *
 * F1F2: Binance BTCUSDT 펀딩(4년, 페이지네이션) + Upbit BTC 4h→일봉 집계, evalF1F2 룰 재사용.
 * F6_v2/F6_v3: 기존 캔들 백테스트, 일별 mark-to-market.
 * 월별 수익률 상관(Pearson) + 50/50 합성(각 자본 절반, 무리밸런스) total/MDD 비교.
 */
import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import type { CachedBar } from '../_candle-cache';
import { aggregateDaily, evalF1F2, type FundingFetchPoint } from '@/lib/paper-funding-strategy';

const CACHE_DIR = path.resolve(process.cwd(), 'data', 'candle-cache');
const OUT_DIR = path.resolve(process.cwd(), 'data', 'research');
const INITIAL = 10_000_000, COST_RT = 0.001, LOOKBACK = 42;
const COINS = ['BTC','ETH','SOL','XRP','ADA','DOGE','AVAX','LINK','DOT','BCH','POL','NEAR','ATOM','TRX','ALGO'];
const thresholds = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/paper-trading/train-thresholds.json'), 'utf-8'));

function loadBars(coin: string): CachedBar[] {
  const fp = path.join(CACHE_DIR, `KRW-${coin}_240m_2022-06-10_2026-06-10.json`);
  if (!fs.existsSync(fp)) return [];
  return (JSON.parse(fs.readFileSync(fp, 'utf-8')) as CachedBar[]).sort((a, b) => a.ts - b.ts);
}
function kstDate(ts: number) { return new Date(ts + 9*3600_000).toISOString().slice(0, 10); }
function ym(d: string) { return d.slice(0, 7); }

async function fetchFundingHistory(startMs: number): Promise<FundingFetchPoint[]> {
  const out: FundingFetchPoint[] = []; let cursor = startMs;
  for (let call = 0; call < 30; call++) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=${cursor}&limit=1000`;
    const { data } = await axios.get<Array<{ fundingTime: number; fundingRate: string }>>(url, { timeout: 15000 });
    if (!data.length) break;
    for (const d of data) out.push({ ts: d.fundingTime, date: kstDate(d.fundingTime), rate: parseFloat(d.fundingRate) * 100 });
    if (data.length < 1000) break;
    cursor = data[data.length - 1].fundingTime + 1;
  }
  return out;
}

// ─── 4h → KST 일봉 집계 ───
interface DayBar { date: string; open: number; high: number; low: number; close: number; }
function toDaily(bars: CachedBar[]): DayBar[] {
  const byDate = new Map<string, CachedBar[]>();
  for (const b of bars) { const d = kstDate(b.ts); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d)!.push(b); }
  const out: DayBar[] = [];
  for (const [date, bs] of [...byDate.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    bs.sort((a, b) => a.ts - b.ts);
    out.push({ date, open: bs[0].open, high: Math.max(...bs.map(x=>x.high)), low: Math.min(...bs.map(x=>x.low)), close: bs[bs.length-1].close });
  }
  return out;
}

// ─── F1F2 일봉 시뮬 → date별 equity ───
function simF1F2(daily: DayBar[], dailyMap: ReturnType<typeof aggregateDaily>): Map<string, number> {
  const TP = 8, SL = -5, MAXD = 10, FEE = 0.0005, SLIP = 0.0005, SIZE = 0.5;
  let cash = INITIAL; let pos: { entryDate: string; entryPrice: number; vol: number; buyAmt: number } | null = null;
  const eqByDate = new Map<string, number>();
  const barByDate = new Map(daily.map(b => [b.date, b]));
  const daysBetween = (a: string, b: string) => Math.round((new Date(a+'T00:00:00Z').getTime() - new Date(b+'T00:00:00Z').getTime())/86400_000);
  for (let k = 0; k < daily.length; k++) {
    const D = daily[k].date; const yest = daily[k-1]?.date;
    // settle on yesterday bar
    if (pos && yest) {
      const yb = barByDate.get(yest)!;
      if (pos.entryDate <= yest && pos.entryDate !== D) {
        const tp = pos.entryPrice*(1+TP/100), sl = pos.entryPrice*(1+SL/100);
        const held = daysBetween(yest, pos.entryDate);
        let xp = 0, hit = false;
        if (yb.low <= sl) { xp = sl*(1-SLIP); hit = true; } else if (yb.high >= tp) { xp = tp*(1-SLIP); hit = true; } else if (held >= MAXD) { xp = yb.close*(1-SLIP); hit = true; }
        if (hit) { cash += pos.vol*xp*(1-FEE); pos = null; }
      }
    }
    // entry on D open
    const sig = evalF1F2({ evalDate: yest ?? D, dailyMap, thresholds });
    if (sig.label && !pos) {
      const ep = daily[k].open*(1+SLIP); const buyAmt = cash*SIZE*0.995; const fee = buyAmt*FEE;
      if (buyAmt >= 5000 && buyAmt+fee <= cash) { const vol = buyAmt/ep; cash -= buyAmt+fee; pos = { entryDate: D, entryPrice: ep, vol, buyAmt }; }
    }
    eqByDate.set(D, cash + (pos ? pos.vol*daily[k].close : 0));
  }
  return eqByDate;
}

// ─── F6 계열 4h 시뮬 → date별 equity (일말 mark) ───
function calcVolZ(v: number[], i: number, w = 30): number | null {
  if (i < w) return null; let s=0,s2=0; for (let j=i-w;j<i;j++){s+=v[j];s2+=v[j]*v[j];} const m=s/w,sd=Math.sqrt(Math.max(s2/w-m*m,1e-12)); return sd>0?(v[i]-m)/sd:null;
}
interface Sig { coin: string; barIdx: number; ts: number; }
function sigF6v2(bars: CachedBar[], coin: string): Sig[] { const vol=bars.map(b=>b.volume); const o: Sig[]=[];
  for (let i=LOOKBACK+1;i<bars.length;i++){ let mx=-Infinity; for(let j=i-LOOKBACK;j<i-1;j++) if(bars[j].high>mx)mx=bars[j].high;
    if(!(bars[i-1].high>mx))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; o.push({coin,barIdx:i,ts:bars[i].ts}); } return o; }
function sigF6v3(bars: CachedBar[], coin: string): Sig[] { const vol=bars.map(b=>b.volume); const o: Sig[]=[];
  for (let L=LOOKBACK+3;L<bars.length;L++){ const i=L-1; let mx=-Infinity; for(let j=i-LOOKBACK;j<i-1;j++) if(bars[j].high>mx)mx=bars[j].high;
    if(!(bars[i-1].high>mx))continue; if(!(bars[i].close>bars[i].open))continue; if(!(bars[i].close>bars[i-1].high))continue;
    const z=calcVolZ(vol,i,30); if(z==null||z<0.5)continue; if(!(bars[L].close>bars[i].high))continue; if(!(bars[L].close>bars[L].open))continue;
    o.push({coin,barIdx:L,ts:bars[L].ts}); } return o; }

function simF6(sigGen: (b: CachedBar[], c: string)=>Sig[], tp: number, sl: number, pos: number, maxC: number, barsByCoin: Map<string,CachedBar[]>, idxByCoinTs: Map<string,Map<number,number>>): Map<string, number> {
  const MAX_BARS = 84; const sigs: Sig[] = [];
  for (const c of barsByCoin.keys()) for (const s of sigGen(barsByCoin.get(c)!, c)) sigs.push(s);
  const sigByTs = new Map<number, Sig[]>(); for (const s of sigs.sort((a,b)=>a.ts-b.ts)){ if(!sigByTs.has(s.ts))sigByTs.set(s.ts,[]); sigByTs.get(s.ts)!.push(s);}
  const allTs = new Set<number>(); for (const bars of barsByCoin.values()) for (const b of bars) allTs.add(b.ts);
  const tsList = [...allTs].sort((a,b)=>a-b);
  let cash = INITIAL; const positions: any[] = []; const eqByDate = new Map<string, number>();
  for (const ts of tsList) {
    for (let q=positions.length-1;q>=0;q--){ const p=positions[q]; const idx=idxByCoinTs.get(p.coin)!.get(ts); if(idx==null)continue;
      const b=barsByCoin.get(p.coin)![idx]; const hold=idx-p.entryIdx; let xp=0,hit=false;
      if(b.low<=p.sl){xp=p.sl;hit=true;}else if(b.high>=p.tp){xp=p.tp;hit=true;}else if(hold>=MAX_BARS){xp=b.close;hit=true;}
      if(hit){ cash += p.vol*xp*(1-COST_RT/2); positions.splice(q,1);} }
    for (const s of (sigByTs.get(ts)||[])){ if(positions.length>=maxC)break; const bars=barsByCoin.get(s.coin); if(!bars)continue;
      const ei=s.barIdx+1; if(ei>=bars.length)continue; const ep=bars[ei].open; const use=cash*pos; if(use<5000)continue;
      cash-=use; positions.push({coin:s.coin,entryIdx:ei,vol:use*(1-COST_RT/2)/ep,cashUsed:use,tp:ep*(1+tp/100),sl:ep*(1+sl/100)}); }
    let ov=0; for(const p of positions){const idx=idxByCoinTs.get(p.coin)!.get(ts); if(idx!=null)ov+=p.vol*barsByCoin.get(p.coin)![idx].close;}
    eqByDate.set(kstDate(ts), cash+ov); // 같은 날 여러 4h → 마지막 값이 일말
  }
  return eqByDate;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length); if (n < 3) return NaN;
  const ma = a.reduce((s,x)=>s+x,0)/n, mb = b.reduce((s,x)=>s+x,0)/n;
  let cov=0,va=0,vb=0; for(let i=0;i<n;i++){const da=a[i]-ma,db=b[i]-mb;cov+=da*db;va+=da*da;vb+=db*db;}
  return cov/Math.sqrt(va*vb+1e-12);
}
function monthlyReturns(eqByDate: Map<string,number>): Map<string, number> {
  const dates = [...eqByDate.keys()].sort(); const monthEnd = new Map<string, number>();
  for (const d of dates) monthEnd.set(ym(d), eqByDate.get(d)!); // 마지막 덮어쓰기 = 월말
  const months = [...monthEnd.keys()].sort(); const ret = new Map<string, number>();
  for (let i=1;i<months.length;i++){ const prev=monthEnd.get(months[i-1])!, cur=monthEnd.get(months[i])!; ret.set(months[i], (cur-prev)/prev*100); }
  return ret;
}
function mddOf(eqByDate: Map<string,number>): number {
  const dates=[...eqByDate.keys()].sort(); let peak=-Infinity,mdd=0; for(const d of dates){const e=eqByDate.get(d)!; if(e>peak)peak=e; const dd=(peak-e)/peak*100; if(dd>mdd)mdd=dd;} return mdd;
}
function fmt(n: number, s=true){return `${s&&n>=0?'+':''}${n.toFixed(2)}%`;}
function pad(s: string,w: number){return s.length>=w?s:s+' '.repeat(w-s.length);}
function padS(s: string,w: number){return s.length>=w?s:' '.repeat(w-s.length)+s;}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const barsByCoin = new Map<string, CachedBar[]>();
  for (const c of COINS){ const b=loadBars(c); if(b.length>=8000) barsByCoin.set(c,b); }
  const idxByCoinTs = new Map<string, Map<number,number>>();
  for (const [coin,bars] of barsByCoin){ const m=new Map<number,number>(); for(let i=0;i<bars.length;i++)m.set(bars[i].ts,i); idxByCoinTs.set(coin,m); }

  const btcDaily = toDaily(barsByCoin.get('BTC')!);
  const startMs = new Date(btcDaily[0].date+'T00:00:00+09:00').getTime();
  console.log('Fetching Binance funding history...');
  const funding = await fetchFundingHistory(startMs);
  console.log(`funding points: ${funding.length} (${funding[0]?.date} ~ ${funding[funding.length-1]?.date})`);
  const dailyMap = aggregateDaily(funding);

  const eqF1F2 = simF1F2(btcDaily, dailyMap);
  const eqV2 = simF6(sigF6v2, 7, -2.5, 0.33, 3, barsByCoin, idxByCoinTs);
  const eqV3 = simF6(sigF6v3, 10, -3, 0.25, 4, barsByCoin, idxByCoinTs);

  // 공통 날짜로 정렬, 합성 (각 5M)
  const allDates = [...new Set([...eqF1F2.keys(), ...eqV2.keys()])].sort();
  function fill(eq: Map<string,number>): Map<string,number> { // 결측일은 직전 값 carry
    const out = new Map<string,number>(); let last = INITIAL;
    for (const d of allDates){ if (eq.has(d)) last = eq.get(d)!; out.set(d, last); } return out;
  }
  const f1=fill(eqF1F2), v2=fill(eqV2), v3=fill(eqV3);
  const combo = (a: Map<string,number>, b: Map<string,number>) => { const o=new Map<string,number>(); for(const d of allDates) o.set(d, 0.5*a.get(d)! + 0.5*b.get(d)!); return o; };
  const comboV2 = combo(f1, v2), comboV3 = combo(f1, v3);

  const rF1 = monthlyReturns(eqF1F2), rV2 = monthlyReturns(eqV2), rV3 = monthlyReturns(eqV3);
  const months = [...rF1.keys()].filter(m => rV2.has(m)).sort();
  const arrF1 = months.map(m=>rF1.get(m)!), arrV2 = months.map(m=>rV2.get(m)!), arrV3 = months.filter(m=>rV3.has(m)).map(m=>rV3.get(m)!);
  const monthsV3 = [...rF1.keys()].filter(m=>rV3.has(m)).sort();

  const totalOf = (eq: Map<string,number>) => { const ds=[...eq.keys()].sort(); return (eq.get(ds[ds.length-1])!-INITIAL)/INITIAL*100; };

  const L: string[] = [];
  L.push('='.repeat(90));
  L.push(`R49 — F1F2 ↔ F6 상관 + 합성 포트폴리오 (4년, ${barsByCoin.size}코인, 공통 ${months.length}개월)`);
  L.push('='.repeat(90));
  L.push(`\n## 월별 수익률 상관 (Pearson)`);
  L.push(`  F1F2 vs F6_v2 : ${pearson(arrF1, months.map(m=>rV2.get(m)!)).toFixed(3)}`);
  L.push(`  F1F2 vs F6_v3 : ${pearson(monthsV3.map(m=>rF1.get(m)!), monthsV3.map(m=>rV3.get(m)!)).toFixed(3)}`);
  L.push(`  F6_v2 vs F6_v3: ${pearson(months.map(m=>rV2.get(m)!), months.filter(m=>rV3.has(m)).map(m=>rV3.get(m)!)).toFixed(3)}`);

  L.push(`\n## 단독 vs 합성 (4년 total / MDD)`);
  L.push(`${pad('portfolio',24)} | ${padS('total',10)} | ${padS('MDD',7)}`);
  L.push('-'.repeat(48));
  for (const [nm, eq] of [['F1F2 단독', eqF1F2],['F6_v2 단독', eqV2],['F6_v3 단독', eqV3],['50/50 F1F2+F6_v2', comboV2],['50/50 F1F2+F6_v3', comboV3]] as const) {
    L.push(`${pad(nm,24)} | ${padS(fmt(totalOf(eq)),10)} | ${padS(mddOf(eq).toFixed(1)+'%',7)}`);
  }
  L.push(`\n해석: 합성 MDD가 두 단독의 가중평균보다 낮으면 분산 효과 있음 (상관<1).`);

  console.log(L.join('\n'));
  fs.writeFileSync(path.join(OUT_DIR, `${stamp}_R49_CORRELATION.txt`), L.join('\n'));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
