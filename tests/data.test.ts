import { describe, it, expect } from "vitest";
import { SEED_DIAGNOSIS_RULES } from "../src/data/rules.js";
import {
  FLUTE_PITCH_MM,
  expectedFlutePitchMm,
} from "../src/data/flutes.js";
import { SEED_SUBSTRATE_PROFILES } from "../src/data/profiles.js";
import { SEED_ACCEPTANCE_POLICIES } from "../src/data/policies.js";
import type {
  DiagnosisRule,
  SubstrateCategory,
} from "../src/domain/types.js";

describe("SEED_DIAGNOSIS_RULES (§C8)", () => {
  const byId = new Map(SEED_DIAGNOSIS_RULES.map((r) => [r.id, r]));

  const expected: Record<string, DiagnosisRule["severity"]> = {
    BWR_GAIN: 3,
    WASHBOARD: 2,
    LOW_CONTRAST: 2,
    QR_REGISTRATION: 2,
    DEFECTS: 2,
    QUIET_ZONE: 1,
    NO_DECODE: 3,
  };

  it("contains exactly the 7 seed rule ids", () => {
    expect(SEED_DIAGNOSIS_RULES).toHaveLength(7);
    expect([...byId.keys()].sort()).toEqual(Object.keys(expected).sort());
  });

  it("each rule has the correct severity", () => {
    for (const [id, sev] of Object.entries(expected)) {
      expect(byId.get(id)?.severity).toBe(sev);
    }
  });

  it("WASHBOARD is scoped to DIRECT_COARSE with amplitudeRatio > 0.12", () => {
    const r = byId.get("WASHBOARD");
    expect(r?.substrateCategories).toEqual(["DIRECT_COARSE"]);
    expect(r?.when).toContainEqual({
      metric: "washboard.amplitudeRatio",
      op: ">",
      value: 0.12,
    });
  });

  it("BWR_GAIN requires both MOD.score < 2.5 AND barWidthGainMm > 0.04", () => {
    const r = byId.get("BWR_GAIN");
    expect(r?.appliesTo).toEqual(["ITF14", "GS1_128", "CODE128"]);
    expect(r?.when).toEqual([
      { metric: "MOD.score", op: "<", value: 2.5 },
      { metric: "barWidthGainMm", op: ">", value: 0.04 },
    ]);
  });

  it("NO_DECODE keys off decoded == 0", () => {
    expect(byId.get("NO_DECODE")?.when).toEqual([
      { metric: "decoded", op: "==", value: 0 },
    ]);
  });
});

describe("FLUTE_PITCH_MM / expectedFlutePitchMm (§D3)", () => {
  it("matches the D3 nominal pitch table", () => {
    expect(FLUTE_PITCH_MM.A).toBe(9.2);
    expect(FLUTE_PITCH_MM.C).toBe(7.4);
    expect(FLUTE_PITCH_MM.B).toBe(6.5);
    expect(FLUTE_PITCH_MM.E).toBe(3.2);
    expect(FLUTE_PITCH_MM.F).toBe(2.4);
    expect(FLUTE_PITCH_MM.NONE).toBeUndefined();
  });

  it("helper returns pitch for flutes and undefined for NONE", () => {
    expect(expectedFlutePitchMm("A")).toBe(9.2);
    expect(expectedFlutePitchMm("F")).toBe(2.4);
    expect(expectedFlutePitchMm("NONE")).toBeUndefined();
  });
});

describe("SEED_SUBSTRATE_PROFILES (§C3.2)", () => {
  it("covers all four substrate categories", () => {
    const cats = new Set(SEED_SUBSTRATE_PROFILES.map((p) => p.category));
    const all: SubstrateCategory[] = [
      "DIRECT_COARSE",
      "DIRECT_FINE",
      "LITHO_LAM",
      "LABEL",
    ];
    for (const c of all) expect(cats.has(c)).toBe(true);
  });

  it("has unique ids and a positive alertScore each", () => {
    const ids = SEED_SUBSTRATE_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SEED_SUBSTRATE_PROFILES) {
      expect(p.thresholds.alertScore).toBeGreaterThan(0);
    }
  });

  it("wires expectedFlutePitchMm from the flute table", () => {
    const c = SEED_SUBSTRATE_PROFILES.find((p) => p.id === "direct-c-flute");
    expect(c?.fluteType).toBe("C");
    expect(c?.expectedFlutePitchMm).toBe(expectedFlutePitchMm("C"));

    const lam = SEED_SUBSTRATE_PROFILES.find((p) => p.category === "LITHO_LAM");
    expect(lam?.expectedFlutePitchMm).toBeUndefined();
  });
});

describe("SEED_ACCEPTANCE_POLICIES (§D2)", () => {
  it("ITF-14 policy: requiredGrade C, xDimSpecMm 1.016, quietZoneMinX 10", () => {
    const itf = SEED_ACCEPTANCE_POLICIES.find((p) => p.symbology === "ITF14");
    expect(itf).toBeDefined();
    expect(itf?.requiredGrade).toBe("C");
    expect(itf?.xDimSpecMm).toBe(1.016);
    expect(itf?.quietZoneMinX).toBe(10);
  });

  it("GS1-128 policy requires grade B", () => {
    const gs1 = SEED_ACCEPTANCE_POLICIES.find((p) => p.symbology === "GS1_128");
    expect(gs1?.requiredGrade).toBe("B");
  });
});
