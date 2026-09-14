package main

import "testing"

// ── 分享文案（从 B 站 App 复制的「标题 + 空格 + 链接」）─────────────
//
// 线上真实故障复现：用户把 App 里复制的一整段粘进输入框，
// /api/bili/resolve 返回 404。根因是解析层用 url.Parse 去啃整段文字，
// 把开头的 https 当成 scheme、把后面的中文当成 opaque data，得到空 Host，
// 于是「域名可信」这道校验不通过，整个链接分支被静默跳过。
func TestParseBiliRefHandlesShareText(t *testing.T) {
	// 一字不改的线上输入
	shareText := "【【洛天依原创】线条与色彩丨致仍手握画笔的你】 https://www.bilibili.com/video/BV1UVtb6PENV/?share_source=copy_web&vd_source=701f14b1944b350b54b777bd57dbd0eb"

	got := ParseBiliRef(shareText)
	if got.Kind != "url-bvid" || got.Bvid != "BV1UVtb6PENV" {
		t.Errorf("分享文案应解析出 BV1UVtb6PENV，实际 kind=%s bvid=%q aid=%q",
			got.Kind, got.Bvid, got.Aid)
	}
	if got.Raw != shareText {
		t.Error("Raw 应原样保留用户输入，便于界面回显")
	}

	// 各种同源形态：移动端、无 scheme、末尾没有斜杠、链接在前
	more := map[string]string{
		"标题 https://m.bilibili.com/video/BV1UVtb6PENV":              "BV1UVtb6PENV",
		"【标题】www.bilibili.com/video/BV1UVtb6PENV":                  "BV1UVtb6PENV",
		"标题 www.bilibili.com/video/BV1UVtb6PENV":                    "BV1UVtb6PENV",
		"标题 https://www.bilibili.com/video/BV1UVtb6PENV":            "BV1UVtb6PENV",
		"https://www.bilibili.com/video/BV1UVtb6PENV 分享自 bilibili": "BV1UVtb6PENV",
	}

	// av 形态的分享文案也要认（kind 是 url-avid，Bvid 为空）
	if got := ParseBiliRef("标题 https://www.bilibili.com/video/av116078873153625"); got.Aid != "116078873153625" {
		t.Errorf("av 分享文案应解析出 aid，实际 %+v", got)
	}
	for in, wantBv := range more {
		if got := ParseBiliRef(in); got.Bvid != wantBv {
			t.Errorf("ParseBiliRef(%q) 应得到 %s，实际 %+v", in, wantBv, got)
		}
	}

	// 中文标点紧跟在链接后面时必须被切开，否则 BV 号会被污染
	withPunct := "看看这个 https://www.bilibili.com/video/BV1UVtb6PENV，很不错"
	if got := ParseBiliRef(withPunct); got.Bvid != "BV1UVtb6PENV" {
		t.Errorf("链接后接中文逗号时 BV 号应完整，实际 %+v", got)
	}
}

// 分享文案里混进别的域名时，只信 B 站那个；一个都不可信就整体判无效。
// 这是「不能替任意站点做跳板」这条底线在文字场景下的延伸。
func TestParseBiliRefShareTextHostTrust(t *testing.T) {
	// 前面挂一个外站链接，后面才是真的 B 站链接 —— 必须取 B 站那个
	mixed := "https://evil.example/watch/BV1xx411c7mD 然后 https://www.bilibili.com/video/BV1UVtb6PENV"
	if got := ParseBiliRef(mixed); got.Bvid != "BV1UVtb6PENV" {
		t.Errorf("应跳过不可信域名、取 B 站链接，实际 %+v", got)
	}

	// 全是外站链接：整体无效，不得顺路提取出 BV 号
	for _, in := range []string{
		"标题 https://evil.example/watch/BV1UVtb6PENV",
		"标题 http://169.254.169.254/latest/meta-data/BV1UVtb6PENV",
		"标题 https://bilibili.com.evil.example/BV1UVtb6PENV",
	} {
		if got := ParseBiliRef(in); got.Kind != "invalid" {
			t.Errorf("ParseBiliRef(%q) 应判为 invalid，实际 kind=%s bvid=%s", in, got.Kind, got.Bvid)
		}
	}
}

// 短链带不带 scheme 都要认出来。老实现的 b23 判定锚在串首（^https?:// 是可选的），
// 改成在整段文字里找链接之后，"https://b23.tv/xxx" 很容易被漏掉。
func TestParseBiliRefShortlinkWithScheme(t *testing.T) {
	for _, in := range []string{
		"https://b23.tv/abcd1234",
		"http://b23.tv/abcd1234",
		"b23.tv/abcd1234",
		"【标题】 https://b23.tv/abcd1234",
	} {
		if got := ParseBiliRef(in); got.Kind != "shortlink" {
			t.Errorf("ParseBiliRef(%q) 应为 shortlink，实际 kind=%s bvid=%s aid=%s",
				in, got.Kind, got.Bvid, got.Aid)
		}
	}
}

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
		{"https://www.bilibili.com/video/BV1JHZNBdEQv?share_source=copy_web&vd_source=701f14b", "url-bvid", "BV1JHZNBdEQv", ""},
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
