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
		logger.Info("服务启动",
			"listen", cfg.Listen,
			"weekly_upstream", cfg.Upstream.Weekly,
			"bilibili_upstream", cfg.Upstream.Bilibili,
			"cors_origins", cfg.CORS.AllowedOrigins,
			"trusted_proxies", cfg.RateLimit.TrustedProxies,
		)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		logger.Error("监听失败", "err", err)
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
	fmt.Printf("配置文件解析成功\n")
	fmt.Printf("  监听地址      %s\n", cfg.Listen)
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
