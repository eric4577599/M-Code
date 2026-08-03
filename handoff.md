# Handoff — M-Code(瓦楞箱條碼 / QR 品質檢驗核心庫)

> 最後更新:2026-08-03T23:40+0800

## Current Task

`spec20260731-1.md` 影像層六階段。**階段 ①②③④ 程式面完成但實機未驗,⑤⑥ 未開始**。

上一輪(2026-08-03)三個裁示題全部拿到答案,階段 ④ 已接線完成,見 `report20260803-1.md`。

## Done

- **階段 ①②③(2026-07-31,`report20260731-1.md`)** — 解析度偵測與三層降級取幀、GSD 誠實化、
  梯形矯正核心純函式。**三階段皆實機未驗**,依專案 DoD 不得宣稱完工。
- **C3.1 型別放寬 + C4.2/C3.1 守門測試(2026-08-01,`report20260801-1.md`)** — 不可得改以
  `null` 承載;`tests/gate-spec-sync.test.ts` 36 測試,已用 9 個變異驗證守門會紅。
- **階段 ④ 接線(2026-08-03,`report20260803-1.md`)** — 依裁示落地:
  - `demo/imgproc.js` 新增 `focalPxFromSettings` / `quadFromZxingPoints` / `rectifyQuad` /
    `rectifyPlan` / `resolveTiltDeg` / `FOCAL_PX_LIMITS` / `TILT_SOURCE_LABEL`
    —— **接線的所有判斷刻意全放純函式**,`mobile.html` 只剩座標換算與 DOM。
  - `demo/mobile.html` 接線:`roiGrayOf` 多回 `{x0,y0,sx,sy}` 建立三段座標橋、
    `inspectReal` 依 `rectifyPlan` 決定量測吃正射還是原 ROI、結果頁與 PDF 明細加
    「幾何量測 / 傾角來源」誠實標註。
  - `tests/imgproc.test.ts` 79 → 109 測試。
- **抓到一個會讓透視閘門恆綠的幾何問題(本輪最重要的產出)** — QR 三個 finder 中心補出的
  第四角構成**平行四邊形**,其單應矩陣是仿射的 → **`tiltFromHomography` 不論真實傾角
  一律回 0.00°**,而 0° 正是 ≤5° 閘門最寬鬆的放行值。實測表見 `spec20260731-1.md` §3.3
  補點段。已由 `rectifyPlan` 擋掉(QR 退回臂長差代理值),並有對照組護欄測試。

## Next Step

**唯一的解鎖點是實機,不是程式。** 順序:

1. **8765 實機驗收(一次把 ①②③④ 做完)** — 三步缺一不可,見 Key Context。
   要記的數字:Android 與 iOS 各一次的 **請求值 / `getSettings()` 實拿值 /
   分析影像實際寬 / 實走 L1 還是 L2 還是 L3**(`camStatus` 直接顯示)。
   iOS 那次同時解掉 §6.5 決策 ① 的前置(走 L2 就沒事,走 L3 才要選 (a)/(c))。
   順帶要看的:結果頁「幾何量測」那一行在 2D 實拍時顯示什麼、
   `tiltSource` 有沒有出現過一次「單應矩陣實算」(那要 `focalLength` 真的拿得到)。
2. **回答 §6.5 決策 ③(QR 要不要取 alignment pattern)** — 這是 QR 能不能拿到真透視的
   唯一路徑。三個選項:(a) 擴充 ZXing 取 alignment pattern / (b) 接受 QR 走代理值並在
   文案載明 / (c) 併入階段 ⑤ 一起自寫偵測。**建議 (c)** —— 1D 的 bearer bar 擬合本來就
   要自寫偵邊,兩件事同源。
3. **階段 ⑤(1D 四角偵測)** — 純函式、vitest 可測,不依賴任何裁示,隨時可動。
   風險最高(GS1-128 無 bearer bar)。它做完 §1.4 的 DEC 污染才真的修掉。

## Key Context

- **git** — 分支 `main`,**本輪改動尚未 commit**(`demo/imgproc.js`、`demo/mobile.html`、
  `tests/imgproc.test.ts` 三個 M,加上 `docs/report20260803-1.md` 新檔與
  `docs/spec20260731-1.md`、`docs/todolist20260703-1.md`、`handoff.md` 的回寫)。
  push 依全域 §0 需 Eric 明確同意。
