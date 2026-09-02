// config.js — 交易费用配置文件
// 手动修改 DEFAULT_TRADE_CONFIG 可调整默认值；页面「策略规则设置 → 交易费用」中修改会覆盖并持久化到 localStorage。
window.ST = window.ST || {};

(function (ST) {
  const DEFAULT_TRADE_CONFIG = {
    commissionRate: 0.0001,  // 佣金：万分之一（0.01%）
    commissionMin: 5,        // 最低佣金（元/笔）
    stampDutyRate: 0.0005,   // 印花税：万分之五（卖出时收取）
    enabled: true            // 是否启用费用计算
  };

  // 读取（合并默认值）
  function get() {
    return Object.assign({}, DEFAULT_TRADE_CONFIG, ST.Storage.getTradeConfig({}));
  }

  // 保存（合并默认值，缺省回退默认）
  function save(cfg) {
    ST.Storage.saveTradeConfig(Object.assign({}, DEFAULT_TRADE_CONFIG, cfg));
  }

  // 买入费用：仅佣金
  function buyFee(amount, apply) {
    const c = get();
    if (apply === false || !c.enabled) return 0;
    return round2(Math.max(amount * c.commissionRate, c.commissionMin));
  }

  // 卖出费用：佣金 + 印花税（印花税卖出收取）
  function sellFee(amount, apply) {
    const c = get();
    if (apply === false || !c.enabled) return 0;
    const comm = Math.max(amount * c.commissionRate, c.commissionMin);
    const stamp = amount * c.stampDutyRate;
    return round2(comm + stamp);
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  ST.TradeConfig = {
    defaults: DEFAULT_TRADE_CONFIG,
    get: get,
    save: save,
    buyFee: buyFee,
    sellFee: sellFee
  };

  // 投资组合配置
  const DEFAULT_PORTFOLIO = {
    initialCapital: 1000000, // 初始资金（元），默认 100 万
    maxHoldings: 40          // 最多同时持有股票个数（可在设置中调整）
  };
  function getPortfolio() {
    return Object.assign({}, DEFAULT_PORTFOLIO, ST.Storage.getPortfolioConfig({}));
  }
  function savePortfolio(cfg) {
    ST.Storage.savePortfolioConfig(Object.assign({}, DEFAULT_PORTFOLIO, cfg));
  }

  ST.PortfolioConfig = {
    defaults: DEFAULT_PORTFOLIO,
    get: getPortfolio,
    save: savePortfolio
  };
})(window.ST);