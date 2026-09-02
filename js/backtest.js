// backtest.js — 历史回测：用真实日K逐日回放当前策略库，验证买卖规则效果
// 引擎逻辑与实时自动交易一致（买入总资产1/20、资金不足调仓卖最差两只、部分止盈/清仓），
// 只在虚拟资金账本上运行，不写入真实 storage。
// 撮合口径：真实一年多的分钟级K线免费接口拉不全，故用每日真实 OHLC 合成 5 分钟分时路径，
// 盘中逐步评估策略（与实时系统一致：均线 = 历史日收盘 + 最新分时价），按分时价成交。
window.ST = window.ST || {};

(function (ST) {
  const WARM = 0;            // 均线预热由历史数据天然提供（拉取320个交易日）
  const DAY_MS = 86400000;
  const MAX_TRADE_LIST = 500; // 明细最多展示笔数

  function round2(x) { return Math.round(x * 100) / 100; }
  function stampOf(amount) { return round2(amount * (ST.TradeConfig.get().stampDutyRate || 0.0005)); }

  // 均线信息：{ma5,ma10,ma20,ma60}（数据不足为 null），供悬浮提示展示
  function maInfo(series) {
    const out = {};
    [5, 10, 20, 60].forEach(n => {
      if (series && series.length >= n) {
        const slice = series.slice(-n);
        out['ma' + n] = round2(slice.reduce((a, b) => a + b, 0) / n);
      } else {
        out['ma' + n] = null;
      }
    });
    return out;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------- 数据 ----------
  async function fetchKline(code) {
    const res = await fetch('/api/kline?code=' + encodeURIComponent(code));
    if (!res.ok) throw new Error('kline ' + res.status);
    const j = await res.json();
    if (!j || !j.closes || !j.closes.length) throw new Error('no kline data for ' + code);
    const r2 = v => Math.round(v * 100) / 100;
    return {
      code,
      dates: (j.dates || []).map(String),
      closes: (j.closes || []).map(r2),
      opens: (j.opens || []).map(r2),
      highs: (j.highs || []).map(r2),
      lows: (j.lows || []).map(r2)
    };
  }

  // ---------- 日内分时路径模拟 ----------
  // 基于每日真实 OHLC 用「布朗桥 + 波动噪声」合成 5 分钟分时路径（48 段）：
  // 起点=开盘、终点=收盘、盘中触及最高/最低；以 代码|日期 为随机种子，结果可复现。
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // 生成某日分时路径：长度 n+1（n 段），open→close，盘中触及 high/low
  function intradayPath(open, high, low, close, n, rng) {
    const p = new Array(n + 1);
    p[0] = open;
    const amp = Math.max(high - low, Math.abs(close - open), 1e-9);
    const sigma = amp * 0.5;
    // 布朗桥噪声（两端为 0）
    const z = new Array(n + 1); z[0] = 0; z[n] = 0;
    {
      let c = 0; const cum = [0];
      for (let i = 1; i <= n; i++) { c += gauss(rng); cum.push(c); }
      const total = cum[n];
      for (let i = 1; i < n; i++) z[i] = cum[i] - (i / n) * total;
    }
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      p[i] = open + (close - open) * t + sigma * z[i];
    }
    // 校准：把中间段的最小/最大拉伸到 low/high（端点 open/close 保持不动）
    let mn = Infinity, mx = -Infinity;
    for (let i = 1; i < n; i++) { if (p[i] < mn) mn = p[i]; if (p[i] > mx) mx = p[i]; }
    const spread = (mx - mn) || amp;
    const scale = amp / spread;
    for (let i = 1; i < n; i++) p[i] = low + (p[i] - mn) * scale;
    // 两端平滑：按权重把两端拉回 open/close 之间的线性目标（中部保留高低点）
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const w = (1 + Math.cos(Math.PI * t)) / 2;   // 两端≈1，中点≈0
      p[i] = p[i] + (open + (close - open) * t - p[i]) * w;
    }
    const pad = amp * 0.01;
    for (let i = 0; i <= n; i++) {
      p[i] = Math.max(low - pad, Math.min(high + pad, p[i]));
      p[i] = Math.round(p[i] * 10000) / 10000;
    }
    return p;
  }
  // 分时时间标签（A股 5 分钟：9:30-11:30、13:00-15:00，共 48 段）
  function timeOfStep(step) {
    const m = step <= 24 ? 570 + step * 5 : 780 + (step - 24) * 5;
    const hh = Math.floor(m / 60), mm = m % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  // ---------- 核心回放 ----------
  // stocks: [{code,name,dates,opens,highs,lows,closes}]  data: {cap, from, to, strategies}
  function runBacktest(stocks, data) {
    const cap = data.initialCapital;
    const N = 48;                       // 每天 5 分钟分时段数
    // 主时间轴：所有股票交易日并集
    const dateSet = new Set();
    stocks.forEach(s => (s.dates || []).forEach(d => dateSet.add(d)));
    const allDates = Array.from(dateSet).sort();
    if (allDates.length < 5) return null;

    const stockData = stocks.map(s => {
      const closeMap = new Map(), openMap = new Map(), highMap = new Map(), lowMap = new Map();
      (s.dates || []).forEach((d, i) => {
        closeMap.set(d, s.closes[i]);
        openMap.set(d, s.opens ? s.opens[i] : s.closes[i]);
        highMap.set(d, s.highs ? s.highs[i] : s.closes[i]);
        lowMap.set(d, s.lows ? s.lows[i] : s.closes[i]);
      });
      return { code: s.code, name: s.name, closeMap, openMap, highMap, lowMap };
    });
    const nameMap = new Map(stockData.map(sd => [sd.code, sd.name]));

    // 回测区间裁剪
    const from = data.from || allDates[0];
    const to = data.to || allDates[allDates.length - 1];
    let fromIdx = allDates.findIndex(d => d >= from);
    if (fromIdx < 0) fromIdx = allDates.length - 1;
    let toIdx = allDates.findIndex(d => d > to);
    toIdx = (toIdx < 0 ? allDates.length : toIdx) - 1;
    if (toIdx < fromIdx) toIdx = fromIdx;

    // 状态
    let cash = cap;
    const ops = [];                       // 回测操作记录（复用 ST.Holding.compute）
    const partial = new Map();            // code -> 本轮持仓是否已部分止盈
    const includeClose = new Map();       // code -> 回测起点纳入价
    const trades = [];
    const closesBefore = new Map();       // code -> 当日之前的历史日收盘序列（截至昨收）
    const lastPrice = new Map();
    stockData.forEach(sd => { closesBefore.set(sd.code, []); lastPrice.set(sd.code, null); });

    // 某日 OHLC（停牌/缺数据时回落昨收）
    function dayOHLC(sd, date) {
      const lp = lastPrice.get(sd.code);
      const o = sd.openMap.get(date), h = sd.highMap.get(date),
            l = sd.lowMap.get(date), c = sd.closeMap.get(date);
      const open = o != null ? o : lp;
      const close = c != null ? c : lp;
      const high = h != null ? h : (open != null ? open : lp);
      const low = l != null ? l : (open != null ? open : lp);
      return { open, high, low, close };
    }

    function makeVirtual(sd, price) {
      const hist = closesBefore.get(sd.code);
      const prev = hist.length ? hist[hist.length - 1] : price;
      const inc = includeClose.get(sd.code) || price;
      return {
        code: sd.code, name: sd.name, market: 'sh', currentPrice: price, prevClose: prev,
        series: hist.slice(-60).concat([price]), includeClose: inc,
        cumChangePct: inc > 0 ? (price - inc) / inc * 100 : 0,
        partialDone: !!partial.get(sd.code)
      };
    }
    function currentStockVal(virtuals) {
      let v = 0;
      virtuals.forEach(vv => { v += ST.Holding.compute(vv, ops).marketValue; });
      return v;
    }
    function makeOp(sd, type, price, qty, amount, fee, stamp, date, step, note) {
      const base = +new Date(date.replace(/-/g, '/'));
      return { code: sd.code, name: sd.name, type, price, qty, amount, fee, stamp, note,
        time: timeOfStep(step), ts: base + step * 5 * 60000 };
    }

    // 资金不足调仓：卖持仓中浮动盈亏率最差的两只，各腾出 ≥ need（100股整数倍，不足清仓）
    function shiftFund(dayData, stepVirtuals, need, date, step) {
      const picks = dayData
        .map(({ sd, path }, idx) => ({
          v: stepVirtuals[idx],
          h: ST.Holding.compute(stepVirtuals[idx], ops),
          price: path[step]
        }))
        .filter(p => p.h.qty > 0)
        .sort((a, b) => (a.h.pnlPct - b.h.pnlPct) || a.v.code.localeCompare(b.v.code))
        .slice(0, 2);
      let raised = 0;
      picks.forEach(({ v, h, price }) => {
        let qty = Math.ceil((need / price) / 100) * 100;
        if (qty > h.qty) qty = h.qty;
        if (!(qty > 0)) return;
        const amount = round2(price * qty);
        const fee = ST.TradeConfig.sellFee(amount);
        const stamp = stampOf(amount);
        const avg = h.avgCost;
        const note = '调仓卖出（盈利最差）';
        cash += amount - fee - stamp;
        ops.push(makeOp(v, 'sell', price, qty, amount, fee, stamp, date, step, note));
        trades.push({ date, time: timeOfStep(step), code: v.code, name: v.name, type: 'sell', price, qty, amount, fee, stamp,
          realizedPnl: (price - avg) * qty - fee - stamp, note, ma: maInfo(v.series) });
        raised += amount;
      });
      return raised;
    }

    // 均线预热：先积累回测起点之前的日收盘，使 MA60 等有足够历史
    for (let j = 0; j < fromIdx; j++) {
      const date = allDates[j];
      stockData.forEach(sd => {
        const c = sd.closeMap.get(date);
        const px = c != null ? c : (lastPrice.get(sd.code) != null ? lastPrice.get(sd.code) : 0);
        closesBefore.get(sd.code).push(px);
        lastPrice.set(sd.code, px);
      });
    }

    // 逐日回放（日内分时撮合）
    const curve = [];
    for (let i = fromIdx; i <= toIdx; i++) {
      const date = allDates[i];
      if (i === fromIdx) {
        // 记录纳入价 = 回测起点当天收盘
        stockData.forEach(sd => {
          const c = sd.closeMap.get(date);
          includeClose.set(sd.code, c != null ? c : (lastPrice.get(sd.code) || 0));
        });
      }
      // 生成当日分时路径（种子 = 代码|日期，可复现）
      const dayData = stockData.map(sd => {
        const oh = dayOHLC(sd, date);
        const rng = mulberry32(hashStr(sd.code + '|' + date));
        const path = intradayPath(oh.open, oh.high, oh.low, oh.close, N, rng);
        return { sd, path };
      });

      const doneToday = new Map();       // code -> Set<action>（每个动作每天每股票最多一次）

      // 盘中逐步撮合
      for (let step = 0; step <= N; step++) {
        let dayShiftDone = false;        // 每步（≈每5分钟）最多调仓一次，与实时系统口径一致
        const stepVirtuals = dayData.map(({ sd, path }) => makeVirtual(sd, path[step]));
        dayData.forEach(({ sd, path }, idx) => {
          const price = path[step];
          if (!(price > 0)) return;
          const virtual = stepVirtuals[idx];
          const ev = ST.Strategy.evaluate(virtual, data.strategies, ops);
          if (!ev.action) return;
          let done = doneToday.get(sd.code);
          if (!done) { done = new Set(); doneToday.set(sd.code, done); }
          if (done.has(ev.action)) return;       // 当日同类型动作只执行一次
          const h = ST.Holding.compute(virtual, ops);

          if (ev.action === 'buy') {
            if ((h.qty || 0) > 0) return;        // 已持仓不再重复买入
            const totalAsset = cash + currentStockVal(stepVirtuals);
            const x = totalAsset / 20;           // 买入金额 = 总资产 1/20
            let buyAmount = x;
            if (cash < x - 1e-9) {
              if (!dayShiftDone) { shiftFund(dayData, stepVirtuals, x / 2, date, step); dayShiftDone = true; }
              buyAmount = Math.min(x, cash);
            }
            let qty = Math.floor(buyAmount / price / 100) * 100;
            if (!(qty > 0)) return;              // 买不起一手则跳过
            const amount = round2(price * qty);
            const fee = ST.TradeConfig.buyFee(amount);
            const sName = (ev.hits.buy && ev.hits.buy.name) || '策略';
            const note = '买入策略【' + sName + '】建仓（1/20仓位）';
            cash -= amount + fee;
            ops.push(makeOp(virtual, 'buy', price, qty, amount, fee, 0, date, step, note));
            partial.set(virtual.code, false);    // 新一轮持仓，重新武装部分止盈
            done.add('buy');
            trades.push({ date, time: timeOfStep(step), code: virtual.code, name: virtual.name, type: 'buy', price, qty, amount, fee, stamp: 0, note, ma: maInfo(virtual.series) });
          } else if (ev.action === 'sell_partial') {
            if (h.qty <= 0) return;
            const ratio = (ev.hits.sell_partial && ev.hits.sell_partial.params && ev.hits.sell_partial.params.ratio) || 0.3;
            let qty = Math.floor((h.qty * ratio / 100)) * 100;
            if (!(qty > 0)) qty = h.qty;
            const amount = round2(price * qty);
            const fee = ST.TradeConfig.sellFee(amount);
            const stamp = stampOf(amount);
            const avg = h.avgCost;
            const sName = (ev.hits.sell_partial && ev.hits.sell_partial.name) || '策略';
            const note = '部分止盈策略【' + sName + '】卖约' + Math.round(ratio * 100) + '%';
            cash += amount - fee - stamp;
            ops.push(makeOp(virtual, 'sell', price, qty, amount, fee, stamp, date, step, note));
            partial.set(virtual.code, true);     // 本轮已部分止盈，剩余继续持有
            done.add('sell_partial');
            trades.push({ date, time: timeOfStep(step), code: virtual.code, name: virtual.name, type: 'sell', price, qty, amount, fee, stamp,
              realizedPnl: (price - avg) * qty - fee - stamp, note, ma: maInfo(virtual.series) });
          } else if (ev.action === 'sell_all') {
            if (h.qty <= 0) return;
            const qty = h.qty;
            const amount = round2(price * qty);
            const fee = ST.TradeConfig.sellFee(amount);
            const stamp = stampOf(amount);
            const avg = h.avgCost;
            const sName = (ev.hits.sell_all && ev.hits.sell_all.name) || '策略';
            const note = '清仓策略【' + sName + '】清仓卖出';
            cash += amount - fee - stamp;
            ops.push(makeOp(virtual, 'sell', price, qty, amount, fee, stamp, date, step, note));
            done.add('sell_all');
            trades.push({ date, time: timeOfStep(step), code: virtual.code, name: virtual.name, type: 'sell', price, qty, amount, fee, stamp,
              realizedPnl: (price - avg) * qty - fee - stamp, note, ma: maInfo(virtual.series) });
          }
        });
      }

      // 日终：把当日收盘并入历史序列（供次日/盘中均线使用），并更新最新价
      stockData.forEach(sd => {
        const oh = dayOHLC(sd, date);
        const c = oh.close != null ? oh.close : (lastPrice.get(sd.code) || 0);
        closesBefore.get(sd.code).push(c);
        lastPrice.set(sd.code, c);
      });

      // 记录当日资产曲线（按收盘价估值）
      const virtuals = stockData.map(sd => makeVirtual(sd, lastPrice.get(sd.code)));
      const asset = cash + currentStockVal(virtuals);
      curve.push({ date, asset, pct: cap > 0 ? (asset - cap) / cap * 100 : 0 });
    }

    if (!curve.length) return null;

    // ---------- 统计 ----------
    const finalAsset = curve[curve.length - 1].asset;
    const totalRet = cap > 0 ? (finalAsset - cap) / cap * 100 : 0;
    const nDays = curve.length;
    const annualRet = (cap > 0 && finalAsset > 0 && nDays > 1)
      ? (Math.pow(finalAsset / cap, 252 / nDays) - 1) * 100 : 0;
    let peak = -Infinity, maxDrawdown = 0;
    curve.forEach(c => { peak = Math.max(peak, c.asset); if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - c.asset) / peak * 100); });
    const sells = trades.filter(t => t.type === 'sell');
    const wins = sells.filter(t => (t.realizedPnl || 0) > 0).length;
    const buyCount = trades.filter(t => t.type === 'buy').length;
    const sellCount = sells.length;
    const winRate = sellCount ? wins / sellCount * 100 : 0;

    return {
      dates: curve.map(c => c.date),
      portPct: curve.map(c => c.pct),
      totalRet, annualRet, maxDrawdown, winRate,
      buyCount, sellCount, tradeCount: trades.length,
      initialCapital: cap, finalAsset, nDays,
      trades, stocks: stockData.map(sd => ({ code: sd.code, name: nameMap.get(sd.code) }))
    };
  }

  // ---------- 沪深300 基准（按回测日期对齐） ----------
  function alignIndex(index, dates, from) {
    const series = (index.dates || []).map((s, i) => ({ t: +new Date(String(s).replace(/-/g, '/')), c: index.closes[i] }));
    const start0 = +new Date(from.replace(/-/g, '/'));
    let base = 0, idx = 0;
    for (let i = 0; i < series.length; i++) { if (series[i].t >= start0) { base = series[i].c; break; } }
    if (!(base > 0)) base = series.length ? series[series.length - 1].c : 1;
    const out = [];
    dates.forEach(d => {
      const t = +new Date(d.replace(/-/g, '/'));
      while (idx < series.length && series[idx].t <= t + DAY_MS) idx++;
      let j = idx - 1; while (j >= 0 && series[j].t > t) j--;
      const c = j >= 0 ? series[j].c : base;
      out.push(((c / base) - 1) * 100);
    });
    return out;
  }

  // ---------- 绘图（与资产分析图风格一致） ----------
  function drawChart(canvas, data) {
    if (!canvas || !data || !data.port || data.port.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = data.port.length;
    let lo = 0, hi = 0;
    data.port.concat(data.hsi).forEach(v => { if (v < lo) lo = v; if (v > hi) hi = v; });
    const span = (hi - lo) || 1;
    lo -= span * 0.1; hi += span * 0.1; const rng = hi - lo;

    const padL = 52, padR = 14, padT = 14, padB = 24;
    const xAt = i => padL + (i / (n - 1)) * (w - padL - padR);
    const yAt = v => padT + (1 - (v - lo) / rng) * (h - padT - padB);

    ctx.font = '10px sans-serif';
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
    const y0 = yAt(0);
    if (y0 > padT && y0 < h - padB) {
      ctx.strokeStyle = 'rgba(155,166,196,.35)'; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(w - padR, y0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(155,166,196,.7)'; ctx.textAlign = 'right';
      ctx.fillText('0%', padL - 4, y0 + 3);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      const v = hi - (i / 4) * rng;
      ctx.fillStyle = '#6b7798'; ctx.textAlign = 'right';
      ctx.fillText(Math.round(v) + '%', padL - 6, y + 3);
    }
    ctx.fillStyle = '#6b7798'; ctx.textAlign = 'center';
    const tickIdx = n <= 12 ? null : Math.ceil(n / 6);
    for (let i = 0; i < n; i++) {
      if (tickIdx && i % tickIdx !== 0) continue;
      const lb = data.labels[i] || '';
      ctx.fillText(lb.length > 10 ? lb.slice(2) : lb, xAt(i), h - 8);
    }
    // 沪深300 虚线
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = '#ffb020'; ctx.lineWidth = 1.6; ctx.beginPath();
    data.hsi.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.setLineDash([]);
    // 组合实线
    ctx.strokeStyle = '#4aa8ff'; ctx.lineWidth = 2.4; ctx.beginPath();
    data.port.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.fillStyle = '#4aa8ff'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(data.port[n - 1].toFixed(2) + '%', xAt(n - 1) + 5, yAt(data.port[n - 1]) - 4);
    ctx.fillStyle = '#ffb020';
    ctx.fillText(data.hsi[n - 1].toFixed(2) + '%', xAt(n - 1) + 5, yAt(data.hsi[n - 1]) + 12);
  }

  // ---------- 页面渲染 ----------
  function fmtDate(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function fmtMoney(v) {
    if (!isFinite(v)) return '0.00';
    const s = v >= 0 ? '' : '-';
    const a = Math.abs(v);
    return s + (a >= 10000 ? (a / 10000).toFixed(2) + '万' : a.toFixed(2));
  }

  // 填充股票多选列表（默认全选）
  function renderConfig() {
    const stocks = (ST.App && ST.App.getStocks()) || [];
    const wrap = document.getElementById('btStockList');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!stocks.length) {
      wrap.innerHTML = '<div class="bt-empty">暂无跟踪股票，请先在「跟踪系统」添加股票。</div>';
      return;
    }
    stocks.forEach(s => {
      const label = document.createElement('label');
      label.className = 'bt-stock-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = s.code; cb.checked = true;
      cb.className = 'bt-stock-cb';
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = s.name + ' (' + s.code + ')';
      label.appendChild(span);
      wrap.appendChild(label);
    });
    // 默认区间：近一年；初始资金：沿用设置
    const now = new Date();
    const from = new Date(now.getTime() - 365 * DAY_MS);
    document.getElementById('btFrom').value = fmtDate(from);
    document.getElementById('btTo').value = fmtDate(now);
    const cap = (ST.PortfolioConfig && ST.PortfolioConfig.get().initialCapital) || 1000000;
    document.getElementById('btCapital').value = cap;
    document.getElementById('btLoading').hidden = true;
    document.getElementById('btResult').hidden = true;
  }

  async function run() {
    const cbs = Array.prototype.slice.call(document.querySelectorAll('#btStockList .bt-stock-cb'))
      .filter(cb => cb.checked);
    if (!cbs.length) { ST.UI.toast('请至少选择一只股票', 'warn'); return; }
    const codes = cbs.map(cb => cb.value);
    const cap = parseFloat(document.getElementById('btCapital').value) || 1000000;
    const from = document.getElementById('btFrom').value;
    const to = document.getElementById('btTo').value;
    const strategies = (ST.Storage && ST.Storage.getStrategies()) || [];

    const loading = document.getElementById('btLoading');
    const result = document.getElementById('btResult');
    loading.hidden = false; loading.textContent = '正在拉取历史K线并回放策略（日内分时撮合）…';
    result.hidden = true;

    try {
      // 逐只拉取：单只无历史K线时跳过并提示，不阻塞整体回测
      const klines = [];
      const skipped = [];
      for (const code of codes) {
        try { klines.push(await fetchKline(code)); }
        catch (e) { skipped.push(code); }
      }
      if (skipped.length) {
        ST.UI.toast('以下股票暂无历史K线数据，已跳过：' + skipped.join(', '), 'warn');
      }
      if (!klines.length) throw new Error('没有可用的K线数据');
      // 注入名称（/api/kline 不返回名称，从跟踪池补齐）
      const allStocks = (ST.App && ST.App.getStocks()) || [];
      const nameMap = new Map(allStocks.map(s => [s.code, s.name]));
      klines.forEach(k => { k.name = nameMap.get(k.code) || k.code; });
      const res = runBacktest(klines, { initialCapital: cap, from, to, strategies });
      if (!res) throw new Error('区间内没有可回测的交易日');
      // 沪深300基准
      let hsi = null;
      try { hsi = await ST.Market.getIndex(); } catch (e) { hsi = null; }
      renderResult(res, hsi);
    } catch (e) {
      loading.hidden = true;
      ST.UI.toast('回测失败：' + (e && e.message ? e.message : e), 'error');
    }
  }

  function renderResult(res, index) {
    const result = document.getElementById('btResult');
    result.hidden = false;
    const loading = document.getElementById('btLoading');
    loading.hidden = true;

    // 统计卡
    document.getElementById('btRet').textContent = res.totalRet.toFixed(2) + '%';
    document.getElementById('btRet').className = 'stat-value ' + (res.totalRet >= 0 ? 'up' : 'down');
    document.getElementById('btAnnual').textContent = (res.annualRet || 0).toFixed(2) + '%';
    document.getElementById('btAnnual').className = 'stat-value ' + (res.annualRet >= 0 ? 'up' : 'down');
    document.getElementById('btMaxDD').textContent = res.maxDrawdown.toFixed(2) + '%';
    document.getElementById('btWinRate').textContent = res.winRate.toFixed(1) + '%';
    document.getElementById('btTradeCount').textContent = res.tradeCount;
    document.getElementById('btBuyCount').textContent = res.buyCount;
    document.getElementById('btSellCount').textContent = res.sellCount;
    document.getElementById('btRange').textContent =
      (res.dates[0] || '') + ' 至 ' + (res.dates[res.dates.length - 1] || '') + '（' + res.nDays + ' 个交易日）';
    document.getElementById('btInitCap').textContent = fmtMoney(res.initialCapital);
    document.getElementById('btFinalAsset').textContent = fmtMoney(res.finalAsset);
    const diff = res.finalAsset - res.initialCapital;
    document.getElementById('btPnl').textContent = (diff >= 0 ? '+' : '-') + fmtMoney(Math.abs(diff));
    document.getElementById('btPnl').className = diff >= 0 ? 'up' : 'down';

    // 图表
    const chart = document.getElementById('btChart');
    const labels = res.dates.map(d => {
      const p = d.split('-');
      return p[1] + '/' + p[2];
    });
    const data = { labels, port: res.portPct, hsi: [] };
    if (index) {
      try { data.hsi = alignIndex(index, res.dates, res.dates[0]); } catch (e) { data.hsi = res.portPct.map(() => 0); }
    } else {
      data.hsi = res.portPct.map(() => 0);
    }
    setTimeout(() => drawChart(chart, data), 30);

    // 交易明细
    const list = document.getElementById('btTrades');
    list.innerHTML = '';
    const rows = res.trades.slice(-MAX_TRADE_LIST);
    if (!rows.length) {
      list.innerHTML = '<div class="bt-empty">区间内未产生交易。</div>';
      return;
    }
    rows.forEach(t => {
      const tr = document.createElement('tr');
      const isBuy = t.type === 'buy';
      const maData = JSON.stringify({ name: t.name, code: t.code, date: t.date, time: t.time, ma: t.ma || {} });
      tr.innerHTML =
        '<td>' + t.date + (t.time ? ' <span class="bt-time">' + t.time + '</span>' : '') + '</td>' +
        '<td><span class="bt-code" data-tip="' + escapeHtml(maData) + '">' + escapeHtml(t.name) + ' (' + t.code + ')</span></td>' +
        '<td class="' + (isBuy ? 'up' : 'down') + '">' + (isBuy ? '买入' : '卖出') + '</td>' +
        '<td>' + t.qty + '</td>' +
        '<td>' + t.price.toFixed(2) + '</td>' +
        '<td>' + fmtMoney(t.amount) + '</td>' +
        '<td>' + (isBuy ? '—' : (t.realizedPnl >= 0 ? '+' : '-') + fmtMoney(Math.abs(t.realizedPnl))) + '</td>' +
        '<td>' + (t.note || '') + '</td>';
      list.appendChild(tr);
    });
    if (res.trades.length > MAX_TRADE_LIST) {
      const tip = document.createElement('div');
      tip.className = 'bt-empty';
      tip.textContent = '仅展示最近 ' + MAX_TRADE_LIST + ' 笔，共 ' + res.trades.length + ' 笔。';
      list.appendChild(tip);
    }
  }

  // ---------- MA 悬浮提示 ----------
  const tipEl = document.createElement('div');
  tipEl.className = 'bt-tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);

  function buildTipHTML(d) {
    const ma = d.ma || {};
    const rows = [5, 10, 20, 60].map(n => {
      const v = ma['ma' + n];
      return '<tr><td>MA' + n + '</td><td>' + (v == null ? '—' : v.toFixed(2)) + '</td></tr>';
    }).join('');
    return '<div class="bt-tip-title">' + escapeHtml(d.name + ' ' + d.code) +
      '<span>' + escapeHtml(d.date + (d.time ? ' ' + d.time : '')) + '</span></div>' +
      '<div class="bt-tip-label">当日均线</div>' +
      '<table class="bt-tip-ma"><tbody>' + rows + '</tbody></table>';
  }

  function showTip(el, data) {
    const rect = el.getBoundingClientRect();
    tipEl.innerHTML = buildTipHTML(data);
    tipEl.hidden = false;
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    left = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
    let top = rect.top - th - 8;
    if (top < 8) top = rect.bottom + 8;
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
  }
  function hideTip() { tipEl.hidden = true; }

  document.addEventListener('mouseover', e => {
    const el = e.target && e.target.closest ? e.target.closest('.bt-code') : null;
    if (el && el.dataset.tip) {
      try { showTip(el, JSON.parse(el.dataset.tip)); } catch (err) { hideTip(); }
    }
  });
  document.addEventListener('mouseout', e => {
    const el = e.target && e.target.closest ? e.target.closest('.bt-code') : null;
    if (el) hideTip();
  });
  // 容器滚动/窗口尺寸变化时隐藏，避免提示错位
  window.addEventListener('scroll', hideTip, true);
  window.addEventListener('resize', hideTip);

  ST.Backtest = { run, renderConfig, renderResult, drawChart };
})(window.ST);
