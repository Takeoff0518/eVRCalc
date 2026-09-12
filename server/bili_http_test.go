package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ── 客户端 IP 判定（限流的根基）──────────────────────────────────

// 这是整个限流里最要紧的一条：**只有请求确实来自可信代理时**才能读
// CF-Connecting-IP。否则任何人加一个请求头就能伪造 IP、绕过限流。
func TestClientIPIgnoresForgedHeaderWhenNoTrustedProxy(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.9:12345"
	req.Header.Set("CF-Connecting-IP", "1.2.3.4") // 伪造

	got := clientIP(req, nil, "CF-Connecting-IP")
	if got != "203.0.113.9" {
		t.Errorf("无可信代理时应使用 TCP 对端地址，实际 %q（伪造头生效了！）", got)
	}
}

func TestClientIPTrustsHeaderFromTrustedProxy(t *testing.T) {
	matcher, err := buildIPMatcher([]string{"cloudflare"})
	if err != nil {
		t.Fatal(err)
	}

	// 来自 Cloudflare 网段（104.16.0.0/13 内）
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "104.16.1.1:443"
	req.Header.Set("CF-Connecting-IP", "198.51.100.7")

	got := clientIP(req, matcher, "CF-Connecting-IP")
	if got != "198.51.100.7" {
		t.Errorf("可信代理转发的真实 IP 应被采用，实际 %q", got)
	}
}

func TestClientIPIgnoresHeaderFromUntrustedSource(t *testing.T) {
	matcher, err := buildIPMatcher([]string{"cloudflare"})
	if err != nil {
		t.Fatal(err)
	}

	// 伪造者不在 Cloudflare 网段内 —— 头必须被忽略
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "198.51.100.7:5555"
	req.Header.Set("CF-Connecting-IP", "10.0.0.1")

	got := clientIP(req, matcher, "CF-Connecting-IP")
	if got != "198.51.100.7" {
		t.Errorf("不可信来源的转发头必须被忽略，实际 %q", got)
	}
}

func TestClientIPHandlesHeaderChain(t *testing.T) {
	matcher, _ := buildIPMatcher([]string{"cloudflare"})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "104.16.1.1:443"
	req.Header.Set("CF-Connecting-IP", "198.51.100.7, 10.0.0.1")

	if got := clientIP(req, matcher, "CF-Connecting-IP"); got != "198.51.100.7" {
		t.Errorf("逗号分隔时应取第一个，实际 %q", got)
	}
}

func TestBuildIPMatcherRejectsGarbage(t *testing.T) {
	if _, err := buildIPMatcher([]string{"不是网段"}); err == nil {
		t.Error("无法识别的条目应报错，而不是被静默忽略")
	}
	if _, err := buildIPMatcher([]string{"cloudflare", "loopback", "10.1.2.0/24", "192.0.2.5"}); err != nil {
		t.Errorf("合法组合不应报错: %v", err)
	}

	// loopback 关键字
	m, _ := buildIPMatcher([]string{"loopback"})
	if !m.Contains(mustIP(t, "127.0.0.1")) {
		t.Error("loopback 应包含 127.0.0.1")
	}
	if m.Contains(mustIP(t, "8.8.8.8")) {
		t.Error("loopback 不应包含公网地址")
	}

	// 单个 IP 带掩码化
	m2, _ := buildIPMatcher([]string{"192.0.2.5"})
	if !m2.Contains(mustIP(t, "192.0.2.5")) {
		t.Error("单个 IP 应被正确识别")
	}
	if m2.Contains(mustIP(t, "192.0.2.6")) {
		t.Error("单个 IP 不应匹配邻居")
	}
}

// ── B 站端点 ─────────────────────────────────────────────────────

