import { describe, it, expect } from "vitest";
import { CSV_COLUMNS, toCsvRow, toCsv } from "../src/export/csv.js";
import type { InspectionSession } from "../src/domain/types.js";

const EXPECTED_HEADER =
  "session_id,captured_at,plant,line,process_stage,work_order,customer," +
  "symbology,decoded_data,expected_match,overall_grade,overall_score," +
  "required_grade,pass,margin_score,x_dim_mm,bwr_gain_mm,quiet_zone_x," +
  "washboard_period_mm,washboard_amp_ratio,substrate_profile,diagnosis_ids";

function makeSession(over: Partial<InspectionSession> = {}): InspectionSession {
  return {
    id: "sess-1",
    createdAt: "2026-06-19T10:00:00Z",
    plantId: "P1",
    lineId: "L3",
    processStage: "INLINE",
    workOrderId: "WO-42",
    substrateProfileId: "prof-C",
    symbology: "ITF14",
    capture: { passedAll: true, gsdMmPerPx: 0.05, pxPerModule: 8, checks: [] },
    decode: {
      decoded: true,
      symbology: "ITF14",
      data: "10012345678902",
      expectedDataMatch: true,
    },
    measurement: {
      scaleRef: { type: "CARD", nominalMm: 85.6, resolvedPx: 1000 },
      xDimMm: 1.016,
      barWidthGainMm: 0.02,
      quietZoneX: 12,
      washboard: { detected: true, periodMm: 6.5, amplitudeRatio: 0.12 },
    },
    grade: {
      overall: "B",
      overallScore: 3,
      isRelative: true,
      parameters: [],
    },
    diagnosis: {
      matched: [
        { ruleId: "R1", cause: "c", remedy: "r", severity: 2 },
        { ruleId: "R7", cause: "c", remedy: "r", severity: 1 },
      ],
    },
    acceptance: {
      policyId: "pol-1",
      requiredGrade: "C",
      pass: true,
      marginScore: 1,
    },
    syncState: "LOCAL",
    ...over,
  };
}

describe("CSV_COLUMNS", () => {
  it("matches the exact §C9.4 order", () => {
    expect(CSV_COLUMNS.join(",")).toBe(EXPECTED_HEADER);
    expect(CSV_COLUMNS).toHaveLength(22);
  });
});

describe("toCsv", () => {
  it("yields header only for an empty list", () => {
    expect(toCsv([])).toBe(EXPECTED_HEADER);
  });

  it("emits header + one row per session", () => {
    const csv = toCsv([makeSession(), makeSession({ id: "sess-2" })]);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(EXPECTED_HEADER);
    expect(lines[1]?.startsWith("sess-1,")).toBe(true);
    expect(lines[2]?.startsWith("sess-2,")).toBe(true);
  });
});

describe("toCsvRow", () => {
  it("round-trips a full session to the expected column values", () => {
    const row = toCsvRow(makeSession(), { customer: "ACME" });
    expect(row).toBe(
      "sess-1,2026-06-19T10:00:00Z,P1,L3,INLINE,WO-42,ACME,ITF14," +
        "10012345678902,true,B,3,C,true,1,1.016,0.02,12,6.5,0.12,prof-C,R1;R7",
    );
  });

  it("joins diagnosis ruleIds with ';'", () => {
    const row = toCsvRow(makeSession());
    expect(row.split(",").pop()).toBe("R1;R7");
  });

  it("leaves missing optional values as empty fields", () => {
    const session = makeSession({
      plantId: undefined,
      lineId: undefined,
      workOrderId: undefined,
      measurement: undefined,
      decode: { decoded: false, symbology: "ITF14" },
      diagnosis: { matched: [] },
    });
    const cells = toCsvRow(session).split(",");
    // plant, line are empty; customer empty (no extra); decoded_data empty;
    // measurement-derived fields empty; diagnosis_ids empty.
    expect(cells[2]).toBe(""); // plant
    expect(cells[3]).toBe(""); // line
    expect(cells[5]).toBe(""); // work_order
    expect(cells[6]).toBe(""); // customer
    expect(cells[8]).toBe(""); // decoded_data
    expect(cells[9]).toBe(""); // expected_match
    expect(cells[15]).toBe(""); // x_dim_mm
    expect(cells[16]).toBe(""); // bwr_gain_mm
    expect(cells[17]).toBe(""); // quiet_zone_x
    expect(cells[18]).toBe(""); // washboard_period_mm
    expect(cells[19]).toBe(""); // washboard_amp_ratio
    expect(cells[21]).toBe(""); // diagnosis_ids
  });

  it("escapes fields containing comma, quote, or newline", () => {
    const row = toCsvRow(
      makeSession({ decode: { decoded: true, symbology: "ITF14", data: 'a,b"c\nd' } }),
      { customer: "Smith, Inc" },
    );
    expect(row).toContain('"a,b""c\nd"');
    expect(row).toContain('"Smith, Inc"');
  });

  it("清除浮點表示誤差,不改動合理數值", () => {
    // 模擬上游分數/量測算出的浮點雜訊(2.56 → 2.5599999999999 等)
    const row = toCsvRow(
      makeSession({
        grade: { overall: "B", overallScore: 2.5599999999999, isRelative: true, parameters: [] },
        acceptance: { policyId: "pol-1", requiredGrade: "C", pass: true, marginScore: 0.5599999999999992 },
        measurement: {
          scaleRef: { type: "CARD", nominalMm: 85.6, resolvedPx: 1000 },
          xDimMm: 1.016,
          barWidthGainMm: 0.030000000000000027,
          quietZoneX: 12,
          washboard: { detected: true, periodMm: 6.5, amplitudeRatio: 0.12 },
        },
      }),
    );
    const cells = row.split(",");
    expect(cells[11]).toBe("2.56"); // overall_score:雜訊收斂
    expect(cells[14]).toBe("0.56"); // margin_score:雜訊收斂
    expect(cells[16]).toBe("0.03"); // bwr_gain_mm:雜訊收斂
    expect(cells[15]).toBe("1.016"); // x_dim_mm:合理值原封不動
    expect(cells[18]).toBe("6.5"); // washboard_period_mm:原封不動
    expect(cells[19]).toBe("0.12"); // washboard_amp_ratio:原封不動
  });
});
