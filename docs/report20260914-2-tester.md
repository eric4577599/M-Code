# 驗收報告 report20260914-a10a01-v1

- 規格:`docs/spec20260914-a10a01-v1.md`(稽核 A-10 量錯對象 / A-01「全部 OK」含未量測項)
- 受測改動:`demo/imgproc.js`、`demo/mobile.html`、`tests/imgproc.test.ts`、`tests/shot-gate-roi-sync.test.ts`(新檔)
- 驗收日期:2026-09-14
- 結論:**PASS**(T1 / T2 / T3 全數通過)

---

## T1 deterministic —— 親自執行,不採信 RD 說法

| AC | 指令 | 實跑結果 |
|---|---|---|
| AC-1 | `npm run typecheck` | exit 0,無輸出(`tsc -p tsconfig.json --noEmit`) |
| AC-2 | `npm run build` | exit 0(以 `npm run build >/dev/null; echo $?` 確認,不看管線尾碼) |
| AC-3 | `npm test` | **Test Files 21 passed / Tests 603 passed**,零失敗、零 skip |
| AC-4 | `tests/expected-gtin-sync.test.ts` | `✓ (30 tests)` 全綠(A-02/A-03 未被破壞) |
| AC-13 | `tests/gate-spec-sync.test.ts` | `✓ (36 tests)` 全綠 |

基線對照:規格要求「既有 584 支一支都不能壞」。實跑 603 = 584 + 新檔 `shot-gate-roi-sync` 10 支 + `imgproc.test.ts` 追加 9 支。
`tests/imgproc.test.ts` 由 241 → 250,其餘 19 個測試檔支數未變。

護欄 1 的檔案範圍以 `git status --short` / `git diff --stat` 確認:
異動僅 `demo/imgproc.js`(+48)、`demo/mobile.html`(+85/-11)、`tests/imgproc.test.ts`(+107),
新增 `tests/shot-gate-roi-sync.test.ts`。`src/` / `dist/` / `deploy/` / `demo/sw.js` / `demo/vendor/` / `package.json` 一個位元組都沒動。

AC-13 門檻凍結另以 diff 過濾佐證:`git diff -U0 demo/` 的非註解變更行中,
`120` / `0.08` / `>= 8` / `SLOW_SHUTTER_MS` 等閘門常數與比較式**無任何命中**(過濾結果為空)。

**T1 = PASS。**

---

## T2 semantic —— 做的事對不對

### A-10:光度四項確實改量 ROI(AC-5 / AC-6)

- `demo/mobile.html:870-871`
  `const shotQRoi = measureQuality(roiCanvasOf(photo, roiFull), roiFull.x1 - roiFull.x0, roiFull.y1 - roiFull.y0);`
  位置在 `roiFull`(`:860-862`)算出之後、`roiGrayOf` 之前 —— 符合規格 §2.3 的順序要求。
- `roiCanvasOf`(`:728-742`)夾回走既有純函式 `scaleRoi(roi, 1, photo.width, photo.height)`,
  `drawImage` 來源矩形與目的矩形寬高同為 `rw`/`rh`,**未預先縮放**,取樣鏈維持「由原尺寸直接縮到 320」。
- 退化 ROI(E2):`demo/imgproc.js:326-333` 的 `scaleRoi` 以 `x1 = Math.max(x0 + 1, …)` / `y1 = Math.max(y0 + 1, …)`
  保證輸出至少 1×1,故 `roiCanvasOf` 不會建出 0 寬高 canvas、`drawImage` 不會丟例外 —— 規格 E2 的「保底 1×1」由既有純函式達成,未重寫夾回邏輯。
- `measureQuality`(`:1640`)只用 `srcW/srcH` 推長寬比,傳 ROI 實寬高與 canvas 實寬高一致,無不一致風險。
- E3(1D 走矯正):量的是 `roiFull`(未矯正),與 `pmRoi` 光度基底一致,未改吃正射影像。

### A-01:三態呈現(AC-7 / AC-8 / AC-9)

- `demo/imgproc.js:2299-2341` 新增純函式 `summarizeShotGate`,排除 `scaleRef`、分 未量測 / 非 OK / OK 三組,
  輸出順序為「非 OK → 未量測 → OK」(符合規格 §2.2 第 3 條),組間 ` · `、組內 `、`。
