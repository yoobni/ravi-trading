#!/usr/bin/env tsx
/**
 * AI 리스크 데스크 — 매시 :12 크론. 뉴스에서 **코인 고유 재난**을 찾아 쌍둥이(*_AI) 전략의 신규 매수를 거부한다.
 *
 * 2026-10-13 검증(data/research-ext/riskdesk-2026-10/, docs/RESEARCH-LOG.md) 결론을 그대로 구현한 것:
 *   - 돈이 되는 영역은 "공지 **전** 뉴스로 거부" 하나뿐(LUNA 2022-05-07 디페그 → 05-08 진입 전). 상한 연 ≈1%p.
 *   - 감성 점수가 아니라 **이벤트 유형 분류**(디페그·해킹·지급불능·체인정지·소송·상폐위험). 일반 부정 뉴스는 사유 아님.
 *   - 거시 발표 후 축소·급락 유형 판별은 기각 → 여기 없다. 시장 전체 거부는 스테이블 디페그·거래소 지급불능뿐.
 *   - LLM 은 1단계 분류기, 최종 권한은 코드: 후보 코인 밖·허용 종류 밖·기간 초과는 버린다. 주문 도구 없는 세션에서 돈다.
 * 비용 통제: 결정론적 사전 필터(후보 코인 이름 + 재난 키워드가 같은 헤드라인에)가 걸릴 때만 LLM(Sonnet) 1회 호출.
 * 플래그: --dry-run(쓰지 않음) · --inject <json>(시험용 가짜 헤드라인 파일, 자동으로 dry-run)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { getUpbitClient } from '@/lib/upbit-client';
import { F7_COINS } from '@/lib/paper-f7-store';
import { asFiles } from '@/lib/paper-altswing-store';
import { rlFiles } from '@/lib/paper-rslag-store';
import { AI_STANCE_FILE, AI_STANCE_LOG, readStance } from '@/lib/paper-ai-stance';
import { AI_VETO_LOG, VETO_KINDS, VETO_MAX_HOURS, readVetoList, writeVetoList, type VetoKind, type VetoList } from '@/lib/paper-ai-veto';

const D = path.resolve(process.cwd(), 'data', 'ai-riskdesk');
const NAMES_FILE = path.join(D, 'market-names.json');
const SEEN_FILE = path.join(D, 'seen.json');
const HEADLINES = path.resolve(process.cwd(), 'data', 'ai-feed', 'headlines.jsonl');
const H = 3600e3;
const now = Date.now();
const kst = (ts: number) => new Date(ts + 9 * H).toISOString().slice(0, 16).replace('T', ' ');
const args = process.argv.slice(2);
const inject = args.includes('--inject') ? args[args.indexOf('--inject') + 1] : null;
const dry = args.includes('--dry-run') || !!inject;
fs.mkdirSync(D, { recursive: true });

const DISASTER = /해킹|해커|탈취|익스플로잇|exploit|hack|drain|디페그|depeg|페그|peg\b|파산|지급불능|insolven|bankrupt|출금 ?(중단|정지|제한)|withdrawal.{0,20}(halt|suspend|paus|freez)|halts? withdrawal|소송|lawsuit|기소|indict|증권.{0,6}(지정|판단|분류)|security.{0,15}(designat|classif)|sues|체인.{0,8}(중단|정지|멈)|network.{0,12}(halt|outage|down)|halted|상장 ?폐지|거래 ?지원 ?종료|delist|유의 ?종목|러그 ?풀|rug ?pull|먹튀|준비금|reserve/i;
const MARKET_WIDE = /((USDT|USDC|테더|Tether|Circle|USDe).{0,40}(디페그|depeg|페그|peg\b|준비금|reserve))|((디페그|depeg).{0,40}(USDT|USDC|테더|Tether))|((바이낸스|Binance|코인베이스|Coinbase|업비트|Upbit|빗썸|Bithumb|OKX|Bybit|바이비트).{0,40}(파산|지급불능|insolven|bankrupt|출금 ?(중단|정지)|halts? withdrawal|withdrawal.{0,15}(halt|suspend)))/i;
/** 이름 매칭에서 흔한 단어·사람 이름과 겹치는 코인 — 괄호 심볼로만 매칭 */
const WEAK = new Set(['KRW-TRUMP', 'KRW-G', 'KRW-CAP', 'KRW-SOON', 'KRW-ARK', 'KRW-DRV', 'KRW-FLOCK', 'KRW-ONG', 'KRW-T', 'KRW-ME', 'KRW-W', 'KRW-A', 'KRW-S', 'KRW-H', 'KRW-ZRO', 'KRW-BLUR', 'KRW-MOVE', 'KRW-LAYER', 'KRW-PUMP']);

