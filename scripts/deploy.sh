#!/usr/bin/env bash
# =============================================================
# 拾光 · 一键发布
#   1) 本地构建前端（pnpm build，含类型检查）
#   2) 同步到服务器 /var/www/shiguang 与 /opt/shiguang
#   3) 首次运行会自动初始化服务器（目录 / systemd / Caddy）
#   4) 重启服务并做线上验收
#
# 用法：pnpm deploy             # 正常发布
#       pnpm deploy --check     # 只做线上验收，不构建不发版
#       pnpm deploy --no-build  # 用已有 dist 发布
# =============================================================
set -euo pipefail

HOST="${APP_HOST:-aliyun}"
REMOTE_WEB="${APP_REMOTE_WEB:-/var/www/shiguang}"
REMOTE_APP="${APP_REMOTE_APP:-/opt/shiguang}"
DATA_DIR="${APP_DATA_DIR:-/var/lib/shiguang}"
REMOTE_DL="${APP_REMOTE_DL:-/var/www/download}"
ENV_FILE="${APP_ENV_FILE:-/etc/shiguang.env}"
SITE_URL="${APP_URL:-https://zhuangrongjian.space/shiguang/}"
KEY_FILE="${DEEPSEEK_KEY_FILE:-$HOME/.dsh/.credentials.yaml}"

BUILD=1
CHECK_ONLY=0
WITH_APK=0
for a in "$@"; do
  case "$a" in
    --no-build) BUILD=0 ;;
    --check) CHECK_ONLY=1 ;;
    --with-apk) WITH_APK=1 ;;
  esac
done

