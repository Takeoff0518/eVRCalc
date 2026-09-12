package main

import "testing"

// ── 标识解析 ─────────────────────────────────────────────────────

func TestParseBiliRef(t *testing.T) {
	cases := []struct {
		in       string
		wantKind string
		wantBv   string
		wantAid  string
	}{
		{"BV1JHZNBdEQv", "bvid", "BV1JHZNBdEQv", ""},
		{"  BV1JHZNBdEQv  ", "bvid", "BV1JHZNBdEQv", ""},
		{"av116078873153625", "avid", "", "116078873153625"},
		{"AV116078873153625", "avid", "", "116078873153625"},
		{"116078873153625", "avid", "", "116078873153625"},
		{"https://www.bilibili.com/video/BV1JHZNBdEQv", "url-bvid", "BV1JHZNBdEQv", ""},
		{"https://www.bilibili.com/video/BV1JHZNBdEQv/?spm_id_from=333.999", "url-bvid", "BV1JHZNBdEQv", ""},
		{"www.bilibili.com/video/BV1JHZNBdEQv", "url-bvid", "BV1JHZNBdEQv", ""},
		{"https://m.bilibili.com/video/BV1JHZNBdEQv", "url-bvid", "BV1JHZNBdEQv", ""},
		{"https://www.bilibili.com/video/av116078873153625/", "url-avid", "", "116078873153625"},
		{"https://www.bilibili.com/video/?aid=116078873153625", "url-avid", "", "116078873153625"},
		{"https://www.bilibili.com/video?bvid=BV1JHZNBdEQv", "url-bvid", "BV1JHZNBdEQv", ""},
		{"https://b23.tv/abcd1234", "shortlink", "", ""},
		{"b23.tv/abcd1234", "shortlink", "", ""},
		{"随便什么文字 BV1JHZNBdEQv 夹杂其中", "bvid", "BV1JHZNBdEQv", ""},
		{"", "invalid", "", ""},
		{"完全不是视频", "invalid", "", ""},
	}

	for _, c := range cases {
		got := ParseBiliRef(c.in)
		if got.Kind != c.wantKind || got.Bvid != c.wantBv || got.Aid != c.wantAid {
			t.Errorf("ParseBiliRef(%q) = {kind:%s bvid:%s aid:%s}, 期望 {kind:%s bvid:%s aid:%s}",
				c.in, got.Kind, got.Bvid, got.Aid, c.wantKind, c.wantBv, c.wantAid)
		}
	}
}

func TestNormalizeRefFillsBvidFromAid(t *testing.T) {
	ref := normalizeRef(BiliRef{Raw: "av116078873153625", Aid: "116078873153625", Kind: "avid"})
	if ref.Bvid != "BV1JHZNBdEQv" {
		t.Fatalf("normalizeRef 未补出 BV 号，得到 %q", ref.Bvid)
	}
}

// 输入是 URL 时域名必须可信，否则任何站点都能借我们"顺路"解析出 BV 号。
// 但纯文本输入（从聊天记录里粘贴的）仍应宽松处理。
func TestParseBiliRefRejectsForeignURLHosts(t *testing.T) {
	foreign := []string{
		"https://evil.example/watch/BV1JHZNBdEQv",
		"https://evil.example/video/av116078873153625",
		"http://notbilibili.com/BV1JHZNBdEQv",
		"https://bilibili.com.evil.example/BV1JHZNBdEQv",
		"https://169.254.169.254/latest/meta-data/BV1JHZNBdEQv",
		"https://127.0.0.1:8080/BV1JHZNBdEQv",
	}
	for _, in := range foreign {
		got := ParseBiliRef(in)
		if got.Kind != "invalid" {
			t.Errorf("ParseBiliRef(%q) 应判为 invalid，实际 kind=%s bvid=%s aid=%s",
				in, got.Kind, got.Bvid, got.Aid)
		}
	}

	// 纯文本（不带域名）仍应宽松提取，否则从聊天里粘贴的文本会解析失败
	loose := map[string]string{
		"看看这个 BV1JHZNBdEQv 挺好的": "BV1JHZNBdEQv",
		"av116078873153625":     "",
		"推荐 BV1JHZNBdEQv":       "BV1JHZNBdEQv",
	}
	for in, wantBv := range loose {
		got := ParseBiliRef(in)
		if wantBv != "" && got.Bvid != wantBv {
			t.Errorf("ParseBiliRef(%q) 应提取出 %s，实际 %+v", in, wantBv, got)
		}
	}

	// B 站自家域名（含子域）必须继续放行
	allowed := map[string]string{
		"https://www.bilibili.com/video/BV1JHZNBdEQv": "BV1JHZNBdEQv",
		"https://m.bilibili.com/video/BV1JHZNBdEQv":   "BV1JHZNBdEQv",
		"https://b23.tv/abc":                          "",
		"www.bilibili.com/video/BV1JHZNBdEQv":         "BV1JHZNBdEQv",
	}
	for in, wantBv := range allowed {
		got := ParseBiliRef(in)
		if wantBv != "" && got.Bvid != wantBv {
			t.Errorf("ParseBiliRef(%q) 应得到 %s，实际 %+v", in, wantBv, got)
		}
		if got.Kind == "invalid" {
			t.Errorf("ParseBiliRef(%q) 不应判为 invalid", in)
		}
	}
}

// ── SSRF 防护 ────────────────────────────────────────────────────

// 短链跟跳必须逐跳校验域名，否则这个接口就是任意 URL 的 SSRF 跳板。
func TestHostAllowedRejectsNonBilibili(t *testing.T) {
	allowed := []string{
		"b23.tv", "www.bilibili.com", "bilibili.com", "m.bilibili.com",
		"api.bilibili.com", "www.biligame.com", "B23.TV", "b23.tv.",
	}
	for _, h := range allowed {
		if !hostAllowed(h) {
			t.Errorf("%q 应被允许", h)
		}
	}

	blocked := []string{
		"127.0.0.1", "localhost", "169.254.169.254", // 云元数据端点
		"10.0.0.1", "192.168.1.1",
		"evil.com", "b23.tv.evil.com", "notbilibili.com",
		"bilibili.com.evil.com", "xn--bilibili.com",
	}
	for _, h := range blocked {
		if hostAllowed(h) {
			t.Errorf("%q 必须被拒绝（SSRF 风险）", h)
		}
	}

	if !hostAllowed("www.bilibili.com:443") {
		t.Error("带端口的合法域名应被允许")
	}
	if hostAllowed("evil.com:80") {
		t.Error("带端口的非法域名必须被拒绝")
	}
}
