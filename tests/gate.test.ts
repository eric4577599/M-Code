import { describe, it, expect } from "vitest";
import {
  classifyChecks,
  evaluateGate,
  gateState,
  type GateMeasurements,
} from "../src/engines/gate.js";
import type { GateCheck, GateStatus } from "../src/domain/types.js";

// All-passing baseline; tweak one field per test to exercise a boundary.
const PASS: GateMeasurements = {
  symbolDetected: true,
  varLap: 120,
  glareRatio: 0.01,
  washboardAmpRatio: 0.08,
  wbGainDeviation: 0.05,
  scaleRefDetected: true,
  picketAngleDeg: 10,
  perspectiveTiltDeg: 5,
  gsdMmPerPx: 0.2,
  pxPerModule: 8,
};

function statusOf(checks: GateCheck[], key: string): GateStatus {
  const c = checks.find((x) => x.key === key);
  if (!c) throw new Error(`no check ${key}`);
  return c.status;
}

function focusStatus(m: Partial<GateMeasurements>): GateStatus {
  return statusOf(classifyChecks({ ...PASS, ...m }), "focus");
}

describe("focus (>=120 OK else FAIL)", () => {
  it("OK at boundary 120", () => expect(focusStatus({ varLap: 120 })).toBe("OK"));
  it("FAIL just below", () => expect(focusStatus({ varLap: 119.9 })).toBe("FAIL"));
});

describe("glare (<=1% OK, 1-4% WARN, >4% FAIL)", () => {
  const g = (v: number) => statusOf(classifyChecks({ ...PASS, glareRatio: v }), "glare");
  it("OK at 1%", () => expect(g(0.01)).toBe("OK"));
  it("WARN just above 1%", () => expect(g(0.0101)).toBe("WARN"));
  it("WARN at 4%", () => expect(g(0.04)).toBe("WARN"));
  it("FAIL just above 4%", () => expect(g(0.0401)).toBe("FAIL"));
});

describe("washboard (<=0.08 OK, 0.08-0.15 WARN, >0.15 FAIL)", () => {
  const w = (v: number) =>
    statusOf(classifyChecks({ ...PASS, washboardAmpRatio: v }), "washboard");
  it("OK at 0.08", () => expect(w(0.08)).toBe("OK"));
  it("WARN just above 0.08", () => expect(w(0.0801)).toBe("WARN"));
  it("WARN at 0.15", () => expect(w(0.15)).toBe("WARN"));
  it("FAIL just above 0.15", () => expect(w(0.1501)).toBe("FAIL"));
});

describe("washboard fluteType-aware (NONE substrate never FAILs/WARNs)", () => {
  const w = (v: number, fluteType?: GateMeasurements["fluteType"]) =>
    statusOf(classifyChecks({ ...PASS, washboardAmpRatio: v, fluteType }), "washboard");
  it("NONE substrate: value that would normally FAIL (0.5) → OK", () =>
    expect(w(0.5, "NONE")).toBe("OK"));
  it("NONE substrate: value that would normally WARN (0.1) → OK", () =>
    expect(w(0.1, "NONE")).toBe("OK"));
  it("flute C substrate: same 0.5 value → still FAIL (other substrates not relaxed)", () =>
    expect(w(0.5, "C")).toBe("FAIL"));
  it("fluteType undefined (legacy caller): unchanged, applies fixed thresholds", () =>
    expect(w(0.5, undefined)).toBe("FAIL"));
});

describe("whiteBalance (advisory: <=5% OK else WARN, never FAIL/locks)", () => {
  const wb = (v: number) =>
    statusOf(classifyChecks({ ...PASS, wbGainDeviation: v }), "whiteBalance");
  it("OK at 5%", () => expect(wb(0.05)).toBe("OK"));
  it("WARN (not FAIL) just above 5%", () => expect(wb(0.0501)).toBe("WARN"));
  it("even a large deviation stays WARN, never FAIL", () => expect(wb(0.9)).toBe("WARN"));
});

// 實際使用者場景:有色光源下白平衡偏差超標,不該鎖死快門
// (條碼可讀性看色差對比,由解碼/分級把關,非白平衡)。
describe("whiteBalance does not lock the shutter (C4.2 advisory)", () => {
  it("large wb deviation alone stays ARMED and passedAll true", () => {
    const { state, report } = evaluateGate({ ...PASS, wbGainDeviation: 0.9 });
    expect(state).toBe("ARMED");
    expect(report.passedAll).toBe(true);
  });
});

describe("scaleRef (detected OK else FAIL)", () => {
  const sr = (v: boolean) =>
    statusOf(classifyChecks({ ...PASS, scaleRefDetected: v }), "scaleRef");
  it("OK when detected", () => expect(sr(true)).toBe("OK"));
  it("FAIL when not detected", () => expect(sr(false)).toBe("FAIL"));
});

