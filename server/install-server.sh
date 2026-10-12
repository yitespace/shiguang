#!/usr/bin/env bash
# =============================================================
# 拾光 · 服务器初始化（只需跑一次）
# 由 scripts/deploy.sh 通过 ssh 传到服务器上执行，也可以手动跑：
#   scp server/install-server.sh aliyun:/tmp/ && ssh aliyun 'bash /tmp/install-server.sh'
#
# 做四件事：
#   1) 建目录（/opt/shiguang 代码、/var/lib/shiguang 数据、/var/www/shiguang 静态）
#   2) 写 /etc/shiguang.env（含 DeepSeek Key），权限 600
#   3) 装 systemd 服务
#   4) 把站点片段注入 /etc/caddy/Caddyfile（先备份、再校验、最后热加载）
# =============================================================
set -euo pipefail

APP_DIR=/opt/shiguang
DATA_DIR=/var/lib/shiguang
WEB_DIR=/var/www/shiguang
ENV_FILE=/etc/shiguang.env
CADDY=/etc/caddy/Caddyfile
BEGIN="# >>> shiguang >>>"
END="# <<< shiguang <<<"

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "请用 root 运行"; exit 1; }

# ---------- 1. 目录 ----------
say "创建目录"
mkdir -p "$APP_DIR" "$DATA_DIR" "$WEB_DIR"
chmod 755 "$DATA_DIR"
ok "$APP_DIR / $DATA_DIR / $WEB_DIR"

# ---------- 2. 环境文件 ----------
if [ ! -f "$ENV_FILE" ]; then
  say "写入 $ENV_FILE（默认密码 123456，进站点后请改）"
  cat > "$ENV_FILE" <<'EOF'
# 拾光服务配置
PORT=8787
HOST=127.0.0.1
SHIGUANG_DATA=/var/lib/shiguang
SHIGUANG_DIST=/var/www/shiguang
SHIGUANG_COOKIE_PATH=/shiguang

# DeepSeek
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
DEEPSEEK_API_KEY=请替换成你的key

# 初始访问密码（仅首次启动时生效，之后在「设置」里改）
SHIGUANG_PASSWORD=123456
EOF
  chmod 600 "$ENV_FILE"
  ok "已写入（记得填 DEEPSEEK_API_KEY）"
else
  ok "$ENV_FILE 已存在，保留原样（不会覆盖你的 Key）"
fi

# ---------- 3. systemd ----------
say "安装 systemd 服务"
if [ -f /tmp/shiguang.service ]; then
  install -m 644 /tmp/shiguang.service /etc/systemd/system/shiguang.service
  systemctl daemon-reload
  systemctl enable shiguang >/dev/null 2>&1 || true
  ok "shiguang.service 已安装"
else
  warn "没有找到 /tmp/shiguang.service，跳过（重新部署会自动带上）"
fi

# ---------- 3.5 每日备份 ----------
say "安装每日备份定时器"
if [ -f /tmp/shiguang-backup.service ] && [ -f /tmp/shiguang-backup.timer ]; then
  install -m 755 /tmp/backup.sh "$APP_DIR/server/backup.sh"
  install -m 644 /tmp/shiguang-backup.service /etc/systemd/system/shiguang-backup.service
  install -m 644 /tmp/shiguang-backup.timer /etc/systemd/system/shiguang-backup.timer
  systemctl daemon-reload
  systemctl enable --now shiguang-backup.timer >/dev/null 2>&1 || true
  ok "备份定时器已启用（每天 03:30，保留 7 日 + 4 周）"
  systemctl list-timers shiguang-backup.timer --no-pager 2>/dev/null | sed -n '2p' | sed 's/^/  /'
else
  warn "没有找到备份单元文件，跳过"
fi

# ---------- 4. Caddy ----------
say "注入 Caddy 站点配置"
if [ -f /tmp/caddy-snippet.caddyfile ]; then
  # 先去掉旧片段（幂等）
  if grep -qF "$BEGIN" "$CADDY"; then
    cp -a "$CADDY" "$CADDY.bak-$(date +%F-%H%M%S)"
    awk -v b="$BEGIN" -v e="$END" '
      $0 ~ b {skip=1; next}
      $0 ~ e {skip=0; next}
      !skip {print}
    ' "$CADDY" > "$CADDY.new"
    mv "$CADDY.new" "$CADDY"
    ok "已移除旧片段"
  else
    cp -a "$CADDY" "$CADDY.bak-$(date +%F-%H%M%S)"
  fi

  # 在根域块内、handle_errors 之前插入新片段
  python3 - "$CADDY" /tmp/caddy-snippet.caddyfile "$BEGIN" "$END" <<'PY'
import sys
caddy, snippet, begin, end = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
lines = open(caddy, encoding='utf-8').read().split('\n')
block = open(snippet, encoding='utf-8').read().rstrip('\n').split('\n')
out, inserted = [], False
for line in lines:
    if not inserted and line.strip().startswith('handle_errors'):
        out.append(begin)
        out.extend(block)
        out.append(end)
        inserted = True
    out.append(line)
if not inserted:
    # 没有 handle_errors 就放到文件结尾
    out.extend([begin] + block + [end])
open(caddy, 'w', encoding='utf-8').write('\n'.join(out))
print('inserted' if inserted else 'appended')
PY

  say "校验 Caddyfile"
  if caddy validate --adapter caddyfile --config "$CADDY" 2>&1 | tail -3; then
    systemctl reload caddy
    ok "Caddy 已热加载"
  else
    LATEST=$(ls -t "$CADDY".bak-* | head -1)
    cp -a "$LATEST" "$CADDY"
    echo "配置校验失败，已回滚到 $LATEST"
    exit 1
  fi
else
  warn "没有找到 /tmp/caddy-snippet.caddyfile，跳过 Caddy 配置"
fi

ok "服务器初始化完成"
