# server.py — 股票交易跟踪系统：静态托管 + 行情代理
# 运行：python server.py  （默认端口 8081）
# 说明：
#   - 浏览器直接请求行情接口会被 CORS 拦截，且新浪需 Referer、腾讯为 GBK 编码；
#   - 本服务在服务端转发「东方财富」UTF-8 JSON 行情接口，绕过 CORS 并避免编码问题；
#   - 仅用 Python 标准库，无第三方依赖。
#
# 端点：
#   GET /api/quote?code=600519 或 codes=a,b  -> {ok, quotes:[{code,name,price,prevClose,change,changePct}]}
#   GET /api/kline?code=600519              -> {code, closes:[...], pctCum:[...]}（收盘序列，从早到晚）
import json
import os
import re
import sqlite3
import sys
import threading
from http.server import SimpleHTTPRequestHandler, HTTPServer
try:
    from http.server import ThreadingHTTPServer          # Python >= 3.7
except ImportError:
    from socketserver import ThreadingMixIn              # Python 3.6（CentOS 7 自带）
    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True
from urllib.parse import urlparse, parse_qs
from urllib.request import Request, urlopen

PORT = int(os.environ.get('PORT', 8081))
ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BODY = 20 * 1024 * 1024   # /api/state 请求体上限 20MB

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')


# ---------- 持久化 ----------
# 普通业务数据（持仓/操作/元信息等）存 SQLite data.db；
# 策略（st.strategy.v1 / st.strategies.v1）单独存 JSON 文件 strategies.json，
# 清数据时不会被删除。浏览器 localStorage 仅作镜像缓存。
# 读写失败时静默降级（返回空/失败），前端自动回退本地模式，不影响使用。
DB_PATH = os.path.join(ROOT, 'data.db')
STRATEGY_KEYS = {'st.strategy.v1', 'st.strategies.v1'}   # 策略类 key：存文件
STRATEGY_FILE = os.path.join(ROOT, 'strategies.json')
_db_lock = threading.Lock()


def _conn():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    conn.commit()
    return conn


