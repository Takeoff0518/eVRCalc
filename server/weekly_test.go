package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── 字段裁剪 ─────────────────────────────────────────────────────

// 裁剪后的字段集合必须**恰好**等于 VIDEO_FIELDS 的交集：
// 既不能漏掉前端要用的字段，也不能把 coverurl / referSource 这类
// 冗余字段漏出去（它们是裁剪掉 60% 体积的关键）。
func TestTrimPeriodKeepsOnlyWhitelistedFields(t *testing.T) {
	raw := []byte(`{
	  "ranknum": 735,
	  "generate_time": "2026-09-07 03:25:26",
	  "collect_start_time": "2026-08-29 00:00:00",
	  "collect_end_time": "2026-09-04 23:59:59",
	  "coverurl": "https://example.com/cover.png",
	  "pubdate": "2026-09-07",
	  "statistic": {"total": 110},
	  "thanks_list": [{"a": 1}],
	  "oth_pickup": [{"title": "不该出现"}],
	  "main_rank": [{
	    "rank": 1,
	    "avid": "av117207459697071",
	    "url": "https://www.bilibili.com/video/BV1mKto6kEBQ",
	    "title": "测试曲目",
	    "point": 575160,
	    "play": 2489409,
	    "like": 110296,
	    "favorite": 35001,
	    "coin": 36538,
	    "comment": 2759,
	    "danmaku": 3123,
	    "share": 15956,
	    "coverurl": "https://example.com/c.png",
	    "pubdate": "2026-08-30",
	    "ext_rank": {"a": 1},
	    "referSource": {"play": 2489409, "like": 110296}
	  }],
	  "second_rank": [{"rank": 31, "avid": "av1", "title": "续榜条目", "point": 100}]
	}`)

	out, err := trimPeriod(raw, time.Now())
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}

	var period map[string]any
	if err := json.Unmarshal(out, &period); err != nil {
		t.Fatalf("裁剪结果不是合法 JSON: %v", err)
	}

	// 顶层不该出现这些字段
	for _, banned := range []string{"coverurl", "pubdate", "statistic", "thanks_list", "oth_pickup"} {
		if _, exists := period[banned]; exists {
			t.Errorf("顶层不应保留 %q", banned)
		}
	}

	// 顶层必须保留这些
	for _, want := range []string{"ranknum", "generate_time", "collect_start_time", "collect_end_time", "main_rank", "second_rank"} {
		if _, exists := period[want]; !exists {
			t.Errorf("顶层缺少 %q", want)
		}
	}

	main := period["main_rank"].([]any)
	v := main[0].(map[string]any)
	for _, banned := range []string{"share", "coverurl", "pubdate", "ext_rank", "referSource"} {
		if _, exists := v[banned]; exists {
			t.Errorf("单条视频不应保留 %q", banned)
		}
	}
	for _, f := range VIDEO_FIELDS {
		if _, exists := v[f]; !exists {
			t.Errorf("单条视频缺少 %q", f)
		}
	}

	// 第二段（31~110 名）必须保留 —— 漏掉它会把所有得分压在 30 名以内
	if len(period["second_rank"].([]any)) != 1 {
		t.Error("second_rank 必须保留")
	}
}

// 上游缺字段时，输出里也不该出现这个键（与 Worker 的
// `if (v?.[f] !== undefined)` 行为一致）。
func TestTrimPeriodOmitsMissingFields(t *testing.T) {
	raw := []byte(`{
	  "ranknum": 1, "generate_time": "t", "collect_start_time": "a", "collect_end_time": "b",
	  "main_rank": [{"rank": 1, "avid": "av1", "title": "只有基本字段"}]
	}`)
	out, err := trimPeriod(raw, time.Now())
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}

	var period struct {
		MainRank []map[string]any `json:"main_rank"`
	}
	if err := json.Unmarshal(out, &period); err != nil {
		t.Fatal(err)
	}
	v := period.MainRank[0]
	if _, exists := v["play"]; exists {
		t.Error("上游没有 play，输出里也不该有")
	}
	if v["avid"] != "av1" {
		t.Errorf("avid 应保留，实际 %v", v["avid"])
	}
}

