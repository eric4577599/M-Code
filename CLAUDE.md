# 開發規範(dev 套件)

> 由 `/seed dev` 套進專案根。本檔只寫**程式開發專案通用**的規範;
> 專案特有的架構、服務、路徑寫在下方「專案區」,不要改上半部。

## 完工定義(DoD)

不可自己宣告完工。程式專案的判準是:

1. 新功能**附測試**且測試通過 —— 沿用專案既有框架(Python→pytest、JS/TS→vitest、Go→testing、C#→xUnit),檔案與被測檔同層或對應 `tests/`。
2. 跑過一次真實情境,不是只有單元測試綠燈。
3. 有 lint / type check 的專案要一併通過。

說「**嚴格測試**」時升級:覆蓋率 ≥ 80%,含正常與邊界案例。

## 程式碼

- 註解用**正體中文**,函式級,說明輸入 / 輸出 / 邏輯。格式自由。
- 寫出來的程式碼要像周圍的程式碼:沿用既有命名、慣例與註解密度,不要引入新風格。
- 不主動加相依套件;需要時先問。

## Commit

Conventional Commits:`feat:` `fix:` `docs:` `refactor:` `test:` `chore:`。
一個 commit 一件事;`push` 依全域 §0 需明確同意。

## 錯誤處理

自動重試 **1 次**,仍失敗就停下回報(附錯誤訊息 + 建議解法)。說「自主處理」時才自行判斷是否續做。

## 交付

- 任務報告 `docs/report{YYYYMMDD}-{序號}.md`,規格 `docs/spec{YYYYMMDD}-{序號}.md`(依全域 §3)。
- 有 page spec 的專案:**改頁面前先讀 `docs/page_spec_<頁面>.md`,改完必須回寫**(PostToolUse hook 會檢查 spec 是否比程式碼舊)。
- 事實(架構決策、Bug 根因)寫 L3;教訓與偏好寫 L2;都不要塞進本檔。

---

## 專案區(以下由各專案自行填寫)

M-Code = 瓦楞箱條碼 / QR 品質檢驗的**純運算核心庫**(前端無關),外加一個 demo 測試台。
**定位護欄**:所有等級皆為相對代理值(`isRelative` 恆為 `true`),**非 ISO 合規驗證、不出具證書**,任何文案與程式都不得暗示合規。

### 技術棧

- TypeScript 5.5(ESM、`strict` + `noUncheckedIndexedAccess`)+ vitest 2 + `@zxing/library`。無框架、無打包器。
- `src/` 為核心引擎(domain / engines / data / erp / export),真實 I/O(像素、解碼器、HTTP、時鐘)一律**注入介面**,不在庫內直接做。
- `demo/*.html` 是原生單檔 HTML + inline JS,**直接 `import "../dist/index.js"`**;`demo/imgproc.js` 是純函式影像層,由 `tests/imgproc.test.ts` 在 Node 直接測。
- 規劃書 `corrugated_barcode_qc_app_master_v1.md` 是規格 SSOT;模組↔規格章節對照見 `README.md` 的表。

### 服務與啟動方式

```bash
npm run typecheck   # tsc --noEmit(只掃 src)
npm test            # vitest,現況 12 檔 159 測試
npm run build       # tsc → dist/(demo 依賴,必跑)
```

線上測試台 `https://m-code.ericchh.work`:Mac mini 上 `python3 -m http.server 8765`(launchd 常駐)+ cloudflared tunnel。入口是 `/demo/index.html`(桌面)與 `/demo/mobile.html`(手機)。安裝與維運見 `deploy/README-macmini.md`、`deploy/README-launchagent.md`。

### 資料庫與重要路徑

- 無資料庫(離線佇列與儲存由前端 host 提供)。
- 線上 docroot 是 **`~/m-code-site`**,不是 repo 本身;上線靠
  `rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/`。

### 這個專案跟通則不同的地方

- **改 `demo/*.html` 沒有自動化測試可覆蓋** → DoD 改為「build 後在本機 8765 測試台實際操作驗證」,並在報告寫明驗了什麼。改 `src/` 仍照通則要附 vitest。
- **帳密與 tier 是兩檔同步的權威表**,`demo/index.html` 與 `demo/mobile.html` 必須一致:`admin/admin → PAID`、`demo/demo → FREE`。功能是否解鎖一律走 `src/domain/flags.ts` 的 `isEnabled(tier, feature)`,不要在 HTML 裡寫死 tier 判斷或文案。

### 已知的坑

- `dist/` 在 `.gitignore` 內但 demo 執行期依賴它 → **改完 `src/` 沒 `npm run build`,demo 頁會空白或 import 失敗**;部署端 `git pull` 後也要重跑 build。
- 部署只 `git pull` 不 rsync 到 `~/m-code-site` = 線上不會變(2026-07-21 就是這樣卡了 26 個 commit 沒上線)。
- web server 必須 `--bind ::`(雙協議),只綁 IPv4 會讓 cloudflared 拿到 **502**;對外 **1033** 則是 cloudflared 沒在跑。
- `*.sh` / `*.plist` 由 `.gitattributes` 固定 LF,不可改成 CRLF(shebang 會壞)。
- 楞痕(washboard)與白平衡屬歷史誤判熱區:白平衡為**建議燈,不鎖快門**,不要改回硬閘門。
