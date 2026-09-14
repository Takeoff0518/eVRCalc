package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// B 站（api.bilibili.com）的转发与解析。
//
// 为什么必须跑在家里：该接口的 WAF 按出口 IP 判定，实测 Cloudflare Workers
// 出口一律 412，而住宅 IP 无论带什么请求头都返回 200。所以这一层不可能放在
// 任何 serverless 上。
//
// 实测补充（本机 2026-09）：
//   · 不需要鉴权、不需要 wbi 签名（/x/web-interface/wbi/view 与 view 等价）
//   · 裸请求（无 UA、无 Referer）也能 200；真正被拒的是带非 bilibili 的 Origin
//   · view 接口会把整个合集塞进 ugc_season —— 一条视频的响应可达 128 KB，
//     而我们要的只是 data.stat 里的六个数字，所以必须服务端裁剪

// ── 标识解析 ─────────────────────────────────────────────────────

// BiliRef 是用户输入解析后的规范化标识。
type BiliRef struct {
	Raw   string `json:"raw"`
	Bvid  string `json:"bvid,omitempty"`
	Aid   string `json:"aid,omitempty"`
	Kind  string `json:"kind"`
	Title string `json:"title,omitempty"`
}

// 注意：BV_RE 没有捕获组，BV_QUERY_RE 有 —— 取值时统一用 m[1] ?? m[0]。
// 这是移植前一份 TypeScript 实现时踩过的坑，保留注释以免重犯。
var (
	bvRe     = regexp.MustCompile(`BV[0-9A-Za-z]{10}`)
	bvOnlyRe = regexp.MustCompile(`^BV[0-9A-Za-z]{10}$`)
	avRe     = regexp.MustCompile(`(?i)av(\d+)`)
	avOnlyRe = regexp.MustCompile(`(?i)^av(\d+)$`)
	numRe    = regexp.MustCompile(`^\d{4,}$`)
	aidQRe   = regexp.MustCompile(`(?i)[?&]aid=(\d+)`)
	bvidQRe  = regexp.MustCompile(`(?i)[?&]bvid=(BV[0-9A-Za-z]{10})`)
	b23Re    = regexp.MustCompile(`(?i)^(https?://)?b23\.tv/`)
	bvidFmt  = regexp.MustCompile(`^BV[0-9A-Za-z]{10}$`)
	aidFmt   = regexp.MustCompile(`^\d{1,20}$`)
	// 从一段文字里找链接：B 站 App 的「复制链接」会把标题一起复制过来，
	// 所以必须在一整段文字里找，不能只当"整段就是一个链接"去解析。
	// 域名部分故意写得宽松（什么域名都先匹配上），可信与否交给 hostAllowed，
	// 免得把「哪些域名算数」写死在正则里、日后改白名单时忘了同步。
	linkRe = regexp.MustCompile(`(?i)(?:https?://)?(?:[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:/[^\s"'<>()\[\]{}，。、；：！？（）【】《》「」]*)?`)
)

// firstGroup 模拟 JS 的 `m[1] ?? m[0]`
func firstGroup(m []string) string {
	if len(m) == 0 {
		return ""
	}
	if len(m) > 1 && m[1] != "" {
		return m[1]
	}
	return m[0]
}

