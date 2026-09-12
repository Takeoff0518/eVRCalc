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

后端只有一个外部依赖（`gopkg.in/yaml.v3`），而且已经 **vendor 进仓库**，
所以克隆下来就能构建，不需要访问 `proxy.golang.org`（该域名在国内常不可达）。

**在目标机上直接编译**（需要装 Go）：

```bash
cd server
go build -o evrcalc-server .            # 产物约 5.9 MB
```

**在 Windows 上交叉编译到 Linux**（推荐，目标机不用装 Go）：

```bash
npm run server:build            # 默认 linux/amd64
npm run server:all              # 全部七个平台
npm run server:verify           # 校验架构与链接方式（发上线前跑一次）
```

或者直接用脚本，参数更灵活：

```powershell
.\server\build.ps1 linux-amd64      # Windows
./server/build.sh linux-amd64       # Linux / macOS / Git Bash / WSL
./server/build.sh all
```

可用目标：`linux-amd64`、`linux-arm64`、`linux-armv7`、`linux-386`、
`windows-amd64`、`darwin-arm64`、`darwin-amd64`。

产物在 `server/dist/`，文件名带平台后缀。

`CGO_ENABLED=0` 让它成为**全静态链接**的二进制——不依赖 glibc 版本，
所以 CentOS 7、Alpine、任何发行版都能直接跑，不需要在目标机上装任何东西。

**先确认目标机架构**，编错了上去就是 `Exec format error`：

```bash
uname -m        # x86_64 → linux-amd64    aarch64 → linux-arm64    armv7l → linux-armv7
```

`npm run server:verify` 会把每个产物的架构与链接方式打出来，可以直接与
`uname -m` 对照。

### 3. 传到目标机

```bash
# 只传二进制，不需要传源码（依赖已编进二进制）
scp server/dist/evrcalc-server-linux-amd64 user@host:/opt/evrcalc/evrcalc-server
scp server/server.example.yaml            user@host:/opt/evrcalc/server.yaml
ssh user@host 'chmod +x /opt/evrcalc/evrcalc-server'
```

记得改 `/opt/evrcalc/server.yaml` 里的 `cors.allowed_origins`。

### 4. 先自检，再启动

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

如果提示 `Permission denied`，是忘了加执行位（`scp` 不会保留它）：

```bash
chmod +x evrcalc-server
```

### 5. 让它常驻

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

### 6. 域名、端口与 TLS

#### 拓扑：HTTP API 用独立子域，其他服务保持灰云

`mc.tbpdt.top` 上除这个后端外还跑着 **Minecraft、OpenList** 这类服务，
它们必须保持**灰云直连** —— 一旦开橙云，Cloudflare 只会转发 80/443 上的
HTTP/HTTPS，游戏连接会直接断掉。

好消息是：**代理开关是按「主机名」生效的，不是按 IP。** 同一台机器上
一个名字开代理、另一个不开，完全可行：

```
evrc.tbpdt.top    橙云  GitHub Pages（前端，人家本来就在 Cloudflare 上）
api2.tbpdt.top    橙云  CNAME → ddns 记录    ← 只给这个 Go 后端
mc.tbpdt.top      灰云  A → 124.128.104.102  Minecraft / OpenList / 其他（不动）
ddns.tbpdt.top    灰云  A → 动态 IP           ← ddns-go 只管这一条
```

用 **CNAME 指向 ddns 记录**（而不是再写一条 A），动态 IP 依然由 ddns-go
一处管住。这对「源站 IP 会变」的部署是 Cloudflare 上的标准做法。

**为什么不用 443**：浏览器连的是 **Cloudflare 边缘的 443**，与你家被封的 443
毫无关系。回源端口由你自己决定，`9983` 就够用（你也已经配好转发了）。

#### 配置步骤

1. **后端保持 `listen: ":9983"`**（绑所有网卡，不能是 `127.0.0.1`）。
   `tls:` 一节**必须配置** —— 见下面第 5 步（Cloudflare 用 HTTPS 回源，
   源站不会讲 TLS 就一定连不上）。

2. **子域名**：用一个没被占用的名字（本文用 `api2`）。
   `api.tbpdt.top` 被早期那个**已停用的 Worker** 占着，而且**它至今仍在公网上
   响应**（实测 `/api/weekly/latest` 返回 200）—— 所以直接换名字更省事。

   > 想清理那个 Worker：删掉 `wrangler.jsonc` 里的 `routes` 后
   > `npx wrangler deploy`，或在面板 → Workers & Pages → `evrcalc-api` →
   > Settings → Domains & Routes 里移除 `api.tbpdt.top`。
   > 它已无人维护，留着等于多一个裸露的旧接口。

3. **建 DNS 记录**（Cloudflare 面板 → DNS）：

   | 类型 | 名称 | 目标 | 代理状态 |
   |---|---|---|---|
   | CNAME | `api2` | `ddns.tbpdt.top`（ddns-go 维护的那条） | **已代理（橙云）** |

   用 API 建的话务必带上 `"proxied": true` —— 用面板改记录类型时那个开关
   有可能被重置成灰云，那就等于直接把源站 IP 暴露出去了。