async function marketNames(): Promise<Record<string, { ko: string; en: string }>> {
  try { const c = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); if (now - c.ts < 24 * H) return c.names; } catch { /* 없음 */ }
  const mk = (await getUpbitClient().getMarkets(true)) as any[];
  const names: Record<string, { ko: string; en: string }> = {};
  for (const m of mk) if (m.market.startsWith('KRW-')) names[m.market] = { ko: m.korean_name, en: m.english_name };
  fs.writeFileSync(NAMES_FILE, JSON.stringify({ ts: now, names }));
  return names;
}
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const lastTick = (f: string) => { try { const l = fs.readFileSync(f, 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]); } catch { return null; } };

/** 후보 = 규칙 전략이 지금 보유하거나 다음에 살 수 있는 코인 */
function candidateMarkets(): Set<string> {
  const out = new Set<string>(F7_COINS);
  for (const f of [asFiles(false), asFiles(true), rlFiles(false), rlFiles(true)]) {
    const st = readJson(f.state); for (const p of st?.positions || []) out.add(p.market);
    const t = lastTick(f.ticks); for (const m of t?.universe || []) out.add(m);
  }
  for (const d of ['paper-f7sl', 'paper-f7btc', 'paper-f7sl-ai']) { const st = readJson(path.resolve('data', d, 'state.json')); for (const p of st?.positions || []) out.add(p.market); }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mentions(title: string, cands: Set<string>, names: Record<string, { ko: string; en: string }>): string[] {
  const hit: string[] = [];
  for (const m of cands) {
    const sym = m.slice(4), n = names[m];
    const bySym = new RegExp(`\\(${esc(sym)}\\)|(?<![A-Z0-9])${esc(sym)}(?![A-Z0-9])`).test(title);
    if (WEAK.has(m)) { if (new RegExp(`\\(${esc(sym)}\\)`).test(title)) hit.push(m); continue; }
    const byKo = !!n?.ko && n.ko.length >= 2 && title.includes(n.ko);
    const byEn = !!n?.en && n.en.length >= 4 && new RegExp(`(?<![A-Za-z])${esc(n.en)}(?![A-Za-z])`, 'i').test(title);
    if ((sym.length >= 3 && bySym) || byKo || byEn) hit.push(m);
  }
  return hit;
}

(async () => {
  // 1) 헤드라인 갱신(감시관 커서는 건드리지 않음) + 최근 3시간
  let rows: { k: string; src: string; ts: number; title: string; link?: string }[] = [];
  if (inject) rows = JSON.parse(fs.readFileSync(inject, 'utf8'));
  else {
    try { execFileSync('npx', ['tsx', 'scripts/ai-feed.ts', '--since-hours', '3'], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'ignore', 'inherit'] }); } catch (e: any) { console.error(`[riskdesk] 피드 갱신 실패: ${e?.message || e}`); }
    rows = fs.existsSync(HEADLINES) ? fs.readFileSync(HEADLINES, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((h) => h.ts >= now - 3 * H) : [];
  }
  const seen: Record<string, number> = readJson(SEEN_FILE) || {};
  for (const k of Object.keys(seen)) if (now - seen[k] > 48 * H) delete seen[k];
  const fresh = rows.filter((h) => !seen[h.k]);

  // 2) 사전 필터
  const cands = candidateMarkets();
  const names = await marketNames();
  const flagged: { h: typeof rows[0]; markets: string[]; wide: boolean }[] = [];
  for (const h of fresh) {
    const t = h.title || '';
    const wide = MARKET_WIDE.test(t);
    const ms = DISASTER.test(t) ? mentions(t, cands, names) : [];
    if (wide || ms.length) flagged.push({ h, markets: ms, wide });
  }
  const tick: any = { ts: now, tickAt: kst(now), headlines: rows.length, fresh: fresh.length, flagged: flagged.length, candidates: cands.size, llm: false, vetoes: 0, marketWide: null, costUsd: 0 };
  const finish = (msg: string) => {
    // LLM 실패·JSON 불량이면 걸린 헤드라인은 seen 에 넣지 않는다 → 다음 시간에 재판정(재난 헤드라인을 영구히 버리지 않기 위해)
    const retry = new Set(tick.error ? flagged.map((f) => f.h.k) : []);
    if (!dry) { for (const h of fresh) if (!retry.has(h.k)) seen[h.k] = now; fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); }
    fs.appendFileSync(path.join(D, 'ticks.jsonl'), JSON.stringify(tick) + '\n');
    fs.writeFileSync(path.join(D, 'state.json'), JSON.stringify({ lastTickTs: now, lastTickAt: new Date(now).toISOString(), ...tick }, null, 2));
    console.log(`[riskdesk ${kst(now)}] ${msg}`);
  };
  if (!flagged.length) return finish(`헤드라인 ${rows.length}(새 ${fresh.length}) · 후보 ${cands.size} · 걸린 것 없음 → LLM 호출 없음`);

  // 3) LLM 분류 (Sonnet, 도구 없음)
  const candList = [...new Set(flagged.flatMap((f) => f.markets))].map((m) => `${m} (${names[m]?.ko ?? ''} / ${names[m]?.en ?? ''})`);
  const input = flagged.map((f) => `- key=${f.h.k} [${kst(f.h.ts)} ${f.h.src}] ${f.h.title.replace(/[\r\n]+/g, ' ').slice(0, 200)}`).join('\n');
  const prompt = `${fs.readFileSync('scripts/ai-riskdesk/task.md', 'utf8')}\n\n## 현재 시각\n${kst(now)} KST\n\n## 후보 코인(이 목록 밖은 무시)\n${candList.join('\n') || '(없음 — market_wide 만 판단)'}\n\n## 헤드라인\n${input}`;
  const r = spawnSync('claude', ['-p', prompt, '--model', 'sonnet', '--output-format', 'json', '--strict-mcp-config',
    '--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'],
    { encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` } });
  let res: any = {}; try { res = JSON.parse(r.stdout); } catch { /* */ }
  tick.llm = true; tick.costUsd = res.total_cost_usd ?? 0;
  if (r.status !== 0 || res.is_error || typeof res.result !== 'string') { tick.error = (res.result || r.stderr || '').slice(0, 300); return finish(`LLM 실패: ${tick.error}`); }
  let out: any = null;
  try { const m = res.result.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : null; } catch { /* */ }
  if (!out) { tick.error = `JSON 아님: ${res.result.slice(0, 200)}`; return finish(tick.error); }

  // 4) 코드 검증 — 후보 밖·종류 밖·기간 초과는 버린다
  const allowed = new Set(flagged.flatMap((f) => f.markets));
  const vetoes: VetoList = readVetoList(now);
  const accepted: any[] = [], rejected: any[] = [];
  for (const v of out.vetoes || []) {
    const kind = v?.kind as VetoKind;
    if (!allowed.has(v?.market) || !VETO_KINDS.includes(kind)) { rejected.push({ ...v, why: '후보 밖 또는 종류 밖' }); continue; }
    const hours = Math.min(Math.max(1, Number(v.hours) || 24), VETO_MAX_HOURS[kind]);
    const e = { kind, reason: String(v.reason || '').slice(0, 200), since: new Date(now).toISOString(), until: new Date(now + hours * H).toISOString(), source: String(v.evidence || '').slice(0, 120) };
    const prev = vetoes[v.market];
    if (!prev || Date.parse(prev.until) < Date.parse(e.until)) vetoes[v.market] = e;
    accepted.push({ market: v.market, ...e });
  }
  let wide: any = null;
  if (out.market_wide && ['stablecoin_depeg', 'exchange_insolvency'].includes(out.market_wide.kind) && flagged.some((f) => f.wide)) {
    const hours = Math.min(Math.max(1, Number(out.market_wide.hours) || 24), 72);
    wide = { level: 'avoid', reasons: [`${out.market_wide.kind}: ${String(out.market_wide.reason || '').slice(0, 200)}`], updatedAt: new Date(now).toISOString(), validUntil: new Date(now + hours * H).toISOString(), scope: ['dip', 'alt', 'trend'], source: 'riskdesk' };
  }
  tick.vetoes = accepted.length; tick.marketWide = wide?.reasons?.[0] ?? null; tick.rejected = rejected.length;
  if (!dry) {
    writeVetoList(vetoes);
    if (wide) { const cur = readStance(now); if (cur.level !== 'avoid' || Date.parse(cur.validUntil) < Date.parse(wide.validUntil)) { fs.writeFileSync(AI_STANCE_FILE, JSON.stringify(wide, null, 2)); fs.appendFileSync(AI_STANCE_LOG, JSON.stringify(wide) + '\n'); } }
  }
  fs.appendFileSync(AI_VETO_LOG, JSON.stringify({ ts: now, at: kst(now), dry, flagged: flagged.map((f) => ({ k: f.h.k, title: f.h.title, markets: f.markets, wide: f.wide })), llm: out, accepted, rejected, wide, costUsd: tick.costUsd }) + '\n');
  finish(`걸린 헤드라인 ${flagged.length} → LLM 판정: 거부 ${accepted.length}건${accepted.length ? ' [' + accepted.map((a) => `${a.market} ${a.kind}`).join(', ') + ']' : ''}${rejected.length ? ` · 코드가 버림 ${rejected.length}` : ''}${wide ? ` · 시장전체 avoid(${wide.reasons[0]})` : ''} · ${tick.costUsd.toFixed(3)}USD${dry ? ' (dry-run)' : ''}`);
})().catch((e) => { console.error('[riskdesk FAIL]', e); process.exit(1); });
