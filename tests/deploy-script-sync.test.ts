import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";

// 上線腳本的順序護欄(稽核 A-13,2026-08-22)。
//
// `deploy/deploy.sh` 存在的唯一理由是「build → rsync → stamp 三步不可能被拆開」。
// 那個保證是靠**腳本內的順序**成立的,而順序是註解攔不住的東西 ——
// 把 stamp 移到 rsync 前面,腳本照跑、也不會出錯,只是 rsync 會把帶著 __STAMP__ 的
// repo 原始檔蓋回去,結果等於沒蓋章,而**沒蓋章這件事沒有症狀**。
// 這支測試把順序與那道殘留檢查釘住。
//
// 另一半是「驗蓋章不可以比 hash」:未蓋章的 sw.js 與 repo 完全相同,
// 平常那套「一致 = 同步好了」對這支檔案方向剛好相反。所以下面有一條**反向斷言**——
// sw.js 不得出現在比 hash 的清單裡。

const SH = "deploy/deploy.sh";
const src = readFileSync(SH, "utf8");

/** 取某個標記在腳本中第一次出現的位置;找不到就讓斷言帶著標記名失敗。 */
function at(marker: string | RegExp): number {
  const i = typeof marker === "string" ? src.indexOf(marker) : src.search(marker);
  expect(i, `deploy.sh 找不到:${marker}`).toBeGreaterThan(-1);
  return i;
}

describe("deploy.sh 把上線三步綁在一起", () => {
  it("可直接執行(shebang + executable bit)", () => {
    expect(src.startsWith("#!/usr/bin/env bash")).toBe(true);
    // .gitattributes 固定 LF —— CRLF 的 shebang 會變成 "bad interpreter"
    expect(src.includes("\r\n")).toBe(false);
    expect(statSync(SH).mode & 0o111).toBeGreaterThan(0);
  });

  it("set -euo pipefail:任一步失敗就不會繼續往下上線", () => {
    expect(src).toMatch(/^set -euo pipefail$/m);
  });

  it("三步齊全且順序為 build → rsync → stamp", () => {
    const build = at(/^npm run build$/m);
    const rsync = at(/^rsync -a --delete --exclude node_modules --exclude \.git \.\/ "\$DOCROOT\/"$/m);
    const stamp = at(/^python3 deploy\/stamp-sw\.py "\$DOCROOT"$/m);
    expect(build).toBeLessThan(rsync);
    expect(rsync).toBeLessThan(stamp); // ← 這一條反了就等於沒蓋章,而且毫無症狀
  });

  it("蓋章後會驗 __STAMP__ 殘留,且殘留時以非零離開", () => {
    const check = at('grep -c __STAMP__ "$DOCROOT/demo/sw.js"');
    expect(check).toBeGreaterThan(at(/^python3 deploy\/stamp-sw\.py "\$DOCROOT"$/m));
    // 殘留檢查必須真的擋下來,不能只印訊息。
    // 範圍要收在**這個 if 區塊之內** —— 只寫 /__STAMP__[^]*?exit 1/ 會比對到後面
    // 線上檢查那段的 exit 1,把「本地檢查被改成只印訊息」判成通過(實測漏掉)。
    const block = src.slice(check, src.indexOf("\nfi\n", check));
    expect(block).toMatch(/^\s*exit 1$/m);
  });

  it("不拿 hash 驗 sw.js(方向相反的那條陷阱)", () => {
    const loop = src.match(/for f in ([^;]+); do/);
    expect(loop, "找不到比 hash 的檔案清單").toBeTruthy();
    expect(loop![1]).not.toContain("sw.js");
    // *.html 同樣不可比 —— Cloudflare 會在 </body> 前注入 bot-detection script
    expect(loop![1]).not.toContain(".html");
  });

  it("dry-run 在蓋章之前就結束,不會留下半套 docroot", () => {
    expect(at(/--dry-run:到此為止/)).toBeLessThan(at(/^python3 deploy\/stamp-sw\.py "\$DOCROOT"$/m));
  });
});

describe("專案 CLAUDE.md 指向 deploy.sh", () => {
  it("上線段落提到 deploy/deploy.sh", () => {
    // 文件與腳本漂開時,人還是會照文件手打三步 —— A-13 就回來了
    expect(readFileSync("CLAUDE.md", "utf8")).toContain("deploy/deploy.sh");
  });
});
