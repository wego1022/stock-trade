// holding.js — 持仓计算：根据一只股票的全部买入/卖出操作计算余额/成本/盈亏/市值
// 移动平均法（A股最常见口径）：买入按 (旧金额+新金额)/(旧股数+新股数) 摊薄；卖出按当前平均成本扣减库存
window.ST = window.ST || {};
(function (ST) {
  function compute(stock, allOps) {
    if (!stock) return { qty: 0, avgCost: 0, cost: 0, realized: 0, marketValue: 0, pnl: 0, pnlPct: 0 };
    const code = stock.code;
    const ops = (allOps || []).filter(o => o.code === code);
    let qty = 0;          // 持有余额
    let cost = 0;         // 当前库存的"成本总额"（= qty × avgCost）
    let realized = 0;     // 已实现盈亏（卖出价 vs 当时成本价）
    ops.forEach(o => {
      if (o.type === "buy") {
        cost += o.amount; // 含手续费的成交金额入账为成本
        qty += o.qty;
      } else if (o.type === "sell") {
        if (qty <= 0) {
          realized += (o.amount || 0); // 空仓卖出不计算已实现亏损/收益（保守）
          return;
        }
        const avgCost = cost / qty;
        realized += (o.price - avgCost) * o.qty;
        cost -= avgCost * o.qty;
        qty -= o.qty;
        if (qty <= 0) { cost = 0; qty = 0; }
      }
    });
    const avgCost = qty > 0 ? cost / qty : 0;
    const price = stock.currentPrice || 0;
    const marketValue = qty * price;
    const unrealized = (price - avgCost) * qty;
    const pnl = unrealized + realized;
    const base = cost; // 当前持仓的成本基数
    const pnlPct = base > 0 ? (pnl / base) * 100 : 0;
    return { qty, avgCost, cost: base, realized, marketValue, pnl, pnlPct };
  }

  // 已清仓股票盈亏分析：实际频繁买卖（做T） vs 从建仓持有到清仓不动
  // 返回按盈亏金额大小排序的数组，每项含 实际盈亏/未动盈亏/差额/更优判定/操作明细
  function computeClosed(allOps, stocks) {
    const ops = (allOps || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const byCode = {};
    ops.forEach(o => {
      if (o.type === "buy" || o.type === "sell") (byCode[o.code] = byCode[o.code] || []).push(o);
    });
    const result = [];
    Object.keys(byCode).forEach(code => {
      const list = byCode[code];
      let buyQ = 0, sellQ = 0;
      list.forEach(o => o.type === "buy" ? buyQ += o.qty : sellQ += o.qty);
      if (!(buyQ > 0 && buyQ === sellQ)) return; // 未清仓 / 数据异常

      const stock = (stocks || []).find(s => s.code === code);
      const name = (stock && stock.name) || list[list.length - 1]?.name || code;

      // 实际做T盈亏（移动平均成本法，同 compute）
      let qty = 0, cost = 0, realized = 0, buyCount = 0, sellCount = 0;
      list.forEach(o => {
        if (o.type === "buy") { cost += (o.amount || o.price * o.qty); qty += o.qty; buyCount++; }
        else if (o.type === "sell") {
          if (qty > 0) {
            const ac = cost / qty;
            realized += (o.price - ac) * o.qty;
            cost -= ac * o.qty; qty -= o.qty;
            if (qty <= 0) { qty = 0; cost = 0; }
          }
          sellCount++;
        }
      });

      const open = list.find(o => o.type === "buy");
      const close = [...list].reverse().find(o => o.type === "sell");
      const openTs = open.ts || 0, closeTs = close.ts || openTs;
      // 反事实：从建仓买入 openQty@openPrice 持有到清仓再卖出（不动）
      const holdPnl = (close.price - open.price) * open.qty;
      const diff = realized - holdPnl; // 做T相对不动的超额
      const better = diff > 0.005 ? "做T更优" : diff < -0.005 ? "持有不动更优" : "基本持平";
      result.push({
        code, name,
        openPrice: open.price, openQty: open.qty, closePrice: close.price,
        openDate: openTs, closeDate: closeTs,
        buyCount, sellCount,
        realized, holdPnl, diff, better,
        ops: list
      });
    });
    result.sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized));
    return result;
  }
  ST.Holding = { compute, computeClosed };
})(window.ST);
