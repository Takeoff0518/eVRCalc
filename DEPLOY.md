# eVRCalc 部署指南

## 架构

```
┌─────────────────────────────┐         ┌───────────────────────────────────┐
│  GitHub Pages                │  跨域   │  Go 后端（家里那台机器）            │
│  https://evrc.tbpdt.top      │ ──────► │  https://mc.tbpdt.top:9983        │
│  纯静态前端（无出网能力）      │  CORS   │  /api/weekly/*  /api/bili/*       │
└─────────────────────────────┘         └───────────┬───────────┬───────────┘
                                                    │           │
                                                    ▼           ▼
                                    www.evocalrank.com   api.bilibili.com
```

**为什么必须有这个后端**，两件事都做不到纯前端：

1. **周刊接口**：`www.evocalrank.com` 的 JSON 接口从不返回 `Access-Control-Allow-Origin`，
   浏览器会**直接丢弃整个响应**——即使服务端返回了 200 与完整数据，JS 侧也只能看到
   `TypeError: Failed to fetch`。注意这与"服务端是否校验来源"无关：实测该服务端并不看
   `Origin` 头，问题纯在浏览器侧的读取授权。

2. **B 站接口**：它的 WAF 按**出口 IP** 判定。浏览器直连会被 `Origin` 检查挡成 403；
   经 Cloudflare Workers 转发得到 **412**——逐个排除请求头差异后确认：住宅 IP 请求全部
   200、Workers 请求 412，**差别只在出口 IP**。所以这一层必须跑在有住宅 IP 的机器上，
   换任何 Serverless 都一样。

后端出去取数，再为浏览器补上 CORS 响应头，顺带把响应裁剪到前端真正需要的字段。

> **上一版**的周刊转发层是 Cloudflare Worker（`worker/index.js`）。统一到 Go 后端后它
> 已停用，代码留在仓库里作参考与回退路径。

---

## 一、部署后端

### 1. 准备配置

```bash
cd server
cp server.example.yaml server.yaml
```

编辑 `server.yaml`，至少确认这几项：

```yaml
listen: ":9983"                                 # 监听端口

cors:
  allowed_origins:
    - "https://evrc.tbpdt.top"                  # 前端域名，必须放行

rate_limit:
  trusted_proxies: []                           # 直连暴露时必须留空！
```

### 2. 编译

```bash
cd server
go build -o evrcalc-server .
```

只有一个外部依赖（`gopkg.in/yaml.v3`）。若目标机器拉不到模块，可以先用
`go mod vendor` 把依赖收进 `vendor/`，之后构建就完全离线了。

交叉编译到 Linux：

```bash
GOOS=linux GOARCH=amd64 go build -o evrcalc-server .
```

### 3. 先自检，再启动

```bash
./evrcalc-server --config server.yaml --check
```

`--check` 会打印生效配置，并实际探一次两个上游。**这一步能提前发现最麻烦的问题**：
如果 B 站那行报 412，说明当前出口 IP 已被判定为机房 IP，后面所有 B 站功能都不会通。

```
上游连通性：
        最新期号 735
  [OK]   周刊  https://www.evocalrank.com
        探针 117207459697071 → 【沨漪原创】秦宣四方…（播放 516824）
  [OK]   B 站  https://api.bilibili.com
```

确认无误后启动：

```bash
./evrcalc-server --config server.yaml
```

### 4. 让它常驻

**Windows**（本机是 `ddns-go` 那一台）：

```powershell
# 用任务计划程序在开机时启动，或注册为服务
sc.exe create evrcalc binPath= "C:\path\to\evrcalc-server.exe --config C:\path\to\server.yaml" start= auto
sc.exe start evrcalc
```

**Linux**（`/etc/systemd/system/evrcalc.service`）：

```ini
[Unit]
Description=eVRCalc backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=evrcalc
WorkingDirectory=/opt/evrcalc
ExecStart=/opt/evrcalc/evrcalc-server --config /opt/evrcalc/server.yaml
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now evrcalc
journalctl -u evrcalc -f
```

### 5. 域名与端口

`mc.tbpdt.top` 的 A 记录由 **`ddns-go`** 维护（家用宽带是动态 IP）。
后端默认监听 `:9983`，所以访问地址形如 `https://mc.tbpdt.top:9983`。

**关于证书**：如果 DDNS 只做 DNS 解析、没有反代，那么 `https://…:9983` 需要
后端自己持有证书，否则浏览器会拦。两种做法：

