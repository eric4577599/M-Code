// Domain model — faithful to spec Part C §C3 (領域模型).
// This is the shared foundation every engine imports. Keep it free of logic.

export type Symbology = "ITF14" | "GS1_128" | "CODE128" | "QR" | "DATAMATRIX";
export type GradeLetter = "A" | "B" | "C" | "D" | "F";
export type GateStatus = "OK" | "WARN" | "FAIL";
export type Tier = "FREE" | "PAID" | "ADVANCED";
export type ProcessStage = "INLINE" | "OUTBOUND" | "COMPLAINT"; // 產線抽檢/出貨檢驗/客訴複驗

// ─── Capture / gate (C4) ───────────────────────────────────────────────────
export interface GateCheck {
  key: string;
  status: GateStatus;
  value: number;
  threshold: string;
}
export interface CaptureQualityReport {
  passedAll: boolean;
  gsdMmPerPx: number;
  pxPerModule: number;
  checks: GateCheck[];
}

// ─── Decode (C5) ─────────────────────────────────────────────────────────────
export interface DecodeResult {
  decoded: boolean;
  symbology: Symbology;
  data?: string;
  dimension?: string;
  expectedDataMatch?: boolean;
}

// ─── Measurement (C6) ─────────────────────────────────────────────────────────
export interface ScaleReference {
  type: "CARD" | "COIN";
  nominalMm: number;
  resolvedPx: number;
}
export interface Washboard {
  detected: boolean;
  periodMm: number;
  amplitudeRatio: number;
}
export interface Measurement {
  scaleRef: ScaleReference;
  xDimMm: number;
  barWidthGainMm?: number;
  quietZoneX: number;
  moduleSizeMm?: number;
  washboard?: Washboard;
}

// ─── Grading (C7) ─────────────────────────────────────────────────────────────
export type ParameterKind = "GEOMETRIC" | "PHOTOMETRIC";
export interface ParameterGrade {
  code: string;
  label: string;
  letter: GradeLetter;
  score: number; // 0–4
  kind: ParameterKind;
}
export interface GradeResult {
  overall: GradeLetter;
  overallScore: number; // 0–4
  isRelative: true; // spec C7: 恆 true，非 ISO 合規
  parameters: ParameterGrade[];
}

// ─── Acceptance (C9 / Part B) ────────────────────────────────────────────────
export interface AcceptanceEvaluation {
  policyId: string;
  requiredGrade: GradeLetter;
  pass: boolean;
  marginScore: number;
}

// ─── Diagnosis (C8) ──────────────────────────────────────────────────────────
export interface DiagnosisHit {
  ruleId: string;
  cause: string;
  remedy: string;
  severity: 1 | 2 | 3;
}
export interface DiagnosisResult {
  matched: DiagnosisHit[];
}

// ─── Session (C3.1) ───────────────────────────────────────────────────────────
export interface InspectionSession {
  id: string;
  createdAt: string;
  operatorId?: string;
  plantId?: string;
  lineId?: string;
  processStage: ProcessStage;
  workOrderId?: string; // ERP（付費版）
  substrateProfileId: string;
  symbology: Symbology;
  capture: CaptureQualityReport;
  decode: DecodeResult;
  measurement?: Measurement; // 需比例尺
  grade: GradeResult;
  diagnosis: DiagnosisResult;
  acceptance: AcceptanceEvaluation;
  imageRef?: string;
  syncState: "LOCAL" | "QUEUED" | "SYNCED" | "FAILED";
}

// ─── Settings / profiles (C3.2) ──────────────────────────────────────────────
export type SubstrateCategory =
  | "DIRECT_COARSE"
  | "DIRECT_FINE"
  | "LITHO_LAM"
  | "LABEL";
export type FluteType = "A" | "B" | "C" | "E" | "F" | "NONE";

export interface SubstrateProfile {
  id: string;
  name: string;
  category: SubstrateCategory;
  fluteType?: FluteType;
  expectedFlutePitchMm?: number; // washboard 比對（D3）
  baseline: { meanScore: number; stdScore: number; sampleN: number };
  thresholds: { alertScore: number }; // 各 profile 獨立
}

export interface AcceptancePolicy {
  id: string;
  customer?: string;
  symbology: Symbology;
  requiredGrade: GradeLetter; // ITF-14 常 ≥C；GS1-128 ≥B
  xDimSpecMm: number; // ITF-14 100% = 1.016
  quietZoneMinX: number; // ITF-14 ≈10
  apertureMil?: number;
}

export interface ErpConnection {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}
export interface AppSettings {
  defaultProcessStage: ProcessStage;
  scaleRefDefault: ScaleReference;
  tier: Tier;
  erp?: ErpConnection;
  language: "zh-Hant" | "en";
}

// ─── Diagnosis rules (C3.3, data-driven) ─────────────────────────────────────
export type RuleOp = "<" | ">" | "<=" | ">=" | "==";
export interface RuleCondition {
  metric: string;
  op: RuleOp;
  value: number;
}
export interface DiagnosisRule {
  id: string;
  appliesTo: Symbology[];
  substrateCategories?: SubstrateCategory[];
  when: RuleCondition[]; // AND
  cause: string;
  remedy: string;
  severity: 1 | 2 | 3;
}