def _load_strategies():
    try:
        with open(STRATEGY_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_strategies(data):
    try:
        with open(STRATEGY_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def kv_get_all():
    data = {}
    try:
        with _db_lock:
            conn = _conn()
            try:
                rows = conn.execute('SELECT key, value FROM kv').fetchall()
                to_migrate = {}
                for k, v in rows:
                    if k in STRATEGY_KEYS:
                        to_migrate[k] = json.loads(v)   # 旧库中的策略：迁出到文件
                    else:
                        data[k] = json.loads(v)
                if to_migrate:
                    merged = _load_strategies()
                    merged.update(to_migrate)
                    _save_strategies(merged)
                    for k in to_migrate:
                        conn.execute('DELETE FROM kv WHERE key=?', (k,))
                    conn.commit()
            finally:
                conn.close()
    except Exception:
        data = {}
    # 合并策略文件（清库不影响策略）
    data.update(_load_strategies())
    return data


def kv_upsert(state):
    # 策略 key 写文件，其余写 SQLite
    strat = {k: v for k, v in state.items() if k in STRATEGY_KEYS}
    rest = {k: v for k, v in state.items() if k not in STRATEGY_KEYS}
    if strat:
        with _db_lock:
            merged = _load_strategies()
            merged.update(strat)
            _save_strategies(merged)
    if not rest:
        return True
    try:
        with _db_lock:
            conn = _conn()
            try:
                conn.execute('BEGIN')
                for k, v in rest.items():
                    conn.execute('INSERT INTO kv(key,value) VALUES(?,?) '
                                 'ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                                 (k, json.dumps(v, ensure_ascii=False)))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
        return True
    except Exception:
        return False


def kv_clear(keys=None):
    # 仅清 SQLite 业务数据；策略文件不受影响
    try:
        with _db_lock:
            conn = _conn()
            try:
                if keys:
                    conn.executemany('DELETE FROM kv WHERE key=?', [(k,) for k in keys])
                else:
                    conn.execute('DELETE FROM kv')
                conn.commit()
            finally:
                conn.close()
        return True
    except Exception:
        return False


# 代码 -> 市场前缀（sh / sz / bj）
def prefix(code):
    c = str(code).strip()
    if c[:2] == '92':
        return 'bj'                     # 北交所 920 代码段
    if c[:1] == '6':
        return 'sh'                     # 沪市主板/科创板
    if c[:1] in ('4', '8'):
        return 'bj'                     # 北交所
    return 'sz'                          # 深市主板/创业板/指数(部分)


def http_get_bytes(url):
    req = Request(url, headers={'User-Agent': UA, 'Referer': 'https://finance.qq.com/'})
    with urlopen(req, timeout=8) as r:
        return r.read()


# 东方财富接口会拒绝带 Referer 的请求（连接被主动关闭），故发纯请求头
def http_get_bytes_plain(url):
    req = Request(url, headers={'User-Agent': UA})
    with urlopen(req, timeout=8) as r:
        return r.read()


# 实时行情（腾讯，GBK 编码）
def fetch_quote(code):
    p = prefix(code)
    url = 'https://qt.gtimg.cn/q=' + p + str(code)
    text = http_get_bytes(url).decode('gbk', 'replace')
    m = re.search(r'v_%s\d{6}="([^"]+)"' % p, text)
    if not m:
        raise ValueError('no quote for ' + code)
    parts = m.group(1).split('~')        # ~ 分隔，下标见下
    def num(i, default=None):
        try:
            v = float(parts[i])
            return v
        except Exception:
            return default
    price = num(3)
    prev = num(4, price)
    if price is None:
        price = prev or 0
    return {
        'code': str(code),
        'name': parts[1],
        'price': price,
        'prevClose': prev,
        'open': num(5, None),
        'high': num(33, None),
        'low': num(34, None),
        'change': num(31, None),
        'changePct': num(32, None)
    }


# 日 K 线（腾讯，UTF-8 JSON），返回 {dates, closes, pctCum}，从早到晚
# 拉取 320 个交易日（约一年以上），供走势图与回测使用
def fetch_kline(code):
    if prefix(code)[:2] == 'bj':
        # 腾讯对北交所个股没有历史日K，先试东方财富；失败则新浪兜底
        k = fetch_kline_em(code)
        if k['closes']:
            return k
        k2 = fetch_kline_sina(code)
        if k2['closes']:
            return k2
        return k
    p = prefix(code)
    url = ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
           '?_var=kline_dayqfq&param=%s%s,day,,,320,qfq' % (p, code))
    text = http_get_bytes(url).decode('utf-8', 'replace')
    if '=' in text:
        text = text.split('=', 1)[1]
    text = text.strip().rstrip(';')
    js = json.loads(text)
    node = js['data'][p + str(code)]
    arr = node.get('qfqday') or node.get('day') or []
    # 腾讯日K条目：[date, open, close, high, low, volume]
    dates = [str(x[0]) for x in arr]
    opens = [float(x[1]) for x in arr]
    closes = [float(x[2]) for x in arr]
    highs = [float(x[3]) for x in arr]
    lows = [float(x[4]) for x in arr]
    base = closes[0] if closes else 0
    pct_cum = [round((c - base) / base * 100, 2) if base else 0 for c in closes]
    return {'code': str(code), 'dates': dates, 'opens': opens, 'closes': closes,
            'highs': highs, 'lows': lows, 'pctCum': pct_cum}


# 日 K 线（东方财富，UTF-8 JSON）：用于北交所（腾讯无 BSE 历史日K）
# 接口偶发断连（RemoteDisconnected）/限流，做重试；仍失败则返回空，由调用方转新浪兜底
def fetch_kline_em(code):
    c = str(code).strip()
    # secid 市场位：沪=1，深/北交所=0；北交所（920/8/4）双市场位保险
    if c[:1] == '6':
        markets = ['1']
    elif c[:2] == '92' or c[:1] in ('8', '4'):
        markets = ['0', '1']
    else:
        markets = ['0']
    for m in markets:
        url = ('https://push2his.eastmoney.com/api/qt/stock/kline/get'
               '?secid=%s.%s&klt=101&fqt=1&fields1=f1&fields2=f51,f52,f53,f54,f55&end=20500101&lmt=320' % (m, c))
        for attempt in range(2):
            try:
                js = json.loads(http_get_bytes_plain(url))
                data = js.get('data') or {}
                arr = data.get('klines') or []
                # 东财K线条目："date,open,close,high,low,..."（f51-f55）
                dates = [str(x.split(',')[0]) for x in arr]
                opens = [float(x.split(',')[1]) for x in arr]
                closes = [float(x.split(',')[2]) for x in arr]
                highs = [float(x.split(',')[3]) for x in arr]
                lows = [float(x.split(',')[4]) for x in arr]
                if not closes:
                    break
                base = closes[0]
                pct_cum = [round((x - base) / base * 100, 2) if base else 0 for x in closes]
                return {'code': c, 'dates': dates, 'opens': opens, 'closes': closes,
                        'highs': highs, 'lows': lows, 'pctCum': pct_cum}
            except Exception:
                if attempt == 1:
                    break
    return {'code': c, 'dates': [], 'opens': [], 'closes': [], 'highs': [], 'lows': [], 'pctCum': []}


# 日 K 线（新浪财经，UTF-8 JSONP）：北交所可靠兜底（东财被限流时）
# symbol 用 bj+code（新浪已支持北交所 920 新段），datalen=320 拉约一年数据
def fetch_kline_sina(code):
    c = str(code).strip()
    url = ('https://quotes.sina.cn/cn/api/jsonp_v2.php/var/CN_MarketDataService.getKLineData'
           '?symbol=bj%s&scale=240&ma=no&datalen=320' % c)
    req = Request(url, headers={'User-Agent': UA, 'Referer': 'https://finance.sina.com.cn/'})
    try:
        with urlopen(req, timeout=8) as r:
            text = r.read().decode('utf-8', 'replace')
    except Exception:
        return {'code': c, 'dates': [], 'closes': [], 'pctCum': []}
    m = re.search(r'var\s*\((\[.*\])\)\s*;?', text, re.S)
    if not m:
        m = re.search(r'(\[.*\])', text, re.S)
    if not m:
        return {'code': c, 'dates': [], 'closes': [], 'pctCum': []}
    try:
        arr = json.loads(m.group(1))
    except Exception:
        return {'code': c, 'dates': [], 'opens': [], 'closes': [], 'highs': [], 'lows': [], 'pctCum': []}
    arr = [x for x in arr if isinstance(x, dict)]
    dates = [str(x.get('day')) for x in arr]
    opens = [float(x['open']) for x in arr if x.get('open')]
    closes = [float(x['close']) for x in arr if x.get('close')]
    highs = [float(x['high']) for x in arr if x.get('high')]
    lows = [float(x['low']) for x in arr if x.get('low')]
    base = closes[0] if closes else 0
    pct_cum = [round((x - base) / base * 100, 2) if base else 0 for x in closes]
    return {'code': c, 'dates': dates, 'opens': opens, 'closes': closes,
            'highs': highs, 'lows': lows, 'pctCum': pct_cum}


# 沪深300 指数日K（腾讯，UTF-8 JSON），返回 {dates, closes}，从早到晚
# 指数代码强制用沪市前缀 sh（沪深300 = sh000300）
def fetch_index(code='000300', count=500):
    p = 'sh'
    url = ('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
           '?_var=index_day&param=%s%s,day,,,%d,qfq' % (p, code, count))
    text = http_get_bytes(url).decode('utf-8', 'replace')
    if '=' in text:
        text = text.split('=', 1)[1]
    text = text.strip().rstrip(';')
    js = json.loads(text)
    node = js['data'][p + str(code)]
    arr = node.get('qfqday') or node.get('day') or []
    return {
        'code': str(code),
        'dates': [x[0] for x in arr],
        'closes': [float(x[1]) for x in arr]
    }


def respond_json(resp, obj, status=200):
    body = json.dumps(obj).encode('utf-8')
    resp.send_response(status)
    resp.send_header('Content-Type', 'application/json; charset=utf-8')
    resp.send_header('Cache-Control', 'no-store')
    resp.send_header('Content-Length', str(len(body)))
    resp.end_headers()
    resp.wfile.write(body)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        # 不传 directory 参数（Python 3.7 才支持），直接依赖启动时 os.chdir(ROOT) 作为工作目录
        super().__init__(*a, **kw)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        qs = parse_qs(u.query)

        if p == '/api/quote':
            codes = [x for x in (qs.get('codes', qs.get('code', ['']))[0].split(',')) if x.strip()]
            out = []
            for c in codes[:30]:
                try:
                    out.append(fetch_quote(c.strip()))
                except Exception:
                    continue
            return respond_json(self, {'ok': True, 'quotes': out})

        if p == '/api/kline':
            code = (qs.get('code', [''])[0] or '').strip()
            try:
                return respond_json(self, fetch_kline(code))
            except Exception as e:
                return respond_json(self, {'error': 'kline failed: %s' % e}, status=502)

        if p == '/api/index':
            try:
                return respond_json(self, fetch_index())
            except Exception as e:
                return respond_json(self, {'error': 'index failed: %s' % e}, status=502)

        if p == '/api/state':
            return respond_json(self, {'ok': True, 'state': kv_get_all()})

        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != '/api/state':
            return respond_json(self, {'ok': False, 'error': 'not found'}, status=404)
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
        except Exception:
            length = 0
        if length <= 0 or length > MAX_BODY:
            return respond_json(self, {'ok': False, 'error': 'bad body'}, status=413)
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8', 'replace') or '{}')
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        return respond_json(self, {'ok': kv_upsert(body)})

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path != '/api/state':
            return respond_json(self, {'ok': False, 'error': 'not found'}, status=404)
        qs = parse_qs(u.query)
        keys = [x for x in qs.get('keys', [''])[0].split(',') if x.strip()]
        return respond_json(self, {'ok': kv_clear(keys or None)})

    def log_message(self, fmt, *args):
        # 精简日志，忽略静态资源噪音
        if self.path.startswith('/api/'):
            sys.stderr.write('[api] %s\n' % (self.path))


if __name__ == '__main__':
    os.chdir(ROOT)
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)   # 绑定全部网卡，公网可直连
    print('[stock-trade] server running at http://127.0.0.1:%d' % PORT, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()