// storage.js — 数据持久化：内存缓存 + localStorage 镜像 + 服务端 SQLite 同步
// 说明：
//   - 对外接口保持同步、与旧版完全一致，所有调用点无需改动；
//   - 写入时同步更新内存与 localStorage（即时响应），并防抖推送整份数据到服务端 /api/state；
//   - 启动时先读本地（秒开），再从服务端拉取一次；服务端有数据且 meta.lastUpdate 较新则以其为准；
//   - 未部署 / 离线 / file:// 直开时自动回退为纯本地模式，不影响使用。
window.ST = window.ST || {};

(function (ST) {
  const KEY_STOCKS = "st.stocks.v1";
  const KEY_STRATEGY = "st.strategy.v1";
  const KEY_STRATEGIES = "st.strategies.v1";
  const KEY_META = "st.meta.v1";
  const KEY_OPS = "st.ops.v1";
  const KEY_TRADE = "st.trade.v1";
  const KEY_PORTFOLIO = "st.portfolio.v1";
  const ALL_KEYS = [KEY_STOCKS, KEY_STRATEGY, KEY_STRATEGIES, KEY_META, KEY_OPS, KEY_TRADE, KEY_PORTFOLIO];

  // 默认策略参数
  const DEFAULT_STRATEGY = {
    shortMA: 5,        // 短期均线
    midMA: 20,         // 中期均线
    longMA: 60,        // 长期均线
    stopLoss: 8,       // 止损线（累计跌幅 %）
    takeProfit: 25,    // 止盈线（累计涨幅 %）
    breakoutRatio: 0.01, // 突破阈值（相对 MA5 偏离 1%）
    autoUpdate: true,    // 是否开启自动更新
    intervalSec: 60     // 自动更新间隔（秒）
  };

  const cache = {};        // 内存缓存（会话内唯一数据源）
  let syncTimer = null;
  let loadPromise = null;
  const SYNC_DELAY = 600;  // 写入防抖毫秒数

  // ---------- 底层读写 ----------
  function memRead(key) {
    return (key in cache) ? cache[key] : undefined;
  }

  function rawFromLocal(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : undefined;
    } catch (e) { return undefined; }
  }

  function read(key, fallback) {
    let v = memRead(key);
    if (v === undefined) v = rawFromLocal(key);
    if (v === undefined) return fallback;
    cache[key] = v;
    return v;
  }

  function write(key, value) {
    cache[key] = value;
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { }
    scheduleSync();
    return true;
  }

  // ---------- 服务端同步 ----------
  function collectState() {
    const payload = {};
    ALL_KEYS.forEach(k => { if (k in cache) payload[k] = cache[k]; });
    return payload;
  }

  function scheduleSync() {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; pushToServer(); }, SYNC_DELAY);
  }

  async function pushToServer() {
    const payload = collectState();
    if (!Object.keys(payload).length) return;
    try {
      await fetch("/api/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } catch (e) { /* 离线 / 未部署：忽略 */ }
  }

  function lastUpdateOf(state) {
    const m = state && state[KEY_META];
    return (m && m.lastUpdate) || "";
  }

  function applyServerState(state) {
    ALL_KEYS.forEach(k => {
      if (state[k] === undefined) return;
      if (JSON.stringify(state[k]) !== JSON.stringify(cache[k])) {
        cache[k] = state[k];
        try { localStorage.setItem(k, JSON.stringify(state[k])); } catch (e) { }
      }
    });
  }

  // 启动时从服务端拉取一次：服务端为空则把本地推上去（首次迁移）；
  // 两侧都有数据时以 meta.lastUpdate 较新的一侧为准。
  async function loadFromServer() {
    try {
      const r = await fetch("/api/state", { method: "GET", cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (!j || !j.ok || !j.state) return;
      const serverState = j.state || {};
      const hasServerData = ALL_KEYS.some(k => serverState[k] !== undefined);
      if (!hasServerData) {
        pushToServer();
        return;
      }
      if (lastUpdateOf(serverState) >= lastUpdateOf(collectState())) {
        applyServerState(serverState);
      } else {
        pushToServer();
      }
    } catch (e) { /* 未部署 / 离线：保持本地模式 */ }
  }

  // 等待首次服务端同步完成（失败也会 resolve，本地模式可用）
  function ensureLoaded() {
    if (!loadPromise) loadPromise = loadFromServer();
    return loadPromise;
  }

  // ---------- 对外接口（与旧版保持一致） ----------
  ST.Storage = {
    ensureLoaded,
    getStocks() {
      const arr = read(KEY_STOCKS, []);
      return Array.isArray(arr) ? arr : [];
    },
    saveStocks(stocks) {
      return write(KEY_STOCKS, stocks);
    },
    getStrategy() {
      return Object.assign({}, DEFAULT_STRATEGY, read(KEY_STRATEGY, {}));
    },
    saveStrategy(strategy) {
      return write(KEY_STRATEGY, Object.assign({}, DEFAULT_STRATEGY, strategy));
    },
    // 策略库（策略管理页）：数组 [{id,name,attr,enabled,params}]
    getStrategies() {
      const arr = read(KEY_STRATEGIES, null);
      if (Array.isArray(arr) && arr.length) return arr;
      // 首次使用：用默认买入/卖出策略播种
      const seed = (ST.Strategy && ST.Strategy.defaultStrategies) ? ST.Strategy.defaultStrategies() : [];
      if (seed.length) write(KEY_STRATEGIES, seed);
      return seed;
    },
    saveStrategies(list) {
      return write(KEY_STRATEGIES, Array.isArray(list) ? list : []);
    },
    getMeta() {
      return Object.assign({ lastUpdate: null }, read(KEY_META, {}));
    },
    saveMeta(meta) {
      return write(KEY_META, Object.assign({}, ST.Storage.getMeta(), meta));
    },
    // 操作记录
    getOperations() {
      const arr = read(KEY_OPS, []);
      return Array.isArray(arr) ? arr : [];
    },
    saveOperations(ops) {
      return write(KEY_OPS, Array.isArray(ops) ? ops : []);
    },
    addOperation(op) {
      const ops = ST.Storage.getOperations();
      ops.push(op);
      ST.Storage.saveOperations(ops);
      return ops;
    },
    // 交易费用配置
    getTradeConfig(fallback) {
      return read(KEY_TRADE, fallback || {});
    },
    saveTradeConfig(cfg) {
      return write(KEY_TRADE, cfg || {});
    },
    // 投资组合配置
    getPortfolioConfig(fallback) {
      return read(KEY_PORTFOLIO, fallback || {});
    },
    savePortfolioConfig(cfg) {
      return write(KEY_PORTFOLIO, cfg || {});
    },
    _defaults: DEFAULT_STRATEGY
  };
})(window.ST);
