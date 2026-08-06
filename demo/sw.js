// M-Code 離線外殼(Service Worker)。2026-08-06。
//
// 由來:實機回報手機開網頁一直轉圈。追下去不是程式壞掉,是往返次數 —— 每次開頁都要跟
// 台灣的 Mac mini 重抓 20 個檔案,而 Cloudflare 邊緣在新加坡(實測單一 1KB 模組往返
// 660ms、origin 本機只要 1ms)。同一個修法也解掉「瓦楞廠現場沒網路」:檢驗流程本來就
// 不需要網路,只有同步紀錄需要。
//
// ── 更新策略:刻意不自動生效 ─────────────────────────────────────────────
// 這個專案踩過「線上沒更新」的坑(2026-07-21 曾有 26 個 commit 沒上線),多一層快取
// 就多一種同樣的失敗模式。所以:
//   ① 新版安裝完只進 waiting,**不 skipWaiting** —— 舊版繼續完整服務,不會出現
//      「新 HTML 配舊 JS」的混搭窗口。
//   ② 由頁面顯示「有新版」橫幅,**使用者按了才** postMessage 過來 skipWaiting。
//   ③ 快取名帶內容雜湊(部署時由 deploy/stamp-sw.py 蓋章),換版即換快取,不會殘留。
// 外殼一律 cache-first:一致性優先於新鮮度 —— 新鮮度由上面那條更新路徑負責。

const VERSION = "__STAMP__"; // 部署時以 SHELL 內容的雜湊取代;未蓋章時為字面值
const CACHE = "mcode-shell-" + VERSION;

// 離線外殼。**必須與頁面實際依賴一致** —— 由 tests/pwa-shell-sync.test.ts 守著,
// src/index.ts 加了新匯入而這裡沒跟上,離線時那一支就抓不到。
const SHELL = [
  "./mobile.html",
  "./index.html",
  "./manual.html",
  "./imgproc.js",
  "./manifest.webmanifest",
  // 圖示也要進外殼:manifest 一被解析,瀏覽器就會去抓它們 —— 漏掉的話離線啟動
  // 會有一支請求打不到網路。這是實跑才發現的(靜態檢查看不出「誰會被請求」)。
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./vendor/zxing.min.js",
  "../dist/index.js",
  "../dist/data/flutes.js",
  "../dist/data/policies.js",
  "../dist/data/profiles.js",
  "../dist/data/rules.js",
  "../dist/domain/flags.js",
  "../dist/domain/scale.js",
  "../dist/domain/types.js",
  "../dist/engines/acceptance.js",
  "../dist/engines/decode.js",
  "../dist/engines/diagnosis.js",
  "../dist/engines/gate.js",
  "../dist/engines/grade.js",
  "../dist/engines/measurement.js",
  "../dist/erp/client.js",
  "../dist/export/csv.js",
];

self.addEventListener("install", (e) => {
  // 刻意不 skipWaiting:新版先待命,由使用者決定何時切換(見檔頭更新策略)
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    // 換版即換快取名,舊的整批刪掉,不讓上一版的檔案殘留成幽靈
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith("mcode-shell-") && n !== CACHE)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨網域不碰
  e.respondWith((async () => {
    // ⚠ **必須用 cache.match(本版快取)而不是 caches.match(全域)。**
    // 2026-08-06 實機事故:頁面丟出
    //   「SyntaxError: Importing binding name 'barBandExtent' is not found」
    // —— 新的 mobile.html 配到舊的 imgproc.js。成因就是這一行原本寫成全域的
    // `caches.match()`:CacheStorage 的全域查找會搜尋**這個網域下的每一個快取**。
    // 而本檔的更新策略刻意讓新版只待命(不 skipWaiting),好讓舊版**完整**服務到
    // 使用者按下更新為止 —— 但新版一旦 install 完就已經建立了第二個快取,
    // 全域查找便會伸手進去,一半新一半舊,正好造出這個策略要避免的混搭。
    // 限定在本版快取內查,原子性才真的成立。
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;                            // 外殼 cache-first(一致性優先)
    try {
      return await fetch(req);
    } catch (err) {
      // 離線且不在外殼內:導覽請求退回手機版首頁,其餘照實失敗
      if (req.mode === "navigate") {
        const fallback = await cache.match("./mobile.html");
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});

self.addEventListener("message", (e) => {
  // 只接受頁面在使用者點擊「立即更新」後送來的這一則
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
