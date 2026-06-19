// Acceptance evaluation engine (spec Part B §B3 門檻判定, §B5, AcceptancePolicy C3.2,
// C9.3 example). Deterministic: takes an already-computed GradeResult and a policy,
// returns the pass/fail decision plus a signed marginScore for alerting/trends (C7.3).

import type {
  GradeResult,
  AcceptancePolicy,
  AcceptanceEvaluation,
} from "../domain/types.js";
import { isAtLeast, letterToNominalScore } from "../domain/scale.js";

/**
 * Decide whether a graded result meets a customer acceptance policy.
 *
 * - pass: overall grade is at least the required grade (e.g. B ≥ C → pass).
 * - marginScore: overallScore − requiredScore (positive = headroom, negative =
 *   shortfall), per spec C7.3 `marginScore = overallScore − requiredScore`.
 */
export function evaluateAcceptance(
  grade: GradeResult,
  policy: AcceptancePolicy,
): AcceptanceEvaluation {
  return {
    policyId: policy.id,
    requiredGrade: policy.requiredGrade,
    pass: isAtLeast(grade.overall, policy.requiredGrade),
    marginScore: grade.overallScore - letterToNominalScore(policy.requiredGrade),
  };
}
