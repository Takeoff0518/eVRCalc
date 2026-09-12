// Package main —— eVRCalc 统一后端
//
// 存在的唯一原因：浏览器无法直连上游。
//
//	· www.evocalrank.com 的 JSON 接口从不返回 Access-Control-Allow-Origin
//	· api.bilibili.com 的 WAF 拒绝数据中心 IP（实测 Cloudflare Workers 出口 412），
//	  只放行住宅 IP —— 所以这一层必须跑在家里那台机器上
//
// 本后端同时承担周刊查询与 B 站数据解析，前端（GitHub Pages）跨域访问它。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const defaultConfigPath = "server.yaml"

func main() {
	var (
		configPath  = flag.String("config", defaultConfigPath, "YAML 配置文件路径")
		checkOnly   = flag.Bool("check", false, "只校验配置与上游连通性，不启动服务")
		showVersion = flag.Bool("version", false, "打印版本后退出")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("evrcalc-server %s\n", buildVersion)
		return
	}

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "配置加载失败: %v\n", err)
		os.Exit(1)
	}

	logger := newLogger(cfg.Log)
	slog.SetDefault(logger)

	if *checkOnly {
		runConfigCheck(cfg, logger)
		return
	}

	srv, err := NewServer(cfg, logger)
	if err != nil {
		logger.Error("初始化失败", "err", err)
		os.Exit(1)
	}

	// 证书在真正监听之前才做严格检查 —— 这样 `--check` 能在证书还没放上去时
	// 用来排查配置本身（DNS、端口、上游连通性），不至于因为缺文件就整个跑不了
	if err := cfg.TLS.ValidateFiles(); err != nil {
		logger.Error("TLS 配置有问题", "err", err)
		os.Exit(1)
	}

	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second, // 上游慢时留足余量
		IdleTimeout:       120 * time.Second,
	}

	// 优雅退出：收到信号后停止接收新连接，给在途请求 10 秒收尾
	errCh := make(chan error, 1)
	go func() {
		scheme := "http"
		if cfg.TLS.IsEnabled() {
			scheme = "https"
		}
		logger.Info("服务启动",
			"listen", cfg.Listen,
			"scheme", scheme,
			"weekly_upstream", cfg.Upstream.Weekly,
			"bilibili_upstream", cfg.Upstream.Bilibili,
			"cors_origins", cfg.CORS.AllowedOrigins,
			"trusted_proxies", cfg.RateLimit.TrustedProxies,
		)

		var err error
		if cfg.TLS.IsEnabled() {
			// 用 ListenAndServeTLS 而不是自己包 tls.Listener：它会在启动时
			// 校验证书能否解析，坏证书立刻失败，而不是等第一个请求才炸
			err = httpSrv.ListenAndServeTLS(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		} else {
			err = httpSrv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		logger.Error("监听失败", "err", err)

		// 这两类失败几乎占了全部，给出可操作的提示比丢一个裸错误有用得多
		if cfg.TLS.IsEnabled() {
			fmt.Fprintf(os.Stderr, "\nHTTPS 启动失败，请检查证书：\n  cert = %s\n  key  = %s\n",
				cfg.TLS.CertFile, cfg.TLS.KeyFile)
		} else {
			fmt.Fprintf(os.Stderr, "\n当前以**明文 HTTP** 启动。如果前端页面在 https 下，\n"+
				"浏览器会拦截跨域的 http 请求（混合内容），必须在 server.yaml 里配置 tls.* 启用 HTTPS。\n")
		}
		msg := strings.ToLower(err.Error())
		if strings.Contains(msg, "address already in use") || strings.Contains(msg, "only one usage") {
			fmt.Fprintf(os.Stderr, "\n端口 %s 已被占用：很可能是上一次的进程还没退出。\n", cfg.Listen)
		}
		os.Exit(1)
	case sig := <-stop:
		logger.Info("收到退出信号，正在关闭", "signal", sig.String())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(ctx); err != nil {
		logger.Warn("关闭超时，强制退出", "err", err)
	}
	logger.Info("已退出")
}

// runConfigCheck 打印生效配置并试探上游连通性，用于部署后自检。
func runConfigCheck(cfg *Config, logger *slog.Logger) {
	scheme := "http"
	if cfg.TLS.IsEnabled() {
		scheme = "https"
	}

	fmt.Printf("配置文件解析成功\n")
	fmt.Printf("  监听地址      %s（%s）\n", cfg.Listen, strings.ToUpper(scheme))
	if cfg.TLS.IsEnabled() {
		fmt.Printf("  证书          %s\n", cfg.TLS.CertFile)
		fmt.Printf("  私钥          %s\n", cfg.TLS.KeyFile)
	}
	fmt.Printf("  周刊上游      %s\n", cfg.Upstream.Weekly)
	fmt.Printf("  B 站上游      %s\n", cfg.Upstream.Bilibili)
	fmt.Printf("  上游超时      %s\n", cfg.Upstream.Timeout)
	fmt.Printf("  CORS 白名单   %v\n", cfg.CORS.AllowedOrigins)
	fmt.Printf("  可信代理      %v\n", cfg.RateLimit.TrustedProxies)
	fmt.Printf("  缓存 TTL      当期=%s 目录=%s 历史=%s B站=%s B站过期=%s\n",
		cfg.Cache.LatestTTL, cfg.Cache.InfoTTL, cfg.Cache.RankTTL,
		cfg.Cache.BiliTTL, cfg.Cache.BiliStaleTTL)
	fmt.Printf("  限流          周刊=%d/min  B站=%d/min  burst=%d\n",
		cfg.RateLimit.WeeklyPerMinute, cfg.RateLimit.BiliPerMinute, cfg.RateLimit.Burst)
	fmt.Printf("  日志级别      %s\n", cfg.Log.Level)

	// 前端在 GitHub Pages（https），所以明文 HTTP 的后端根本调不通。
	// 这是实际部署时最容易踩且最难自己看出来的坑，因此在这里明确点出来。
	if !cfg.TLS.IsEnabled() {
		fmt.Printf("\n  ⚠ 未启用 HTTPS。若前端页面在 https 下，浏览器会拦截跨域的 http 请求\n")
		fmt.Printf("    （混合内容），界面会一直显示「周刊数据不可用」。\n")
		fmt.Printf("    要启用：在 server.yaml 里配置 tls.cert_file / tls.key_file，\n")
		fmt.Printf("    证书签发方式见 DEPLOY.md「域名与端口」。\n")
	} else {
		// 只校验证书能否加载，**不要求文件存在** —— 见上面 ValidateFiles 的注释
		if err := cfg.TLS.ValidateFiles(); err != nil {
			fmt.Printf("\n  [警告] %v\n", err)
			fmt.Printf("    证书还没就位。配置本身是对的，把证书放好即可启动。\n")
		} else {
			fmt.Printf("\n  [OK]   证书加载正常\n")
		}
	}

	srv, err := NewServer(cfg, logger)
	if err != nil {
		fmt.Fprintf(os.Stderr, "初始化失败: %v\n", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	fmt.Printf("\n上游连通性：\n")
	if err := srv.CheckWeeklyUpstream(ctx); err != nil {
		fmt.Printf("  [失败] 周刊  %v\n", err)
	} else {
		fmt.Printf("  [OK]   周刊  %s\n", cfg.Upstream.Weekly)
	}
	if err := srv.CheckBiliUpstream(ctx); err != nil {
		fmt.Printf("  [失败] B 站  %v\n", err)
	} else {
		fmt.Printf("  [OK]   B 站  %s\n", cfg.Upstream.Bilibili)
	}
}
