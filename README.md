# 股票交易跟踪系统

一个自部署的股票交易跟踪 + 策略管理 Web 应用，支持实时行情展示、买卖信号评估、操作记录与历史回测，并附带一套迁移到聚宽（JoinQuant）平台的回测策略。

## 功能概览

- **实时行情**：服务端代理东方财富行情接口，绕过浏览器 CORS；行情获取失败时回退本地模拟价
- **买卖信号**：均线多头排列（5/20/60）趋势突破买入、部分止盈、跌破长期均线清仓、止损清仓
- **跟踪管理**：股票池增删（支持批量移除）、持仓/盈亏统计、历史操作记录（纳入/买入/卖出/移除）
- **策略管理**：可在「策略管理」页启停各买卖策略、配置交易费用与仓位，数据存于独立文件 `strategies.json`
- **历史回测**：基于真实日K回放策略库，验证买卖规则效果
- **聚宽回测**：`joinquant/` 目录提供可直接粘贴到聚宽平台的回测策略

## 目录结构

```
stock-trade/
├── index.html            # 前端入口
├── styles.css            # 样式
├── js/                   # 前端逻辑（行情/策略/持仓/回测/存储/UI）
├── server.py             # 服务端（纯 Python 标准库，无第三方依赖，推荐）
├── server.js             # 服务端（Node.js 内置模块版，二选一）
├── strategies.json       # 策略配置（独立于数据库）
├── data.db               # SQLite 业务数据（持仓/操作记录/元信息）
└── joinquant/            # 聚宽平台回测策略
    ├── stock_trade_strategy.py   # 本系统策略的聚宽移植版
    └── multi_etf_strategy.py     # 参考社区的多ETF融合策略
```

## 快速启动

需要 Python 3（推荐）或 Node.js，均无需安装额外依赖。

### 方式一：Python

```bash
python server.py        # 或 python3 server.py
```

### 方式二：Node.js

```bash
node server.js
```

启动后访问 <http://localhost:8080>。

> 注意：两种服务端口相同（默认 8080），不要同时启动，避免端口冲突。

### 修改端口

通过环境变量 `PORT` 指定：

```bash
PORT=9090 python server.py     # Linux/macOS
$env:PORT=9090; python server.py   # Windows PowerShell
```

## 部署到天翼云（CentOS，IP:8080 直连）

`server.py` 仅用 Python 标准库，部署流程为：上传代码 → 装 Python → 常驻运行 → 放行端口。

### 1. 上传代码

把整个 `stock-trade` 目录传到服务器，例如 `/opt/stock-trade/`（可用 WinSCP / XFTP，或 `scp` / 压缩包传输）。

### 2. 安装 Python 3

```bash
yum -y install python3
python3 --version
```

### 3. 用 systemd 常驻运行（开机自启）

```bash
cat > /etc/systemd/system/stock-trade.service <<'EOF'
[Unit]
Description=Stock Trade Tracking Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/stock-trade
ExecStart=/usr/bin/python3 /opt/stock-trade/server.py
Environment=PORT=8080
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable stock-trade
systemctl start stock-trade
systemctl status stock-trade      # 应为 active (running)
journalctl -u stock-trade -f      # 实时查看日志
```

### 4. 放行端口

- **天翼云安全组**：控制台入方向放行 TCP 8080
- **系统防火墙**：

```bash
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --reload
firewall-cmd --list-all
```

### 5. 验证

浏览器访问 `http://<公网IP>:8080`。服务端行情代理依赖外网访问东方财富接口，可在服务器上自测：

```bash
curl -s "http://127.0.0.1:8080/api/quote?code=600519"
```

## 聚宽策略使用

1. 登录 [聚宽](https://www.joinquant.com) → 「我的策略」→ 新建策略
2. 把 `joinquant/stock_trade_strategy.py` 整体内容粘贴到策略编辑区
3. 回测设置：建议回测频率选「分钟」、区间 ≥ 1 年、基准沪深300（已在代码中设置）
4. 运行回测，查看收益曲线、回撤、交易明细与日志

`multi_etf_strategy.py` 为参考社区"多ETF/抄底+五福"融合策略，同样整体粘贴即可运行。

## 数据与配置

- **业务数据**（股票池/持仓/操作记录/元信息）：存于 `data.db`（SQLite）
- **策略配置**（各策略启停、交易费用、仓位等）：存于 `strategies.json`，与数据库独立，删除数据库不影响策略
- **前端缓存**：部分数据镜像在浏览器 `localStorage`，彻底清空需同时清理浏览器站点缓存
