// Representative acceptance policies (spec §C3.2, §D2). ITF-14 commonly ≥C,
// GS1-128 commonly ≥B. xDimSpecMm/quietZoneMinX per ITF-14 100% spec (§D2).
import type { AcceptancePolicy } from "../domain/types.js";

export const SEED_ACCEPTANCE_POLICIES: AcceptancePolicy[] = [
  {
    id: "itf14-direct-default",
    symbology: "ITF14",
    requiredGrade: "C",
    xDimSpecMm: 1.016, // ITF-14 100% X 寬
    quietZoneMinX: 10, // ≈10 X（§D2）
  },
  {
    id: "gs1-128-default",
    symbology: "GS1_128",
    requiredGrade: "B",
    xDimSpecMm: 1.016,
    quietZoneMinX: 10,
  },
];
