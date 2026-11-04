// Acceptance evaluation engine (spec Part B §B3 門檻判定, §B5, AcceptancePolicy C3.2,
// C9.3 example). Deterministic: takes an already-computed GradeResult and a policy,
// returns the pass/fail decision plus a signed marginScore for alerting/trends (C7.3).

import type {
  GradeResult,
  AcceptancePolicy,
  AcceptanceEvaluation,
} from "../domain/types.js";
import { isAtLeast, letterToBandCut } from "../domain/scale.js";

/**
 * 允收判定:輸入已算好的 GradeResult 與客戶允收政策,輸出 pass 與 marginScore。
 *
 * - pass:總級字母 ≥ 門檻字母(例:B ≥ C → 通過)。
 * - marginScore:overallScore − requiredScore(C7.3),requiredScore 取門檻
 *   字母的帶下界(C=1.5),使 margin ≥ 0 ⟺ pass,符合 C9.3 實例
 *   (score 1.8、門檻 C → pass、margin +0.3)。正=餘裕、負=不足。
 */
export function evaluateAcceptance(
  grade: GradeResult,
  policy: AcceptancePolicy,
): AcceptanceEvaluation {
  return {
    policyId: policy.id,
    requiredGrade: policy.requiredGrade,
    pass: isAtLeast(grade.overall, policy.requiredGrade),
    marginScore: grade.overallScore - letterToBandCut(policy.requiredGrade),
  };
}

/** X 寬下限判定結果。N/A = policy 沒有可用的下限,不做判定。 */
export type DirectPrintXVerdict = "OK" | "BELOW" | "N/A";

/**
 * 直印瓦楞的 X 寬下限判定(設計說明 §4)。
 * 輸入:policy 與量到的 X 寬(mm);輸出 OK / BELOW / N/A。
 *
 * 只有同時滿足才判定,其餘一律 N/A(不丟例外、不靜默採用壞值):
 *   - policy.substrate === "corrugated-direct"
 *   - policy.directPrintXMinMm 是有限且 > 0 的數字
 * 量測值不是有限正數時回 N/A —— 量不到不能當作「達標」也不能當作「不足」。
 * 等於下限算 OK(下限是「可接受的最小值」)。
 */
export function checkDirectPrintXDim(
  policy: AcceptancePolicy,
  measuredXMm: number | null | undefined,
): DirectPrintXVerdict {
  if (policy.substrate !== "corrugated-direct") return "N/A";
  const floor = policy.directPrintXMinMm;
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor <= 0) return "N/A";
  if (typeof measuredXMm !== "number" || !Number.isFinite(measuredXMm) || measuredXMm <= 0) {
    return "N/A";
  }
  return measuredXMm >= floor ? "OK" : "BELOW";
}
