package main

import (
	"context"
	"sync"
	"time"
)

// 进程内缓存。
//
// 为什么不用 Redis：这是单实例服务，周刊数据每期只冻结一份、B 站数据 TTL 也就
// 一两分钟，进程内 map 足够；引入外部存储只会多一个会挂的部件。
//
// 三个关键能力：
//  1. 带 TTL 的正常缓存
//  2. stale 回吐 —— 上游挂掉时宁可给旧数据 + 标记，也不给用户报错
//  3. 并发去重 —— 同一个 key 的并发请求只打上游一次

// entry 是一个缓存条目
type entry struct {
	val       []byte
	etag      string
	fetchedAt time.Time
	expiresAt time.Time
}

// CacheState 描述一次读取的结果来自哪里
type CacheState string

const (
	StateFresh   CacheState = "fresh"   // 在 TTL 内
	StateStale   CacheState = "stale"   // 已过期，但仍在 stale 窗口内
	StateFetched CacheState = "fetched" // 本次打上游取到的（或上游 304 确认未变）
)

// Fetcher 负责去上游取数据。
//
// prevETag 是上次记录的 ETag，可为空。返回 notModified=true 表示上游回了 304，
// 此时 data 可为 nil，缓存沿用旧值但刷新时间戳。
type Fetcher func(ctx context.Context, prevETag string) (data []byte, etag string, notModified bool, err error)

type Cache struct {
	mu       sync.RWMutex
	entries  map[string]*entry
	inflight map[string]*call
	now      func() time.Time // 便于测试注入
}

type call struct {
	done chan struct{}
	data []byte
	err  error
}

func NewCache() *Cache {
	return &Cache{
		entries:  make(map[string]*entry),
		inflight: make(map[string]*call),
		now:      time.Now,
	}
}

// Get 只读缓存，不触发任何上游请求。
func (c *Cache) Get(key string) (data []byte, e *entry, state CacheState, ok bool) {
	c.mu.RLock()
	ent, found := c.entries[key]
	c.mu.RUnlock()
	if !found {
		return nil, nil, "", false
	}
	if c.now().Before(ent.expiresAt) {
		return ent.val, ent, StateFresh, true
	}
	return ent.val, ent, StateStale, true
}

// GetOrFetch 是主入口。
//
// ttl 为条的存活时间；staleTTL 为过期后仍允许回吐的额外时长
// （staleTTL=0 表示不给过期数据）。
//
// 命中 stale 且配置了 staleTTL 时，会**立即返回旧数据**并在后台刷新 —— 用户不会
// 因为上游抖动而看到错误，代价是这一次拿到的是稍旧的数据（响应里会标出来）。
func (c *Cache) GetOrFetch(key string, ttl, staleTTL time.Duration, f Fetcher) ([]byte, CacheState, error) {
	if data, ent, state, ok := c.Get(key); ok {
		switch state {
		case StateFresh:
			return data, StateFresh, nil
		case StateStale:
			if staleTTL > 0 && c.now().Sub(ent.expiresAt) <= staleTTL {
				// 后台刷新，失败也无所谓 —— 旧数据还在
				go func() {
					defer func() { _ = recover() }()
					_, _, _ = c.refresh(key, ttl, ent.etag, staleTTL, f)
				}()
				return data, StateStale, nil
			}
		}
	}

	data, state, err := c.refresh(key, ttl, c.currentETag(key), staleTTL, f)
	return data, state, err
}

func (c *Cache) currentETag(key string) string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if ent, ok := c.entries[key]; ok {
		return ent.etag
	}
	return ""
}

// refresh 打上游并写回缓存，同时对同 key 的并发调用去重。
//
// staleTTL 决定「上游失败时是否允许退回旧值」：为 0 时必须把错误暴露出去，
// 否则调用方会以为拿到的是新鲜数据。
func (c *Cache) refresh(key string, ttl time.Duration, prevETag string, staleTTL time.Duration, f Fetcher) ([]byte, CacheState, error) {
	c.mu.Lock()
	if cl, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-cl.done
		return cl.data, StateFetched, cl.err
	}
	cl := &call{done: make(chan struct{})}
	c.inflight[key] = cl
	c.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	data, etag, notModified, err := f(ctx, prevETag)

	var out []byte
	if notModified {
		// 上游确认内容未变：沿用旧值，只刷新时间戳与过期时间
		c.mu.Lock()
		if ent, ok := c.entries[key]; ok {
			ent.expiresAt = c.now().Add(ttl)
			ent.fetchedAt = c.now()
			if etag != "" {
				ent.etag = etag
			}
			out = ent.val
		}
		c.mu.Unlock()
	} else if err == nil {
		c.mu.Lock()
		c.entries[key] = &entry{
			val:       data,
			etag:      etag,
			fetchedAt: c.now(),
			expiresAt: c.now().Add(ttl),
		}
		c.mu.Unlock()
		out = data
	}

	cl.data, cl.err = out, err
	c.mu.Lock()
	delete(c.inflight, key)
	c.mu.Unlock()
	close(cl.done)

	if err != nil {
		// 上游失败时，只有在配置允许的 stale 窗口内才退回旧值 ——
		// staleTTL=0 的调用方（如期号目录）必须拿到错误，而不是过期数据。
		if staleTTL > 0 {
			c.mu.RLock()
			ent, ok := c.entries[key]
			c.mu.RUnlock()
			if ok && c.now().Sub(ent.expiresAt) <= staleTTL {
				return ent.val, StateStale, nil
			}
		}
		return nil, "", err
	}
	return out, StateFetched, nil
}

// FetchedAt 返回某 key 的取数时间，用于响应里如实标注数据新鲜度。
func (c *Cache) FetchedAt(key string) (time.Time, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if ent, ok := c.entries[key]; ok {
		return ent.fetchedAt, true
	}
	return time.Time{}, false
}

// Len 供测试与调试使用
func (c *Cache) Len() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}

// Sweep 清理长期未访问的条目，避免内存无界增长（主要针对 B 站按 bvid 建键的部分）。
func (c *Cache) Sweep(maxIdle time.Duration) int {
	cutoff := c.now().Add(-maxIdle)
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for k, ent := range c.entries {
		if ent.expiresAt.Before(cutoff) {
			delete(c.entries, k)
			n++
		}
	}
	return n
}
