# 공통: BTC 장중 경로(2018~2020 60m, 2021~ 15m), 업비트 일봉, 국면 라벨, 함대 시리즈, 단일 슬리브 포트폴리오 시뮬
import json, math, numpy as np
from datetime import datetime, timezone
R = '/Users/goyubin/Desktop/Ravi/project/upbit-trading/data/research-ext/'
OUT = R + 'dip-2026-10/shock/'
DAY = 86400000
FEE = 0.0005
SLIP = max(0.0005, json.load(open(R + '../research-spread-p50.json'))['KRW-BTC'] / 2 / 1e4)  # 스프레드½, 최소 0.05%
PEN = 0.002  # 지정가 관통 요구

def load_bars():
    h = json.load(open(R + 'macro/KRW-BTC_60m.json'))
    q = json.load(open(R + 'btc15m.json'))
    cut = 1609459200000
    rows = [(x['ts'], 3600000, x['open'], x['high'], x['low'], x['close']) for x in h if x['ts'] < cut]
    rows += [(x[0], 900000, x[1], x[2], x[3], x[4]) for x in q]
    a = np.array(rows, dtype=float)
    return dict(T=a[:, 0].astype(np.int64), D=a[:, 1].astype(np.int64), O=a[:, 2], H=a[:, 3], L=a[:, 4], C=a[:, 5], E=(a[:, 0] + a[:, 1]).astype(np.int64))
B = load_bars()

def mark(t):  # 시각 t 의 가격(t 이전에 끝난 마지막 봉 종가)
    i = np.searchsorted(B['E'], t, 'right') - 1
    return B['C'][max(i, 0)]

def bar_at(t):  # 시작 ≥ t 인 첫 봉
    return int(np.searchsorted(B['T'], t, 'left'))

dly = json.load(open(R + 'daily/KRW-BTC.json'))
DT = np.array([x['ts'] for x in dly], dtype=np.int64); DC = np.array([x['close'] for x in dly], float)
def _lab():
    lab = {}
    for k in range(len(DC)):
        if k < 50: continue
        sma = DC[k - 49:k + 1].mean(); r20 = DC[k] / DC[k - 20] - 1
        lab[int(DT[k])] = 'a' if DC[k] < sma else ('b' if r20 <= 0.02 else 'c')
    return lab
LAB = _lab()
BTCD = {int(DT[k]): DC[k] / DC[k - 1] - 1 for k in range(1, len(DC))}

FS = json.load(open(R + 'final/daily-series.json'))
FKEYS = ['BTC_TREND', 'BTC_ENS', 'ETH_TREND', 'ALT_SWING', 'USDT_Z', 'BTC_DIP', 'F7_sl*']
def _fleet():
    acc = {}
    for k in FKEYS:
        for t, r in FS[k]: acc.setdefault(int(t), []).append(r)
    return {t: sum(v) / len(v) for t, v in acc.items()}
FLEET = _fleet()

def ymd(ms): return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%d')

def sim_trade(sig_t, delay_ms, tp=None, hold_ms=24 * 3600000, entry_at=None, cost_mult=1.0):
    """sig_t: 정보 확정 시각. entry_at: 진입 시각을 직접 지정(일봉 시가 등). 반환 dict 또는 None"""
    t0 = entry_at if entry_at is not None else sig_t + delay_ms
    i = bar_at(t0)
    if i >= len(B['T']) or B['T'][i] - t0 > 6 * 3600000: return None  # 데이터 공백
    fee, slip = FEE * cost_mult, SLIP * cost_mult
    ein = B['O'][i]; et = int(B['T'][i])
    tend = et + hold_ms
    j_end = bar_at(tend)
    if j_end >= len(B['T']): return None
    if tp is not None:
        lvl = ein * (1 + tp)
        hit = np.nonzero(B['H'][i:j_end] >= lvl * (1 + PEN))[0]
        if len(hit):
            j = i + hit[0]
            g = lvl / ein
            net = g * (1 - fee) / ((1 + slip) * (1 + fee)) - 1
            return dict(sig=sig_t, et=et, xt=int(B['E'][j]), ein=ein, xp=lvl, gross=g - 1, net=net, how='tp')
    xp = B['O'][j_end]; g = xp / ein
    net = g * (1 - slip) * (1 - fee) / ((1 + slip) * (1 + fee)) - 1
    return dict(sig=sig_t, et=et, xt=int(B['T'][j_end]), ein=ein, xp=xp, gross=g - 1, net=net, how='time')

