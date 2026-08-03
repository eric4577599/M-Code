# Handoff — M-Code(瓦楞箱條碼 / QR 品質檢驗核心庫)

> 最後更新:2026-08-03T23:58+0800

## Current Task

`spec20260731-1.md` 影像層六階段。**階段 ①②③④ 程式面完成但實機未驗;
階段 ⑤ 只做了 QR 那半邊(決策 ③(c)),1D 四角偵測未開始;⑥ 未開始**。

2026-08-03 三個裁示題 + 決策 ③ 全部拿到答案,見 `report20260803-1.md`。

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
- **決策 ③(c)的 QR 半邊(2026-08-03,`report20260803-1.md` §7)** — `qrQuadFromPoints`
  由 alignment pattern 的模組座標還原符號真四角(dimension 照抄 ZXing 的
  `computeDimension`);`quadFromZxingPoints` 改為必須知道符號別,不明時保守標
  `derived`。測試 109 → 119。
- **抓到兩個「檢查在跑、量的卻是錯的東西」的幾何問題(這兩天最重要的產出)**
  1. **恆綠** — QR 三個 finder 中心補出的第四角構成**平行四邊形**,其單應矩陣是仿射的
     → `tiltFromHomography` 不論真實傾角一律回 **0.00°**(≤5° 閘門最寬鬆的放行值)。
  2. **恆紅** — ZXing 對 v≥2 的 QR **本來就回四個點**,第四個是 **alignment 中心而非
     右下角**;上一版把它當實測角點,導致**拍正的 QR 也算出 53.74°、每張 v≥2 QR 都 FAIL**。
     這個是階段 ④ 那一輪自己寫進 main 的,同日發現同日修掉。
  兩者 `quadConfidence` 都擋不住(都是正常凸四邊形)。實測表見 `spec20260731-1.md` §3.3。

## Next Step

**階段 ⑤ 的 1D 那半邊隨時可動;其餘卡在實機。** 順序:

1. **8765 實機驗收(一次把 ①②③④ 做完)** — 三步缺一不可,見 Key Context。
   要記的數字:Android 與 iOS 各一次的 **請求值 / `getSettings()` 實拿值 /
   分析影像實際寬 / 實走 L1 還是 L2 還是 L3**(`camStatus` 直接顯示)。
   iOS 那次同時解掉 §6.5 決策 ① 的前置(走 L2 就沒事,走 L3 才要選 (a)/(c))。
   順帶要看的:結果頁「幾何量測」那一行在 2D 實拍時顯示什麼、
   `tiltSource` 有沒有出現過一次「單應矩陣實算」(那要 `focalLength` 真的拿得到)。
2. **階段 ⑤ 的 1D 四角偵測(唯一不依賴實機、隨時可動的一項)** — ITF-14 靠 bearer bar、
   GS1-128 只能靠條的上下端點群做直線擬合。風險最高。它做完 §1.4 的 DEC 污染才真的修掉。
   **動工時務必記住這兩天的教訓:四條邊必須各自獨立擬合。** 若把上下邊取成平行
   (例如用單一的「條高帶」),得到的又是平行四邊形,傾角一樣恆 0° —— 那就是把同一個
   錯誤再犯一次。規格 §5.4 的「1D 邊界擬合失敗」退回測試也要在此補齊。

## Key Context

- **git** — 分支 `main`。2026-08-03 兩個 commit(階段 ④ 接線 `b217a34`、
  決策 ③(c) `8296fda`)**皆未 push**;push 依全域 §0 需 Eric 明確同意。
- **實跑基線(2026-08-03)** — `npm test` **14 檔 376 測試**全綠;`npm run typecheck`、
  `npm run build` 通過。測試數的 SSOT 是 `docs/spec20260731-1.md` §5.1 表,**每階段收工當場加一列**。
- **實機驗收要跑的三步(缺一不可)** —
  `npm run build` → `rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/`
  → 8765 測試台實際操作。**只 git pull 不 rsync = 線上不會變**(2026-07-21 曾卡 26 個 commit)。
