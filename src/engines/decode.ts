// Decode engine boundary — spec Part C §C5 (解碼引擎).
//
// The actual ZXing-C++ / libdmtx work lives in a frontend-supplied adapter.
// This module is the deterministic core boundary: it takes an injected
// `Decoder` plus an opaque image input and normalizes the result into the
// shared `DecodeResult` shape, applying the spec C5 behavior:
//   - auto-detect symbology (the adapter reports which one it read),
//   - on a work order, compare the decoded data against the expected GTIN
//     (`expectedDataMatch`),
//   - on a no-decode, return `decoded:false` while preserving the
//     requested/declared symbology so the downstream "not readable"
//     diagnosis (C8) can still run.

import type { DecodeResult, Symbology } from "../domain/types.js";

/**
 * Opaque handle for an image (or a ROI within one) handed to the decoder.
 * The core never inspects pixels; the injected adapter does. Frontends are
 * free to carry whatever they need (canvas, byte buffer, native handle).
 */
export interface DecodeInput {
  /**
   * Symbology the caller wants attempted, or wants assumed when auto-detect
   * yields nothing. When the adapter auto-detects, it reports the symbology
   * it actually read in `RawDecode.symbology`; this declared value is the
   * fallback used to keep a meaningful symbology on the no-decode path.
   */
  declaredSymbology: Symbology;
  /** Backend-specific image / ROI payload. Never read by the core. */
  handle: unknown;
}

/** Raw output of the injected decode adapter for a single read. */
export interface RawDecode {
  symbology: Symbology;
  /** Decoded payload: GTIN-14 for ITF14, AI structure for GS1-128, etc. */
  data: string;
  /**
   * Symbology-specific dimension descriptor, e.g. QR version ("M4"),
   * DataMatrix size ("16x16"), or undefined for 1D symbols.
   */
  dimension?: string;
}

/**
 * Injected decode adapter. Returns a `RawDecode` on a successful read, or
 * `null` when nothing readable was found (per C5: 解碼失敗→decoded=false).
 */
export interface Decoder {
  decode(input: DecodeInput): RawDecode | null;
}

export interface RunDecodeOptions {
  /**
   * Expected GTIN-14 from the linked work order (付費版). When provided, the
   * result carries `expectedDataMatch`; otherwise that field stays undefined.
   */
  expectedGtin?: string;
}

/**
 * Normalize an ITF-14 / GTIN-14 string for comparison: drop a leading GS1
 * application identifier `(01)` (the GTIN AI, present in the human-readable
 * GS1-128 form), strip everything that is not a digit (spaces, dashes,
 * bearer-bar artefacts) and left-pad to 14 digits so a 13-digit GTIN compares
 * equal to its zero-padded 14-digit form. Returns the canonical 14-digit
 * string, or the digit-only string unchanged when it is not <=14 digits.
 */
export function normalizeGtin14(raw: string): string {
  const withoutAi = raw.replace(/^\s*\(01\)/, "");
  const digits = withoutAi.replace(/\D+/g, "");
  if (digits.length === 0 || digits.length > 14) return digits;
  return digits.padStart(14, "0");
}

/** True when two GTIN strings are equal after GTIN-14 normalization. */
export function gtinMatches(a: string, b: string): boolean {
  return normalizeGtin14(a) === normalizeGtin14(b);
}

/**
 * Run the injected decoder over an input and produce a spec `DecodeResult`.
 *
 * Success: { decoded:true, symbology, data, dimension?, expectedDataMatch? }.
 *   - For ITF14, `expectedDataMatch` uses GTIN-14 normalized comparison.
 *   - For other symbologies, it is an exact string equality of data vs GTIN.
 *   - When no `expectedGtin` is supplied, `expectedDataMatch` is undefined.
 *
 * No-decode: { decoded:false, symbology: input.declaredSymbology } with the
 *   decoded data/dimension omitted, so downstream diagnosis can still run.
 */
export function runDecode(
  decoder: Decoder,
  input: DecodeInput,
  opts: RunDecodeOptions = {},
): DecodeResult {
  const raw = decoder.decode(input);

  if (raw === null) {
    return { decoded: false, symbology: input.declaredSymbology };
  }

  const result: DecodeResult = {
    decoded: true,
    symbology: raw.symbology,
    data: raw.data,
  };
  if (raw.dimension !== undefined) result.dimension = raw.dimension;

  if (opts.expectedGtin !== undefined) {
    result.expectedDataMatch =
      raw.symbology === "ITF14"
        ? gtinMatches(raw.data, opts.expectedGtin)
        : raw.data === opts.expectedGtin;
  }

  return result;
}
