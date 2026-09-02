// demo.js — 一键填充 / 清空演示数据，方便验证各功能
// 使用：点击界面上的「示例数据 / 清空」按钮，或控制台执行 ST.Demo.load() / ST.Demo.clear()
window.ST = window.ST || {};

(function (ST) {
  const day = 86400000;

  function dateStr(ts) {
    const d = new Date(ts);
    const p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // 生成一套演示数据并写入本地存储
  function load() {
    const now = Date.now();
    // 当前跟踪股票（其中前 3 只已建仓持有多，其余仅纳入）
    const defs = [
      ["600519", "贵州茅台", 1700, 20, -2],
      ["601318", "中国平安", 50, 15, -2],
      ["300750", "宁德时代", 210, 25, -6],
      ["600887", "伊利股份", 28, 10, -9],
      ["002594", "比亚迪", 250, 0, -120],
      ["601012", "隆基绿能", 40, 5, -15],
      ["000858", "五粮液", 160, 8, -3]
    ];
    const stocks = defs.map(x =>
      ST.Market.createStock({ code: x[0], name: x[1], includeClose: x[2], includeDate: dateStr(now - x[4] * day), position: x[3] })
    );
    for (let k = 0; k < 5; k++) ST.Market.tickAll(stocks); // 制造今日涨跌
    ST.Storage.saveStocks(stocks);

    // 操作记录：当前持仓建仓 + 今日加仓 + 7 只已清仓（做T / 普通）
    const ops = [];
    let i = 0;
    const buy = (code, name, price, qty, at, note) =>
      ops.push({ id: "b" + (i++), code, name, type: "buy", price, qty, amount: Math.round(price * qty * 100) / 100, ts: now - at * day, note });
    const sell = (code, name, price, qty, at, note) =>
      ops.push({ id: "s" + (i++), code, name, type: "sell", price, qty, amount: Math.round(price * qty * 100) / 100, ts: now - at * day, note });

    // 当前持仓建仓 + 今日加仓（供「今日操作 / 最新提醒 / 历史7天」演示）
    buy("600519", "贵州茅台", 1700, 100, 2, "建仓");
    buy("601318", "中国平安", 50, 1000, 6, "建仓");
    buy("300750", "宁德时代", 210, 200, 2, "建仓");
    buy("601318", "中国平安", 52, 300, 0, "今日加仓");

    // 已清仓：做T 多次（清仓日 -5）
    buy("600001", "清仓科技A", 10, 1000, 40, "建仓");
    buy("600001", "清仓科技A", 10.8, 500, 30, "加仓");
    sell("600001", "清仓科技A", 11.5, 700, 20, "高抛做T");
    buy("600001", "清仓科技A", 11, 600, 15, "低吸回补");
    sell("600001", "清仓科技A", 12.2, 1400, 5, "清仓");
    // 已清仓：做T（清仓日 -2）
    buy("600002", "清仓科技B", 20, 400, 25, "建仓");
    sell("600002", "清仓科技B", 21, 200, 18, "做T卖");
    buy("600002", "清仓科技B", 20.5, 200, 12, "做T买回");
    sell("600002", "清仓科技B", 20.9, 400, 2, "清仓");
    // 已清仓：普通亏损（清仓日 -8）
    buy("600003", "清仓医药C", 50, 300, 50, "建仓");
    sell("600003", "清仓医药C", 48, 300, 8, "清仓亏损");
    // 已清仓：普通盈利（清仓日 -70，超出最近一月）
    buy("600004", "清仓能源D", 30, 400, 90, "建仓");
    sell("600004", "清仓能源D", 33, 400, 70, "清仓");
    // 已清仓（清仓日 -6）
    buy("600005", "清仓消费E", 15, 500, 28, "建仓");
    buy("600005", "清仓消费E", 15.5, 200, 22, "加仓");
    sell("600005", "清仓消费E", 16, 700, 6, "清仓");
    // 已清仓（清仓日 -3）
    buy("600006", "清仓金融F", 12, 600, 24, "建仓");
    sell("600006", "清仓金融F", 11, 600, 3, "清仓");
    // 已清仓：做T 复杂（清仓日 -1）
    buy("600007", "清仓制造G", 8, 800, 50, "建仓");
    buy("600007", "清仓制造G", 8.4, 400, 35, "加仓");
    sell("600007", "清仓制造G", 9, 600, 16, "做T减仓");
    buy("600007", "清仓制造G", 8.8, 300, 10, "回补");
    sell("600007", "清仓制造G", 9.3, 900, 1, "清仓");

    ST.Storage.saveOperations(ops);
    return { stocks: stocks.length, ops: ops.length };
  }

  // 清空所有业务数据（本地 + 服务端）
  function clear() {
    ST.Storage.saveStocks([]);
    ST.Storage.saveOperations([]);
    ST.Storage.clearAll(["st.stocks.v1", "st.ops.v1", "st.meta.v1"]);
    return { stocks: 0, ops: 0 };
  }

  ST.Demo = { load, clear };
})(window.ST);