// main_rank / second_rank 缺失时必须是空数组而不是 null ——
// 前端拿到 null 会在 `.map()` 上炸掉。
func TestTrimPeriodEmitsEmptyArraysNotNull(t *testing.T) {
	raw := []byte(`{"ranknum": 1, "generate_time": "t", "collect_start_time": "a", "collect_end_time": "b"}`)
	out, err := trimPeriod(raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(out, &probe); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"main_rank", "second_rank"} {
		if string(probe[k]) != "[]" {
			t.Errorf("%s 应为 []，实际 %s", k, probe[k])
		}
	}
}

func TestTrimInfoKeepsOnlyRankNum(t *testing.T) {
	raw := []byte(`{
	  "generate_time": "2026-09-07 03:31:29",
	  "generate_timestamp": 123,
	  "rank_list": [
	    {"rank_num": 735, "url": "u", "coverurl": "c", "avid": "av1"},
	    {"rank_num": 734, "url": "u", "coverurl": "c", "avid": "av2"}
	  ]
	}`)
	out, err := trimInfo(raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}

	var info struct {
		RankList []map[string]any `json:"rank_list"`
	}
	if err := json.Unmarshal(out, &info); err != nil {
		t.Fatal(err)
	}
	if len(info.RankList) != 2 {
		t.Fatalf("应有 2 条，实际 %d", len(info.RankList))
	}
	for _, e := range info.RankList {
		if len(e) != 1 {
			t.Errorf("条目应只有 rank_num，实际 %v", e)
		}
	}
	// 上游 rank_num 是数字，必须统一转成字符串（前端按字符串比对）
	if info.RankList[0]["rank_num"] != "735" {
		t.Errorf("rank_num 应转成字符串 \"735\"，实际 %#v", info.RankList[0]["rank_num"])
	}
}

// 空榜单不能写进缓存 —— 否则一次上游抽风会让前端长时间看不到榜单。
func TestSanityCheckRejectsEmptyPayloads(t *testing.T) {
	if err := sanityCheckTrimmed([]byte(`{"ranknum":1,"main_rank":[]}`)); err == nil {
		t.Error("空主榜应被拒绝")
	}
	if err := sanityCheckTrimmed([]byte(`{"rank_list":[]}`)); err == nil {
		t.Error("空目录应被拒绝")
	}
	if err := sanityCheckTrimmed([]byte(`{"ranknum":1,"main_rank":[{"rank":1}]}`)); err != nil {
		t.Errorf("非空主榜应通过，实际 %v", err)
	}
	if err := sanityCheckTrimmed([]byte(`{"rank_list":[{"rank_num":"735"}]}`)); err != nil {
		t.Errorf("非空目录应通过，实际 %v", err)
	}
}

// 用真实夹具验证裁剪收益与结构保持。
//
// 注意：仓库里的 latest-735.json 是**抽样**的（main_rank 30 条 + second_rank 前 10 条），
// 不是完整 110 条，所以这里不校验总条数 —— 110 条的完整性由
// TestTrimPeriodKeepsFullRanking 用完整夹具保证。
func TestTrimPeriodOnRealFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "src", "__fixtures__", "latest-735.json"))
	if err != nil {
		t.Skipf("夹具不可读（真实数据不在仓库里时属正常）: %v", err)
	}

	out, err := trimPeriod(raw, time.Now())
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}

	var period WeeklyPeriod
	if err := json.Unmarshal(out, &period); err != nil {
		t.Fatal(err)
	}
	if period.Ranknum != 735 {
		t.Errorf("期号应为 735，实际 %d", period.Ranknum)
	}
	if len(period.MainRank) == 0 {
		t.Fatal("主榜不应为空")
	}
	if len(period.SecondRank) == 0 {
		t.Fatal("续榜不应为空（漏掉它会把所有得分压在 30 名以内）")
	}

	// 真实数据里第一条的六项数值必须原样带出，不能变成 0
	first := period.MainRank[0]
	if first.Play == 0 || first.Point == 0 || first.Title == "" {
		t.Errorf("首条数据不完整: %+v", first)
	}
	if first.Avid == "" {
		t.Errorf("首条应带 avid: %+v", first)
	}

	// 冗余字段必须被裁掉
	trimmed, _ := json.Marshal(period)
	for _, banned := range []string{"referSource", "coverurl", "ext_rank", "thanks_list", "statistic"} {
		if strings.Contains(string(trimmed), banned) {
			t.Errorf("裁剪结果里仍出现冗余字段 %q", banned)
		}
	}

	// 这个夹具本身就是「已裁剪的抽样」（main 30 + second 前 10，且没有 url），
	// 所以收益不会像线上完整数据那样达到 60% —— 只要明显缩小即可。
	gain := 100 * (1 - float64(len(out))/float64(len(raw)))
	t.Logf("真实夹具裁剪 %d → %d 字节（省 %.1f%%）", len(raw), len(out), gain)
	if gain < 20 {
		t.Errorf("裁剪收益只有 %.1f%%，白名单可能没生效", gain)
	}
}

