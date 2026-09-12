package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	// 单个上游响应体的上限。周刊 74 KB、B 站 view 接口约 128 KB（合集展开），
	// 4 MB 足够宽松又能防住上游抽风返回超大响应把内存吃爆。
	maxUpstreamBytes = 4 << 20

	cacheKeyInfo       = "weekly:info"
	cacheKeyLatest     = "weekly:latest"
	cacheKeyRankPrefix = "weekly:rank:"
	cacheKeyBiliPrefix = "bili:stats:"
	cacheKeyResolve    = "bili:resolve:"

	// 内置 UA。注意 B 站请求要带上它 —— 实测裸请求也能过，但带上更稳。
	defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
)

// Server 持有配置、HTTP 客户端与各层缓存。
type Server struct {
	cfg       *Config
	logger    *slog.Logger
	client    *http.Client
	cache     *Cache
	limiter   *RateLimiter
	trusted   *ipMatcher
	origins   map[string]bool
	allowAll  bool
	startedAt time.Time
}

func NewServer(cfg *Config, logger *slog.Logger) (*Server, error) {
	if logger == nil {
		logger = slog.Default()
	}

	var trusted *ipMatcher
	if len(cfg.RateLimit.TrustedProxies) > 0 {
		m, err := buildIPMatcher(cfg.RateLimit.TrustedProxies)
		if err != nil {
			return nil, err
		}
		trusted = m
	}

	origins := cfg.allowedOriginSet()
	_, allowAll := origins["*"]

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ForceAttemptHTTP2:     true,
	}

	s := &Server{
		cfg:       cfg,
		logger:    logger,
		client:    &http.Client{Transport: transport, Timeout: cfg.Upstream.Timeout.D()},
		cache:     NewCache(),
		trusted:   trusted,
		origins:   origins,
		allowAll:  allowAll,
		startedAt: time.Now(),
	}
	s.limiter = NewRateLimiter(
		map[string]int{
			classWeekly: cfg.RateLimit.WeeklyPerMinute,
			classBili:   cfg.RateLimit.BiliPerMinute,
		},
		cfg.RateLimit.Burst,
		cfg.RateLimit.BucketIdleTimeout.D(),
	)
	return s, nil
}

const (
	classWeekly = "weekly"
	classBili   = "bili"
)

// Handler 组装路由与中间件。
//
// 路径用普通 pattern（不用 Go 1.22 的 "GET /path" 语法），因为本机装的是
// Go 1.21.1 —— 用了那一套会直接 panic。方法校验由 methodGate 承担，
// 这样在任何 Go 版本上行为都确定，也不需要第三方路由库。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	get := func(h http.HandlerFunc) http.HandlerFunc { return methodGate(h) }

	mux.HandleFunc("/api/healthz", get(s.handleHealth))
	mux.HandleFunc("/api/weekly/info", get(s.withLimit(classWeekly, s.handleWeeklyInfo)))
	mux.HandleFunc("/api/weekly/latest", get(s.withLimit(classWeekly, s.handleWeeklyLatest)))
	mux.HandleFunc("/api/weekly/rank", get(s.withLimit(classWeekly, s.handleWeeklyRank)))
	mux.HandleFunc("/api/bili/stats", get(s.withLimit(classBili, s.handleBiliStats)))
	mux.HandleFunc("/api/bili/batch", get(s.withLimit(classBili, s.handleBiliBatch)))
	mux.HandleFunc("/api/bili/resolve", get(s.withLimit(classBili, s.handleBiliResolve)))

	// 兜底：未知路径返回 JSON，而不是 Go 默认的 HTML 404
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeError(w, r, http.StatusNotFound, "not found")
	})

	var h http.Handler = mux
	h = s.corsMiddleware(h)
	h = s.accessLogMiddleware(h)
	h = s.recoverMiddleware(h)
	return h
}

// methodGate 只放行 GET 与 OPTIONS（预检由 corsMiddleware 统一处理头）。
func methodGate(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET, OPTIONS")
			writeError(w, r, http.StatusMethodNotAllowed, "只支持 GET")
			return
		}
		next(w, r)
	}
}

// ── 中间件 ───────────────────────────────────────────────────────

func (s *Server) recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.logger.Error("处理请求时 panic", "path", r.URL.Path, "panic", fmt.Sprint(rec))
				writeError(w, r, http.StatusInternalServerError, "服务内部错误")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}

func (sr *statusRecorder) Write(b []byte) (int, error) {
	if sr.status == 0 {
		sr.status = http.StatusOK
	}
	n, err := sr.ResponseWriter.Write(b)
	sr.bytes += n
	return n, err
}

