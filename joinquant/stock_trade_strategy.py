# -*- coding: utf-8 -*-
"""
股票交易跟踪系统 —— 聚宽(JoinQuant) 回测策略
====================================================

移植自本地项目 stock-trade（前端策略引擎 js/strategy.js + js/backtest.js + js/config.js）。

【策略逻辑与本地系统一致】
  1. 股票池：g.stocks 列表（对应本地「跟踪系统」左侧列表）。
  2. 买入策略（无持仓才触发）：
     - 趋势突破买入：短>中>长均线（多头排列）且现价 ≥ 长均×(1-偏离阈值)
     - 回踩低吸买入：上升趋势 + 现价回踩中均线附近未破 + 拐头向上（默认关闭）
  3. 卖出策略（有持仓才触发）：
     - 部分止盈：累计涨幅 ≥ 阈值 时卖出一部分（本轮持仓只执行一次，之后转持有）
     - 跌破清仓：现价跌破长期均线
     - 止损清仓：累计跌幅 ≤ -阈值
  4. 卖出优先级：清仓 > 部分止盈 > 买入。
  5. 买入行为：单只买入金额 = 总资产 1/20（约 5% 仓位，对应本地 1/20）；
     现金不足时先卖持仓中浮动盈亏率最差的两只各腾出 ≥ 1/2 份；
     按 100 股整数手成交。
  6. 每个动作（买入/部分止盈/清仓）每天每只股票最多执行一次。
  7. 交易费用：佣金万分之一（单笔最低 5 元）、印花税万分之五（仅卖出），与本地一致。
  8. 均线口径：最近 N 根收盘的平均 = (N-1) 根历史日收盘 + 当前最新价，与本地一致。

【聚宽使用步骤】
  1. 登录聚宽网站（joinquant.com）→「我的策略」→ 新建策略。
  2. 把本文件内容整体粘贴到策略编辑区。
  3. 回测设置：
     - 回测频率：建议选「分钟」（本策略每日 09:35 定点评估一次，
       用开盘后最新价触发买入/止盈/止损；选「天」则每日评估一次，逻辑同样成立）；
     - 起始资金：默认 100 万（与本地设置一致，可在聚宽回测参数里调整）；
     - 回测区间：自选（建议 ≥ 1 年）；
     - 基准：沪深300（已在 initialize 中 set_benchmark）。
  4. 点击「运行回测」，查看收益曲线、回撤、交易明细与日志。
  5. 如需调整股票池 / 均线周期 / 止盈止损参数，直接改下方「参数区」。

【与本地回测的差异说明】
  - 聚宽数据为真实行情，无需本地「布朗桥合成分时」；成交按聚宽分钟级市价撮合，
    且遵循 A 股 T+1（当日买入不可当日卖出），比本地回测更贴近实盘。
  - 累计涨幅基准价 = 回测开始前一交易日收盘价（本地用回测起点当日收盘），差异极小。
"""

from jqdata import *
import math

# ============================================================
# 参数区（对应本地「策略规则设置」，修改后直接生效）
# ============================================================

# ---- 均线周期（对应本地 shortMA / midMA / longMA）----
SHORT_MA = 5
MID_MA = 20
LONG_MA = 60

# ---- 买入策略参数 ----
BREAKOUT_RATIO = 0.01   # 趋势突破：现价 ≥ 长均×(1-容差)，对应本地 breakoutRatio
PULL_RATIO = 0.03       # 回踩低吸：现价距中均线的容差比例，对应本地 pullRatio

# ---- 卖出策略参数 ----
TAKE_PROFIT_PCT = 25.0  # 部分止盈：累计涨幅达标线(%)，对应本地 gainPct/takeProfit
PARTIAL_RATIO = 0.3     # 部分止盈卖出比例，对应本地 ratio
LOSS_PCT = 8.0          # 止损清仓：累计跌幅(%)，对应本地 lossPct/stopLoss

# ---- 各策略开关（对应本地「策略管理」的启用状态）----
BUY_BREAKOUT_ENABLED = True    # 趋势突破买入（buy_breakout）
BUY_DIP_ENABLED = False        # 回踩低吸买入（buy_dip，本地默认关闭）
SELL_PARTIAL_ENABLED = True    # 部分止盈（sell_partial）
SELL_BELOW_MA_ENABLED = True   # 跌破清仓（sell_belowMA）
SELL_STOPLOSS_ENABLED = True   # 止损清仓（sell_stoploss）

# ---- 交易费用（对应本地 config.js）----
COMMISSION = 0.0001    # 佣金：万分之一（买卖双向）
MIN_COMMISSION = 5.0   # 单笔最低佣金（元）
STAMP_DUTY = 0.0005    # 印花税：万分之五（仅卖出时收取）

