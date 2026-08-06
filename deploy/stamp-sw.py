#!/usr/bin/env python3
"""給 docroot 裡的 Service Worker 蓋內容雜湊的章。

為什麼需要:`demo/sw.js` 的離線外殼是 cache-first,快取鍵是 `mcode-shell-<VERSION>`。
版本號如果不動,部署了新的 `dist/*.js` 也不會有人發現 —— 舊快取繼續服務,線上等於沒更新。
這個專案踩過那個坑(2026-07-21 曾有 26 個 commit 沒上線),不能再靠人記得改版本號。

做法:把外殼清單裡每個檔案的內容串起來取 SHA-256,前 12 碼寫進 `__STAMP__`。
任何一支檔案有變 → 章不同 → 快取名不同 → 瀏覽器偵測到新的 sw.js → 安裝新版 →
頁面跳出「有新版本」橫幅(不自動切換,見 demo/sw.js 檔頭的更新策略)。

**必須在 rsync 之後跑** —— rsync 會把 repo 裡帶著 `__STAMP__` 字面值的原始檔蓋回去。
repo 裡刻意保留未蓋章的版本:蓋章結果隨 build 產物變動,進版控只會製造無意義的 diff。

用法:
    python3 deploy/stamp-sw.py                      # 蓋 ~/m-code-site
    python3 deploy/stamp-sw.py /path/to/docroot     # 蓋指定 docroot
"""
import hashlib
import os
import re
import sys

DEFAULT_DOCROOT = os.path.expanduser("~/m-code-site")
PLACEHOLDER = "__STAMP__"


def shell_entries(sw_text):
    """從 sw.js 取出 SHELL 陣列裡的相對路徑。輸入:sw.js 全文;輸出:路徑字串串列。"""
    m = re.search(r"const SHELL = \[(.*?)\];", sw_text, re.S)
    if not m:
        raise SystemExit("找不到 SHELL 陣列 —— sw.js 的結構變了,請一併更新本腳本")
    return re.findall(r'"([^"]+)"', m.group(1))


def main():
    docroot = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DOCROOT
    sw_path = os.path.join(docroot, "demo", "sw.js")
    if not os.path.isfile(sw_path):
        raise SystemExit(f"找不到 {sw_path} —— 是不是還沒 rsync?")

    with open(sw_path, encoding="utf-8") as f:
        text = f.read()

    entries = shell_entries(text)
    h = hashlib.sha256()
    missing = []
    for rel in sorted(entries):
        # SHELL 的路徑是相對於 demo/(sw.js 所在目錄)
        p = os.path.normpath(os.path.join(docroot, "demo", rel))
        if not os.path.isfile(p):
            missing.append(rel)
            continue
        h.update(rel.encode("utf-8"))
        with open(p, "rb") as fp:
            h.update(fp.read())

    if missing:
        # 外殼少一支,install 時 addAll 會整批失敗 → 使用者完全沒有離線能力而且毫無症狀。
        # 寧可在部署當下就停下來,不要讓它靜默壞掉。
        raise SystemExit("外殼缺檔,中止蓋章(是不是忘了 npm run build?):\n  "
                         + "\n  ".join(missing))

    # sw.js 自己也要進雜湊。它不在 SHELL 清單裡(外殼不快取自己),但**它的行為變了
    # 就是換了一版** —— 2026-08-06 修掉 fetch 用全域 caches.match 造成版本混搭的那次,
    # 外殼檔案一個都沒動,版本章因此沒變,畫面上顯示的版本也沒變 → 使用者無從得知
    # 自己有沒有拿到修正。雜湊的是**蓋章前**的原文(含 __STAMP__ 佔位),故仍然穩定。
    h.update(b"sw.js")
    h.update(text.encode("utf-8"))

    stamp = h.hexdigest()[:12]
    if PLACEHOLDER not in text:
        raise SystemExit(f"{sw_path} 沒有 {PLACEHOLDER} —— 可能已經蓋過章了,重跑 rsync 再試")

    with open(sw_path, "w", encoding="utf-8") as f:
        f.write(text.replace(PLACEHOLDER, stamp))

    print(f"已蓋章 {sw_path}")
    print(f"  外殼 {len(entries)} 項 → 版本 {stamp}")


if __name__ == "__main__":
    main()
