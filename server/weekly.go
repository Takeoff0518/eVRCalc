package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// 周刊上游（www.evocalrank.com）的转发与裁剪。
//
// 裁剪逻辑与原先的 Cloudflare Worker **逐字段等价** —— 前端的数据形状没有变，
// 所以前端搬家时只需要改 API 基地址，业务代码一行都不用动。
//
// 上游一份 latest.json 有 63.8 KB，其中大半用不到：
//   · referSource  约 116 字节/条 —— 与外部六个字段重复的同快照，纯冗余
//   · coverurl      约 60 字节/条 —— 界面不显示封面
//   · pubdate / share / ext_rank
//   · 整段 oth_pickup / thanks_list / statistic / ed / op 等 —— 一律不用
//
// 裁剪后降到约 24 KB。权衡：后端与前端的数据形状因此耦合，前端若要新字段，
// 需要同步改 VIDEO_FIELDS 并重启后端。

// VIDEO_FIELDS 是唯一的字段来源。前端要加字段时改这里。
var VIDEO_FIELDS = []string{
	"url", // 供排名区标题点击跳转
	"avid",
	"title",
	"point",
	"rank",
	"play",
	"like",
	"favorite",
	"coin",
	"comment",
	"danmaku",
}

// WeeklyVideo 是裁剪后的单条视频。
//
// 用 omitempty 而不是裸字段：上游缺哪个字段，输出里就少哪个键 ——
// 这与 Worker 里 `if (v?.[f] !== undefined) out[f] = v[f]` 的行为一致。
type WeeklyVideo struct {
	URL      string  `json:"url,omitempty"`
	Avid     string  `json:"avid,omitempty"`
	Title    string  `json:"title,omitempty"`
	Point    float64 `json:"point,omitempty"`
	Rank     int     `json:"rank,omitempty"`
	Play     int64   `json:"play,omitempty"`
	Like     int64   `json:"like,omitempty"`
	Favorite int64   `json:"favorite,omitempty"`
	Coin     int64   `json:"coin,omitempty"`
	Comment  int64   `json:"comment,omitempty"`
	Danmaku  int64   `json:"danmaku,omitempty"`
}

// WeeklyPeriod 是裁剪后的一份期刊数据。
//
// 重要：main_rank 是第 1~30 名，second_rank 是第 31~110 名，
// **两段合起来才是完整榜单**。漏掉第二段会把所有得分压在 30 名以内。
type WeeklyPeriod struct {
	Ranknum          int           `json:"ranknum"`
	GenerateTime     string        `json:"generate_time"`
	CollectStartTime string        `json:"collect_start_time"`
	CollectEndTime   string        `json:"collect_end_time"`
	MainRank         []WeeklyVideo `json:"main_rank"`
	SecondRank       []WeeklyVideo `json:"second_rank"`
	// 本工具自己加的字段：数据获取时间，便于前端标注新鲜度。
	// 前端不认识会直接忽略，不影响兼容。
	FetchedAt string `json:"fetched_at,omitempty"`
}

// RankListEntry 是期号目录条目。上游还有 url / coverurl / avid，前端不用。
type RankListEntry struct {
	RankNum string `json:"rank_num"`
}

type WeeklyInfo struct {
	GenerateTime string          `json:"generate_time,omitempty"`
	RankList     []RankListEntry `json:"rank_list"`
	FetchedAt    string          `json:"fetched_at,omitempty"`
}

// ── 裁剪 ─────────────────────────────────────────────────────────

func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", x)
	}
}

func asFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case json.Number:
		f, _ := x.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f
	default:
		return 0
	}
}

func asInt64(v any) int64 {
	switch x := v.(type) {
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		return n
	default:
		return 0
	}
}

func trimVideo(m map[string]any) WeeklyVideo {
	var v WeeklyVideo
	for _, f := range VIDEO_FIELDS {
		raw, exists := m[f]
		if !exists || raw == nil {
			continue
		}
		switch f {
		case "url":
			v.URL = asString(raw)
		case "avid":
			v.Avid = asString(raw)
		case "title":
			v.Title = asString(raw)
		case "point":
			v.Point = asFloat(raw)
		case "rank":
			v.Rank = int(asInt64(raw))
		case "play":
			v.Play = asInt64(raw)
		case "like":
			v.Like = asInt64(raw)
		case "favorite":
			v.Favorite = asInt64(raw)
		case "coin":
			v.Coin = asInt64(raw)
		case "comment":
			v.Comment = asInt64(raw)
		case "danmaku":
			v.Danmaku = asInt64(raw)
		}
	}
	return v
}

func trimVideoList(v any) []WeeklyVideo {
	arr, ok := v.([]any)
	out := make([]WeeklyVideo, 0, len(arr))
	if !ok {
		return out
	}
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, trimVideo(m))
	}
	return out
}