// ParseBiliRef 解析任意输入：BV 号 / av 号 / 纯数字 / 完整链接 / 短链，
// 以及「标题 + 空格 + 链接」这种直接从 B 站 App 复制出来的分享文案。
// 短链在此**不**做网络解析，只标记 kind=shortlink，由调用方决定是否跟跳。
func ParseBiliRef(input string) BiliRef {
	raw := strings.TrimSpace(input)
	if raw == "" {
		return BiliRef{Kind: "invalid"}
	}

	if bvOnlyRe.MatchString(raw) {
		return BiliRef{Raw: raw, Bvid: raw, Kind: "bvid"}
	}

	if m := avOnlyRe.FindStringSubmatch(raw); m != nil {
		return BiliRef{Raw: raw, Aid: m[1], Kind: "avid"}
	}

	if numRe.MatchString(raw) {
		return BiliRef{Raw: raw, Aid: raw, Kind: "avid"}
	}

	// 输入本身就是短链时在这里收口；链接混在文字里（"标题 https://b23.tv/x"）
	// 则由下面的循环接住。两处都依赖 b23Re 不锚定串首 —— 一旦把 ^ 加回去，
	// 「https://b23.tv/xxx」就会漏判成普通链接，进而被当成无法识别。
	if b23Re.MatchString(raw) {
		return BiliRef{Raw: raw, Kind: "shortlink"}
	}

	// 输入里带链接时，**只认可信域名的那个链接**；同一段文字里混进来的其他
	// 域名一概不看。这样既拦得住 https://evil.example/watch/BV1JHZNBdEQv，
	// 也认得 B 站 App「复制链接」那种「标题 + 空格 + 真链接」的形态。
	for _, candidate := range linkRe.FindAllString(raw, -1) {
		link, ok := prettyLink(candidate)
		if !ok {
			continue
		}
		u, err := url.Parse(link)
		if err != nil || u.Host == "" || !hostAllowed(u.Host) {
			continue // 不可信的候选直接丢弃，绝不让它借道
		}
		if b23Re.MatchString(link) {
			// 短链要做网络跟跳，交给调用方决定
			return BiliRef{Raw: raw, Kind: "shortlink"}
		}
		if ref, ok := refFromURL(link); ok {
			ref.Raw = raw
			return ref
		}
	}

	inputIsURL := looksLikeURL(raw)
	if inputIsURL {
		// 是链接但不是 B 站域名 —— 到这儿为止，不做兜底提取
		return BiliRef{Raw: raw, Kind: "invalid"}
	}

	// 兜底：纯文本输入里任意位置出现 BV / av
	if m := bvRe.FindString(raw); m != "" {
		return BiliRef{Raw: raw, Bvid: m, Kind: "bvid"}
	}
	if m := avRe.FindStringSubmatch(raw); m != nil {
		return BiliRef{Raw: raw, Aid: m[1], Kind: "avid"}
	}

	return BiliRef{Raw: raw, Kind: "invalid"}
}

// prettyLink 把正则匹配到的一小段整理成可解析的 URL。
//
// 只接受 http/https：其他 scheme 的直接判否，走不到后面那步，
// 于是 ftp://bilibili.com/BV... 这类输入仍会被 looksLikeURL 拦下。
func prettyLink(candidate string) (string, bool) {
	if strings.Contains(candidate, "://") {
		if !strings.HasPrefix(strings.ToLower(candidate), "http://") &&
			!strings.HasPrefix(strings.ToLower(candidate), "https://") {
			return "", false
		}
		return candidate, true
	}
	// 裸域名（"www.bilibili.com/video/BV..."）：补上 scheme 再解析
	return "https://" + candidate, true
}

// refFromURL 从链接里取标识，只看 path 与 query（域名已由调用方校验）。
func refFromURL(rawURL string) (BiliRef, bool) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return BiliRef{}, false
	}

	pathAndQuery := u.Path
	if u.RawQuery != "" {
		pathAndQuery += "?" + u.RawQuery
	}

	if m := bvRe.FindStringSubmatch(pathAndQuery); m != nil {
		return BiliRef{Bvid: m[0], Kind: "url-bvid"}, true
	}
	if m := bvidQRe.FindStringSubmatch(pathAndQuery); m != nil {
		return BiliRef{Bvid: firstGroup(m), Kind: "url-bvid"}, true
	}
	if m := avRe.FindStringSubmatch(pathAndQuery); m != nil {
		return BiliRef{Aid: firstGroup(m), Kind: "url-avid"}, true
	}
	if m := aidQRe.FindStringSubmatch(pathAndQuery); m != nil {
		return BiliRef{Aid: firstGroup(m), Kind: "url-avid"}, true
	}
	return BiliRef{}, false
}

