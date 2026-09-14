// Representative acceptance policies (spec §C3.2, §D2). ITF-14 commonly ≥C,
// GS1-128 commonly ≥B. xDimSpecMm/quietZoneMinX per ITF-14 100% spec (§D2).
//
// **每一個 Symbology 都必須在這裡有一筆**(稽核 A-08,`tests/policy-coverage.test.ts` 釘住)。
// 少一筆的後果不是出錯,是呼叫端自己生一個門檻出來 —— 那個門檻就跑到 §6.1 的治理之外了。
import type { AcceptancePolicy } from "../domain/types.js";

export const SEED_ACCEPTANCE_POLICIES: AcceptancePolicy[] = [
  {
    id: "itf14-direct-default",
    symbology: "ITF14",
    requiredGrade: "C",
    xDimSpecMm: 1.016, // ITF-14 100% X 寬
    quietZoneMinX: 10, // ≈10 X（§D2）
  },
  {
    id: "gs1-128-default",
    symbology: "GS1_128",
    requiredGrade: "B",
    xDimSpecMm: 1.016,
    quietZoneMinX: 10,
  },
  // ── 以下三筆為 2026-09-14 補齊(稽核 A-08)────────────────────────────
  // 由來:`demo/mobile.html` 的 `policyOf()` 找不到 policy 時會退回一個**寫在 HTML 裡**
  // 的 `requiredGrade:"C"`。CODE128 / QR / DATAMATRIX 三種符號別從來沒有 policy,
  // 所以它們的允收門檻實際上一直由那行 fallback 決定 —— 不受規格 §6.1 的門檻凍結治理、
  // 沒有任何守門測試,而且改它不需要碰 src/,審不到。
  //
  // **這三筆不改變任何現行嚴格度**:值就是那行 fallback 一直在用的 C。
  // 這是把既有行為搬進受治理的地方,不是調門檻(§6.1 凍結仍然有效)。
  //
  // xDimSpecMm / quietZoneMinX 給 0 = 「沒有適用的尺寸規格」,與 fallback 一致:
  // CODE128 的 X 寬隨應用而定,2D 根本沒有 X 寬與靜區 X 倍數的對應概念。
  // 填一個看起來合理的數字等於編造規格,下游的尺寸判定會據此給出無意義的結論。
  {
    id: "code128-default",
    symbology: "CODE128",
    requiredGrade: "C",
    xDimSpecMm: 0,
    quietZoneMinX: 0,
  },
  {
    id: "qr-default",
    symbology: "QR",
    requiredGrade: "C",
    xDimSpecMm: 0,
    quietZoneMinX: 0,
  },
  {
    id: "datamatrix-default",
    symbology: "DATAMATRIX",
    requiredGrade: "C",
    xDimSpecMm: 0,
    quietZoneMinX: 0,
  },
];