func (s *Server) accessLogMiddleware(next http.Handler) http.Handler {
	if !s.cfg.Log.AccessLog {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)

		level := slog.LevelInfo
		if rec.status >= 500 {
			level = slog.LevelWarn
		}
		s.logger.Log(r.Context(), level, "request",
			"method", r.Method,
			"path", r.URL.Path,
			"query", r.URL.RawQuery,
			"status", rec.status,
			"bytes", rec.bytes,
			"ms", time.Since(start).Milliseconds(),
			"ip", clientIP(r, s.trusted, s.cfg.RateLimit.RealIPHeader),
		)
	})
}

// corsMiddleware 处理跨域。
//
// 注意：CORS 响应头**不是访问控制** —— 它只是浏览器自愿遵守的规则。
// 爬虫用 curl 完全不看 Access-Control-Allow-Origin。所以这里的作用是
// 「允许我们自己的前端在浏览器里读响应」，不是「防止别人刷接口」。
// 真正防刷靠限流。
func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		switch {
		case s.allowAll:
			w.Header().Set("Access-Control-Allow-Origin", "*")
		case origin != "" && s.origins[origin]:
			w.Header().Set("Access-Control-Allow-Origin", origin)
			// 同一份数据对不同来源响应不同，避免中间缓存串味
			w.Header().Add("Vary", "Origin")
		}

		if s.allowAll || (origin != "" && s.origins[origin]) {
			w.Header().Set("Access-Control-Allow-Methods", strings.Join(s.cfg.CORS.AllowedMethods, ", "))
			w.Header().Set("Access-Control-Allow-Headers", strings.Join(s.cfg.CORS.AllowedHeaders, ", "))
			if ma := int(s.cfg.CORS.MaxAge.D().Seconds()); ma > 0 {
				w.Header().Set("Access-Control-Max-Age", fmt.Sprint(ma))
			}
		}

		next.ServeHTTP(w, r)
	})
}

// withLimit 是限流中间件。超限返回 429 并带 Retry-After。
func (s *Server) withLimit(class string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r, s.trusted, s.cfg.RateLimit.RealIPHeader)
		if !s.limiter.Allow(class, ip) {
			if secs := s.limiter.RetryAfter(class, ip); secs > 0 {
				w.Header().Set("Retry-After", fmt.Sprint(secs))
			}
			s.logger.Warn("限流命中", "class", class, "ip", ip, "path", r.URL.Path)
			writeError(w, r, http.StatusTooManyRequests, "请求过于频繁，请稍后再试")
			return
		}
		next(w, r)
	}
}

// ── 响应工具 ─────────────────────────────────────────────────────

// writeJSONBytes 输出已经序列化好的 JSON 字节。
//
// state 用来标注这次数据是新鲜的还是回吐的旧数据 —— 前端据此显示
// 「数据获取于 …」，让用户知道手上这份成绩单是什么时候的快照。
func (s *Server) writeJSONBytes(w http.ResponseWriter, r *http.Request, data []byte, state CacheState, ttl time.Duration, status int) {
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	if ttl > 0 && state != StateStale {
		h.Set("Cache-Control", fmt.Sprintf("public, max-age=%d", int(ttl.Seconds())))
	} else {
		// 回吐旧数据时不能让中间层或浏览器再缓存一份
		h.Set("Cache-Control", "no-store")
	}
	if state == StateStale {
		h.Set("X-EvRCalc-Stale", "1")
	}

	body := data
	if acceptsGzip(r) && len(data) >= 1024 {
		h.Set("Content-Encoding", "gzip")
		h.Add("Vary", "Accept-Encoding")
		h.Del("Content-Length") // 交给 gzip writer 决定，避免长度不符
		w.WriteHeader(status)
		gz := gzip.NewWriter(w)
		_, _ = gz.Write(data)
		_ = gz.Close()
		return
	}

	h.Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func acceptsGzip(r *http.Request) bool {
	if r == nil {
		return false
	}
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		if strings.EqualFold(strings.TrimSpace(strings.SplitN(part, ";", 2)[0]), "gzip") {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"序列化失败"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, r *http.Request, status int, msg string) {
	writeJSON(w, r, status, map[string]string{"error": msg})
}

// writeUpstreamError 把上游错误统一转成 502，并带上可读原因。
//
// 用 502 而不是让异常冒泡：前端始终能拿到 JSON，也方便展示失败原因。
func writeUpstreamError(w http.ResponseWriter, r *http.Request, err error) {
	if err == nil {
		writeError(w, r, http.StatusBadGateway, "上游请求失败")
		return
	}
	if _, isURLErr := err.(*url.Error); isURLErr {
		writeError(w, r, http.StatusBadGateway, "上游请求失败："+err.Error())
		return
	}
	writeError(w, r, http.StatusBadGateway, err.Error())
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":        true,
		"version":   buildVersion,
		"uptimeSec": int(time.Since(s.startedAt).Seconds()),
		"cacheKeys": s.cache.Len(),
	})
}

// readLimited 读取响应体，超过上限直接报错而不是静默截断 ——
// 截断的 JSON 解析失败更难排查。
func readLimited(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("上游响应超过 %d 字节上限", limit)
	}
	return data, nil
}
