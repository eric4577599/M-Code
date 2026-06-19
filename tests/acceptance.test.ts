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
    // marginScore = 2.7 − nominal(C)=2 → +0.7
    expect(result.marginScore).toBeCloseTo(0.7, 10);
    expect(result.marginScore).toBeGreaterThan(0);
  });

  it("matches the C9.3 worked example (required C, marginScore 0.3)", () => {
    const result = evaluateAcceptance(grade("C", 2.3), policy("C"));
    expect(result.pass).toBe(true);
    expect(result.marginScore).toBeCloseTo(0.3, 10);
  });

  it("passes on exact-equal nominal score (zero margin)", () => {
    const result = evaluateAcceptance(grade("C", 2.0), policy("C"));
    expect(result.pass).toBe(true);
    expect(result.marginScore).toBeCloseTo(0, 10);
  });

  it("fails when grade is below requirement (D < C) with negative margin", () => {
    const result = evaluateAcceptance(grade("D", 1.2), policy("C"));
    expect(result.pass).toBe(false);
    // marginScore = 1.2 − 2 → −0.8
    expect(result.marginScore).toBeCloseTo(-0.8, 10);
    expect(result.marginScore).toBeLessThan(0);
  });

  it("fails GS1-128-style stricter requirement (C < B)", () => {
    const result = evaluateAcceptance(grade("C", 2.4), policy("B", "gs1"));
    expect(result.pass).toBe(false);
    expect(result.marginScore).toBeCloseTo(-0.6, 10);
  });

  it("echoes policyId and requiredGrade", () => {
    const result = evaluateAcceptance(grade("A", 3.9), policy("B", "cust-42"));
    expect(result.policyId).toBe("cust-42");
    expect(result.requiredGrade).toBe("B");
    expect(result.pass).toBe(true);
    expect(result.marginScore).toBeCloseTo(0.9, 10);
  });
});
