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
