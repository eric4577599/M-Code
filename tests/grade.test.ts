import { describe, expect, it } from "vitest";
import {
  buildGradeResult,
  computeParameters,
  gradePhotometric,
  is1D,
  marginScore,
  reflectanceNormalize,
  type ProxyInputs,
} from "../src/engines/grade.js";

// A "perfect" proxy input set: every parameter maps to score 4 (letter A).
function perfect2D(): ProxyInputs {
  return {
    photometric: {
      rLight: 1,
      rDark: 0,
      rDarkMin: 0,
      edgeContrasts: [1, 1, 1],
    },
    geometric: {
      finderTimingDamageRatio: 0, // FPD = 1 → 4
      gridDeviation: 0, // GNU = 1 → 4
      usedEC: 0,
      totalEC: 10, // UEC = 1 → 4
    },
  };
}

function perfect1D(): ProxyInputs {
  return {
    photometric: {
      rLight: 1,
      rDark: 0,
      rDarkMin: 0,
      edgeContrasts: [1],
    },
    geometric: {
      maxWidthDeviation: 0,
      tolerance: 0.1, // DEC = 1 → 4
      maxElementReflectanceNonUniformity: 0, // DEF = 1 → 4
    },
  };
}

describe("reflectanceNormalize (C7.1)", () => {
  it("normalizes within the black/white span", () => {
    expect(reflectanceNormalize(50, 0, 100)).toBeCloseTo(0.5);
    expect(reflectanceNormalize(0, 0, 100)).toBe(0);
    expect(reflectanceNormalize(100, 0, 100)).toBe(1);
  });

  it("clamps below black and above white", () => {
    expect(reflectanceNormalize(-20, 0, 100)).toBe(0);
    expect(reflectanceNormalize(150, 0, 100)).toBe(1);
  });

  it("returns 0 for a degenerate (non-positive) span", () => {
    expect(reflectanceNormalize(50, 100, 100)).toBe(0);
    expect(reflectanceNormalize(50, 100, 0)).toBe(0);
  });
});

describe("band cuts via scoreToLetter (C7.3)", () => {
  // Cuts: A≥3.5, B≥2.5, C≥1.5, D≥0.5, F<0.5.
  it("places overall letters at the band boundaries", () => {
    const cases: Array<[number, string]> = [
      [4.0, "A"],
      [3.5, "A"],
      [3.49, "B"],
      [2.5, "B"],
      [2.49, "C"],
      [1.5, "C"],
      [1.49, "D"],
      [0.5, "D"],
      [0.49, "F"],
      [0, "F"],
    ];
    for (const [score, letter] of cases) {
      // Drive the boundary through a 2D min so overallScore == score exactly.
      const r = buildGradeResult("QR", {
        photometric: {
          rLight: 1,
          rDark: 0,
          rDarkMin: 0,
          edgeContrasts: [1],
        },
        geometric: { gridDeviation: 1 - score / 4 },
      });
      expect(r.overallScore).toBeCloseTo(score, 5);
      expect(r.overall).toBe(letter);
    }
  });
});

describe("photometric proxies (C7.2)", () => {
  it("computes SC, MOD, Rmin", () => {
    const params = gradePhotometric({
      rLight: 0.8,
      rDark: 0.2,
      rDarkMin: 0.1,
      edgeContrasts: [0.3, 0.6],
    });
    const sc = params.find((p) => p.code === "SC")!;
    const mod = params.find((p) => p.code === "MOD")!;
    const rmin = params.find((p) => p.code === "Rmin")!;
    // SC = 0.6 → 2.4
    expect(sc.score).toBeCloseTo(2.4);
    // MOD = min(0.3,0.6)/0.6 = 0.5 → 2.0
    expect(mod.score).toBeCloseTo(2.0);
    // Rmin = 1 - 0.1 = 0.9 → 3.6
    expect(rmin.score).toBeCloseTo(3.6);
    for (const p of params) expect(p.kind).toBe("PHOTOMETRIC");
  });

  it("guards degenerate SC for MOD", () => {
    const params = gradePhotometric({
      rLight: 0.5,
      rDark: 0.5,
      rDarkMin: 0.5,
      edgeContrasts: [0.4],
    });
    expect(params.find((p) => p.code === "MOD")!.score).toBe(0);
  });
});

