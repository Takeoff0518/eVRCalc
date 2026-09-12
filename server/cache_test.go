package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ── 缓存 ─────────────────────────────────────────────────────────

func TestCacheFetchesOnceThenServesFromCache(t *testing.T) {
	c := NewCache()
	var calls int32

	fetch := func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		atomic.AddInt32(&calls, 1)
		return []byte("v1"), "etag-1", false, nil
	}

	for i := 0; i < 5; i++ {
		data, state, err := c.GetOrFetch("k", time.Minute, 0, fetch)
		if err != nil {
			t.Fatalf("第 %d 次出错: %v", i, err)
		}
		if string(data) != "v1" {
			t.Fatalf("第 %d 次数据不对: %q", i, data)
		}
		if i == 0 && state != StateFetched {
			t.Errorf("首次应为 fetched，得到 %s", state)
		}
		if i > 0 && state != StateFresh {
			t.Errorf("第 %d 次应为 fresh，得到 %s", i, state)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("上游应只被调用 1 次，实际 %d 次", got)
	}
}

// TTL 到期后必须重新取数 —— 否则新一期发布后前端永远看不到。
func TestCacheRefetchesAfterTTL(t *testing.T) {
	c := NewCache()
	now := time.Now()
	c.now = func() time.Time { return now }

	var calls int32
	fetch := func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		n := atomic.AddInt32(&calls, 1)
		return []byte{byte('0' + n)}, "etag", false, nil
	}

	if _, _, err := c.GetOrFetch("k", 10*time.Second, 0, fetch); err != nil {
		t.Fatal(err)
	}
	now = now.Add(11 * time.Second)
	data, state, err := c.GetOrFetch("k", 10*time.Second, 0, fetch)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "2" || state != StateFetched {
		t.Errorf("TTL 到期后应重新取数，得到 %q / %s", data, state)
	}
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("上游应被调用 2 次，实际 %d 次", got)
	}
}

// 上游挂掉时，stale 窗口内的旧数据必须照常返回并标记为 stale ——
// 让用户拿到「稍旧的数字」远好过拿到一个报错。
func TestCacheServesStaleWhenUpstreamFails(t *testing.T) {
	c := NewCache()
	now := time.Now()
	c.now = func() time.Time { return now }

	ok := true
	fetch := func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		if ok {
			return []byte("good"), "etag", false, nil
		}
		return nil, "", false, errors.New("上游炸了")
	}

	if _, _, err := c.GetOrFetch("k", 10*time.Second, time.Hour, fetch); err != nil {
		t.Fatal(err)
	}

	ok = false
	now = now.Add(20 * time.Second) // TTL 已过，但在 staleTTL 内

	data, state, err := c.GetOrFetch("k", 10*time.Second, time.Hour, fetch)
	if err != nil {
		t.Fatalf("stale 窗口内不应报错，实际 %v", err)
	}
	if string(data) != "good" {
		t.Errorf("应回吐旧数据，实际 %q", data)
	}
	if state != StateStale {
		t.Errorf("应标记为 stale，实际 %s", state)
	}
}

// staleTTL=0 时必须报错，不能悄悄给过期数据（期号目录就属于这类）。
func TestCacheDoesNotServeStaleWhenDisabled(t *testing.T) {
	c := NewCache()
	now := time.Now()
	c.now = func() time.Time { return now }

	ok := true
	fetch := func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		if ok {
			return []byte("good"), "etag", false, nil
		}
		return nil, "", false, errors.New("上游炸了")
	}

	if _, _, err := c.GetOrFetch("k", 10*time.Second, 0, fetch); err != nil {
		t.Fatal(err)
	}
	ok = false
	now = now.Add(20 * time.Second)

	if _, _, err := c.GetOrFetch("k", 10*time.Second, 0, fetch); err == nil {
		t.Error("staleTTL=0 时应把上游错误暴露出来")
	}
}

// 上游回 304 时必须沿用旧数据、只刷新时间戳，而不是把空数据写进缓存。
func TestCacheHandles304(t *testing.T) {
	c := NewCache()
	now := time.Now()
	c.now = func() time.Time { return now }

	calls := 0
	fetch := func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		calls++
		if calls == 1 {
			return []byte("body"), "etag-abc", false, nil
		}
		if prevETag != "etag-abc" {
			t.Errorf("第二次应带上 If-None-Match=etag-abc，实际 %q", prevETag)
		}
		return nil, "etag-abc", true, nil // 304
	}

	if _, _, err := c.GetOrFetch("k", 10*time.Second, 0, fetch); err != nil {
		t.Fatal(err)
	}
	now = now.Add(11 * time.Second)
	data, state, err := c.GetOrFetch("k", 10*time.Second, 0, fetch)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "body" {
		t.Errorf("304 之后应沿用旧数据，实际 %q", data)
	}
	if state != StateFetched {
		t.Errorf("304 也是一次成功的确认，state 应为 fetched，实际 %s", state)
	}
}