4. **从外网确认回源端口真的通**（这一步最容易跳过，然后又白排查半天）：

   在**另一台机器**上（手机、VPS、或任何不在这个局域网里的设备）连一下：

   ```bash
   nc -vz mc.tbpdt.top 9983        # 或 telnet mc.tbpdt.top 9983
   ```

   连不上就先解决端口转发/防火墙，别急着怪 Cloudflare。

   > ⚠️ 必须从**外网**测。在同一台机器或同一局域网里测会得到"通"的假象
   > （走的是内网直连，不经过路由器与运营商）。

5. **回源证书 + 让源站讲 HTTPS**（本节是本项目踩坑最多的一步）。
   面板 → **SSL/TLS → Origin Server** → **Origin Certificates** 标签 →
   [**Create Certificate**](https://dash.cloudflare.com/?to=/:account/:zone/ssl-tls/origin)，
   一键签发（免费、15 年有效）；然后把 SSL/TLS → Overview 的模式设成 **Full (strict)**。

   **Hostnames 填 `*.tbpdt.top, tbpdt.top`**（通配符覆盖一级子域，`api2` 属于一级子域）。

   拿到证书后**源站也要启用 HTTPS**，否则 Cloudflare 用 HTTPS 回源会失败：

   ```yaml
   listen: ":9983"
   tls:
     cert_file: "/etc/evrcalc/fullchain.pem"
     key_file:  "/etc/evrcalc/privkey.pem"
   ```

   ⚠️ **别走错页面。** Cloudflare 的 SSL/TLS 下有两个名字很像的入口，很容易点错：

   | 页面 | 证书类型 | 用途 | 有没有 SAN |
   |---|---|---|---|
   | SSL/TLS → **Origin Server** → Origin Certificates | **Origin CA**（回源证书） | 给 Cloudflare 回源时**验证你的服务器** | **有**，填的 hostname 就是 SAN |
   | SSL/TLS → **Client Certificates** | **客户端证书**（mTLS） | 给 Cloudflare **验证来访客户端** | **没有** |

   走错的表现很好认：签发出来的证书 `subjectAltName` 是**空的**、CN 只有 `Cloudflare`，
   于是 Full (strict) 下必然 **526**（Cloudflare 找不到能匹配你域名的条目）。
   客户端证书天生不需要 SAN，所以怎么重签都不会有。
   正确的证书长这样：`CN=CloudFlare Origin Certificate`、
   颁发者 `CloudFlare Origin SSL Certificate Authority`、
   SAN 为 `DNS:*.tbpdt.top, DNS:tbpdt.top`。

   想确认手上的证书属于哪一类，看 SAN 就行（现代 TLS 客户端只看 SAN、不看 CN）：

   ```bash
   openssl s_client -connect mc.tbpdt.top:9983 -servername mc.tbpdt.top </dev/null 2>/dev/null \
     | openssl x509 -noout -subject -ext subjectAltName
   ```

   要看到 SAN 里列出 `DNS:*.tbpdt.top` 与 `DNS:tbpdt.top`。
   若报 `No extensions in certificate` 或 SAN 为空，就是签错页面了。

   ⚠️ **不能用 Flexible**：它会让 Cloudflare 用 **http** 回源，而 http 回源时
   它会去连源站的 **80 端口** —— 你家 80 被封，直接 522。

6. **回源端口**：Cloudflare 默认按标准端口回源，**不会**自动用 9983。
   在 **Rules → Overview → Create rule → Origin Rule** 里加一条：

   | 字段 | 值 |
   |---|---|
   | When incoming requests match | Custom filter → `Hostname equals api2.tbpdt.top` |
   | Then → **Destination Port** | Rewrite to **`9983`** |

   没有这条的典型表现：**522 且响应耗时约 20 秒**（SYN 被丢包），
   而源站本身明明是好的。

7. **限流取真实 IP**：开了代理后后端看到的对端 IP 是 Cloudflare 的，
   必须配置：

   ```yaml
   rate_limit:
     trusted_proxies: ["cloudflare"]
   ```

   ⚠️ 两个方向都会出问题，别弄错：
   - 走了代理却**没配** → 限流把所有访客当成同一个人
   - 没走代理却**配了** → 任何人伪造 `CF-Connecting-IP` 就能绕过限流

8. 前端 `public/config.json` 里 `apiBase` 填 `https://api2.tbpdt.top`（不带端口）。

> **顺带一提**：`OpenList` 这类本身就想走 HTTP 的服务，也可以照同样办法挂到
> 自己的橙云子域上，不必和 `mc` 共用灰云。本文只针对本项目，不展开。

#### 备选：直连源站

不想开代理也行，前端直接连 `https://mc.tbpdt.top:9983`，但那样**必须自己持有
受信任的证书**（浏览器会拒绝自签）。家里 80 被封 → HTTP-01 走不通，
而 `tbpdt.top` 的 NS 在 Cloudflare，**DNS-01 可行**：

```bash
curl https://get.acme.sh | sh -s email=你的邮箱
export CF_Token="你的 Cloudflare API token"   # 权限：Zone → DNS → Edit

~/.acme.sh/acme.sh --issue --dns dns_cf \
  -d mc.tbpdt.top --server letsencrypt

~/.acme.sh/acme.sh --install-cert -d mc.tbpdt.top \
  --key-file       /etc/evrcalc/privkey.pem \
  --fullchain-file /etc/evrcalc/fullchain.pem \
  --reloadcmd      "systemctl restart evrcalc"
```

`--reloadcmd` **别漏**，否则 60 天后续期了但进程还在用旧证书。然后：

```yaml
tls:
  cert_file: "/etc/evrcalc/fullchain.pem"
  key_file:  "/etc/evrcalc/privkey.pem"
```

**没配 tls 时 `--check` 会明确警告**「若前端页面在 https 下……界面会一直显示
周刊数据不可用」—— 照它说的做即可。

---

## 二、部署前端

前端仍是 GitHub Pages，由 `.github/workflows/deploy-pages.yml` 自动构建部署。

### API 地址是**运行时**可配的

不用再为换地址重新构建前端了。解析顺序：

1. 站点根目录的 **`config.json`**（`public/config.json`，已入库）
2. 构建期的 `VITE_API_BASE`（工作流里的兜底值）
3. 相对路径（本地开发由 Vite proxy 转发）

改 `public/config.json` 后**刷新页面即生效**。

```json
{
  "apiBase": "https://api2.tbpdt.top",
  "biliBase": ""
}
```

`biliBase` 留空则跟随 `apiBase`。走 Cloudflare 代理时**不带端口号**。

工作流里同时也留着兜底值（构建期变量，改了要重新部署，所以日常请改
`config.json`）：

```yaml
env:
  VITE_API_BASE: https://api2.tbpdt.top
```

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
- [ ] 排名定位区出现 110 条可比对，且中间的绿色分隔线标出当前位置
- [ ] 数据输入区出现粘贴框与「获取」按钮
- [ ] 点排名区条目的「填入」（悬停才出现），六项数据被填入且显示「数据获取于 …」

---

## 四、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 界面显示「周刊数据不可用」 | 前端够不到后端 | 按顺序查：`config.json` 里的地址对不对 → 后端 `--check` 能否取到上游 → 从外网 `nc -vz` 试回源端口 |
| **522，且耗时约 20 秒** | 边缘回源到了没人应答的端口 | **最常见的一个坑**。Cloudflare 默认按标准端口回源，**不会**自动用 9983。加 **Origin Rule → Destination Port = 9983** |
| 522，源站已确认可达且讲 TLS | Cloudflare 用了 http 回源（模式是 Flexible） | 改成 **Full (strict)** 并在源站启用 `tls.*` |
| **526** | 回源证书不被接受 | 看 SAN（见第 5 步的 openssl 命令）。**SAN 为空 = 签成了客户端证书**（Client Certificates 页面），要去 **Origin Server → Origin Certificates** 重签。其余可能：私钥与证书不配对、证书过期、`cert_file` 没用 fullchain |
| 526 → 换证书后变 522 | 换了证书但源站没重启 / 没启用 tls | `--check` 应显示 `（HTTPS）` 与 `[OK] 证书加载正常` |
| 525/526，SAN 也正确 | 模式与源站协议不一致 | Full (strict) 要求源站讲 TLS；Flexible 要求源站讲明文 |
| 开橙云后源站 IP 仍暴露 | 改记录类型时橙云开关被重置成灰云 | 用 API 建记录时显式带 `"proxied": true`；建完 `dig` 确认返回的是 Cloudflare 的 IP |
| 浏览器报 CORS 错误 | `allowed_origins` 里没有前端域名 | 在 `server.yaml` 里加上，重启 |
| 浏览器报混合内容 | 后端是 http 而页面是 https | 后端启用 HTTPS（见「域名、端口与 TLS」） |
| 后端日志里所有访客是同一个 IP | 走了 Cloudflare 代理但没配 `trusted_proxies` | 加 `trusted_proxies: ["cloudflare"]` |
| 限流形同虚设 | 直连暴露却配了 `trusted_proxies`，IP 可被伪造 | 清空 `trusted_proxies` |
| B 站接口一律 412 | 出口 IP 被判为机房 IP | 确认流量确实从住宅 IP 出；VPS 上无解 |
| B 站接口偶发 5xx | 上游限流或抖动 | 正常，缓存会回吐旧数据并标 `stale` |
| 新一期发布后仍是旧数据 | `latest_ttl` 未到 | 最多等 5 分钟；也可调小该项 |
| 前端请求打到 `evrc.tbpdt.top/api/...` | 没读到配置 | 检查 `config.json` 是否随构建产物发布、`VITE_API_BASE` 是否为空 |
| `Permission denied` 启动不了 | scp 不保留执行位 | `chmod +x evrcalc-server` |
| 外网连不上但本机 curl 正常 | 监听绑了 `127.0.0.1` | 改成 `":9983"`（绑所有网卡） |

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
