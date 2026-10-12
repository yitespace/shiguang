#!/usr/bin/env bash
# =============================================================
# 拾光 · 配置阿里云短信
#
# 在服务器上以 root 运行。四项填完会自动写进 /etc/shiguang.env、
# 重启服务、并回头验证短信通道是否真的就绪。
#
# 用法（二选一）：
#   交互式：  bash set-sms.sh
#   一行搞定：bash set-sms.sh <AccessKeyId> <AccessKeySecret> <签名> <模板CODE>
#
# 例：
#   bash set-sms.sh LTAI5tXXXXXX 9aBcDeFgXXXXXX 拾光 SMS_123456789
# =============================================================
set -euo pipefail

ENV_FILE="${SHIGUANG_ENV:-/etc/shiguang.env}"
SERVICE="${SHIGUANG_SERVICE:-shiguang}"

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '\033[31m✗\033[0m %s\n' "$*"; }

if [ "$(id -u)" != "0" ]; then
  bad "要用 root 跑（它要改 $ENV_FILE）"
  exit 1
fi

AK_ID="${1:-}"
AK_SECRET="${2:-}"
SIGN="${3:-}"
TEMPLATE="${4:-}"

if [ -z "$AK_ID" ]; then
  echo "按提示填四样东西（在阿里云短信控制台都能找到）："
  echo
  read -rp "1/4 AccessKey ID      : " AK_ID
  read -rp "2/4 AccessKey Secret  : " AK_SECRET
  read -rp "3/4 短信签名          : " SIGN
  read -rp "4/4 模板 CODE         : " TEMPLATE
  echo
fi

for pair in "AccessKey ID:$AK_ID" "AccessKey Secret:$AK_SECRET" "短信签名:$SIGN" "模板 CODE:$TEMPLATE"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [ -z "$value" ]; then
    bad "$name 是空的"
    exit 1
  fi
done

case "$TEMPLATE" in
  SMS_*) ;;
  *) bad "模板 CODE 一般长这样：SMS_123456789（你这是「$TEMPLATE」）" ; exit 1 ;;
esac

say "备份现有配置"
cp -a "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
ok "备份好了"

say "写入新配置"
# 先把旧的同名行删掉，避免出现两份不一样的配置
if grep -q '^ALIYUN_SMS_' "$ENV_FILE" 2>/dev/null; then
  sed -i '/^ALIYUN_SMS_/d' "$ENV_FILE"
fi
{
  echo ''
  echo '# 阿里云短信（配置时间：'"$(date '+%Y-%m-%d %H:%M')"'）'
  echo "ALIYUN_SMS_AK_ID=$AK_ID"
  echo "ALIYUN_SMS_AK_SECRET=$AK_SECRET"
  echo "ALIYUN_SMS_SIGN=$SIGN"
  echo "ALIYUN_SMS_TEMPLATE=$TEMPLATE"
} >> "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "写好了（$ENV_FILE，权限 600）"

say "重启服务"
systemctl restart "$SERVICE"
sleep 2

say "回头验证"
HEALTH=$(curl -s -m 10 "http://127.0.0.1:${SHIGUANG_PORT:-8787}/api/healthz" || true)
if echo "$HEALTH" | grep -q '"sms":{"enabled":true}'; then
  ok "短信通道已就绪"
  echo
  echo "  现在打开网页，登录页会多出「验证码登录」和「注册」两个页签。"
  echo "  第一个账号可以用设置码建，也可以直接走注册（会真的发短信，按条计费）。"
  echo
  echo "  自己发一条试试："
  echo "    curl -s -X POST -H 'Content-Type: application/json' \\"
  echo "      -d '{\"phone\":\"你的手机号\",\"purpose\":\"register\"}' \\"
  echo "      http://127.0.0.1:8787/api/auth/sms/send"
  echo "    （返回 {\"sent\":true} 就是发出去了；返回错误会带上阿里云的原话）"
else
  bad "短信通道还没就绪，服务自检返回："
  echo "$HEALTH"
  echo
  echo "  看看日志里怎么说的："
  echo "    journalctl -u $SERVICE -n 50 --no-pager"
  exit 1
fi
