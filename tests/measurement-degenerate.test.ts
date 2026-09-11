// A-04 稽核補強測試(spec20260911-src-audit-v1 §3)。
// 守的是:measurement.ts 的退化守衛必須真的擋住 NaN / ±Infinity(原本只擋 <=0,
// 註解卻宣稱擋了 Infinity/NaN),以及 CSV 不得出現字面的 NaN / Infinity 儲存格。
import { describe, it, expect } from "vitest";
import type { ScaleReference, InspectionSession } from "../src/domain/types.js";
import {
  pxPerMm,
  gsd,
  xDimMm,
  barWidthGainMm,
  quietZoneX,
  moduleSizeMm,
  buildMeasurement,
} from "../src/engines/measurement.js";
import { toCsv, toCsvRow, CSV_COLUMNS } from "../src/export/csv.js";

/** 造一個 ScaleReference,方便逐欄替換成退化值。 */
const scale = (over: Partial<ScaleReference> = {}): ScaleReference => ({
  type: "CARD",
  nominalMm: 85.6,
  resolvedPx: 300,
  ...over,
});

describe("A-04 — pxPerMm / gsd 退化輸入防護", () => {
  it("AC-04-1:正常值與改動前逐位相同", () => {
    expect(pxPerMm(scale())).toBe(300 / 85.6);
    expect(gsd(scale())).toBe(85.6 / 300);
  });

  it("AC-04-1:resolvedPx / nominalMm 為 NaN 或 ±Infinity 時 pxPerMm 與 gsd 皆回 0", () => {
    const degenerate: Array<Partial<ScaleReference>> = [
      { resolvedPx: NaN },
      { nominalMm: NaN },
      { resolvedPx: Infinity },
      { nominalMm: Infinity },
      { resolvedPx: -Infinity },
      { nominalMm: -Infinity },
    ];
    for (const over of degenerate) {
      expect(pxPerMm(scale(over))).toBe(0);
      expect(gsd(scale(over))).toBe(0);
    }
  });

  it("AC-04-1:0 與負值仍回 0(既有行為不變)", () => {
    for (const over of [{ resolvedPx: 0 }, { resolvedPx: -5 }, { nominalMm: 0 }, { nominalMm: -1 }]) {
      expect(pxPerMm(scale(over))).toBe(0);
      expect(gsd(scale(over))).toBe(0);
    }
  });
});

describe("A-04 — xDimMm / moduleSizeMm / quietZoneX / barWidthGainMm", () => {
  it("AC-04-1:像素輸入為 NaN / ±Infinity 時 xDimMm 與 moduleSizeMm 回 0", () => {
    for (const px of [NaN, Infinity, -Infinity]) {
      expect(xDimMm(px, scale())).toBe(0);
      expect(moduleSizeMm(px, scale())).toBe(0);
    }
  });

  it("AC-04-1:正常值與改動前逐位相同", () => {
    expect(xDimMm(3, scale())).toBe(3 * (85.6 / 300));
    expect(moduleSizeMm(8, scale())).toBe(8 * (85.6 / 300));
    expect(quietZoneX(120, 10)).toBe(12);
    expect(barWidthGainMm(1.02, 1.0)).toBe(1.02 - 1.0);
  });

  it("AC-04-1:quietZoneX 任一輸入非有限值時回 0", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(quietZoneX(120, v)).toBe(0);
      expect(quietZoneX(v, 10)).toBe(0);
    }
    expect(quietZoneX(120, 0)).toBe(0);
  });

  it("AC-04-1:barWidthGainMm 任一輸入非有限值時回 0", () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(barWidthGainMm(v, 1.0)).toBe(0);
      expect(barWidthGainMm(1.0, v)).toBe(0);
    }
  });

  it("AC-04-2:重演稽核情境 —— resolvedPx = NaN 走完整條鏈,四個輸出皆為 0", () => {
    const bad = scale({ resolvedPx: NaN });
    const p = pxPerMm(bad);
    const g = gsd(bad);
    const x = xDimMm(3, bad);
    const q = quietZoneX(120, x);
    for (const v of [p, g, x, q]) {
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBe(0);
    }
    // 組裝出來的 Measurement 也不得外洩 NaN
    const m = buildMeasurement({
      scaleRef: bad,
      narrowestElementPx: NaN,
      quietZonePixels: Infinity,
      measuredBarWidthMm: NaN,
      nominalBarWidthMm: 1,
      modulePixels: Infinity,
    });
    expect(m.xDimMm).toBe(0);
    expect(m.quietZoneX).toBe(0);
    expect(m.barWidthGainMm).toBe(0);
    expect(m.moduleSizeMm).toBe(0);
  });
});

/** 造一個量測值可替換的 session,用來驗 CSV 的儲存格輸出。 */
function makeSession(over: Partial<InspectionSession> = {}): InspectionSession {
  return {
    id: "sess-nan",
    createdAt: "2026-09-11T10:00:00Z",
    plantId: "P1",
    lineId: "L3",
    processStage: "INLINE",
    workOrderId: "WO-42",
    substrateProfileId: "prof-C",
    symbology: "ITF14",
    capture: { passedAll: true, measurementEnabled: true, gsdMmPerPx: 0.05, pxPerModule: 8, checks: [] },
    decode: { decoded: true, symbology: "ITF14", data: "10012345678902", expectedDataMatch: true },
    measurement: {
      scaleRef: { type: "CARD", nominalMm: 85.6, resolvedPx: 300 },
      xDimMm: NaN,
      barWidthGainMm: Infinity,
      quietZoneX: -Infinity,
      washboard: { detected: true, periodMm: NaN, amplitudeRatio: 0.12 },
    },
    grade: { overall: "B", overallScore: 3, isRelative: true, parameters: [] },
    diagnosis: { matched: [] },
    acceptance: { policyId: "pol-1", requiredGrade: "C", pass: true, marginScore: 1 },
    syncState: "LOCAL",
    ...over,
  };
}

describe("A-04 — CSV 不得輸出字面的 NaN / Infinity", () => {
  it("AC-04-3:非有限量測值的儲存格為空字串,欄位數與逗號數不變", () => {
    const row = toCsvRow(makeSession(), { customer: "ACME" });
    const cells = row.split(",");
    expect(cells).toHaveLength(CSV_COLUMNS.length);
    expect(row).not.toContain("NaN");
    expect(row).not.toContain("Infinity");
    const idx = (name: string) => CSV_COLUMNS.indexOf(name);
    expect(cells[idx("x_dim_mm")]).toBe("");
    expect(cells[idx("bwr_gain_mm")]).toBe("");
    expect(cells[idx("quiet_zone_x")]).toBe("");
    expect(cells[idx("washboard_period_mm")]).toBe("");
    // 有限值不受影響
    expect(cells[idx("washboard_amp_ratio")]).toBe("0.12");
    expect(cells[idx("overall_score")]).toBe("3");
  });

  it("AC-04-3:整份 CSV 的逗號數逐列一致", () => {
    const csv = toCsv([makeSession()], [{ customer: "ACME" }]);
    const lines = csv.split("\n");
    const commas = (s: string) => s.split(",").length;
    expect(lines).toHaveLength(2);
    expect(commas(lines[1]!)).toBe(commas(lines[0]!));
  });
});
