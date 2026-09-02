// server.js — 股票交易跟踪系统：静态托管 + 行情代理
// 运行：node server.js  （默认端口 8081）
// 说明：
//  - 前端浏览器直接请求腾讯/新浪行情会被 CORS 拦截，且新浪需 Referer、腾讯为 GBK 编码。
//  - 本服务在服务端转发「东方财富」UTF-8 JSON 行情接口，绕过 CORS 并避免编码问题；
//  - 完全使用 Node 内置模块，无第三方依赖。
//
// 端点：
//   GET /api/quote?code=600519   -> 实时行情 {code,name,price,prevClose,change,changePct}
//   GET /api/kline?code=600519   -> 日 K 收盘序列 {code,closes:[...],pctCum:[...]}
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8081;
const ROOT = __dirname;

// 东财 secid 前缀：沪市(6) -> 1.，深市(0/3) -> 0.，北交所(4/8) -> 0.
function secid(code) {
  code = String(code).trim();
  const a = code.charAt(0);
  return (a === '6' ? '1.' : '0.') + code;
}

// 底层 https GET（返回文本）
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://quote.eastmoney.com/'
      }
    }, (res) => {
      let raw = Buffer.alloc(0);
      res.on('data', (c) => { raw = Buffer.concat([raw, c]); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { resolve(JSON.parse(raw.toString('utf8'))); }
        catch (e) { reject(new Error('bad json from eastmoney')); }
      });
    }).on('error', reject);
  });
}

// 实时行情
async function fetchQuote(code) {
  const sid = secid(code);
  const url = 'https://push2.eastmoney.com/api/qt/stock/get' +
    '?secid=' + encodeURIComponent(sid) +
    '&fields=f57,f58,f43,f60,f169,f170&invt=2&fltt=2';
  const j = await httpsGet(url);
  const d = j && j.data ? j.data : null;
  if (!d || d.f57 == null) throw new Error('no data for ' + code);
  return {
    code: String(d.f57),
    name: d.f58 || '',
    price: d.f43,
    prevClose: d.f60,
    change: d.f169,
    changePct: d.f170
  };
}

// 日 K 线（前复权），返回收盘序列（从早到晚）与累计涨跌%
async function fetchKline(code) {
  const sid = secid(code);
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' + encodeURIComponent(sid) +
    '&klt=101&fqt=1&beg=0&end=20500101&lmt=150' +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57';
  const j = await httpsGet(url);
  const d = j && j.data ? j.data : null;
  if (!d || !Array.isArray(d.klines)) throw new Error('no kline for ' + code);
  const closes = [];
  for (const line of d.klines) {
    const p = line.split(',');
    // [0]date [1]open [2]close [3]high [4]low [5]vol [6]amount
    closes.push(parseFloat(p[2]));
  }
  const base = closes[0] || 0;
  const pctCum = closes.map(c => base ? Math.round((c - base) / base * 10000) / 100 : 0);
  return { code: String(d.code), closes, pctCum };
}

function json(res, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function jsonErr(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: msg }));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // ---- API：实时行情 ----
  if (p === '/api/quote') {
    const code = (u.searchParams.get('code') || '').trim();
    const codes = (u.searchParams.get('codes') || code || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!codes.length) return jsonErr(res, 400, 'missing code');
    const out = [];
    for (const c of codes) {
      if (out.length >= 30) break;
      try { out.push(await fetchQuote(c)); } catch (e) { /* 单只失败跳过 */ }
    }
    return json(res, { ok: true, quotes: out });
  }

  // ---- API：日 K 线 ----
  if (p === '/api/kline') {
    const code = (u.searchParams.get('code') || '').trim();
    if (!code) return jsonErr(res, 400, 'missing code');
    try { return json(res, await fetchKline(code)); }
    catch (e) { return jsonErr(res, 502, 'kline fetch failed: ' + e.message); }
  }

  // ---- 静态文件 ----
  let file = p === '/' ? '/index.html' : p;
  if (file.indexOf('..') !== -1) { res.writeHead(403); return res.end('forbidden'); }
  const full = path.join(ROOT, file);
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log('[stock-trade] server running at http://127.0.0.1:' + PORT);
});