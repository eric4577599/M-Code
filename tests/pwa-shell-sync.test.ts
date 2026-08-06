import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

// Service Worker 的離線外殼清單必須與頁面實際依賴一致。
//
// 由來(2026-08-06):加了離線外殼之後,`demo/sw.js` 的 SHELL 陣列變成第二份「這個 app
// 由哪些檔案組成」的清單(第一份是 HTML 的 modulepreload)。兩份都是手寫的靜態清單,
// 而 src/index.ts 才是真正的來源 —— 三者一漂開就會出現**沒有症狀的故障**:
//   · 少一支 → install 的 cache.addAll 整批失敗 → 使用者完全沒有離線能力,但線上一切正常,
//     沒有任何人會發現(deploy/stamp-sw.py 也會擋,但那只擋得到「檔案不存在」)。
//   · 多一支不存在的 → 同樣 addAll 失敗。
// 這支測試把三者釘在一起。
//
// 基準取 src/index.ts 不取 dist/index.js:dist/ 在 .gitignore 內、要先 build 才存在,
// 拿它當基準會讓「沒 build 就跑測試」變成假失敗。TS 的 ESM 原始碼本來就寫 .js 副檔名。

const SW = "demo/sw.js";
const PAGES = ["demo/mobile.html", "demo/index.html"];

/** src/index.ts 的相對匯入(去掉開頭 "./")。 */
function srcImports(): string[] {
  const s = readFileSync("src/index.ts", "utf8");
  return [...new Set([...s.matchAll(/from "\.\/([^"]+)"/g)].map((m) => m[1]!))].sort();
}

/** sw.js 的 SHELL 陣列內容。 */
function shell(): string[] {
  const m = readFileSync(SW, "utf8").match(/const SHELL = \[(.*?)\];/s);
  expect(m, "sw.js 找不到 SHELL 陣列").toBeTruthy();
  return [...m![1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("PWA 離線外殼與實際依賴同步", () => {
  const mods = srcImports();
  const list = shell();

  it("外殼含入口 dist/index.js 與全部 15 支子模組", () => {
    const want = ["../dist/index.js", ...mods.map((m) => `../dist/${m}`)];
    expect(list).toEqual(expect.arrayContaining(want));
  });

  it("**外殼沒有多餘的 dist 項**(不存在的檔會讓 addAll 整批失敗 → 完全沒有離線能力)", () => {
    const extra = list
      .filter((h) => h.startsWith("../dist/") && h !== "../dist/index.js")
      .filter((h) => !mods.includes(h.replace("../dist/", "")));
    expect(extra).toEqual([]);
  });

  it("外殼含兩個頁面、imgproc、ZXing 與 manifest", () => {
    for (const need of ["./mobile.html", "./index.html", "./imgproc.js",
      "./vendor/zxing.min.js", "./manifest.webmanifest"]) {
      expect(list).toContain(need);
    }
  });

  it("外殼列的檔案都真的存在(dist 需先 build,缺 dist 時只檢查 demo 側)", () => {
    const distBuilt = existsSync("dist/index.js");
    const missing = list
      .map((rel) => rel.replace(/^\.\//, "demo/").replace(/^\.\.\//, ""))
      .filter((p) => distBuilt || !p.startsWith("dist/"))
      .filter((p) => !existsSync(p));
    expect(missing).toEqual([]);
  });

  it("外殼無重複項", () => {
    expect(list.length).toBe(new Set(list).size);
  });

  it("**更新策略不得退回靜默生效** —— install 內不可 skipWaiting", () => {
    const s = readFileSync(SW, "utf8");
    // 這個專案踩過「線上沒更新」的坑;反過來,自動 skipWaiting 會造成
    // 「新 HTML 配舊 JS」的混搭窗口。兩邊都要擋,故 skipWaiting 只准出現在 message 處理內。
    // 比對的是**呼叫**不是字樣:install 的註解本來就寫著「刻意不 skipWaiting」,
    // 用字樣比對會把那句解釋自己的註解當成違規。
    const installBlock = s.slice(s.indexOf('addEventListener("install"'),
      s.indexOf('addEventListener("activate"'));
    expect(installBlock).not.toMatch(/skipWaiting\s*\(/);
    expect(s).toContain('e.data.type === "SKIP_WAITING"');
    expect(s).toMatch(/SKIP_WAITING"\)\s*self\.skipWaiting\(\)/);
  });

  it("**fetch 必須查本版快取,不可用全域 caches.match**(混搭版本的成因)", () => {
    // 2026-08-06 實機事故:頁面丟出「Importing binding name 'barBandExtent' is not found」——
    // 新的 mobile.html 配到舊的 imgproc.js。成因是 fetch handler 用了全域 caches.match(),
    // 它會搜尋網域下的**每一個**快取;而更新策略刻意讓新版只待命、舊版完整服務,
    // 新版 install 完就已建立第二個快取 → 全域查找伸手進去 → 一半新一半舊。
    // 比對前先去掉行註解:上面那段解釋本身就寫著 caches.match(),
    // 直接比對字樣會把「解釋自己為什麼不能這樣寫」的註解當成違規(同 skipWaiting 那條的教訓)。
    const s = readFileSync(SW, "utf8").split("\n")
      .map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    const fetchBlock = s.slice(s.indexOf('addEventListener("fetch"'));
    expect(fetchBlock).not.toMatch(/\bcaches\.match\s*\(/);
    expect(fetchBlock).toContain("caches.open(CACHE)");
    expect(fetchBlock).toMatch(/cache\.match\s*\(/);
  });

  it("快取名帶版本章,且 repo 內保留未蓋章的字面值", () => {
    const s = readFileSync(SW, "utf8");
    expect(s).toContain('const VERSION = "__STAMP__"');
    expect(s).toContain('const CACHE = "mcode-shell-" + VERSION');
  });

  for (const page of PAGES) {
    it(`${page} 註冊 sw.js、掛 manifest,且更新採「使用者確認」`, () => {
      const s = readFileSync(page, "utf8");
      expect(s).toContain('navigator.serviceWorker.register("./sw.js")');
      expect(s).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
      // 沒有這則 postMessage 就等於沒有更新路徑 —— 使用者會永遠停在第一次安裝的版本
      expect(s).toContain('postMessage({ type: "SKIP_WAITING" })');
    });
  }

  it("manifest 的圖示檔都存在", () => {
    const m = JSON.parse(readFileSync("demo/manifest.webmanifest", "utf8"));
    const missing = m.icons
      .map((i: { src: string }) => i.src.replace(/^\.\//, "demo/"))
      .filter((p: string) => !existsSync(p));
    expect(missing).toEqual([]);
  });

  it("**manifest 的圖示也要在外殼裡** —— manifest 一被解析瀏覽器就會去抓", () => {
    // 2026-08-06 實跑抓到的漏網:icon-192 在啟動時被請求卻不在外殼,離線會打不到網路。
    // 靜態檢查看不出「誰會被請求」,所以這條是照著實跑結果補的。
    const m = JSON.parse(readFileSync("demo/manifest.webmanifest", "utf8"));
    const want = m.icons.map((i: { src: string }) => i.src);
    expect(list).toEqual(expect.arrayContaining(want));
  });

  it("apple-touch-icon 也要在外殼裡(iOS 加到主畫面時會抓)", () => {
    expect(list).toContain("./icons/apple-touch-icon.png");
    expect(readFileSync("demo/mobile.html", "utf8"))
      .toContain('rel="apple-touch-icon" href="./icons/apple-touch-icon.png"');
  });
});