- `measured[key]` 不存在視為已量測(`measured[c.key] === false` 才算未量測)—— E9 成立,日後新增檢查項不會靜默消失。
- `demo/mobile.html:1047-1063`:`measured = { resolution: pxmMeasured, perspective: tilt.source !== "none", picket: !!zx }`,
  與規格 §1.2 表格逐條相符;光度四項刻意不列,恆為已量測。
- `pxmMeasured`(宣告於 `:988`,設真於 `:984` 的 `if (g1.modulePx)` 區塊內)全檔唯一設真點在 1D 分支 ⇒ 2D 恆為未量測(E4)、
  1D 掃描線全滅時亦為 false(E5),不再因 `state.gate.pxm` 仍是 `resetPreviewGeometry` 的 `9`(`9 >= 8`)而印 OK。
- 「全部 OK」字面在去除行註解後的 `demo/mobile.html` 與 `demo/imgproc.js` 的執行路徑上皆不存在(僅存於解釋病灶的註解中)。

實際跑一次引擎確認檢查項鍵值與標籤對得上(`node` 直接 import `dist/index.js` 呼叫 `evaluateGate`):
`focus | glare | washboard | whiteBalance | scaleRef | picket | perspective | resolution` 共 8 項,
排除 `scaleRef` 後 7 項全部在 `CHECK_LABEL`(`demo/mobile.html:479`)中有中文標籤,不會退化成印出英文 key。

### §1.3 交互作用:新鮮度與本張閘門脫鉤(AC-11)

- `shotQ` → `shotQFull`(`:821`)計算一字未改;`shotGateFull = gateOn(shotQFull)`(`:1034`)。
- `assessShotFreshness`(`:1044-1049`)四個布林與 `shotVarLap` 全數取自 `previewGate` / `shotGateFull`,
  完全沒有 `shotGateRoi` / `shotQRoi` —— 2026-08-06 建立的判準行為不變。
- `gateOn` 的非光度輸入(`symbolDetected` / 幾何三項 / `scaleRefDetected` / `fluteType`)未調整,兩組閘門仍只在光度四項上有差別。

### 預覽路徑未動(AC-10)

`measureFrame` 本體仍為 `measureQuality(v, v.videoWidth, v.videoHeight)`,本體內無任何 `roi` 字樣,
`resetPreviewGeometry()` 與 `recompute()` 的呼叫關係不變 —— 快門鎖定行為(§0.1)未受影響。

### §2.5 版本標記

`lastShotInfo.shotGateBase = "ROI(裁切後)"`(`:1066`),`shotSummary` 以 `閘門基底 …` 印出(`:2101`),
`shotGate` 欄位名與 PDF 的「本張閘門 」行不變。`demo/index.html` 無 shot 路徑,不需同步。

**T2 = PASS。**

---

## T3 judgment —— 驗收契約與斷言有效性

### 斷言有效性:由 Tester 獨立重做「把 bug 種回去」

**不採信 RD 自述。** 以 `rsync` 複製全 repo 到 scratchpad(`…/scratchpad/mut`,`node_modules` 軟連結),
在**複本**上種回舊寫法後跑 `npx vitest run tests/shot-gate-roi-sync.test.ts tests/imgproc.test.ts`,
每次跑完立即還原。專案工作目錄的 `demo/` 全程未被修改。

| # | 種回去的 bug | 轉紅的測試 | 結果 |
|---|---|---|---|
| M1 | `gateOn(shotQRoi)` → `gateOn(shotQFull)` | AC-6 報告用的閘門是 gateOn(shotQRoi)… | 1 failed / 259 passed |
| M2 | `resolution: pxmMeasured` → `resolution: true` | AC-9②/AC-12 measured 三項取自實際狀態… | 1 failed / 259 passed |
| M3 | `measureFrame` 改吃 ROI | AC-10 預覽路徑仍為全幀… | 1 failed / 259 passed |
| M4 | `summarizeShotGate` 輸出退回「全部 OK」 | imgproc 三態組 **8 支**同時轉紅(含 AC-7 行為面) | 8 failed / 252 passed |
| M5 | 拿掉未量測分流(退回兩態,未量測被算進 OK) | imgproc 三態組 **4 支**轉紅 | 4 failed / 256 passed |
| M6 | `roiCanvasOf(photo, roiFull)` → `roiCanvasOf(small, roiFull)` | AC-5 shotQRoi 由 measureQuality 量在… | 1 failed / 259 passed |
| M7 | 新鮮度改吃 `shotGateRoi` | AC-11 取幀新鮮度仍比全幀… | 1 failed / 259 passed |