// trimPeriod 把上游期刊 JSON 裁成前端要的形状。
//
// 用 float64 解析数字（而不是 json.Number），是为了让大整数（如播放量 2489409）
// 不丢精度 —— float64 能精确表示到 2^53，播放量远小于这个数量级。
func trimPeriod(raw []byte, fetchedAt time.Time) ([]byte, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("期刊数据不是合法 JSON: %w", err)
	}

	p := WeeklyPeriod{
		Ranknum:          int(asInt64(m["ranknum"])),
		GenerateTime:     asString(m["generate_time"]),
		CollectStartTime: asString(m["collect_start_time"]),
		CollectEndTime:   asString(m["collect_end_time"]),
		MainRank:         trimVideoList(m["main_rank"]),
		SecondRank:       trimVideoList(m["second_rank"]),
		FetchedAt:        fetchedAt.UTC().Format(time.RFC3339),
	}
	return json.Marshal(p)
}

func trimInfo(raw []byte, fetchedAt time.Time) ([]byte, error) {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("期号目录不是合法 JSON: %w", err)
	}

	list := make([]RankListEntry, 0)
	if arr, ok := m["rank_list"].([]any); ok {
		for _, item := range arr {
			e, ok := item.(map[string]any)
			if !ok {
				continue
			}
			list = append(list, RankListEntry{RankNum: asString(e["rank_num"])})
		}
	}

	info := WeeklyInfo{
		GenerateTime: asString(m["generate_time"]),
		RankList:     list,
		FetchedAt:    fetchedAt.UTC().Format(time.RFC3339),
	}
	return json.Marshal(info)
}

// ── 上游取数 ─────────────────────────────────────────────────────

// upstreamFetcher 生成一个带 ETag 条件请求的 Fetcher。
//
// 上游只发 Etag / Last-Modified，**完全不发 Cache-Control**（实测），
// 所以条件请求是唯一能低成本确认「有没有出新期」的手段：
// 没变时上游回 304，省下 64 KB 传输。
func (s *Server) upstreamFetcher(url string) Fetcher {
	return func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, "", false, err
		}
		req.Header.Set("User-Agent", s.cfg.Upstream.UserAgent)
		req.Header.Set("Accept", "application/json, text/plain, */*")
		// 上游是静态站点，Referer 用自身即可
		req.Header.Set("Referer", s.cfg.Upstream.Weekly+"/")
		if prevETag != "" {
			req.Header.Set("If-None-Match", prevETag)
		}

		res, err := s.client.Do(req)
		if err != nil {
			return nil, "", false, err
		}
		defer res.Body.Close()

		if res.StatusCode == http.StatusNotModified {
			return nil, res.Header.Get("Etag"), true, nil
		}
		if res.StatusCode != http.StatusOK {
			return nil, "", false, fmt.Errorf("上游返回 HTTP %d", res.StatusCode)
		}

		body, err := readLimited(res.Body, maxUpstreamBytes)
		if err != nil {
			return nil, "", false, err
		}
		return body, res.Header.Get("Etag"), false, nil
	}
}

// ── HTTP 处理 ────────────────────────────────────────────────────

// weeklyTTL 决定某个期号该用多长的 TTL。
//
// 若只按 URL 分档会出错：新一期发布后 `rank_data/736.json` 第一次被请求时，
// 若直接按「历史期」给 24 小时，那它在 24 小时内不会更新 —— 而它其实还是当期
// 数据。所以拿最新期号比一次：离最新期不超过 rank_ttl_grace 的，一律按当期对待。
func (s *Server) weeklyTTL(periodNum int) time.Duration {
	latest, ok := s.latestPeriodNumber()
	if !ok {
		// 目录拿不到时，既不激进也不摆烂
		return time.Hour
	}
	if periodNum >= latest-s.gracePeriods() {
		return s.cfg.Cache.LatestTTL.D()
	}
	return s.cfg.Cache.RankTTL.D()
}

// gracePeriods 把 rank_ttl_grace 这个时长换算成「多少期」。
// 周刊一周一期，所以期数 = 天数。不足一天按 0 处理（只要最新一期）。
func (s *Server) gracePeriods() int {
	days := int(s.cfg.Cache.RankTTLGrace.D().Hours() / 24)
	if days < 0 {
		return 0
	}
	return days
}

// latestPeriodNumber 从（可能已缓存的）期号目录里取最新期号。
func (s *Server) latestPeriodNumber() (int, bool) {
	if data, _, _, ok := s.cache.Get(cacheKeyInfo); ok {
		var info WeeklyInfo
		if err := json.Unmarshal(data, &info); err == nil && len(info.RankList) > 0 {
			if n, err := strconv.Atoi(info.RankList[0].RankNum); err == nil {
				return n, true
			}
		}
	}

	// 缓存里没有 —— 直接打一次上游（不写入缓存，避免和正常路径抢）
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.Upstream.Timeout.D())
	defer cancel()
	data, _, _, err := s.upstreamFetcher(s.cfg.Upstream.Weekly+"/data/info/info.json")(ctx, "")
	if err != nil {
		return 0, false
	}
	trimmed, err := trimInfo(data, time.Now())
	if err != nil {
		return 0, false
	}
	var info WeeklyInfo
	if err := json.Unmarshal(trimmed, &info); err != nil || len(info.RankList) == 0 {
		return 0, false
	}
	n, err := strconv.Atoi(info.RankList[0].RankNum)
	return n, err == nil
}

