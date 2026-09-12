# eVRCalc

**周刊虚拟歌手中文曲排行榜 · 视频得分计算器**

输入播放、点赞、收藏、硬币、评论、弹幕六项数据，按周刊的官方计分规则算出最终得点，
并显示每一项命中了哪条公式分支、被抑制了多少，同时告诉你这个分数在最新一期周刊里大概排第几。

> 与周刊官网无隶属关系，为第三方工具。

---

## 功能

- **五类得点**：播放 / 互动 / 收藏 / 硬币 / 点赞，逐项展示配色与明细
- **四个修正值**（A/B/C/D）：展示原始值与「保留比例」，命中上限时标红、被重罚时箱体着色
- **完整计算逻辑**：右侧常驻公式原文，并高亮当前**实际命中**的公式分支
- **周刊排名定位**：算出当前得点在最新一期周刊 110 条榜单中的大概位次，名次相邻的标题可点击跳转
- **Top 1 叠加层**：以最新一期榜首为基准的对数刻度进度条，直观对比各项得点
- **从 B 站一键获取数据**：粘贴视频链接 / BV 号 / av 号即可自动填入六项数据；
  也可以直接点排名区里相邻条目的「填入」

**网络不可用时不影响计算**——六项数据随时可以手动填写，得点计算、修正展示、公式说明
全部照常工作，联网功能会自动隐藏并给出提示。

界面上会标出数据的获取时间，而不是假装它是实时的。

## 计分规则

```
最终得点 = 播放得点 + 互动得点 + 收藏得点 + 硬币得点 + 点赞得点

基础播放得点 = 播放 > 10000 ? 播放 * 0.5 + 5000 : 播放
播放得点     = 基础播放得点 * 修正 D
互动得点     = (评论 + 弹幕) * 修正 A * 15
收藏得点     = 收藏 * 修正 B
硬币得点     = 硬币 * 修正 C
点赞得点     = min(点赞, 硬币 * 2)

修正 A = min(((基础播放得点 + 收藏) / (基础播放得点 + 收藏 + (弹幕 + 评论) * 20)) ^ 2, 1)
修正 B = min(收藏 > 硬币*2 ? 硬币^2 / (播放 * 收藏) * 1000 : 收藏 / 播放 * 250, 50)
修正 C = min(硬币 > 收藏   ? 收藏^2 / (播放 * 硬币) * 250  : 硬币 / 播放 * 250, 50)
修正 D = min(收藏 > 硬币   ? 硬币 / 播放 * 25              : 收藏 / 播放 * 25, 1)
```

**关于修正值的理解**：四个修正都是**不超过上限的乘法系数**，所以修正值越大、惩罚越轻，
等于上限即最优，趋近 0 表示该项得点几乎被压光。因此界面把它显示为「保留比例 = 修正值 / 上限」。

**关于榜单结构**：`main_rank` 是第 1~30 名，`second_rank` 是第 31~110 名，
**两段合起来才是完整榜单**（共 110 条）。排名定位同时使用两段。

## 技术栈

React 19 · TypeScript · Vite · TailwindCSS v4 · Vitest · Go（自托管后端）

界面为 Y2K 原始极简风格：1px 实线细边框、完全扁平、单色底，彩色只来自五类得点的官方配色。

## 本地开发

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 84 项前端测试
npm run build        # 产物在 dist/
```

仅前端即可运行全部计算功能。若要使用联网功能（周刊排名定位、叠加层、从 B 站取回数据），
需要同时把后端跑起来：

```bash
# 终端 1：Go 后端（默认监听 :9983，见 server/server.example.yaml）
cd server
cp server.example.yaml server.yaml
go run . --config server.yaml --check    # 先自检配置与上游连通性
go run . --config server.yaml

