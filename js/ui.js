// ui.js — 渲染层（列表、统计、研究弹窗、图表）
window.ST = window.ST || {};

(function (ST) {
  function fmtPrice(p) { return p == null || isNaN(p) ? "—" : Number(p).toFixed(2); }
  function signPct(p) {
    if (p == null || isNaN(p)) return "—";
    const s = p > 0 ? "+" : "";
    return s + p.toFixed(2) + "%";
  }
  function cls(p) {
    if (p == null || isNaN(p)) return "flat";
    if (p > 0.0001) return "up";
    if (p < -0.0001) return "down";
    return "flat";
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  const SIGNAL_TEXT = { buy: "买入", hold: "持有", watch: "观望", sell: "卖出" };
  let chartWindow = 90;   // 研究弹窗 K 线窗口（90/180 日），跨打开保持

  // 渲染列表（batch=true 时显示勾选列，用于批量移除）
  function renderTable(stocks, strat, sortState) {
    const tbody = document.getElementById("stockTbody");
    const batch = ST.UI.batch === true;
    // 表头勾选列：批量模式下显示全选框
    const thSel = document.getElementById("thBatchSel");
    if (thSel) thSel.innerHTML = batch ? '<input type="checkbox" id="checkAll" title="全选">' : "";
    if (!stocks.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="16">暂无跟踪股票，点击「+ 添加股票」开始。</td></tr>';
      updateSortIndicators(sortState);
      return;
    }
    const ops = ST.Storage ? ST.Storage.getOperations() : [];
    const rows = stocks.map(s => {
      const sig = ST.Strategy.evaluate(s);
      const todayCls = cls(s.todayChangePct);
      const cumCls = cls(s.cumChangePct);
      const sigClass = "signal-" + sig.signal;
      const h = ST.Holding ? ST.Holding.compute(s, ops) : { qty: 0, avgCost: 0, pnl: 0, pnlPct: 0, marketValue: 0 };
      const pnlCls = cls(h.pnlPct);
      const checkTd = batch
        ? `<td class="chk-cell"><input type="checkbox" class="row-check" data-id="${esc(s.id)}"></td>`
        : '<td class="chk-cell"></td>';
      return `
      <tr data-id="${esc(s.id)}">
        ${checkTd}
        <td>
          <span class="stock-code">${esc(s.code)}</span><span class="stock-market">${esc(s.market)}</span>
          <span class="stock-name">${esc(s.name)}</span>
        </td>
        <td class="price">${fmtPrice(s.currentPrice)}</td>
        <td class="${todayCls}">${signPct(s.todayChangePct)}<br><span style="font-size:11px;opacity:.8">${s.todayChange >= 0 ? "+" : ""}${fmtPrice(s.todayChange)}</span></td>
        <td><span class="signal ${sigClass} basis-tip" title="${esc(sig.basis)}">${SIGNAL_TEXT[sig.signal]}</span></td>
        <td class="price">${h.qty || 0}</td>
        <td class="price">${fmtPrice(h.avgCost)}</td>
        <td class="${pnlCls}">${h.qty > 0 ? signPct(h.pnlPct) : "—"}</td>
        <td class="${pnlCls}">${h.qty > 0 ? (h.pnl >= 0 ? "+" : "") + fmtPrice(h.pnl) : "—"}</td>
        <td class="price">${fmtPrice(h.marketValue)}</td>
        <td>${(s.position || 0).toFixed(0)}%</td>
        <td>${fmtPrice(s.includeClose)}</td>
        <td class="${cumCls}">${signPct(s.cumChangePct)}<br><span style="font-size:11px;opacity:.8">${s.cumChange >= 0 ? "+" : ""}${fmtPrice(s.cumChange)}</span></td>
        <td>${esc(s.includeDate)}</td>
        <td><span class="concept" title="${esc(s.concept)}">${esc(s.concept)}</span></td>
        <td style="text-align:left">
          <button class="btn btn-sm btn-research" data-act="research">研究</button>
          <button class="btn btn-sm btn-edit" data-act="edit">编辑</button>
          <button class="btn btn-sm btn-remove" data-act="remove">移除</button>
        </td>
      </tr>`;
    }).join("");
    tbody.innerHTML = rows;
    updateSortIndicators(sortState);
  }

  // 更新表头排序指示
  function updateSortIndicators(st) {
    const ths = document.querySelectorAll("#stockTable thead th.sortable");
    ths.forEach(th => {
      th.classList.remove("sort-asc", "sort-desc");
      const ind = th.querySelector(".sort-ind");
      if (ind) ind.textContent = "";
      if (st && st.key && st.key !== "_default" && th.getAttribute("data-sort") === st.key) {
        th.classList.add(st.dir >= 0 ? "sort-asc" : "sort-desc");
        if (ind) ind.textContent = st.dir >= 0 ? "▲" : "▼";
      }
    });
  }

  // 组合资产计算：总资产 / 仓位和 / 持仓数（供统计卡与买卖提醒复用）
  function computeAssets(stocks) {
    const count = stocks.length;
    const cap = (ST.PortfolioConfig && ST.PortfolioConfig.get().initialCapital) || 0;
    const totalPos = stocks.reduce((a, s) => a + (s.position || 0), 0);
    const cashPool = cap * Math.max(0, 1 - totalPos / 100);
    let stockVal = 0;
    let stockValPrev = 0;
    stocks.forEach(s => {
      const alloc = cap * (s.position || 0) / 100;
      if (alloc <= 0 || !s.includeClose) return;
      stockVal += alloc * (s.currentPrice / s.includeClose);
      stockValPrev += alloc * ((s.prevClose || s.currentPrice) / s.includeClose);
    });
    const totalAsset = cashPool + stockVal;
    const totalAssetPrev = cashPool + stockValPrev;
    let holdCount = 0;
    if (ST.Holding && ST.Storage) {
      const ops = ST.Storage.getOperations();
      stocks.forEach(s => { if (ST.Holding.compute(s, ops).qty > 0) holdCount++; });
    } else {
      holdCount = count;
    }
    const cumPct = cap > 0 ? (totalAsset - cap) / cap * 100 : 0;
    const todayPct = totalAssetPrev > 0 ? (totalAsset - totalAssetPrev) / totalAssetPrev * 100 : 0;
    return { count, totalPos, totalAsset, holdCount, cumPct, todayPct };
  }

  // 渲染统计概览
  function renderStats(stocks) {
    const a = computeAssets(stocks);
    setVal("statCount", a.count);
    setVal("statHoldCount", a.holdCount);
    setVal("statPosition", a.totalPos.toFixed(0) + "%", a.totalPos > 100 ? "down" : "flat");
    setVal("statTotalAsset", "¥" + fmtAsset(a.totalAsset));
    setVal("statReturn", signPct(a.cumPct), cls(a.cumPct));
    setVal("statToday", signPct(a.todayPct), cls(a.todayPct));
  }

  function fmtAsset(v) {
    if (!isFinite(v)) return "0.00";
    return v >= 10000 ? (v / 10000).toFixed(2) + "万" : v.toFixed(2);
  }

  function setVal(id, val, colorCls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.classList.remove("up", "down", "flat");
    if (colorCls) el.classList.add(colorCls);
  }

  // 研究：K 线蜡烛图绘制（红涨绿跌，中国惯例；叠加均线与当前价标记）
  function drawChart(canvas, stock, strat, windowDays) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const allCloses = (stock.dailyCloses || stock.series || []).slice();
    if (!allCloses.length) return;
    const allOpens = (stock.dailyOpens || allCloses).slice();
    const allHighs = (stock.dailyHighs || allCloses).slice();
    const allLows = (stock.dailyLows || allCloses).slice();

    // 只显示最近 WINDOW 根，避免过密（可切换 90/180）
    const WINDOW = Math.min(windowDays || 90, allCloses.length);
    const start = Math.max(0, allCloses.length - WINDOW);
    const closes = allCloses.slice(start);

    // 历史 K 线（窗口内）；prevClose 用于一字/十字线按相对昨收判定红绿
    const candles = closes.map((c, i) => {
      const g = start + i;
      const prev = i > 0 ? closes[i - 1] : (start > 0 ? allCloses[start - 1] : null);
      return { open: allOpens[g], close: c, high: allHighs[g], low: allLows[g], prevClose: prev };
    });
    // 今日动态 K 线：历史最后一根不是今天则追加一根；否则实时刷新最后一根
    const dates = stock.dailyDates || [];
    const lastDate = dates.length ? dates[dates.length - 1] : "";
    if (lastDate === ST.Market.todayStr()) {
      const last = candles[candles.length - 1];
      last.open = stock.todayOpen || last.open;
      last.close = stock.currentPrice;
      last.high = Math.max(last.high, stock.todayHigh || -1e9, stock.currentPrice);
      last.low = Math.min(last.low, stock.todayLow || 1e9, stock.currentPrice);
    } else {
      const prev = closes[closes.length - 1];
      const o = stock.todayOpen || prev;
      const c = stock.currentPrice;
      candles.push({
        open: o, close: c,
        high: Math.max(o, c, stock.todayHigh || -1e9),
        low: Math.min(o, c, stock.todayLow || 1e9),
        prevClose: prev
      });
    }

    const padL = 8, padR = 56, padT = 12, padB = 20;
    let min = Infinity, max = -Infinity;
    for (const k of candles) {
      if (k.high > max) max = k.high;
      if (k.low < min) min = k.low;
    }
    const span = (max - min) || 1;
    const lo = min - span * 0.08, hi = max + span * 0.08;
    const rng = hi - lo;
    const n = candles.length;
    const step = (w - padL - padR) / n;
    const xAt = i => padL + step * i + step / 2;
    const yAt = v => padT + (1 - (v - lo) / rng) * (h - padT - padB);
    const bodyW = Math.max(3, step * 0.62);

    // 网格
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    }

    // 均线（基于完整日收盘序列，与交易软件口径一致；映射到窗口坐标）
    function drawMA(period, color) {
      const pts = [];
      for (let wi = 0; wi < closes.length; wi++) {
        const g = start + wi;
        if (g < period - 1) continue;
        let sum = 0;
        for (let j = g - period + 1; j <= g; j++) sum += allCloses[j];
        pts.push([xAt(wi), yAt(sum / period)]);
      }
      if (!pts.length) return;
      ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      ctx.stroke();
    }
    drawMA(strat.shortMA, "#ffb020");
    drawMA(strat.midMA, "#4aa8ff");
    drawMA(strat.longMA, "#b388ff");

    // 蜡烛（红涨绿跌）；一字/十字线（open==close）按相对昨收涨跌判定颜色
    const UP = "#ff4d4f", DOWN = "#27c93f";
    const isUp = k => k.close > k.open
      ? true
      : (k.close < k.open ? false : (k.prevClose != null && k.close > k.prevClose));
    candles.forEach((k, i) => {
      const x = xAt(i);
      const up = isUp(k);
      const color = up ? UP : DOWN;
      // 影线
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yAt(k.high)); ctx.lineTo(x, yAt(k.low)); ctx.stroke();
      // 实体
      const yO = yAt(k.open), yC = yAt(k.close);
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yO - yC));
      ctx.fillStyle = color;
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
      if (up) { ctx.strokeRect(x - bodyW / 2, top, bodyW, bh); }
    });

    // 当前价标记（最后一根 K 右侧）
    const lastK = candles[n - 1];
    const lastY = yAt(lastK.close);
    ctx.fillStyle = isUp(lastK) ? UP : DOWN;
    ctx.beginPath(); ctx.arc(xAt(n - 1), lastY, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.font = "11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(stock.currentPrice.toFixed(2), xAt(n - 1) + 6, lastY + 4);

    // 纳入价参考线
    if (stock.includeClose >= lo && stock.includeClose <= hi) {
      const iy = yAt(stock.includeClose);
      ctx.strokeStyle = "rgba(155,166,196,.5)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, iy); ctx.lineTo(w - padR, iy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(155,166,196,.8)"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
      ctx.fillText("纳入 " + stock.includeClose.toFixed(2), w - padR - 2, iy - 4);
    }
  }

  // 研究弹窗内容
  function renderResearch(stock, strat) {
    document.getElementById("researchTitle").textContent = `${stock.name} (${stock.market}${stock.code})`;
    const sig = ST.Strategy.compute(stock, strat);
    const todayCls = cls(stock.todayChangePct);
    const cumCls = cls(stock.cumChangePct);
    const factors = sig.factors.map(f =>
      `<div class="research-item">
         <div class="lbl">${esc(f.key)} ${f.pass ? '✓' : '✗'}</div>
         <div class="val ${f.pass ? 'up' : 'down'}" style="font-size:12px;font-weight:400">${esc(f.text)}</div>
       </div>`).join("");
    document.getElementById("researchBody").innerHTML = `
      <div class="research-grid">
        <div class="research-item"><div class="lbl">最新价</div><div class="val">${fmtPrice(stock.currentPrice)}</div></div>
        <div class="research-item"><div class="lbl">今日涨跌</div><div class="val ${todayCls}">${signPct(stock.todayChangePct)}</div></div>
        <div class="research-item"><div class="lbl">纳入日收盘</div><div class="val">${fmtPrice(stock.includeClose)}</div></div>
        <div class="research-item"><div class="lbl">累计涨跌</div><div class="val ${cumCls}">${signPct(stock.cumChangePct)}</div></div>
        <div class="research-item"><div class="lbl">MA5 / MA10</div><div class="val" style="font-size:14px">${fmtPrice(stock.ma5)} / ${fmtPrice(stock.ma10)}</div></div>
        <div class="research-item"><div class="lbl">MA20 / MA60</div><div class="val" style="font-size:14px">${fmtPrice(stock.ma20)} / ${fmtPrice(stock.ma60)}</div></div>
        <div class="research-item"><div class="lbl">核心概念</div><div class="val" style="font-size:13px;font-weight:400">${esc(stock.concept)}</div></div>
        <div class="research-item"><div class="lbl">纳入日期</div><div class="val" style="font-size:13px;font-weight:400">${esc(stock.includeDate)} · 仓位 ${(stock.position||0).toFixed(0)}%</div></div>
      </div>

      <div class="research-section">
        <h4>加入原因 / 备注</h4>
        <div class="research-note">${stock.note ? esc(stock.note) : '<span class="dim">暂无备注，可在列表中点击「编辑」添加。</span>'}</div>
      </div>

      <div class="research-section">
        <h4 class="chart-head">近 <span id="researchChartDays">${Math.min(stock.dailyCloses.length, chartWindow)}</span> 日 K 线走势
          <span class="chart-switch">
            <button type="button" class="chart-sw-btn ${chartWindow === 90 ? 'active' : ''}" data-win="90">90日</button>
            <button type="button" class="chart-sw-btn ${chartWindow === 180 ? 'active' : ''}" data-win="180">180日</button>
          </span>
        </h4>
        <div class="chart-box"><canvas id="researchChart"></canvas></div>
      </div>

      <div class="research-section">
        <h4>信号：<span class="signal signal-${sig.signal}">${SIGNAL_TEXT[sig.signal]}</span></h4>
        <div class="basis-box">${esc(sig.basis)}</div>
        <div class="research-grid" style="margin-top:8px">${factors}</div>
      </div>`;

    // 绘制图表（延迟一帧确保 canvas 已布局）
    requestAnimationFrame(() => {
      drawChart(document.getElementById("researchChart"), stock, strat, chartWindow);
    });

    // K 线窗口切换（90/180 日）
    document.querySelectorAll(".chart-sw-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        chartWindow = Number(btn.dataset.win) || 90;
        document.querySelectorAll(".chart-sw-btn").forEach(b => b.classList.toggle("active", b === btn));
        document.getElementById("researchChartDays").textContent = Math.min(stock.dailyCloses.length, chartWindow);
        requestAnimationFrame(() => {
          drawChart(document.getElementById("researchChart"), stock, strat, chartWindow);
        });
      });
    });
  }

  // 设置弹窗表单
  function renderSettingsForm() {
    const tc = ST.TradeConfig.get();
    const pc = ST.PortfolioConfig.get();
    const money = Number(pc.initialCapital).toLocaleString("zh-CN");
    document.getElementById("settingsBody").innerHTML = `
      <div class="op-hint" style="margin:0 0 8px;font-weight:600;color:var(--text)">投资组合</div>
      <div class="form-row"><label>初始资金 (元)</label><input id="cfgInitCap" type="number" min="0" step="1000" value="${pc.initialCapital}"></div>
      <div class="form-row"><label>最多同时持有</label><div class="form-inline"><input id="cfgMaxHold" type="number" min="1" max="200" value="${pc.maxHoldings}"><span class="form-unit">个</span></div></div>
      <div class="form-hint">当前初始资金：<b style="color:var(--accent)">${money}</b> 元</div>
      <div class="op-hint" style="margin:14px 0 8px;font-weight:600;color:var(--text)">交易费用</div>
      <div class="form-row"><label>佣金 (万分之)</label><input id="cfgComm" type="number" min="0" step="0.1" value="${(tc.commissionRate*10000).toFixed(1)}"></div>
      <div class="form-row"><label>佣金最低 (元)</label><input id="cfgCommMin" type="number" min="0" step="0.5" value="${tc.commissionMin}"></div>
      <div class="form-row"><label>印花税 (万分之)</label><input id="cfgStamp" type="number" min="0" step="0.1" value="${(tc.stampDutyRate*10000).toFixed(1)}"></div>
      <div class="form-hint">印花税仅卖出时收取；佣金买卖双向收取。</div>`;
  }
  // 读取交易费用表单（万分之几 → 小数比率）
  function readTradeConfigForm() {
    const v = id => parseFloat(document.getElementById(id).value);
    return {
      commissionRate: Math.max(0, (v("cfgComm") || 0)) / 10000,
      commissionMin: Math.max(0, v("cfgCommMin") || 0),
      stampDutyRate: Math.max(0, (v("cfgStamp") || 0)) / 10000,
      enabled: true
    };
  }
  // 读取投资组合表单
  function readPortfolioForm() {
    const v = id => parseFloat(document.getElementById(id).value);
    return {
      initialCapital: Math.max(0, v("cfgInitCap") || 1000000),
      maxHoldings: Math.max(1, Math.floor(v("cfgMaxHold") || 40))
    };
  }

  // Toast
  let toastTimer = null;
  function toast(msg, type) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "toast show " + (type || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; }, 2200);
  }

  const OP_TEXT = { add: "纳入股票池", buy: "买入", sell: "卖出", remove: "移除" };
  const OP_CLS = { add: "op-add", buy: "op-buy", sell: "op-sell", remove: "op-remove" };

  // 渲染今日操作列表（仅展示当日记录）
  function renderOperationModal(ops, stocks) {
    ops = ops || [];
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayOps = ops.filter(o => (o.ts || 0) >= todayStart.getTime());
    const opts = (stocks || []).map(s =>
      `<option value="${esc(s.id)}">${esc(s.name)} (${esc(s.code)})</option>`).join("");
    const list = todayOps.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).map(op => {
      const type = OP_TEXT[op.type] || op.type;
      const d = new Date(op.ts);
      const time = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0") + " " +
        String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      const extra = op.type === "buy" || op.type === "sell"
        ? ` @ ${fmtPrice(op.price)} × ${op.qty} 股  <span class="op-amount">${fmtPrice(op.amount)}</span>` +
          (op.type === "sell" ? ` <span class="op-fee">印花税 ${fmtPrice(op.stamp)}</span>` : "")
        : (op.price ? ` 纳入价 ${fmtPrice(op.price)}` : "");
      return `
      <div class="op-item">
        <span class="op-type ${OP_CLS[op.type] || ''}">${esc(type)}</span>
        <span class="op-stock">${esc(op.name || op.code)} (${esc(op.code)})</span>
        <span class="op-extra">${extra}</span>
        <span class="op-note">${esc(op.note || "")}</span>
        <span class="op-time">${time}</span>
      </div>`;
    }).join("");
    const empty = todayOps.length ? "" : '<div class="op-empty">今日暂无操作记录。手动录入「买入 / 卖出」或添加股票自动记录「纳入股票池」。</div>';
    document.getElementById("opBody").innerHTML = `
      <div class="op-form">
        <select id="opType">
          <option value="buy">买入</option>
          <option value="sell">卖出</option>
        </select>
        <select id="opStock">${opts || '<option value="">请先添加股票</option>'}</select>
        <input id="opPrice" type="number" step="0.01" placeholder="价格" />
        <input id="opQty" type="number" step="1" placeholder="数量(股)" />
        <input id="opNote" type="text" placeholder="备注(可选)" />
        <button id="btnAddOp" class="btn btn-accent">添加操作</button>
      </div>
      <div class="op-hint">表单用于手动记录「买入 / 卖出」；「纳入股票池」在添加股票时自动记录。</div>
      <div class="op-list">
        <div class="op-list-head">
          <span>今日操作</span><span class="op-count">共 ${todayOps.length} 条</span>
        </div>
        ${empty}
        ${list}
      </div>`;
  }

  // ---------- 资产分析 ----------
  // 区间状态
  let assetRange = "all";
  let assetFrom = ""; // 自定义起（yyyy-MM-dd）
  let assetTo = "";   // 自定义止
  const DAY_MS = 86400000;

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  // 计算区间起止时间戳（返回 {startTs, endTs, isAll}）
  function assetRangeSpan(stocks) {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    let startTs, endTs = now.getTime();
    if (assetRange === "month") {
      startTs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    } else if (assetRange === "year") {
      startTs = new Date(now.getFullYear(), 0, 1).getTime();
    } else if (assetRange === "year1") {
      startTs = now.getTime() - 365 * DAY_MS;
    } else if (assetRange === "custom") {
      startTs = assetFrom ? +new Date(assetFrom) : Date.now();
      if (!isFinite(startTs)) startTs = Date.now();
      if (assetTo) {
        const t = +new Date(assetTo); t && isFinite(t) && t < endTs && (endTs = t);
      }
    } else { // all：最早纳入/最早操作
      startTs = Date.now();
      const dates = stocks.map(s => +new Date(s.includeDate)).filter(v => isFinite(v));
      if (ST.Storage) {
        ST.Storage.getOperations().forEach(o => { if (o.ts && o.ts < startTs) startTs = o.ts; });
      }
      if (dates.length && Math.min.apply(null, dates) < startTs) startTs = Math.min.apply(null, dates);
    }
    return { startTs: isFinite(startTs) ? startTs : Date.now(), endTs };
  }
  function fmtDate(d) { return (d.getMonth() + 1) + "/" + d.getDate(); }

  // 构造区间收益率曲线（组合路径确定性强，刷新不抖动）
  // index 为可选的真实沪深300 {dates, closes}；缺省则用仿真基准（连通前兜底）
  function buildAssetCurve(stocks, actualReturnPct, index) {
    const span = assetRangeSpan(stocks);
    const startD = new Date(span.startTs);
    const endD = new Date(span.endTs);
    const spanDays = Math.max(10, Math.round((span.endTs - span.startTs) / DAY_MS) + 1);

    // 抽样：最长展示约 180 个点
    const step = Math.max(1, Math.ceil(spanDays / 180));
    const labels = [];
    const pts = [];
    const dayDates = []; // 抽样点对应的日期，供真实指数对齐
    for (let i = 0; i < spanDays; i += step) {
      const d = new Date(startD.getTime() + i * DAY_MS);
      labels.push(fmtDate(d));
      dayDates.push(d);
      pts.push(i / Math.max(1, spanDays - 1));
    }
    const isTodayEnd = span.endTs >= new Date().setHours(0, 0, 0, 0);
    labels[labels.length - 1] = isTodayEnd ? "今" : fmtDate(endD);

    // 组合收益率路径：随机游走累积，终点强制对齐实际收益率
    const rng = mulberry32(span.startTs);
    let walk = 0;
    const port = pts.map(() => {
      walk += (rng() - 0.5) * 0.9; // 模拟阶段波动
      return walk;
    });
    const portEnd = port[port.length - 1] || 1;
    const portOut = port.map((v, i) => (pts.length === 1) ? actualReturnPct : (v / portEnd) * actualReturnPct);

    // 沪深300
    let hsiOut;
    if (index && index.dates && index.closes && index.closes.length >= 2) {
      hsiOut = realIndexPath(index, startD, dayDates, span.endTs);
    } else {
      // 仿真基准（仅在真实指数未连通时兜底）
      const rng2 = mulberry32(span.startTs + 777);
      let w2 = 0; const hsi = pts.map(() => { w2 += (rng2() - 0.48) * 0.6; return w2; });
      const hsiEnd = hsi[hsi.length - 1] || 1;
      const simTarget = actualReturnPct + (rng2() - 0.5) * 36;
      hsiOut = hsi.map((v, i) => (pts.length === 1) ? simTarget : (v / hsiEnd) * simTarget);
    }
    return { labels, port: portOut, hsi: hsiOut, realIndex: !!index };
  }

  // 用真实沪深300收盘序列，按各抽样日对齐出区间内的累计涨跌幅（%）
  // 基准价取区间起始日之后首个有效交易日收盘；某日无行情(周末/停牌)则沿用最近一个交易日
  function realIndexPath(index, startD, dayDates, endTs) {
    const series = index.dates.map((s, i) => ({ t: +new Date(s.replace(/-/g, "/")), c: index.closes[i] }));
    const start0 = new Date(startD); start0.setHours(0, 0, 0, 0);
    let base = 0;
    for (let i = 0; i < series.length; i++) {
      if (series[i].t >= start0.getTime()) { base = series[i].c; break; }
    }
    if (!(base > 0)) base = series[series.length - 1].c || 1;

    const out = [];
    let idx = 0;
    const n = series.length; const dayMS = 86400000;
    for (const dd of dayDates) {
      const t = new Date(dd); t.setHours(0, 0, 0, 0); const tt = t.getTime();
      while (idx < n && series[idx].t <= tt + dayMS) idx++;
      let j = idx - 1; while (j >= 0 && series[j].t > tt) j--;
      const close = j >= 0 ? series[j].c : base;
      out.push(((close / base) - 1) * 100);
    }
    return out;
  }

  function drawAssetChart(canvas, data) {
    if (!canvas || !data) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = data.port.length;
    if (n < 2) return;
    let lo = 0, hi = 0;
    data.port.concat(data.hsi).forEach(v => { if (v < lo) lo = v; if (v > hi) hi = v; });
    const span = (hi - lo) || 1;
    lo -= span * 0.1; hi += span * 0.1; const rng = hi - lo;

    const padL = 52, padR = 14, padT = 14, padB = 24;
    const xAt = i => padL + (i / (n - 1)) * (w - padL - padR);
    const yAt = v => padT + (1 - (v - lo) / rng) * (h - padT - padB);

    // 网格 + 0 参考线
    ctx.font = "10px sans-serif";
    ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = 1;
    const y0 = yAt(0);
    if (y0 > padT && y0 < h - padB) {
      ctx.strokeStyle = "rgba(155,166,196,.35)"; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(w - padR, y0); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(155,166,196,.7)"; ctx.textAlign = "right";
      ctx.fillText("0%", padL - 4, y0 + 3);
    }
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    for (let i = 0; i <= 4; i++) {
      const y = padT + (i / 4) * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      // y 轴刻度
      const v = hi - (i / 4) * rng;
      ctx.fillStyle = "#6b7798"; ctx.textAlign = "right";
      ctx.fillText(Math.round(v) + "%", padL - 6, y + 3);
    }
    // x 轴刻度
    ctx.fillStyle = "#6b7798"; ctx.textAlign = "center";
    const tickIdx = n <= 12 ? null : Math.ceil(n / 6);
    for (let i = 0; i < n; i++) {
      if (tickIdx && i % tickIdx !== 0) continue;
      ctx.fillText(data.labels[i], xAt(i), h - 8);
    }

    // 沪深300：虚线
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = "#ffb020"; ctx.lineWidth = 1.6; ctx.beginPath();
    data.hsi.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    ctx.setLineDash([]);
    // 组合：实线
    ctx.strokeStyle = "#4aa8ff"; ctx.lineWidth = 2.4; ctx.beginPath();
    data.port.forEach((v, i) => { const x = xAt(i), y = yAt(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    // 端点标签
    ctx.fillStyle = "#4aa8ff"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(data.port[n - 1].toFixed(2) + "%", xAt(n - 1) + 5, yAt(data.port[n - 1]) - 4);
    ctx.fillStyle = "#ffb020";
    ctx.fillText(data.hsi[n - 1].toFixed(2) + "%", xAt(n - 1) + 5, yAt(data.hsi[n - 1]) + 12);
  }

  function renderAssetAnalysis(stocks) {
    const a = ST.UI.computeAssets(stocks);
    const cap = (ST.PortfolioConfig && ST.PortfolioConfig.get().initialCapital) || 0;
    const pnl = a.totalAsset - cap;
    setVal("astTotal", "¥" + fmtAsset(a.totalAsset));
    // 区间盈亏卡：标题随区间、内容为盈亏金额 + 收益率
    const rangeTag = assetRange === "month" ? "本月盈亏"
      : assetRange === "year" ? "今年盈亏"
      : assetRange === "year1" ? "近一年盈亏"
      : assetRange === "custom" ? "区间盈亏"
      : "累计盈亏";
    setVal("astRangeLabel", rangeTag, "");
    setVal("astRangePnl", (pnl >= 0 ? "+" : "−") + fmtAsset(Math.abs(pnl)), cls(pnl));
    setVal("astRangePnlPct", signPct(a.cumPct) + "（收益）", cls(a.cumPct));
    setVal("astPnl", (pnl >= 0 ? "+" : "−") + fmtAsset(Math.abs(pnl)), cls(pnl));
    setVal("astReturn", signPct(a.cumPct), cls(a.cumPct));

    // 先出图（默认仿真基准兜底）
    const data = buildAssetCurve(stocks, a.cumPct, null);
    // 区间文本身：起 至 止
    const span = assetRangeSpan(stocks);
    const fromD = new Date(span.startTs), toD = new Date(span.endTs);
    const isTodayEnd = span.endTs >= new Date().setHours(0, 0, 0, 0);
    const endLabel = isTodayEnd ? "今" : (toD.getFullYear() + "/" + (toD.getMonth() + 1) + "/" + toD.getDate());
    const rangeText = `${fromD.getFullYear()}/${(fromD.getMonth() + 1)}/${fromD.getDate()} 至 ${endLabel}`;
    document.getElementById("astRange").textContent = "区间 " + rangeText;
    const chart = document.getElementById("assetChart");
    setTimeout(() => drawAssetChart(chart, data), 30);
    // 异步拉取真实沪深300，成功后用真实基准重绘
    if (ST.Market && ST.Market.getIndex) {
      ST.Market.getIndex().then(idx => {
        drawAssetChart(chart, buildAssetCurve(stocks, a.cumPct, idx));
      }).catch(() => { /* 连通失败则保留仿真基准 */ });
    }
  }

  // 切换区间并重绘
  function setAssetRange(key) {
    assetRange = key;
    // 自定义首次点开：给默认起止
    if (key === "custom") {
      const now = new Date();
      if (!assetFrom) {
        assetFrom = toDateStr(new Date(now.getTime() - 30 * DAY_MS));
        document.getElementById("assetFrom").value = assetFrom;
      }
      if (!assetTo) {
        assetTo = toDateStr(now);
        document.getElementById("assetTo").value = assetTo;
      }
      // 每次重新读取输入框，保证改日期后重绘用的是新值
      assetFrom = document.getElementById("assetFrom").value;
      assetTo = document.getElementById("assetTo").value;
      document.getElementById("assetRangeCustom").hidden = false;
    } else {
      document.getElementById("assetRangeCustom").hidden = true;
    }
    // 更新 tab 高亮
    document.querySelectorAll("#assetRangeTabs .rtab").forEach(b =>
      b.classList.toggle("active", b.getAttribute("data-range") === key));
    renderAssetAnalysis(ST.App ? ST.App.getStocks() : []);
  }

  // ---------- 清仓股票 ----------
  // 时间戳 → 日期字符串（含时分）
  function fmtStamp(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d)) return "—";
    const p = n => (n < 10 ? "0" : "") + n;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function renderClosedList(stocks) {
    const listEl = document.getElementById("closedList");
    const pagerEl = document.getElementById("closedPager");
    const sumEl = document.getElementById("closedSummary");
    if (!listEl || !sumEl) return;

    // 日期过滤（按清仓日期）：跨度 ≤ 1 年
    let fromTs = 0, toTs = Infinity;
    const f = closedState.from, t = closedState.to;
    if (f) {
      const fd = new Date(f); fd.setHours(0, 0, 0, 0);
      fromTs = fd.getTime();
      if (t) {
        const td = new Date(t); td.setHours(0, 0, 0, 0);
        const span = td.getTime() - fd.getTime();
        if (span > 365 * 24 * 3600 * 1000) {
          const maxD = new Date(fd); maxD.setDate(maxD.getDate() + 365);
          document.getElementById("clDateTo").value = closedState.to = toDateStr(maxD);
          toast("日期跨度不能超过 1 年，已自动调整为最晚可选日期", "error");
        }
        toTs = td.getTime() + 24 * 3600 * 1000 - 1; // 含当日
      }
    }
    let closed = ST.Holding.computeClosed(ST.Storage.getOperations(), stocks)
      .filter(c => {
        const ts = c.closeDate || 0;
        return ts >= fromTs && ts <= toTs;
      })
      .sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));

    const totalPages = Math.max(1, Math.ceil(closed.length / CLOSED_PAGE_SIZE));
    if (closedState.page > totalPages) closedState.page = totalPages;
    if (closedState.page < 1) closedState.page = 1;
    const pageClosed = closed.slice((closedState.page - 1) * CLOSED_PAGE_SIZE, closedState.page * CLOSED_PAGE_SIZE);

    if (!closed.length) {
      sumEl.innerHTML = "";
      listEl.innerHTML = "<div class='empty'>暂无已清仓股票。完成一笔「买入 + 全量卖出」的操作后，这里会展示盈亏与做T/持有对比。</div>";
      if (pagerEl) pagerEl.innerHTML = "";
      return;
    }
    const totalRealized = closed.reduce((s, c) => s + c.realized, 0);
    const tBetter = closed.filter(c => c.better === "做T更优").length;
    const hBetter = closed.filter(c => c.better === "持有不动更优").length;
    sumEl.innerHTML = `
      <div class="closed-chip">共 <b>${closed.length}</b> 只已清仓</div>
      <div class="closed-chip">实际累计盈亏 <b class="${totalRealized >= 0 ? 'up' : 'down'}">${totalRealized >= 0 ? "+" : "−"}¥${Math.abs(totalRealized).toFixed(2)}</b></div>
      <div class="closed-chip">做T更优 <b>${tBetter}</b> 只 / 持有不动更优 <b>${hBetter}</b> 只</div>`;

    listEl.innerHTML = pageClosed.map((c, i) => `
      <div class="closed-row" data-idx="${i}">
        <div class="cl-name"><b>${esc(c.name)}</b><span>${esc(c.code)}</span></div>
        <div class="cl-dates"><span>建仓 ${fmtDate(new Date(c.openDate))}</span><span>→ 清仓 ${fmtDate(new Date(c.closeDate))}</span></div>
        <div class="cl-metric"><span class="cl-label">实际盈亏</span><span class="cl-val ${c.realized >= 0 ? 'up' : 'down'}">${c.realized >= 0 ? "+" : "−"}¥${Math.abs(c.realized).toFixed(2)}</span></div>
        <div class="cl-metric"><span class="cl-label">持有不动</span><span class="cl-val ${c.holdPnl >= 0 ? 'up' : 'down'}">${c.holdPnl >= 0 ? "+" : "−"}¥${Math.abs(c.holdPnl).toFixed(2)}</span></div>
        <div class="cl-metric"><span class="cl-label">差额</span><span class="cl-val ${c.diff >= 0 ? 'up' : 'down'}">${c.diff >= 0 ? "+" : "−"}¥${Math.abs(c.diff).toFixed(2)}</span></div>
        <div class="cl-better ${c.better === '做T更优' ? 'better-t' : (c.better === '持有不动更优' ? 'better-h' : '')}">${esc(c.better)}</div>
      </div>`).join("");

    listEl.querySelectorAll(".closed-row").forEach(row =>
      row.addEventListener("click", () => renderClosedDetail(pageClosed[+row.getAttribute("data-idx")])));

    if (pagerEl) pagerEl.innerHTML = renderClosedPager(totalPages);
  }

  // 清仓分页状态
  const CLOSED_PAGE_SIZE = 20;
  let closedState = { from: "", to: "", page: 1 };
  function renderClosedPager(totalPages) {
    const p = closedState.page;
    const page = (n) => `onclick="ST.UI.goClosedPage(${n})"`;
    const btn = (label, n, disabled) =>
      `<button class="hp-btn" ${disabled ? "disabled" : ""} ${n >= 1 && n <= totalPages && !disabled ? page(n) : ""}>${label}</button>`;
    let nums = "";
    const start = Math.max(1, p - 2), end = Math.min(totalPages, p + 2);
    for (let i = start; i <= end; i++) {
      nums += i === p
        ? `<span class="hp-num active">${i}</span>`
        : `<span class="hp-num" ${page(i)}>${i}</span>`;
    }
    return `
      <span class="hp-info">共 ${totalPages} 页</span>
      ${btn("‹ 上一页", p - 1, p <= 1)}
      ${nums}
      ${btn("下一页 ›", p + 1, p >= totalPages)}`;
  }
  function goClosedPage(n) {
    if (n < 1) return;
    closedState.page = n;
    renderClosedList(ST.App ? ST.App.getStocks() : []);
    const listEl = document.getElementById("closedList");
    if (listEl) listEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function setClosedFilter(part) {
    Object.assign(closedState, part);
    closedState.page = 1;
    renderClosedList(ST.App ? ST.App.getStocks() : []);
  }

  function renderClosedDetail(c) {
    const titleEl = document.getElementById("closedTitle");
    const bodyEl = document.getElementById("closedBody");
    if (!titleEl || !bodyEl || !c) return;
    titleEl.textContent = `${esc(c.name)}（${esc(c.code)}）`;
    const feeHint = "（此处未扣手续费/印花税）";
    const opsRows = c.ops.map(o => `
      <tr>
        <td>${fmtStamp(o.ts)}</td>
        <td><span class="op-tag ${o.type === 'buy' ? 'op-buy' : 'op-sell'}">${o.type === 'buy' ? '买入' : '卖出'}</span></td>
        <td>${parseFloat(o.price || 0).toFixed(2)} × ${o.qty} 股</td>
        <td>¥${parseFloat(o.amount || 0).toFixed(2)}</td>
        <td>${esc(o.note || "")}</td>
      </tr>`).join("");
    bodyEl.innerHTML = `
      <div class="closed-overview">
        <span>建仓 ${fmtDate(new Date(c.openDate))} @ ¥${c.openPrice.toFixed(2)}（${c.openQty} 股）</span>
        <span>清仓 ${fmtDate(new Date(c.closeDate))} @ ¥${c.closePrice.toFixed(2)}</span>
        <span>共 ${c.buyCount} 笔买入 / ${c.sellCount} 笔卖出</span>
      </div>
      <div class="compare-grid">
        <div class="compare-col">
          <div class="cc-title">实际（频繁做T）</div>
          <div class="cc-val ${c.realized >= 0 ? 'up' : 'down'}">${c.realized >= 0 ? "+" : "−"}¥${Math.abs(c.realized).toFixed(2)}</div>
          <div class="cc-sub">${c.buyCount} 买 ${c.sellCount} 卖</div>
        </div>
        <div class="compare-vs">VS</div>
        <div class="compare-col">
          <div class="cc-title">从建仓持有到清仓（不动）</div>
          <div class="cc-val ${c.holdPnl >= 0 ? 'up' : 'down'}">${c.holdPnl >= 0 ? "+" : "−"}¥${Math.abs(c.holdPnl).toFixed(2)}</div>
          <div class="cc-sub">1 买 1 卖，不做T</div>
        </div>
      </div>
      <div class="compare-concl ${c.better === '做T更优' ? 'better-t' : (c.better === '持有不动更优' ? 'better-h' : '')}">
        结论：<b>${esc(c.better)}</b>（差额 ${c.diff >= 0 ? "+" : "−"}¥${Math.abs(c.diff).toFixed(2)}）${feeHint}
      </div>
      <div class="cl-table-wrap">
        <table class="table">
          <thead><tr><th>时间</th><th>类型</th><th>价格 × 数量</th><th>金额</th><th>备注</th></tr></thead>
          <tbody>${opsRows}</tbody>
        </table>
      </div>`;
    document.getElementById("closedModal").classList.add("show");
  }

  // 历史操作分页状态
  const HIST_PAGE_SIZE = 100;
  let histState = { kw: "", type: "", from: "", to: "", page: 1 };

  // 渲染历史操作列表（全部历史，支持关键字/类型/日期过滤 + 分页）
  function renderHistory() {
    const listEl = document.getElementById("historyList");
    const pagerEl = document.getElementById("historyPager");
    if (!listEl) return;
    // 日期跨度限制：≤ 1 个月
    let fromTs = 0, toTs = Infinity;
    const f = histState.from, t = histState.to;
    if (f) {
      const fd = new Date(f); fd.setHours(0, 0, 0, 0);
      fromTs = fd.getTime();
      if (t) {
        const td = new Date(t); td.setHours(0, 0, 0, 0);
        const span = td.getTime() - fd.getTime();
        if (span > 31 * 24 * 3600 * 1000) {
          const maxD = new Date(fd); maxD.setDate(maxD.getDate() + 31);
          document.getElementById("histDateTo").value = histState.to = toDateStr(maxD);
          toast("日期跨度不能超过 1 个月，已自动调整为最晚可选日期", "error");
        }
        toTs = td.getTime() + 24 * 3600 * 1000 - 1; // 含当日
      }
    }
    let ops = ST.Storage.getOperations().filter(o => {
      const ts = o.ts || 0;
      if (ts < fromTs || ts > toTs) return false;
      if (histState.type && o.type !== histState.type) return false;
      const kw = histState.kw.toLowerCase();
      if (kw && !((o.code || "").toLowerCase().includes(kw) ||
                  (o.name || "").toLowerCase().includes(kw) ||
                  (o.note || "").toLowerCase().includes(kw))) return false;
      return true;
    }).sort((a, b) => (b.ts || 0) - (a.ts || 0));

    const totalPages = Math.max(1, Math.ceil(ops.length / HIST_PAGE_SIZE));
    if (histState.page > totalPages) histState.page = totalPages;
    if (histState.page < 1) histState.page = 1;
    const pageOps = ops.slice((histState.page - 1) * HIST_PAGE_SIZE, histState.page * HIST_PAGE_SIZE);

    if (!ops.length) {
      listEl.innerHTML = '<div class="op-empty">暂无匹配的历史操作。</div>';
      pagerEl.innerHTML = "";
      return;
    }
    listEl.innerHTML = pageOps.map(op => {
      const tt = OP_TEXT[op.type] || op.type;
      const d = new Date(op.ts);
      const time = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0") + " " +
        String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      let extra = "";
      if (op.type === "buy" || op.type === "sell") {
        extra = ` @ ${fmtPrice(op.price)} × ${op.qty} 股  <span class="op-amount">${fmtPrice(op.amount)}</span>` +
          (op.type === "sell" && op.stamp ? ` <span class="op-fee">印花税 ${fmtPrice(op.stamp)}</span>` : "");
      } else if (op.price) {
        extra = ` 纳入价 ${fmtPrice(op.price)}`;
      }
      return `
      <div class="op-item">
        <span class="op-type ${OP_CLS[op.type] || ''}">${esc(tt)}</span>
        <span class="op-stock">${esc(op.name || op.code)} (${esc(op.code)})</span>
        <span class="op-extra">${extra}</span>
        <span class="op-note">${esc(op.note || "")}</span>
        <span class="op-time">${time}</span>
      </div>`;
    }).join("");

    pagerEl.innerHTML = renderPager(totalPages);
  }

  function renderPager(totalPages) {
    const p = histState.page;
    const page = (n) => `onclick="ST.UI.goHistoryPage(${n})"`;
    const btn = (label, n, disabled) =>
      `<button class="hp-btn" ${disabled ? "disabled" : ""} ${n >= 1 && n <= totalPages && !disabled ? page(n) : ""}>${label}</button>`;
    let nums = "";
    const start = Math.max(1, p - 2), end = Math.min(totalPages, p + 2);
    for (let i = start; i <= end; i++) {
      nums += i === p
        ? `<span class="hp-num active">${i}</span>`
        : `<span class="hp-num" ${page(i)}>${i}</span>`;
    }
    return `
      <span class="hp-info">共 ${totalPages} 页</span>
      ${btn("‹ 上一页", p - 1, p <= 1)}
      ${nums}
      ${btn("下一页 ›", p + 1, p >= totalPages)}`;
  }

  function toDateStr(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // ---- 策略管理页 ---- 
  function renderStrategyManage(list) {
    const box = document.getElementById("strategyManageList");
    if (!box) return;
    if (!list || !list.length) { box.innerHTML = '<div class="empty-note">暂无策略，点击「+ 新增策略」创建。</div>'; return; }
    const ATTR = ST.Strategy.ATTR_TEXT;
    box.innerHTML = list.map((s, i) => `
      <div class="strat-card${s.enabled === false ? " is-disabled" : ""}" data-idx="${i}">
        <div class="strat-head">
          <span class="strat-name">${esc(s.name)}</span>
          <span class="strat-attr strat-attr-${s.attr}">${ATTR[s.attr] || s.attr}</span>
          <span class="strat-state ${s.enabled === false ? "off" : ""}">${s.enabled === false ? "已停用" : "启用中"}</span>
        </div>
        <div class="strat-desc">${esc(strategyDesc(s))}</div>
        <div class="strat-actions">
          <button class="btn btn-sm" data-strat-act="toggle">${s.enabled === false ? "启用" : "停用"}</button>
          <button class="btn btn-sm" data-strat-act="edit">编辑</button>
          <button class="btn btn-sm btn-remove" data-strat-act="del">删除</button>
        </div>
      </div>`).join("");
  }
  function strategyDesc(s) {
    const p = s.params || {};
    if (s.attr === "buy") {
      if (p.mode === "dip") return `上升趋势(MA${p.shortMA}>MA${p.midMA}>MA${p.longMA})中，现价回踩 MA${p.midMA} 附近且拐头向上时买入`;
      return `MA${p.shortMA}>MA${p.midMA}>MA${p.longMA} 完全多头且现价站上 MA${p.longMA} 时买入`;
    }
    if (s.attr === "sell_partial") return `持仓涨幅 ≥ ${p.gainPct}% 时，卖出约 ${Math.round((p.ratio || 0.3) * 100)}% 落袋（每轮持仓仅触发一次）`;
    if (p.mode === "stoploss") return `持仓跌幅 ≤ -${Math.abs(p.lossPct)}% 时清仓卖出`;
    return `现价跌破 MA${p.ma} 时清仓卖出`;
  }
  function nvSt(id, def) { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? def : v; }
  // 策略编辑表单（属性切换参数区）
  function renderStrategyEditForm(s) {
    s = s || { id: "", name: "", attr: "buy", enabled: true, params: { mode: "breakout", shortMA: 5, midMA: 20, longMA: 60, breakoutRatio: 0.01 } };
    const p = s.params || {};
    document.getElementById("strategyEditTitle").textContent = s.id ? "编辑策略" : "新增策略";
    document.getElementById("strategyEditBody").innerHTML = `
      <div class="form-row"><label>策略名称</label><input id="sedName" type="text" value="${esc(s.name || "")}" placeholder="如：趋势突破买入"></div>
      <div class="form-row"><label>策略属性</label><select id="sedAttr" onchange="ST.UI.updateStrategyEditParams()">
        <option value="buy" ${s.attr === "buy" ? "selected" : ""}>买入</option>
        <option value="sell_partial" ${s.attr === "sell_partial" ? "selected" : ""}>卖出-部分止盈</option>
        <option value="sell_all" ${s.attr === "sell_all" ? "selected" : ""}>卖出-清仓</option>
      </select></div>

      <div class="strat-params" data-sed="buy">
        <div class="op-hint">买入条件</div>
        <div class="form-row"><label>形态</label><select id="sedBuyMode">
          <option value="breakout" ${p.mode !== "dip" ? "selected" : ""}>突破买入（完全多头）</option>
          <option value="dip" ${p.mode === "dip" ? "selected" : ""}>回踩低吸</option>
        </select></div>
        <div class="form-row"><label>短期均线</label><input id="sedBuys" type="number" min="1" value="${p.shortMA || 5}"></div>
        <div class="form-row"><label>中期均线</label><input id="sedBuym" type="number" min="1" value="${p.midMA || 20}"></div>
        <div class="form-row"><label>长期均线</label><input id="sedBuyl" type="number" min="1" value="${p.longMA || 60}"></div>
      </div>

      <div class="strat-params" data-sed="sell_partial">
        <div class="op-hint">部分止盈</div>
        <div class="form-row"><label>触发持仓涨幅(%)</label><input id="sedGain" type="number" min="0" step="0.5" value="${p.gainPct != null ? p.gainPct : 25}"></div>
        <div class="form-row"><label>卖出比例(%)</label><input id="sedRatio" type="number" min="1" max="100" step="1" value="${Math.round((p.ratio != null ? p.ratio : 0.3) * 100)}"></div>
      </div>

      <div class="strat-params" data-sed="sell_all">
        <div class="op-hint">清仓卖出</div>
        <div class="form-row"><label>触发方式</label><select id="sedAllMode" onchange="ST.UI.updateStrategyEditParams2()">
          <option value="stoploss" ${p.mode !== "belowMA" ? "selected" : ""}>跌破止损线</option>
          <option value="belowMA" ${p.mode === "belowMA" ? "selected" : ""}>跌破长期均线</option>
        </select></div>
        <div class="form-row" data-sed-all="stoploss"><label>持仓止损线(%)</label><input id="sedLoss" type="number" min="1" step="0.5" value="${Math.abs(p.lossPct != null ? p.lossPct : 8)}"></div>
        <div class="form-row" data-sed-all="belowMA"><label>长期均线周期</label><input id="sedSellma" type="number" min="1" value="${p.ma || 60}"></div>
      </div>`;
    updateStrategyEditParams();
  }
  function updateStrategyEditParams() {
    const attr = (document.getElementById("sedAttr") || {}).value;
    document.querySelectorAll("#strategyEditBody .strat-params").forEach(el => {
      el.style.display = el.getAttribute("data-sed") === attr ? "" : "none";
    });
    updateStrategyEditParams2();
  }
  function updateStrategyEditParams2() {
    const mode = (document.getElementById("sedAllMode") || {}).value;
    document.querySelectorAll("#strategyEditBody [data-sed-all]").forEach(el => {
      el.style.display = el.getAttribute("data-sed-all") === mode ? "" : "none";
    });
  }
  function readStrategyEditForm() {
    const attr = document.getElementById("sedAttr").value;
    const name = document.getElementById("sedName").value.trim();
    const p = {};
    if (attr === "buy") {
      p.mode = document.getElementById("sedBuyMode").value;
      p.shortMA = Math.max(1, Math.floor(nvSt("sedBuys", 5)));
      p.midMA = Math.max(1, Math.floor(nvSt("sedBuym", 20)));
      p.longMA = Math.max(1, Math.floor(nvSt("sedBuyl", 60)));
      p.breakoutRatio = 0.01;
    } else if (attr === "sell_partial") {
      p.gainPct = Math.abs(nvSt("sedGain", 25));
      p.ratio = Math.max(0.01, Math.min(1, nvSt("sedRatio", 30) / 100));
    } else {
      p.mode = document.getElementById("sedAllMode").value;
      if (p.mode === "stoploss") p.lossPct = Math.abs(nvSt("sedLoss", 8));
      else p.ma = Math.max(1, Math.floor(nvSt("sedSellma", 60)));
    }
    return { name, attr, params: p };
  }

  // 分页跳转（由分页控件 onclick 调用）
  function goHistoryPage(n) {
    if (n < 1) return;
    histState.page = n;
    renderHistory();
    const listEl = document.getElementById("historyList");
    if (listEl) listEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // 更新历史筛选状态并跳到第 1 页
  function setHistoryFilter(part) {
    Object.assign(histState, part);
    histState.page = 1;
    renderHistory();
  }

  ST.UI = {
    renderTable, renderStats, renderResearch, renderSettingsForm,
    readTradeConfigForm, readPortfolioForm, renderOperationModal, renderHistory,
    setHistoryFilter, goHistoryPage, renderAssetAnalysis, setAssetRange, renderClosedList, goClosedPage, setClosedFilter, drawChart, toast,
    computeAssets, fmtPrice, signPct, cls,
    renderStrategyManage, renderStrategyEditForm, readStrategyEditForm, updateStrategyEditParams, updateStrategyEditParams2
  };
})(window.ST);
