package main

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

const buildVersion = "1.0.0"

// Duration 包一层 time.Duration，让配置里可以写 "30d" 这种天级单位
// （标准库只认到 "h"）。同时支持 YAML 里的纯数字，按秒解释。
type Duration time.Duration

func (d Duration) D() time.Duration { return time.Duration(d) }

// String 让日志与 --check 输出可读（默认会打出纳秒整数）
func (d Duration) String() string { return time.Duration(d).String() }

func (d *Duration) UnmarshalYAML(node *yaml.Node) error {
	raw := strings.TrimSpace(node.Value)
	if raw == "" {
		*d = 0
		return nil
	}

	// 纯数字 → 秒
	if n, err := strconv.ParseFloat(raw, 64); err == nil {
		*d = Duration(time.Duration(n * float64(time.Second)))
		return nil
	}

	if v, err := parseDuration(raw); err == nil {
		*d = Duration(v)
		return nil
	}
	return fmt.Errorf("无法解析时长 %q（示例：10s / 5m / 24h / 30d）", raw)
}

// parseDuration 在标准库基础上扩展 d（天）与 w（周）
func parseDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("空时长")
	}

	unit := s[len(s)-1]
	switch unit {
	case 'd', 'D':
		n, err := strconv.ParseFloat(strings.TrimSpace(s[:len(s)-1]), 64)
		if err != nil {
			return 0, err
		}
		return time.Duration(n * float64(24*time.Hour)), nil
	case 'w', 'W':
		n, err := strconv.ParseFloat(strings.TrimSpace(s[:len(s)-1]), 64)
		if err != nil {
			return 0, err
		}
		return time.Duration(n * float64(7*24*time.Hour)), nil
	}
	return time.ParseDuration(s)
}

// ── 配置结构 ─────────────────────────────────────────────────────

type Config struct {
	// 监听地址，形如 ":9983" 或 "0.0.0.0:9983"
	Listen string `yaml:"listen"`

	Upstream  UpstreamConfig  `yaml:"upstream"`
	Cache     CacheConfig     `yaml:"cache"`
	RateLimit RateLimitConfig `yaml:"rate_limit"`
	CORS      CORSConfig      `yaml:"cors"`
	Log       LogConfig       `yaml:"log"`
}

type UpstreamConfig struct {
	Weekly   string   `yaml:"weekly"`
	Bilibili string   `yaml:"bilibili"`
	Timeout  Duration `yaml:"timeout"`
	// 转发给上游的 UA。留空则用内置的桌面 Chrome UA。
	UserAgent string `yaml:"user_agent"`
}

type CacheConfig struct {
	// 当期数据（latest.json）。一天一变，取短 TTL。
	LatestTTL Duration `yaml:"latest_ttl"`
	// 期号目录（info.json）。
	InfoTTL Duration `yaml:"info_ttl"`
	// 已发布的历史期。发布即冻结，配合 ETag 条件请求复核，可以缓存很久。
	RankTTL Duration `yaml:"rank_ttl"`
	// B 站六项数据，分钟级变化。
	BiliTTL Duration `yaml:"bili_ttl"`
	// 上游挂掉后，仍允许回吐多旧的 B 站数据。设为 0 表示不回吐过期数据。
	BiliStaleTTL Duration `yaml:"bili_stale_ttl"`
	// b23.tv 短链解析结果，几乎不变。
	ResolveTTL Duration `yaml:"resolve_ttl"`
	// 当期数据「距成为历史期不足这个时长」时，仍沿用 LatestTTL 而不是 RankTTL
	RankTTLGrace Duration `yaml:"rank_ttl_grace"`
	// ETag 条件请求的最小间隔，避免频繁 304 打上游
	RevalidateMinInterval Duration `yaml:"revalidate_min_interval"`
}

type RateLimitConfig struct {
	// 每分钟允许的请求数（按 IP）。0 表示不限流。
	WeeklyPerMinute int `yaml:"weekly_per_minute"`
	BiliPerMinute   int `yaml:"bili_per_minute"`
	// 令牌桶容量，允许的瞬时突发
	Burst int `yaml:"burst"`
	// 只有来自这些来源的请求才被信任去读 real_ip_header。
	// 支持关键字 "cloudflare" 或 CIDR（"173.245.48.0/20"）。
	// 直连暴露时务必留空，否则伪造头即可绕过限流。
	TrustedProxies []string `yaml:"trusted_proxies"`
	RealIPHeader   string   `yaml:"real_ip_header"`
	// 停用多久的桶会被回收
	BucketIdleTimeout Duration `yaml:"bucket_idle_timeout"`
}

type CORSConfig struct {
	// 允许的来源白名单。写 "*" 表示不限制（浏览器层等同无保护）。
	AllowedOrigins []string `yaml:"allowed_origins"`
	AllowedMethods []string `yaml:"allowed_methods"`
	AllowedHeaders []string `yaml:"allowed_headers"`
	MaxAge         Duration `yaml:"max_age"`
}

type LogConfig struct {
	Level     string `yaml:"level"`
	AccessLog bool   `yaml:"access_log"`
	// JSON 输出便于日志采集；默认文本更适合直接看
	JSON bool `yaml:"json"`
}

// ── 默认值与加载 ─────────────────────────────────────────────────