// looksLikeURL 判断输入是否"本来就是链接"（而非一段随手粘贴的文本）。
//
// 只用于一件事：输入里**没能**解析出 B 站标识时，决定这个"不认识的链接"
// 是被拒绝（不留把任意站点当跳板的余地），还是当普通文字再兜底扫一遍 BV 号。
//
// 判定规则刻意保守：只有出现 "://"，或「第一个斜杠之前那一小段像个域名」
// 才算链接。这样 https://evil.example/watch/BV1... 会被拦住，
// 而 "看看这个 BV1JHZNBdEQv 挺好的" 仍按文本处理。
func looksLikeURL(raw string) bool {
	if strings.Contains(raw, "://") {
		return true
	}
	head, _, found := strings.Cut(raw, "/")
	if !found || strings.ContainsAny(head, " \t") || !strings.Contains(head, ".") {
		return false
	}
	// head 必须整体像个 host（字母数字、点、连字符、可选端口）
	for _, r := range head {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') ||
			r == '.' || r == '-' || r == ':' || r == '_' {
			continue
		}
		return false
	}
	return true
}

// ── av 号 → BV 号 ────────────────────────────────────────────────

const (
	bvXorCode = 23442827791579
	// 注意是 2^51 - 1，不是 1<<51。差这一个 1 会让输出的 BV 号整体错位。
	bvMaxCode = 2251799813685247
	bvPaulNum = 58
	bvCharts  = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf"
)

// AvToBv 把 av 号转成 BV 号。
//
// ── 实现来源与踩过的坑（务必保留）──────────────────────────────────
// 这段算法在各处流传的版本口径不一，而且**错法很隐蔽**：输出依然是 10 个
// 字符、看起来完全像一个合法 BV 号，只是永远对应不到正确的视频。
//
// draft.md 里的 Kotlin 参考与早先那版 TypeScript 实现都是错的；我按它们改出来的
// Go 版本对 av2 给出 BVc1147x1xmD，而正确值是 BV1xx411c7mD。
//
// 最终采用 bilibili-API-collect 官方文档里的 Golang 实现
// （docs/misc/bvid_desc.md，PR #1027），三处关键细节：
//  1. MAX_CODE = 2^51 - 1 = 2251799813685247，不是 1<<51
//  2. 用 [12]string{"B","V","1"} 承载，从 arr[11] **倒着填**，
//     迭代次数由循环决定，因此位数天然保留（不会多填也不会少填）
//  3. 两次交换 swap(3,9)、swap(4,7) 作用在**含 "BV" 前缀的整个数组**上，
//     而不是只作用在数字部分
//
// 正确性由 TestAvToBvOfficialDocsExample（官方文档样例
// av1054803170 → BV1mH4y1u7UA）、TestAvToBvMatchesOfficialSample 与
// TestAvToBvAgainstLiveBilibili（拿 B 站返回的 bvid 交叉验证）共同锁定。
func AvToBv(avID string) string {
	digits := strings.TrimSpace(avID)
	if m := avOnlyRe.FindStringSubmatch(digits); m != nil {
		digits = m[1]
	} else if digits == "" {
		return ""
	}

	for _, c := range digits {
		if c < '0' || c > '9' {
			return ""
		}
	}

	aid, ok := new(big.Int).SetString(digits, 10)
	if !ok {
		return ""
	}
	// 超出 BV 号可表示范围（aid >= 2^51）时无对应 BV 号
	if aid.Cmp(big.NewInt(1<<51)) >= 0 {
		return ""
	}

	// temp = (aid | (MAX_CODE + 1)) ^ XOR_CODE
	tmp := new(big.Int).Or(aid, big.NewInt(bvMaxCode+1))
	tmp.Xor(tmp, big.NewInt(bvXorCode))

	// 用 12 个槽位承载，从最右端倒着填 base-58 各位
	arr := make([]byte, 12)
	copy(arr, "BV1")
	idx := len(arr) - 1
	base := big.NewInt(bvPaulNum)
	mod := new(big.Int)
	for tmp.Sign() > 0 {
		tmp.DivMod(tmp, base, mod)
		arr[idx] = bvCharts[mod.Int64()]
		idx--
	}
	if idx < 0 {
		return ""
	}

	// 两次交换作用在整个数组上
	arr[3], arr[9] = arr[9], arr[3]
	arr[4], arr[7] = arr[7], arr[4]

	return string(arr)
}