- **實跑基線(2026-08-03)** — `npm test` **14 檔 366 測試**全綠;`npm run typecheck`、
  `npm run build` 通過。測試數的 SSOT 是 `docs/spec20260731-1.md` §5.1 表,**每階段收工當場加一列**。
- **實機驗收要跑的三步(缺一不可)** —
  `npm run build` → `rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/`
  → 8765 測試台實際操作。**只 git pull 不 rsync = 線上不會變**(2026-07-21 曾卡 26 個 commit)。
- **沒有實機時怎麼驗 `demo/*.html`** — 用假相機探針,做法見 `report20260803-1.md` §4.2:
  canvas 合成一張真的 ITF 條碼 → `captureStream()` → 換掉 `getUserMedia`。
  不需要相機權限,ZXing 真的解得開。**探針檔驗完就刪,不要留在 repo。**
- **文件** — 規格 `docs/spec20260731-1.md`;報告 `report20260731-1.md`(①②③)、
  `report20260801-1.md`(型別 + 守門)、`report20260803-1.md`(④);
  待辦 `docs/todolist20260703-1.md`;規格 SSOT 是 repo 根的
  `corrugated_barcode_qc_app_master_v1.md`。
- **守門測試的分工** — `tests/rules-spec-sync.test.ts` 守 C8 種子規則;
  `tests/gate-spec-sync.test.ts` 守 C4.2 + C3.1。**改 `gate.ts` 門檻或 `types.ts` 欄位型別,
  一定要同時回寫主規劃書,否則測試會紅**(這是刻意的)。

## Risk / Note

- **`demo/*.html` 全程無自動化測試可覆蓋。** 階段 ④ 已把能搬的判斷都搬進 `imgproc.js`
  的純函式,但座標換算(`rectifyRoi` 的三段鏈)與 canvas I/O 仍在 HTML 裡。
  1D 那條已用探針實跑過,**2D 兩條分支(DataMatrix 實算 / QR 代理)沒有實跑過**。
- **`rectifyPlan` 是唯一該加規則的地方。** 之後任何「這種情況要不要用矯正 / 要不要用單應
  傾角」的判斷都往那支加。一寫進 `mobile.html` 就再也驗不了。
- **1D 的透視閘門仍然形同虛設。** 1D 拿不到四角也拿不到臂長差,傾角來源標「未量測」,
  而 `state.gate.tilt` 仍是 `resetPreviewGeometry` 的 0°。這是誠實地**暴露**了 §1.3 的
  病灶,不是修好了 —— 硬塞 `null` 會讓 `classifyPerspective` 判 FAIL 鎖死所有 1D。
  真正修掉要靠階段 ⑤ 加 §6.3 的即時化。
- **即時迴圈的 `pxm` 仍硬寫 9** —— 快門前 resolution 燈恆綠,屬 §6.3 待辦。
- **焦距一次都沒真的拿到過。** 合理帶(`FOCAL_PX_LIMITS`)只保證單位錯的值會被擋下並退回
  代理,不保證實機拿得到。若實機一律拿不到,G4 對所有符號別都只剩代理值。
- **`quadConfidence` 的四個門檻(8px / 0.55 / 25 / 20°)未經實拍標定**,實拍後要看誤拒率。
- **不得調 `policies.ts` 的任何允收門檻** —— 需先做「提高解析度前 / 後」的實拍對照(§6.1)。
- **白平衡是歷史誤判熱區** —— 建議燈,永不 FAIL、不鎖快門,現在有測試守著。
- **守門的邊界** —— C4.1 狀態機、C4.3 偽碼、六項檢查表的「量測方法」欄都沒守;
  C5–C7、C9 只有 C8 那一組。別以為 C4 全被守住了。
- **SessionStart hook 的日期不可信** —— 2026-08-01 那次注入 `2026-07-31 22:35`,實跑 `date`
  是 `2026-08-01 14:42`;2026-08-03 這次注入 `21:33`,實跑是 `22:57`(日期對、時間差 1.4 小時)。
  **文件命名前先跑一次 `date` 核對。** hook 本身待查(屬 `~/.claude` 範圍,非本專案)。
