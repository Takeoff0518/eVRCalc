package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newTestServer 造一个指向假上游的 Server。
// 注意 Upstream.Bilibili 也需要一个 http:// 地址，所以调用方一般传两个。
func newTestServer(t *testing.T, weeklyURL string, weeklyPerMin, biliPerMin int) *Server {
	t.Helper()
	cfg := defaultConfig()
	cfg.Upstream.Weekly = weeklyURL
	cfg.Upstream.Bilibili = weeklyURL // 单上游测试时复用
	cfg.Upstream.Timeout = Duration(5 * time.Second)
	cfg.RateLimit.WeeklyPerMinute = weeklyPerMin
	cfg.RateLimit.BiliPerMinute = biliPerMin
	cfg.RateLimit.Burst = 10
	cfg.Log.AccessLog = false
	if err := cfg.Validate(); err != nil {
		t.Fatalf("测试配置非法: %v", err)
	}
	srv, err := NewServer(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("Server 初始化失败: %v", err)
	}
	return srv
}

// weeklyFixtureJSON 造一份形状与上游一致的最小期刊 JSON。
func weeklyFixtureJSON(ranknum int, mainCount, secondCount int) string {
	mk := func(start, n int) string {
		parts := make([]string, 0, n)
		for i := 0; i < n; i++ {
			parts = append(parts, fmt.Sprintf(
				`{"rank":%d,"avid":"av%d","url":"https://www.bilibili.com/video/BV1xx411c7mD",`+
					`"title":"曲目 %d","point":%d,"play":%d,"like":%d,"favorite":%d,"coin":%d,`+
					`"comment":%d,"danmaku":%d,"share":1,"coverurl":"https://example.com/c.png",`+
					`"referSource":{"play":%d}}`,
				start+i, 1000+i, start+i, 500000-i*100, 2000000-i*10, 100000-i, 30000-i,
				20000-i, 3000-i, 2000-i, 2000000-i*10))
		}
		return strings.Join(parts, ",")
	}
	return fmt.Sprintf(`{
	  "ranknum": %d,
	  "generate_time": "2026-09-07 03:25:26",
	  "collect_start_time": "2026-08-29 00:00:00",
	  "collect_end_time": "2026-09-04 23:59:59",
	  "coverurl": "https://example.com/cover.png",
	  "main_rank": [%s],
	  "second_rank": [%s]
	}`, ranknum, mk(1, mainCount), mk(mainCount+1, secondCount))
}

const testInfoJSON = `{
  "generate_time": "2026-09-07 03:31:29",
  "rank_list": [
    {"rank_num": 735, "url": "u", "coverurl": "c", "avid": "av1"},
    {"rank_num": 734, "url": "u", "coverurl": "c", "avid": "av2"}
  ]
}`

// newWeeklyUpstream 造一个假周刊上游，支持 ETag 条件请求。
func newWeeklyUpstream(t *testing.T) (*httptest.Server, *int) {
	t.Helper()
	var hits int
	const etag = `W/"test-etag"`

	mux := http.NewServeMux()
	mux.HandleFunc("/data/info/info.json", func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Etag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = io.WriteString(w, testInfoJSON)
	})
	mux.HandleFunc("/data/info/latest.json", func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Etag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = io.WriteString(w, weeklyFixtureJSON(735, 30, 80))
	})
	mux.HandleFunc("/data/rank_data/", func(w http.ResponseWriter, r *http.Request) {
		hits++
		num := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/data/rank_data/"), ".json")
		var n int
		_, _ = fmt.Sscanf(num, "%d", &n)
		w.Header().Set("Etag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = io.WriteString(w, weeklyFixtureJSON(n, 30, 80))
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, &hits
}

// ── 周刊端点 ─────────────────────────────────────────────────────

func TestWeeklyLatestReturnsFullRanking(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/latest", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type 应为 JSON，实际 %q", ct)
	}

	var period WeeklyPeriod
	if err := json.Unmarshal(rec.Body.Bytes(), &period); err != nil {
		t.Fatalf("响应不是合法期刊 JSON: %v", err)
	}
	if period.Ranknum != 735 {
		t.Errorf("期号应为 735，实际 %d", period.Ranknum)
	}
	total := len(period.MainRank) + len(period.SecondRank)
	if total != 110 {
		t.Errorf("应返回 110 条，实际 %d（主 %d + 续 %d）",
			total, len(period.MainRank), len(period.SecondRank))
	}
	if len(period.SecondRank) != 80 {
		t.Errorf("续榜应为 80 条（第 31~110 名），实际 %d", len(period.SecondRank))
	}
}

func TestWeeklyInfoReturnsPeriodList(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/info", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d", rec.Code)
	}
	var info WeeklyInfo
	if err := json.Unmarshal(rec.Body.Bytes(), &info); err != nil {
		t.Fatalf("响应不是合法目录 JSON: %v", err)
	}
	if len(info.RankList) != 2 || info.RankList[0].RankNum != "735" {
		t.Errorf("目录内容不对: %+v", info.RankList)
	}
}