func (s *Server) handleWeeklyInfo(w http.ResponseWriter, r *http.Request) {
	data, state, err := s.cache.GetOrFetch(
		cacheKeyInfo,
		s.cfg.Cache.InfoTTL.D(),
		0, // 目录必须新鲜：宁可报错也不要给过期期号
		func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
			return s.fetchAndTrim(ctx, s.cfg.Upstream.Weekly+"/data/info/info.json", prevETag, trimInfo)
		},
	)
	if err != nil {
		writeUpstreamError(w, r, err)
		return
	}
	s.writeJSONBytes(w, r, data, state, s.cfg.Cache.InfoTTL.D(), http.StatusOK)
}

func (s *Server) handleWeeklyLatest(w http.ResponseWriter, r *http.Request) {
	ttl := s.cfg.Cache.LatestTTL.D()
	data, state, err := s.cache.GetOrFetch(
		cacheKeyLatest,
		ttl,
		0,
		func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
			return s.fetchAndTrim(ctx, s.cfg.Upstream.Weekly+"/data/info/latest.json", prevETag, trimPeriod)
		},
	)
	if err != nil {
		writeUpstreamError(w, r, err)
		return
	}
	s.writeJSONBytes(w, r, data, state, ttl, http.StatusOK)
}

func (s *Server) handleWeeklyRank(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("n")
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || n <= 0 || n > 100000 {
		writeError(w, r, http.StatusBadRequest, "缺少或非法的 n 参数")
		return
	}

	// 严格数字校验，杜绝路径穿越（n 会拼进上游 URL）
	num := strconv.Itoa(n)
	key := cacheKeyRankPrefix + num
	ttl := s.weeklyTTL(n)

	data, state, err := s.cache.GetOrFetch(
		key,
		ttl,
		0,
		func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
			u := s.cfg.Upstream.Weekly + "/data/rank_data/" + num + ".json"
			return s.fetchAndTrim(ctx, u, prevETag, trimPeriod)
		},
	)
	if err != nil {
		writeUpstreamError(w, r, err)
		return
	}
	s.writeJSONBytes(w, r, data, state, ttl, http.StatusOK)
}

// fetchAndTrim 取上游 + 裁剪，是三条周刊路由共用的骨架。
func (s *Server) fetchAndTrim(
	ctx context.Context,
	url, prevETag string,
	trim func([]byte, time.Time) ([]byte, error),
) ([]byte, string, bool, error) {
	fetch := s.upstreamFetcher(url)
	data, etag, notModified, err := fetch(ctx, prevETag)
	if err != nil || notModified {
		return data, etag, notModified, err
	}

	trimmed, err := trim(data, time.Now())
	if err != nil {
		return nil, "", false, err
	}
	// 裁剪失败/空榜单时不要污染缓存
	if err := sanityCheckTrimmed(trimmed); err != nil {
		return nil, "", false, err
	}
	return trimmed, etag, false, nil
}

// sanityCheckTrimmed 防止把一份「看起来合法但实际为空」的数据写进缓存 ——
// 上游偶发返回空榜单时，缓存 24 小时会让前端长时间看不到榜单。
func sanityCheckTrimmed(trimmed []byte) error {
	var probe struct {
		Ranknum  *int             `json:"ranknum"`
		RankList *json.RawMessage `json:"rank_list"`
		MainRank *json.RawMessage `json:"main_rank"`
	}
	if err := json.Unmarshal(trimmed, &probe); err != nil {
		return err
	}
	switch {
	case probe.RankList != nil:
		var list []RankListEntry
		if err := json.Unmarshal(*probe.RankList, &list); err != nil {
			return err
		}
		if len(list) == 0 {
			return fmt.Errorf("上游返回了空的期号目录")
		}
	case probe.MainRank != nil:
		var main []WeeklyVideo
		if err := json.Unmarshal(*probe.MainRank, &main); err != nil {
			return err
		}
		if len(main) == 0 {
			return fmt.Errorf("上游返回了空的主榜")
		}
	}
	return nil
}

// ── 上游自检（供 --check 使用） ──────────────────────────────────

func (s *Server) CheckWeeklyUpstream(ctx context.Context) error {
	u, err := url.Parse(s.cfg.Upstream.Weekly + "/data/info/info.json")
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", s.cfg.Upstream.UserAgent)
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	if _, _, err := s.cache.GetOrFetch(cacheKeyInfo, s.cfg.Cache.InfoTTL.D(), 0,
		func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
			return s.fetchAndTrim(ctx, u.String(), prevETag, trimInfo)
		}); err != nil {
		return err
	}
	n, ok := s.latestPeriodNumber()
	if !ok {
		return fmt.Errorf("无法解析期号目录")
	}
	fmt.Printf("        最新期号 %d\n", n)
	return nil
}
