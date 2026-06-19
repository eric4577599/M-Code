// End-to-end integration: drive a synthetic inspection through the whole
// edge pipeline (C1): gate → decode → measurement → grade → diagnosis →
// acceptance → CSV. Proves the independently-built engines compose into a
// coherent InspectionSession. All inputs are synthetic numbers (no real I/O).
import { describe, it, expect } from "vitest";

import { evaluateGate, type GateMeasurements } from "../src/engines/gate.js";
import { runDecode, type Decoder } from "../src/engines/decode.js";
import { buildMeasurement } from "../src/engines/measurement.js";
import { buildGradeResult, type ScanlineInputs } from "../src/engines/grade.js";
import { evaluateDiagnosis, type DiagnosisContext } from "../src/engines/diagnosis.js";
import { evaluateAcceptance } from "../src/engines/acceptance.js";
import { toCsvRow, toCsv, CSV_COLUMNS } from "../src/export/csv.js";
import { SEED_DIAGNOSIS_RULES } from "../src/data/rules.js";
import { SEED_ACCEPTANCE_POLICIES } from "../src/data/policies.js";
import { SEED_SUBSTRATE_PROFILES } from "../src/data/profiles.js";
import { isAtLeast } from "../src/domain/scale.js";
import type {
  InspectionSession,
  ScaleReference,
  GradeResult,
} from "../src/domain/types.js";

// A direct-print C-flute job (the most common, washboard-prone substrate).
const profile = SEED_SUBSTRATE_PROFILES.find((p) => p.id === "direct-c-flute")!;
const policy = SEED_ACCEPTANCE_POLICIES.find((p) => p.id === "itf14-direct-default")!;
const EXPECTED_GTIN = "104712345678904";

const scale: ScaleReference = { type: "CARD", nominalMm: 26, resolvedPx: 260 }; // 10 px/mm

// Proxy inputs crafted to land around a relative C grade with a Defects weak spot.
function scanline(): ScanlineInputs[number] {
  return {
    photometric: { rLight: 0.8, rDark: 0.2, rDarkMin: 0.2, edgeContrasts: [0.55, 0.6, 0.58] },
    geometric: {
      maxWidthDeviation: 0.4,
      tolerance: 1,
      maxElementReflectanceNonUniformity: 0.3, // drives DEF down → diagnosis hit
    },
  };
}

function gradeToMetrics(grade: GradeResult, barWidthGainMm: number, quietZoneX: number, decoded: boolean): Record<string, number> {
  const m: Record<string, number> = { barWidthGainMm, quietZoneX, decoded: decoded ? 1 : 0 };
  for (const p of grade.parameters) m[`${p.code}.score`] = p.score;
  return m;
}

