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

// ── 直印瓦楞(需版製程)的 GS1 數值 ─────────────────────────────────────────
// 出處:GS1 General Specifications Release 16.0(2016-01)。**只適用需版(plate-based)製程**;
// 數位/噴墨等無版直印不在這些規則內,不要對它們套用本 helper。
// seed policy 本身**仍不填**這三個欄位(行為與現行相同);要用直印判定的呼叫端明確走
// `plateDirectPrintPolicy`,由此可 grep 到所有使用者。
/** X 寬下限(mm)。p.263 腳註:低於此值的 ITF-14 SHOULD NOT 以傳統(需版)製程直印瓦楞。 */
export const GS1_ITF14_PLATE_DIRECT_X_MIN_MM = 0.635;
/** 需版製程的 bearer bar 固定厚度(mm)。§5.3.2.4。 */
export const GS1_BEARER_BAR_PLATE_MM = 4.83;
/** 無版製程的 bearer bar 下限(窄條寬倍數)。§5.3.2.4。 */
export const GS1_BEARER_BAR_PLATELESS_MIN_X = 2;

/**
 * 把一筆 policy 轉成「需版直印瓦楞」版本。輸入:base policy;輸出:新物件(不改動 base)。
 * 只加直印欄位,**requiredGrade / xDimSpecMm / quietZoneMinX 一個字都不動**(§6.1 凍結)。
 * GS1 對直印瓦楞另有較低的最低驗收(0.5/20/660)—— 那是門檻決策,未經 Eric 裁示與實拍對照,
 * 這裡刻意不採用(見 docs/design20261105-1.md)。
 */
export function plateDirectPrintPolicy(base: AcceptancePolicy): AcceptancePolicy {
  return {
    ...base,
    substrate: "corrugated-direct",
    directPrintXMinMm: GS1_ITF14_PLATE_DIRECT_X_MIN_MM,
    bearerBarPlateMm: GS1_BEARER_BAR_PLATE_MM,
  };
}

// ── 允收標準檔位:高標 / 標準(2026-11-10 Eric 指示「設高標、標準可切換」)──────────
// 高標 = SEED_ACCEPTANCE_POLICIES 原樣(預設,§6.1 凍結的現行門檻,一個字母沒動)。
// 標準 = 把 GS1 一般規格 Release 16(pdf p.263 驗收表)明列、且與高標不同的符號別降到該表等級:
//   目前只有 GS1-128(高標 B → 標準 C,表列 1.5/10/660)。
// **ITF-14 在標準檔位刻意不降到 D**:GS1 對直印瓦楞的 D 屬牛皮紙門檻決策(Eric 選 C,先蒐集實拍),
// 未決前不採用(見 docs/design20261105-1.md)。QR / DM / Code128 GS1 表無對應列,維持原值。
// 所有等級仍為相對代理值,檔位名稱不代表任何合規認證。
export type AcceptanceProfileId = "high" | "standard";

/** 兩個檔位的顯示名稱與預設檔位。 */
export const ACCEPTANCE_PROFILES: ReadonlyArray<readonly [AcceptanceProfileId, string]> = [
  ["high", "高標"],
  ["standard", "標準"],
];
export const DEFAULT_ACCEPTANCE_PROFILE: AcceptanceProfileId = "high";

/** 標準檔位相對高標的等級覆寫(只列有 GS1 表依據的符號別)。 */
const STANDARD_GRADE_OVERRIDES: Readonly<Partial<Record<AcceptancePolicy["symbology"], AcceptancePolicy["requiredGrade"]>>> = {
  GS1_128: "C",
};

/**
 * 取某檔位的 policy 清單。輸入:檔位(未知值一律回高標);輸出:新陣列,不改動 seed。
 * 標準檔位被覆寫的 policy 其 id 加 `-standard` 後綴,方便 log 區分。
 */
export function acceptancePoliciesFor(profile: AcceptanceProfileId | string | null | undefined): AcceptancePolicy[] {
  if (profile !== "standard") return SEED_ACCEPTANCE_POLICIES.map((p) => ({ ...p }));
  return SEED_ACCEPTANCE_POLICIES.map((p) => {
    const g = STANDARD_GRADE_OVERRIDES[p.symbology];
    return g && g !== p.requiredGrade ? { ...p, id: `${p.id}-standard`, requiredGrade: g } : { ...p };
  });
}

/** 取某符號別在某檔位的 policy;找不到回 undefined(呼叫端負責缺漏告警)。 */
export function policyForProfile(
  symbology: AcceptancePolicy["symbology"],
  profile: AcceptanceProfileId | string | null | undefined,
): AcceptancePolicy | undefined {
  return acceptancePoliciesFor(profile).find((p) => p.symbology === symbology);
}
