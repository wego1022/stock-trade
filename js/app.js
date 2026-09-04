// app.js — 主编排：状态、事件、自动刷新、模态框
window.ST = window.ST || {};

(function (ST) {
  let stocks = [];
  let strat = null;
  let strategies = [];
  let timer = null;
  let filterText = "";
  let aftermarketDoneDate = ""; // 当日盘后观察是否已生成（避免重复触发）
  // 排序状态：key 可能是内置列名 或 "_default"（信号→纳入日期）
  let sortState = { key: "_default", dir: 1 };

  // 信号优先级：买入 < 持有 < 卖出 < 观望
  const SIGNAL_RANK = { buy: 0, hold: 1, sell: 2, watch: 3 };

  function getStocks() { return stocks; }
  function filtered() {
    if (!filterText) return stocks;
    const q = filterText.toLowerCase();
    return stocks.filter(s =>
      s.code.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.concept.toLowerCase().includes(q));
  }

  function renderAll() {
    const list = filtered();
    const sorted = applySort(list, strat, sortState);
    ST.UI.renderTable(sorted, strat, sortState);
    ST.UI.renderStats(stocks); // 统计基于全量
  }

  // 排序：默认按信号分组（买→持→卖→观）同组内按纳入日期；其他列按所选列升降序
  function applySort(arr, strat, st) {
    if (!st || st.key === "_default") {
      return arr.slice().sort((a, b) => {
        const sa = ST.Strategy.evaluate(a).signal;
        const sb = ST.Strategy.evaluate(b).signal;
        const ra = SIGNAL_RANK[sa] || 99;
        const rb = SIGNAL_RANK[sb] || 99;
        if (ra !== rb) return ra - rb;
        // 同组：纳入日期早的在前
        return (a.includeDate || "").localeCompare(b.includeDate || "");
      });
    }
    const dir = st.dir >= 0 ? 1 : -1;
    const field = st.key;
    return arr.slice().sort((a, b) => {
      const va = sortField(a, field);
      const vb = sortField(b, field);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") return dir * va.localeCompare(vb);
      return dir * (va - vb);
    });
  }
  function sortField(s, key) {
    if (key === "code") return s.code;
    if (key === "price") return s.currentPrice;
    if (key === "today") return s.todayChangePct;
    if (key === "cum") return s.cumChangePct;
    if (key === "includeDate") return s.includeDate;
    if (key === "position") return s.position || 0;
    if (key === "qty" || key === "marketValue" || key === "pnl" || key === "avgCost" || key === "pnlPct") {
      // 依赖 ST.Holding 实时计算
      if (ST.Holding) {
        const h = ST.Holding.compute(s, ST.Storage.getOperations());
        return h ? h[key] : 0;
      }
      return 0;
    }
    return null;
  }

  // 点击表头：未选 → 升序 → 降序 → 恢复默认（信号→纳入日期）
  function onHeaderClick(key) {
    if (!key) return;
    if (sortState.key !== key) {
      sortState.key = key;
      sortState.dir = 1; // 首次：升序
    } else if (sortState.dir === 1) {
      sortState.dir = -1; // 二次：降序
    } else {
      sortState.key = "_default"; // 三次：回归默认
      sortState.dir = 1;
    }
    renderAll();
  }
  // 恢复默认排序
  function resetSort() {
    sortState = { key: "_default", dir: 1 };
    renderAll();
  }

  function saveAll() {
    ST.Storage.saveStocks(stocks);
    ST.Storage.saveStrategy(strat);
    ST.Storage.saveStrategies(strategies);
  }

  function updateLastUpdate() {
    const d = new Date();
    const t = String(d.getHours()).padStart(2, "0") + ":" +
      String(d.getMinutes()).padStart(2, "0") + ":" +
      String(d.getSeconds()).padStart(2, "0");
    document.getElementById("lastUpdate").textContent = "最近更新 " + t;
    ST.Storage.saveMeta({ lastUpdate: d.toISOString() });
  }

  // 行情刷新：优先拉真实行情；失败则回退模拟价格游走
  async function refreshPrices(silent) {
    try {
      await ST.Market.loadRealQuotes(stocks);
    } catch (e) {
      ST.Market.tickAll(stocks);
    }
    updateLastUpdate();
    // 交易时段内：按启用策略自动生成买入/卖出操作记录（状态化，不重复）
    if (isTradingSession() && strategies.length) {
      try { runAutoTrading(); } catch (e) { console.warn("自动交易执行失败", e); }
    }
    renderAll();
    saveAll();
    if (!silent) ST.UI.toast("行情已更新", "success");
  }

  // 按启用的策略对每只股票自动建仓/卖出；每天每个动作只执行一次
  function runAutoTrading() {
    const ops = ST.Storage.getOperations();
    const today = ST.Market.todayStr();
    let changed = false;
    let fundShiftDone = false; // 本轮是否已做过"资金不足调仓卖出"（每轮最多一次）
    stocks.forEach(s => {
      const ev = ST.Strategy.evaluate(s, strategies, ops);
      if (!ev.action) return;
      if (s.strategyExec && s.strategyExec[ev.action] === today) return; // 当天已执行过同类动作
      const h = ST.Holding.compute(s, ops);
      const price = s.currentPrice;
      if (ev.action === "buy") {
        const totalAsset = (ST.UI.computeAssets(stocks).totalAsset || ST.PortfolioConfig.get().initialCapital);
        const cap = ST.PortfolioConfig.get().initialCapital;
        const x = totalAsset / 20; // 买入金额 = 总资产 1/20
        const totalPos = stocks.reduce((a, st) => a + (st.position || 0), 0);
        let cashPool = cap * Math.max(0, 1 - totalPos / 100); // 可用现金池
        let buyAmount = x;
        if (cashPool < x - 1e-9) {
          // 买入金额不足：先卖持仓中浮动盈亏率最差的两只，各腾出 ≥ x/2
          if (!fundShiftDone) {
            const raised = sellForCash(ops, x / 2);
            fundShiftDone = true;
            cashPool += raised; // 回笼现金并入可用资金
          }
          buyAmount = Math.min(x, cashPool);
        }
        let qty = Math.floor(buyAmount / price / 100) * 100;
        if (!(qty > 0)) return; // 不足以买入一手（100 股），跳过
        const amount = Math.round(price * qty * 100) / 100;
        recordOp("buy", s, { price, qty, amount, fee: ST.TradeConfig.buyFee(amount), stamp: 0, note: "自动买入（" + nameOf(ev, "buy") + "），占1/20仓位" });
        s.position = Math.round(((s.position || 0) + 5) * 10) / 10; // 新增约 5% 仓位（1/20）
        s.partialDone = false; // 新一轮持仓，重新武装部分止盈
        changed = true;
      } else if (ev.action === "sell_partial") {
        if (h.qty <= 0) return;
        const ratio = (ev.hits.sell_partial && ev.hits.sell_partial.params && ev.hits.sell_partial.params.ratio) || 0.3;
        let qty = Math.floor((h.qty * ratio / 100)) * 100;
        if (!(qty > 0)) qty = h.qty;
        const amount = Math.round(price * qty * 100) / 100;
        recordOp("sell", s, { price, qty, amount, fee: ST.TradeConfig.sellFee(amount), stamp: Math.round(amount * ST.TradeConfig.get().stampDutyRate * 100) / 100, note: "自动部分止盈（" + nameOf(ev, "sell_partial") + "），卖约 " + Math.round(ratio * 100) + "%" });
        s.partialDone = true;
        changed = true;
      } else if (ev.action === "sell_all") {
        if (h.qty <= 0) return;
        const qty = h.qty;
        const amount = Math.round(price * qty * 100) / 100;
        recordOp("sell", s, { price, qty, amount, fee: ST.TradeConfig.sellFee(amount), stamp: Math.round(amount * ST.TradeConfig.get().stampDutyRate * 100) / 100, note: "自动清仓卖出（" + nameOf(ev, "sell_all") + "）" });
        changed = true;
      }
      s.strategyExec = Object.assign({}, s.strategyExec, { [ev.action]: today });
    });
    if (changed) { saveAll(); renderAll(); ST.UI.toast("已按策略自动执行买卖", "success"); }
  }
  function nameOf(ev, key) { return (ev.hits && ev.hits[key] && ev.hits[key].name) || "策略"; }

  // 资金不足时调仓：卖持仓中浮动盈亏率最差的两只，各卖出 ≥ need（100 股整数倍，持仓不足则清仓）
  function sellForCash(ops, need) {
    const picks = stocks
      .map(s => ({ s, h: ST.Holding.compute(s, ops) }))
      .filter(p => p.h.qty > 0)
      .sort((a, b) => (a.h.pnlPct - b.h.pnlPct) || a.s.code.localeCompare(b.s.code))
      .slice(0, 2);
    let raised = 0;
    picks.forEach(({ s, h }) => {
      const price = s.currentPrice;
      let qty = Math.ceil((need / price) / 100) * 100; // 至少卖 need，向上取整到 100 股
      if (qty > h.qty) qty = h.qty;                    // 持仓不足则清仓
      if (!(qty > 0)) return;
      const amount = Math.round(price * qty * 100) / 100;
      recordOp("sell", s, { price, qty, amount, fee: ST.TradeConfig.sellFee(amount), stamp: Math.round(amount * ST.TradeConfig.get().stampDutyRate * 100) / 100, note: "资金不足调仓卖出（盈利最差）" });
      // 同步缩减该股仓位比例（清仓则归零）
      const ratio = qty / h.qty;
      s.position = Math.max(0, Math.round(((s.position || 0) * (1 - ratio)) * 10) / 10);
      raised += amount;
    });
    return raised;
  }

  // 是否处于交易时段：周一至周五 9:30-11:30、13:00-15:00（A股连续竞价时段，买卖仅在此时段触发）
  function isTradingSession() {
    const d = new Date();
    const day = d.getDay();
    if (day === 0 || day === 6) return false; // 周末
    const mins = d.getHours() * 60 + d.getMinutes();
    const am = mins >= 9 * 60 + 25 && mins < 11 * 60 + 30; // 9:25 ~ 11:30
    const pm = mins >= 13 * 60 && mins < 15 * 60;          // 13:00 ~ 15:00
    return am || pm;
  }
  // 交易日 + 是否开盘（用于状态文案）
  function sessionDesc() {
    const d = new Date();
    return d.getDay() === 0 || d.getDay() === 6 ? "休市" : (isTradingSession() ? "交易中" : "非交易时段");
  }

  // 自动更新调度
  // 定时器始终运行：暂停自动更新时交易时段不刷新行情，但 15:10 仍强制生成当日盘后观察
  function restartTimer() {
    if (timer) { clearInterval(timer); timer = null; }
    // 用较短间隔定时检查，使开收盘能准点切换；仅在建仓时段内才真正刷新
    const checkMs = Math.min(Math.max(10, strat.intervalSec), 60) * 1000;
    timer = setInterval(() => {
      if (isTradingSession()) {
        if (strat.autoUpdate) {
          refreshPrices(true);
        } else {
          updateAutoStatus(); // 已暂停：不刷新，仅更新状态
        }
      } else if (ST.Aftermarket && ST.Aftermarket.isAftermarketTime()) {
        // 收盘后 15:10：拉一次收盘价并生成当日盘后观察（每交易日一次，暂停自动更新也强制执行）
        const today = ST.Market.todayStr();
        if (aftermarketDoneDate !== today) {
          aftermarketDoneDate = today;
          refreshPrices(true);
          if (location.hash.indexOf("aftermarket") >= 0) ST.Aftermarket.render();
        }
        updateAutoStatus();
      } else {
        updateAutoStatus(); // 非交易时段：不刷新，仅更新状态
      }
    }, checkMs);
    updateAutoStatus();
  }
  function updateAutoStatus() {
    const el = document.getElementById("autoStatus");
    const btn = document.getElementById("btnToggleAuto");
    if (strat.autoUpdate) {
      el.textContent = isTradingSession()
        ? "自动更新：已开启（交易中）"
        : `自动更新：等待开盘（${sessionDesc()}）`;
      el.classList.remove("off");
      btn.textContent = "暂停自动";
    } else {
      el.textContent = "自动更新：已暂停";
      el.classList.add("off");
      btn.textContent = "开启自动";
    }
  }

  // 模态框
  function openModal(id) {
    document.getElementById(id).classList.add("open");
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove("open");
  }

  // 添加股票
  function openAdd() {
    document.getElementById("addCode").value = "";
    document.getElementById("addName").value = "";
    document.getElementById("addConcept").value = "";
    document.getElementById("addNote").value = "";
    document.getElementById("addClose").value = "";
    document.getElementById("addMarket").value = "auto";
    document.getElementById("addDate").value = ST.Market.todayStr();
    document.getElementById("addHint").textContent = "";
    openModal("addModal");
    setTimeout(() => document.getElementById("addCode").focus(), 50);
  }
  function confirmAdd() {
    const code = document.getElementById("addCode").value;
    const parsed = ST.Market.parseCode(code);
    const hint = document.getElementById("addHint");
    if (!parsed) { hint.textContent = "代码格式不正确，请输入 6 位数字代码（如 600519 或 sz000001）。"; return; }
    if (stocks.some(s => s.id === parsed.market + parsed.code)) {
      hint.textContent = "该股票已在跟踪列表中。"; return;
    }
    const max = (ST.PortfolioConfig && ST.PortfolioConfig.get().maxHoldings) || 40;
    if (stocks.length >= max) {
      hint.textContent = `已达「最多同时持有 ${max} 只」上限，请先在「⚙ 设置」中调整或移除其他股票。`; return;
    }
    const stock = ST.Market.createStock({
      code: parsed.code,
      market: parsed.market,
      name: document.getElementById("addName").value,
      concept: document.getElementById("addConcept").value,
      note: document.getElementById("addNote").value,
      includeDate: document.getElementById("addDate").value || ST.Market.todayStr(),
      includeClose: document.getElementById("addClose").value
    });
    if (!stock) { hint.textContent = "创建失败，请检查输入。"; return; }
    stocks.push(stock);
    saveAll();
    // 自动记录「纳入股票池」
    recordOp("add", stock, { price: stock.currentPrice, note: "纳入跟踪池" });
    renderAll();
    closeModal("addModal");
    ST.UI.toast(`已添加 ${stock.name} (${stock.code})`, "success");
    // 后台拉取该股真实 K 线（重建真实均线 / 走势图），完成后刷新
    ST.Market.hydrateKlines(stock).then(() => { renderAll(); saveAll(); });
  }

  // 输入代码后自动查询并填充名称 / 现价（经本地代理，失败则回退内置预设名称）
  let addCodeTimer = null;
  async function onAddCodeInput() {
    const code = document.getElementById("addCode").value;
    const parsed = ST.Market.parseCode(code);
    const hint = document.getElementById("addHint");
    if (addCodeTimer) clearTimeout(addCodeTimer);
    addCodeTimer = setTimeout(async () => {
      if (!parsed) { hint.textContent = "输入 6 位代码后将自动匹配股票名称与价格。"; return; }
      hint.textContent = "正在查询…";
      let name = "", price = 0;
      try {
        const quotes = await ST.Market.fetchQuotes([parsed.code]);
        const q = quotes && quotes.find(x => x.code === parsed.code);
        if (q) { name = q.name || ""; price = parseFloat(q.price); }
      } catch (e) { /* 无网络则回退预设 */ }
      if (!name) {
        const preset = ST.Market.PRESET[parsed.code];
        if (preset) name = preset[0];
      }
      if (name) document.getElementById("addName").value = name;
      if (price > 0) document.getElementById("addClose").value = price;
      hint.textContent = price > 0
        ? `已匹配：${name || parsed.code}，现价 ¥${ST.Market.round2(price)}`
        : (name ? `已匹配名称：${name}（现价未获取，可手动填写）` : "未查询到该股票，请手动填写名称与价格。");
    }, 350);
  }

  // 移除
  function removeStock(id) {
    const s = stocks.find(x => x.id === id);
    if (!s) return;
    if (!confirm(`确认从跟踪列表移除 ${s.name} (${s.code})？\n（仅移除跟踪，不影响真实持仓）`)) return;
    stocks = stocks.filter(x => x.id !== id);
    recordOp("remove", s, { note: "从跟踪列表移除" });
    saveAll();
    renderAll();
    ST.UI.toast("已移除 " + s.name, "success");
  }

  // ---- 批量移除 ----
  let batchMode = false;
  function setBatch(v) {
    batchMode = v;
    ST.UI.batch = v;
    const bar = document.getElementById("batchSelBar");
    const btn = document.getElementById("btnBatchRemove");
    const thSel = document.getElementById("thBatchSel");
    if (bar) bar.hidden = !v;
    if (btn) btn.textContent = v ? "退出批量" : "批量移除";
    if (!v && thSel) thSel.innerHTML = "";   // 退出时清空表头全选框
    updateBatchCount();
    renderAll();
  }
  function updateBatchCount() {
    const n = document.querySelectorAll("#stockTbody .row-check:checked").length;
    const el = document.getElementById("batchSelCount");
    if (el) el.textContent = n;
  }
  function removeStockBatch(ids) {
    const target = stocks.filter(x => ids.includes(x.id));
    if (!target.length) return;
    const names = target.map(s => `${s.name}(${s.code})`).join("、");
    if (!confirm(`确认从跟踪列表批量移除 ${target.length} 只？\n${names}\n（仅移除跟踪，不影响真实持仓）`)) return;
    const idSet = new Set(ids);
    target.forEach(s => recordOp("remove", s, { note: "批量移除" }));
    stocks = stocks.filter(x => !idSet.has(x.id));
    saveAll();
    setBatch(false);
    renderAll();
    ST.UI.toast("已批量移除 " + target.length + " 只", "success");
  }

  // 研究
  function researchStock(id) {
    const s = stocks.find(x => x.id === id);
    if (!s) return;
    ST.UI.renderResearch(s, strat);
    openModal("researchModal");
  }

  // 编辑股票（核心概念 / 备注）
  let editId = "";
  function editStock(id) {
    const s = stocks.find(x => x.id === id);
    if (!s) return;
    editId = id;
    document.getElementById("editTitle").textContent = `编辑 ${s.name} (${s.code})`;
    document.getElementById("editConcept").value = s.concept || "";
    document.getElementById("editNote").value = s.note || "";
    openModal("editModal");
    setTimeout(() => document.getElementById("editConcept").focus(), 50);
  }
  function confirmEdit() {
    const s = stocks.find(x => x.id === editId);
    if (!s) return;
    s.concept = document.getElementById("editConcept").value.trim();
    s.note = document.getElementById("editNote").value.trim();
    saveAll();
    renderAll();
    closeModal("editModal");
    ST.UI.toast("已保存修改", "success");
  }

  // ---- 策略管理 ----
  let editingStrategyId = null; // null=新增
  function openStrategyAdd() {
    editingStrategyId = null;
    ST.UI.renderStrategyEditForm(null);
    openModal("strategyEditModal");
  }
  function editStrategyByIdx(idx) {
    const s = strategies[idx];
    if (!s) return;
    editingStrategyId = s.id;
    ST.UI.renderStrategyEditForm(Object.assign({}, s));
    openModal("strategyEditModal");
  }
  function saveStrategyEdit() {
    const form = ST.UI.readStrategyEditForm();
    if (!form.name) { ST.UI.toast("请填写策略名称", "error"); return; }
    if (editingStrategyId) {
      const s = strategies.find(x => x.id === editingStrategyId);
      if (s) { s.name = form.name; s.attr = form.attr; s.params = form.params; }
    } else {
      strategies.push({
        id: "strat_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
        name: form.name, attr: form.attr, enabled: true, params: form.params
      });
    }
    saveAll();
    closeModal("strategyEditModal");
    ST.UI.renderStrategyManage(strategies);
    renderAll();
    ST.UI.toast("策略已保存", "success");
  }
  function toggleStrategyByIdx(idx) {
    const s = strategies[idx];
    if (!s) return;
    s.enabled = !s.enabled;
    saveAll();
    ST.UI.renderStrategyManage(strategies);
    ST.UI.toast(s.enabled ? `已启用「${s.name}」` : `已停用「${s.name}」`, "success");
  }
  function deleteStrategyByIdx(idx) {
    const s = strategies[idx];
    if (!s) return;
    if (!confirm(`确认删除策略「${s.name}」？`)) return;
    strategies.splice(idx, 1);
    saveAll();
    ST.UI.renderStrategyManage(strategies);
    ST.UI.toast("已删除策略", "success");
  }

  // 设置（交易费用）
  function openSettings() {
    ST.UI.renderSettingsForm();
    openModal("settingsModal");
  }
  function saveSettings() {
    ST.TradeConfig.save(ST.UI.readTradeConfigForm());
    ST.PortfolioConfig.save(ST.UI.readPortfolioForm());
    closeModal("settingsModal");
    ST.UI.toast("设置已保存", "success");
  }

  // 操作记录
  function recordOp(type, stock, extra) {
    const op = Object.assign({}, extra, {
      id: "op_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      type: type,
      code: stock.code,
      name: stock.name,
      ts: Date.now()
    });
    ST.Storage.addOperation(op);
    // 买入/卖出：刷新顶部最新提醒
    if (type === "buy" || type === "sell") renderLatestAlert(op, stocks);
    return op;
  }
  function openOperation() {
    ST.UI.renderOperationModal(ST.Storage.getOperations(), stocks);
    openModal("opModal");
  }
  function addOp() {
    const stockId = document.getElementById("opStock").value;
    const stock = stocks.find(s => s.id === stockId);
    if (!stock) { ST.UI.toast("请选择股票", "error"); return; }
    const price = parseFloat(document.getElementById("opPrice").value);
    const qty = parseInt(document.getElementById("opQty").value, 10);
    if (!(price > 0) || !(qty > 0)) { ST.UI.toast("请填写正确的价格与数量", "error"); return; }
    const type = document.getElementById("opType").value;
    const note = document.getElementById("opNote").value.trim();
    const amount = Math.round(price * qty * 100) / 100;
    // 计算手续费（印花税卖出收取）
    const fee = type === "buy" ? ST.TradeConfig.buyFee(amount) : ST.TradeConfig.sellFee(amount);
    const stamp = type === "buy" ? 0 : Math.round((amount * ST.TradeConfig.get().stampDutyRate) * 100) / 100;
    recordOp(type, stock, { price: price, qty: qty, amount: amount, fee: fee, stamp: stamp, note: note });
    ST.UI.toast(`已记录${type === "buy" ? "买入" : "卖出"} ${stock.name}`, "success");
    ST.UI.renderOperationModal(ST.Storage.getOperations(), stocks);
  }

  // 事件绑定
  function bind() {
    document.getElementById("btnManualUpdate").addEventListener("click", () => refreshPrices(false));
    document.getElementById("btnToggleAuto").addEventListener("click", () => {
      strat.autoUpdate = !strat.autoUpdate;
      saveAll();
      restartTimer();
      ST.UI.toast(strat.autoUpdate ? "已开启自动更新" : "已暂停自动更新", "success");
    });
    document.getElementById("btnAddStock").addEventListener("click", openAdd);
    document.getElementById("addCode").addEventListener("input", onAddCodeInput);
    document.getElementById("btnConfirmAdd").addEventListener("click", confirmAdd);
    document.getElementById("btnConfirmEdit").addEventListener("click", confirmEdit);
    // 策略管理
    document.getElementById("btnAddStrategy").addEventListener("click", openStrategyAdd);
    document.getElementById("btnSaveStrategyEdit").addEventListener("click", saveStrategyEdit);
    document.getElementById("strategyManageList").addEventListener("click", e => {
      const btn = e.target.closest("button[data-strat-act]");
      if (!btn) return;
      const card = btn.closest(".strat-card");
      const idx = parseInt(card.getAttribute("data-idx"), 10);
      const act = btn.getAttribute("data-strat-act");
      if (act === "toggle") toggleStrategyByIdx(idx);
      else if (act === "edit") editStrategyByIdx(idx);
      else if (act === "del") deleteStrategyByIdx(idx);
    });
    document.getElementById("btnSettings").addEventListener("click", openSettings);
    if (document.getElementById("btnRunBacktest") && ST.Backtest) {
      document.getElementById("btnRunBacktest").addEventListener("click", () => ST.Backtest.run());
    }
    if (document.getElementById("btnRefreshAftermarket") && ST.Aftermarket) {
      document.getElementById("btnRefreshAftermarket").addEventListener("click", () => {
        ST.Aftermarket.render();
        ST.UI.toast("盘后观察已刷新", "success");
      });
    }
    document.getElementById("btnSaveSettings").addEventListener("click", saveSettings);
    document.getElementById("btnOperations").addEventListener("click", openOperation);
    // 表头点击排序
    document.querySelectorAll("#stockTable thead th.sortable").forEach(th => {
      th.addEventListener("click", () => onHeaderClick(th.getAttribute("data-sort")));
    });
    // 操作记录弹窗：添加操作（事件代理）
    document.getElementById("opModal").addEventListener("click", e => {
      if (e.target.id === "btnAddOp") addOp();
    });

    // 关闭按钮（data-close）
    document.querySelectorAll("[data-close]").forEach(b =>
      b.addEventListener("click", () => closeModal(b.getAttribute("data-close"))));
    // 点击遮罩关闭
    document.querySelectorAll(".modal").forEach(m =>
      m.addEventListener("click", e => { if (e.target === m) m.classList.remove("open"); }));
    // Esc 关闭
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") document.querySelectorAll(".modal.open").forEach(m => m.classList.remove("open"));
    });

    // 添加弹窗：回车确认
    document.getElementById("addModal").addEventListener("keydown", e => {
      if (e.key === "Enter") confirmAdd();
    });
    // 代码输入：自动联想名称
    document.getElementById("addCode").addEventListener("input", e => {
      const parsed = ST.Market.parseCode(e.target.value);
      const nameInput = document.getElementById("addName");
      const conceptInput = document.getElementById("addConcept");
      if (parsed && ST.Market.PRESET[parsed.code] && !nameInput.value) {
        const [n, c] = ST.Market.PRESET[parsed.code];
        nameInput.value = n; conceptInput.value = c;
      }
    });

    // 表格按钮代理
    document.getElementById("stockTbody").addEventListener("click", e => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const tr = btn.closest("tr");
      const id = tr.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      if (act === "research") researchStock(id);
      else if (act === "edit") editStock(id);
      else if (act === "remove") removeStock(id);
    });

    // 批量移除：进入/退出批量模式
    const btnBatch = document.getElementById("btnBatchRemove");
    if (btnBatch) btnBatch.addEventListener("click", () => setBatch(!batchMode));
    const btnCancel = document.getElementById("btnCancelBatch");
    if (btnCancel) btnCancel.addEventListener("click", () => setBatch(false));
    const btnConfirm = document.getElementById("btnConfirmBatchRemove");
    if (btnConfirm) btnConfirm.addEventListener("click", () => {
      const ids = [].slice.call(document.querySelectorAll("#stockTbody .row-check:checked"))
        .map(cb => cb.getAttribute("data-id"));
      if (!ids.length) { ST.UI.toast("请先勾选要移除的股票", "error"); return; }
      removeStockBatch(ids);
    });
    // 行勾选 / 表头全选：更新已选计数
    document.getElementById("stockTbody").addEventListener("change", e => {
      if (e.target && e.target.classList.contains("row-check")) updateBatchCount();
    });
    const thSel = document.getElementById("thBatchSel");
    if (thSel) thSel.addEventListener("change", e => {
      if (e.target && e.target.id === "checkAll") {
        const v = e.target.checked;
        [].forEach.call(document.querySelectorAll("#stockTbody .row-check"), cb => cb.checked = v);
        updateBatchCount();
      }
    });

    // 筛选
    document.getElementById("filterInput").addEventListener("input", e => {
      filterText = e.target.value.trim();
      const list = applySort(filtered(), strat, sortState);
      ST.UI.renderTable(list, strat, sortState);
    });

    // 最新提醒：关闭按钮
    document.getElementById("alertClose").addEventListener("click", () => {
      const el = document.getElementById("latestAlert");
      el.hidden = true;
    });

    // 左侧路由：跟踪系统 / 历史操作
    window.addEventListener("hashchange", route);
    // 侧边抽屉导航：尖角按钮展开/收起；点击遮罩回收
    document.getElementById("navToggle").addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
    document.getElementById("navOverlay").addEventListener("click", () => setNav(false));
    document.getElementById("histFilter").addEventListener("input", e =>
      ST.UI.setHistoryFilter({ kw: e.target.value.trim() }));
    document.getElementById("histType").addEventListener("change", e =>
      ST.UI.setHistoryFilter({ type: e.target.value }));
    document.getElementById("histDateFrom").addEventListener("change", e =>
      ST.UI.setHistoryFilter({ from: e.target.value }));
    document.getElementById("histDateTo").addEventListener("change", e => {
      // 若设置了「从」则校验跨度并可能回填
      const backend = document.getElementById("histDateFrom").value;
      ST.UI.setHistoryFilter(backend ? { from: backend, to: e.target.value } : { to: e.target.value });
      // 重新同步因跨度修正而回填的「到」值
      document.getElementById("histDateTo").value = document.getElementById("histDateTo").value;
    });
    // 资产分析：区间切换
    document.querySelectorAll("#assetRangeTabs .rtab").forEach(b =>
      b.addEventListener("click", () => ST.UI.setAssetRange(b.getAttribute("data-range"))));
    document.getElementById("assetFrom").addEventListener("change", () => ST.UI.setAssetRange("custom"));
    document.getElementById("assetTo").addEventListener("change", () => ST.UI.setAssetRange("custom"));
    // 清仓股票：日期过滤
    document.getElementById("clDateFrom").addEventListener("change", e =>
      ST.UI.setClosedFilter({ from: e.target.value, to: document.getElementById("clDateTo").value }));
    document.getElementById("clDateTo").addEventListener("change", e =>
      ST.UI.setClosedFilter({ from: document.getElementById("clDateFrom").value, to: e.target.value }));
  }

  // 设置抽屉开关状态
  function setNav(open) {
    document.body.classList.toggle("nav-open", !!open);
    updateNavToggle();
  }
  // 更新箭头方向：收起时显示 ▸（向外推），展开时显示 ◂（向回收）
  function updateNavToggle() {
    const open = document.body.classList.contains("nav-open");
    document.getElementById("navToggle").textContent = open ? "◂" : "▸";
  }

  // hash 路由：切换视图并高亮导航
  function route() {
    const view = location.hash.replace(/^#\/?/, "") || "tracking";
    const v = (view === "history" || view === "asset" || view === "closed" || view === "strategy" || view === "backtest" || view === "aftermarket") ? view : "tracking";
    showView(v);
  }
  // 本地日期 → yyyy-MM-dd
  function isoDate(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // 默认日期区间：历史操作最近7天；清仓股票最近1个月
  function defaultSpan(days) {
    const to = new Date(), from = new Date(); from.setDate(from.getDate() - days);
    return { from: isoDate(from), to: isoDate(to) };
  }

  function showView(view) {
    const tracking = document.getElementById("viewTracking");
    const history = document.getElementById("viewHistory");
    const asset = document.getElementById("viewAssetAnalysis");
    const closed = document.getElementById("viewClosed");
    const strategy = document.getElementById("viewStrategy");
    const backtest = document.getElementById("viewBacktest");
    const aftermarket = document.getElementById("viewAftermarket");
    if (!tracking || !history || !asset || !closed || !strategy || !backtest || !aftermarket) return;
    tracking.hidden = view !== "tracking";
    history.hidden = view !== "history";
    asset.hidden = view !== "asset";
    closed.hidden = view !== "closed";
    strategy.hidden = view !== "strategy";
    backtest.hidden = view !== "backtest";
    aftermarket.hidden = view !== "aftermarket";
    const navs = document.querySelectorAll(".nav-item");
    navs.forEach(n => n.classList.toggle("active", n.getAttribute("data-view") === view));
    if (view === "history") {
      // 进入历史页：默认最近7天并渲染
      const sp = defaultSpan(7);
      document.getElementById("histDateFrom").value = sp.from;
      document.getElementById("histDateTo").value = sp.to;
      ST.UI.setHistoryFilter({ kw: "", type: "", from: sp.from, to: sp.to });
    } else if (view === "asset") {
      // 进入资产分析页：渲染并等待画布布局后绘图
      ST.UI.renderAssetAnalysis(ST.App.getStocks());
    } else if (view === "closed") {
      // 进入清仓股票页：默认最近1个月（按清仓日）并渲染
      const sp = defaultSpan(30);
      document.getElementById("clDateFrom").value = sp.from;
      document.getElementById("clDateTo").value = sp.to;
      ST.UI.setClosedFilter({ from: sp.from, to: sp.to });
    } else if (view === "strategy") {
      // 进入策略管理页：渲染列表
      ST.UI.renderStrategyManage(strategies);
    } else if (view === "backtest") {
      // 进入回测页：填充配置（股票多选 / 区间 / 初始资金）
      if (ST.Backtest) ST.Backtest.renderConfig();
    } else if (view === "aftermarket") {
      // 进入盘后观察页：实时计算渲染
      if (ST.Aftermarket) ST.Aftermarket.render();
    }
  }

  // 显示最新一条操作提醒
  function renderLatestAlert(op, stocks) {
    const box = document.getElementById("latestAlert");
    const tag = document.getElementById("alertTag");
    const stockEl = document.getElementById("alertStock");
    const timeEl = document.getElementById("alertTime");
    const detailEl = document.getElementById("alertDetail");
    const d = new Date(op.ts);
    const time = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0") + " " +
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    tag.textContent = op.type === "buy" ? "买入" : "卖出";
    tag.className = "alert-tag " + (op.type === "buy" ? "tag-buy" : "tag-sell");
    stockEl.textContent = (op.name || op.code) + " (" + op.code + ")";
    timeEl.textContent = time;
    const amt = op.amount != null ? op.amount.toFixed(2) : "—";
    const feePart = op.fee != null ? `（手续费 ${op.fee.toFixed(2)} 元${op.stamp ? "，含印花税 " + op.stamp.toFixed(2) : ""}）` : "";
    const detailLine = `@ ${op.price} × ${op.qty} 股 = ${amt} 元 ${feePart}`;
    // 交易性质：买入 → 新买入/加仓 + 占全仓几成；卖出 → 清仓/卖出该股比例
    let natureLine = "";
    if (ST.Holding && ST.Storage) {
      const stock = (stocks || []).find(s => s.code === op.code);
      const all = ST.Storage.getOperations();
      const others = all.filter(o => o.id !== op.id && o.code === op.code);
      const st = stock || { code: op.code, currentPrice: op.price };
      const hBefore = ST.Holding.compute(st, others);
      const hAfter = ST.Holding.compute(st, all);
      if (op.type === "buy") {
        const totalAsset = (ST.UI && ST.UI.computeAssets) ? ST.UI.computeAssets(stocks || []).totalAsset : 0;
        const ratio = totalAsset > 0 ? (op.amount / totalAsset) * 100 : 0;
        const cheng = ratio / 10;
        const kind = hBefore.qty > 0 ? "加仓" : "新买入";
        natureLine = `<div class="alert-nature">${kind}<span class="nature-amt">占当前总资产约 ${ratio.toFixed(1)}%（约 ${cheng.toFixed(1)} 成仓位）</span></div>`;
      } else {
        if (hBefore.qty > 0 && hAfter.qty <= 0) {
          natureLine = `<div class="alert-nature">清仓</div>`;
        } else if (hBefore.qty > 0) {
          const pct = (op.qty / hBefore.qty) * 100;
          natureLine = `<div class="alert-nature">卖出该股约 ${pct.toFixed(0)}% 仓位</div>`;
        } else {
          natureLine = `<div class="alert-nature">卖出（持仓为 0）</div>`;
        }
      }
    }
    detailEl.innerHTML = (natureLine || "") + `<div>${detailLine}</div>`;
    box.hidden = false;
  }
  // 加载今日操作中最新的一条买入/卖出
  function loadLatestAlert() {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const ops = ST.Storage.getOperations()
      .filter(o => (o.ts || 0) >= todayStart.getTime())
      .filter(o => o.type === "buy" || o.type === "sell")
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (ops[0]) renderLatestAlert(ops[0], stocks);
  }

  function init() {
    // 先等服务端数据同步完成（失败也立即返回，本地模式可用），再读取并渲染
    ST.Storage.ensureLoaded().then(() => {
      stocks = ST.Storage.getStocks();
      // 校准已有股票的均线/序列（MA 改为纯日收盘口径，与交易软件一致）
      stocks.forEach(s => {
        if (s && s.dailyCloses && s.dailyCloses.length) { try { ST.Market.recompute(s); } catch (e) { } }
      });
      strat = ST.Storage.getStrategy();
      strategies = ST.Storage.getStrategies();
      bind();
      renderAll();
      // 补齐历史 OHLC（K 线蜡烛图需要）：旧数据无 OHLC 时补拉一次，成功后持久化
      stocks.forEach(s => {
        if (s && s.code && !(s.dailyOpens && s.dailyOpens.length)) {
          ST.Market.hydrateKlines(s).then(() => saveAll()).catch(() => { });
        }
      });
      loadLatestAlert();
      updateAutoStatus();
      updateLastUpdate();
      restartTimer();
      // 初始化后立即拉一次真实行情（含真实昨收），
      // 让「今日涨跌」基于上一交易日收盘计算，而非沿用旧的错误昨收（=纳入价）。
      refreshPrices(true);
      route(); // 初始化左侧路由视图
      updateNavToggle(); // 侧边导航默认收起
    });
  }

  document.addEventListener("DOMContentLoaded", init);

  ST.App = { getStocks, refreshPrices, init };
})(window.ST);