// ── 上游调用 ─────────────────────────────────────────────────────

// biliViewData 只取我们需要的部分。其余（ugc_season / pages / desc / owner…）
// 一概不解析 —— 这正是省下 99% 流量的关键。
type biliViewData struct {
	Bvid  string `json:"bvid"`
	Aid   int64  `json:"aid"`
	Cid   int64  `json:"cid"`
	Title string `json:"title"`
	Stat  struct {
		View     int64 `json:"view"`     // 播放
		Danmaku  int64 `json:"danmaku"`  // 弹幕
		Reply    int64 `json:"reply"`    // 评论（注意上游叫 reply，不是 comment）
		Favorite int64 `json:"favorite"` // 收藏
		Coin     int64 `json:"coin"`     // 硬币
		Like     int64 `json:"like"`     // 点赞
		Share    int64 `json:"share"`
	} `json:"stat"`
}

type biliResponse struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

// fetchBiliView 调用 view 接口并做条件检查。
func (s *Server) fetchBiliView(ctx context.Context, ref BiliRef) (*biliViewData, error) {
	q := url.Values{}
	switch {
	case ref.Bvid != "":
		q.Set("bvid", ref.Bvid)
	case ref.Aid != "":
		q.Set("aid", ref.Aid)
	default:
		return nil, errBadRequest("缺少 bvid 或 aid")
	}

	endpoint := s.cfg.Upstream.Bilibili + "/x/web-interface/view?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", s.cfg.Upstream.UserAgent)
	req.Header.Set("Referer", "https://www.bilibili.com/")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	// 刻意不设置 Origin —— 带非 bilibili 的 Origin 会被 WAF 直接 403

	res, err := s.client.Do(req)
	if err != nil {
		return nil, errUpstream(err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		switch res.StatusCode {
		case http.StatusPreconditionFailed:
			return nil, errUpstream(fmt.Errorf("B 站风控拒绝了本次请求（HTTP 412）。" +
				"若长期如此，说明当前出口 IP 已被判定为机房 IP"))
		case http.StatusForbidden:
			return nil, errUpstream(fmt.Errorf("B 站返回 403"))
		}
		return nil, errUpstream(fmt.Errorf("上游返回 HTTP %d", res.StatusCode))
	}

	body, err := readLimited(res.Body, maxUpstreamBytes)
	if err != nil {
		return nil, errUpstream(err)
	}

	var parsed biliResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, errUpstream(fmt.Errorf("上游返回的不是合法 JSON: %w", err))
	}
	if parsed.Code != 0 {
		return nil, errUpstream(fmt.Errorf("B 站返回错误 %d: %s", parsed.Code, parsed.Message))
	}

	var data biliViewData
	if err := json.Unmarshal(parsed.Data, &data); err != nil {
		return nil, errUpstream(fmt.Errorf("解析 B 站数据失败: %w", err))
	}
	return &data, nil
}

// biliStats 是返回给前端的形状。字段名刻意与前端表单一致，
// 避免前端再做一次「reply → comment」的翻译。
type biliStats struct {
	Bvid      string `json:"bvid"`
	Aid       int64  `json:"aid"`
	Title     string `json:"title"`
	FetchedAt string `json:"fetchedAt"`
	Cache     string `json:"cache"` // fresh / stale / fetched
	Play      int64  `json:"play"`
	Like      int64  `json:"like"`
	Favorite  int64  `json:"favorite"`
	Coin      int64  `json:"coin"`
	Comment   int64  `json:"comment"`
	Danmaku   int64  `json:"danmaku"`
}

// ── HTTP 处理 ────────────────────────────────────────────────────

var (
	errBadRequest = func(msg string) error { return &apiError{status: http.StatusBadRequest, msg: msg} }
	errUpstream   = func(err error) error { return &apiError{status: http.StatusBadGateway, err: err} }
	errNotFound   = func(msg string) error { return &apiError{status: http.StatusNotFound, msg: msg} }
)

type apiError struct {
	status int
	msg    string
	err    error
}

