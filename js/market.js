// market.js — 行情数据模拟与更新
// 说明：本地浏览器无法直接请求新浪/腾讯等行情接口（CORS 限制），
// 此模块用几何布朗运动模拟行情，结构上保留了接入真实 API 的位置：
//   ST.Market.fetch(code) 可替换为真实请求，返回 {name, price, prevClose} 即可。
window.ST = window.ST || {};

(function (ST) {
  const HISTORY_DAYS = 90;       // 生成 90 日历史（>60 保证 MA60 可算）
  const TICK_VOL = 0.0025;       // 每分钟波动标准差 ~0.25%
  const DAILY_VOL = 0.018;       // 历史日波动 ~1.8%
  const DRIFT = 0.0006;          // 轻微上行漂移

  // 常见股票预设（代码 -> 名称 / 默认概念）
  const PRESET = {
    "600519": ["贵州茅台", "高端白酒/消费龙头"],
    "601318": ["中国平安", "保险/金融龙头"],
    "600036": ["招商银行", "股份制银行"],
    "000858": ["五粮液", "高端白酒"],
    "000001": ["平安银行", "股份制银行"],
    "000333": ["美的集团", "白电龙头"],
    "601166": ["兴业银行", "股份制银行"],
    "601398": ["工商银行", "国有大行"],
    "600276": ["恒瑞医药", "创新药龙头"],
    "300750": ["宁德时代", "动力电池龙头"],
    "002594": ["比亚迪", "新能源车"],
    "600887": ["伊利股份", "乳业龙头"],
    "601012": ["隆基绿能", "光伏龙头"],
    "002475": ["立讯精密", "消费电子"],
    "600900": ["长江电力", "水电龙头"],
    "601899": ["紫金矿业", "有色/黄金"],
    "600030": ["中信证券", "券商龙头"],
    "000725": ["京东方A", "半导体显示"],
    "002241": ["歌尔股份", "声学/VR"],
    "603259": ["药明康德", "CXO"]
  };

  function gaussian() {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function round2(x) { return Math.round(x * 100) / 100; }
  function round4(x) { return Math.round(x * 10000) / 10000; }

  // 代码 -> 市场
  function detectMarket(code) {
    code = String(code).trim();
    if (code.slice(0, 2) === "92") return "bj";   // 北交所 920 代码段
    const first = code.charAt(0);
    if (first === "6" || first === "9") return "sh";
    if (first === "0" || first === "2" || first === "3") return "sz";
    if (first === "8" || first === "4") return "bj";
    return "sh";
  }

  // 解析用户输入代码：支持 "sh600519" / "sz000001" / "600519"
  function parseCode(input) {
    let s = String(input == null ? "" : input).trim().toLowerCase().replace(/\s+/g, "");
    let market = null, code = s;
    const m = s.match(/^(sh|sz|bj)(.+)$/);
    if (m) { market = m[1]; code = m[2]; }
    code = code.replace(/[^0-9a-z]/g, "");
    if (!/^\d{6}$/.test(code)) return null;
    return { code: code.toUpperCase(), market: market || detectMarket(code) };
  }

  // 生成历史日收盘，最后值 = endPrice
  function genHistory(endPrice, days) {
    const closes = [endPrice];
    for (let i = 1; i < days; i++) {
      const ret = gaussian() * DAILY_VOL - DRIFT; // 反向漂移使前期略低
      let prev = closes[i - 1];
      let np = prev / (1 + ret);
      if (np < endPrice * 0.4) np = endPrice * 0.4;
      closes.push(round2(np));
    }
    closes.reverse();
    return closes;
  }

  // 计算均线
  function ma(series, n) {
    if (!series || !series.length) return null;
    const slice = series.slice(-n);
    return round2(slice.reduce((a, b) => a + b, 0) / slice.length);
  }

  // 重新计算一只股票的派生字段
  function recompute(stock) {
    const closes = stock.dailyCloses || [];
    const prevClose = closes.length ? closes[closes.length - 1] : stock.currentPrice;
    // 纯日收盘序列：均线/信号与交易软件口径一致（不含盘中实时价，实时价仅用于价格线与突破判断）
    const series = closes.slice();

    const todayChange = round4(stock.currentPrice - prevClose);
    const todayChangePct = prevClose ? round4(todayChange / prevClose * 100) : 0;
    const cumChange = round4(stock.currentPrice - stock.includeClose);
    const cumChangePct = stock.includeClose ? round4(cumChange / stock.includeClose * 100) : 0;

    stock.prevClose = round2(prevClose);
    stock.todayChange = todayChange;
    stock.todayChangePct = todayChangePct;
    stock.cumChange = cumChange;
    stock.cumChangePct = cumChangePct;
    stock.ma5 = ma(series, 5);
    stock.ma10 = ma(series, 10);
    stock.ma20 = ma(series, 20);
    stock.ma60 = ma(series, 60);
    stock.series = series; // 供图表/信号使用（日收盘序列）
  }

  // 创建股票对象
  function createStock(params) {
    const parsed = parseCode(params.code);
    if (!parsed) return null;

    const code = parsed.code;
    const market = params.market === "auto" || !params.market ? parsed.market : params.market;
    const preset = PRESET[code];
    const name = (params.name && params.name.trim()) || (preset ? preset[0] : ("股票" + code));
    const concept = (params.concept && params.concept.trim()) || (preset ? preset[1] : "—");

    let includeClose = parseFloat(params.includeClose);
    const includeCloseManual = includeClose > 0;   // 用户是否手动指定纳入价
    if (!(includeClose > 0)) {
      // 预设给一个合理基准价，否则随机 12~88
      const base = preset ? ({
        "600519": 1700, "601318": 50, "600036": 38, "000858": 160,
        "300750": 210, "002594": 250, "600887": 28
      }[code] || (20 + Math.random() * 70)) : (12 + Math.random() * 76);
      includeClose = round2(base);
    }

    const dailyCloses = genHistory(includeClose, HISTORY_DAYS);
    const currentPrice = includeClose;

    // 由收盘序列派生模拟 OHLC（开/高/低），供 K 线蜡烛图使用
    const dailyOpens = [], dailyHighs = [], dailyLows = [];
    dailyCloses.forEach((c, i) => {
      const prev = i === 0 ? c : dailyCloses[i - 1];
      const open = round2(prev * (1 + gaussian() * 0.004));
      dailyOpens.push(open);
      dailyHighs.push(round2(Math.max(open, c) * (1 + Math.abs(gaussian()) * 0.004)));
      dailyLows.push(round2(Math.min(open, c) * (1 - Math.abs(gaussian()) * 0.004)));
    });

    const stock = {
      id: market + code,
      code: code,
      market: market,
      name: name,
      concept: concept,
      note: (params.note || "").toString(),
      includeDate: params.includeDate || todayStr(),
      includeClose: round2(includeClose),
      _includeCloseManual: includeCloseManual,
      position: clampNum(params.position, 0, 100, 0),
      dailyCloses: dailyCloses,
      dailyOpens: dailyOpens,
      dailyHighs: dailyHighs,
      dailyLows: dailyLows,
      currentPrice: round2(currentPrice),
      createdAt: Date.now()
    };
    recompute(stock);
    return stock;
  }

  function todayStr() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function clampNum(v, min, max, def) {
    v = parseFloat(v);
    if (isNaN(v)) return def;
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  // 每分钟价格随机游走（模拟盘中波动）
  function tickPrice(stock) {
    const ret = gaussian() * TICK_VOL;
    let np = stock.currentPrice * (1 + ret);
    if (np < stock.includeClose * 0.2) np = stock.includeClose * 0.2;
    if (np < 0.05) np = 0.05;
    stock.currentPrice = round2(np);
    recompute(stock);
  }

  // 批量 tick
  function tickAll(stocks) {
    for (const s of stocks) tickPrice(s);
  }

  // ---- 真实行情接入（经本地代理 /api/quote、/api/kline）----
  // 任何一步失败都抛错，由调用方决定回退到模拟行情。
  async function fetchQuotes(codes) {
    const res = await fetch('/api/quote?codes=' + encodeURIComponent(codes.join(',')));
    if (!res.ok) throw new Error('quote api ' + res.status);
    const j = await res.json();
    return (j && j.quotes) || [];
  }
  // 用单条实时行情更新股票（价格 / 昨收 / 今日开高低 / 名称），并重算均线与涨跌
  function applyQuote(stock, q) {
    if (!q) return;
    if (q.name) stock.name = q.name;
    if (isFinite(q.prevClose) && q.prevClose > 0) stock.prevClose = Math.round(q.prevClose * 100) / 100;
    if (isFinite(q.price) && q.price > 0) stock.currentPrice = Math.round(q.price * 100) / 100;
    if (isFinite(q.open) && q.open > 0) stock.todayOpen = Math.round(q.open * 100) / 100;
    if (isFinite(q.high) && q.high > 0) stock.todayHigh = Math.round(q.high * 100) / 100;
    if (isFinite(q.low) && q.low > 0) stock.todayLow = Math.round(q.low * 100) / 100;
    recompute(stock);
  }
  // 拉取真实日 K（含 OHLC 与日期），重建 daily 序列（用于真实均线 / K 线走势图）
  async function hydrateKlines(stock) {
    try {
      const res = await fetch('/api/kline?code=' + encodeURIComponent(stock.code));
      if (!res.ok) return;
      const j = await res.json();
      if (j.closes && j.closes.length > 10) {
        stock.dailyCloses = j.closes.map(c => Math.round(c * 100) / 100);
        stock.dailyOpens = (j.opens || j.closes).map(v => Math.round(v * 100) / 100);
        stock.dailyHighs = (j.highs || j.closes).map(v => Math.round(v * 100) / 100);
        stock.dailyLows = (j.lows || j.closes).map(v => Math.round(v * 100) / 100);
        stock.dailyDates = (j.dates || []);
        const lastClose = stock.dailyCloses[stock.dailyCloses.length - 1];
        const manualInclude = stock._includeCloseManual === true;   // 用户手动指定的纳入价
        const stalePrice = !(stock.currentPrice > 0) || stock.currentPrice === stock.includeClose; // 现价仍是创建基准价
        // 纳入基准：预设基准价与真实价偏差大，非用户指定时改用最新收盘，避免累计涨跌异常
        if (!manualInclude) stock.includeClose = lastClose;
        // 现价仍为创建基准价（尚未接实时行情）时，用最新收盘兜底，保证均线与走势图正确
        if (stalePrice) stock.currentPrice = lastClose;
        recompute(stock);
      }
    } catch (e) { /* 失败则保留模拟 K 线 */ }
  }
  // 一次拉取多只股票的真实行情，失败抛错
  async function loadRealQuotes(stocks) {
    if (!stocks || !stocks.length) return 0;
    const quotes = await fetchQuotes(stocks.map(s => s.code));
    let n = 0;
    for (const q of quotes) {
      const s = stocks.find(x => x.code === q.code);
      if (s) { applyQuote(s, q); n++; }
    }
    return n;
  }

  // ---- 沪深300 指数日K（真实基准，经本地代理 /api/index）----
  let indexCache = null;
  async function fetchIndex() {
    if (indexCache && (Date.now() - indexCache.ts) < 5 * 60 * 1000) return indexCache;
    const res = await fetch('/api/index');
    if (!res.ok) throw new Error('index api ' + res.status);
    const j = await res.json();
    if (!j.closes || !j.closes.length) throw new Error('no index data');
    indexCache = { ts: Date.now(), dates: j.dates, closes: j.closes };
    return indexCache;
  }
  function resetIndexCache() { indexCache = null; }

  ST.Market = {
    PRESET: PRESET,
    parseCode: parseCode,
    detectMarket: detectMarket,
    createStock: createStock,
    recompute: recompute,
    tickPrice: tickPrice,
    tickAll: tickAll,
    todayStr: todayStr,
    round2: round2,
    round4: round4,
    applyQuote: applyQuote,
    hydrateKlines: hydrateKlines,
    loadRealQuotes: loadRealQuotes,
    fetchQuotes: fetchQuotes,
    getIndex: fetchIndex,
    resetIndexCache: resetIndexCache,
    // 接入真实行情时替换此函数：返回 Promise<{name?, price, prevClose}>
    async fetch(code, market) {
      return null;
    }
  };
})(window.ST);
