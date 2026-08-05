# Handoff — M-Code(瓦楞箱條碼 / QR 品質檢驗核心庫)

> 最後更新:2026-08-05T19:45+0800

## Current Task

`spec20260731-1.md` 影像層六階段。**階段 ①②③④⑤ 程式面完成但實機未驗;⑥ 未開始**。

2026-08-05 插入一輪**對抗性稽核 + 六項裁示的實作**(`report20260805-1.md`)。
稽核提出 33 條、CONFIRMED 28。Eric 六項全採建議((b))。**已全部實作完畢。**

## Done

- **階段 ①②③(2026-07-31,`report20260731-1.md`)** — 解析度偵測與三層降級取幀、GSD 誠實化、
  梯形矯正核心純函式。**三階段皆實機未驗**。
- **C3.1 型別放寬 + C4.2/C3.1 守門測試(2026-08-01,`report20260801-1.md`)**。
- **階段 ④ 接線(2026-08-03,`report20260803-1.md`)** + **決策 ③(c)的 QR 半邊**。
- **階段 ⑤ 的 1D 半邊(2026-08-04,`report20260804-1.md`)** — `quadFrom1DEdges` 四條邊各自
  獨立擬合;合成情境傾角誤差最大 0.037°;三條分支(1D / QR v≥2 / DataMatrix)都用探針實跑過。
- **對抗性稽核 + 六項裁示實作(2026-08-05,`report20260805-1.md`,本輪)** ——
  **`src/` 零變更,`policies.ts` 門檻一行未動。** 測試 415 → **431**。
  - **D5①** 相機串流中斷偵測:`camFault` + `watchTrackHealth`(ended/mute/unmute)+
    `visibilitychange` + 取幀前 `cameraFaultNow()` 複驗。**是可用性守衛不是品質閘門。**
  - **D5②** 模擬模式全程標記:快門標籤、結果頁標記條、清單「示範」、PDF 標記區塊、
    XLS「資料狀態」欄,且**不計入通過率分母**。
  - **D5③** 快門後閘門讀數:`inspectReal` 補跑一次 `evaluateGate` → `lastShotInfo.shotGate`
    → PDF「本張閘門」。**不鎖快門、不改分級。**
  - **D5④** `recordShot` 請求欄:各層傳自己真正送出的那組,沒送出印「未請求」。
  - **D4** 量不到就不出等級:純函式 `assessMeasurability`(`imgproc.js`),三條路徑同一出口;
    1D 掃描線全滅時**拔掉了硬寫的 `{0.5,0.5,0.5}` 兜底**;橫躺給轉正指引。
  - **D3** 光度基底與幾何分離:1D `useRectified` 時幾何吃 `rect`、光度吃 `rg`;2D 不變。
  - **D1** 白平衡移出燈號面板(現在四盞燈),讀數改存進 shot → PDF。
    **`classifyWhiteBalance` 與兩份守門測試一行不動。**
  - **D2** 規格新增 §3.4b 能力→功能→降級矩陣;程式加 `samplingNote()` 中性取樣註記。
  - **D6** 規格 §5.2 加四列必記欄位表(零程式改動)。
- **本輪被實測證實 / 推翻的事**
  1. **稽核宣稱的光度崩塌是真的**:同圖對照下矯正影像的 `minEdgeContrast` **0.654 → 0.000**,
     而 `rLight`/`rDark` 兩側差距 < 0.25 —— **證明不是矯正把影像弄糊,是取樣範圍不同**。
     0° 拍攝同樣成立,與傾角無關。已成為 repo 內的守門測試。
  2. **規格 §1.5 表格第二列從未成立**(規格第三次自己過期)—— 原文「快門後依真實
     pxPerModule 判定,可能 WARN/FAIL」,實際上 `finally` 會先蓋回 0/0/9。已回寫。
  3. **一個因果誤解要改掉**:拍攝頁 perspective 燈恆綠 **跟焦距拿不拿得到無關**,
     是 `resetPreviewGeometry()` 每 500ms 無條件寫回 0。就算焦距拿得到、實測 30°,燈一樣綠。
  4. 實作到一半自己收緊了一條:原本 `simulated` 會 short-circuit 掉解碼判定,瀏覽器實跑
     發現「示範 + 不可讀」照樣吐等級 B —— 那正是要拔掉的心智模型。改成兩軸獨立。

## Next Step

**不卡實機的項目已全部做完。** 順序:

1. **8765 雙平台實機驗收(一次把 ①②③④⑤ 做完)** — 三步缺一不可,見 Key Context。
   **必記欄位已擴充**,權威清單在規格 §5.2 那張四列表:
   `state.gate.wb`(牛皮箱面、自然光)/ `JSON.stringify(getSettings())` 全文 /
   鏡頭朝向 / 1D 矯正時 `geo` 的取樣尺寸。加上原本的請求值 / 實拿值 / 分析寬 / L1-L2-L3。
   ⚠️ **D5④ 修正之前取得的請求值一律作廢**(舊值會印出從未送出的請求)。
2. **押後的兩件演算法改動(D5 明確裁示留到下一輪)** — 1D 橫躺的方位處理(讓量測跟著符號
   主軸走)、`edgeFitRoi` 沿定位線法向而非影像 y 軸外擴。**兩件都要動演算法,
   應該連同實拍誤拒率一起看**,不要在沒有實拍數字時先改。
3. **取樣密度規則** — 低於門檻關掉 `useRectified`。要加就加在 `rectifyPlan`,且**必須等**
   §5.2 的實機數字(規格 §6.1 門檻凍結)。
4. **階段 ⑥ torch** — 需 Android 實機。

