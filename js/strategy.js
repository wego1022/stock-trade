// strategy.js — 策略规则与信号生成
// 信号：持有 / 观望 / 卖出
// 规则依据可配置均线周期、止损/止盈阈值。
window.ST = window.ST || {};

(function (ST) {
  function ma(series, n) {
    if (!series || !series.length) return null;
    const slice = series.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
  function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  function r2pct(x) { return x == null ? null : Math.round(x * 100) / 100; }

  /**
   * 依据策略计算信号与依据
   * @param {Object} stock 含 currentPrice/series/cumChangePct 等
   * @param {Object} strat 策略参数 {shortMA,midMA,longMA,stopLoss,takeProfit,breakoutRatio}
   * @returns {{signal,basis,factors}}
   */
  function compute(stock, strat) {
    strat = strat || ST.Storage.getStrategy();
    const p = stock.currentPrice;
    const maS = ma(stock.series, strat.shortMA);
    const maM = ma(stock.series, strat.midMA);
    const maL = ma(stock.series, strat.longMA);
    const cum = stock.cumChangePct || 0;
    const tol = strat.breakoutRatio; // 偏离阈值
    const factors = [];

    // 各判定条件
    const f_aboveShort = p > maS * (1 - tol);
    const f_shortAboveMid = maS > maM;
    const f_priceAboveLong = p > maL;
    const f_aboveMid = p > maM;
    const f_belowShort = p < maS;
    const f_shortBelowMid = maS < maM;
    const f_stopLoss = cum <= -Math.abs(strat.stopLoss);
    const f_takeProfit = cum >= Math.abs(strat.takeProfit);
    const f_belowLong = p < maL;

    factors.push({ key: "止盈", pass: f_takeProfit, text: `累计涨幅 ${r2pct(cum)}% ${f_takeProfit ? "≥" : "<"} 止盈线 ${strat.takeProfit}%` });
    factors.push({ key: "止损", pass: f_stopLoss, text: `累计跌幅 ${r2pct(cum)}% ${f_stopLoss ? "≤" : ">"} 止损线 -${strat.stopLoss}%` });
    factors.push({ key: "价>短均", pass: f_aboveShort, text: `现价 ${r2(p)} ${f_aboveShort ? "高于" : "低于"} MA${strat.shortMA}(${r2(maS)})` });
    factors.push({ key: "短>中均", pass: f_shortAboveMid, text: `MA${strat.shortMA}(${r2(maS)}) ${f_shortAboveMid ? ">" : "≤"} MA${strat.midMA}(${r2(maM)})` });
    factors.push({ key: "价>长均", pass: f_priceAboveLong, text: `现价 ${r2(p)} ${f_priceAboveLong ? "高于" : "低于"} MA${strat.longMA}(${r2(maL)})` });
    factors.push({ key: "趋势转弱", pass: f_belowShort && f_shortBelowMid, text: `现价跌破短期均线且短均低于中期均线` });

    let signal = "watch";
    let basis = "";

    // 卖出优先级最高
    if (f_stopLoss) {
      signal = "sell";
      basis = `已触发止损：累计 ${r2pct(cum)}% 跌破 -${strat.stopLoss}% 风控线，建议卖出避险。`;
    } else if (f_takeProfit) {
      signal = "sell";
      basis = `已触达止盈：累计 ${r2pct(cum)}% 达到 ${strat.takeProfit}% 目标，可卖出兑现。`;
    } else if (f_belowLong) {
      signal = "sell";
      basis = `现价 ${r2(p)} 跌破长期支撑 MA${strat.longMA}(${r2(maL)})，中期趋势走弱，建议卖出。`;
    } else if (f_belowShort && f_shortBelowMid) {
      signal = "sell";
      basis = `现价 ${r2(p)} 跌破 MA${strat.shortMA}(${r2(maS)}) 且短均低于中均，短期转弱信号，考虑卖出。`;
    } else if (f_aboveShort && f_shortAboveMid && f_priceAboveLong) {
      signal = "hold";
      basis = `现价站上 MA${strat.shortMA}(${r2(maS)})，短均高于中均且位于长均之上，上升结构完好，继续持有。`;
    } else if (f_aboveShort && f_shortAboveMid && !f_priceAboveLong) {
      signal = "buy";
      basis = `现价 ${r2(p)} 站上 MA${strat.shortMA}(${r2(maS)})，短均(${r2(maS)})高于中均(${r2(maM)})，短中期转强但尚未上穿长均，处于启动阶段，建议买入。`;
    } else {
      signal = "watch";
      if (Math.abs(p - maM) < maM * tol * 2 && Math.abs(maS - maM) < maM * tol * 2) {
        basis = `已纳入股票池，现价、短均(${r2(maS)})、中均(${r2(maM)})纠缠，实际未满足买入条件，建议观望等待。`;
      } else if (!f_shortAboveMid) {
        basis = `已纳入股票池，MA${strat.shortMA}(${r2(maS)}) 仍在 MA${strat.midMA}(${r2(maM)}) 之下，尚未满足买入条件，观望等待。`;
      } else {
        basis = `已纳入股票池，趋势信号尚未形成买入条件，观望等待。`;
      }
    }

    return { signal, basis, factors, maShort: r2(maS), maMid: r2(maM), maLong: r2(maL) };
  }

  // 生成策略规则说明文档（HTML）
  function docHTML(strat) {
    strat = strat || ST.Storage.getStrategy();
    return `
    <h3 class="rule-buy">买入 (Buy)</h3>
    <p>短中期转强、处于启动阶段：</p>
    <ul>
      <li>现价站上 MA${strat.shortMA}（偏离阈值 ${(strat.breakoutRatio*100).toFixed(1)}% 内视为站上）</li>
      <li>MA${strat.shortMA} 高于 MA${strat.midMA}（短中期均线多头排列）</li>
      <li>现价尚未上穿 MA${strat.longMA}（未进入完全多头，属早期进场机会）</li>
    </ul>

    <h3 class="rule-hold">持有 (Hold)</h3>
    <p>买入后趋势成立，继续持有：</p>
    <ul>
      <li>现价高于 MA${strat.shortMA}</li>
      <li>MA${strat.shortMA} 高于 MA${strat.midMA}</li>
      <li>现价高于 MA${strat.longMA}（已站稳长期均线，完全多头）</li>
      <li>累计跌幅未触及 -${strat.stopLoss}% 止损线</li>
    </ul>

    <h3 class="rule-watch">观望 (Watch)</h3>
    <p>股票已纳入跟踪池，但尚未满足买入条件（趋势未转强或盘整纠缠），等待信号转为买入。</p>

    <h3 class="rule-sell">卖出 (Sell)</h3>
    <p>满足以下任一条件即触发：</p>
    <ul>
      <li>累计跌幅 ≤ -${strat.stopLoss}%（止损风控）</li>
      <li>累计涨幅 ≥ ${strat.takeProfit}%（止盈兑现）</li>
      <li>现价跌破 MA${strat.longMA}（长期支撑失守）</li>
      <li>现价跌破 MA${strat.shortMA} 且 MA${strat.shortMA} 低于 MA${strat.midMA}（短期转弱）</li>
    </ul>
    <p style="color:var(--text-mute);font-size:12px;margin-top:10px">注：均线基于本地历史收盘价计算，每分钟随最新价刷新；接入真实行情后依据不变。</p>`;
  }

  // ---- 策略库：属性（买入/卖出-部分止盈/卖出-清仓）----
  // attr: 'buy'          买入策略
  //       'sell_partial' 卖出-部分止盈（触发后按比例卖出一部分，剩余继续持有）
  //       'sell_all'     卖出-清仓（触发后全部卖出）
  // params:
  //   buy:            { shortMA, midMA, longMA, breakoutRatio? , pullRatio? }
  //   sell_partial:   { gainPct, ratio }            —— 累计涨幅达标卖出一部分
  //   sell_all:       { mode:'stoploss'|'belowMA', lossPct | ma }
  function defaultStrategies() {
    const d = (ST.Storage && ST.Storage._defaults) || { shortMA: 5, midMA: 20, longMA: 60, stopLoss: 8, takeProfit: 25, breakoutRatio: 0.01 };
    const tol = d.breakoutRatio != null ? d.breakoutRatio : 0.01;
    return [
      { id: "buy_breakout", name: "趋势突破买入", attr: "buy", enabled: true,
        params: { mode: "breakout", shortMA: d.shortMA, midMA: d.midMA, longMA: d.longMA, breakoutRatio: tol } },
      { id: "buy_dip", name: "回踩低吸买入", attr: "buy", enabled: false,
        params: { mode: "dip", shortMA: d.shortMA, midMA: d.midMA, longMA: d.longMA, pullRatio: 0.03 } },
      { id: "sell_partial", name: "部分止盈", attr: "sell_partial", enabled: true,
        params: { gainPct: d.takeProfit, ratio: 0.3 } },
      { id: "sell_belowMA", name: "跌破清仓", attr: "sell_all", enabled: true,
        params: { mode: "belowMA", ma: d.longMA } },
      { id: "sell_stoploss", name: "止损清仓", attr: "sell_all", enabled: true,
        params: { mode: "stoploss", lossPct: d.stopLoss } }
    ];
  }

  function maN(series, n) {
    if (!series || !series.length || !(n > 0)) return null;
    const slice = series.slice(-n);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  // 买入策略条件（不含持仓判断；持仓门外由 evaluate 处理）
  function buyCondition(stock, p) {
    const maS = maN(stock.series, p.shortMA || 5);
    const maM = maN(stock.series, p.midMA || 20);
    const maL = maN(stock.series, p.longMA || 60);
    if (maS == null || maM == null || maL == null) return false;
    const price = stock.currentPrice;
    if (p.mode === "dip") {
      // 上升趋势(短>中>长) + 价回踩中/长均线附近未破 + 拐头向上(价>昨收 且 价>短均)
      if (!(maS > maM && maM > maL)) return false;
      const prev = stock.prevClose != null ? stock.prevClose : stock.series[stock.series.length - 1];
      const nearMid = Math.abs(price - maM) <= maM * (p.pullRatio || 0.05);
      const aboveLong = price > maL;
      const turn = prev != null && price > prev && price > maS;
      return aboveLong && nearMid && turn;
    }
    // 突破：短>中>长（完全多头）且价站上长均
    const tol = p.breakoutRatio != null ? p.breakoutRatio : 0.01;
    return maS > maM && maM > maL && price >= maL * (1 - tol);
  }
  function sellPartialCondition(stock, p) {
    return (stock.cumChangePct || 0) >= (p.gainPct != null ? p.gainPct : 25);
  }
  function sellAllCondition(stock, p) {
    if (p.mode === "stoploss") {
      return (stock.cumChangePct || 0) <= -(Math.abs(p.lossPct != null ? p.lossPct : 8));
    }
    const maL = maN(stock.series, p.ma || 60);
    return maL != null && stock.currentPrice < maL;
  }
  const ATTR_TEXT = { buy: "买入", sell_partial: "卖出-部分止盈", sell_all: "卖出-清仓" };

  // 按策略库 + 当前持仓评估一只股票，得到状态化信号与动作
  // 规则（持仓驱动，天然满足“第二天”状态迁移）：
  //   - 无持仓 + 买入触发 → 买入(建议建仓) → 自动买入后转持有
  //   - 有持仓 + 卖出(部分/清仓)触发 → 卖出
  //   - 部分止盈已执行(N轮持仓) → 仍持有 → 信号转持有
  //   - 部分止盈/清仓卖出后无持仓 → 观望
  function evaluate(stock, strategies, allOps) {
    strategies = strategies || (ST.Storage ? ST.Storage.getStrategies() : []);
    allOps = allOps || (ST.Storage ? ST.Storage.getOperations() : []);
    const h = ST.Holding ? ST.Holding.compute(stock, allOps) : { qty: 0 };
    const holding = (h.qty || 0) > 0;

    // 逐条策略：仅统计启用且条件满足的
    const hits = { buy: null, sell_partial: null, sell_all: null };
    const factors = [];
    strategies.forEach(s => {
      if (!s || s.enabled === false) return;
      if (s.attr === "buy") {
        const pass = buyCondition(stock, s.params || {});
        factors.push({ key: `${ATTR_TEXT[s.attr]}·${s.name}`, pass, text: pass ? "条件满足" : "条件未满足" });
        if (pass && !holding && !hits.buy) hits.buy = s;
      } else if (s.attr === "sell_partial") {
        const pass = sellPartialCondition(stock, s.params || {});
        factors.push({ key: `${ATTR_TEXT[s.attr]}·${s.name}`, pass, text: pass ? "累计涨幅达标" : "累计涨幅未达" });
        if (pass && holding && !hits.sell_partial) hits.sell_partial = s;
      } else if (s.attr === "sell_all") {
        const pass = sellAllCondition(stock, s.params || {});
        factors.push({ key: `${ATTR_TEXT[s.attr]}·${s.name}`, pass, text: pass ? "条件满足" : "条件未满足" });
        if (pass && holding && !hits.sell_all) hits.sell_all = s;
      }
    });

    let action = null, signal, basis;
    const partialDone = !!stock.partialDone; // 本轮持仓是否已部分止盈过
    if (hits.sell_all) {
      action = "sell_all"; signal = "sell";
      basis = `卖出策略【${hits.sell_all.name}】触发：${hits.sell_all.params.mode === "stoploss" ? "已跌破止损线" : "跌破长期均线"}，建议清仓卖出。`;
    } else if (hits.sell_partial) {
      if (partialDone) {
        signal = "hold"; action = null;
        basis = `本轮已按【${hits.sell_partial.name}】执行过部分止盈，剩余仓位继续持有。`;
      } else {
        action = "sell_partial"; signal = "sell";
        const ratio = (hits.sell_partial.params && hits.sell_partial.params.ratio) || 0.3;
        basis = `卖出策略【${hits.sell_partial.name}】触发：累计涨幅达标，建议卖出约 ${Math.round(ratio * 100)}% 部分止盈。`;
      }
    } else if (hits.buy) {
      action = "buy"; signal = "buy";
      basis = `买入策略【${hits.buy.name}】触发：当前无持仓，建议买入建仓。`;
    } else {
      signal = holding ? "hold" : "watch";
      action = null;
      basis = holding ? "持有中，暂无卖出/止盈策略触发，继续持有。" : "无持仓，当前未触发买入策略，观望等待。";
    }
    return { signal, action, basis, factors, hits };
  }

  ST.Strategy = { compute: compute, evaluate: evaluate, docHTML: docHTML, defaultStrategies: defaultStrategies, ATTR_TEXT: ATTR_TEXT };
})(window.ST);