全部還原後複本重跑:**260 passed / 0 failed**。
七種回歸各自都有對應斷言會變紅,**沒有「無論如何都會通過」形式的斷言**。

另檢查守門測試本身的品質:
- `stripLineComments` 確實先去行註解才斷言,避免註解裡的「全部 OK」「gateOn(shotQFull)」變成假警報(規格 §3.2 明列的陷阱)。
- `functionBody` / `blockAfter` 以大括號配對縮到函式或區塊本體,AC-10 / AC-9② 不是全檔字串比對 —— 這是有效斷言而非存在性斷言。
- AC-9② 額外斷言 `pxmMeasured = true` 全檔只出現一次,才談得上「2D 恆為未量測」。

### 規格涵蓋度與驗收標準合理性

E1–E9 九個 edge case 逐條對回程式,均有對應路徑或既有保護(E1 中央 70% ROI、E2 `scaleRoi` 保底、
E3 未矯正基底、E4/E5 `pxmMeasured`、E6 `if (lastShotInfo)`、E7 全幀那一對、E8 不鎖快門、E9 未列鍵視為已量測)。
AC-1~AC-13 全部可被指令或原始碼證據驗證,無「靠人眼看起來對」的條目。
規格 §5 已誠實宣告「改動前後的檢驗紀錄不可互比」,並以 `shotGateBase` 作為版本標記 —— 這一點做得比一般規格嚴謹,無歧義或矛盾。

**T3 = PASS。**

---

## 誠實邊界(本輪驗證不到的)

依規格 §3.4,以下**未經驗證**,不得當成已驗:

1. **執行期行為完全沒驗。** 沒有開相機、沒有按快門、沒有看結果頁、沒有產 PDF。
   `roiCanvasOf` 的 `document.createElement("canvas")` / `drawImage` 這條路在 Node 下跑不到,
   T2 對它的結論全部來自**靜態閱讀 + 純函式層的行為測試**。
2. **`npm run typecheck` 只掃 `src/`**,`demo/*.js` 與 inline JS 沒有型別檢查覆蓋;
   `demo/mobile.html` 的改動只有本輪新增的靜態守門測試在看。
3. **ROI 與全幀的實際讀數差異沒有量過。** 規格 §1.1 引用的「30247 vs 58」「眩光 100% vs 1%–4%」
   是稽核既有的數字,本輪未重現;「本張閘門從此會印出不同結論」這件事是**推論**,要實機才算證實。
4. 真正的執行期實測(本機 8765 測試台)依規格不寫進本輪 DoD,留給主 session。

### 一條非阻斷的觀察(供主 session 實機時留意,不影響本輪結論)

`roiCanvasOf` 每次快門會額外配置一張**全解析度**的 ROI canvas(解碼失敗走中央 70% 時可達約 2822×2117 ≈ 5.97M px)。
它不經過 `fitRoiToBudget` 的 `MAX_ROI_PIXELS` 取樣預算 —— 那道預算之所以存在,正是因為 iOS Safari 舊機會因大 canvas 被系統回收分頁。
本輪只在 320 寬的 `workCanvas` 上 `getImageData`(未對全解析度取像素),風險等級低於既有的 `photo` 本身;
且這是**規格 §2.1 明文指定的做法**,不是實作偏離。**Tester 無法在 Node 下重現,故不列為 finding**,
僅建議實機驗收時在舊機(iOS Safari)連拍數張觀察是否有分頁重載。

---

## 驗收結論

| 層 | 結果 | 說明 |
|---|---|---|
| T1 deterministic | PASS | typecheck / build exit 0;603 支測試全綠,無既有測試被破壞 |
| T2 semantic | PASS | A-10 改量 ROI、A-01 三態、§1.3 新鮮度脫鉤,逐條對回規格條文與行號皆相符 |
| T3 judgment | PASS | 七種回歸各自轉紅、還原全綠;E1–E9 全覆蓋;驗收標準本身可驗且無歧義 |

**result = PASS,failedLayer = NONE,route = NONE。**