- **推荐**：把子域挂到 Cloudflare 代理（橙云），回源端口设成 9983。
  这样边缘有 TLS、有免费防护，回源端口不必是 443。
  **注意**：走了代理之后，后端看到的对端 IP 是 Cloudflare 的，
  要读真实客户端 IP 必须配置：
  ```yaml
  rate_limit:
    trusted_proxies: ["cloudflare"]
  ```
  ⚠️ **不配这个，限流会把所有访客当成同一个 IP**；而如果**没有**走代理却配了它，
  任何人都能伪造 `CF-Connecting-IP` 绕过限流。两者都会出问题，别弄错方向。

- 或者用 Caddy / nginx 做本机反代并自动签 Let's Encrypt 证书。
  注意家庭宽带常封 443，用非标准端口时 Let's Encrypt 的 HTTP-01 挑战需要 80 端口可达，
  否则改用 DNS-01。

---

## 二、部署前端

前端仍是 GitHub Pages，由 `.github/workflows/deploy-pages.yml` 自动构建部署。

工作流里已写入后端地址：

```yaml
env:
  VITE_API_BASE: https://mc.tbpdt.top:9983
```

**这是构建期变量**：改了它必须重新部署 Pages。而后端那边的上游地址、缓存 TTL、
限流阈值全在 `server.yaml` 里，改那些**不需要**重新构建前端。

> ⚠️ 前提：仓库必须先在 **Settings → Pages → Source** 里选 "GitHub Actions"，
> 否则工作流会在 `configure-pages` 步骤报 `Get Pages site failed ... Not Found`。
> 这是一次性配置。

---

## 三、部署后验证

### 1. 后端接口自检

```bash
node scripts/verify-server.mjs http://127.0.0.1:9983          # 本机
node scripts/verify-server.mjs https://mc.tbpdt.top:9983      # 线上
```

60 项检查，覆盖榜单完整性（110 条、名次连续）、路径穿越防护、B 站六项数据、
CORS 白名单、压缩、限流。**这个脚本比 curl 逐条试快得多，出问题时它直接指出是哪一环。**

### 2. 逐条确认

```bash
curl https://mc.tbpdt.top:9983/api/healthz
curl https://mc.tbpdt.top:9983/api/weekly/latest | head -c 300
curl "https://mc.tbpdt.top:9983/api/bili/stats?aid=av117207459697071"

# 跨域：必须回显你的前端域名
curl -i -H "Origin: https://evrc.tbpdt.top" https://mc.tbpdt.top:9983/api/weekly/info | grep -i access-control

# 压缩：应看到 gzip
curl -i -H "Accept-Encoding: gzip" https://mc.tbpdt.top:9983/api/weekly/latest | grep -i content-encoding
```

### 3. 浏览器

打开 `https://evrc.tbpdt.top/`，确认：

- [ ] 标题右侧显示「第 735 期 · 在线」
- [ ] 排名定位区出现 110 条可比对
- [ ] 数据输入区出现粘贴框与「取回数据」按钮
- [ ] 点排名区相邻条目的「填入」，六项数据被填入且显示「数据获取于 …」

---

## 四、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 浏览器报 CORS 错误 | `allowed_origins` 里没有前端域名 | 在 `server.yaml` 里加上，重启 |
| 前端显示「周刊数据暂时取不到」 | 后端没起来，或解析不通 | 先 `--check`，再看后端日志 |
| 后端日志里所有访客是同一个 IP | 走了 Cloudflare 代理但没配 `trusted_proxies` | 加 `trusted_proxies: ["cloudflare"]` |
| 限流形同虚设 | 直连暴露却配了 `trusted_proxies`，IP 可被伪造 | 清空 `trusted_proxies` |
| B 站接口一律 412 | 出口 IP 被判为机房 IP | 确认流量确实从住宅 IP 出；VPS 上无解 |
| B 站接口偶发 5xx | 上游限流或抖动 | 正常，缓存会回吐旧数据并标 `stale` |
| 新一期发布后仍是旧数据 | `latest_ttl` 未到 | 最多等 5 分钟；也可调小该项 |
| 前端请求打到 `evrc.tbpdt.top/api/...` | 构建时漏了 `VITE_API_BASE` | 改工作流 env 后重新部署 Pages |
| 证书错误 | 直接用了非标端口且无证书 | 见上文「域名与端口」 |

查看后端日志：

```bash
journalctl -u evrcalc -f              # Linux
# 或直接看进程输出（Windows 任务计划/服务的方式不同）
```

把 `log.level` 调成 `debug` 可以看到每次缓存的命中情况。

---

## 附一：防刷与额度保护

### 先把认知摆正：CORS 不是访问控制

`Access-Control-Allow-Origin` 只是**浏览器自愿遵守**的规则。爬虫用
`curl` / `python requests` 时完全不看这个头，照样拿到数据。
所以把白名单收紧**挡不住刷量**，它只能阻止"别人的网页在浏览器里读我们的响应"。