# 终端 2：前端（Vite 已配好 proxy，默认转发到 127.0.0.1:9983）
npm run dev
```

后端的完整接口自检：

```bash
npm run server:test                              # 后端 56 项 Go 测试
npm run server:check                             # 打本机 127.0.0.1:9983 自检 60 项
node scripts/verify-server.mjs https://mc.tbpdt.top:9983   # 也可以打线上
```

### 交叉编译到 Linux

在 Windows 上编出 Linux 二进制，目标机不需要装 Go：

```bash
npm run server:build        # 默认 linux/amd64
npm run server:all          # 全部七个平台
npm run server:verify       # 校验架构与链接方式
```

产物在 `server/dist/`。因为是 `CGO_ENABLED=0` 的**全静态链接**，
不依赖 glibc 版本，CentOS 7 或 Alpine 上都能直接跑。

编之前先在目标机确认架构（编错就是 `Exec format error`）：

```bash
uname -m        # x86_64 / aarch64 / armv7l
```

## 后端

后端是一个 Go 服务，同时提供周刊查询与 B 站数据解析。
**所有可调项都在 YAML 里**，改完重启进程即可，不需要重新编译，也不需要重新构建前端：

```yaml
listen: ":9983"

upstream:
  weekly: "https://www.evocalrank.com"
  bilibili: "https://api.bilibili.com"

cache:
  latest_ttl: "5m"        # 当期数据，一周一变
  rank_ttl: "24h"         # 已发布的历史期，发布即冻结
  bili_ttl: "90s"         # B 站六项数据
  bili_stale_ttl: "24h"   # 上游挂掉后仍允许回吐多久的旧数据

rate_limit:
  weekly_per_minute: 60
  bili_per_minute: 20
  trusted_proxies: []     # 直连暴露时必须留空，否则可伪造 IP 绕过限流

cors:
  allowed_origins:
    - "https://evrc.tbpdt.top"
```

完整配置项见 [`server/server.example.yaml`](./server/server.example.yaml)。

### 接口

| 接口 | 说明 |
|---|---|
| `GET /api/weekly/info` | 期号目录 |
| `GET /api/weekly/latest` | 最新一期（裁剪后的完整 110 条榜单） |
| `GET /api/weekly/rank?n=<期号>` | 指定期数 |
| `GET /api/bili/stats?bvid=` 或 `?aid=` | 单条视频的六项数据 |
| `GET /api/bili/resolve?q=<任意输入>` | 链接 / BV 号 / av 号 / b23 短链 → 规范化标识 |
| `GET /api/bili/batch?bvid=a,b` | 批量查询（最多 20 条，服务端并发；留给将来的批量填充） |
| `GET /api/healthz` | 健康检查 |

### 排障工具

后端的部署链路（Cloudflare 代理 → 家宽回源）出错时，报错信息往往很含糊
（522、526 之类）。这几个脚本能把中层环节逐段照出来，比在面板上猜快得多：

```bash
npm run port:check -- mc.tbpdt.top 9983            # 外网看端口通不通
npm run origin:check -- mc.tbpdt.top 9983 api2.tbpdt.top  # 模拟回源 + 测完整链路
npm run cert:check -- mc.tbpdt.top 9983 api2.tbpdt.top    # 读证书、核对 SAN 覆盖
npm run server:check -- https://api2.tbpdt.top     # 60 项接口自检
```

`cert:check` 尤其有用：526 报错时它能直接告诉你证书里**有没有**覆盖你的域名。
实测踩过的一个坑是——在 Cloudflare 的 **Client Certificates** 页面签出来的
是 mTLS 客户端证书，**天生没有 SAN**，于是 Full (strict) 下必然 526；
正确的入口是 **SSL/TLS → Origin Server → Origin Certificates**。

## 为什么需要一个后端

两件事都做不到纯前端：

1. **周刊接口**：`www.evocalrank.com` 的 JSON 接口**从不返回 `Access-Control-Allow-Origin`**。
   浏览器会直接丢弃整个响应——即使服务端返回了 200 与完整数据，JS 侧也只能看到
   `TypeError: Failed to fetch`，连状态码都读不到。注意这与"服务端是否校验来源"无关：
   实测该服务端并不看 `Origin` 头，问题纯在浏览器侧的读取授权。

2. **B 站接口**：它的 WAF 按**出口 IP** 判定。实测浏览器直连会被 `Origin` 检查挡成 403；
   经 Cloudflare Workers 转发后得到 **412**——逐个排除请求头差异（UA / Accept-Language /
   Sec-Fetch-* / 完全裸请求）后确认：住宅 IP 请求全部 200，Workers 请求 412，
   **差别只在出口 IP**，即 WAF 拒绝数据中心 IP，换任何 Serverless 都一样。

所以这一层必须跑在一台有住宅 IP 的机器上，也就顺理成章地把周刊查询一并接了过来
（早先周刊走 Cloudflare Worker，现已统一到这个后端）。

### B 站数据为什么能省下 98% 的流量

`/x/web-interface/view` 会在视频属于某个合集时**把整个合集塞进 `ugc_season`**——
拜年纪单品之类一条响应能到 118 KB，其中 113 KB 是合集展开。而本工具只需要
`data.stat` 里六个数字，因此服务端解析、裁剪后再返回，响应降到约 **226 字节**。

（注意上游客服把「评论」字段命名为 `reply` 而不是 `comment`，这个映射写错的话
界面会安静地填错数字。）

## 项目结构

```
src/
  calc/score.ts            计算内核（纯函数，无网络依赖）
  calc/scale.ts            对数刻度与进度条换算
  lib/api.ts               周刊取数层（永不抛异常 + 超时 + 降级）
  lib/biliApi.ts           B 站取数层
  lib/cachedFetch.ts       周刊数据缓存（Cache Storage）
  components/              界面组件（WeeklyRank 内含排名合并逻辑与测试）
  __fixtures__/            真实数据回归夹具（官网六期，共 180 条）
