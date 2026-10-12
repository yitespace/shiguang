#!/usr/bin/env bash
# =============================================================
# 拾光 · 数据备份
# 把 /var/lib/shiguang 打包成带日期的压缩包，做「7 日 + 4 周」轮转。
# 由 systemd timer 每天自动跑一次，也可以手动执行。
#
# 手动：ssh aliyun 'bash /opt/shiguang/server/backup.sh'
# =============================================================
set -euo pipefail

DATA_DIR="${SHIGUANG_DATA:-/var/lib/shiguang}"
BACKUP_DIR="${SHIGUANG_BACKUP_DIR:-/var/backups/shiguang}"
KEEP_DAILY=7
KEEP_WEEKLY=4

say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }

[ -d "$DATA_DIR" ] || { echo "数据目录不存在：$DATA_DIR"; exit 1; }
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

STAMP=$(date +%F)
DAY_OF_WEEK=$(date +%u)   # 1=周一 … 7=周日

# ---------- 每日备份 ----------
say "打包 $DATA_DIR"
TMP="$BACKUP_DIR/daily/.shiguang-$STAMP.tar.gz.tmp"
OUT="$BACKUP_DIR/daily/shiguang-$STAMP.tar.gz"

# 先写临时文件再改名，避免备份过程中被读到半个包
tar czf "$TMP" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")"
mv "$TMP" "$OUT"
SIZE=$(du -h "$OUT" | cut -f1)
COUNT=$(tar tzf "$OUT" 2>/dev/null | grep -c '\.jsonl$' || true)
ok "已备份：$OUT（$SIZE，含 $COUNT 个数据文件）"

# ---------- 每周留一份 ----------
if [ "$DAY_OF_WEEK" = "7" ]; then
  cp -f "$OUT" "$BACKUP_DIR/weekly/shiguang-week-$STAMP.tar.gz"
  ok "已存周备份"
fi

# ---------- 轮转 ----------
say "清理旧备份（保留 ${KEEP_DAILY} 日 + ${KEEP_WEEKLY} 周）"
cd "$BACKUP_DIR/daily"
ls -1t shiguang-*.tar.gz 2>/dev/null | tail -n +$((KEEP_DAILY + 1)) | while read -r f; do
  rm -f "$f"; echo "  删除 $f"
done

cd "$BACKUP_DIR/weekly"
ls -1t shiguang-week-*.tar.gz 2>/dev/null | tail -n +$((KEEP_WEEKLY + 1)) | while read -r f; do
  rm -f "$f"; echo "  删除 $f"
done

# ---------- 汇总 ----------
TOTAL=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
FILES=$(find "$BACKUP_DIR" -name '*.tar.gz' | wc -l)
ok "备份目录共 $FILES 个包，占用 $TOTAL"
echo
echo "恢复到某一天："
echo "  systemctl stop shiguang"
echo "  tar xzf $BACKUP_DIR/daily/shiguang-YYYY-MM-DD.tar.gz -C /var/lib"
echo "  systemctl start shiguang"
