// 誤判率指標(工單 T-20261026「NG 判定中實為良品的占比」)。純函式,不碰 I/O。
//
// 輸入是拍照紀錄(shotlog.ts 的 ShotRecord)中兩個欄位:系統判定 result.pass、人工標註 humanLabel。
// 本檔只「量測」,絕不回頭調整任何閘門或等級門檻(§6.1 凍結)。
// 沒有足夠的人工標註樣本時一律回報 NOT_MEASURED,不得用少量或合成資料宣稱達標。

/** 判定結論。NOT_MEASURED = 樣本不足,尚未量測。 */
export type NgRateVerdict = "NOT_MEASURED" | "ACCEPTABLE" | "MARGINAL" | "UNACCEPTABLE";

/** 可調參數。預設值見 DEFAULT_NG_RATE_PARAMS 的來源註記。 */
export interface NgRateParams {
  /** 各指標的分母至少要有幾筆人工標註才給結論;不足 → NOT_MEASURED */
  minSamples: number;
  /** 良品被判 NG 的比例(誤警率)上限:≤ acceptable 為可接受、≤ marginal 為臨界 */
  falseAlarm: { acceptable: number; marginal: number };
  /** 不良被判 OK 的比例(漏判率)上限 */
  miss: { acceptable: number; marginal: number };
  /** 系統判 NG 的紀錄中,實為良品的占比(工單原始定義) */
  falseNgShare: { acceptable: number; marginal: number };
}

/**
 * 預設值。來源與可信度(誠實標示):
 * - falseAlarm 0.05/0.10、miss 0.02/0.05:AIAG MSA 屬性型量測系統分析常引用的級距
 *   (誤警率 <5% 可接受、<10% 臨界;漏判率 <2% 可接受、<5% 臨界)。**憑記憶引用,尚未讀到原文**。
 * - falseNgShare:AIAG 沒有這個分母的指標,沿用誤警率級距,屬假設,不是業界數字。
 * - minSamples 30:統計上的常見下限,屬經驗值,不是標準規定。
 * 這些都只是起點,現場可依客戶合約或自家驗收改參數。
 */
export const DEFAULT_NG_RATE_PARAMS: NgRateParams = {
  minSamples: 30,
  falseAlarm: { acceptable: 0.05, marginal: 0.1 },
  miss: { acceptable: 0.02, marginal: 0.05 },
  falseNgShare: { acceptable: 0.05, marginal: 0.1 },
};

/** 只取用到的欄位,方便直接餵 ShotRecord 或自己造的標註樣本。 */
export interface LabeledShot {
  humanLabel?: "good" | "bad" | null;
  result?: { pass?: boolean | null } | null;
}

export interface Confusion {
  /** 實為不良、系統判 NG(抓到) */
  tp: number;
  /** 實為良品、系統判 NG(誤殺) */
  fp: number;
  /** 實為不良、系統判 OK(漏判) */
  fn: number;
  /** 實為良品、系統判 OK */
  tn: number;
  /** 有人工標註但系統無法判定(pass 為 null),不進矩陣 */
  unjudged: number;
  /** 沒有人工標註,不進矩陣 */
  unlabeled: number;
}

export interface Metric {
  /** 比值;分母為 0 → null */
  rate: number | null;
  numerator: number;
  denominator: number;
  verdict: NgRateVerdict;
}

export interface NgRateReport {
  confusion: Confusion;
  falseNgShare: Metric;
  falseAlarm: Metric;
  miss: Metric;
  params: NgRateParams;
}

const isRate = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** 壞參數不靜默採用:單組不合法(非 0~1、或 marginal < acceptable)就退回預設那一組。 */
export function normalizeParams(p?: Partial<NgRateParams> | null): NgRateParams {
  const d = DEFAULT_NG_RATE_PARAMS;
  const band = (x: unknown, dflt: { acceptable: number; marginal: number }) => {
    const b = x as { acceptable?: unknown; marginal?: unknown } | undefined;
    return b && isRate(b.acceptable) && isRate(b.marginal) && b.marginal >= b.acceptable
      ? { acceptable: b.acceptable, marginal: b.marginal }
      : { ...dflt };
  };
  const ms = p?.minSamples;
  return {
    minSamples: typeof ms === "number" && Number.isInteger(ms) && ms >= 1 ? ms : d.minSamples,
    falseAlarm: band(p?.falseAlarm, d.falseAlarm),
    miss: band(p?.miss, d.miss),
    falseNgShare: band(p?.falseNgShare, d.falseNgShare),
  };
}

/** 依標註與系統判定算混淆矩陣。pass 為 true=OK、false=NG、其他=無法判定。 */
export function confusionOf(shots: readonly LabeledShot[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0, unjudged: 0, unlabeled: 0 };
  for (const s of shots) {
    const lab = s?.humanLabel;
    if (lab !== "good" && lab !== "bad") { c.unlabeled++; continue; }
    const pass = s?.result?.pass;
    if (pass !== true && pass !== false) { c.unjudged++; continue; }
    if (lab === "bad") { if (pass === false) c.tp++; else c.fn++; }
    else { if (pass === false) c.fp++; else c.tn++; }
  }
  return c;
}

function metric(num: number, den: number, band: { acceptable: number; marginal: number }, minSamples: number): Metric {
  const rate = den > 0 ? num / den : null;
  let verdict: NgRateVerdict = "NOT_MEASURED";
  if (rate !== null && den >= minSamples) {
    verdict = rate <= band.acceptable ? "ACCEPTABLE" : rate <= band.marginal ? "MARGINAL" : "UNACCEPTABLE";
  }
  return { rate, numerator: num, denominator: den, verdict };
}

/** 主入口:標註樣本 + 參數 → 三項指標與結論。 */
export function computeNgRate(shots: readonly LabeledShot[], params?: Partial<NgRateParams> | null): NgRateReport {
  const p = normalizeParams(params);
  const c = confusionOf(shots);
  return {
    confusion: c,
    falseNgShare: metric(c.fp, c.fp + c.tp, p.falseNgShare, p.minSamples),
    falseAlarm: metric(c.fp, c.fp + c.tn, p.falseAlarm, p.minSamples),
    miss: metric(c.fn, c.fn + c.tp, p.miss, p.minSamples),
    params: p,
  };
}

/** 解析 JSONL 匯出檔,只留拍照紀錄(type 為 shot 或缺);壞行略過並計數。 */
export function parseShotJsonl(text: string): { shots: LabeledShot[]; badLines: number } {
  const shots: LabeledShot[] = [];
  let badLines = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === "object" && (o.type === undefined || o.type === "shot")) shots.push(o);
    } catch { badLines++; }
  }
  return { shots, badLines };
}
