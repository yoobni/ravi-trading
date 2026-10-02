import { UP, BN, USDT, fxAt } from './_kp_core';
const t0 = Date.UTC(2025, 5, 30, 8);
for (const c of ['XRP', 'BTC']) { console.log(c);
  for (let t = t0; t <= t0 + 5 * 4 * 3600e3; t += 4 * 3600e3) { const u = UP.get(c)!.get(t), b = BN.get(c)!.get(t), us = USDT.get(t);
    console.log(`  ${new Date(t).toISOString().slice(0, 16)}Z  업 o${u?.open} c${u?.close}  바 o${b?.open} c${b?.close}  비율 ${u && b ? (u.close / b.close).toFixed(1) : '-'}  USDT ${us?.close} fx ${fxAt(t)}`); } }