真正有效的是下面两条：

### 1. 限流（`rate_limit`）

令牌桶，按「客户端 IP + 接口类别」分桶。周刊与 B 站分开计数——
B 站那条才是有上游代价的（一条响应 118 KB + 消耗本机 IP 信誉），所以限得更严。

```yaml
rate_limit:
  weekly_per_minute: 60
  bili_per_minute: 20
  burst: 10
  bucket_idle_timeout: "10m"
```

超限返回 **429** 并带 `Retry-After`。

**取真实 IP 这条务必理解清楚**：只有在请求**确实来自 `trusted_proxies`** 时，
才会去读 `real_ip_header`。否则任何人加一个 `CF-Connecting-IP` 请求头就能伪造 IP，
把限流变成摆设。

### 2. 缓存（`cache`）

周刊数据一旦发布就冻结，所以缓存是这里最划算的防线：

| 数据 | 策略 | 说明 |
|---|---|---|
| 历史期 `rank_data/N.json` | 24h + ETag 条件请求 | 发布即冻结，没变时上游回 304 |
| 当期 `latest.json` | 5m | 一周一变，短 TTL 足够 |
| B 站六项数据 | 90s | 分钟级变化 |
| B 站 stale 窗口 | 24h | 上游挂掉时回吐旧数据，标 `X-EvRCalc-Stale: 1` |

上游失败时**优先给旧数据 + 如实标注**，而不是给用户一个报错——
给一份稍旧的数字远好过什么都没有。

### 3. 额度会被刷光的后果

后端自带令牌桶，单 IP 被卡在 20~60 次/分钟；要真跑满需要多来源持续轮换。
**真正被刷时的后果也只是接口暂时不可用**，前端会自动降级为纯手动计算
（周刊排名区隐藏），站点不会崩。

### 4. 加一层 WAF（可选）

若把子域挂到 Cloudflare 代理，可以在面板上再加一条 Rate Limiting 规则，
在请求到达你家的机器之前就拦掉异常流量 —— 这对家用带宽尤其有价值。

---

## 附二：接口与缓存

后端（`https://mc.tbpdt.top:9983`）：

| 路径 | 说明 | 缓存 | 响应体积 |
|---|---|---|---|
| `/api/weekly/latest` | 最新一期，110 条 | 5m | ≈24 KB（gzip ≈8.9 KB） |
| `/api/weekly/info` | 期数目录，216 期 | 30m | ≈4 KB |
| `/api/weekly/rank?n=735` | 指定期数 | 24h | ≈24 KB |
| `/api/bili/stats?bvid=` / `?aid=` | 单条视频六项数据 | 90s | ≈226 B |
| `/api/bili/resolve?q=` | 链接/号 → 规范化标识 | 1h | ≈100 B |
| `/api/bili/batch?bvid=a,b` | 批量（≤20 条） | 复用单条缓存 | — |
| `/api/healthz` | 健康检查 | — | ≈60 B |

### 响应裁剪

上游 `latest.json` 有 63.8 KB，其中大半用不到。后端只保留：

```
url, avid, title, point, rank, play, like, favorite, coin, comment, danmaku
```

剔除的冗余（单条约 200 字节）：`referSource`（与外部字段重复的同快照，最大浪费）、
`coverurl`、`pubdate`、`share`，以及整段 `oth_pickup` / `statistic` / `thanks_list` 等。

| | 原始 | 裁剪后 | 省 |
|---|---|---|---|
| 未压缩 | 63.8 KB | ≈24 KB | **63%** |
| 本机实测 gzip | — | 8,898 B | **69%**（相对未压缩的 28,706 B） |

`/api/weekly/info` 由 36 KB 降到 4 KB。

**B 站那一条更夸张**：`view` 接口在视频属于某个合集时会把整个合集塞进 `ugc_season`，
拜年纪单品之类一条响应可达 118 KB（其中 113 KB 是合集展开），而后端只取
`data.stat` 里的六个数字，响应降到约 **226 字节**。

**副作用**：后端与前端的数据形状耦合 —— 前端若要新字段，需要同步改
`server/weekly.go` 里的 `VIDEO_FIELDS` 并重启后端。

## 附三：关于 CORS 白名单

```yaml
cors:
  allowed_origins:
    - "https://evrc.tbpdt.top"
    - "http://localhost:5173"     # 本地开发
```

不认识的来源不会拿到 `Access-Control-Allow-Origin`，浏览器会阻止 JS 读取响应
（但请求本身还是发出去并被执行了 —— 这正是 CORS 不是访问控制的意思）。

本地开发其实**不需要**配 CORS：Vite 已把 `/api` 代理到后端（见 `vite.config.ts`），
浏览器只看到同源请求。