func (e *apiError) Error() string {
	if e.msg != "" {
		return e.msg
	}
	if e.err != nil {
		return e.err.Error()
	}
	return "未知错误"
}
func (e *apiError) Unwrap() error { return e.err }

func writeAPIError(w http.ResponseWriter, r *http.Request, err error) {
	if ae, ok := err.(*apiError); ok {
		writeError(w, r, ae.status, ae.Error())
		return
	}
	writeError(w, r, http.StatusBadGateway, err.Error())
}

// refFromQuery 从查询参数里取标识。允许直接传 bvid / aid / q（任意输入）。
func refFromQuery(r *http.Request) (BiliRef, error) {
	q := r.URL.Query()
	if raw := strings.TrimSpace(q.Get("q")); raw != "" {
		return ParseBiliRef(raw), nil
	}
	if bv := strings.TrimSpace(q.Get("bvid")); bv != "" {
		if !bvidFmt.MatchString(bv) {
			return BiliRef{}, errBadRequest("bvid 格式不对，应形如 BV1JHZNBdEQv")
		}
		return BiliRef{Raw: bv, Bvid: bv, Kind: "bvid"}, nil
	}
	if aid := strings.TrimSpace(q.Get("aid")); aid != "" {
		// 容忍 "av117..." 形态：周刊数据里的 avid 字段就带 av 前缀，
		// 前端直接透传时不该被拒。
		if m := avOnlyRe.FindStringSubmatch(aid); m != nil {
			aid = m[1]
		}
		if !aidFmt.MatchString(aid) {
			return BiliRef{}, errBadRequest("aid 必须是纯数字（可带 av 前缀）")
		}
		return BiliRef{Raw: aid, Aid: aid, Kind: "avid"}, nil
	}
	return BiliRef{}, errBadRequest("缺少参数：请提供 bvid、aid 或 q")
}

// normalizeRef 补齐 BV/av 互转，让缓存键与上游参数统一。
func normalizeRef(ref BiliRef) BiliRef {
	if ref.Bvid == "" && ref.Aid != "" {
		if bv := AvToBv(ref.Aid); bv != "" {
			ref.Bvid = bv
		}
	}
	return ref
}

func (s *Server) statsFor(ctx context.Context, ref BiliRef) (biliStats, error) {
	ref = normalizeRef(ref)
	if ref.Bvid == "" && ref.Aid == "" {
		return biliStats{}, errBadRequest("无法识别的视频标识")
	}
	key := cacheKeyBiliPrefix + ref.Bvid
	if ref.Bvid == "" {
		key = cacheKeyBiliPrefix + "av" + ref.Aid
	}

	data, state, err := s.cache.GetOrFetch(key, s.cfg.Cache.BiliTTL.D(), s.cfg.Cache.BiliStaleTTL.D(),
		func(ctx context.Context, _ string) ([]byte, string, bool, error) {
			// 故意绕过 fetchAndTrim 的 ETag 逻辑：B 站没有 ETag，
			// 每次都要真取一次（TTL 由缓存层负责）
			view, err := s.fetchBiliView(ctx, ref)
			if err != nil {
				return nil, "", false, err
			}
			out := biliStats{
				Bvid:     view.Bvid,
				Aid:      view.Aid,
				Title:    view.Title,
				Play:     view.Stat.View,
				Like:     view.Stat.Like,
				Favorite: view.Stat.Favorite,
				Coin:     view.Stat.Coin,
				Comment:  view.Stat.Reply,
				Danmaku:  view.Stat.Danmaku,
			}
			body, err := json.Marshal(out)
			return body, "", false, err
		})
	if err != nil {
		return biliStats{}, err
	}

	var out biliStats
	if err := json.Unmarshal(data, &out); err != nil {
		return biliStats{}, errUpstream(fmt.Errorf("缓存数据损坏: %w", err))
	}
	if fetchedAt, ok := s.cache.FetchedAt(key); ok {
		out.FetchedAt = fetchedAt.UTC().Format(time.RFC3339)
	}
	out.Cache = string(state)
	return out, nil
}

