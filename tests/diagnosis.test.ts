import { describe, expect, it } from "vitest";
import {
  evaluateDiagnosis,
  type DiagnosisContext,
} from "../src/engines/diagnosis.js";
import type { DiagnosisRule } from "../src/domain/types.js";

// Small inline fixtures — the real seed set lives in src/data/rules.ts.

const bwrGain: DiagnosisRule = {
  id: "BWR_GAIN",
  appliesTo: ["ITF14", "GS1_128", "CODE128"],
  when: [
    { metric: "MOD.score", op: "<", value: 2.5 },
    { metric: "barWidthGainMm", op: ">", value: 0.04 },
  ],
  cause: "ink too heavy",
  remedy: "increase BWR",
  severity: 3,
};

const washboard: DiagnosisRule = {
  id: "WASHBOARD",
  appliesTo: ["ITF14", "QR"],
  substrateCategories: ["DIRECT_COARSE"],
  when: [{ metric: "washboard.amplitudeRatio", op: ">", value: 0.12 }],
  cause: "washboard",
  remedy: "use finer flute",
  severity: 2,
};

const quietZone: DiagnosisRule = {
  id: "QUIET_ZONE",
  appliesTo: ["ITF14"],
  when: [{ metric: "quietZoneX", op: "<", value: 10 }],
  cause: "quiet zone too small",
  remedy: "widen layout",
  severity: 1,
};

const noDecode: DiagnosisRule = {
  id: "NO_DECODE",
  appliesTo: ["ITF14", "QR"],
  when: [{ metric: "decoded", op: "==", value: 0 }],
  cause: "unreadable",
  remedy: "stop line",
  severity: 3,
};

function ctx(partial: Partial<DiagnosisContext>): DiagnosisContext {
  return {
    symbology: "ITF14",
    metrics: {},
    ...partial,
  };
}

describe("evaluateDiagnosis", () => {
  it("filters by symbology — rule that doesn't apply is skipped", () => {
    const res = evaluateDiagnosis(
      [bwrGain],
      ctx({
        symbology: "QR", // BWR_GAIN does not list QR
        metrics: { "MOD.score": 1.0, barWidthGainMm: 0.1 },
      }),
    );
    expect(res.matched).toEqual([]);
  });

  it("filters by substrate category", () => {
    const metrics = { "washboard.amplitudeRatio": 0.2 };
    const noMatch = evaluateDiagnosis(
      [washboard],
      ctx({ symbology: "ITF14", substrateCategory: "DIRECT_FINE", metrics }),
    );
    expect(noMatch.matched).toEqual([]);

    const match = evaluateDiagnosis(
      [washboard],
      ctx({ symbology: "ITF14", substrateCategory: "DIRECT_COARSE", metrics }),
    );
    expect(match.matched.map((h) => h.ruleId)).toEqual(["WASHBOARD"]);
  });

  it("skips a substrate rule when the context has no category at all", () => {
    const res = evaluateDiagnosis(
      [washboard],
      ctx({ symbology: "ITF14", metrics: { "washboard.amplitudeRatio": 0.5 } }),
    );
    expect(res.matched).toEqual([]);
  });

  it("requires ALL conditions (AND) to match", () => {
    // Only the first condition holds → no match.
    const partial = evaluateDiagnosis(
      [bwrGain],
      ctx({ metrics: { "MOD.score": 1.0, barWidthGainMm: 0.01 } }),
    );
    expect(partial.matched).toEqual([]);

    const full = evaluateDiagnosis(
      [bwrGain],
      ctx({ metrics: { "MOD.score": 1.0, barWidthGainMm: 0.1 } }),
    );
    expect(full.matched.map((h) => h.ruleId)).toEqual(["BWR_GAIN"]);
  });

  it("evaluates each operator correctly", () => {
    const rule = (op: DiagnosisRule["when"][number]["op"]): DiagnosisRule => ({
      id: `OP_${op}`,
      appliesTo: ["ITF14"],
      when: [{ metric: "m", op, value: 5 }],
      cause: "c",
      remedy: "r",
      severity: 1,
    });

    const check = (op: DiagnosisRule["when"][number]["op"], m: number) =>
      evaluateDiagnosis([rule(op)], ctx({ metrics: { m } })).matched.length ===
      1;

    expect(check("<", 4)).toBe(true);
    expect(check("<", 5)).toBe(false);
    expect(check(">", 6)).toBe(true);
    expect(check(">", 5)).toBe(false);
    expect(check("<=", 5)).toBe(true);
    expect(check("<=", 6)).toBe(false);
    expect(check(">=", 5)).toBe(true);
    expect(check(">=", 4)).toBe(false);
    expect(check("==", 5)).toBe(true);
    expect(check("==", 5.0001)).toBe(false);
  });

  it("a condition whose metric is absent does NOT match", () => {
    const res = evaluateDiagnosis(
      [quietZone],
      ctx({ metrics: {} }), // quietZoneX absent
    );
    expect(res.matched).toEqual([]);
  });

  it("sorts matched hits by severity descending", () => {
    const res = evaluateDiagnosis(
      [quietZone, bwrGain, washboard],
      ctx({
        symbology: "ITF14",
        substrateCategory: "DIRECT_COARSE",
        metrics: {
          quietZoneX: 8, // sev 1
          "MOD.score": 1.0, // }
          barWidthGainMm: 0.1, // } sev 3
          "washboard.amplitudeRatio": 0.2, // sev 2
        },
      }),
    );
    expect(res.matched.map((h) => h.severity)).toEqual([3, 2, 1]);
    expect(res.matched.map((h) => h.ruleId)).toEqual([
      "BWR_GAIN",
      "WASHBOARD",
      "QUIET_ZONE",
    ]);
  });

  it("handles the NO_DECODE decoded==0 case", () => {
    const res = evaluateDiagnosis(
      [noDecode],
      ctx({ symbology: "QR", metrics: { decoded: 0 } }),
    );
    expect(res.matched.map((h) => h.ruleId)).toEqual(["NO_DECODE"]);
    expect(res.matched[0]?.severity).toBe(3);

    // decoded == 1 → no hit.
    const ok = evaluateDiagnosis(
      [noDecode],
      ctx({ symbology: "QR", metrics: { decoded: 1 } }),
    );
    expect(ok.matched).toEqual([]);
  });

  it("emits cause and remedy from the rule", () => {
    const res = evaluateDiagnosis(
      [noDecode],
      ctx({ metrics: { decoded: 0 } }),
    );
    expect(res.matched[0]).toMatchObject({
      ruleId: "NO_DECODE",
      cause: "unreadable",
      remedy: "stop line",
      severity: 3,
    });
  });
});
