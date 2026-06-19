// Feature flags / tier gating — faithful to spec §C10.1 feature-flag matrix.
import type { Tier } from "./types.js";

export type FeatureFlag =
  | "decode_relative_light"
  | "capture_gate"
  | "full_parameters"
  | "measurement_scaleref"
  | "diagnosis"
  | "csv_export"
  | "erp_api"
  | "trend_dashboard"
  | "server_learning"
  | "calibration_mgmt"
  | "alert_push";

// C10.1 matrix: each tier is a superset of the one below it.
const FREE_FLAGS: readonly FeatureFlag[] = [
  "decode_relative_light",
  "capture_gate",
];

const PAID_FLAGS: readonly FeatureFlag[] = [
  ...FREE_FLAGS,
  "full_parameters",
  "measurement_scaleref",
  "diagnosis",
  "csv_export",
  "erp_api",
  "trend_dashboard",
];

const ADVANCED_FLAGS: readonly FeatureFlag[] = [
  ...PAID_FLAGS,
  "server_learning",
  "calibration_mgmt",
  "alert_push",
];

export const TIER_FLAGS: Record<Tier, ReadonlySet<FeatureFlag>> = {
  FREE: new Set(FREE_FLAGS),
  PAID: new Set(PAID_FLAGS),
  ADVANCED: new Set(ADVANCED_FLAGS),
};

export function isEnabled(tier: Tier, flag: FeatureFlag): boolean {
  return TIER_FLAGS[tier].has(flag);
}
