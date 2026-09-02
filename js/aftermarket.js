// aftermarket.js — 盘后观察：当日触发信号总结 + 接近触发信号预警
// 收盘后 15:10 自动生成当日盘后观察，方便次日操作。
// 仅展示当日数据（当前行情 + 策略库 + 持仓/操作记录实时计算），不保存历史。
window.ST = window.ST || {};

(function (ST) {
  // ---- 参数（可按需调整）----
  const OBS_TIME = "15:10";     // 盘后观察生成时间
  const NEAR_CUM_PCT = 2.0;     // 累计涨跌距止盈/止损线 2% 以内 → 预警
  const NEAR_MA_PCT = 0.01;     // 价格距均线阈值 1% 以内 → 预警

  // ---- 工具 ----
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function r2(x) { return x == null ? null : Math.round(x * 100) / 100; }
  function signPct(x) {
    if (x == null || isNaN(x)) return "—";
    return (x > 0 ? "+" : "") + x.toFixed(2) + "%";
  }
  function maN(series, n) {
    if (!series || !series.length || !(n > 0)) return null;
    const s = series.slice(-n);
    return s.reduce((a, b) => a + b, 0) / s.length;
  }
  function nowHM() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  // 是否交易日（周一至周五）
  function isWeekday() {
    const d = new Date();
    return d.getDay() !== 0 && d.getDay() !== 6;
  }
  // 是否已过盘后观察时间（交易日 15:10 及以后）
  function isAftermarketTime() {
    if (!isWeekday()) return false;
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes() >= 15 * 60 + 10;
  }

  // 今日已执行的买卖操作
  function todayExecuted() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return (ST.Storage.getOperations() || [])
      .filter(o => (o.ts || 0) >= start.getTime())
      .filter(o => o.type === "buy" || o.type === "sell")
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  // 当前仍处于触发状态的信号（未成交或今日刚触发尚未执行）
  function liveSignals(stocks, strategies, ops) {
    const buys = [], sells = [];
    stocks.forEach(s => {
      const ev = ST.Strategy.evaluate(s, strategies, ops);
      if (ev.action === "buy") {
        buys.push({ s, basis: ev.basis, name: ev.hits.buy && ev.hits.buy.name });
      } else if (ev.action === "sell_partial") {
        sells.push({ s, basis: ev.basis, name: ev.hits.sell_partial && ev.hits.sell_partial.name, kind: "partial" });
      } else if (ev.action === "sell_all") {
        const mode = ev.hits.sell_all && ev.hits.sell_all.params && ev.hits.sell_all.params.mode;
        sells.push({ s, basis: ev.basis, name: ev.hits.sell_all && ev.hits.sell_all.name, kind: mode === "stoploss" ? "stoploss" : "belowMA" });
      }
    });
    return { buys, sells };
  }

  // 接近触发信号预警（未触发但离阈值很近，提示次日关注）
  function nearMisses(stocks, strategies, ops) {
    const warns = [];
    strategies = (strategies || []).filter(x => x && x.enabled !== false);
    stocks.forEach(s => {
      const ev = ST.Strategy.evaluate(s, strategies, ops);
      if (ev.action) return; // 已触发，不重复预警
      const h = ST.Holding.compute(s, ops);
      const holding = (h.qty || 0) > 0;
      const price = s.currentPrice;
      const cum = s.cumChangePct || 0;

      if (!holding) {
        // ---- 买入预警（未持仓）----
        const buy = strategies.find(x => x.attr === "buy");
        if (!buy) return;
        const p = buy.params || {};
        const maS = maN(s.series, p.shortMA || 5), maM = maN(s.series, p.midMA || 20), maL = maN(s.series, p.longMA || 60);
        if (maS == null || maM == null || maL == null) return;
        if (p.mode === "dip") {
          // 回踩低吸：上升趋势 + 价回踩中均附近（含容差近邻）
          const nearMid = Math.abs(price - maM) <= maM * ((p.pullRatio || 0.05) + NEAR_MA_PCT);
          if (maS > maM && maM > maL && price > maL && nearMid) {
            warns.push({
              s, cat: "买入", tag: "接近买入·回踩",
              text: `现价 ${r2(price)} 正回踩 MA${p.midMA}(${r2(maM)}) 附近，接近「${buy.name}」触发条件`
            });
          }
        } else {
          // 突破买入：多头排列 + 价站上长均（含容差）
          const tol = p.breakoutRatio != null ? p.breakoutRatio : 0.01;
          const target = maL * (1 - tol);
          const gap = price >= target ? 0 : (target - price) / maL * 100;
          if (gap <= NEAR_MA_PCT * 100 && maS > maM && maM > maL) {
            warns.push({
              s, cat: "买入", tag: "接近买入·突破",
              text: `现价 ${r2(price)} 距买入价 MA${p.longMA}×${(1 - tol).toFixed(3)}(${r2(target)}) 仅差 ${gap.toFixed(2)}%，上穿即触发「${buy.name}」`
            });
          }
          // 均线即将上穿（短→中 / 中→长）
          if (!(maS > maM) && maM > maL && (maM - maS) / maM * 100 <= NEAR_MA_PCT * 100) {
            warns.push({
              s, cat: "买入", tag: "接近买入·上穿",
              text: `MA${p.shortMA}(${r2(maS)}) 即将上穿 MA${p.midMA}(${r2(maM)})，上穿后接近「${buy.name}」触发`
            });
          } else if (maS > maM && !(maM > maL) && (maL - maM) / maL * 100 <= NEAR_MA_PCT * 100) {
            warns.push({
              s, cat: "买入", tag: "接近买入·上穿",
              text: `MA${p.midMA}(${r2(maM)}) 即将上穿 MA${p.longMA}(${r2(maL)})，完全多头后接近「${buy.name}」触发`
            });
          }
        }
      } else {
        // ---- 卖出预警（持仓）----
        strategies.forEach(st => {
          if (st.attr === "sell_partial") {
            const g = (st.params && st.params.gainPct != null) ? st.params.gainPct : 25;
            const gap = g - cum;
            if (gap >= 0 && gap <= NEAR_CUM_PCT) {
              warns.push({
                s, cat: "卖出", tag: "接近止盈",
                text: `累计涨幅 ${signPct(cum)}，距「${st.name}」止盈线 ${g}% 仅差 ${gap.toFixed(2)}%`
              });
            }
          } else if (st.attr === "sell_all") {
            const p = st.params || {};
            if (p.mode === "stoploss") {
              const loss = Math.abs(p.lossPct != null ? p.lossPct : 8);
              const gap = cum - (-loss);
              if (gap >= 0 && gap <= NEAR_CUM_PCT) {
                warns.push({
                  s, cat: "卖出", tag: "接近止损",
                  text: `累计跌幅 ${signPct(cum)}，距「${st.name}」止损线 -${loss}% 仅差 ${gap.toFixed(2)}%`
                });
              }
            } else {
              const maL = maN(s.series, p.ma || 60);
              if (maL != null && price > maL) {
                const gap = (price - maL) / maL * 100;
                if (gap <= NEAR_MA_PCT * 100) {
                  warns.push({
                    s, cat: "卖出", tag: "接近跌破长均",
                    text: `现价 ${r2(price)} 距 MA${p.ma}(${r2(maL)}) 仅高 ${gap.toFixed(2)}%，跌破即触发「${st.name}」`
                  });
                }
              }
            }
          }
        });
      }
    });
    return warns;
  }

  // ---- 渲染 ----
  function render() {
    const stocks = ST.App ? ST.App.getStocks() : [];
    const strategies = ST.Storage.getStrategies();
    const ops = ST.Storage.getOperations();

    // 状态行
    const statusEl = document.getElementById("aftermarketStatus");
    if (statusEl) {
      const done = isAftermarketTime();
      statusEl.innerHTML = done
        ? `<span class="am-status-ok">已生成</span><span>今日（${ST.Market.todayStr()}）盘后观察已生成 · ${nowHM()}</span>`
        : (isWeekday()
          ? `<span class="am-status-wait">未到时间</span><span>今日盘后观察将于 ${OBS_TIME} 自动生成（当前 ${nowHM()}），以下为盘中实时预览</span>`
          : `<span class="am-status-close">休市</span><span>今日为休市日，无盘后观察</span>`);
    }

    // 今日触发信号总结
    const exec = todayExecuted();
    const live = liveSignals(stocks, strategies, ops);
    const sigEl = document.getElementById("amTriggered");
    if (sigEl) sigEl.innerHTML = renderTriggered(exec, live);

    // 接近触发信号预警
    const warns = nearMisses(stocks, strategies, ops);
    const nearEl = document.getElementById("amNear");
    if (nearEl) nearEl.innerHTML = renderNear(warns);
  }

  function renderTriggered(exec, live) {
    const opRows = exec.map(o => {
      const d = new Date(o.ts);
      const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
      const typeTxt = o.type === "buy" ? "买入" : "卖出";
      const cls = o.type === "buy" ? "op-buy" : "op-sell";
      const detail = ` @ ${o.price} × ${o.qty} 股 = ¥${(o.amount || 0).toFixed(2)}`;
      return `<div class="am-item">
        <span class="op-type ${cls}">${typeTxt}</span>
        <span class="op-stock">${esc(o.name || o.code)} (${esc(o.code)})</span>
        <span class="op-extra">${detail}</span>
        <span class="op-note">${esc(o.note || "")}</span>
        <span class="op-time">${hm}</span>
      </div>`;
    }).join("");

    const buyRows = live.buys.map(x => `<div class="am-item">
      <span class="am-tag tag-buy">买入信号</span>
      <span class="op-stock">${esc(x.s.name)} (${esc(x.s.code)})</span>
      <span class="am-basis">${esc(x.basis)}</span>
    </div>`).join("");

    const sellRows = live.sells.map(x => {
      const tag = x.kind === "partial" ? "部分止盈" : (x.kind === "stoploss" ? "止损清仓" : "跌破清仓");
      return `<div class="am-item">
        <span class="am-tag tag-sell">卖出信号·${tag}</span>
        <span class="op-stock">${esc(x.s.name)} (${esc(x.s.code)})</span>
        <span class="am-basis">${esc(x.basis)}</span>
      </div>`;
    }).join("");

    const blk = (title, empty, rows) =>
      `<div class="am-subtitle">${title}</div>` + (rows || `<div class="am-empty">${empty}</div>`);

    return blk("今日已执行交易", "今日暂无买入 / 卖出记录", opRows)
      + blk("当前买入信号（未持仓）", "当前无买入信号触发", buyRows)
      + blk("当前卖出信号（持仓）", "当前无卖出信号触发", sellRows);
  }

  function renderNear(warns) {
    if (!warns.length) return '<div class="am-empty">今日无接近触发信号的预警。</div>';
    const order = {
      "接近买入·突破": 1, "接近买入·回踩": 1, "接近买入·上穿": 1,
      "接近止盈": 2, "接近止损": 3, "接近跌破长均": 4
    };
    warns.sort((a, b) => (order[a.tag] || 9) - (order[b.tag] || 9) || a.s.code.localeCompare(b.s.code));
    return warns.map(w => {
      const tagCls = w.cat === "买入" ? "tag-near-buy" : "tag-near-sell";
      return `<div class="am-item">
        <span class="am-tag ${tagCls}">${esc(w.tag)}</span>
        <span class="op-stock">${esc(w.s.name)} (${esc(w.s.code)})</span>
        <span class="am-basis">${esc(w.text)}</span>
        <span class="op-note">累计 ${signPct(w.s.cumChangePct)} · 现价 ${r2(w.s.currentPrice)}</span>
      </div>`;
    }).join("");
  }

  ST.Aftermarket = { render, isAftermarketTime, isWeekday };
})(window.ST);