// handleBiliStats 查询单条视频的六项数据。
func (s *Server) handleBiliStats(w http.ResponseWriter, r *http.Request) {
	ref, err := refFromQuery(r)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	// 短链要先跟跳拿到真实标识
	if ref.Kind == "shortlink" {
		ref, err = s.resolveShortlink(r.Context(), ref.Raw)
		if err != nil {
			writeAPIError(w, r, err)
			return
		}
	}
	if ref.Bvid == "" && ref.Aid == "" {
		writeAPIError(w, r, errBadRequest("无法从输入中识别出视频"))
		return
	}

	stats, err := s.statsFor(r.Context(), ref)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	// 回吐旧数据时必须如实标注，别让用户以为这是刚取的
	if stats.Cache == string(StateStale) {
		w.Header().Set("X-EvRCalc-Stale", "1")
		w.Header().Set("Cache-Control", "no-store")
	}
	writeJSON(w, r, http.StatusOK, stats)
}

// handleBiliBatch 一次查询多条，最多 maxBatch 条。
//
// 存在的理由：排行榜有 110 条，若将来要做「整榜取数」，
// 逐条请求会瞬间打爆限流。批量接口在服务端并发取数并复用缓存。
func (s *Server) handleBiliBatch(w http.ResponseWriter, r *http.Request) {
	const maxBatch = 20

	q := r.URL.Query()
	var refs []BiliRef
	for _, part := range strings.Split(q.Get("bvid"), ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !bvidFmt.MatchString(part) {
			writeAPIError(w, r, errBadRequest("bvid 格式不对："+part))
			return
		}
		refs = append(refs, BiliRef{Raw: part, Bvid: part, Kind: "bvid"})
	}
	for _, part := range strings.Split(q.Get("aid"), ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !aidFmt.MatchString(part) {
			writeAPIError(w, r, errBadRequest("aid 必须是纯数字："+part))
			return
		}
		refs = append(refs, BiliRef{Raw: part, Aid: part, Kind: "avid"})
	}

	if len(refs) == 0 {
		writeAPIError(w, r, errBadRequest("缺少参数：bvid 或 aid（逗号分隔）"))
		return
	}
	if len(refs) > maxBatch {
		writeAPIError(w, r, errBadRequest(fmt.Sprintf("一次最多查询 %d 条，收到 %d 条", maxBatch, len(refs))))
		return
	}

	type item struct {
		OK    bool       `json:"ok"`
		Error string     `json:"error,omitempty"`
		Stats *biliStats `json:"stats,omitempty"`
	}
	results := make([]item, len(refs))
	done := make(chan int, len(refs))

	for i, ref := range refs {
		go func(i int, ref BiliRef) {
			defer func() {
				if rec := recover(); rec != nil {
					results[i] = item{Error: "内部错误"}
				}
				done <- i
			}()
			stats, err := s.statsFor(r.Context(), ref)
			if err != nil {
				results[i] = item{Error: err.Error()}
				return
			}
			results[i] = item{OK: true, Stats: &stats}
		}(i, ref)
	}
	for range refs {
		<-done
	}

	failed := 0
	for _, it := range results {
		if !it.OK {
			failed++
		}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"count":   len(results),
		"failed":  failed,
		"results": results,
	})
}

// handleBiliResolve 只做标识解析，不取数据。供前端「粘贴链接」输入框使用。
func (s *Server) handleBiliResolve(w http.ResponseWriter, r *http.Request) {
	raw := strings.TrimSpace(r.URL.Query().Get("q"))
	if raw == "" {
		writeAPIError(w, r, errBadRequest("缺少参数 q"))
		return
	}

	ref := ParseBiliRef(raw)
	if ref.Kind == "shortlink" {
		resolved, err := s.resolveShortlink(r.Context(), raw)
		if err != nil {
			writeAPIError(w, r, err)
			return
		}
		ref = resolved
	}

	ref = normalizeRef(ref)
	if ref.Bvid == "" && ref.Aid == "" {
		writeAPIError(w, r, errNotFound("无法从输入中识别出 BV 号或 av 号"))
		return
	}
	writeJSON(w, r, http.StatusOK, ref)
}

