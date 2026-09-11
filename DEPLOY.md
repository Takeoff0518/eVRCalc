# eVRCalc 部署指南

## 架构

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  GitHub Pages                │  跨域   │  Cloudflare Worker           │
│  https://evrc.tbpdt.top      │ ──────► │  https://api.tbpdt.top       │
│  纯静态前端（无出网能力）      │  CORS   │  /api/weekly/*               │
└─────────────────────────────┘         └──────────────┬───────────────┘
                                                       │
                                                       ▼
                                            www.evocalrank.com
```

**为什么必须有这个 Worker**：浏览器无法直连周刊接口。`www.evocalrank.com` 的 JSON
接口从不返回 `Access-Control-Allow-Origin`，浏览器会**直接丢弃整个响应**——即使
服务端返回了 200 与完整数据，JS 侧也只能看到 `TypeError: Failed to fetch`。
注意这与"服务端是否校验来源"无关：实测该服务端并不看 `Origin` 头，问题纯在
浏览器侧的读取授权。

Worker 出去取数，再为浏览器补上 CORS 响应头，顺带把响应裁剪到前端真正需要的字段。
**跨域这件事已处理好**：所有响应（含错误响应）都带 `Access-Control-Allow-Origin`。

**不含 B 站接口。**自动填充已确认不可行并移除，原因见 `README.md`
「为什么没有 B 站自动填充」。

---

## 一、部署 Worker（拿到 API 地址）

### 1. 确认域名配置

`wrangler.jsonc` 里只需这一行：

```jsonc
"routes": [{ "pattern": "api.tbpdt.top", "custom_domain": true }]
```

用 **Custom Domain** 而不是 Route：

- Custom Domain 会**自动创建 DNS 记录并签发证书**
- Route 只匹配已有流量、**不会创建 DNS 记录**，照抄 Route 写法会出现
  `api.tbpdt.top` 解析不了（`ENOTFOUND`）的情况

两个注意点：pattern 是**纯主机名**（不带 `/*`、不带路径）；该主机名下不能已存在
CNAME 记录，否则创建失败。

### 2. 部署

```bash
npx wrangler login     # 打开浏览器授权，只需一次
npx wrangler deploy
```

`wrangler` 不在 `devDependencies` 里（它的 postinstall 会拉 workerd 二进制，
会触发本机沙箱限制），用 `npx` 临时下载即可，功能不受影响。

**部署前不需要先 build** —— Worker 已不依赖 `dist/`（前端由 Pages 托管）。

### 3. 验证 Worker

```bash
node scripts/verify-trim.mjs      # 校验裁剪字段与体积（可选，不依赖 Worker）
```

再用浏览器或 curl 确认三个接口：

```
https://api.tbpdt.top/api/weekly/latest
https://api.tbpdt.top/api/weekly/info
https://api.tbpdt.top/api/weekly/rank?n=735
```

预期结果：

| 接口 | 状态 | 体积 | 内容 |
|---|---|---|---|
| `/api/weekly/latest` | 200 | ≈24 KB | `main_rank` 30 条 + `second_rank` 80 条 = **110 条** |
| `/api/weekly/info` | 200 | ≈4 KB | 216 期期号（520–735） |
| `/api/weekly/rank?n=735` | 200 | ≈24 KB | 同 latest |

同时确认单个条目只有这些字段：
`url, avid, title, point, rank, play, like, favorite, coin, comment, danmaku`
（**不应**出现 `referSource` / `coverurl` / `pubdate` / `share`）。

---

## 二、部署前端到 GitHub Pages

### 1. 推送代码

```bash
git remote add origin https://github.com/Takeoff0518/eVRCalc.git
git push -u origin main
```

### 2. ⚠️ 先启用 Pages（**必须先做，否则第一次构建就会失败**）

仓库 → **Settings** → **Pages** → **Build and deployment** → **Source** 选
**GitHub Actions**（不要选 "Deploy from a branch"）。

**这一步不能省，也不能靠工作流自动完成。** 跳过的话 Actions 会在
`actions/configure-pages@v5` 处失败：

```
Error: Get Pages site failed. Please verify that the repository has Pages enabled
and configured to build using GitHub Actions... Error: Not Found
```

> 为什么不加 `enablement: true` 自动开启？官方 action 文档写明
> "This option requires a token other than `GITHUB_TOKEN` to be provided" ——
> 默认的 `GITHUB_TOKEN` 权限不足，加了只会把 404 变成 403，反而更难排查。

启用后把失败的运行 **Re-run all jobs**，或推一个提交即可。

工作流里已写入 `VITE_API_BASE: https://api.tbpdt.top`。
**若换了 Worker 子域，必须同步改这一处**，否则线上前端会去请求
`evrc.tbpdt.top/api/...`（那里没有 Worker），必然 404。

### 3. 自定义域名 evrc.tbpdt.top

**第一步：告诉 GitHub**

仓库 → Settings → Pages → **Custom domain** 填 `evrc.tbpdt.top` → Save。

**第二步：在 Cloudflare 加 DNS 记录**

Cloudflare 面板 → `tbpdt.top` → **DNS** → Add record：

| 字段 | 值 |
|---|---|
| Type | `CNAME` |
| Name | `evrc` |
| Target | `takeoff0518.github.io` |
| Proxy status | **DNS only（灰云）** ← 必须 |

⚠️ **必须选灰云。** 开成橙云时 Cloudflare 会接管 TLS，而 GitHub Pages 需要自己
签发证书，两者冲突会导致证书错误或重定向循环。等证书签发完再考虑是否开橙云。

> 对照：`api`（Worker）的 DNS 记录由 Custom Domain **自动创建**，
> 而 `evrc`（Pages）的 DNS 记录**必须你手动加**。两个子域来源不同，容易混淆。

**第三步：等待证书**

Settings → Pages 里 Custom domain 旁出现 ✅，勾选 **Enforce HTTPS**。
首次签发可能需要几分钟到几小时。

---

## 三、部署后确认清单

- [ ] `https://api.tbpdt.top/api/weekly/latest` 返回 200，110 条数据
- [ ] `https://evrc.tbpdt.top/` 能打开，标题 `eVRCalc`，样式正常（五色 Box）
- [ ] 手动填六项数据 → 得点算出、五类得点与四个修正正常显示
- [ ] 右侧「完整计算逻辑」里当前分支有淡色底高亮
- [ ] 周刊排名定位出现，名次与相邻条目标题可点击跳转
- [ ] 得点明显高于 30 名水平时，位次能报出 **30 名以后**（验证续榜已生效）
- [ ] 手机窄屏下右侧公式区下移、各 Box 转单列

**如果周刊排名定位没出现**：F12 看 Network 里 `api.tbpdt.top/api/weekly/latest`
的状态。若是 CORS 报错，说明 Worker 未部署新版；若是 404，检查 `VITE_API_BASE`。

---

## 四、本地开发

```bash
npx wrangler dev --port 8787    # 终端 1：本地 Worker
npm run dev                     # 终端 2：Vite（已配好 proxy）
```

也可直接连线上 Worker：

```powershell
$env:VITE_API_BASE="https://api.tbpdt.top"; npm run dev
```

什么都不配也能跑 —— 联网功能自动降级，手动填写与计算完全可用。

---

## 五、后续更新

```bash
git add -A && git commit -m "..." && git push    # → Actions 自动构建部署 Pages
```

Worker 改动需要单独部署（Pages 工作流不会碰 Worker）：

```bash
npx wrangler deploy
```

---

## 六、排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| `api.tbpdt.top` 解析失败（ENOTFOUND） | 用了 Route 而非 Custom Domain，未建 DNS 记录 | 改为 `custom_domain: true` 重新部署 |
| 域名根路径 404 | Pages 未启用或 Source 选错 | Settings → Pages → Source 选 GitHub Actions |
| `Get Pages site failed` | Pages 未启用 | 同上 |
| 前端样式/JS 全丢 | 产物未上传或 base 配置问题 | 确认 `vite.config.ts` 里 `base: './'`，重新构建 |
| Pages 证书错误 / 重定向循环 | Cloudflare 橙云与 Pages 抢 TLS | DNS 记录改为**灰云** |
| 周刊区块不显示 | 周刊接口失败 → 已按降级设计隐藏 | F12 Network 看状态码 |
| 前端请求打到 `evrc.tbpdt.top/api/...` | 构建时漏了 `VITE_API_BASE` | 改工作流 env 后重新部署 |
| 排名位次都卡在 30 以内 | Worker 或前端用了裁剪掉 second_rank 的旧版本 | 确认 Worker 返回 `second_rank` 且前端已部署新版 |

Worker 实时日志：

```bash
npx wrangler tail
```

---

## 附一：防刷与额度保护

### 先纠正一个常见误解：CORS 不是访问控制

`Access-Control-Allow-Origin` 只是**浏览器自愿遵守**的规则。爬虫用 `curl` /
`python requests` 时完全不看这个头，照样拿到数据。实测本 Worker 对
`Origin: null`、`Origin: https://evil.example.com` 都返回 `ACAO=*`，
但**即使改成白名单，curl 也照样能取**。

所以「只允许某个域名请求」防不住刷量，它只能阻止"别人的网页在浏览器里读我们的响应"。
当前默认 `*` 是有意为之（见附二），换成白名单带来的防护是心理上的。

同样地，检查 `Origin` / `Referer` 也是无效的 —— 这些头都能任意伪造。

### 真正有效的手段

**① 限流（已启用，实测有效）**

`wrangler.jsonc` 里的 `ratelimits` 绑定：

```jsonc
"ratelimits": [
  { "name": "RATE_LIMITER", "namespace_id": "1001",
    "simple": { "limit": 30, "period": 60 } }
]
```

**免费版可用。** 部署时会显示 `env.RATE_LIMITER (30 requests/60s)  Rate Limit`。
实测快速连打时第 29 次请求开始返回 429，符合阈值设定。

阈值取 30 次/分钟的理由：正常使用是「每次打开页面 1 个请求」，
30 次/分钟（每 2 秒一次）对真人远远用不到，但足以挡住脚本。

两个必须知道的限制（官方文档明确说明）：

- 计数**按 Cloudflare 节点独立**：同一 IP 在不同节点各有额度。
  因此它不是精确的全局限流，但能挡住绝大多数脚本。
- `period` 只能是 10 或 60 秒。

限流键用「国家 + 节点 + IP」组合。官方建议不要只按 IP 限流
（移动网络下大量用户共用出口 IP），组合键可减轻误伤。

**② 边缘缓存（已配置，但效果无法确证）**

Worker 的 fetch 子请求默认**不缓存**，`cache-control` 只作用于浏览器。
代码里已加 `cf: { cacheEverything: true, cacheTtl: <各接口 TTL> }`，
意在让同一节点在 TTL 内只回上游一次。

实测情况：

- 上游该接口**不发送 `cache-control`**（只有 etag），所以不存在上游头覆盖 TTL 的问题
- 客户端读不到 `cf-cache-status` / `age`，无法直接证明命中
- 延迟由首访 ~1300ms 稳定到 ~750ms，有改善但不足以断定是边缘缓存

也就是说**这条可能生效、也可能没有**。若你希望确证，可以在 Cloudflare 面板看图表的
"Requests to origin" 或开启 Workers Logs 观察。

**③ 可选：Bot Fight Mode**

Cloudflare 面板 → Security → Bots，免费计划包含基本的 Bot Fight Mode。
开启后会对已知爬虫特征做挑战。对本项目是可选项。

### 额度会被刷光的风险有多大

即使不设防，单 IP 也被限流卡在 30 次/分钟；要在一天内跑满 100,000 次请求，
需要持续多个来源轮换。**真正被刷光时的后果也只是当天该 API 不可用**，
前端会自动降级为纯手动计算（周刊排名区隐藏），站点不会崩。

### 实时监控

```bash
npx wrangler tail
```

或在面板 → Workers → evrcalc-api → Metrics 看请求量曲线。
同时可以观察 429 的比例来判断是否有人在刷。

---

## 附二：接口与缓存

Worker（`https://api.tbpdt.top`）：

| 路径 | 说明 | 缓存 | 体积 |
|---|---|---|---|
| `/api/weekly/latest` | 最新一期，110 条 | 600s | ≈24 KB |
| `/api/weekly/info` | 期数目录，216 期 | 3600s | ≈4 KB |
| `/api/weekly/rank?n=735` | 指定期数 | 86400s | ≈24 KB |

**当前前端只调用 `/api/weekly/latest`**，`/info` 仅在网络失败回退缓存时用于取最新期号。
`/rank` 为将来切换期数保留。

### 响应裁剪

上游 `latest.json` 有 63.8 KB，其中大半用不到。Worker 只保留：

```
url, avid, title, point, rank, play, like, favorite, coin, comment, danmaku
```

剔除的冗余（单条约 200 字节）：`referSource`（与外部字段重复的同快照，最大浪费）、
`coverurl`、`pubdate`、`share`，以及整段 `oth_pickup` / `statistic` / `thanks_list` 等。

| | 原始 | 裁剪后 | 省 |
|---|---|---|---|
| 未压缩 | 63.8 KB | 23.9 KB | **63%** |
| gzip | 14.9 KB | 8.6 KB | **42%** |

`/api/weekly/info` 由 36 KB 降到 4 KB。

**副作用**：Worker 与前端的数据形状耦合 —— 前端若需多要一个字段，要同步改
`worker/index.js` 里的 `VIDEO_FIELDS` 并重新部署。当前规模下可接受。

Cloudflare Workers 免费版 **100,000 请求/天**，本应用量级远远用不到。

## 附三：可选——收紧 CORS 来源

默认 `Access-Control-Allow-Origin: *`。若想只允许自己的前端域名，在
Cloudflare 面板 → Worker → Settings → Variables 添加：

```
ALLOWED_ORIGIN = https://evrc.tbpdt.top
```

**但请先读附一**：CORS 头只影响浏览器，挡不住用 curl 的爬虫，
所以这一步的防护意义有限，主要是"礼仪性"的。另外收紧后本地开发的
`localhost` 会被浏览器拦截，需临时把 localhost 也加入，或本地开发时不带该变量。
