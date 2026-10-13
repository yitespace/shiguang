#!/usr/bin/env bash
# ============================================================
# 拾光 · 打包 Android APK
#
# 工具链（JDK 21 + Android SDK + Gradle）复用仓库里已有的那份，
# 不重复下载 1.3GB。查找顺序：
#   1) 拾光/.android-build
#   2) ../心迹/.android-build        ← 已有，默认走这个
#   3) /mnt/e/obsidian/我的第二大脑/.android-build（共享位置）
#
# 用法：pnpm build:apk
# ============================================================
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
say() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }

# ---------- 0. 找工具链 ----------
find_tools() {
  for c in "$ROOT/.android-build" "$ROOT/../心迹/.android-build" "/mnt/e/obsidian/我的第二大脑/.android-build"; do
    if [ -x "$c/jdk21/bin/java" ] && [ -d "$c/sdk/platforms/android-35" ] && [ -x "$c/gradle/bin/gradle" ]; then
      echo "$c"; return 0
    fi
  done
  return 1
}

TOOLS=$(find_tools || true)
if [ -z "$TOOLS" ]; then
  cat <<'EOF'
没有找到 Android 工具链。两种做法：

 A. 复用已有的（推荐）：心迹目录下已经有一份
      ls ../心迹/.android-build
    如果存在，本脚本会自动找到它，无需任何操作。

 B. 从零准备（约 1.3GB，需联网）：参考 ../心迹/scripts/build-apk.sh 顶部的
    「工具链不完整」说明，把下载步骤在 拾光/.android-build 里做一遍。
EOF
  exit 1
fi
ok "工具链：$TOOLS"

SDK="$TOOLS/sdk"
BT="$SDK/build-tools/35.0.0"

# ---------- 1. 签名密钥库 ----------
KS="$ROOT/.android-build/shiguang-release.keystore"
KS_PASS="${SHIGUANG_KS_PASS:-shiguang}"
mkdir -p "$ROOT/.android-build"
if [ ! -f "$KS" ]; then
  say "生成签名密钥库"
  "$TOOLS/jdk21/bin/keytool" -genkeypair -v \
    -keystore "$KS" \
    -alias "${SHIGUANG_KS_ALIAS:-shiguang}" \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "${SHIGUANG_KS_DNAME:-CN=ShiGuang, OU=Personal, O=ShiGuang, C=CN}" >/dev/null 2>&1
  ok "密钥库已生成（口令 $KS_PASS，务必自行备份）"
  warn "这份密钥库是签名凭证，丢了就没法给已装的 App 覆盖升级，请单独备份"
  warn "证书里的信息可以用 SHIGUANG_KS_DNAME 覆盖，但换了 DN 就等于换了密钥"
else
  ok "密钥库已存在，沿用"
fi

# ---------- 2. 构建 Web 并同步进 Android 工程 ----------
say "构建 Web 产物并同步到 Android 工程"
# App 里的页面跑在 https://localhost，接口必须用绝对地址，
# 所以打包 App 时把后端地址注入进去（网页版则保持同源相对路径）
API_BASE="${VITE_API_BASE:-https://zhuangrongjian.space/shiguang}"
VITE_API_BASE="$API_BASE" pnpm build
if grep -q "zhuangrongjian.space" dist/assets/*.js 2>/dev/null; then
  ok "已注入后端地址 $API_BASE"
else
  warn "没找到注入的后端地址，App 可能连不上服务器"
fi
pnpm exec cap sync android >/dev/null 2>&1
ok "Web 产物已同步（离线可用）"

# ---------- 3. 图标 ----------
say "生成 Android 图标"
node scripts/gen-android-icons.mjs 2>&1 | tail -2 || warn "图标生成脚本失败，沿用默认图标"

# ---------- 4. 编译 ----------
export JAVA_HOME="$TOOLS/jdk21"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export GRADLE_USER_HOME="$TOOLS/gradle-home"
GRADLE_NATIVE_DIR="$TOOLS/gradle-native"
mkdir -p "$GRADLE_USER_HOME" "$GRADLE_NATIVE_DIR"

say "Gradle assembleRelease（首次会下载 gradle 依赖，可能要几分钟）"
cd android
"$TOOLS/gradle/bin/gradle" assembleRelease --no-daemon \
  -Dorg.gradle.native.dir="$GRADLE_NATIVE_DIR"

cd "$ROOT"
APK=$(ls -1 android/app/build/outputs/apk/release/*.apk 2>/dev/null | head -1)
[ -n "$APK" ] || { echo "未生成 APK"; exit 1; }
APK="$ROOT/$APK"

# ---------- 5. 校验 ----------
say "校验 APK 签名"
"$BT/apksigner" verify --print-certs "$APK" 2>&1 | head -4
"$BT/aapt2" dump badging "$APK" 2>/dev/null | grep -E "^package|application-label|uses-permission.*RECORD_AUDIO" | head -5

SIZE=$(du -h "$APK" | cut -f1)
ok "APK：$APK（$SIZE）"
echo
echo "传到手机点安装即可（需允许「安装未知来源应用」）。"
echo "也可以发布到网站：pnpm deploy --with-apk"
