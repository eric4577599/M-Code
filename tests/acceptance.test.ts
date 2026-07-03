import { describe, it, expect } from "vitest";
import { evaluateAcceptance } from "../src/engines/acceptance.js";
import type {
  GradeResult,
  AcceptancePolicy,
  GradeLetter,
} from "../src/domain/types.js";

function grade(overall: GradeLetter, overallScore: number): GradeResult {
  return { overall, overallScore, isRelative: true, parameters: [] };
}

function policy(
  requiredGrade: GradeLetter,
  id = "pol-1",
): AcceptancePolicy {
  return {
    id,
    symbology: "ITF14",
    requiredGrade,
    xDimSpecMm: 1.016,
    quietZoneMinX: 10,
  };
}

describe("evaluateAcceptance", () => {
  it("passes when grade exceeds requirement (B ≥ C, spec B3 example)", () => {
    const result = evaluateAcceptance(grade("B", 2.7), policy("C"));
    expect(result.pass).toBe(true);
    // marginScore = 2.7 − bandCut(C)=1.5 → +1.2
    expect(result.marginScore).toBeCloseTo(1.2, 10);
    expect(result.marginScore).toBeGreaterThan(0);
  });

  it("matches the C9.3 worked example (score 1.8, required C → pass, marginScore +0.3)", () => {
    // 規格 C9.3 實例原文:score 1.8、requiredGrade C、pass true、marginScore 0.3
    const result = evaluateAcceptance(grade("C", 1.8), policy("C"));
    expect(result.pass).toBe(true);
    expect(result.marginScore).toBeCloseTo(0.3, 10);
  });

  it("passes with zero margin exactly at the band cut (C = 1.5)", () => {
    const result = evaluateAcceptance(grade("C", 1.5), policy("C"));
    expect(result.pass).toBe(true);
    expect(result.marginScore).toBeCloseTo(0, 10);
  });

  it("fails when grade is below requirement (D < C) with negative margin", () => {
    const result = evaluateAcceptance(grade("D", 1.2), policy("C"));
    expect(result.pass).toBe(false);
    // marginScore = 1.2 − 1.5 → −0.3
    expect(result.marginScore).toBeCloseTo(-0.3, 10);
    expect(result.marginScore).toBeLessThan(0);
  });

  it("fails GS1-128-style stricter requirement (C < B)", () => {
    const result = evaluateAcceptance(grade("C", 2.4), policy("B", "gs1"));
    expect(result.pass).toBe(false);
    expect(result.marginScore).toBeCloseTo(-0.1, 10);
  });

  it("pass and margin sign always agree (margin ≥ 0 ⟺ pass)", () => {
    // 修正前用名目分(C=2)當 requiredScore,1.5–2.0 區間會 pass 但 margin<0
    const passing = evaluateAcceptance(grade("C", 1.8), policy("C"));
    expect(passing.pass).toBe(true);
    expect(passing.marginScore).toBeGreaterThanOrEqual(0);
    const failing = evaluateAcceptance(grade("D", 1.49), policy("C"));
    expect(failing.pass).toBe(false);
    expect(failing.marginScore).toBeLessThan(0);
  });

  it("echoes policyId and requiredGrade", () => {
    const result = evaluateAcceptance(grade("A", 3.9), policy("B", "cust-42"));
    expect(result.policyId).toBe("cust-42");
    expect(result.requiredGrade).toBe("B");
    expect(result.pass).toBe(true);
    expect(result.marginScore).toBeCloseTo(1.4, 10);
  });
});
