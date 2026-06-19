// Measurement engine — spec Part C §C6 (量測引擎).
//
// Pure calculators over injected pixel-space inputs + a ScaleReference. This
// core never touches image pixels itself: callers (the frontend / capture
// pipeline) measure pixel widths via ZXing/OpenCV and pass the already-resolved
// numbers in. Everything here is deterministic arithmetic so it round-trips and
// tests cleanly.
//
// Scale calibration (C6):
//   pxPerMm = scale.resolvedPx / scale.nominalMm
//   gsd     = 1 / pxPerMm          (mm per pixel — D5 名詞表)

import type { Measurement, ScaleReference, Washboard } from "../domain/types.js";

/**
 * Washboard amplitude-ratio floor at/above which washboarding is flagged
 * "detected". Chosen as 0.08 to match the capture-gate WARN onset in C4.2:
 * the `washboard` row reads OK ≤0.08, WARN 0.08–0.15, FAIL >0.15. So any ratio
 * strictly above the OK ceiling is the first sign of periodic flute show-through
 * worth reporting. Kept here as a named constant so the gate engine and this
 * engine cannot drift apart.
 */
export const WASHBOARD_AMP_RATIO_FLOOR = 0.08;

/** Pixels per millimetre from a resolved scale reference (C6). */
export function pxPerMm(scale: ScaleReference): number {
  return scale.resolvedPx / scale.nominalMm;
}

/** Ground sample distance in mm/px — the inverse of pxPerMm (C6 / D5). */
export function gsd(scale: ScaleReference): number {
  return 1 / pxPerMm(scale);
}

/**
 * X-dimension in mm: the narrowest bar/space pixel width scaled by GSD.
 * `narrowestElementPx` is the measured width of the narrowest bar or space.
 */
export function xDimMm(narrowestElementPx: number, scale: ScaleReference): number {
  return narrowestElementPx * gsd(scale);
}

/**
 * Bar width gain in mm (1D): measured bar width minus its nominal width.
 * Positive = ink spread made bars too wide (BWR diagnosis input, C6 table).
 */
export function barWidthGainMm(
  measuredBarWidthMm: number,
  nominalBarWidthMm: number,
): number {
  return measuredBarWidthMm - nominalBarWidthMm;
}

/**
 * Quiet zone expressed in X units: the side quiet-zone pixel width divided by
 * the X-dimension pixel width. Compared against AcceptancePolicy.quietZoneMinX
 * (ITF-14 ≈10). Guards against a zero/negative X width.
 */
export function quietZoneX(quietZonePixels: number, xDimPixels: number): number {
  if (xDimPixels <= 0) return 0;
  return quietZonePixels / xDimPixels;
}

/** 2D module edge length in mm: measured module pixel width scaled by GSD. */
export function moduleSizeMm(modulePixels: number, scale: ScaleReference): number {
  return modulePixels * gsd(scale);
}

/**
 * Washboard assessment from an FFT main-peak in the 2–10mm cross-flute band
 * (C4.2 / C6). `periodMm` is the dominant period (compared against expected
 * flute pitch, D3) and `amplitudeRatio` is main-peak/mean. Detected when the
 * ratio exceeds WASHBOARD_AMP_RATIO_FLOOR. `expectedFlutePitchMm` is accepted
 * for context/symmetry with callers but does not gate detection — detection is
 * purely amplitude-driven per the gate spec.
 */
export function washboard(
  periodMm: number,
  amplitudeRatio: number,
  _expectedFlutePitchMm?: number,
): Washboard {
  return {
    detected: amplitudeRatio > WASHBOARD_AMP_RATIO_FLOOR,
    periodMm,
    amplitudeRatio,
  };
}

/** Inputs for assembling a Measurement. Optional groups omit their output. */
export interface MeasurementInputs {
  scaleRef: ScaleReference;
  /** Narrowest bar/space width in pixels (required for xDimMm). */
  narrowestElementPx: number;
  /** Side quiet-zone width in pixels (required for quietZoneX). */
  quietZonePixels: number;
  /** 1D bar-width-gain inputs; both required to emit barWidthGainMm. */
  measuredBarWidthMm?: number;
  nominalBarWidthMm?: number;
  /** 2D module edge in pixels; required to emit moduleSizeMm. */
  modulePixels?: number;
  /** Washboard FFT result; both required to emit washboard. */
  washboardPeriodMm?: number;
  washboardAmplitudeRatio?: number;
  expectedFlutePitchMm?: number;
}

/**
 * Assemble a Measurement (C3 / C6). xDimMm and quietZoneX are always present;
 * barWidthGainMm, moduleSizeMm and washboard are emitted only when their inputs
 * are supplied (so a 1D symbol omits moduleSizeMm, a 2D symbol omits BWR, etc.).
 */
export function buildMeasurement(inputs: MeasurementInputs): Measurement {
  const { scaleRef } = inputs;
  const xDimPixels = inputs.narrowestElementPx;

  const m: Measurement = {
    scaleRef,
    xDimMm: xDimMm(xDimPixels, scaleRef),
    quietZoneX: quietZoneX(inputs.quietZonePixels, xDimPixels),
  };

  if (
    inputs.measuredBarWidthMm !== undefined &&
    inputs.nominalBarWidthMm !== undefined
  ) {
    m.barWidthGainMm = barWidthGainMm(
      inputs.measuredBarWidthMm,
      inputs.nominalBarWidthMm,
    );
  }

  if (inputs.modulePixels !== undefined) {
    m.moduleSizeMm = moduleSizeMm(inputs.modulePixels, scaleRef);
  }

  if (
    inputs.washboardPeriodMm !== undefined &&
    inputs.washboardAmplitudeRatio !== undefined
  ) {
    m.washboard = washboard(
      inputs.washboardPeriodMm,
      inputs.washboardAmplitudeRatio,
      inputs.expectedFlutePitchMm,
    );
  }

  return m;
}
