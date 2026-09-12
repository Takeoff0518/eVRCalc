#!/usr/bin/env bash
#
# eVRCalc 后端构建脚本（Linux / macOS / WSL / Git Bash）
#
# 用法：
#   ./build.sh                    # 默认编当前平台
#   ./build.sh linux-amd64        # 交叉编译到 Linux x86_64
#   ./build.sh linux-arm64        # Linux aarch64（树莓派 4/5 64 位、各类 ARM 服务器）
#   ./build.sh linux-armv7        # 32 位 ARM（较老的树莓派）
#   ./build.sh windows-amd64      # Windows
#   ./build.sh all                # 上面全部
#   ./build.sh clean              # 清掉 dist/
#
# 产物在 server/dist/，文件名带平台后缀，便于直接 scp 上机。

set -euo pipefail

cd "$(dirname "$0")"

VERSION="${VERSION:-1.0.0}"
OUT_DIR="${OUT_DIR:-dist}"

# 把 Go 构建缓存放进仓库内（仅在默认位置不可写时才需要）。
# 本机 C:\Users\<user>\AppData\Local\go-build 被沙箱/安全软件拦着，
# 不设这个变量时 go build 会以 "failed to initialize build cache ... Access is denied"
# 失败。在正常机器上设了也无害。
REPO_ROOT="$(cd .. && pwd)"
export GOCACHE="${GOCACHE:-$REPO_ROOT/.gocache}"
export GOTMPDIR="${GOTMPDIR:-$REPO_ROOT/.gotmp}"
mkdir -p "$GOCACHE" "$GOTMPDIR"

# -trimpath          去掉本机绝对路径，构建可复现、也不泄露目录结构
# -s -w              去掉符号表与调试信息（体积约小 30%）
# -X main.buildVersion  把版本号注入进去，--version 才不是写死的
LDFLAGS="-s -w -X main.buildVersion=${VERSION}"

build_one() {
  local goos="$1" goarch="$2" goarm="${3:-}" label="$4"
  local suffix=""
  [ -n "$goarm" ] && suffix="v${goarm}"
  local out="${OUT_DIR}/evrcalc-server-${label}"

  echo "  → ${label}  (GOOS=${goos} GOARCH=${goarch}${goarm:+ GOARM=${goarm}})"
  env GOOS="$goos" GOARCH="$goarch" ${goarm:+GOARM="$goarm"} CGO_ENABLED=0 \
    go build -trimpath -ldflags "$LDFLAGS" -o "$out" .

  local size
  size=$(wc -c < "$out" | tr -d ' ')
  echo "     $out  ($(( size / 1024 )) KB)"
}

# 单个目标名（linux-amd64）→ 平台三元组
build_named() {
  case "$1" in
    linux-amd64)   build_one linux amd64 ""      linux-amd64 ;;
    linux-arm64)   build_one linux arm64 ""      linux-arm64 ;;
    linux-armv7)   build_one linux arm   7       linux-armv7 ;;
    linux-386)     build_one linux 386   ""      linux-386 ;;
    windows-amd64) build_one windows amd64 ""    windows-amd64.exe ;;
    darwin-arm64)  build_one darwin arm64 ""     darwin-arm64 ;;
    darwin-amd64)  build_one darwin amd64 ""     darwin-amd64 ;;
    *)
      echo "未知目标：$1" >&2
      echo "可用：linux-amd64 linux-arm64 linux-armv7 linux-386 windows-amd64 darwin-arm64 darwin-amd64 all clean" >&2
      exit 1
      ;;
  esac
}

ALL_TARGETS="linux-amd64 linux-arm64 linux-armv7 linux-386 windows-amd64 darwin-arm64 darwin-amd64"

case "${1:-native}" in
  clean)
    rm -rf "$OUT_DIR"
    echo "已清理 ${OUT_DIR}/"
    ;;
  all)
    mkdir -p "$OUT_DIR"
    echo "构建全部平台（版本 ${VERSION}）"
    for t in $ALL_TARGETS; do build_named "$t"; done
    ;;
  native)
    mkdir -p "$OUT_DIR"
    echo "构建当前平台（版本 ${VERSION}）"
    build_one "" "" "" "native"
    ;;
  *)
    mkdir -p "$OUT_DIR"
    echo "构建 ${1}（版本 ${VERSION}）"
    build_named "$1"
    ;;
esac

echo
echo "完成。产物："
ls -la "$OUT_DIR" 2>/dev/null || true
