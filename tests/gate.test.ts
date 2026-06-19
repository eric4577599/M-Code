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

describe("whiteBalance (<=5% OK else FAIL)", () => {
  const wb = (v: number) =>
    statusOf(classifyChecks({ ...PASS, wbGainDeviation: v }), "whiteBalance");
  it("OK at 5%", () => expect(wb(0.05)).toBe("OK"));
  it("FAIL just above 5%", () => expect(wb(0.0501)).toBe("FAIL"));
});

describe("scaleRef (detected OK else FAIL)", () => {
  const sr = (v: boolean) =>
    statusOf(classifyChecks({ ...PASS, scaleRefDetected: v }), "scaleRef");
  it("OK when detected", () => expect(sr(true)).toBe("OK"));
  it("FAIL when not detected", () => expect(sr(false)).toBe("FAIL"));
});

describe("picket (<=10 OK, 10-25 WARN)", () => {
  const p = (v: number) =>
    statusOf(classifyChecks({ ...PASS, picketAngleDeg: v }), "picket");
  it("OK at 10", () => expect(p(10)).toBe("OK"));
  it("WARN just above 10", () => expect(p(10.1)).toBe("WARN"));
  it("WARN at 25", () => expect(p(25)).toBe("WARN"));
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
