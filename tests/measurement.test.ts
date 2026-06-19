import { describe, it, expect } from "vitest";
import type { ScaleReference } from "../src/domain/types.js";
import {
  pxPerMm,
  gsd,
  xDimMm,
  barWidthGainMm,
  quietZoneX,
  moduleSizeMm,
  washboard,
  buildMeasurement,
  WASHBOARD_AMP_RATIO_FLOOR,
} from "../src/engines/measurement.js";

// A reference card resolved to 200px over a 26.0mm nominal (D4 NT$10 ≈26mm),
// giving a clean pxPerMm = 200/26.
const card: ScaleReference = { type: "CARD", nominalMm: 26.0, resolvedPx: 200 };

describe("scale calibration (C6)", () => {
  it("pxPerMm = resolvedPx / nominalMm", () => {
    expect(pxPerMm(card)).toBeCloseTo(200 / 26.0, 10);
  });

  it("gsd is the inverse of pxPerMm and round-trips", () => {
    expect(gsd(card)).toBeCloseTo(26.0 / 200, 10);
    expect(pxPerMm(card) * gsd(card)).toBeCloseTo(1, 12);
  });

  it("gsd · pxPerMm round-trips a pixel length back to itself", () => {
    const px = 17;
    const mm = px * gsd(card);
    expect(mm * pxPerMm(card)).toBeCloseTo(px, 10);
  });
});

describe("xDimMm from pixels (C6)", () => {
  it("scales narrowest-element pixels by GSD", () => {
    // pxPerMm = 200/26 ≈ 7.692 px/mm; 8px → ~1.04mm (near ITF-14 100% X≈1.016)
    expect(xDimMm(8, card)).toBeCloseTo(8 * (26.0 / 200), 10);
  });
});

describe("barWidthGainMm sign (C6)", () => {
  it("positive when measured bar is wider than nominal (ink spread)", () => {
    expect(barWidthGainMm(1.10, 1.016)).toBeGreaterThan(0);
    expect(barWidthGainMm(1.10, 1.016)).toBeCloseTo(0.084, 10);
  });

  it("negative when measured bar is narrower than nominal", () => {
    expect(barWidthGainMm(0.98, 1.016)).toBeLessThan(0);
  });

  it("zero when measured equals nominal", () => {
    expect(barWidthGainMm(1.016, 1.016)).toBe(0);
  });
});

describe("quietZoneX ratio (C6)", () => {
  it("is quietZonePixels / xDimPixels", () => {
    // 80px quiet zone, 8px X → 10 X units (ITF-14 quietZoneMinX ≈10)
    expect(quietZoneX(80, 8)).toBeCloseTo(10, 10);
  });

  it("guards a non-positive X width", () => {
    expect(quietZoneX(80, 0)).toBe(0);
    expect(quietZoneX(80, -5)).toBe(0);
  });
});

describe("moduleSizeMm for 2D (C6)", () => {
  it("scales module pixels by GSD", () => {
    expect(moduleSizeMm(10, card)).toBeCloseTo(10 * (26.0 / 200), 10);
  });
});

describe("washboard detection (C4.2 / C6 / D3)", () => {
  it("floor matches the gate WARN onset of 0.08", () => {
    expect(WASHBOARD_AMP_RATIO_FLOOR).toBe(0.08);
  });

  it("detected when amplitudeRatio is above the floor", () => {
    // C-flute pitch ≈7.4mm (D3); ratio 0.13 is in the WARN band.
    const w = washboard(7.4, 0.13, 7.4);
    expect(w.detected).toBe(true);
    expect(w.periodMm).toBe(7.4);
    expect(w.amplitudeRatio).toBe(0.13);
  });

  it("not detected at or below the floor", () => {
    expect(washboard(7.4, 0.08).detected).toBe(false);
    expect(washboard(7.4, 0.05).detected).toBe(false);
  });

  it("detection is amplitude-driven, independent of expected flute pitch", () => {
    expect(washboard(3.2, 0.2, 7.4).detected).toBe(true);
  });
});

describe("buildMeasurement assembly (C3 / C6)", () => {
  it("always emits xDimMm and quietZoneX; omits optional fields without inputs", () => {
    const m = buildMeasurement({
      scaleRef: card,
      narrowestElementPx: 8,
      quietZonePixels: 80,
    });
    expect(m.scaleRef).toBe(card);
    expect(m.xDimMm).toBeCloseTo(8 * (26.0 / 200), 10);
    expect(m.quietZoneX).toBeCloseTo(10, 10);
    expect(m.barWidthGainMm).toBeUndefined();
    expect(m.moduleSizeMm).toBeUndefined();
    expect(m.washboard).toBeUndefined();
  });

  it("emits barWidthGainMm only when both 1D inputs are present", () => {
    const m = buildMeasurement({
      scaleRef: card,
      narrowestElementPx: 8,
      quietZonePixels: 80,
      measuredBarWidthMm: 1.10,
      nominalBarWidthMm: 1.016,
    });
    expect(m.barWidthGainMm).toBeCloseTo(0.084, 10);

    const partial = buildMeasurement({
      scaleRef: card,
      narrowestElementPx: 8,
      quietZonePixels: 80,
      measuredBarWidthMm: 1.10,
    });
    expect(partial.barWidthGainMm).toBeUndefined();
  });

  it("emits moduleSizeMm for a 2D symbol", () => {
    const m = buildMeasurement({
      scaleRef: card,
      narrowestElementPx: 10,
      quietZonePixels: 40,
      modulePixels: 10,
    });
    expect(m.moduleSizeMm).toBeCloseTo(10 * (26.0 / 200), 10);
  });

  it("emits washboard only when both FFT inputs are present", () => {
    const m = buildMeasurement({
      scaleRef: card,
      narrowestElementPx: 8,
      quietZonePixels: 80,
      washboardPeriodMm: 7.4,
      washboardAmplitudeRatio: 0.13,
      expectedFlutePitchMm: 7.4,
    });
    expect(m.washboard).toEqual({
      detected: true,
      periodMm: 7.4,
      amplitudeRatio: 0.13,
    });

    const partial = buildMeasurement({
      scaleRef: card,
      narrowestElementPx: 8,
      quietZonePixels: 80,
      washboardPeriodMm: 7.4,
    });
    expect(partial.washboard).toBeUndefined();
  });
});