def run(sigs, f=1.0, **kw):
    """단일 슬리브: 보유 중 신호는 건너뜀. sigs: [(sig_t, entry_at|None)]"""
    trades = []; busy = 0
    for s, ea in sigs:
        t0 = ea if ea is not None else s + kw.get('delay_ms', 0)
        if t0 < busy: continue
        tr = sim_trade(s, entry_at=ea, **kw)
        if tr is None: continue
        trades.append(tr); busy = tr['xt']
    return trades

def daily_curve(trades, f, t_start, t_end, cost_mult=1.0):
    """일 단위(00:00 UTC=KST09시) 자산곡선 → {day_ts: r}"""
    days = np.arange(t_start, t_end + 1, DAY)
    eq = np.empty(len(days)); e = 1.0; k = 0
    fee, slip = FEE * cost_mult, SLIP * cost_mult
    tr_i = 0
    for n, d in enumerate(days):
        # 이 날짜 시점 이전에 끝난 거래 확정
        while tr_i < len(trades) and trades[tr_i]['xt'] <= d:
            e *= (1 + f * trades[tr_i]['net']); tr_i += 1
        if tr_i < len(trades) and trades[tr_i]['et'] <= d:
            tr = trades[tr_i]
            m = mark(d) / tr['ein'] * (1 - slip) * (1 - fee) / ((1 + slip) * (1 + fee)) - 1
            eq[n] = e * (1 + f * m)
        else:
            eq[n] = e
    r = eq[1:] / eq[:-1] - 1
    return {int(days[n]): r[n] for n in range(len(r))}  # 키=그날 시작, 값=그날 수익(다음날 00:00 까지)

def stats(trades, dr, f=1.0):
    rs = np.array([t['net'] for t in trades]) if trades else np.array([0.0])
    v = np.array(list(dr.values())); eq = np.cumprod(1 + v)
    yrs = len(v) / 365.0
    mdd = (eq / np.maximum.accumulate(eq) - 1).min()
    sh = v.mean() / v.std() * math.sqrt(365) if v.std() > 0 else 0
    n = len(trades)
    t = rs.mean() / rs.std(ddof=1) * math.sqrt(n) if n > 2 and rs.std() > 0 else 0
    return dict(n=n, tot=eq[-1] - 1, cagr=eq[-1] ** (1 / yrs) - 1, mdd=mdd, sh=sh, npy=n / yrs, win=(rs > 0).mean() if n else 0,
                avg=rs.mean() if n else 0, med=float(np.median(rs)) if n else 0, t=t)

def regime(dr):
    out = {}
    for g in 'abc':
        v = np.array([r for t, r in dr.items() if LAB.get(t) == g])
        out[g] = (len(v), v.mean() if len(v) else 0, np.prod(1 + v) - 1 if len(v) else 0)
    return out

def complement(dr):
    ks = [t for t in dr if t in FLEET]
    s = np.array([dr[t] for t in ks]); fl = np.array([FLEET[t] for t in ks])
    if len(ks) < 30 or s.std() == 0: return dict(n=len(ks))
    loss = fl < 0
    per = {}
    for k in FKEYS:
        m = {int(t): r for t, r in FS[k]}; kk = [t for t in ks if t in m]
        if len(kk) > 30: per[k] = np.corrcoef([dr[t] for t in kk], [m[t] for t in kk])[0, 1]
    return dict(n=len(ks), corr=np.corrcoef(s, fl)[0, 1], loss_n=int(loss.sum()), loss_mean=s[loss].mean(), all_mean=s.mean(),
                fleet_loss_mean=fl[loss].mean(), per=per, first=ymd(ks[0]))

def P(x, d=2): return f'{x * 100:+.{d}f}%'
def fmt_stats(s): return f"n={s['n']:3d} 총익 {P(s['tot'],1):>8} CAGR {P(s['cagr'],1):>7} MDD {P(s['mdd'],1):>7} 샤프 {s['sh']:5.2f} 거래/연 {s['npy']:4.1f} 승률 {s['win']*100:4.0f}% 평균 {P(s['avg'])} 중앙 {P(s['med'])} t {s['t']:4.2f}"