describe("picket (<=10 OK, 10-25 WARN, >25 FAIL — D2 必須 picket fence)", () => {
  const p = (v: number) =>
    statusOf(classifyChecks({ ...PASS, picketAngleDeg: v }), "picket");
  it("OK at 10", () => expect(p(10)).toBe("OK"));
  it("WARN just above 10", () => expect(p(10.1)).toBe("WARN"));
  it("WARN at 25", () => expect(p(25)).toBe("WARN"));
  it("FAIL just above 25", () => expect(p(25.1)).toBe("FAIL"));
  it("FAIL when the barcode lies sideways (90° ladder)", () => expect(p(90)).toBe("FAIL"));
});

describe("perspective (<=5 OK else FAIL)", () => {
  const pe = (v: number) =>
    statusOf(classifyChecks({ ...PASS, perspectiveTiltDeg: v }), "perspective");
  it("OK at 5", () => expect(pe(5)).toBe("OK"));
  it("FAIL just above 5", () => expect(pe(5.1)).toBe("FAIL"));
});

describe("resolution (gsd<=0.20 & pxPerModule>=8 OK, <8 WARN, <5 FAIL)", () => {
  const r = (gsd: number, px: number) =>
    statusOf(classifyChecks({ ...PASS, gsdMmPerPx: gsd, pxPerModule: px }), "resolution");
  it("OK at gsd 0.20 & px 8", () => expect(r(0.2, 8)).toBe("OK"));
  it("WARN when gsd too coarse", () => expect(r(0.21, 8)).toBe("WARN"));
  it("WARN at px 7 (>=5, <8)", () => expect(r(0.2, 7)).toBe("WARN"));
  it("WARN at px 5 boundary", () => expect(r(0.2, 5)).toBe("WARN"));
  it("FAIL just below 5", () => expect(r(0.2, 4.9)).toBe("FAIL"));
});

describe("gate state (C4.1)", () => {
  it("SCANNING when no symbol ROI", () => {
    const { state, report } = evaluateGate({ ...PASS, symbolDetected: false });
    expect(state).toBe("SCANNING");
    expect(report.passedAll).toBe(false);
  });

  it("ARMED when all OK/WARN", () => {
    const { state, report } = evaluateGate(PASS);
    expect(state).toBe("ARMED");
    expect(report.passedAll).toBe(true);
  });

  it("ARMED tolerates WARN-only checks", () => {
    const { state } = evaluateGate({ ...PASS, glareRatio: 0.02, picketAngleDeg: 20 });
    expect(state).toBe("ARMED");
  });

  it("LOCKED on any single FAIL", () => {
    const { state, report } = evaluateGate({ ...PASS, varLap: 50 });
    expect(state).toBe("LOCKED");
    expect(report.passedAll).toBe(false);
  });

  it("gateState helper: LOCKED requires symbol detected", () => {
    const failing = classifyChecks({ ...PASS, varLap: 0 });
    expect(gateState(false, failing)).toBe("SCANNING");
    expect(gateState(true, failing)).toBe("LOCKED");
  });

  // C4.2:scaleRef 未偵測 → 量測停用、仍可解碼,不鎖快門
  it("scaleRef missing alone does NOT lock (C4.2: measurement off, decode allowed)", () => {
    const { state, report } = evaluateGate({ ...PASS, scaleRefDetected: false });
    expect(state).toBe("ARMED");
    expect(report.measurementEnabled).toBe(false);
    expect(report.passedAll).toBe(false); // 仍有一項 FAIL,不算全過
  });

  it("scaleRef missing plus another FAIL still locks", () => {
    const { state } = evaluateGate({ ...PASS, scaleRefDetected: false, varLap: 50 });
    expect(state).toBe("LOCKED");
  });

  it("measurementEnabled is true when scaleRef is detected", () => {
    const { report } = evaluateGate(PASS);
    expect(report.measurementEnabled).toBe(true);
    expect(report.passedAll).toBe(true);
  });

  // 實際使用者場景:標籤材質(無瓦楞)不該被楞痕透印誤判鎖死快門
  it("NONE substrate with a high washboard reading stays ARMED, not LOCKED", () => {
    const { state } = evaluateGate({ ...PASS, fluteType: "NONE", washboardAmpRatio: 0.9 });
    expect(state).toBe("ARMED");
  });
});

describe("report shape", () => {
  it("carries gsd, pxPerModule and all eight checks", () => {
    const { report } = evaluateGate(PASS);
    expect(report.gsdMmPerPx).toBe(0.2);
    expect(report.pxPerModule).toBe(8);
    expect(report.checks.map((c) => c.key)).toEqual([
      "focus",
      "glare",
      "washboard",
      "whiteBalance",
      "scaleRef",
      "picket",
      "perspective",
      "resolution",
    ]);
    for (const c of report.checks) expect(typeof c.threshold).toBe("string");
  });
});
