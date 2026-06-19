# 瓦楞箱條碼 / QR 品質檢驗 — 核心引擎庫（TypeScript）

本套件實作規劃書 [`corrugated_barcode_qc_app_master_v1.md`](./corrugated_barcode_qc_app_master_v1.md)
**Part C（系統 / 開發規格 SDD）** 的確定性核心邏輯，為一個**前端無關、可攜、純運算**
的核心庫。任何前端（規劃書建議的 Flutter，或其他 JS host）皆透過 FFI / 直接呼叫此核心。

> **定位護欄（規劃書 A3 / D1）**：所有等級皆為**相對代理值（proxy）**，`isRelative` 恆為
> `true`，**非 ISO 合規驗證、不出具證書**。合規驗證需改用具固定照明幾何的合規 verifier。

## 為何是純運算核心

規劃書建議 Flutter + OpenCV + ZXing 的行動 App。本環境（無 Flutter/Dart、無真機與實拍影像）
無法建置/驗證原生 UI 與 CV 影像基元。因此本庫聚焦規劃書真正的**工程核心與可驗證部分**：
閘門判定、解碼結果正規化、量測換算、相對分級、診斷規則、驗收、ERP/CSV——
所有真實 I/O（像素、ZXing/libdmtx、OpenCV、HTTP）一律**抽象為注入介面或已算好的數值輸入**。
影像基元（Laplacian 變異數、FFT 楞痕、反射正規化的取像）與 UI 由後續真機階段以 adapter 實作。

## 模組對應規格

| 模組 | 檔案 | 規格 |
|---|---|---|
| 領域模型 | `src/domain/types.ts` | C3 |
| 等級換算（letter↔score） | `src/domain/scale.ts` | C7.3 / D1 |
| 版本旗標 / Tier 閘門 | `src/domain/flags.ts` | C10.1 |
| 拍攝品質閘門（六燈號 + 狀態機） | `src/engines/gate.ts` | C4 |
| 解碼邊界（注入 Decoder、GTIN 比對、不可讀路徑） | `src/engines/decode.ts` | C5 |
| 量測引擎（pxPerMm/gsd、X 寬、BWR、Quiet Zone、楞痕） | `src/engines/measurement.ts` | C6 |
| 相對分級引擎（反射正規化、proxy 參數、1D 平均/2D 取最低） | `src/engines/grade.ts` | C7 |
| 診斷規則引擎（資料驅動） | `src/engines/diagnosis.ts` | C8 |
| 驗收評估（pass/marginScore） | `src/engines/acceptance.ts` | B3/B5 |
| ERP 客戶端 + 離線佇列（注入 transport/clock） | `src/erp/client.ts` | C9.1–9.3, 9.5 |
| CSV 匯出（22 欄固定順序） | `src/export/csv.ts` | C9.4 |
| 種子診斷規則（7 條） | `src/data/rules.ts` | C8 |
| 楞距表 + 查詢 | `src/data/flutes.ts` | D3 |
| 基準檔（四類 substrate） | `src/data/profiles.ts` | C3.2 |
| 驗收政策（ITF-14 ≥C、GS1-128 ≥B） | `src/data/policies.ts` | C3.2 / D2 |

`src/index.ts` 為單一進入點，re-export 全部領域型別與引擎。

## 使用

```bash
npm install
npm run typecheck   # tsc --noEmit（src）
npm test            # vitest，124 測試
npm run build       # 產出 dist/ 型別宣告 + JS
```

完整 edge pipeline（規劃書 C1：閘門→解碼→量測→分級→診斷→驗收→CSV）的跨模組組合，
見整合測試 [`tests/pipeline.integration.test.ts`](./tests/pipeline.integration.test.ts)。

## 驗證狀態

- **typecheck**：乾淨（strict + `noUncheckedIndexedAccess`）。
- **測試**：124 passing（11 檔），含單元測試與一支端到端 pipeline 整合測試。
- 對應規劃書 C11 的閘門邊界值、分級帶切、診斷規則過濾、ERP 冪等/離線佇列、CSV 欄序等驗收項。

## 後續真機階段（本核心之外，需 Flutter/原生）

對照規劃書 Backlog（C12）尚未涵蓋、且需真機/原生環境者：

- **CV 影像基元 adapter**：Laplacian 變異數、glare 占比、楞痕 FFT、白平衡增益、比例尺/角點偵測
  ——產出本庫 `GateMeasurements` 與量測/分級的數值輸入。
- **解碼 adapter**：ZXing-C++（ITF-14 / Code128）、ZXing QR、libdmtx，實作 `Decoder` 介面。
- **相機層**：AVFoundation / CameraX，AE/AF/AWB lock（C2 可重複性硬需求）。
- **UI**：Part B 三畫面（拍攝 HUD / 結果儀表 / 趨勢）。
- **本地儲存**：SQLite（Profile/設定/離線佇列）。
- **Server（進階版）**：離峰學習、校正基準管理、預警推播。
- **C11 可重複性協定（Gauge R&R）**：需真機 1 樣本×30 擷取×3 操作員實測，非純邏輯可驗。
