// Relative grading engine — spec §C7.
// All grades are relative proxies aligned to ISO parameter spirit, never a
// compliance verdict. `isRelative` is always true (C7).
//
// Pure, deterministic core: callers pass already-computed numeric proxy
// inputs (no image processing here). Photometric inputs are expected to be
// reflectance-normalized via `reflectanceNormalize` (C7.1) beforehand.

import type {
  GradeLetter,
  GradeResult,
  ParameterGrade,
  ParameterKind,
  Symbology,
} from "../domain/types.js";
import { letterToNominalScore, scoreToLetter } from "../domain/scale.js";

/** Clamp a value into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * C7.1 reflectance normalization with the reference card black/white patches:
 *   R = clamp((L - Lblack) / (Lwhite - Lblack), 0, 1)
 * A non-positive black/white span is degenerate (no usable contrast) → 0.
 */
export function reflectanceNormalize(
  L: number,
  Lblack: number,
  Lwhite: number,
): number {
  const span = Lwhite - Lblack;
  if (span <= 0) return 0;
  return clamp((L - Lblack) / span, 0, 1);
}

/** Raw proxy inputs for the photometric (light-sensitive) parameters (C7.2). */
export interface PhotometricProxyInputs {
  /** Mean normalized reflectance of light elements (spaces). */
  rLight: number;
  /** Mean normalized reflectance of dark elements (bars). */
  rDark: number;
  /** Minimum normalized reflectance of dark elements. */
  rDarkMin: number;
  /** Per-element edge contrasts (normalized 0–1), one per element. */
  edgeContrasts: number[];
}

/** Raw proxy inputs for the geometric parameters (C7.2). 1D and/or 2D fields. */
export interface GeometricProxyInputs {
  // 1D ---------------------------------------------------------------------
  /** DEC: maximum element-width deviation (same unit as `tolerance`). */
  maxWidthDeviation?: number;
  /** DEC: allowed width tolerance (must be > 0 to compute DEC). */
  tolerance?: number;
  /** DEF: maximum element reflectance non-uniformity (normalized 0–1). */
  maxElementReflectanceNonUniformity?: number;
  // 2D ---------------------------------------------------------------------
  /** FPD: damaged fraction of finder/timing patterns (0–1). */
  finderTimingDamageRatio?: number;
  /** ANU/GNU: module grid geometric deviation, normalized (0–1). */
  gridDeviation?: number;
  /** UEC: used error-correction codewords (RS decode). */
  usedEC?: number;
  /** UEC: total error-correction codewords (must be > 0 to compute UEC). */
  totalEC?: number;
}

/** Map a normalized [0,1] proxy ratio to the 0–4 grade score scale. */
function ratioToScore(ratio: number): number {
  return clamp(ratio, 0, 1) * 4;
}

function makeParam(
  code: string,
  label: string,
  kind: ParameterKind,
  score: number,
): ParameterGrade {
  const s = clamp(score, 0, 4);
  return { code, label, kind, score: s, letter: scoreToLetter(s) };
}

/**
 * Compute the photometric parameter grades (C7.2):
 *   SC   = R_light − R_dark
 *   MOD  = min(edgeContrast) / SC
 *   Rmin = min(R_dark)        (lower reflectance is better for dark elements)
 * Each proxy is a 0–1 ratio mapped onto the 0–4 score scale.
 */
export function gradePhotometric(
  inp: PhotometricProxyInputs,
): ParameterGrade[] {
  const sc = clamp(inp.rLight - inp.rDark, 0, 1);
  const minEdge =
    inp.edgeContrasts.length > 0 ? Math.min(...inp.edgeContrasts) : 0;
  // MOD is edge contrast relative to symbol contrast; degenerate SC → 0.
  const mod = sc > 0 ? clamp(minEdge / sc, 0, 1) : 0;
  // Rmin proxy: darker (lower reflectance) bars score higher → 1 − rDarkMin.
  const rmin = clamp(1 - inp.rDarkMin, 0, 1);

  return [
    makeParam("SC", "Symbol Contrast", "PHOTOMETRIC", ratioToScore(sc)),
    makeParam("MOD", "Modulation", "PHOTOMETRIC", ratioToScore(mod)),
    makeParam("Rmin", "Min Reflectance", "PHOTOMETRIC", ratioToScore(rmin)),
  ];
}

/**
 * Compute the geometric parameter grades (C7.2). Only parameters whose inputs
 * are supplied are emitted, so 1D and 2D callers get the relevant subset:
 *   DEC      = 1 − maxWidthDeviation / tolerance              (1D)
 *   DEF      = 1 − maxElementReflectanceNonUniformity / SC    (1D, uses SC)
 *   FPD      = 1 − finderTimingDamageRatio                    (2D)
 *   ANU/GNU  = 1 − gridDeviation                              (2D)
 *   UEC      = 1 − usedEC / totalEC                           (2D)
 * `sc` is the already-computed symbol-contrast ratio (0–1) used by DEF.
 */
