package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestAvToBvMatchesOfficialSample 用官方样例锁定算法。
// av2 → BV1xx411c7mD 是 bilibili-API-collect 里公开的换算样例。
func TestAvToBvMatchesOfficialSample(t *testing.T) {
	cases := map[string]string{
		"av2": "BV1xx411c7mD",
		"2":   "BV1xx411c7mD",
		"AV2": "BV1xx411c7mD",
	}
	for in, want := range cases {
		if got := AvToBv(in); got != want {
			t.Errorf("AvToBv(%q) = %q, 期望 %q", in, got, want)
		}
	}

	for _, bad := range []string{"", "abc", "av", "av12x", "BV1JHZNBdEQv"} {
		if got := AvToBv(bad); got != "" {
			t.Errorf("AvToBv(%q) 应返回空串，实际 %q", bad, got)
		}
	}
}

// TestAvToBvOfficialDocsExample 用 bilibili-API-collect 官方文档给出的
// 互转样例锁定算法（docs/misc/bvid_desc.md，Golang 实现里的 main 函数）。
func TestAvToBvOfficialDocsExample(t *testing.T) {
	const (
		aid  = "1054803170"
		want = "BV1mH4y1u7UA"
	)
	if got := AvToBv(aid); got != want {
		t.Errorf("AvToBv(%s) = %q, 期望 %q", aid, got, want)
	}
}

// TestAvToBvTable 是一张**离线**的换算表，用于回归。
//
// 表中的每一对都经过真实 B 站接口验证（见 TestAvToBvAgainstLiveBilibili），
// 所以即使没有网络，这个测试也能守住算法不回退。
func TestAvToBvTable(t *testing.T) {
	cases := map[string]string{
		"av2":               "BV1xx411c7mD",
		"1054803170":        "BV1mH4y1u7UA",
		"av116078873153625": "BV1JHZNBdEQv",
		"av116079158370026": "BV1oGZMBbEHJ",
		"av116079124811785": "BV1NoZTB6Enm",
	}
	for in, want := range cases {
		if got := AvToBv(in); got != want {
			t.Errorf("AvToBv(%q) = %q, 期望 %q", in, got, want)
		}
	}
}

// TestAvToBvAgainstLiveBilibili 用真实榜单里的 avid 走一遍 B 站接口，
// 拿 B 站自己返回的 bvid 作为标准答案。
//
// 这是唯一能真正证明算法正确的测试 —— 其他测试都只是「跟自己一致」。
// 需要网络，默认跳过；用 EVRC_LIVE=1 开启。
func TestAvToBvAgainstLiveBilibili(t *testing.T) {
	if os.Getenv("EVRC_LIVE") != "1" {
		t.Skip("需要网络：设置 EVRC_LIVE=1 开启")
	}

	// 取夹具里的真实 avid（周刊 735 期主榜前若干条）
	raw, err := os.ReadFile(filepath.Join("..", "src", "__fixtures__", "period-735.json"))
	if err != nil {
		t.Skipf("夹具不可读: %v", err)
	}
	var fixture struct {
		Entries []struct {
			Avid  string `json:"avid"`
			Title string `json:"title"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("夹具解析失败: %v", err)
	}

	cfg, err := LoadConfig(filepath.Join("testdata", "nonexistent.yaml"))
	if err != nil {
		t.Fatalf("配置加载失败: %v", err)
	}
	srv, err := NewServer(cfg, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError})))
	if err != nil {
		t.Fatalf("初始化失败: %v", err)
	}

	limit := 6
	if len(fixture.Entries) < limit {
		limit = len(fixture.Entries)
	}

	verified := 0
	for i := 0; i < limit; i++ {
		avid := fixture.Entries[i].Avid
		got := AvToBv(avid)
		if got == "" {
			t.Errorf("AvToBv(%s) 返回空", avid)
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		view, err := srv.fetchBiliView(ctx, BiliRef{Raw: avid, Aid: strings.TrimPrefix(avid, "av"), Kind: "avid"})
		cancel()
		if err != nil {
			t.Logf("跳过 %s（上游不可用: %v）", avid, err)
			continue
		}

		if view.Bvid != got {
			t.Errorf("AvToBv(%s) = %s，但 B 站说它是 %s", avid, got, view.Bvid)
			continue
		}
		fmt.Printf("  ✓ %s → %s  (%s)\n", avid, got, fixture.Entries[i].Title)
		verified++

		time.Sleep(400 * time.Millisecond) // 别把上游惹毛
	}

	if verified == 0 {
		t.Fatal("没有一条通过真实接口校验，无法证明算法正确")
	}
	t.Logf("经 B 站接口验证 %d 条，av→BV 全部一致", verified)
}