// 完整榜单必须是 110 条、名次连续覆盖 1..110。
//
// 这条测试守的是项目早期那个明确的 bug：只读 main_rank 时，
// 任何得分都会被压在 30 名以内。
func TestTrimPeriodKeepsFullRanking(t *testing.T) {
	raw := []byte(weeklyFixtureJSON(735, 30, 80))

	out, err := trimPeriod(raw, time.Now())
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}

	var period WeeklyPeriod
	if err := json.Unmarshal(out, &period); err != nil {
		t.Fatal(err)
	}

	total := len(period.MainRank) + len(period.SecondRank)
	if total != 110 {
		t.Errorf("主榜+续榜应为 110 条，实际 %d（主 %d + 续 %d）",
			total, len(period.MainRank), len(period.SecondRank))
	}
	if len(period.MainRank) != 30 {
		t.Errorf("主榜应为 30 条，实际 %d", len(period.MainRank))
	}
	if len(period.SecondRank) != 80 {
		t.Errorf("续榜应为 80 条（第 31~110 名），实际 %d", len(period.SecondRank))
	}

	seen := map[int]bool{}
	for _, v := range append(append([]WeeklyVideo{}, period.MainRank...), period.SecondRank...) {
		seen[v.Rank] = true
	}
	for i := 1; i <= 110; i++ {
		if !seen[i] {
			t.Errorf("缺少名次 %d", i)
		}
	}
}

// 与前端共享的字段契约：前端 types/weekly.ts 里的 WeeklyVideo 字段
// 必须都在 VIDEO_FIELDS 里。漏一个前端就会静默拿到 undefined。
func TestVideoFieldsCoverFrontendContract(t *testing.T) {
	// 前端类型里声明为必填的字段
	required := []string{"url", "avid", "title", "point"}
	// 外加六项原始数据
	required = append(required, "play", "like", "favorite", "coin", "comment", "danmaku")
	// rank 用于排序
	required = append(required, "rank")

	set := map[string]bool{}
	for _, f := range VIDEO_FIELDS {
		set[f] = true
	}
	for _, f := range required {
		if !set[f] {
			t.Errorf("前端需要的字段 %q 不在 VIDEO_FIELDS 里", f)
		}
	}
}

// ── 上游地址拼装（防路径穿越）────────────────────────────────────

func TestWeeklyRankRejectsNonNumericN(t *testing.T) {
	var rankPaths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/data/info/info.json":
			// weeklyTTL 需要期号目录来判断该用哪个 TTL，这是预期内的请求
			_, _ = fmt.Fprint(w, testInfoJSON)
		case strings.HasPrefix(r.URL.Path, "/data/rank_data/"):
			rankPaths = append(rankPaths, r.URL.Path)
			_, _ = fmt.Fprint(w, weeklyFixtureJSON(735, 30, 80))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	srv := newTestServer(t, upstream.URL, 0, 0)

	// 这些都必须被 400 挡掉，绝不能拼进上游 URL
	for _, bad := range []string{"", "abc", "../../etc/passwd", "-1", "0", "1e5", "735;ls", "%2e%2e%2f", "99999999999999999999"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodGet, "/api/weekly/rank?n="+bad, nil)
		srv.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest {
			t.Errorf("n=%q 应返回 400，实际 %d", bad, w.Code)
		}
	}

	// 没有任何非法输入可以拼进上游路径
	if len(rankPaths) != 0 {
		t.Errorf("非法 n 不应触发任何 rank_data 请求，实际 %v", rankPaths)
	}

	// 合法值应当通过
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/weekly/rank?n=735", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("n=735 应返回 200，实际 %d，body=%s", rec.Code, rec.Body.String())
	}
	if len(rankPaths) != 1 || rankPaths[0] != "/data/rank_data/735.json" {
		t.Errorf("上游应收到的唯一 rank 路径是 /data/rank_data/735.json，实际 %v", rankPaths)
	}
}
