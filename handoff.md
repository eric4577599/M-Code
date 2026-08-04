# Handoff — M-Code(瓦楞箱條碼 / QR 品質檢驗核心庫)

> 最後更新:2026-08-04T12:35+0800

## Current Task

`spec20260731-1.md` 影像層六階段。**階段 ①②③④⑤ 程式面完成但實機未驗;⑥ 未開始**。

2026-08-04 補上階段 ⑤ 的最後一塊 —— **1D(ITF-14 / GS1-128 / CODE128)四角偵測**,
規格已併回 `spec20260731-1.md`(§3.3「1D 四角偵測」節 + §5.4d),階段 ⑤ 的增修節草稿
`docs/spec-v1.md` 依其 §7 併入後**已刪除,不留兩份規格**。

## Done

- **階段 ①②③(2026-07-31,`report20260731-1.md`)** — 解析度偵測與三層降級取幀、GSD 誠實化、
  梯形矯正核心純函式。**三階段皆實機未驗**,依專案 DoD 不得宣稱完工。
- **C3.1 型別放寬 + C4.2/C3.1 守門測試(2026-08-01,`report20260801-1.md`)** — 不可得改以
  `null` 承載;`tests/gate-spec-sync.test.ts` 36 測試,已用 9 個變異驗證守門會紅。
- **階段 ④ 接線(2026-08-03,`report20260803-1.md`)** — `demo/imgproc.js` 新增
  `focalPxFromSettings` / `quadFromZxingPoints` / `rectifyQuad` / `rectifyPlan` /
  `resolveTiltDeg`;**接線的所有判斷刻意全放純函式**,`mobile.html` 只剩座標換算與 DOM。
- **決策 ③(c)的 QR 半邊(2026-08-03)** — `qrQuadFromPoints` 由 alignment pattern 的模組
  座標還原符號真四角;`quadFromZxingPoints` 改為必須知道符號別,不明時保守標 `derived`。
- **階段 ⑤ 的 1D 半邊(2026-08-04,本輪)** — `demo/imgproc.js` 新增
  `ONE_D_SYMBOLOGIES` / `LINE_FIT_LIMITS`(13 個凍結門檻)/ `fitLineTLS`(TLS + MAD 離群
  剔除)/ `quadFrom1DEdges`(**四條邊各自獨立擬合**後求交點),`rectifyQuad` 多一個 1D
  分流(`derived: false`、`source: "1d-edges"`),**`rectifyPlan` 判斷邏輯不必改**;
  `mobile.html` 只改一段過期註解;**`src/` 零變更**。測試 119 → **154**(全檔 376 → **411**)。
  實測(合成、無亂數):ITF-14 / GS1-128 繞 X/Y 兩軸 0–30°,傾角誤差**最大 0.037°**
  (判準 ±1°);繞 Y 軸 25° 的 `maxWidthDeviation` **0.4545 → 0.0833**、模組寬變異數
  **1.9195 → 0.1088**(0° 拍攝基準 0.1429,矯正後還更好)。**§1.4 的 DEC 污染對 1D
  終於修掉(合成情境)。**
- **本輪被實測推翻的兩件事(寫進規格 §3.3 / §5.4d)**
  1. 草稿的「取**平行於定位線**的掃描線求左右邊」走不通 —— 透視下上下兩線會聚,平行線
     會跑出條高帶外,繞 Y 軸 25° 時左邊 RMS **4.5px**(門檻 1.5px)。改為**沿上下兩線
     線性內插**取掃描線。
  2. 草稿 §5.2 的「繞 X 軸那組上下邊方向角差最明顯」**寫反了** —— 針孔模型下繞 X 軸時
     上下兩邊恰好平行(<0.1°),會聚在**左右**兩邊;護欄改用繞 Y 軸 30° 驗。
- **規格側收尾(2026-08-04,主 session 補,`report20260804-1.md` §5)** —— workflow 的
  Tester 在 T3 擋下三項規格缺陷(T1/T2 全過),主 session 接手補完:
  1. **`searchHalfSpanRatio` 那格的宣稱基準量寫錯** —— 原文「條高可達**符號寬**的 1.2 倍」,
     實際 1.2 倍的基準是**定位線長**(定位點在最外側暗元素**中心**,故恆短於符號寬)。
     自行二分 24 次實測邊界 471.5px,理論 `2 × 0.6 × 定位線長` = 472.5px,**差 < 1px**。
     規格改寫為機制式敘述,**未動常數**(調高增加誤追蹤風險,依 §6.1 留待實拍)。
  2. **補 §5.4e**:草稿 §6 點名為風險卻沒驗收案例的兩個 edge case(符號旋轉 90°、
     近正方形標籤)補 4 條測試,**實作一行未改**。
  3. **§5.4d 記入流程缺陷**:`spec-v1.md` 從未進版控就被 `rm`,驗收無從回溯。
     往後草稿先 commit 再交棒、併檔用 `git rm`。

## Next Step

**剩下的全部卡在實機。** 順序:

1. **8765 實機驗收(一次把 ①②③④⑤ 做完)** — 三步缺一不可,見 Key Context。
   要記的數字:Android 與 iOS 各一次的 **請求值 / `getSettings()` 實拿值 / 分析影像實際寬 /
   實走 L1 還是 L2 還是 L3**(`camStatus` 直接顯示)。iOS 那次同時解掉 §6.5 決策 ① 的前置。
   **本輪新增的重點**:1D 標的(ITF-14 / GS1-128)實拍時結果頁「幾何量測」那一行要顯示
   「已矯正 …,1D 四角由條端擬合」而不是退回理由 —— 這條路徑**一次都沒在瀏覽器裡跑過**。
