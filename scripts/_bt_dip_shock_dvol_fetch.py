# Deribit DVOL(BTC) 일봉·1h 히스토리 캐시 (Deribit 공개 API, 초당 ≤2회)
import json, time, urllib.request, sys
OUT = '/Users/goyubin/Desktop/Ravi/project/upbit-trading/data/research-ext/dip-2026-10/shock/deribit-dvol-btc.json'
URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp={s}&end_timestamp={e}&resolution={r}'
def fetch(res):
    end = int(time.time()*1000); start = 1609459200000  # 2021-01-01
    rows = {}
    e = end
    while True:
        u = URL.format(s=start, e=e, r=res)
        with urllib.request.urlopen(u, timeout=30) as f: j = json.load(f)
        data = j['result']['data']; cont = j['result'].get('continuation')
        for r in data: rows[r[0]] = r
        print(res, len(data), data[0][0] if data else None, cont, file=sys.stderr)
        time.sleep(0.6)
        if not cont or not data or cont <= start: break
        e = cont
    return [rows[k] for k in sorted(rows)]
out = {'daily': fetch('1D'), 'hourly': fetch('3600'), 'fields': ['ts', 'open', 'high', 'low', 'close'], 'fetched': time.strftime('%Y-%m-%d %H:%M:%S')}
json.dump(out, open(OUT, 'w'))
print('daily', len(out['daily']), 'hourly', len(out['hourly']))