## Key Context

- **git** — 分支 `main`。**2026-08-05 20:38 已 push 到 `origin/main`(`4b107aa..80325ec`,
  三個 commit:`feat(imgproc)` 純函式 + 測試 / `feat(demo)` D1–D5 實作 / `docs` 規格與報告)。**
  唯一可能未推的是本行所在的這次 handoff 更正(收工前補的),`git log origin/main..HEAD`
  一查便知。往後 push 仍依全域 §0 需 Eric 明確同意。
- **已上線** — 本輪已 `npm run build` → `rsync -a --delete` 到 `~/m-code-site`,
  `https://m-code.ericchh.work` 是最新內容。
  **驗法不是看 HTTP 200,是比 hash**;`demo/mobile.html` 的 hash **會對不上,那是正常的** ——
  Cloudflare 在 `</body>` 前注入 bot-detection script,差異僅此一段。
- **實跑基線(2026-08-05)** — `npm test` **14 檔 431 測試**全綠(`tests/imgproc.test.ts` 174);
  `npm run typecheck`、`npm run build` 通過。測試數 SSOT 是規格 §5.1 表,**收工當場加一列**。
- **實機驗收要跑的三步(缺一不可)** —
  `npm run build` → `rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/`
  → 8765 測試台實際操作。**只 git pull 不 rsync = 線上不會變**。
- **沒有實機時怎麼驗 `demo/*.html`** — 假相機探針。**做法與 ITF 編碼表已寫進
  `report20260805-1.md` §5**(上一輪只寫了做法沒留碼,這次補上),照著重建即可。
  兩個省時間的點:① 快門 FAIL 時是 `disabled`,`.click()` 沒反應,改呼叫
  `document.getElementById('shutter').onclick()` 走的仍是同一條 `inspect()`;
  ② 驗 PDF 時先把 `window.print` 換成 no-op,否則列印對話框會卡住整個工具。
  **探針檔驗完就刪**(本輪已刪並確認對外 404)。
- **文件** — 規格 `docs/spec20260731-1.md`(**新增 §3.4b 降級矩陣 / §3.4c 可量測性 /
  §3.4d 光度基底**);報告 `report20260731-1.md`、`report20260801-1.md`、`report20260803-1.md`、
  `report20260804-1.md`、**`report20260805-1.md`(本輪,含探針原始碼)**。
  稽核決策頁:https://claude.ai/code/artifact/4a8a0961-41e9-4239-9cad-12e8c3420bad
- **守門測試的分工** — `rules-spec-sync.test.ts` 守 C8;`gate-spec-sync.test.ts` 守 C4.2 + C3.1;
  `imgproc.test.ts` 守 `QUAD_CONFIDENCE_LIMITS` / `LINE_FIT_LIMITS` / `ONE_D_SYMBOLOGIES`
  整表,**外加本輪的可量測性護欄(文案不得含 ISO/合規/不合格/印壞)與光度基底對照**。

## Risk / Note

- **稽核的 28 條 CONFIRMED 不代表我在瀏覽器裡重現了失效。** 那是「另一個 agent 打開行號
  重讀確認程式碼確實如此」。全部來自靜態閱讀與 Node 重演,**一條都沒實拍過**。
- **三條 UNCERTAIN 拿一次實機讀數就能定案**:牛皮紙上白平衡是否恆亮 WARN、
  單通道飽和是否高估 SC、`focalLength` 兩平台可得性。**不要當成已確認的事實引用。**
- **本輪沒驗到的**(`report20260805-1.md` §4.3 完整列出):
  ① D3 的「光度基底 未矯正 ROI」分支沒在瀏覽器走到(探針合成圖條端擬合失敗,調兩輪停手;
  該分支的實質行為已由 vitest 同圖對照直接證實);② D5① 的中斷偵測沒有實機驗
  (`ended`/`mute` 在假相機上不會自然發生);③ 實拍一次都沒有。
- **1D 走矯正在低取樣密度下會讓 DEC 變差**(5px/module 時 avgMaxDev 0 → 0.5)。
  本輪**刻意不改行為**,8765 驗收要記這組數字。
- **C1 是這條產品線最貴的教訓,不要退化。** 任何「把對邊取成平行」的簡化都會讓傾角恆 0°,
  而 0° 是 ≤5° 閘門最寬鬆的放行值。護欄測試(平行四邊形對照組)不得刪。
- **`rectifyPlan` 與 `assessMeasurability` 是唯二該加規則的地方。**
  「要不要用矯正 / 要不要用單應傾角」往前者加;「這種情況該不該出等級」往後者加。
  **一寫進 `mobile.html` 就再也驗不了。**
- **QR 的傾角只限 v≥2**;v1 沒有 alignment pattern,仍走補點 → `derived` → 代理值。
- **即時迴圈的 `pxm` 仍硬寫 9、`tilt` 仍還原 0°** —— 快門前 resolution / perspective 燈恆綠,
  屬 §6.3 待辦。**D5③ 修的是「把快門後量到的記下來」,不是讓它參與判定。**
- **焦距在實機上拿不拿得到,仍然不知道。** 這仍是最該驗的一件事。
- **不得調 `policies.ts` 的任何允收門檻** —— 需先做「提高解析度前 / 後」的實拍對照(§6.1)。
- **白平衡是歷史誤判熱區** —— 本輪只動 UI 與紀錄,**引擎與兩道守門測試一行未改**,
  硬閘門復辟的護欄完整保留。
- **SessionStart hook 的日期不可信** —— 文件命名前先跑 `date`(本輪已核對:2026-08-05 19:41)。