cd "$(dirname "$0")/.."
say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m!\033[0m %s\n' "$*"; }
bad() { printf '\033[31m✗\033[0m %s\n' "$*"; }
SSH="ssh -o BatchMode=yes -o ConnectTimeout=15 $HOST"

# ---------------------------------------------------------------
# 线上验收
# ---------------------------------------------------------------
verify() {
  say "线上验收"
  local code
  code=$($SSH "curl -s -o /dev/null -w '%{http_code}' -m 10 '$SITE_URL'" || echo 000)
  printf "  %-58s %s\n" "页面 $SITE_URL" "$code"

  local api
  api=$($SSH "curl -s -m 10 'http://127.0.0.1:8787/api/healthz'" || echo '{}')
  echo "  服务自检：$api"
  # 语音转写通道没配就不要报成功
  if echo "$api" | grep -q '"asr":{"enabled":false'; then
    warn "语音转写未配置（/etc/shiguang.env 里加 SILICONFLOW_API_KEY 后重启即可）"
  fi

  local svc
  svc=$($SSH "systemctl is-active shiguang" || echo unknown)
  printf "  %-58s %s\n" "systemd shiguang" "$svc"

  local bk
  bk=$($SSH "systemctl is-active shiguang-backup.timer 2>/dev/null || echo none")
  local bkn
  bkn=$($SSH "ls -1 /var/backups/shiguang/daily/*.tar.gz 2>/dev/null | wc -l")
  printf "  %-58s %s（%s 个备份包）\n" "备份定时器" "$bk" "$bkn"

  if [ "$code" != "200" ]; then bad "页面没有返回 200"; return 1; fi
  if [ "$svc" != "active" ]; then bad "服务没有跑起来，看：ssh $HOST journalctl -u shiguang -n 50"; return 1; fi
  ok "验收通过"
}

if [ "$CHECK_ONLY" = "1" ]; then
  verify
  exit $?
fi

# ---------------------------------------------------------------
# 1. 构建
# ---------------------------------------------------------------
if [ "$BUILD" = "1" ]; then
  say "构建前端"
  pnpm build
  [ -f dist/index.html ] || { bad "构建产物缺失"; exit 1; }
  ok "构建完成（$(du -sh dist | cut -f1)）"
else
  [ -f dist/index.html ] || { bad "dist 不存在，先执行 pnpm build"; exit 1; }
  warn "跳过构建，使用已有 dist"
fi

# ---------------------------------------------------------------
# 2. 服务器初始化（幂等，已初始化就只更新 unit 与 Caddy 片段）
# ---------------------------------------------------------------
say "同步安装脚本到服务器"
$SSH "mkdir -p '$REMOTE_WEB' '$REMOTE_APP/server/src' '$DATA_DIR' '$REMOTE_DL'"
scp -q -o BatchMode=yes server/shiguang.service "$HOST:/tmp/shiguang.service"
scp -q -o BatchMode=yes server/caddy-snippet.caddyfile "$HOST:/tmp/caddy-snippet.caddyfile"
scp -q -o BatchMode=yes server/install-server.sh "$HOST:/tmp/install-server.sh"
scp -q -o BatchMode=yes server/backup.sh "$HOST:/tmp/backup.sh"
scp -q -o BatchMode=yes server/shiguang-backup.service "$HOST:/tmp/shiguang-backup.service"
scp -q -o BatchMode=yes server/shiguang-backup.timer "$HOST:/tmp/shiguang-backup.timer"
ok "已上传"

say "执行服务器初始化（幂等）"
$SSH "bash /tmp/install-server.sh"

# ---------------------------------------------------------------
# 3. 补齐 DeepSeek Key（服务器上没有才补，不覆盖已有的）
# ---------------------------------------------------------------
# 必须用 sk- 前缀判断，否则 .env 里的中文占位符会被误认为已配置
have_key=$($SSH "grep -cE '^DEEPSEEK_API_KEY=sk-[A-Za-z0-9_-]{8,}' '$ENV_FILE' 2>/dev/null || true")
have_key=${have_key:-0}
if [ "$have_key" = "0" ]; then
  KEY="${DEEPSEEK_API_KEY:-}"
  if [ -z "$KEY" ] && [ -f "$KEY_FILE" ]; then
    KEY=$(python3 - "$KEY_FILE" <<'PY'
import re, sys
try:
    txt = open(sys.argv[1], encoding='utf-8').read()
    m = re.search(r'DEEPSEEK_API_KEY:\s*(\S+)', txt)
    print(m.group(1) if m else '')
except Exception:
    print('')
PY
)
  fi
  if [ -n "$KEY" ]; then
    say "把 DeepSeek Key 写入服务器（不回显）"
    printf '%s' "$KEY" | $SSH "KEY=\$(cat); \
      sed -i '/^DEEPSEEK_API_KEY=/d' '$ENV_FILE'; \
      printf 'DEEPSEEK_API_KEY=%s\n' \"\$KEY\" >> '$ENV_FILE'; \
      chmod 600 '$ENV_FILE'; \
      grep -c '^DEEPSEEK_API_KEY=sk-' '$ENV_FILE'"
    ok "Key 已写入 $ENV_FILE"
  else
    warn "本地找不到 DeepSeek Key，AI 功能会不可用"
    warn "请手动执行：ssh $HOST \"vi $ENV_FILE\""
  fi
else
  ok "服务器上已有 DeepSeek Key，保持不变"
fi

# ---------------------------------------------------------------
# 4. 同步代码与静态资源
# ---------------------------------------------------------------
say "同步前端到 $REMOTE_WEB"
rsync -az --delete --chmod=D755,F644 -e "ssh -o BatchMode=yes" dist/ "$HOST:$REMOTE_WEB/"
ok "静态资源 $( $SSH "find '$REMOTE_WEB' -type f | wc -l" ) 个文件"

say "同步服务端到 $REMOTE_APP/server"
rsync -az --delete --chmod=D755,F644 -e "ssh -o BatchMode=yes" server/src/ "$HOST:$REMOTE_APP/server/src/"
ok "服务端代码已同步"

# ---------------------------------------------------------------
# 4.5 安卓包（可选）
# ---------------------------------------------------------------
if [ "$WITH_APK" = "1" ]; then
  APK=$(ls -1 android/app/build/outputs/apk/release/*.apk 2>/dev/null | head -1 || true)
  if [ -z "$APK" ]; then
    warn "没找到 APK，请先执行 pnpm build:apk"
  else
    say "上传安卓包（$(du -h "$APK" | cut -f1)）"
    scp -q -o BatchMode=yes "$APK" "$HOST:$REMOTE_DL/shiguang.apk"
    # 版本号以 Android 的 versionName 为准：package.json 的 version 一直是 1.0.0，
    # 拿它命名归档会每个包都叫 1.0.0，分不清是哪一版
    VER=$(sed -n 's/.*versionName "\([^"]*\)".*/\1/p' android/app/build.gradle | head -1)
    VER=${VER:-$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)}
    $SSH "cp -f '$REMOTE_DL/shiguang.apk' '$REMOTE_DL/shiguang-$VER.apk'"
    ok "APK 已上传：$REMOTE_DL/shiguang.apk（归档名 shiguang-$VER.apk）"
  fi
fi

# ---------------------------------------------------------------
# 5. 重启并验收
# ---------------------------------------------------------------
say "重启服务"
$SSH "systemctl daemon-reload; systemctl restart shiguang; sleep 2; systemctl is-active shiguang"

verify
echo
ok "发布完成 → $SITE_URL"