func TestWeeklyUpstreamErrorBecomes502(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	srv := newTestServer(t, upstream.URL, 0, 0)
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/latest", nil))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("上游 500 应转成 502，实际 %d", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("错误响应必须是 JSON，实际 %s", rec.Body.String())
	}
	if body["error"] == "" {
		t.Error("错误响应应带 error 字段")
	}
}

// 上游抽风返回空榜单时不能污染缓存：连打两次，第二次仍应重试上游。
func TestWeeklyEmptyRankingIsNotCached(t *testing.T) {
	var hits int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits == 1 {
			_, _ = io.WriteString(w, `{"ranknum":735,"main_rank":[]}`)
			return
		}
		_, _ = io.WriteString(w, weeklyFixtureJSON(735, 30, 80))
	}))
	defer upstream.Close()

	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/latest", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("空榜单应报 502，实际 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/latest", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("第二次应重试并成功，实际 %d", rec.Code)
	}
	if hits != 2 {
		t.Errorf("上游应被请求 2 次（空结果不应进缓存），实际 %d", hits)
	}
}

// 缓存生效时不应重复打上游。
func TestWeeklyLatestIsCached(t *testing.T) {
	upstream, hits := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	for i := 0; i < 4; i++ {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/latest", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次失败: %d", i, rec.Code)
		}
	}
	if *hits != 1 {
		t.Errorf("4 次请求应只打上游 1 次，实际 %d", *hits)
	}
}

// 未启用 gzip 时不应加 Content-Encoding —— 否则浏览器解压会失败。
func TestGzipOnlyWhenAccepted(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	// 不带 Accept-Encoding
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/latest", nil))
	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("未声明 gzip 时不应压缩，实际 %q", enc)
	}
	if rec.Body.Len() == 0 {
		t.Error("响应体不应为空")
	}

	// 不带 gzip 也应能正常解析
	var period WeeklyPeriod
	if err := json.Unmarshal(rec.Body.Bytes(), &period); err != nil {
		t.Errorf("明文响应解析失败: %v", err)
	}
}

// ── 通用路由行为 ─────────────────────────────────────────────────

func TestUnknownPathReturnsJSON404(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/nope", nil))

	if rec.Code != http.StatusNotFound {
		t.Errorf("应返回 404，实际 %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("404 也应是 JSON，实际 %q", ct)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/weekly/latest", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST 应返回 405，实际 %d", rec.Code)
	}
	if allow := rec.Header().Get("Allow"); !strings.Contains(allow, "GET") {
		t.Errorf("应带 Allow 头，实际 %q", allow)
	}
}

func TestHealthz(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/healthz", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("应返回 200，实际 %d", rec.Code)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true {
		t.Errorf("ok 应为 true，实际 %v", body["ok"])
	}
}

// ── CORS ─────────────────────────────────────────────────────────

func TestCORSAllowAllByDefault(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	req := httptest.NewRequest(http.MethodGet, "/api/weekly/info", nil)
	req.Header.Set("Origin", "https://anywhere.example")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("默认应允许所有来源，实际 %q", got)
	}
}

func TestCORSWhitelistOnlyEchoesAllowedOrigin(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)
	srv.cfg.CORS.AllowedOrigins = []string{"https://evrc.tbpdt.top"}
	srv.origins = srv.cfg.allowedOriginSet()
	srv.allowAll = false

	// 白名单内 → 回显该来源
	req := httptest.NewRequest(http.MethodGet, "/api/weekly/info", nil)
	req.Header.Set("Origin", "https://evrc.tbpdt.top")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://evrc.tbpdt.top" {
		t.Errorf("白名单内的来源应被回显，实际 %q", got)
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Origin") {
		t.Error("应带 Vary: Origin，避免中间缓存串味")
	}

	// 白名单外 → 不回显（浏览器会据此拒绝读取响应）
	req = httptest.NewRequest(http.MethodGet, "/api/weekly/info", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("白名单外的来源不应被回显，实际 %q", got)
	}
}

func TestPreflightReturns204(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 0, 0)

	req := httptest.NewRequest(http.MethodOptions, "/api/weekly/latest", nil)
	req.Header.Set("Origin", "https://evrc.tbpdt.top")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("预检应返回 204，实际 %d", rec.Code)
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Error("预检响应应带 Allow-Methods")
	}
}

// ── 限流 ─────────────────────────────────────────────────────────

func TestRateLimitReturns429(t *testing.T) {
	upstream, _ := newWeeklyUpstream(t)
	srv := newTestServer(t, upstream.URL, 2, 0) // 周刊 2/min，burst 10
	srv.limiter = NewRateLimiter(map[string]int{classWeekly: 2, classBili: 0}, 3, time.Minute)

	got429 := false
	for i := 0; i < 10; i++ {
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/info", nil))
		if rec.Code == http.StatusTooManyRequests {
			got429 = true
			if rec.Header().Get("Retry-After") == "" {
				t.Error("429 响应应带 Retry-After")
			}
			break
		}
	}
	if !got429 {
		t.Error("超过 burst 后应返回 429")
	}
}
