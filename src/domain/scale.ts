// Canonical grade <-> score conversions. Single source of truth so the
// grading, acceptance and diagnosis engines never drift apart.
// Spec C7.3 band cuts: A≥3.5, B≥2.5, C≥1.5, D≥0.5, F<0.5 (scores on 0–4).
// Spec D1 nominal letter scores: A=4, B=3, C=2, D=1, F=0.

import type { GradeLetter } from "./types.js";

/** Lower-bound score cut for each letter (C7.3). */
export const GRADE_BAND_CUTS: ReadonlyArray<[GradeLetter, number]> = [
  ["A", 3.5],
  ["B", 2.5],
  ["C", 1.5],
  ["D", 0.5],
  ["F", 0],
];

/** Nominal score for a letter, used when comparing a required grade (D1). */
export const LETTER_NOMINAL_SCORE: Readonly<Record<GradeLetter, number>> = {
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  F: 0,
};

/** Map a 0–4 score to its letter grade via C7.3 band cuts. */
export function scoreToLetter(score: number): GradeLetter {
  for (const [letter, cut] of GRADE_BAND_CUTS) {
    if (score >= cut) return letter;
  }
  return "F";
}

/** Nominal score (0–4) for a required-grade comparison. */
export function letterToNominalScore(letter: GradeLetter): number {
  return LETTER_NOMINAL_SCORE[letter];
}

/** Higher grade letter wins. A is best, F worst. */
export function isAtLeast(actual: GradeLetter, required: GradeLetter): boolean {
  return LETTER_NOMINAL_SCORE[actual] >= LETTER_NOMINAL_SCORE[required];
}