func defaultConfig() *Config {
	return &Config{
		Listen: ":9983",
		Upstream: UpstreamConfig{
			Weekly:    "https://www.evocalrank.com",
			Bilibili:  "https://api.bilibili.com",
			Timeout:   Duration(10 * time.Second),
			UserAgent: defaultUserAgent,
		},
		Cache: CacheConfig{
			LatestTTL:             Duration(5 * time.Minute),
			InfoTTL:               Duration(30 * time.Minute),
			RankTTL:               Duration(24 * time.Hour),
			BiliTTL:               Duration(90 * time.Second),
			BiliStaleTTL:          Duration(24 * time.Hour),
			ResolveTTL:            Duration(1 * time.Hour),
			RankTTLGrace:          Duration(2 * time.Hour),
			RevalidateMinInterval: Duration(5 * time.Minute),
		},
		RateLimit: RateLimitConfig{
			WeeklyPerMinute:   60,
			BiliPerMinute:     20,
			Burst:             10,
			RealIPHeader:      "CF-Connecting-IP",
			BucketIdleTimeout: Duration(10 * time.Minute),
		},
		CORS: CORSConfig{
			AllowedOrigins: []string{"*"},
			AllowedMethods: []string{"GET", "OPTIONS"},
			AllowedHeaders: []string{"content-type"},
			MaxAge:         Duration(24 * time.Hour),
		},
		Log: LogConfig{Level: "info", AccessLog: true},
	}
}

// LoadConfig 读取 YAML；文件不存在时用默认值并给出提示。
func LoadConfig(path string) (*Config, error) {
	cfg := defaultConfig()

	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			// 允许无配置文件启动，全部走默认值 —— 方便先把服务跑起来
			return cfg, nil
		}
		return nil, fmt.Errorf("读取 %s: %w", path, err)
	}

	// 严格模式：配置里写错的键直接报错，而不是被静默忽略
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	if err := dec.Decode(cfg); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", path, err)
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Validate 补齐缺省项并检查明显错误
func (c *Config) Validate() error {
	if strings.TrimSpace(c.Listen) == "" {
		return fmt.Errorf("listen 不能为空")
	}
	if c.Upstream.Weekly == "" {
		return fmt.Errorf("upstream.weekly 不能为空")
	}
	if c.Upstream.Bilibili == "" {
		return fmt.Errorf("upstream.bilibili 不能为空")
	}
	c.Upstream.Weekly = strings.TrimRight(c.Upstream.Weekly, "/")
	c.Upstream.Bilibili = strings.TrimRight(c.Upstream.Bilibili, "/")

	if c.Upstream.Timeout.D() <= 0 {
		c.Upstream.Timeout = Duration(10 * time.Second)
	}
	if c.Upstream.UserAgent == "" {
		c.Upstream.UserAgent = defaultUserAgent
	}
	if c.Cache.LatestTTL.D() <= 0 {
		c.Cache.LatestTTL = Duration(5 * time.Minute)
	}
	if c.Cache.InfoTTL.D() <= 0 {
		c.Cache.InfoTTL = Duration(30 * time.Minute)
	}
	if c.Cache.RankTTL.D() <= 0 {
		c.Cache.RankTTL = Duration(24 * time.Hour)
	}
	if c.Cache.BiliTTL.D() <= 0 {
		c.Cache.BiliTTL = Duration(90 * time.Second)
	}
	if c.Cache.ResolveTTL.D() <= 0 {
		c.Cache.ResolveTTL = Duration(1 * time.Hour)
	}
	if c.Cache.RevalidateMinInterval.D() < 0 {
		c.Cache.RevalidateMinInterval = 0
	}
	if c.RateLimit.Burst <= 0 {
		c.RateLimit.Burst = 10
	}
	if c.RateLimit.RealIPHeader == "" {
		c.RateLimit.RealIPHeader = "CF-Connecting-IP"
	}
	if c.RateLimit.BucketIdleTimeout.D() <= 0 {
		c.RateLimit.BucketIdleTimeout = Duration(10 * time.Minute)
	}
	if len(c.CORS.AllowedOrigins) == 0 {
		c.CORS.AllowedOrigins = []string{"*"}
	}
	if len(c.CORS.AllowedMethods) == 0 {
		c.CORS.AllowedMethods = []string{"GET", "OPTIONS"}
	}
	if len(c.CORS.AllowedHeaders) == 0 {
		c.CORS.AllowedHeaders = []string{"content-type"}
	}
	if c.CORS.MaxAge.D() < 0 {
		c.CORS.MaxAge = 0
	}

	// 直连暴露 + 信任代理头 = 可以被伪造 IP 绕过限流，属于危险组合，直接拒绝启动
	if len(c.RateLimit.TrustedProxies) > 0 && (c.RateLimit.WeeklyPerMinute > 0 || c.RateLimit.BiliPerMinute > 0) {
		if _, err := buildIPMatcher(c.RateLimit.TrustedProxies); err != nil {
			return fmt.Errorf("rate_limit.trusted_proxies: %w", err)
		}
	}
	return nil
}

func (c *Config) allowedOriginSet() map[string]bool {
	set := make(map[string]bool, len(c.CORS.AllowedOrigins))
	for _, o := range c.CORS.AllowedOrigins {
		set[strings.TrimSpace(o)] = true
	}
	return set
}

func newLogger(cfg LogConfig) *slog.Logger {
	var level slog.Level
	switch strings.ToLower(cfg.Level) {
	case "debug":
		level = slog.LevelDebug
	case "warn", "warning":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if cfg.JSON {
		h = slog.NewJSONHandler(os.Stdout, opts)
	} else {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	return slog.New(h)
}
