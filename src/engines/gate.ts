// Capture quality gate — spec §C4.
// Pure functions over ALREADY-MEASURED numeric inputs. No image processing here;
// the Laplacian variance, glare ratio, FFT amplitude ratio, etc. are injected as
// numbers by the frontend/native layer. This keeps the gate deterministic and
// frontend-agnostic.

import type {
  CaptureQualityReport,
  GateCheck,
  GateStatus,
} from "../domain/types.js";

/**
 * Gate state machine (C4.1).
 * - SCANNING: no symbol ROI located yet (nothing to evaluate).
 * - LOCKED:   shutter disabled — at least one check FAILed.
 * - ARMED:    shutter enabled — all checks OK/WARN.
 */
export type GateState = "SCANNING" | "LOCKED" | "ARMED";

/** Raw measured values feeding the gate. All already computed upstream. */
export interface GateMeasurements {
  /** Symbol ROI located in the frame; when false the gate is SCANNING. */
  symbolDetected: boolean;
  /** Laplacian variance over the ROI (normalised 8-bit). */
  varLap: number;
  /** Highlight (glare) pixel ratio, as a fraction 0–1 (L>250 share). */
  glareRatio: number;
  /** Washboard FFT main-peak / mean amplitude ratio over the 2–10mm band. */
  washboardAmpRatio: number;
  /** White-balance gain deviation against the reference white patch, fraction 0–1. */
  wbGainDeviation: number;
  /** Reference card/coin detected and corner-resolved. */
  scaleRefDetected: boolean;
  /** Symbol main-axis angle from vertical, degrees (absolute). */
  picketAngleDeg: number;
  /** Perspective tilt, degrees (absolute) — additional check folded into release. */
  perspectiveTiltDeg: number;
  /** Ground sample distance, mm per pixel (additional resolution check). */
  gsdMmPerPx: number;
  /** Pixels per narrowest module (additional resolution check). */
  pxPerModule: number;
}

const check = (
  key: string,
  status: GateStatus,
  value: number,
  threshold: string,
): GateCheck => ({ key, status, value, threshold });

// ── Individual check classifiers (C4.2) ─────────────────────────────────────

function classifyFocus(varLap: number): GateCheck {
  // ≥120 OK else FAIL.
  return check("focus", varLap >= 120 ? "OK" : "FAIL", varLap, ">=120 OK");
}

function classifyGlare(glareRatio: number): GateCheck {
  // ≤1% OK, 1–4% WARN, >4% FAIL. glareRatio is a fraction (0.01 == 1%).
  let status: GateStatus;
  if (glareRatio <= 0.01) status = "OK";
  else if (glareRatio <= 0.04) status = "WARN";
  else status = "FAIL";
  return check("glare", status, glareRatio, "<=1% OK, 1-4% WARN, >4% FAIL");
}

function classifyWashboard(ampRatio: number): GateCheck {
  // ≤0.08 OK, 0.08–0.15 WARN, >0.15 FAIL.
  let status: GateStatus;
  if (ampRatio <= 0.08) status = "OK";
  else if (ampRatio <= 0.15) status = "WARN";
  else status = "FAIL";
  return check(
    "washboard",
    status,
    ampRatio,
    "<=0.08 OK, 0.08-0.15 WARN, >0.15 FAIL",
  );
}

function classifyWhiteBalance(wbGainDeviation: number): GateCheck {
  // Δgain ≤5% OK else FAIL. Fraction (0.05 == 5%).
  return check(
    "whiteBalance",
    wbGainDeviation <= 0.05 ? "OK" : "FAIL",
    wbGainDeviation,
    "<=5% OK",
  );
}

function classifyScaleRef(detected: boolean): GateCheck {
  // Detected -> OK / FAIL. Measurement disabled on FAIL but decode still allowed.
  return check(
    "scaleRef",
    detected ? "OK" : "FAIL",
    detected ? 1 : 0,
    "detected OK else FAIL",
  );
}