export function gradeGeometric(
  inp: GeometricProxyInputs,
  sc: number,
): ParameterGrade[] {
  const out: ParameterGrade[] = [];

  if (inp.maxWidthDeviation !== undefined && inp.tolerance !== undefined) {
    const dec =
      inp.tolerance > 0
        ? clamp(1 - inp.maxWidthDeviation / inp.tolerance, 0, 1)
        : 0;
    out.push(makeParam("DEC", "Decodability", "GEOMETRIC", ratioToScore(dec)));
  }

  if (inp.maxElementReflectanceNonUniformity !== undefined) {
    const def =
      sc > 0
        ? clamp(1 - inp.maxElementReflectanceNonUniformity / sc, 0, 1)
        : 0;
    out.push(makeParam("DEF", "Defects", "GEOMETRIC", ratioToScore(def)));
  }

  if (inp.finderTimingDamageRatio !== undefined) {
    const fpd = clamp(1 - inp.finderTimingDamageRatio, 0, 1);
    out.push(
      makeParam("FPD", "Fixed Pattern Damage", "GEOMETRIC", ratioToScore(fpd)),
    );
  }

  if (inp.gridDeviation !== undefined) {
    const gnu = clamp(1 - inp.gridDeviation, 0, 1);
    out.push(
      makeParam("GNU", "Axial/Grid Non-uniformity", "GEOMETRIC", ratioToScore(gnu)),
    );
  }

  if (inp.usedEC !== undefined && inp.totalEC !== undefined) {
    const uec =
      inp.totalEC > 0 ? clamp(1 - inp.usedEC / inp.totalEC, 0, 1) : 0;
    out.push(makeParam("UEC", "Unused Error Correction", "GEOMETRIC", ratioToScore(uec)));
  }

  return out;
}

/** Full proxy input set for one symbol's parameter computation. */
export interface ProxyInputs {
  photometric: PhotometricProxyInputs;
  geometric: GeometricProxyInputs;
}

/**
 * Compute every parameter grade for one symbol (photometric + geometric).
 * The photometric SC ratio is reused as the denominator for DEF (C7.2).
 */
export function computeParameters(inp: ProxyInputs): ParameterGrade[] {
  const photometric = gradePhotometric(inp.photometric);
  const sc = clamp(inp.photometric.rLight - inp.photometric.rDark, 0, 1);
  const geometric = gradeGeometric(inp.geometric, sc);
  return [...photometric, ...geometric];
}

const ONE_D: ReadonlySet<Symbology> = new Set<Symbology>([
  "ITF14",
  "GS1_128",
  "CODE128",
]);

/** True for 1D symbologies (ITF14/GS1_128/CODE128), false for 2D (QR/DM). */
export function is1D(symbology: Symbology): boolean {
  return ONE_D.has(symbology);
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

function minimum(xs: number[]): number {
  if (xs.length === 0) return 0;
  let m = xs[0]!;
  for (const x of xs) if (x < m) m = x;
  return m;
}

/**
 * Per-scanline parameter sets for a 1D symbol. Spec C7.3 simulates N=10
 * scanlines and averages their overall scores. A single set is treated as
 * one scanline.
 */
export type ScanlineInputs = ProxyInputs[];

/**
 * Build a GradeResult (C7.3).
 *
 * 1D (ITF14/GS1_128/CODE128): overall score = AVERAGE of the per-scanline
 *   overall scores, where each scanline's overall is the MINIMUM of its
 *   parameter scores (ISO 15416 takes the worst parameter per scanline). The
 *   reported `parameters` come from the first scanline. Passing a single
 *   ProxyInputs (not an array) is treated as one scanline.
 *
 * 2D (QR/DATAMATRIX): overall score = MINIMUM of the parameter scores
 *   (ISO 15415 grade is the lowest parameter).
 */
export function buildGradeResult(
  symbology: Symbology,
  input: ProxyInputs | ScanlineInputs,
): GradeResult {
  if (is1D(symbology)) {
    const scanlines: ScanlineInputs = Array.isArray(input) ? input : [input];
    const effective = scanlines.length > 0 ? scanlines : [];
    const perScanline = effective.map((s) => computeParameters(s));
    const scanlineOveralls = perScanline.map((params) =>
      minimum(params.map((p) => p.score)),
    );
    const overallScore = average(scanlineOveralls);
    // Report the first scanline's parameters as representative.
    const parameters = perScanline[0] ?? [];
    return {
      overall: scoreToLetter(overallScore),
      overallScore,
      isRelative: true,
      parameters,
    };
  }

  // 2D — a single parameter set; min parameter takes the overall.
  const single: ProxyInputs = Array.isArray(input) ? input[0]! : input;
  const parameters = computeParameters(single);
  const overallScore = minimum(parameters.map((p) => p.score));
  return {
    overall: scoreToLetter(overallScore),
    overallScore,
    isRelative: true,
    parameters,
  };
}

/**
 * marginScore = overallScore − requiredScore (C7.3), where requiredScore is
 * the nominal score of the required grade band (scale.js). Positive ⇒ passing
 * margin; used for acceptance, pre-warning and trend monitoring.
 */
export function marginScore(
  overallScore: number,
  requiredGrade: GradeLetter,
): number {
  return overallScore - letterToNominalScore(requiredGrade);
}
