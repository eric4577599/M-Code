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
  /** C4.2:scaleRef 偵測到才可量測;false 時量測停用、僅解碼/分級。 */
  measurementEnabled: boolean;
  /**
   * 地面取樣距離(mm/px)。**`null` = 量不出來**(C4.2「GSD 不可得」分支),
   * 不得補 0 或任何假值充數(A4.5:無實體基準則只有像素、量不出 mm)。
   * 刻意用 `null` 而非 `NaN`:NaN 會傳染 —— `JSON.stringify(NaN)` 產出 `null`
   * (本報告會隨 InspectionSession 序列化送 ERP,C9)、`toFixed()` 印出 "NaN"、
   * 任何算術一路污染下去,而型別上仍是合法 `number`,呼叫端不會被逼著處理。
   * 用 `null` 則消費端在 `strict` 下必須明確面對不可得的情形。
   */
  gsdMmPerPx: number | null;
  /** 最窄模組的像素數。`null` 同上,代表量不出來,不得以 0 或 NaN 承載。 */
  pxPerModule: number | null;
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
  // ── 直印瓦楞欄位(2026-11-04 Eric 同意新增;設計說明 docs/design20261104-1.md §4)────
  // 皆**選填**,未填時行為與先前完全相同。數值出處 GS1 General Specifications Release 16.0
  // (2026-11-05 Eric 取得原文並同意採用),見 `src/data/policies.ts` 的具名常數與
  // `plateDirectPrintPolicy`。原文語意:這些規則**只針對需版(plate-based)製程**。
  /** 基材標記。目前只認 "corrugated-direct";其他值一律視為未設定。 */
  substrate?: string;
  /** 直印瓦楞可接受的 X 寬下限(mm)。僅在 substrate 為 "corrugated-direct" 時生效。
   *  GS1:X < 0.635 mm 的 ITF-14「SHOULD NOT」以傳統(需版)製程直印瓦楞 —— 不適用數位/噴墨。 */
  directPrintXMinMm?: number;
  /** bearer bar 寬度,**無版製程**用:窄條寬的倍數(GS1 §5.3.2.4:至少 2 倍)。
   *  目前只存放,尚無判定使用。需版製程是絕對值,見 bearerBarPlateMm —— 兩者是兩種製程各自的值,
   *  不是互相衝突的說法。 */
  bearerBarX?: number;
  /** bearer bar 厚度,**需版製程**用:固定毫米數(GS1 §5.3.2.4:4.83 mm,須包住含靜區的整個符號)。
   *  這是絕對值,不是 X 的倍數,所以不能塞進 bearerBarX。目前只存放,尚無判定使用。 */
  bearerBarPlateMm?: number;
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
