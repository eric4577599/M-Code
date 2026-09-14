#!/usr/bin/env bash
#
# M-Code 上線:build → rsync → stamp,三步綁成一個不可拆的動作。
#
# 為什麼要有這支(稽核 A-13,2026-08-22):
# 上線本來是三個各自獨立的指令,而**漏掉任何一步都沒有症狀**——
#   · 漏 build  → docroot 的 dist/ 還是舊的,demo 頁行為不變(或直接空白)
#   · 漏 rsync  → 線上完全不會變(2026-07-21 就這樣卡了 26 個 commit)
#   · 漏 stamp  → sw.js 的 VERSION 留在 __STAMP__,快取名恆定,新版 install 時開到
#                 舊版正在服務的那個快取並就地覆寫 → 「新 HTML 配舊 JS」的混搭事故
# 三種失敗都不會出錯、不會有畫面異常,只能靠人記得。所以解法不是寫得更清楚的文件,
# 是讓這三步沒有辦法被分開執行。
#
# 蓋章驗證**不可以比 hash**:未蓋章的 sw.js 與 repo 完全相同,
# 「一致 = 同步好了」這個平常的慣用法對這支檔案方向剛好相反。
# 唯一有效的判準是 __STAMP__ 殘留數必須為 0(見下方 verify 段)。
#
# 用法:
#   ./deploy/deploy.sh              # 完整上線(會先跑 typecheck + test 當閘門)
#   ./deploy/deploy.sh --no-test    # 跳過測試閘門(只在測試環境已知綠燈時用)
#   ./deploy/deploy.sh --dry-run    # 只顯示 rsync 會改動什麼,不實際上線
#
# ⚠ 這支**不驗收**,只上線。demo/*.html 的改動要在上線前先在臨時埠驗過
#   (8765 的 docroot 就是 ~/m-code-site,照字面「在 8765 驗」等於先發佈再驗證):
#     python3 -m http.server 8799 --bind 127.0.0.1
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCROOT="${MCODE_DOCROOT:-$HOME/m-code-site}"
SITE_URL="${MCODE_SITE_URL:-https://m-code.ericchh.work}"

RUN_TESTS=1
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-test) RUN_TESTS=0 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "未知參數:$arg" >&2; exit 2 ;;
  esac
done

cd "$REPO_DIR"

step() { printf '\n\033[1m[%s/%s] %s\033[0m\n' "$1" "$2" "$3"; }

# 注意:這裡不可以寫成 `[ ... ] && TOTAL=5` —— RUN_TESTS=0 時整行回非零,
# set -e 會讓腳本在這一行就靜默結束(看起來像「跑完了」)。
TOTAL=4
if [ "$RUN_TESTS" -eq 1 ]; then TOTAL=5; fi

# ── 閘門:typecheck + test ────────────────────────────────────────────────
# 放在最前面,失敗就完全不碰 docroot(set -e)。上線一半比沒上線更難收拾。
if [ "$RUN_TESTS" -eq 1 ]; then
  step 1 "$TOTAL" "typecheck + test"
  npm run typecheck
  npm test
fi

# ── 1. build ─────────────────────────────────────────────────────────────
step $((TOTAL-3)) "$TOTAL" "build(dist/ 是 demo 的執行期依賴,不進版控)"
npm run build
[ -f dist/index.js ] || { echo "build 後仍找不到 dist/index.js" >&2; exit 1; }

# ── 2. rsync ─────────────────────────────────────────────────────────────
step $((TOTAL-2)) "$TOTAL" "rsync → $DOCROOT"
if [ "$DRY_RUN" -eq 1 ]; then
  rsync -a --delete --itemize-changes --dry-run \
    --exclude node_modules --exclude .git ./ "$DOCROOT/"
  echo
  echo "--dry-run:到此為止,未上線(也未蓋章)。"
  exit 0
fi
mkdir -p "$DOCROOT"
rsync -a --delete --exclude node_modules --exclude .git ./ "$DOCROOT/"

# ── 3. stamp ─────────────────────────────────────────────────────────────
# 必須在 rsync 之後 —— rsync 剛把帶著 __STAMP__ 字面值的 repo 原始檔蓋回去了。
step $((TOTAL-1)) "$TOTAL" "stamp-sw.py(必須在 rsync 之後)"
python3 deploy/stamp-sw.py "$DOCROOT"

# ── 4. verify ────────────────────────────────────────────────────────────
step "$TOTAL" "$TOTAL" "驗證"

local_left=$(grep -c __STAMP__ "$DOCROOT/demo/sw.js" || true)
if [ "$local_left" != "0" ]; then
  echo "❌ docroot 的 sw.js 還有 $local_left 個 __STAMP__ —— 蓋章沒生效" >&2
  exit 1
fi
echo "  ✅ docroot sw.js 已蓋章(__STAMP__ 殘留 0)"
echo "     版本章 $(sed -n 's/^const VERSION = "\([^"]*\)".*/\1/p' "$DOCROOT/demo/sw.js")"

# 線上這一段是「服務端真的在服務新檔案了嗎」,拿不到網路不算上線失敗,只警告。
if online=$(curl -sf --max-time 15 "$SITE_URL/demo/sw.js" 2>/dev/null); then
  remote_left=$(printf '%s' "$online" | grep -c __STAMP__ || true)
  if [ "$remote_left" != "0" ]; then
    echo "❌ 線上 sw.js 仍有 __STAMP__ —— 服務的不是剛蓋章的那份" >&2
    exit 1
  fi
  echo "  ✅ 線上 sw.js 已蓋章"
  # dist/index.js 與 imgproc.js 可以比 hash(它們不像 sw.js 需要與 repo 不同,
  # 也不像 *.html 會被 Cloudflare 注入 bot-detection script)。
  for f in demo/imgproc.js dist/index.js; do
    a=$(curl -sf --max-time 15 "$SITE_URL/$f" | shasum | awk '{print $1}')
    b=$(shasum "$f" | awk '{print $1}')
    if [ "$a" = "$b" ]; then echo "  ✅ $f 與 repo 一致"
    else echo "  ⚠️  $f 與 repo 不同(可能是 CDN 還沒換,稍後重驗)"; fi
  done
else
  echo "  ⚠️  連不到 $SITE_URL,跳過線上驗證(本機 docroot 已就緒)"
fi

echo
echo "上線完成。使用者端不會自動切版 —— 要按頁面上的「有新版本可用」橫幅才生效。"
