package main

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// remoteIP 取 TCP 层对端地址（未经任何请求头影响）。
func remoteIP(r *http.Request) net.IP {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}

// 令牌桶限流，按「IP + 接口类别」分桶。
//
// 为什么按类别：B 站接口才是有上游代价的（一条 118 KB 响应 + 会消耗我们这台
// 机器的 IP 信誉），周刊接口只是取静态 JSON。两者限速不该一样。

// ipMatcher 判断某个 IP 是否属于可信来源（例如 Cloudflare 回源网段）
type ipMatcher struct {
	nets []*net.IPNet
	all  bool
}

func (m *ipMatcher) Contains(ip net.IP) bool {
	if m == nil {
		return false
	}
	if m.all {
		return true
	}
	for _, n := range m.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// buildIPMatcher 解析配置里的 trusted_proxies。
// 支持关键字 "cloudflare"、"loopback"、"private" 以及标准 CIDR。
func buildIPMatcher(items []string) (*ipMatcher, error) {
	m := &ipMatcher{}
	for _, raw := range items {
		item := strings.TrimSpace(raw)
		if item == "" {
			continue
		}
		switch strings.ToLower(item) {
		case "*", "all", "any":
			m.all = true
			continue
		case "cloudflare":
			for _, c := range cloudflareCIDRs {
				if _, n, err := net.ParseCIDR(c); err == nil {
					m.nets = append(m.nets, n)
				}
			}
			continue
		case "loopback":
			for _, c := range []string{"127.0.0.0/8", "::1/128"} {
				if _, n, err := net.ParseCIDR(c); err == nil {
					m.nets = append(m.nets, n)
				}
			}
			continue
		case "private":
			for _, c := range []string{
				"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7",
			} {
				if _, n, err := net.ParseCIDR(c); err == nil {
					m.nets = append(m.nets, n)
				}
			}
			continue
		}

		if _, n, err := net.ParseCIDR(item); err == nil {
			m.nets = append(m.nets, n)
			continue
		}
		if ip := net.ParseIP(item); ip != nil {
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			m.nets = append(m.nets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}
		return nil, fmt.Errorf("无法识别的可信代理 %q（支持 cloudflare / loopback / private 或 CIDR）", item)
	}
	return m, nil
}

// cloudflareCIDRs 是 Cloudflare 的官方回源网段（https://www.cloudflare.com/ips/）。
//
// 刻意硬编码而不是启动时去拉取：拉取会让服务启动依赖外部网络，而这份列表变动
// 极少。真的变了，可以在配置里用 CIDR 覆盖。
var cloudflareCIDRs = []string{
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
	"141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
	"197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
	"104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
	"2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
}

// ── 客户端 IP 判定 ───────────────────────────────────────────────

// clientIP 取真实客户端 IP。
//
// 只有在**请求确实来自可信代理**时才读 realIPHeader，否则任何人都能伪造
// CF-Connecting-IP 来绕过限流。这是本文件里最要紧的一条规则。
func clientIP(r *http.Request, trusted *ipMatcher, header string) string {
	remote := remoteIP(r)
	if remote == nil {
		return "unknown"
	}
	if trusted != nil && trusted.Contains(remote) && header != "" {
		if v := strings.TrimSpace(r.Header.Get(header)); v != "" {
			// 该头可能是逗号分隔的链，取第一个
			if i := strings.IndexByte(v, ','); i >= 0 {
				v = strings.TrimSpace(v[:i])
			}
			if ip := net.ParseIP(v); ip != nil {
				return ip.String()
			}
			return v
		}
	}
	return remote.String()
}

// ── 令牌桶 ───────────────────────────────────────────────────────

type bucket struct {
	tokens   float64
	lastSeen time.Time
}

type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	// 每分钟补充的令牌数
	perMinute map[string]float64
	burst     int
	idle      time.Duration
	now       func() time.Time
}

// NewRateLimiter 传 0 表示该类接口不限流。
func NewRateLimiter(perMinute map[string]int, burst int, idle time.Duration) *RateLimiter {
	pm := make(map[string]float64, len(perMinute))
	for k, v := range perMinute {
		pm[k] = float64(v)
	}
	return &RateLimiter{
		buckets:   make(map[string]*bucket),
		perMinute: pm,
		burst:     burst,
		idle:      idle,
		now:       time.Now,
	}
}

// Allow 判断该 ip 在 class 类接口上是否放行。disabled 为 true 时一律放行。
func (l *RateLimiter) Allow(class, ip string) bool {
	if l == nil {
		return true
	}
	rate, ok := l.perMinute[class]
	if !ok || rate <= 0 {
		return true // 该类未配置限流
	}

	now := l.now()
	key := class + "|" + ip

	l.mu.Lock()
	defer l.mu.Unlock()

	b, exists := l.buckets[key]
	if !exists {
		l.buckets[key] = &bucket{tokens: float64(l.burst) - 1, lastSeen: now}
		l.sweepLocked(now)
		return true
	}

	// 按经过时间补充令牌
	elapsed := now.Sub(b.lastSeen).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * (rate / 60.0)
		if b.tokens > float64(l.burst) {
			b.tokens = float64(l.burst)
		}
	}
	b.lastSeen = now

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// RetryAfter 估算还需等待多久才有一个令牌（秒），用于 Retry-After 响应头。
func (l *RateLimiter) RetryAfter(class, ip string) int {
	if l == nil {
		return 0
	}
	rate, ok := l.perMinute[class]
	if !ok || rate <= 0 {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	b, exists := l.buckets[class+"|"+ip]
	if !exists {
		return 0
	}
	need := 1 - b.tokens
	if need <= 0 {
		return 0
	}
	secs := need / (rate / 60.0)
	if secs < 1 {
		return 1
	}
	return int(secs) + 1
}

func (l *RateLimiter) sweepLocked(now time.Time) {
	if l.idle <= 0 {
		return
	}
	for k, b := range l.buckets {
		if now.Sub(b.lastSeen) > l.idle {
			delete(l.buckets, k)
		}
	}
}

// Buckets 供测试与调试使用
func (l *RateLimiter) Buckets() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
