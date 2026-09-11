# eVRCalc 部署指南

## 架构：两个部署目标，前端与 API 跨域

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  GitHub Pages               │  跨域   │  Cloudflare Worker           │
│  https://evrc.tbpdt.top     │ ──────► │  https://api.tbpdt.top       │
│  纯静态前端（无出网能力）      │  CORS   │  /api/weekly/*  /api/bili/*  │
└─────────────────────────────┘         └──────────────┬───────────────┘
                                                       │ Worker 出网
                                                       │ （不带 Origin）
                                                       ▼
                                    www.evocalrank.com · api.bilibili.com
```

**为什么必须要有那个 Worker**：浏览器无法直连这两个 API（实测确认，见 `plan.md` §1.3）——
`evocalrank.com` 从不返回 `Access-Control-Allow-Origin`；`api.bilibili.com` 对非 bilibili
域名的 `Origin` 直接返回 403，连 CORS 阶段都到不了。Worker 出去取数再补上 CORS 头，
是唯一可行的路径。

**跨域这件事已处理好**：Worker 会给所有响应（含错误响应）加上
`Access-Control-Allow-Origin: *`。本 Worker 不携带任何凭据、全部是公开只读数据，
用 `*` 是安全的。若要收紧，见下方「可选：收紧 CORS 来源」。

---

## 一、先部署 Worker（拿到 API 地址）

Worker 必须先上线，因为前端的构建需要它的地址。

### 1. 改域名配置

编辑 `wrangler.jsonc`，只改这一行：

```jsonc
"routes": [{ "pattern": "api.tbpdt.top/*", "zone_name": "tbpdt.top" }]
```

⚠️ **pattern 结尾必须是 `/*`，不能写成 `/api/*`。**

`assets` 绑定只决定"哪些文件可被服务"，`routes` 才决定"哪些请求进入这个 Worker"。

### 2. 部署

```bash
npx wrangler login     # 打开浏览器授权，只需一次
npx wrangler deploy
```

`wrangler` 不在 `devDependencies` 里（它的 postinstall 会拉 workerd 二进制，
在本机沙箱下会导致 `npm install` 失败），用 `npx` 临时下载即可。

### 3. 验证 Worker（**关键，唯一的功能性未知数**）

```
https://api.tbpdt.top/api/weekly/latest
https://api.tbpdt.top/api/bili/view?bvid=BV1WeZLBtEW1
```

| 结果 | 含义 |
|---|---|
| 两条都返回 JSON | ✅ 完美，继续下一步 |
| 周刊 OK，B 站返回 `{"error":"上游返回 HTTP 403"}` | ⚠️ B 站不放行 Cloudflare 出口 IP —— 见下方「B 站不通怎么办」 |
| 页面 404 | `routes` 配错了，检查是否写成 `/*` |
| DNS 错误 | 自定义域未生效，面板 Domains & Routes 看状态 |

**周刊那条几乎必然成功**：evocalrank 本身就托管在 Cloudflare 上，
Worker 访问它属于 CF 网络内部路由，不经公网出口。

---

## 二、再部署前端到 GitHub Pages

### 1. 初始化仓库并推送

当前目录还不是 git 仓库，先初始化：

```bash
git init -b main
git add -A
git commit -m "feat: eVRCalc 初始版本"

# 仓库地址按你给的规划：https://github.com/Takeoff0518/eVRCalc
git remote add origin https://github.com/Takeoff0518/eVRCalc.git
git push -u origin main
```

> 首次推送若报错，先在 GitHub 上手动建好空仓库（**不要**勾选 README / .gitignore，
> 否则会有冲突）。

### 2. 打开 GitHub Pages 并选对来源

仓库 → **Settings** → **Pages**：

- **Source** 选 **GitHub Actions**（不要选 "Deploy from a branch"）
- 仓库里已放好 `.github/workflows/deploy-pages.yml`，推送到 `main` 后会自动构建部署

工作流里已经把 `VITE_API_BASE: https://api.tbpdt.top` 写进构建环境。
**如果你用了别的 Worker 子域，记得同步改这一处**（否则线上前端会去请求
`evrc.tbpdt.top/api/...`，那个地址上没有 Worker，必然 404）。

也可以不用 Actions、手动部署：本地 `npm run build` 后把 `dist/` 推到一个 `gh-pages`
分支，Pages Source 选那个分支。

### 3. 配置自定义域名 evrc.tbpdt.top

**第一步：告诉 GitHub 这个域名**

仓库 → Settings → Pages → **Custom domain** 填 `evrc.tbpdt.top` → Save。

或者直接在仓库根目录放一个 `CNAME` 文件（内容就一行 `evrc.tbpdt.top`）——
Actions 部署时 `actions/configure-pages` 会自动处理这一步。

**第二步：在 Cloudflare 加 DNS 记录**

Cloudflare 面板 → 你的域名 `tbpdt.top` → **DNS** → Add record：

| 字段 | 值 |
|---|---|
| Type | `CNAME` |
| Name | `evrc` |
| Target | `takeoff0518.github.io` |
| Proxy status | **DNS only（灰云）** ← 重要 |

⚠️ **必须选灰云（DNS only）。** 如果开成橙云（Proxied），Cloudflare 会接管 TLS，
而 GitHub Pages 需要自己签发证书，两者会冲突，结果是证书错误或重定向循环。
等 GitHub 签发完证书（首次通常几分钟到半小时），再考虑要不要开橙云。

**第三步：等待证书签发**

Settings → Pages 里 Custom domain 旁出现 ✅，且勾选 **Enforce HTTPS**。
GitHub 首次签发 Let's Encrypt 证书可能需要几分钟到几小时。

### 4. 顺带确认 `favicon.svg` 路径

`vite.config.ts` 里设了 `base: './'`，产物用的是相对路径
（`./assets/...`、`./favicon.svg`），因此无论部署在域名根路径还是子路径都不会 404。
这是刻意做的防御。

---

## 三、部署后确认清单

- [ ] `https://api.tbpdt.top/api/weekly/latest` 返回 JSON
- [ ] `https://api.tbpdt.top/api/bili/view?bvid=BV1WeZLBtEW1` 返回 `code:0`
- [ ] `https://evrc.tbpdt.top/` 能打开，标题 `eVRCalc`，样式正常（有五色 Box）
- [ ] 手动填六项数据 → 得点算出、五类得点与四个修正正常显示
- [ ] 右侧「完整计算逻辑」里当前分支有淡色底高亮
- [ ] 周刊排名定位区块出现（说明 CORS 通了）
- [ ] 输入 BV 号点「查询」→ 六项数据自动填入（B 站那条通的话）
- [ ] 手机窄屏下右侧公式区下移、各 Box 转单列

**如果「周刊排名定位」没出现**：说明前端取不到数据。按 F12 看 Network 里
`api.tbpdt.top/api/weekly/latest` 的状态——若是 CORS 报错，说明 Worker 的
CORS 头没生效（检查是否漏部署了新版本）；若是 404，检查 `VITE_API_BASE` 是否配对。

---

## 四、B 站那条不通怎么办

**不影响主功能，无需改代码。** 界面已实现自动探测与静默降级：

| 功能 | Worker 在线且放行 | Worker 不通或被 403 |
|---|---|---|
| 手动填六项 + 全部得点计算 | ✅ | ✅ **完全可用** |
| 五类得点 / 四个修正 / 计算逻辑面板 | ✅ | ✅ **完全可用** |
| B 站 URL/BV/av 自动填充 | ✅ | ❌ 自动隐藏入口并给提示 |
| 周刊排名定位 | ✅ | ✅ **不受影响**（走 evocalrank） |
| Top1 叠加进度条 | ✅ | ✅ **不受影响** |
| 减去上期数据按钮 | ✅ | ✅ **不受影响** |

如果 B 站那条真的不通，我可以再帮你加一个「手动导入周刊 JSON」的兜底入口，
让周刊那一套功能在完全离线时也能用。

---

## 五、本地开发

前端和 Worker 分居两地，本地开发有三种方式：

**方式 1（推荐）：本地 Worker + Vite proxy**

```bash
npx wrangler dev --port 8787    # 终端 1
npm run dev                     # 终端 2
```

浏览器只看到 `localhost:5173` 的同源请求，由 Vite 转发（`vite.config.ts` 已配好）。

**方式 2：直接连线上 Worker**

```powershell
$env:VITE_API_BASE="https://api.tbpdt.top"; npm run dev
```

**方式 3：什么都不配**

联网功能自动降级，手动填写与计算完全可用。

---

## 六、后续更新流程

```bash
git add -A
git commit -m "..."
git push          # → GitHub Actions 自动构建并部署 Pages
```

Worker 改动需要单独部署（Pages 的工作流不会碰 Worker）：

```bash
npx wrangler deploy
```

---

## 七、排错速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 域名根路径 404 | `routes` 写成了 `/api/*` | 改成 `/*` 重新 `wrangler deploy` |
| 前端样式/JS 全丢 | `base` 配置或产物未上传 | 确认 `vite.config.ts` 里 `base: './'`，重新构建 |
| Pages 证书错误 / 重定向循环 | Cloudflare 橙云与 Pages 抢 TLS | DNS 记录改为**灰云（DNS only）** |
| `/api/*` 返回 `{"error":"not found"}` | 路径拼错或请求没进 Worker | 检查 `routes` 与 URL |
| 周刊区块不显示 | 周刊接口失败 → 已按降级设计隐藏 | F12 Network 看状态码 |
| 前端请求打到 `evrc.tbpdt.top/api/...` | 构建时漏了 `VITE_API_BASE` | 改工作流 env 后重新部署 |
| `wrangler deploy` 报域名不属于该账号 | `zone_name` 写错或域名在别的账号 | 核对面板拼写 |
| B 站返回 403 | CF 出口 IP 被 B 站挡 | 接受降级（见第四节） |

Worker 实时日志：

```bash
npx wrangler tail
```

---

## 附一：接口路径速查

Worker（`https://api.tbpdt.top`）：

| 路径 | 说明 | 缓存 |
|---|---|---|
| `/api/weekly/info` | 期数目录（216 期，520–735） | 3600s |
| `/api/weekly/latest` | 最新一期全量（≈65 KB，115 条） | 600s |
| `/api/weekly/rank?n=735` | 指定期数 | 86400s |
| `/api/bili/view?bvid=BV1WeZLBtEW1` | 视频六项数据 | 120s |
| `/api/bili/view?aid=116067884077341` | 同上（av 号形式） | 120s |

**当前代码只调用 `/api/weekly/latest` 与 `/api/bili/view`**，其余为将来保留。

Cloudflare Workers 免费版：**100,000 请求/天**，本应用量级远远用不到。

## 附二：可选——收紧 CORS 来源

默认 `Access-Control-Allow-Origin: *`。若想只允许自己的前端域名，在
Cloudflare 面板 → Worker → Settings → Variables 添加：

```
ALLOWED_ORIGIN = https://evrc.tbpdt.top
```

Worker 会读取该变量替代 `*`。**注意**：收紧后本地开发的 `localhost:5173`
会被浏览器拦截，需要临时把 `localhost` 也加进去，或本地开发时干脆不带该变量。