// newBiliUpstream 造一个假 B 站上游：view 接口返回带 ugc_season 的胖响应，
// 用来验证我们**确实只取六个数字**并且裁掉了合集。
func newBiliUpstream(t *testing.T, code int, message string) (*httptest.Server, *int) {
	t.Helper()
	var hits int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if code != 0 {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "message": message})
			return
		}
		// 故意塞一大段没用的字段，模拟真实的 ugc_season 膨胀
		bloat := strings.Repeat("x", 50000)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code":    0,
			"message": "OK",
			"data": map[string]any{
				"bvid":       "BV1JHZNBdEQv",
				"aid":        116078873153625,
				"cid":        36098672988,
				"title":      "LIFE TRAIN(ライフトレイン)",
				"desc":       bloat,
				"ugc_season": map[string]any{"bloat": bloat},
				"pages":      []any{map[string]any{"cid": 1}},
				"stat": map[string]any{
					"view":     370400,
					"danmaku":  203,
					"reply":    774,
					"favorite": 12675,
					"coin":     3063,
					"like":     25057,
					"share":    421,
				},
			},
		})
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func TestBiliStatsMapsFieldsCorrectly(t *testing.T) {
	upstream, hits := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/stats?bvid=BV1JHZNBdEQv", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d，body=%s", rec.Code, rec.Body.String())
	}

	var stats biliStats
	if err := json.Unmarshal(rec.Body.Bytes(), &stats); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}

	// 六项数值必须一一对应。特别是 comment ← 上游的 reply，
	// 这个映射写错的话界面会安静地填错数字。
	if stats.Play != 370400 {
		t.Errorf("播放应为 370400，实际 %d", stats.Play)
	}
	if stats.Comment != 774 {
		t.Errorf("评论应取自上游 reply=774，实际 %d", stats.Comment)
	}
	if stats.Danmaku != 203 {
		t.Errorf("弹幕应为 203，实际 %d", stats.Danmaku)
	}
	if stats.Favorite != 12675 {
		t.Errorf("收藏应为 12675，实际 %d", stats.Favorite)
	}
	if stats.Coin != 3063 {
		t.Errorf("硬币应为 3063，实际 %d", stats.Coin)
	}
	if stats.Like != 25057 {
		t.Errorf("点赞应为 25057，实际 %d", stats.Like)
	}
	if stats.Bvid != "BV1JHZNBdEQv" || stats.Aid != 116078873153625 {
		t.Errorf("标识不对: %s / %d", stats.Bvid, stats.Aid)
	}
	if stats.FetchedAt == "" {
		t.Error("应带上取数时间，供界面标注数据新鲜度")
	}
	if stats.Cache == "" {
		t.Error("应标注数据来自缓存还是上游")
	}

	// 响应必须远小于上游的胖响应
	if rec.Body.Len() > 2000 {
		t.Errorf("裁剪后响应仍高达 %d 字节，白名单可能没生效", rec.Body.Len())
	}
	// 上游只应被调用一次
	if *hits != 1 {
		t.Errorf("上游应被调用 1 次，实际 %d", *hits)
	}
}

// aid 查询应当被补成 BV 号（缓存键统一），并且带回正确的 bvid。
func TestBiliStatsByAidNormalizesToBvid(t *testing.T) {
	upstream, _ := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/stats?aid=116078873153625", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d", rec.Code)
	}
	var stats biliStats
	_ = json.Unmarshal(rec.Body.Bytes(), &stats)
	if stats.Bvid != "BV1JHZNBdEQv" {
		t.Errorf("aid 查询应补出 BV 号，实际 %q", stats.Bvid)
	}
}

// B 站返回业务错误码时应转成 502 并把原因带出来，而不是返回一堆 0。
func TestBiliStatsSurfacesUpstreamErrorCode(t *testing.T) {
	upstream, _ := newBiliUpstream(t, -404, "啥都木有")
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/stats?bvid=BV1JHZNBdEQv", nil))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("上游业务错误应转成 502，实际 %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "啥都木有") {
		t.Errorf("错误信息应包含上游 message，实际 %s", rec.Body.String())
	}
}

func TestBiliStatsValidatesParams(t *testing.T) {
	upstream, _ := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	cases := []struct {
		name string
		url  string
		want int
	}{
		{"完全没有参数", "/api/bili/stats", http.StatusBadRequest},
		{"bvid 格式不对", "/api/bili/stats?bvid=abc", http.StatusBadRequest},
		{"aid 不是数字", "/api/bili/stats?aid=abc", http.StatusBadRequest},
		{"q 无法识别", "/api/bili/stats?q=这不是视频", http.StatusBadRequest},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.url, nil))
		if rec.Code != c.want {
			t.Errorf("%s：应返回 %d，实际 %d", c.name, c.want, rec.Code)
		}
	}
}

// 缓存生效：同一视频连查多次只打一次上游。
func TestBiliStatsIsCached(t *testing.T) {
	upstream, hits := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	for i := 0; i < 4; i++ {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/stats?bvid=BV1JHZNBdEQv", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次失败: %d", i, rec.Code)
		}
	}
	if *hits != 1 {
		t.Errorf("上游应只被调用 1 次，实际 %d", *hits)
	}
}

// aid 与 bvid 指向同一视频时必须命中同一条缓存（否则白打一遍上游）。
func TestBiliStatsSharesCacheBetweenAidAndBvid(t *testing.T) {
	upstream, hits := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	for _, u := range []string{
		"/api/bili/stats?bvid=BV1JHZNBdEQv",
		"/api/bili/stats?aid=116078873153625",
	} {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, u, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s 失败: %d", u, rec.Code)
		}
	}
	if *hits != 1 {
		t.Errorf("aid 与 bvid 应共用缓存，上游实际被调用 %d 次", *hits)
	}
}