# ---- 仓位 ----
POSITION_SLOTS = 20    # 单只买入金额 = 总资产 1/20（约 5% 仓位，对应本地 1/20）

# ---- 调试 ----
DEBUG_TRACE = False    # 打印 evaluate 每次评估的完整变量（排查信号时可开，稳定后建议 False）

# ============================================================
# 股票池（对应本地「跟踪系统」跟踪列表）
# 格式：沪市 .XSHG，深市 .XSHE，北交所 .BJ
# ============================================================
STOCKS = [
    '603822.XSHG',
    '002816.XSHE', 
    '603021.XSHG',
    '002789.XSHE',
    '002501.XSHE', 
    '600053.XSHG',
    '600734.XSHG',
    '605336.XSHG',
    '002719.XSHE',
    '002977.XSHE', 
    '000821.XSHE',
    '002168.XSHE', 
    '002620.XSHE',
    '600759.XSHG',
    '688053.XSHG',
    '300076.XSHE', 
    '002055.XSHE',
    '002592.XSHE',
    '002872.XSHE',
    '600309.XSHG',
    '301015.XSHE',
    '301059.XSHE',
    '002215.XSHE',
    '688275.XSHG',
    '300267.XSHE'
]


# ============================================================
# 初始化
# ============================================================
def initialize(context):
    # 设定沪深300作为基准
    set_benchmark('000300.XSHG')
    # 开启动态复权模式（真实价格）
    set_option('use_real_price', True)
    # 禁止未来函数（信号只用 T-1 及以前数据，与参考策略一致）
    set_option('avoid_future_data', True)
    # 交易费用：佣金万分之一（最低5元）+ 卖出印花税万五，与本地 config.js 一致
    set_order_cost(OrderCost(open_tax=0, close_tax=STAMP_DUTY,
                             open_commission=COMMISSION, close_commission=COMMISSION,
                             min_commission=MIN_COMMISSION), type='stock')

    g.stocks = STOCKS
    g.hist_close = {}      # code -> 截至昨收的历史日收盘序列（每交易日更新一次）
    g.base_close = {}      # code -> 累计涨幅基准价（回测起点前一交易日收盘）
    g.partial_done = {}    # code -> 本轮持仓是否已执行过部分止盈
    g.exec_today = {}      # code -> 当日已执行动作集合
    g.shift_done_today = False   # 当日是否已做过资金不足调仓（每交易日最多一次）
    g.signal_logged = {}   # code -> 当日已打印的信号 key（每种信号每天最多一条）
    g.init_flag = False

    # 每日定点调仓：09:35 用 T-1 已收盘日K评估一次（参考"多股票追涨策略"取价方式）
    # （与参考策略同款 run_daily 定点模式，消除 handle_data 调用机制的不确定性）
    run_daily(trade_once, time='09:35')


# ============================================================
# 工具函数
# ============================================================
def calc_ma(closes, price, n):
    """均线：最近 n 根收盘的平均（n-1 根历史日收盘 + 当前价），与本地口径一致。"""
    if closes is None:
        return None
    # 过滤 NaN/None，避免异常数据污染均线导致永不触发买入
    seq = [x for x in list(closes) + [price]
           if x is not None and not (isinstance(x, float) and math.isnan(x))]
    if not seq:
        return None
    return sum(seq[-n:]) / min(n, len(seq))


def prev_close(sec):
    """昨收（用于回踩低吸的拐头判断）。"""
    closes = g.hist_close.get(sec)
    if closes:
        return closes[-1]
    return None