server/                    Go 后端（周刊查询 + B 站解析 + 缓存 + 限流）
  server.example.yaml      配置模板（真实配置 server.yaml 不入库）
  build.ps1 / build.sh     构建脚本（含交叉编译）
  vendor/                  唯一的依赖 yaml.v3（327 KB，故意入库 → 可离线构建）
scripts/verify-server.mjs  后端接口自检（60 项）
scripts/verify-elf.mjs     交叉编译产物校验（架构 + 静态链接）
scripts/verify-trim.mjs    裁剪字段与体积校验
scripts/check-port.mjs     外网端口可达性探测
scripts/check-origin-pull.mjs  模拟 Cloudflare 回源
scripts/inspect-cert.mjs   源站证书 SAN 核对
worker/index.js            早期的 Cloudflare Worker 实现（已停用，留作回退）
```

计算内核与网络完全解耦，因此可以独立测试。回归测试直接用官网六期榜单的真实数据
断言与官方 `point` 的相对偏差 < 1%（实测 180 条平均 0.0699%，最差 0.5051%），
防止公式被改坏。

> 这个偏差相对的是**官方发布的 `point`**；同类第三方工具之间的结果是一致的。
> 成因尚未定论，因此不在界面上向用户解释，也不在此处下结论。

**一个容易踩的坑**：周刊官网把榜单切成两段存放——`main_rank` 是第 1~30 名，
`second_rank` 是第 31~110 名，**两段合起来才是完整榜单**。只读前者会让所有得分
都被报在 30 名以内。

**另一个**：`av号 → BV号` 的换算在各处流传的参考实现里口径不一，`draft.md` 里的
Kotlin 版与早先那版 TypeScript 版都是错的，对 `av2` 给出 `BVc1147x1xmD`
（正确值是 `BV1xx411c7mD`）。它的输出依然"看起来像"合法 BV 号，所以错了很久没被发现。
现改用官方文档的实现，并用 B 站接口返回的 `bvid` 交叉验证。

## 数据来源

- 周刊榜单与得分：[周刊虚拟歌手中文曲排行榜](https://www.evocalrank.com/)
- 视频数据：[bilibili](https://www.bilibili.com/)

## License

MIT
