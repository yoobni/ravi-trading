/** 실시간 손절 체결 슬리피지 추정 — 1분 호가 스냅샷 (2026-08-24~). 반 스프레드 + 1분간 하락 점프 분포. */
import fs from 'fs';
import path from 'path';
const DIR = path.resolve(process.cwd(), 'data', 'microstructure');
const files = fs.readdirSync(DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
const halfSpread: number[] = []; const drop1m: number[] = []; const dropBig: number[] = [];
const last = new Map<string, { ts: number; mid: number }>();
for (const f of files) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    if (!line) continue;
    let r: any; try { r = JSON.parse(line); } catch { continue; }
    if (!r.mid) continue;
    halfSpread.push(r.spreadBps / 2 / 100); // %
    const p = last.get(r.m);
    if (p && r.ts - p.ts < 90_000) {
      const ch = (r.mid / p.mid - 1) * 100;
      if (ch < 0) { drop1m.push(-ch); if (ch < -0.5) dropBig.push(-ch); }
    }
    last.set(r.m, { ts: r.ts, mid: r.mid });
  }
}
const q = (a: number[], p: number) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
console.log(`파일 ${files.length}일, 스냅샷 ${halfSpread.length}`);
console.log(`반 스프레드 %: 평균 ${mean(halfSpread).toFixed(3)} 중앙 ${q(halfSpread, .5).toFixed(3)} p90 ${q(halfSpread, .9).toFixed(3)} p99 ${q(halfSpread, .99).toFixed(3)}`);
console.log(`1분 하락폭 % (하락 구간만 ${drop1m.length}): 중앙 ${q(drop1m, .5).toFixed(3)} p90 ${q(drop1m, .9).toFixed(3)} p99 ${q(drop1m, .99).toFixed(3)} p99.9 ${q(drop1m, .999).toFixed(3)}`);
console.log(`1분 −0.5% 초과 급락 비율 ${(100 * dropBig.length / drop1m.length).toFixed(2)}%`);
