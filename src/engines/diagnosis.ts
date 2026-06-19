// Diagnosis rule engine — spec §C8.
// Data-driven: after grading, evaluate every rule (filtered by symbology /
// substrate), and emit matched "cause + remedy" hits sorted by severity desc.
// The seed rule set itself lives in src/data/rules.ts (built elsewhere); this
// module only evaluates whatever rules it is given.

import type {
  DiagnosisHit,
  DiagnosisResult,
  DiagnosisRule,
  RuleCondition,
  RuleOp,
  SubstrateCategory,
  Symbology,
} from "../domain/types.js";

/** Evaluation context: the symbology under test, optional substrate category,
 *  and a flat record of already-computed metric values the rules reference
 *  (e.g. "MOD.score", "barWidthGainMm", "quietZoneX", "decoded"). */
export interface DiagnosisContext {
  symbology: Symbology;
  substrateCategory?: SubstrateCategory;
  metrics: Record<string, number>;
}

/** Apply a single comparison operator. */
function compare(actual: number, op: RuleOp, expected: number): boolean {
  switch (op) {
    case "<":
      return actual < expected;
    case ">":
      return actual > expected;
    case "<=":
      return actual <= expected;
    case ">=":
      return actual >= expected;
    case "==":
      return actual === expected;
  }
}

/** A condition matches only when its metric is present in the context AND the
 *  operator comparison holds. A missing metric never matches. */
function conditionMatches(
  cond: RuleCondition,
  metrics: Record<string, number>,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(metrics, cond.metric)) return false;
  const actual = metrics[cond.metric];
  if (actual === undefined) return false; // guard noUncheckedIndexedAccess
  return compare(actual, cond.op, cond.value);
}

/** A rule matches when the symbology applies, the substrate filter (if any)
 *  admits the context's category, and every `when` condition holds (AND). */
function ruleMatches(rule: DiagnosisRule, ctx: DiagnosisContext): boolean {
  if (!rule.appliesTo.includes(ctx.symbology)) return false;
  if (rule.substrateCategories && rule.substrateCategories.length > 0) {
    if (
      ctx.substrateCategory === undefined ||
      !rule.substrateCategories.includes(ctx.substrateCategory)
    ) {
      return false;
    }
  }
  return rule.when.every((cond) => conditionMatches(cond, ctx.metrics));
}

/** Evaluate all rules against the context and return matched hits sorted by
 *  severity descending (3 first). Ties keep input rule order (stable sort). */
export function evaluateDiagnosis(
  rules: DiagnosisRule[],
  ctx: DiagnosisContext,
): DiagnosisResult {
  const matched: DiagnosisHit[] = rules
    .filter((rule) => ruleMatches(rule, ctx))
    .map((rule) => ({
      ruleId: rule.id,
      cause: rule.cause,
      remedy: rule.remedy,
      severity: rule.severity,
    }));

  matched.sort((a, b) => b.severity - a.severity);
  return { matched };
}
