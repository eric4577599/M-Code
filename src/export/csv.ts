// CSV export — spec §C9.4. Maps an InspectionSession to the exact ordered
// column list and renders RFC-4180-style CSV (quote fields containing
// comma / quote / newline; double internal quotes).

import type { InspectionSession } from "../domain/types.js";

/** The exact ordered column list from spec §C9.4. */
export const CSV_COLUMNS: readonly string[] = [
  "session_id",
  "captured_at",
  "plant",
  "line",
  "process_stage",
  "work_order",
  "customer",
  "symbology",
  "decoded_data",
  "expected_match",
  "overall_grade",
  "overall_score",
  "required_grade",
  "pass",
  "margin_score",
  "x_dim_mm",
  "bwr_gain_mm",
  "quiet_zone_x",
  "washboard_period_mm",
  "washboard_amp_ratio",
  "substrate_profile",
  "diagnosis_ids",
];

/** Render one cell: empty for null/undefined, escaped when it contains , " or newline. */
function escapeField(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Map a session to the ordered field values of one CSV row (pre-escape).
 * `customer` is not on the session model, so it is supplied via `extra`.
 */
export function toCsvRow(
  session: InspectionSession,
  extra?: { customer?: string },
): string {
  const m = session.measurement;
  const wb = m?.washboard;
  const diagnosisIds = session.diagnosis.matched
    .map((hit) => hit.ruleId)
    .join(";");

  const cells: Array<string | number | boolean | undefined | null> = [
    session.id,
    session.createdAt,
    session.plantId,
    session.lineId,
    session.processStage,
    session.workOrderId,
    extra?.customer,
    session.symbology,
    session.decode.data,
    session.decode.expectedDataMatch,
    session.grade.overall,
    session.grade.overallScore,
    session.acceptance.requiredGrade,
    session.acceptance.pass,
    session.acceptance.marginScore,
    m?.xDimMm,
    m?.barWidthGainMm,
    m?.quietZoneX,
    wb?.periodMm,
    wb?.amplitudeRatio,
    session.substrateProfileId,
    diagnosisIds,
  ];

  return cells.map(escapeField).join(",");
}

/** Produce a full CSV document: header row followed by one row per session. */
export function toCsv(
  sessions: InspectionSession[],
  extras?: Array<{ customer?: string } | undefined>,
): string {
  const header = CSV_COLUMNS.join(",");
  const rows = sessions.map((s, i) => toCsvRow(s, extras?.[i]));
  return [header, ...rows].join("\n");
}