// 并发请求同一个 key 时只应打上游一次（去重）。
func TestCacheDeduplicatesConcurrentFetches(t *testing.T) {
	c := NewCache()
	var calls int32

	fetch := func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		atomic.AddInt32(&calls, 1)
		time.Sleep(50 * time.Millisecond)
		return []byte("data"), "etag", false, nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := c.GetOrFetch("same-key", time.Minute, 0, fetch); err != nil {
				t.Errorf("并发取数出错: %v", err)
			}
		}()
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("并发去重失效：上游被调用了 %d 次，期望 1 次", got)
	}
}

func TestCacheSweep(t *testing.T) {
	c := NewCache()
	now := time.Now()
	c.now = func() time.Time { return now }

	fetch := func(ctx context.Context, prevETag string) ([]byte, string, bool, error) {
		return []byte("x"), "", false, nil
	}
	_, _, _ = c.GetOrFetch("a", time.Second, 0, fetch)
	_, _, _ = c.GetOrFetch("b", time.Second, 0, fetch)
	if c.Len() != 2 {
		t.Fatalf("应有 2 个条目，实际 %d", c.Len())
	}

	now = now.Add(2 * time.Hour)
	if n := c.Sweep(time.Hour); n != 2 {
		t.Errorf("应清理 2 个条目，实际 %d", n)
	}
	if c.Len() != 0 {
		t.Errorf("清理后应为空，实际 %d", c.Len())
	}
}

// ── 令牌桶限流 ───────────────────────────────────────────────────

func TestRateLimiterBurstThenRefill(t *testing.T) {
	now := time.Now()
	l := NewRateLimiter(map[string]int{"bili": 60}, 5, time.Minute)
	l.now = func() time.Time { return now }

	// burst=5：前 5 次放行，第 6 次拒绝
	for i := 0; i < 5; i++ {
		if !l.Allow("bili", "1.2.3.4") {
			t.Fatalf("第 %d 次应放行", i+1)
		}
	}
	if l.Allow("bili", "1.2.3.4") {
		t.Error("超过 burst 后应拒绝")
	}

	// 60/min = 每秒 1 个；等 1 秒后应恢复 1 个令牌
	now = now.Add(time.Second)
	if !l.Allow("bili", "1.2.3.4") {
		t.Error("等待 1 秒后应恢复 1 个令牌")
	}

	// 不同 IP 互不影响
	if !l.Allow("bili", "5.6.7.8") {
		t.Error("另一个 IP 应独立计数")
	}
}

// 不同接口类别必须分开计数：B 站接口限得严，不该连累周刊接口。
func TestRateLimiterSeparatesClasses(t *testing.T) {
	now := time.Now()
	l := NewRateLimiter(map[string]int{"weekly": 60, "bili": 1}, 1, time.Minute)
	l.now = func() time.Time { return now }

	if !l.Allow("bili", "ip") {
		t.Fatal("首次应放行")
	}
	if l.Allow("bili", "ip") {
		t.Error("bili 类别应被限住")
	}
	if !l.Allow("weekly", "ip") {
		t.Error("weekly 类别不应受 bili 影响")
	}
}

// 类别未配置（0 或不存在的 key）时视为不限流。
func TestRateLimiterDisabledClassAlwaysAllows(t *testing.T) {
	l := NewRateLimiter(map[string]int{"weekly": 0}, 1, time.Minute)
	for i := 0; i < 100; i++ {
		if !l.Allow("weekly", "ip") {
			t.Fatal("0 表示不限流，应始终放行")
		}
	}
	if !l.Allow("未配置的类别", "ip") {
		t.Error("未知类别应放行")
	}
}

func TestRateLimiterRetryAfter(t *testing.T) {
	now := time.Now()
	l := NewRateLimiter(map[string]int{"bili": 60}, 1, time.Minute)
	l.now = func() time.Time { return now }

	if !l.Allow("bili", "ip") {
		t.Fatal("首次应放行")
	}
	secs := l.RetryAfter("bili", "ip")
	if secs < 1 || secs > 2 {
		t.Errorf("60/min 下 Retry-After 应约为 1 秒，实际 %d", secs)
	}
}