def evaluate(sec, price, holding):
    """
    策略评估：返回 (动作, 策略名) 或 (None, 原因)。
    动作：buy / sell_partial / sell_all；与本地 ST.Strategy.evaluate 判定一致。
    """
    closes = g.hist_close.get(sec)
    if not closes:
        return None, '历史数据不足'
    ma_s = calc_ma(closes, price, SHORT_MA)
    ma_m = calc_ma(closes, price, MID_MA)
    ma_l = calc_ma(closes, price, LONG_MA)
    if ma_s is None or ma_m is None or ma_l is None:
        return None, '均线数据不足'

    base = g.base_close.get(sec)
    cum = (price - base) / base * 100.0 if base else 0.0   # 累计涨幅%

    # ---- 调试跟踪：打印每次评估的完整变量（DEBUG_TRACE=False 可关闭）----
    if DEBUG_TRACE:
        log.info('【评估】%s price=%.2f holding=%s MA%d=%.2f MA%d=%.2f MA%d=%.2f base=%.2f cum=%.2f%%'
                 % (sec, price, '有' if holding else '无',
                    SHORT_MA, ma_s, MID_MA, ma_m, LONG_MA, ma_l,
                    base if base else 0.0, cum))

    # ---- 买入策略（无持仓才触发）----
    hit_buy = None
    if BUY_BREAKOUT_ENABLED and ma_s > ma_m and ma_m > ma_l \
            and price >= ma_l * (1 - BREAKOUT_RATIO):
        hit_buy = '趋势突破买入'
    if BUY_DIP_ENABLED and not hit_buy:
        prev = prev_close(sec)
        if prev and ma_s > ma_m and ma_m > ma_l \
                and abs(price - ma_m) <= ma_m * PULL_RATIO \
                and price > prev and price > ma_s:
            hit_buy = '回踩低吸买入'

    # ---- 卖出策略（有持仓才触发）----
    hit_partial = None
    if SELL_PARTIAL_ENABLED and cum >= TAKE_PROFIT_PCT:
        hit_partial = '部分止盈'
    hit_sell_all = None
    if SELL_BELOW_MA_ENABLED and price < ma_l:
        hit_sell_all = '跌破清仓'
    if SELL_STOPLOSS_ENABLED and cum <= -LOSS_PCT:
        hit_sell_all = '止损清仓'

    # ---- 优先级：清仓 > 部分止盈 > 买入 ----
    action, name, note = None, None, None
    if hit_sell_all:
        action, name = 'sell_all', hit_sell_all
    elif hit_partial:
        if g.partial_done.get(sec):
            note = '本轮已部分止盈，剩余持有'
        else:
            action, name = 'sell_partial', hit_partial
    elif hit_buy:
        if holding:
            note = '已持仓，不再重复买入'
        else:
            action, name = 'buy', hit_buy
    elif holding:
        note = '持有中，暂无卖出信号'
    else:
        note = '观望：买入条件未满足'

    # ---- 信号跟踪日志：命中任一策略时打印，每只股票每天每种信号最多一条 ----
    if name:
        key = name + '|' + (action if action else 'hold:' + note)
        if g.signal_logged.get(sec) != key:
            g.signal_logged[sec] = key
            log.info('【信号】%s 现价%.2f MA%d=%.2f MA%d=%.2f MA%d=%.2f 累计%.2f%% 持仓%s → %s%s'
                     % (sec, price, SHORT_MA, ma_s, MID_MA, ma_m, LONG_MA, ma_l, cum,
                        '有' if holding else '无', name,
                        (' → 执行' + action) if action else (' [未执行:%s]' % note)))

    if action:
        return action, name
    return None, note


def shift_fund(context, need):
    """
    资金不足调仓：卖持仓中浮动盈亏率最差的两只，各腾出 >= need（100 股整数倍，不足清仓）。
    对应本地 app.js sellForCash()。
    """
    cands = []
    for sec, pos in context.portfolio.positions.items():
        if pos.total_amount > 0 and pos.closeable_amount > 0:
            cost = pos.avg_cost
            cur = pos.price
            pnl = (cur - cost) / cost * 100.0 if cost > 0 else 0.0
            cands.append((pnl, sec, pos.closeable_amount, cur))
    cands.sort(key=lambda t: t[0])   # 浮动盈亏率最低（最差）在前
    for pnl, sec, qty, price in cands[:2]:
        if not (price > 0):
            continue
        need_qty = int(math.ceil(need / price / 100.0)) * 100
        if need_qty <= 0:
            continue
        o = order(sec, -need_qty)
        if o is not None and o.filled > 0:
            log.info('【调仓】资金不足，卖出 %s %d 股 @%.2f（浮动盈亏率 %.2f%%）'
                     % (sec, need_qty, o.price, pnl))


# ============================================================
# 定点模式：开盘前重置 + 09:35 每日评估一次全部股票池
# ============================================================
def before_trading_start(context):
    """每交易日开盘前：重置每日状态 + 刷新历史日收盘缓存 + 首次初始化基准价。

    开盘前取到的日K只到昨收（T-1），天然满足 avoid_future_data 的要求。
    """
    g.exec_today = {sec: set() for sec in g.stocks}
    g.shift_done_today = False
    g.signal_logged = {}
    g.hist_close = {}
    for sec in g.stocks:
        df = attribute_history(sec, count=60, unit='1d', fields=['close'])
        if df is not None:
            g.hist_close[sec] = [float(x) for x in df['close']]
    if not g.init_flag:
        g.init_flag = True
        g.partial_done = {sec: False for sec in g.stocks}
        # 累计涨幅基准价 = 回测起点前一交易日收盘（历史序列最后一根）
        for sec in g.stocks:
            hist = g.hist_close.get(sec) or []
            if hist:
                g.base_close[sec] = hist[-1]