describe("geometric proxies emit only supplied parameters (C7.2)", () => {
  it("1D yields DEC + DEF, no 2D params", () => {
    const codes = computeParameters(perfect1D()).map((p) => p.code);
    expect(codes).toContain("DEC");
    expect(codes).toContain("DEF");
    expect(codes).not.toContain("FPD");
    expect(codes).not.toContain("UEC");
  });

  it("2D yields FPD + GNU + UEC, no DEC", () => {
    const codes = computeParameters(perfect2D()).map((p) => p.code);
    expect(codes).toContain("FPD");
    expect(codes).toContain("GNU");
    expect(codes).toContain("UEC");
    expect(codes).not.toContain("DEC");
  });
});

describe("is1D", () => {
  it("classifies symbologies", () => {
    expect(is1D("ITF14")).toBe(true);
    expect(is1D("GS1_128")).toBe(true);
    expect(is1D("CODE128")).toBe(true);
    expect(is1D("QR")).toBe(false);
    expect(is1D("DATAMATRIX")).toBe(false);
  });
});

describe("buildGradeResult — 1D averaging (C7.3)", () => {
  it("averages per-scanline overall (min-per-scanline) scores", () => {
    // Scanline A: all params 4 → overall 4. Scanline B: GNU-less 1D with a
    // weak DEF dragging its min down.
    const strong = perfect1D();
    const weak: ProxyInputs = {
      photometric: {
        rLight: 1,
        rDark: 0,
        rDarkMin: 0,
        edgeContrasts: [1],
      },
      geometric: {
        maxWidthDeviation: 0,
        tolerance: 0.1, // DEC = 4
        maxElementReflectanceNonUniformity: 0.5, // DEF = 1 - 0.5/1 = 0.5 → 2.0
      },
    };
    const r = buildGradeResult("ITF14", [strong, weak]);
    // strong overall min = 4 ; weak overall min = 2 ; average = 3 → B
    expect(r.overallScore).toBeCloseTo(3.0);
    expect(r.overall).toBe("B");
    // reported params come from the first (strong) scanline
    expect(r.parameters.every((p) => p.score === 4)).toBe(true);
  });

  it("treats a single ProxyInputs as one scanline", () => {
    const r = buildGradeResult("ITF14", perfect1D());
    expect(r.overallScore).toBeCloseTo(4.0);
    expect(r.overall).toBe("A");
    expect(r.isRelative).toBe(true);
  });
});

describe("buildGradeResult — 2D min-takes-overall (C7.3)", () => {
  it("uses the lowest parameter score as overall", () => {
    const inp = perfect2D();
    // Drag one parameter down: grid deviation 0.5 → GNU 2.0.
    inp.geometric.gridDeviation = 0.5;
    const r = buildGradeResult("QR", inp);
    expect(r.overallScore).toBeCloseTo(2.0);
    expect(r.overall).toBe("C");
    expect(r.isRelative).toBe(true);
  });

  it("accepts an array and uses its first element for 2D", () => {
    const r = buildGradeResult("DATAMATRIX", [perfect2D()]);
    expect(r.overallScore).toBeCloseTo(4.0);
    expect(r.overall).toBe("A");
  });
});

describe("marginScore (C7.3)", () => {
  it("subtracts the required grade's nominal score", () => {
    // required C → nominal 2.
    expect(marginScore(1.8, "C")).toBeCloseTo(-0.2);
    expect(marginScore(2.3, "C")).toBeCloseTo(0.3);
    expect(marginScore(3.0, "B")).toBeCloseTo(0.0);
  });
});
