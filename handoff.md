# Handoff — M-Code(瓦楞箱條碼 / QR 品質檢驗核心庫)

> 最後更新:2026-08-03T19:57:46+0800

## Current Task

`spec20260731-1.md` 影像層六階段。**階段 ①②③ 程式面完成但未驗收,④⑤⑥ 未開始且全部卡住**。

上一輪(2026-08-01)改做的是 todolist 上不被實機或裁示卡住的兩項:C3.1 型別放寬、
C4.2/C3.1 規格↔程式守門測試 —— **兩項都已完成、測試綠、已 commit**。

## Done

- **階段 ①②③(2026-07-31,`report20260731-1.md`)** — 解析度偵測與三層降級取幀、GSD 誠實化、
  梯形矯正核心純函式。**③ 刻意未接線**;三階段皆**實機未驗**,依專案 DoD 不得宣稱完工。
- **C3.1 型別放寬(2026-08-01,`report20260801-1.md`)** — `CaptureQualityReport` 的
  `gsdMmPerPx` / `pxPerModule` 由 `number` 改為 `number | null`,不再以 NaN 承載不可得。
  消費端(csv / erp / demo)全部掃過皆不讀這兩欄,**無行為變更**。
  `GateCheck.value` 維持 `-1` 哨兵值(該欄型別放不進 null,判準已寫進規格與測試)。
- **`tests/gate-spec-sync.test.ts`(新檔,36 測試)** — 解析主規劃書與程式逐項比對:
  C4.2 六項檢查門檻、透視/解析度兩支判定表與 `threshold` 字串、「不可得」守衛表、
  哨兵值、C3.1 型別宣告。**已用 9 個變異(3 程式端 + 6 規格端)驗證守門會紅。**
- **抓到一筆真實漂移並修掉** — C4.2 表格的 `whiteBalance` 停在「>5% → FAIL」,與程式的
  建議燈語意及同節下方守衛表矛盾。**修規格不動程式**,並把「永不 FAIL」變成掃描斷言。
- 文件回寫:主規劃書 C3.1 / C4.2、`spec20260731-1.md` §5.1 基線表補兩列、
  `todolist20260703-1.md` 三項打勾。

## Next Step

**先回答階段 ④ 的三個裁示題(這是唯一的解鎖點,不必再寫任何程式)**,順序如下:

1. **`focalPx` 從哪來** —— 三個候選皆未驗證:`track.getSettings().focalLength`(機型覆蓋率與
   單位不明)/ 由已知尺寸基準物反推(依賴尚未實作的「參考卡真實偵測」)/ 機型對照表。
   **定不下來就不能接線**:`tiltFromHomography` 沒有焦距只回 `null`,而 `classifyPerspective`
   對 `null` 判 FAIL,現場會拍不了。若決定退回臂長差代理值,要一併決定結果頁怎麼標註該值為代理。
2. **iOS Safari tier-3 解析度** —— `spec20260731-1.md` §6.5 決策 ①,三選項已列。
   **前置是拿一台 iOS 機實測走 L2 還是 L3**(`camStatus` 會顯示),不實測就選等於猜。
3. **DEC 門檻是否重標定** —— 需實拍前後對照。在那之前**不得調 `policies.ts` 的任何允收門檻**。

裁示 1 給出答案後即可動階段 ④(接線 `demo/mobile.html` + `demo/index.html`)。
若想先做不依賴裁示的,階段 ⑤(1D 四角偵測)是純函式、vitest 可測,但產物是要餵給 ④ 的。

**另有一條與裁示平行、隨時可做的**:階段 ①②③ 的 8765 實機驗收(見 Key Context 的部署三步)。

## Key Context

- **git** — 分支 `main`,工作區乾淨,**`0898ff3` 尚未 push(領先 origin/main 1 個 commit)**。
  push 依全域 §0 需 Eric 明確同意。
- **實跑基線(2026-08-01)** — `npm test` 14 檔 336 測試全綠;`npm run typecheck`、
  `npm run build` 通過。測試數的 SSOT 是 `docs/spec20260731-1.md` §5.1 表,**每階段收工當場加一列**。
- **文件** — 規格 `docs/spec20260731-1.md`;報告 `docs/report20260731-1.md`(階段 ①②③)、
  `docs/report20260801-1.md`(型別 + 守門);待辦 `docs/todolist20260703-1.md`;
  規格 SSOT 是 repo 根的 `corrugated_barcode_qc_app_master_v1.md`。
- **實機驗收要跑的三步(缺一不可)** —
  `npm run build` → `rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/`
  → 8765 測試台實際操作。**只 git pull 不 rsync = 線上不會變**(2026-07-21 曾卡 26 個 commit)。
- **實機要記的數字(§5.2)** — Android 與 iOS 各一次:請求值 / `getSettings()` 實拿值 /
  分析影像實際寬 / 實際走 L1 還是 L2 還是 L3。
- **守門測試的分工** — `tests/rules-spec-sync.test.ts` 守 C8 種子規則;
  `tests/gate-spec-sync.test.ts` 守 C4.2 + C3.1。**改 `gate.ts` 門檻或 `types.ts` 欄位型別,
  一定要同時回寫主規劃書,否則測試會紅**(這是刻意的)。

## Risk / Note

- **`demo/*.html` 全程無自動化測試可覆蓋。** 階段 ①③ 的 `mobile.html` 快門路徑是整段重寫的
  (同步單函式 → 三層非同步降級;全張分析 → 降取樣解碼 + ROI 放大取像素),336 個測試涵蓋的是
  純函式,**涵蓋不到 canvas I/O、ZXing 對降取樣影像的解碼率、`applyConstraints` 的真機行為**。
- **即時迴圈的 `pxm` 仍硬寫 9** —— 快門前 resolution 燈恆綠。屬 §6.3 待辦,不是本輪造成的,
  但別誤以為那盞燈有在把關。
- **`quadConfidence` 的四個門檻(8px / 0.55 / 25 / 20°)未經實拍標定**,階段 ⑤ 實拍後要看誤拒率。
- **白平衡是歷史誤判熱區** —— 建議燈,永不 FAIL、不鎖快門。現在有測試守著(規格標 `—` 的欄位
  會被掃描斷言),想改回硬閘門必須先改規格,改了規格又會撞上其他測試。
- **守門的邊界** —— C4.1 狀態機(mermaid)、C4.3 偽碼、六項檢查表的「量測方法」欄**都沒守**;
  C5–C7、C9 等章節同樣只有 C8 那一組。別以為 C4 全被守住了。
- **SessionStart hook 的日期不可信** —— 2026-08-01 那次 hook 注入 `2026-07-31 22:35`,
  實跑 `date` 是 `2026-08-01 14:42`。**文件命名前先跑一次 `date` 核對**,這是每個 session 的
  命名依據,錯了會一路錯下去。hook 本身待查(屬 `~/.claude` 範圍,非本專案)。