def trade_once(context):
    """每日定点调仓（09:35）：用最近已收盘日K（T-1 收盘）评估全部股票池并交易一次。

    与参考"多股票追涨策略"同款取价方式：attribute_history 取 T-1 已收盘日K，
    当前价 = 最近一根日K收盘价（避免未来函数，且不依赖 get_current_data）。
    每日只评估一次，避免 handle_data 在部分回测精度下被跳过/重复评估。
    """
    for sec in g.stocks:
        _tick(context, sec)


def _tick(context, sec):
    # 取价：直接用 before_trading_start 缓存的 60 根日收盘（T-1 已收盘），
    # 当前价取最近一根日K收盘（等价 attribute_history(sec,1,'1d')['close'][-1]）。
    hist = g.hist_close.get(sec) or []
    if not hist:
        if DEBUG_TRACE:
            log.info('【跳过】%s 无历史收盘数据', sec)
        return
    price = hist[-1]

    pos = context.portfolio.positions.get(sec)
    holding = pos is not None and pos.total_amount > 0
    closeable = pos.closeable_amount if (pos is not None and holding) else 0

    action, name = evaluate(sec, price, holding)
    if action is None:
        return
    if action in g.exec_today.get(sec, set()):
        return   # 当日同类型动作只执行一次

    # ---------- 买入 ----------
    if action == 'buy':
        if holding:
            return
        total_value = context.portfolio.total_value          # 现金 + 持仓市值
        x = total_value / POSITION_SLOTS                     # 单份买入金额（1/20）
        cash = context.portfolio.available_cash
        if cash < x - 1e-9:                                  # 现金不足：先调仓
            if not g.shift_done_today:
                shift_fund(context, x / 2.0)
                g.shift_done_today = True
            cash = context.portfolio.available_cash
        buy_amount = min(x, cash)
        qty = int(buy_amount / price / 100.0) * 100          # 100 股整数手
        if qty <= 0:
            return
        o = order(sec, qty)
        if o is not None and o.filled > 0:
            g.partial_done[sec] = False                      # 新一轮持仓，重新武装部分止盈
            g.exec_today[sec].add('buy')
            log.info('【买入】%s %s %d 股 @%.2f 金额 %.2f（%s，约1/%d仓位）'
                     % (sec, name, o.filled, o.price, o.filled * o.price, name, POSITION_SLOTS))

    # ---------- 部分止盈 ----------
    elif action == 'sell_partial':
        if closeable <= 0:
            return
        qty = int(closeable * PARTIAL_RATIO / 100.0) * 100
        if qty <= 0:
            qty = closeable
        o = order(sec, -qty)
        if o is not None and o.filled > 0:
            g.partial_done[sec] = True                       # 本轮已部分止盈，剩余继续持有
            g.exec_today[sec].add('sell_partial')
            log.info('【部分止盈】%s %s 卖出 %d 股 @%.2f（卖约 %d%%）'
                     % (sec, name, o.filled, o.price, int(PARTIAL_RATIO * 100)))

    # ---------- 清仓 ----------
    elif action == 'sell_all':
        if closeable <= 0:
            return
        o = order(sec, -closeable)                           # 卖出全部可卖部分（T+1 当仓次日再处理）
        if o is not None and o.filled > 0:
            g.exec_today[sec].add('sell_all')
            log.info('【清仓】%s %s 全部卖出 %d 股 @%.2f' % (sec, name, o.filled, o.price))


# ============================================================
# 收盘后：打印当日持仓摘要（便于核对，不影响交易）
# ============================================================
def after_trading_end(context):
    total = context.portfolio.total_value
    cash = context.portfolio.available_cash
    positions = context.portfolio.positions
    if not positions:   # 空仓：只打印总结，不再逐只遍历
        log.info('=== 收盘 %s 总资产 %.2f 现金 %.2f 空仓 ==='
                 % (context.current_dt.date(), total, cash))
        return
    holds = ['%s:%d股' % (sec, pos.total_amount) for sec, pos in positions.items()]
    log.info('=== 收盘 %s 总资产 %.2f 现金 %.2f 持仓 %s ==='
             % (context.current_dt.date(), total, cash, ' '.join(holds)))
    for sec, pos in positions.items():
        pnl = (pos.price - pos.avg_cost) * pos.total_amount
        log.info('  持仓 %s 数量 %d 成本 %.2f 现价 %.2f 浮动盈亏 %.2f'
                 % (sec, pos.total_amount, pos.avg_cost, pos.price, pnl))