// ── 短链跟跳（必须防 SSRF）──────────────────────────────────────

// allowedBiliHosts 是允许跟跳到的域名。b23.tv 短链最终会落在 bilibili.com，
// 但**不能因此就信任它的 Location** —— 否则这个接口会变成任意 URL 的
// SSRF 跳板（内网探测、云元数据端点等）。
var allowedBiliHosts = []string{
	"bilibili.com",
	"b23.tv",
	"biligame.com",
}

func hostAllowed(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	for _, allowed := range allowedBiliHosts {
		if host == allowed || strings.HasSuffix(host, "."+allowed) {
			return true
		}
	}
	return false
}

// resolveShortlink 跟跳 b23.tv 短链，逐跳校验域名。
func (s *Server) resolveShortlink(ctx context.Context, raw string) (BiliRef, error) {
	target := raw
	if !strings.Contains(target, "://") {
		target = "https://" + target
	}

	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	client := &http.Client{
		Timeout: 6 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// 交给我们自己逐跳处理
			return http.ErrUseLastResponse
		},
	}

	for hop := 0; hop < 5; hop++ {
		u, err := url.Parse(target)
		if err != nil {
			return BiliRef{}, errBadRequest("短链格式非法")
		}
		if !hostAllowed(u.Host) {
			return BiliRef{}, errBadRequest("短链指向了非 B 站域名，已拒绝：" + u.Host)
		}

		// 已经到了真正的视频地址，直接解析
		if ref := ParseBiliRef(target); ref.Bvid != "" || ref.Aid != "" {
			ref.Raw = raw
			if ref.Kind == "shortlink" {
				ref.Kind = "url-bvid"
			}
			return ref, nil
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return BiliRef{}, errBadRequest("短链请求构造失败")
		}
		req.Header.Set("User-Agent", s.cfg.Upstream.UserAgent)

		res, err := client.Do(req)
		if err != nil {
			return BiliRef{}, errUpstream(fmt.Errorf("短链解析失败: %w", err))
		}
		loc := res.Header.Get("Location")
		_ = res.Body.Close()

		if res.StatusCode < 300 || res.StatusCode >= 400 || loc == "" {
			return BiliRef{}, errNotFound("短链没有指向有效的视频地址")
		}

		next, err := u.Parse(loc)
		if err != nil {
			return BiliRef{}, errNotFound("短链跳转地址非法")
		}
		if !hostAllowed(next.Host) {
			return BiliRef{}, errBadRequest("短链跳转到了非 B 站域名，已拒绝：" + next.Host)
		}
		target = next.String()
	}

	return BiliRef{}, errNotFound("短链跳转次数过多")
}

// CheckBiliUpstream 供 --check 使用：探一条已知视频确认出口 IP 没被风控。
func (s *Server) CheckBiliUpstream(ctx context.Context) error {
	// 用周刊最新期榜首那条，避免硬编码一个可能被删的视频
	var probe BiliRef
	if n, ok := s.latestPeriodNumber(); ok {
		data, _, _, ok := s.cache.Get(cacheKeyRankPrefix + strconv.Itoa(n))
		if !ok {
			if d, _, err := s.cache.GetOrFetch(cacheKeyRankPrefix+strconv.Itoa(n), time.Hour, 0,
				func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
					return s.fetchAndTrim(ctx, s.cfg.Upstream.Weekly+"/data/rank_data/"+strconv.Itoa(n)+".json", prevETag, trimPeriod)
				}); err == nil {
				data = d
			}
		}
		var p WeeklyPeriod
		if json.Unmarshal(data, &p) == nil && len(p.MainRank) > 0 {
			probe = ParseBiliRef(p.MainRank[0].Avid)
		}
	}
	if probe.Bvid == "" && probe.Aid == "" {
		probe = BiliRef{Raw: "av2", Aid: "2", Kind: "avid"}
	}

	view, err := s.fetchBiliView(ctx, probe)
	if err != nil {
		return err
	}
	fmt.Printf("        探针 %s → %s（播放 %d）\n", probe.Bvid+probe.Aid, view.Title, view.Stat.View)
	return nil
}
