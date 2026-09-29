#!/bin/bash
# =============================================================================
# hrkdeploy.sh - phpmailer-injector 注入程序 VPS 部署脚本
# =============================================================================
# 来源: GUI 内嵌，SSH 上传到 /tmp/hrkdeploy-<uuid>.sh 后执行，执行完即删
#
# 用途: 在 VPS 上下载 phpmailer-injector.tar.gz，安装 PHP + Composer 依赖，
#       生成伪装文件名的包装脚本（如 rsyslog-66a / udev-ag-db4），供 GUI 灌信。
#       包装脚本嵌入每台随机的 version/buildid/填充，使 BinarySha256 各机不同。
#
# 调用方: Warship GUI 通过 SSH 注入以下环境变量后执行本脚本
#
# 脚本结构:
#   0  pre-flight        环境预检 (root/Linux)
#   1  ensure deps       安装 curl/tar 等
#   2  ensure php        安装 php-cli / mbstring / composer
#   3  download source   下载 phpmailer-injector.tar.gz
#   4  composer          composer update --no-dev
#   5  install           安装到 VAR_INSTALL_DIR 并输出 DEPLOY_OK
#
# 退出码:
#   0  = 成功 (最后一行 DEPLOY_OK:路径:sha256)
#   10 = 预检或依赖安装失败
#   12 = 源码 tar.gz 下载/校验失败
#   13 = composer / 源码结构失败
#   14 = 自检失败（二进制无法运行）
# =============================================================================
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
export UCF_FORCE_CONFOLD=1

# 日志/失败辅助函数（输出格式与 GUI 日志解析一致）
log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
fail() { echo "ERROR: $*" >&2; exit "${2:-1}"; }

# ============================================================================
# download_with_fallback: 健壮下载函数
#   策略: 先用 HTTP/2 尝试 3 次 (每次间隔 3 秒), 失败后降级 HTTP/1.1 再尝试 3 次
# ============================================================================
download_with_fallback() {
    local out="$1"
    local url="$2"
    local mode attempt curl_flag rc

    for mode in "http2" "http1.1"; do
        curl_flag=""
        [ "$mode" = "http1.1" ] && curl_flag="--http1.1"

        for attempt in 1 2 3; do
            log "  download attempt [$mode] $attempt/3"
            set +e
            curl -fsSL $curl_flag --connect-timeout 15 --max-time 180 -o "$out" "$url" 2>/dev/null
            rc=$?
            set -e
            if [ $rc -eq 0 ]; then
                log "  download success [$mode] attempt $attempt"
                return 0
            fi
            log "  download failed [$mode] attempt $attempt (curl exit $rc)"
            if [ $attempt -lt 3 ]; then
                sleep 3
            fi
        done

        if [ "$mode" = "http2" ]; then
            log "  http2 exhausted after 3 attempts, falling back to http1.1"
            sleep 3
        fi
    done

    log "  all download attempts exhausted (http2 x3 + http1.1 x3)"
    return 1
}

# ===== 必填环境变量（GUI 在 bash 前 export）=====
# VAR_INSTALL_DIR   安装目录，必须在 /opt 下，如 /opt/kmon-fadf95
# VAR_BINARY_NAME   伪装二进制名，如 rsyslog-66a
# VAR_TASKS_BASE_DIR 任务目录，如 .../tasks
# SRC_TAR_URL       源码 tar.gz 地址（无本地包时才下载）
# SRC_TAR_PRELOADED GUI 已上传到 VPS 的本地 tar.gz（优先于远程 URL）
# SRC_TAR_SHA256    源码 tar.gz 校验和（固定，防篡改）
# 兼容旧变量名 SRC_ZIP_URL / SRC_ZIP_SHA256（仍指向 tar.gz）
: "${VAR_INSTALL_DIR:?missing VAR_INSTALL_DIR}"
: "${VAR_BINARY_NAME:?missing VAR_BINARY_NAME}"
: "${VAR_TASKS_BASE_DIR:?missing VAR_TASKS_BASE_DIR}"
VAR_VERSION="${VAR_VERSION:-0.0.0}"
VAR_BUILDID="${VAR_BUILDID:-$(tr -dc 'a-f0-9' </dev/urandom | head -c32)}"
VAR_GITCOMMIT="${VAR_GITCOMMIT:-$(tr -dc 'a-f0-9' </dev/urandom | head -c40)}"
VAR_MODULE_NAME="${VAR_MODULE_NAME:-phpmailer/core}"
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

