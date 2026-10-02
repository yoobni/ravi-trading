/**
 * 축 A ③ — 매매화. 이벤트: 바이낸스 k=3분 수익 − 업비트 3분 수익(괴리) ≥ X bp.
 * 체결: 업비트 스냅샷 시점 L분 뒤 매수 = mid×(1+스프레드/2) (그 시점 실제 spreadBps), 매도 = mid×(1−스프레드/2), 수수료 0.05%×2.
 * 청산: h분 뒤 시장가 · 또는 지정가 익절 +tp bp(mid 가 목표+스프레드/2 이상 닿으면 체결로 간주, 관통 요구 별도) 실패 시 h분 뒤.
 * 코인 그룹: 스프레드 p50 ≤ 15bp(유동) / 전체. 한 코인 동시 1포지션, 쿨다운 h분.
 */
import { up, bn } from './_an_leadlag';
const M = 60_000; const COINS = [...bn.keys()];
const SPREAD: Record<string, number> = require('../data/research-spread-p50.json');
const allT = [...up.get('BTC')!.keys()].sort((a, b) => a - b); const half = allT[Math.floor(allT.length / 2)];
const FEE = 0.0005;
interface Tr { c: string; t: number; r: number }
function sim(X: number, L: number, h: number, liquidOnly: boolean, tp: number | null, feeMul = 1, shuffle = false) {
  const out: Tr[] = [];
  for (const c of COINS) {
    if (liquidOnly && (SPREAD['KRW-' + c] ?? 99) > 15) continue;
    const u = up.get(c)!, b = bn.get(c)!; if (!u) continue;
    const ts = [...u.keys()].sort((a, b) => a - b);
    // 플라시보: 바이낸스 시계열을 하루(1440분) 밀어서 맞춘다 — 같은 분포, 시간 관계만 파괴
    const bAt = (t: number) => b.get(shuffle ? t - 1440 * M : t);
    let busyUntil = 0;
    for (const t of ts) {
      if (t < busyUntil) continue;
      const v = u.get(t)!, u0 = u.get(t - 3 * M), b0 = bAt(t - 3 * M), bt = bAt(t);
      if (!u0 || !b0 || !bt) continue;
      const gap = 1e4 * ((bt / b0 - 1) - (v.mid / u0.mid - 1));
      if (gap < X) continue;
      const e = u.get(t + L * M); if (!e) continue;
      const ep = e.mid * (1 + e.spr / 2e4);
      let xp: number | null = null;
      for (let j = 1; j <= h; j++) {
        const s = u.get(t + (L + j) * M); if (!s) continue;
        if (tp != null && s.mid * (1 - s.spr / 2e4) >= ep * (1 + tp / 1e4)) { xp = ep * (1 + tp / 1e4); break; }   // 지정가 매도: bid 가 목표 이상
        if (j === h) xp = s.mid * (1 - s.spr / 2e4);
      }
      if (xp == null) continue;
      out.push({ c, t, r: (xp / ep) * (1 - FEE * feeMul) ** 2 - 1 });
      busyUntil = t + (L + h) * M;
    }
  }
  return out;
}
const fmt = (xs: Tr[]) => { const m = (a: Tr[]) => a.length ? (1e4 * a.reduce((s, x) => s + x.r, 0) / a.length).toFixed(1) : '—'; const w = xs.filter(x => x.r > 0).length;
  return `${String(xs.length).padStart(5)}건 평균 ${m(xs).padStart(6)}bp (전 ${m(xs.filter(x => x.t < half)).padStart(6)} / 후 ${m(xs.filter(x => x.t >= half)).padStart(6)}) 승률 ${xs.length ? (100 * w / xs.length).toFixed(0) : 0}%`; };
console.log('거래당 순수익(bp, 수수료·실제 스프레드 반영)');
for (const liq of [true, false]) {
  console.log(`\n── ${liq ? '유동 코인(스프레드 p50 ≤15bp)' : '전체 28코인'} ──`);
  for (const L of [0, 1]) for (const X of [30, 50, 80, 120]) for (const h of [5, 15, 60]) {
    console.log(`  L=${L} 괴리≥${String(X).padStart(3)} h=${String(h).padStart(2)} 시장가청산  ${fmt(sim(X, L, h, liq, null))}`);
  }
  for (const X of [50, 80]) for (const tp of [20, 40]) console.log(`  L=0 괴리≥${X} 지정가익절 +${tp}bp/h=60  ${fmt(sim(X, 0, 60, liq, tp))}`);
}
console.log('\n── 플라시보(바이낸스 1일 시프트) · 유동, L=0 ──');
for (const X of [50, 80]) console.log(`  괴리≥${X} h=15  실제 ${fmt(sim(X, 0, 15, true, null))}\n             플라시보 ${fmt(sim(X, 0, 15, true, null, 1, true))}`);
