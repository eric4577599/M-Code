import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// demo/*.html 的 <link rel="modulepreload"> 清單必須與 src/index.ts 的匯入一致。
//
// 由來(2026-08-06):實機回報「網頁打不開,一直轉圈」。追下去不是程式壞掉,是**往返次數** ——
// dist/ 是未打包的 ES module 樹,瀏覽器要先把 dist/index.js 下載完並解析,才會發現底下
// 還有 15 支子模組,那是一整層額外的 round trip。經 Cloudflare 隧道實測(邊緣在 SIN、
// origin 在台灣)每個往返約 0.7 秒,四層瀑布讓 DOMContentLoaded 要 3.8 秒(總量只有 176KB,
// 最慢的幾支都是 1KB 的檔案各花 1.9 秒 —— 純延遲,與頻寬無關)。手機 RTT 更高會拉到十幾秒。
//
// 解法是在 <head> 預先宣告,讓它們在解析 HTML 當下就平行開抓。**這是靜態清單,會過期** ——
// src/index.ts 加了新的匯入而 HTML 沒跟上,那一支就退回舊的瀑布,而且**沒有任何症狀**
// (頁面照樣會動,只是慢),不寫測試守著就一定會靜默漂掉。這支測試就是那道守門。
//
// 用 src/index.ts 當基準而非 dist/index.js:dist/ 在 .gitignore 內、要先 build 才存在,
// 拿它當基準會讓「沒 build 就跑測試」變成假失敗。TS 的 ESM 原始碼本來就寫 .js 副檔名,
// 兩者的路徑字面值一致。

const SRC = "src/index.ts";
const PAGES = ["demo/mobile.html", "demo/index.html"];

/** 取出 src/index.ts 的相對匯入路徑(去掉開頭的 "./")。 */
function srcImports(): string[] {
  const s = readFileSync(SRC, "utf8");
  return [...new Set([...s.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!))].sort();
}

/** 取出某頁 <link rel="modulepreload"> 的 href 清單。 */
function preloads(page: string): string[] {
  const s = readFileSync(page, "utf8");
  return [...s.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]!);
}

describe("modulepreload 與 src/index.ts 同步", () => {
  const mods = srcImports();

  it("src/index.ts 確實有相對匯入可守(基準本身沒被改空)", () => {
    expect(mods.length).toBeGreaterThan(0);
  });

  for (const page of PAGES) {
    describe(page, () => {
      const hrefs = preloads(page);

      it("每一支 src/index.ts 的子模組都有對應的 modulepreload", () => {
        const missing = mods.filter((m) => !hrefs.includes(`../dist/${m}`));
        expect(missing).toEqual([]);
      });

      it("入口 dist/index.js 本身也要預先宣告", () => {
        expect(hrefs).toContain("../dist/index.js");
      });

      it("**沒有多餘的 dist preload**(指到不存在的模組 = 每次載入都白抓一個 404)", () => {
        const extra = hrefs
          .filter((h) => h.startsWith("../dist/") && h !== "../dist/index.js")
          .filter((h) => !mods.includes(h.replace("../dist/", "")));
        expect(extra).toEqual([]);
      });

      it("preload 清單無重複(重複不會壞但代表清單是手工編的)", () => {
        expect(hrefs.length).toBe(new Set(hrefs).size);
      });
    });
  }

  it("mobile.html 另外要預先宣告 imgproc.js(它是第二個入口,不在 dist 樹內)", () => {
    expect(preloads("demo/mobile.html")).toContain("./imgproc.js");
  });
});