WORK_DIR="$(mktemp -d /tmp/hrkdeploy-XXXXXXXX)"

cleanup() {
    local rc=$?
    set +e
    [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ] && rm -rf "$WORK_DIR"
    exit $rc
}
trap cleanup EXIT INT TERM

ensure_cmd() {
    command -v "$1" >/dev/null 2>&1
}

# ===== Step 0: 环境预检 =====
log "pre-flight check"
[ "$(id -u)" = "0" ] || fail "must run as root" 10
[ "$(uname -s)" = "Linux" ] || fail "not linux" 10

# ===== Step 1: 安装基础依赖 =====
NEED=()
for c in curl tar sed grep awk; do
    ensure_cmd "$c" || NEED+=("$c")
done
if [ ${#NEED[@]} -gt 0 ]; then
    log "installing: ${NEED[*]}"
    apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEED[@]}" >/dev/null 2>&1 \
        || fail "apt install failed: ${NEED[*]}" 10
fi

# ===== Step 2: 安装 PHP 运行时 + Composer =====
# apt 可能先配置 phpX.Y-mbstring、后配置 phpX.Y-cli：扩展 postinst 的 phpenmod
# 当时还没有 CLI conf.d，包装上了但 php -m 看不到 mbstring。再 apt install 已装包是空操作。
php_has_ext() {
    command -v php >/dev/null 2>&1 || return 1
    php -r "exit(extension_loaded('$1') ? 0 : 1);" >/dev/null 2>&1
}

apt_install_quiet() {
    local logf rc
    logf="$(mktemp /tmp/hrk-apt-XXXXXX.log)"
    set +e
    apt-get install -y -qq "$@" >"$logf" 2>&1
    rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
        tail -n 40 "$logf" >&2 || true
        rm -f "$logf"
        return "$rc"
    fi
    rm -f "$logf"
    return 0
}

enable_php_exts() {
    local ver mods m ini dest
    hash -r 2>/dev/null || true
    mods="mbstring xml curl"
    if command -v phpenmod >/dev/null 2>&1; then
        for m in $mods; do
            phpenmod -s ALL "$m" >/dev/null 2>&1 || phpenmod "$m" >/dev/null 2>&1 || true
        done
    fi
    ver="$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null || true)"
    [ -n "$ver" ] || return 0
    mkdir -p "/etc/php/${ver}/cli/conf.d"
    for m in $mods; do
        ini="/etc/php/${ver}/mods-available/${m}.ini"
        dest="/etc/php/${ver}/cli/conf.d/20-${m}.ini"
        if [ -f "$ini" ]; then
            ln -sfn "../../mods-available/${m}.ini" "$dest"
        fi
    done
}

ensure_php_runtime() {
    enable_php_exts
    if php_has_ext mbstring; then
        log "php ok ($(php -r 'echo PHP_VERSION;')) mbstring enabled"
        return 0
    fi

    log "installing php-cli php-mbstring php-xml php-curl composer"
    apt-get update -qq >/dev/null 2>&1 || true
    # 先装 CLI，再装扩展，避免 mbstring 在 cli/conf.d 还不存在时被配置
    apt_install_quiet php-cli \
        || fail "apt install php-cli failed" 10
    apt_install_quiet php-mbstring php-xml php-curl composer \
        || fail "apt install php packages failed" 10
    enable_php_exts

    if ! php_has_ext mbstring; then
        ver="$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null || true)"
        if [ -n "$ver" ]; then
            log "retry php${ver}-mbstring for active php $ver"
            apt_install_quiet --reinstall "php${ver}-mbstring" || true
            enable_php_exts
        fi
    fi

    ensure_cmd php || fail "php not found after apt install" 10
    php_has_ext mbstring \
        || fail "php-mbstring still missing after apt install (try: apt install php-mbstring && phpenmod mbstring)" 10
    log "php ok ($(php -r 'echo PHP_VERSION;')) mbstring enabled"
}

ensure_php_runtime
ensure_cmd composer || fail "composer not found after install" 10

# ===== Step 3: 源码 tar.gz（本地预上传优先，不走远程）=====
log "download source"
cd "$WORK_DIR"
if [ -n "${SRC_TAR_PRELOADED:-}" ] && [ -f "$SRC_TAR_PRELOADED" ]; then
    log "use preloaded source: $SRC_TAR_PRELOADED"
    cp "$SRC_TAR_PRELOADED" src.tar.gz \
        || fail "copy preloaded source failed" 12
else
    [ -n "$SRC_TAR_URL" ] || fail "missing SRC_TAR_URL and SRC_TAR_PRELOADED" 12
    download_with_fallback src.tar.gz "$SRC_TAR_URL" \
        || fail "source download failed" 12
fi
echo "$SRC_TAR_SHA256  src.tar.gz" | sha256sum -c --quiet \
    || fail "source sha256 mismatch" 12
tar -xzf src.tar.gz || fail "source extract failed" 12
rm -f src.tar.gz

resolve_src_dir() {
    if [ -f ./injector.php ] && [ -f ./composer.json ]; then
        echo "."
        return 0
    fi
    local d
    for d in ./*/; do
        d="${d%/}"
        [ -d "$d" ] || continue
        if [ -f "$d/injector.php" ] && [ -f "$d/composer.json" ]; then
            echo "$d"
            return 0
        fi
    done
    return 1
}
SRC_DIR="$(resolve_src_dir)" || fail "source dir not found (tar must contain phpmailer-injector/injector.php)" 12
log "source dir: $SRC_DIR"
cd "$SRC_DIR"

[ -f composer.json ] || fail "composer.json missing in source" 13

if grep -qE '"symfony/yaml"\s*:\s*"\^6\.4\|' composer.json 2>/dev/null \
    || grep -qE '"symfony/yaml"\s*:\s*"\^7' composer.json 2>/dev/null; then
    log "patch composer.json symfony/yaml -> ^6.4 (PHP 8.1 compatible)"
    sed -i 's/"symfony\/yaml": "[^"]*"/"symfony\/yaml": "^6.4"/' composer.json
fi
rm -f composer.lock

# ===== Step 4: Composer 安装依赖 =====
log "composer update (PHP $(php -r 'echo PHP_VERSION;'))"
COMPOSER_ALLOW_SUPERUSER=1 composer update --no-dev --no-interaction --optimize-autoloader \
    || fail "composer update failed" 13

[ -f injector.php ] || fail "injector.php missing" 13
[ -f vendor/autoload.php ] || fail "vendor/autoload.php missing" 13

# ===== Step 5: 安装到目标路径 =====
log "install to $VAR_INSTALL_DIR/$VAR_BINARY_NAME"
mkdir -p "$VAR_INSTALL_DIR" "$VAR_TASKS_BASE_DIR"
chmod 0755 "$VAR_INSTALL_DIR" "$VAR_TASKS_BASE_DIR"

tar -cf - \
    --exclude='./.git' \
    --exclude='./tests' \
    --exclude='./deploy' \
    . | tar -xf - -C "$VAR_INSTALL_DIR"

# 入口 PHP 只追加注释，不改发信逻辑；每台 injector.php 哈希不同
printf '\n// variant %s %s %s %s\n' \
    "$VAR_VERSION" "$VAR_BUILDID" "$VAR_GITCOMMIT" "$VAR_MODULE_NAME" \
    >> "$VAR_INSTALL_DIR/injector.php"

# 包装脚本嵌入 build 元数据 + 随机填充（与 GO ELF pad 同类），BinarySha256 每台不同
PAD_N=$((256 + RANDOM % 512))
PAD="$(dd if=/dev/urandom bs=1 count="$PAD_N" 2>/dev/null | base64 | tr -d '\n')"
cat > "$VAR_INSTALL_DIR/$VAR_BINARY_NAME" <<WRAP
#!/usr/bin/env bash
# variant ${VAR_VERSION} ${VAR_BUILDID} ${VAR_GITCOMMIT}
set -euo pipefail
DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
exec /usr/bin/env php "\$DIR/injector.php" "\$@"
# ${PAD}
WRAP
chmod 0755 "$VAR_INSTALL_DIR/$VAR_BINARY_NAME"
chown root:root "$VAR_INSTALL_DIR/$VAR_BINARY_NAME" 2>/dev/null || true

SELF_CHECK="$("$VAR_INSTALL_DIR/$VAR_BINARY_NAME" --help 2>&1)" || {
    echo "self-check output: ${SELF_CHECK:-<empty>}" >&2
    php "$VAR_INSTALL_DIR/injector.php" --help >&2 || true
    fail "installed binary self-check failed" 14
}

FINAL_SHA=$(sha256sum "$VAR_INSTALL_DIR/$VAR_BINARY_NAME" | awk '{print $1}')
echo "$SRC_TAR_SHA256" > "$VAR_INSTALL_DIR/.source_tar_sha256"

echo "DEPLOY_OK:${VAR_INSTALL_DIR}/${VAR_BINARY_NAME}:${FINAL_SHA}"
exit 0