- **沒有實機時怎麼驗 `demo/*.html`** — 用假相機探針,做法見 `report20260803-1.md`
  §4.2(ITF,手刻編碼表約 20 行)與 §7.3(QR,直接用 bundle 內的
  `ZXing.MultiFormatWriter` 產生,更省事)。要點:① 換掉
  `navigator.mediaDevices.getUserMedia` 回傳 `canvas.captureStream()`;
  ② **畫布每幀要真的變動**(`putImageData`),否則不送幀、取幀會失敗;
  ③ 繞過 `inspect()` 的 ARMED 檢查(合成圖必然眩光/楞痕不過);
  ④ 要驗「單應矩陣實算」路徑就順手 patch `MediaStreamTrack.prototype.getSettings`
  補一個合理帶內的 `focalLength`。**探針檔驗完就刪,不要留在 repo。**
- **文件** — 規格 `docs/spec20260731-1.md`;報告 `report20260731-1.md`(①②③)、
  `report20260801-1.md`(型別 + 守門)、`report20260803-1.md`(④ 與 §7 的決策 ③(c));
  待辦 `docs/todolist20260703-1.md`;規格 SSOT 是 repo 根的
  `corrugated_barcode_qc_app_master_v1.md`。
- **守門測試的分工** — `tests/rules-spec-sync.test.ts` 守 C8 種子規則;
  `tests/gate-spec-sync.test.ts` 守 C4.2 + C3.1。**改 `gate.ts` 門檻或 `types.ts` 欄位型別,
  一定要同時回寫主規劃書,否則測試會紅**(這是刻意的)。

## Risk / Note

- **`demo/*.html` 全程無自動化測試可覆蓋。** 階段 ④ 已把能搬的判斷都搬進 `imgproc.js`
  的純函式,但座標換算(`rectifyRoi` 的三段鏈)與 canvas I/O 仍在 HTML 裡。
  1D 與 QR(v≥2,單應矩陣實算)兩條已用探針實跑過,**DataMatrix 那條沒有實跑過**。
- **`rectifyPlan` 是唯一該加規則的地方。** 之後任何「這種情況要不要用矯正 / 要不要用單應
  傾角」的判斷都往那支加。一寫進 `mobile.html` 就再也驗不了。
- **QR 的傾角現在是真的了,但只限 v≥2。** v1 QR 沒有 alignment pattern,仍走平行四邊形
  補點 → `derived` → 退回臂長差代理值。這是正確的誠實退回,不是缺陷。
- **1D 的透視閘門仍然形同虛設。** 1D 拿不到四角也拿不到臂長差,傾角來源標「未量測」,
  而 `state.gate.tilt` 仍是 `resetPreviewGeometry` 的 0°。這是誠實地**暴露**了 §1.3 的
  病灶,不是修好了 —— 硬塞 `null` 會讓 `classifyPerspective` 判 FAIL 鎖死所有 1D。
  真正修掉要靠階段 ⑤ 加 §6.3 的即時化。
- **即時迴圈的 `pxm` 仍硬寫 9** —— 快門前 resolution 燈恆綠,屬 §6.3 待辦。
- **焦距在實機上拿不拿得到,仍然不知道。** 探針餵了一個合理帶內的 `focalLength`,
  「單應矩陣實算」那條路已實跑通過,但那是探針餵的。合理帶(`FOCAL_PX_LIMITS`)只保證
  單位錯的值會被擋下並退回代理,不保證實機拿得到。若實機一律拿不到,G4 對所有符號別
  都只剩代理值。
- **`quadConfidence` 的四個門檻(8px / 0.55 / 25 / 20°)未經實拍標定**,實拍後要看誤拒率。
- **不得調 `policies.ts` 的任何允收門檻** —— 需先做「提高解析度前 / 後」的實拍對照(§6.1)。
- **白平衡是歷史誤判熱區** —— 建議燈,永不 FAIL、不鎖快門,現在有測試守著。
- **守門的邊界** —— C4.1 狀態機、C4.3 偽碼、六項檢查表的「量測方法」欄都沒守;
  C5–C7、C9 只有 C8 那一組。別以為 C4 全被守住了。
- **SessionStart hook 的日期不可信** —— 2026-08-01 那次注入 `2026-07-31 22:35`,實跑 `date`
  是 `2026-08-01 14:42`;2026-08-03 這次注入 `21:33`,實跑是 `22:57`(日期對、時間差 1.4 小時)。
  **文件命名前先跑一次 `date` 核對。** hook 本身待查(屬 `~/.claude` 範圍,非本專案)。
