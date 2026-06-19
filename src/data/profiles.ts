// Representative substrate profiles (spec §C3.2). One per category; baselines
// and alertScore are seed defaults — each profile is independently tunable and
// should be refined from real repeatability data per plant/line.
import type { SubstrateProfile } from "../domain/types.js";
import { expectedFlutePitchMm } from "./flutes.js";

export const SEED_SUBSTRATE_PROFILES: SubstrateProfile[] = [
  {
    id: "direct-c-flute",
    name: "直印 C 楞（粗楞，最常用）",
    category: "DIRECT_COARSE",
    fluteType: "C",
    expectedFlutePitchMm: expectedFlutePitchMm("C"),
    baseline: { meanScore: 2.0, stdScore: 0.4, sampleN: 30 },
    thresholds: { alertScore: 1.5 },
  },
  {
    id: "direct-e-flute",
    name: "直印 E 楞（細楞，高階圖文）",
    category: "DIRECT_FINE",
    fluteType: "E",
    expectedFlutePitchMm: expectedFlutePitchMm("E"),
    baseline: { meanScore: 2.8, stdScore: 0.3, sampleN: 30 },
    thresholds: { alertScore: 2.0 },
  },
  {
    id: "litho-lam",
    name: "表貼（litho-laminated，幾近無楞痕）",
    category: "LITHO_LAM",
    fluteType: "NONE",
    expectedFlutePitchMm: expectedFlutePitchMm("NONE"),
    baseline: { meanScore: 3.3, stdScore: 0.25, sampleN: 30 },
    thresholds: { alertScore: 2.5 },
  },
  {
    id: "label",
    name: "標籤面材（label，無瓦楞）",
    category: "LABEL",
    fluteType: "NONE",
    expectedFlutePitchMm: expectedFlutePitchMm("NONE"),
    baseline: { meanScore: 3.5, stdScore: 0.2, sampleN: 30 },
    thresholds: { alertScore: 2.5 },
  },
];