2. **(可先做,不必實機)`demo/_probe.html` 假相機探針跑一次 1D 新路徑** — 做法見
   `report20260803-1.md` §4.2。本輪沒做,是階段 ⑤ 目前最大的未驗項,
   **也是下一次唯一不卡實機、隨時可動的一項**。探針驗完即刪,不留在 repo。
3. **階段 ⑥ torch** — 需 Android 實機。

## Key Context

- **git** — 分支 `main`。2026-08-03 兩個 commit(`b217a34`、`8296fda`)+ 本輪 commit
  **皆未 push**;push 依全域 §0 需 Eric 明確同意。
- **實跑基線(2026-08-04)** — `npm test` **14 檔 411 測試**全綠(`tests/imgproc.test.ts`
  154);`npm run typecheck`、`npm run build` 通過。測試數的 SSOT 是
  `docs/spec20260731-1.md` §5.1 表,**每階段收工當場加一列,數字抄實跑輸出**。
- **實機驗收要跑的三步(缺一不可)** —
  `npm run build` → `rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/`
  → 8765 測試台實際操作。**只 git pull 不 rsync = 線上不會變**(2026-07-21 曾卡 26 個 commit)。
- **沒有實機時怎麼驗 `demo/*.html`** — 假相機探針,做法見 `report20260803-1.md`
  §4.2(ITF,手刻編碼表約 20 行)與 §7.3(QR,用 bundle 內的 `ZXing.MultiFormatWriter`)。
  要點:① 換掉 `getUserMedia` 回傳 `canvas.captureStream()`;② **畫布每幀要真的變動**;
  ③ 繞過 `inspect()` 的 ARMED 檢查;④ 要驗「單應矩陣實算」就 patch `getSettings()` 補一個
  合理帶內的 `focalLength`。**探針檔驗完就刪。**
- **文件** — 規格 `docs/spec20260731-1.md`(1D 四角偵測的權威定義在 §3.3「1D 四角偵測」節
  與「條高上限」段,狀態在 §5.4d,edge case 驗收在 §5.4e);報告 `report20260731-1.md`
  (①②③)、`report20260801-1.md`、`report20260803-1.md`(④ + QR)、
  **`report20260804-1.md`(⑤ 1D,含規格側三項修正與變異驗證)**。
- **守門測試的分工** — `tests/rules-spec-sync.test.ts` 守 C8 種子規則;
  `tests/gate-spec-sync.test.ts` 守 C4.2 + C3.1;`tests/imgproc.test.ts` 守
  `QUAD_CONFIDENCE_LIMITS` 與 **`LINE_FIT_LIMITS` / `ONE_D_SYMBOLOGIES`** 整表。
  **改門檻沒改規格 = 測試紅**,這是刻意的 —— 但守門只擋得住「值變了」,擋不住
  「值沒變、規格說明過期」,那部分仍靠人回寫。

## Risk / Note

- **1D 的新路徑完全沒在瀏覽器裡跑過。** 合成測試綠燈 ≠ 實拍可用:合成圖沒有印刷毛邊、
  紙面起伏與雜訊,`maxRmsPx = 1.5px` 這一關在實拍下的**誤拒率是未知數**。規格 §6.2 的
  階段 ⑤ 風險改為「實拍未驗」,不是「已解除」。
- **§6 的兩個 edge case 沒有驗收案例** —— 「符號旋轉 90°(條水平)」只由 `fitLineTLS` 的
  垂直線測試間接覆蓋、沒走過 `quadFrom1DEdges` 全程;「近正方形標籤」完全沒測
  (`searchHalfSpanRatio = 0.6` 夠不夠只有推理)。兩者要補都只需多合成一張標籤。
- **C1 是這條產品線最貴的教訓,不要退化。** 任何「把對邊取成平行」的簡化都會讓傾角恆 0°,
  而 0° 是 ≤5° 閘門最寬鬆的放行值。護欄測試(平行四邊形對照組)不得刪。
- **`demo/*.html` 全程無自動化測試可覆蓋。** 座標換算(`rectifyRoi` 三段鏈)與 canvas I/O
  仍在 HTML 裡;1D 與 QR(v≥2)已用探針實跑過**舊路徑**,DataMatrix 那條從沒實跑過。
- **`rectifyPlan` 是唯一該加規則的地方。** 之後任何「要不要用矯正 / 要不要用單應傾角」的
  判斷都往那支加。一寫進 `mobile.html` 就再也驗不了。
- **QR 的傾角只限 v≥2**;v1 沒有 alignment pattern,仍走補點 → `derived` → 代理值。
- **即時迴圈的 `pxm` 仍硬寫 9、`tilt` 仍還原 0°** —— 快門前 resolution / perspective 燈恆綠,
  屬 §6.3 待辦(「picket 與 px/module 燈號拍攝前即時化」)。**階段 ⑤ 修的是快門後那半邊。**
- **焦距在實機上拿不拿得到,仍然不知道。** 拿不到就全部退回臂長差代理值,1D 連臂長差都
  沒有 → 標「未量測」。這會讓本輪的成果在實機上打折,是接下來最該驗的一件事。
- **不得調 `policies.ts` 的任何允收門檻** —— 需先做「提高解析度前 / 後」的實拍對照(§6.1)。
- **白平衡是歷史誤判熱區** —— 建議燈,永不 FAIL、不鎖快門,現在有測試守著。
- **SessionStart hook 的日期不可信** —— **文件命名前先跑一次 `date` 核對**
  (本輪已核對:2026-08-04 11:45)。