describe("full inspection pipeline (C1)", () => {
  it("an armed, decodable, C-grade ITF-14 capture flows end to end", () => {
    // 1. Gate — all six checks within OK bounds → ARMED.
    const measurements: GateMeasurements = {
      symbolDetected: true,
      varLap: 200, // ≥120 OK
      glareRatio: 0.005, // 0.5% ≤1% OK (fraction)
      washboardAmpRatio: 0.06, // ≤0.08 OK
      wbGainDeviation: 0.03, // 3% ≤5% OK (fraction)
      scaleRefDetected: true,
      picketAngleDeg: 4, // ≤10 OK
      perspectiveTiltDeg: 3, // ≤5 OK
      gsdMmPerPx: 0.12, // ≤0.20
      pxPerModule: 9, // ≥8 OK
    };
    const gate = evaluateGate(measurements);
    expect(gate.state).toBe("ARMED");
    expect(gate.report.passedAll).toBe(true);

    // 2. Decode — injected adapter returns the expected GTIN.
    const decoder: Decoder = {
      decode: () => ({ symbology: "ITF14", data: EXPECTED_GTIN, dimension: undefined }),
    };
    const decode = runDecode(decoder, { declaredSymbology: "ITF14", handle: {} }, { expectedGtin: EXPECTED_GTIN });
    expect(decode.decoded).toBe(true);
    expect(decode.expectedDataMatch).toBe(true);

    // 3. Measurement — pixel-space inputs against the scale card.
    const measurement = buildMeasurement({
      scaleRef: scale,
      narrowestElementPx: 11, // ~1.1mm X at 10px/mm
      quietZonePixels: 110,
      measuredBarWidthMm: 1.1,
      nominalBarWidthMm: 1.016,
      washboardPeriodMm: 7.4, // matches C flute pitch (D3)
      washboardAmplitudeRatio: 0.06,
      expectedFlutePitchMm: profile.expectedFlutePitchMm,
    });
    expect(measurement.xDimMm).toBeGreaterThan(0);
    expect(measurement.barWidthGainMm).toBeCloseTo(0.084, 3);

    // 4. Grade — N scanlines averaged (1D). isRelative must stay true (legal guardrail).
    const grade = buildGradeResult("ITF14", Array.from({ length: 10 }, scanline));
    expect(grade.isRelative).toBe(true);
    expect(["A", "B", "C", "D", "F"]).toContain(grade.overall);
    expect(grade.overall).toBe("C");

    // 5. Diagnosis — weak Defects param should surface the DEFECTS rule.
    const ctx: DiagnosisContext = {
      symbology: "ITF14",
      substrateCategory: profile.category,
      metrics: gradeToMetrics(grade, measurement.barWidthGainMm!, measurement.quietZoneX, decode.decoded),
    };
    const diagnosis = evaluateDiagnosis(SEED_DIAGNOSIS_RULES, ctx);
    expect(diagnosis.matched.some((h) => h.ruleId === "DEFECTS")).toBe(true);
    // severity-descending invariant
    for (let i = 1; i < diagnosis.matched.length; i++) {
      expect(diagnosis.matched[i - 1]!.severity).toBeGreaterThanOrEqual(diagnosis.matched[i]!.severity);
    }

    // 6. Acceptance — C policy, C grade ⇒ pass with non-negative margin.
    const acceptance = evaluateAcceptance(grade, policy);
    expect(acceptance.pass).toBe(isAtLeast(grade.overall, policy.requiredGrade));
    expect(acceptance.pass).toBe(true);
    expect(acceptance.marginScore).toBeGreaterThanOrEqual(0);

    // 7. Assemble the session and export a CSV row.
    const session: InspectionSession = {
      id: "sess-int-001",
      createdAt: "2026-06-19T08:12:00+08:00",
      plantId: "P1",
      lineId: "L3",
      processStage: "OUTBOUND",
      workOrderId: "WO-2406A-7741",
      substrateProfileId: profile.id,
      symbology: "ITF14",
      capture: gate.report,
      decode,
      measurement,
      grade,
      diagnosis,
      acceptance,
      syncState: "LOCAL",
    };

    const csv = toCsv([session], [{ customer: "ACME" }]);
    const [header, row] = csv.split("\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
    // overall_grade column carries the C grade.
    const cols = row!.split(",");
    expect(cols[CSV_COLUMNS.indexOf("overall_grade")]).toBe("C");
    expect(cols[CSV_COLUMNS.indexOf("pass")]).toBe("true");
    expect(cols[CSV_COLUMNS.indexOf("customer")]).toBe("ACME");
    expect(cols[CSV_COLUMNS.indexOf("diagnosis_ids")]).toContain("DEFECTS");
    expect(toCsvRow(session, { customer: "ACME" })).toBe(row);
  });

  it("a no-decode capture still produces a NO_DECODE diagnosis", () => {
    const decoder: Decoder = { decode: () => null };
    const decode = runDecode(decoder, { declaredSymbology: "ITF14", handle: {} });
    expect(decode.decoded).toBe(false);

    const diagnosis = evaluateDiagnosis(SEED_DIAGNOSIS_RULES, {
      symbology: "ITF14",
      substrateCategory: profile.category,
      metrics: { decoded: 0 },
    });
    expect(diagnosis.matched.some((h) => h.ruleId === "NO_DECODE")).toBe(true);
  });
});
