// Flute pitch reference (spec §D3). Pitch ≈ 304.8 / flutes-per-foot; nominal
// values must be re-calibrated against the actual flute roll in production.
import type { FluteType } from "../domain/types.js";

// Nominal flute pitch in mm; NONE (litho-lam / label) has no corrugation.
export const FLUTE_PITCH_MM: Readonly<Record<FluteType, number | undefined>> = {
  A: 9.2,
  C: 7.4,
  B: 6.5,
  E: 3.2,
  F: 2.4,
  NONE: undefined,
};

/** Nominal expected washboard pitch for a flute type (undefined when none). */
export function expectedFlutePitchMm(fluteType: FluteType): number | undefined {
  return FLUTE_PITCH_MM[fluteType];
}