// 上游挂掉后，stale 窗口内仍应能拿到旧数据并标明是 stale。
func TestBiliStatsServesStaleOnUpstreamFailure(t *testing.T) {
	var fail bool
	var hits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"code": 0, "message": "OK",
			"data": map[string]any{
				"bvid": "BV1JHZNBdEQv", "aid": 1, "title": "t",
				"stat": map[string]any{"view": 100, "like": 1, "favorite": 2, "coin": 3, "reply": 4, "danmaku": 5},
			},
		})
	}))
	defer upstream.Close()

	srv := newTestServer(t, upstream.URL, 0, 0)
	srv.cfg.Cache.BiliTTL = Duration(10 * time.Millisecond)
	srv.cfg.Cache.BiliStaleTTL = Duration(time.Hour)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/stats?bvid=BV1JHZNBdEQv", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("首次应成功，实际 %d", rec.Code)
	}

	fail = true
	time.Sleep(30 * time.Millisecond) // 让 TTL 过期

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/stats?bvid=BV1JHZNBdEQv", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("上游挂掉时 stale 窗口内应返回 200，实际 %d", rec.Code)
	}
	if rec.Header().Get("X-EvRCalc-Stale") != "1" {
		t.Error("回吐旧数据时必须带上 stale 标记，不能假装是新的")
	}
	var stats biliStats
	_ = json.Unmarshal(rec.Body.Bytes(), &stats)
	if stats.Play != 100 {
		t.Errorf("应回吐旧数据（play=100），实际 %d", stats.Play)
	}
	if stats.Cache != string(StateStale) {
		t.Errorf("cache 字段应为 stale，实际 %q", stats.Cache)
	}
}

// ── 批量端点 ─────────────────────────────────────────────────────

func TestBiliBatchReturnsOrderedResults(t *testing.T) {
	upstream, _ := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/bili/batch?bvid=BV1JHZNBdEQv,BV1oGZMBbEHJ&aid=116078873153625", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d", rec.Code)
	}
	var body struct {
		Count   int `json:"count"`
		Failed  int `json:"failed"`
		Results []struct {
			OK    bool       `json:"ok"`
			Stats *biliStats `json:"stats"`
		} `json:"results"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Count != 3 {
		t.Errorf("应有 3 条结果，实际 %d", body.Count)
	}
	if body.Failed != 0 {
		t.Errorf("不应有失败项，实际 %d", body.Failed)
	}
	// 顺序必须与入参一致
	if body.Results[0].Stats == nil || body.Results[1].Stats == nil || body.Results[2].Stats == nil {
		t.Fatal("结果项不应为空")
	}
	if body.Results[2].Stats.Aid != 116078873153625 {
		t.Errorf("第三条应来自 aid 参数，实际 %d", body.Results[2].Stats.Aid)
	}
}

func TestBiliBatchRejectsTooMany(t *testing.T) {
	upstream, _ := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	ids := make([]string, 30)
	for i := range ids {
		ids[i] = "BV1xx411c7mD"
	}
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/api/bili/batch?bvid="+strings.Join(ids, ","), nil))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("超过上限应返回 400，实际 %d", rec.Code)
	}
}

// ── resolve 端点 ─────────────────────────────────────────────────

func TestBiliResolveParsesInputs(t *testing.T) {
	upstream, _ := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	cases := []struct {
		q       string
		wantBv  string
		wantAid string
	}{
		{"BV1JHZNBdEQv", "BV1JHZNBdEQv", ""},
		// resolve 会做规范化：av 号同时补出 BV 号，便于前端统一回显
		{"av116078873153625", "BV1JHZNBdEQv", "116078873153625"},
		{"https://www.bilibili.com/video/BV1JHZNBdEQv?spm_id_from=333", "BV1JHZNBdEQv", ""},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/resolve?q="+c.q, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s 应返回 200，实际 %d", c.q, rec.Code)
			continue
		}
		var ref BiliRef
		if err := json.Unmarshal(rec.Body.Bytes(), &ref); err != nil {
			t.Fatal(err)
		}
		if ref.Bvid != c.wantBv || ref.Aid != c.wantAid {
			t.Errorf("%s → bvid=%q aid=%q，期望 bvid=%q aid=%q", c.q, ref.Bvid, ref.Aid, c.wantBv, c.wantAid)
		}
	}
}

func TestBiliResolveRejectsUnrecognizable(t *testing.T) {
	upstream, _ := newBiliUpstream(t, 0, "")
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/resolve?q=随便一句话", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("无法识别时应返回 404，实际 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/bili/resolve", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("缺少 q 时应返回 400，实际 %d", rec.Code)
	}
}

func mustIP(t *testing.T, s string) net.IP {
	t.Helper()
	ip := net.ParseIP(s)
	if ip == nil {
		t.Fatalf("非法 IP: %q", s)
	}
	return ip
}
