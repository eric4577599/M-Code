import { describe, it, expect } from "vitest";
import type { FeatureFlag } from "../src/domain/flags.js";
import { TIER_FLAGS, isEnabled } from "../src/domain/flags.js";

const ALL_FLAGS: FeatureFlag[] = [
  "decode_relative_light",
  "capture_gate",
  "full_parameters",
  "measurement_scaleref",
  "diagnosis",
  "csv_export",
  "erp_api",
  "trend_dashboard",
  "server_learning",
  "calibration_mgmt",
  "alert_push",
];

describe("C10.1 feature-flag matrix", () => {
  it("FREE has exactly 2 flags (decode_relative_light, capture_gate)", () => {
    expect(TIER_FLAGS.FREE.size).toBe(2);
    expect(isEnabled("FREE", "decode_relative_light")).toBe(true);
    expect(isEnabled("FREE", "capture_gate")).toBe(true);
    expect(isEnabled("FREE", "full_parameters")).toBe(false);
    expect(isEnabled("FREE", "erp_api")).toBe(false);
  });

  it("PAID gates erp_api on but server_learning off", () => {
    expect(isEnabled("PAID", "erp_api")).toBe(true);
    expect(isEnabled("PAID", "server_learning")).toBe(false);
    expect(isEnabled("PAID", "calibration_mgmt")).toBe(false);
    expect(isEnabled("PAID", "alert_push")).toBe(false);
    expect(TIER_FLAGS.PAID.size).toBe(8);
  });

  it("PAID enables every PAID-tier feature", () => {
    for (const flag of [
      "full_parameters",
      "measurement_scaleref",
      "diagnosis",
      "csv_export",
      "trend_dashboard",
    ] as const) {
      expect(isEnabled("PAID", flag)).toBe(true);
    }
  });

  it("ADVANCED has all 11 flags", () => {
    expect(TIER_FLAGS.ADVANCED.size).toBe(11);
    for (const flag of ALL_FLAGS) {
      expect(isEnabled("ADVANCED", flag)).toBe(true);
    }
  });

  it("each tier is a superset of the tier below it", () => {
    for (const flag of TIER_FLAGS.FREE) {
      expect(TIER_FLAGS.PAID.has(flag)).toBe(true);
    }
    for (const flag of TIER_FLAGS.PAID) {
      expect(TIER_FLAGS.ADVANCED.has(flag)).toBe(true);
    }
  });
});