function classifyPicket(angleDeg: number): GateCheck {
  // ≤10° OK,10–25° WARN,>25° FAIL(C4.2;D2 要求必須 picket fence,
  // 條碼橫躺(如 90°)不得放行)。
  let status: GateStatus;
  if (angleDeg <= 10) status = "OK";
  else if (angleDeg <= 25) status = "WARN";
  else status = "FAIL";
  return check(
    "picket",
    status,
    angleDeg,
    "<=10 OK, 10-25 WARN, >25 FAIL",
  );
}

// ── Additional checks folded into release (C4.2 附加) ────────────────────────

function classifyPerspective(tiltDeg: number): GateCheck {
  // ≤5° OK else FAIL.
  return check(
    "perspective",
    tiltDeg <= 5 ? "OK" : "FAIL",
    tiltDeg,
    "<=5 OK else FAIL",
  );
}

function classifyResolution(gsdMmPerPx: number, pxPerModule: number): GateCheck {
  // gsd≤0.20 AND pxPerModule≥8 OK; pxPerModule<5 FAIL; else WARN.
  let status: GateStatus;
  if (pxPerModule < 5) status = "FAIL";
  else if (gsdMmPerPx <= 0.2 && pxPerModule >= 8) status = "OK";
  else status = "WARN";
  return check(
    "resolution",
    status,
    pxPerModule,
    "gsd<=0.20 & pxPerModule>=8 OK, <8 WARN, <5 FAIL",
  );
}

/** Classify all six checks plus the additional release checks (C4.2). */
export function classifyChecks(m: GateMeasurements): GateCheck[] {
  return [
    classifyFocus(m.varLap),
    classifyGlare(m.glareRatio),
    classifyWashboard(m.washboardAmpRatio),
    classifyWhiteBalance(m.wbGainDeviation),
    classifyScaleRef(m.scaleRefDetected),
    classifyPicket(m.picketAngleDeg),
    classifyPerspective(m.perspectiveTiltDeg),
    classifyResolution(m.gsdMmPerPx, m.pxPerModule),
  ];
}

/**
 * 由各檢查結果推導閘門狀態(C4.1)。
 * 輸入:是否偵測到符號 ROI、各檢查結果;輸出:SCANNING / LOCKED / ARMED。
 * C4.2:scaleRef 未偵測只「量測停用,仍可解碼」,不鎖快門;
 * 其餘任一檢查 FAIL 才 LOCKED。
 */
export function gateState(symbolDetected: boolean, checks: GateCheck[]): GateState {
  if (!symbolDetected) return "SCANNING";
  return checks.some((c) => c.status === "FAIL" && c.key !== "scaleRef")
    ? "LOCKED"
    : "ARMED";
}

/** Result of evaluating the gate: the report plus the C4.1 state. */
export interface GateEvaluation {
  state: GateState;
  report: CaptureQualityReport;
}

/**
 * 評估拍攝品質閘門(C4.3)。
 * 輸入:上游已算好的量測數值;輸出:CaptureQualityReport 與閘門狀態。
 * - 未偵測到符號 ROI → SCANNING,passedAll=false。
 * - passedAll:ARMED 且無任何 FAIL(scaleRef 未偵測時可 ARMED 但 passedAll=false)。
 * - measurementEnabled:scaleRef 偵測到才可量測(C4.2:未偵測→量測停用,仍可解碼)。
 */
export function evaluateGate(m: GateMeasurements): GateEvaluation {
  const checks = classifyChecks(m);
  const state = gateState(m.symbolDetected, checks);
  const passedAll =
    state === "ARMED" && checks.every((c) => c.status !== "FAIL");
  return {
    state,
    report: {
      passedAll,
      measurementEnabled: m.scaleRefDetected,
      gsdMmPerPx: m.gsdMmPerPx,
      pxPerModule: m.pxPerModule,
      checks,
    },
  };
}
