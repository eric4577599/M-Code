// Capture quality gate — spec §C4.
// Pure functions over ALREADY-MEASURED numeric inputs. No image processing here;
// the Laplacian variance, glare ratio, FFT amplitude ratio, etc. are injected as
// numbers by the frontend/native layer. This keeps the gate deterministic and
// frontend-agnostic.

import type {
  CaptureQualityReport,
  FluteType,
  GateCheck,
  GateStatus,
} from "../domain/types.js";

/**
 * Gate state machine (C4.1).
 * - SCANNING: no symbol ROI located yet (nothing to evaluate).
 * - LOCKED:   shutter disabled — at least one check FAILed.
 * - ARMED:    shutter enabled — all checks OK/WARN.
 */
export type GateState = "SCANNING" | "LOCKED" | "ARMED";

/**
 * Raw measured values feeding the gate. All already computed upstream.
 * 量不到的欄位寧可留 null / NaN 也**不要填假值充數** —— 各 classify 都有「不可得」守衛
 * (見下方 isMeasured),會落在嚴側而不是靜默放行。
 */
export interface GateMeasurements {
  /** Symbol ROI located in the frame; when false the gate is SCANNING. */
  symbolDetected: boolean;
  /** Laplacian variance over the ROI (normalised 8-bit). */
  varLap: number;
  /** Highlight (glare) pixel ratio, as a fraction 0–1 (L>250 share). */
  glareRatio: number;
  /** Washboard FFT main-peak / mean amplitude ratio over the 2–10mm band. */
  washboardAmpRatio: number;
  /** White-balance gain deviation against the reference white patch, fraction 0–1. */
  wbGainDeviation: number;
  /** Reference card/coin detected and corner-resolved. */
  scaleRefDetected: boolean;
  /** Symbol main-axis angle from vertical, degrees (absolute). */
  picketAngleDeg: number;
  /** Perspective tilt, degrees (absolute) — additional check folded into release. */
  perspectiveTiltDeg: number;
  /**
   * 地面取樣距離(GSD),mm/px,供附加的 resolution 檢查使用。
   * null / 未提供代表「不可得」—— 比例尺卡(scaleRef)未偵測時沒有實體基準,
   * 依規劃書 A4.5 只有像素、量不出 mm,呼叫端不得填入假值充數。
   * 此時 resolution 檢查僅以 pxPerModule 判定(見 classifyResolution)。
   */
  gsdMmPerPx: number | null;
  /** Pixels per narrowest module (additional resolution check). */
  pxPerModule: number;
  /**
   * 材質楞型(選填)。用於判斷 washboard(楞痕透印)檢查是否適用 ——
   * 無瓦楞材質(fluteType === "NONE",如標籤面材、裱貼平版)物理上不可能
   * 出現楞紋透印,不應套用固定振幅門檻,以免材質紋理/背景週期性圖案誤判為 FAIL。
   */
  fluteType?: FluteType;
}

const check = (
  key: string,
  status: GateStatus,
  value: number,
  threshold: string,
): GateCheck => ({ key, status, value, threshold });

// ── 「不可得」共用處理(C4.2) ───────────────────────────────────────────────
//
// 背景:上游把量測值當 number 注入,但 demo/*.html 是原生 JS、不進 typecheck
// (npm run typecheck 只掃 src),量不出來時很容易傳進 null / undefined / NaN。
// JS 的比較運算會把 null coerce 成 0,而 0 在多數檢查裡正是「最寬鬆的放行值」
// (≤5° 透視、≤10° 印向、≤1% 眩光、≤0.08 楞痕皆然),等於量測失敗自動綠燈 ——
// 與規劃書 §1.3 批判的 tilt=0 是同一個病灶,只是換個假值。故每支吃 number 的
// classify 都必須先過守衛,不得讓不可得的輸入落到放行側。

/**
 * 判斷量測值是否真的量到了。
 * 輸入:任意值(呼叫端可能傳 null / undefined / NaN / ±Infinity);輸出:是否為有限數。
 * 用 Number.isFinite 而非 isNaN:前者不做型別轉換,null 直接判為不可得,
 * 不會像 `Number.isNaN(null as any)` 那樣被 coerce 成 0 而誤判為已量到。
 */
const isMeasured = (v: number | null | undefined): v is number => Number.isFinite(v);

/**
 * 「不可得」在 GateCheck.value 上的統一表示法。
 * GateCheck.value 型別是 number(domain/types.ts,不在本次改動範圍),放不進 null;
 * 也刻意不用 NaN —— InspectionSession(含本報告)會被 JSON 序列化送 ERP,
 * `JSON.stringify(NaN)` 產出的是 `null`,等於繞一圈又把 null 漏進報告。
 * 故一律用 -1:閘門的量測值(變異數、比例、角度、像素數)皆為非負,-1 必定在值域外,
 * 不可能與真實讀數混淆;真正的語意由 status 與 threshold 字串承載。
 */
const UNAVAILABLE = -1;

/**
 * 產生「量測不可得」的檢查結果。
 * 輸入:檢查 key、該給的狀態、原本的門檻字串;輸出:value 統一為 UNAVAILABLE 的 GateCheck。
 * threshold 沿用既有 classifyResolution 的句型(不可得敘述在前、原門檻在後),
 * 且只陳述「不可得」不歸因成因(成因不只一種,由呼叫端自行說明情境)。
 */
const unavailable = (
  key: string,
  status: GateStatus,
  criterion: string,
): GateCheck => check(key, status, UNAVAILABLE, `measurement unavailable: ${criterion}`);

// ── Individual check classifiers (C4.2) ─────────────────────────────────────

function classifyFocus(varLap: number): GateCheck {
  // ≥120 OK else FAIL.
  // 不可得 → FAIL:對焦沒量到就沒有替代量,不得放行。
  if (!isMeasured(varLap)) return unavailable("focus", "FAIL", ">=120 OK");
  return check("focus", varLap >= 120 ? "OK" : "FAIL", varLap, ">=120 OK");
}

function classifyGlare(glareRatio: number): GateCheck {
  // ≤1% OK, 1–4% WARN, >4% FAIL. glareRatio is a fraction (0.01 == 1%).
  // 不可得 → FAIL:null 會 coerce 成 0(≤1%,最寬鬆的放行值),不擋就是自動綠燈。
  if (!isMeasured(glareRatio))
    return unavailable("glare", "FAIL", "<=1% OK, 1-4% WARN, >4% FAIL");
  let status: GateStatus;
  if (glareRatio <= 0.01) status = "OK";
  else if (glareRatio <= 0.04) status = "WARN";
  else status = "FAIL";
  return check("glare", status, glareRatio, "<=1% OK, 1-4% WARN, >4% FAIL");
}

function classifyWashboard(ampRatio: number, fluteType?: FluteType): GateCheck {
  // 無瓦楞材質(fluteType === "NONE")物理上不會有楞痕透印,此檢查不適用,
  // 一律回傳 OK,不套用固定門檻(避免材質紋理造成假陽性 FAIL/WARN 鎖死快門)。
  // value 仍回傳原始 ampRatio 供除錯用,不影響狀態判定。
  if (fluteType === "NONE") {
    return check(
      "washboard",
      "OK",
      // 此分支不看讀數,但 value 仍不得帶 NaN/null 進報告,故不可得時填 UNAVAILABLE。
      isMeasured(ampRatio) ? ampRatio : UNAVAILABLE,
      "N/A (no flute — non-corrugated substrate)",
    );
  }
  // 不可得 → FAIL:有楞材質卻量不到楞痕振幅就是沒判準,null coerce 成 0 會落在 ≤0.08 的
  // 放行側。此處與上面的 NONE 分支語意不同:NONE 是「物理上不適用」,不可得是「該量沒量到」。
  if (!isMeasured(ampRatio))
    return unavailable("washboard", "FAIL", "<=0.08 OK, 0.08-0.15 WARN, >0.15 FAIL");
  // 其餘材質(含未提供 fluteType,維持向後相容預設行為):
  // ≤0.08 OK, 0.08–0.15 WARN, >0.15 FAIL.
  let status: GateStatus;
  if (ampRatio <= 0.08) status = "OK";
  else if (ampRatio <= 0.15) status = "WARN";
  else status = "FAIL";
  return check(
    "washboard",
    status,
    ampRatio,
    "<=0.08 OK, 0.08-0.15 WARN, >0.15 FAIL",
  );
}

function classifyWhiteBalance(wbGainDeviation: number): GateCheck {
  // 白平衡僅為「建議燈」,永不 FAIL、永不鎖快門(Δgain ≤5% OK,>5% WARN)。
  // 理由:條碼 / QR 的可讀性取決於條碼與底色之間的「色差對比」是否足以被解碼器
  // 準確分辨(此由 C5 解碼與 C7 分級的 SC / MOD / 邊緣對比把關),而非取決於
  // 絕對白平衡是否中性。有色光源下灰界白平衡偏差很容易超標,若當硬閘門會使
  // 現場明明拍得出可解讀影像卻鎖死快門(實際使用者回報)。故列為建議、不阻拍。
  // value 仍回傳原始偏差供除錯與反射量測參考。
  //
  // 不可得 → WARN,是本檔唯一不判 FAIL 的「不可得」分支。理由:白平衡永不鎖快門是
  // C4.2 明訂的性質(改成 FAIL 等於把建議燈改回硬閘門,這是歷史誤判熱區),故取
  // 「不鎖快門的前提下最嚴的一側」= WARN,而不是讓 null coerce 成 0 拿到 OK。
  if (!isMeasured(wbGainDeviation))
    return unavailable(
      "whiteBalance",
      "WARN",
      "<=5% OK else WARN (advisory, never locks)",
    );
  return check(
    "whiteBalance",
    wbGainDeviation <= 0.05 ? "OK" : "WARN",
    wbGainDeviation,
    "<=5% OK else WARN (advisory, never locks)",
  );
}

function classifyScaleRef(detected: boolean): GateCheck {
  // Detected -> OK / FAIL. Measurement disabled on FAIL but decode still allowed.
  // 輸入是 bool 不是量測值,不需要 isMeasured 守衛:undefined / null 皆為 falsy,
  // 直接落在 FAIL 側(嚴側),不會因 coerce 而放行。
  return check(
    "scaleRef",
    detected ? "OK" : "FAIL",
    detected ? 1 : 0,
    "detected OK else FAIL",
  );
}

function classifyPicket(angleDeg: number): GateCheck {
  // ≤10° OK,10–25° WARN,>25° FAIL(C4.2;D2 要求必須 picket fence,
  // 條碼橫躺(如 90°)不得放行)。
  //
  // 不可得 → FAIL(鎖快門),語意刻意與 resolution 的「GSD 不可得」不同:
  // GSD 不可得時 pxPerModule 還撐得住那道檢查(少一個條件,不是沒有判準),
  // 但主軸夾角沒有替代量 —— 若比照辦理標成 N/A/OK,這盞燈就恆綠。
  // 且 null/undefined 一 coerce 就是 0°,正好是最寬鬆的放行值。
  // 判 FAIL 是逼呼叫端面對:要嘛真的量到,要嘛明確給代理值並自行標註。
  if (!isMeasured(angleDeg))
    return unavailable("picket", "FAIL", "<=10 OK, 10-25 WARN, >25 FAIL");
  let status: GateStatus;
  if (angleDeg <= 10) status = "OK";
  else if (angleDeg <= 25) status = "WARN";
  else status = "FAIL";
  return check(
    "picket",
    status,
    angleDeg,
    "<=10 OK, 10-25 WARN, >25 FAIL",
  );
}

// ── Additional checks folded into release (C4.2 附加) ────────────────────────

function classifyPerspective(tiltDeg: number): GateCheck {
  // ≤5° OK else FAIL.
  //
  // 不可得 → FAIL(鎖快門),理由同 picket:傾角沒有替代量,標 N/A 就是恆綠。
  // 這道守衛直接對應 tiltFromHomography 的「焦距不可得回 null」——
  // 該函式誠實回 null 之後,若閘門這側讓 null coerce 成 0°,誠實就白做了
  // (0° 是 ≤5° 的最寬鬆放行值)。呼叫端可以退回代理傾角,不可以不填就過。
  if (!isMeasured(tiltDeg)) return unavailable("perspective", "FAIL", "<=5 OK else FAIL");
  return check(
    "perspective",
    tiltDeg <= 5 ? "OK" : "FAIL",
    tiltDeg,
    "<=5 OK else FAIL",
  );
}

/**
 * resolution 檢查(C4.2 附加)。
 * 輸入:GSD(mm/px,null/undefined 代表不可得)、最窄模組的像素數;輸出:GateCheck。
 * 邏輯:
 * - GSD 可得:gsd≤0.20 AND pxPerModule≥8 OK;pxPerModule<5 FAIL;其餘 WARN。
 * - GSD 不可得(呼叫端傳 null/undefined):比照 washboard 對 fluteType === "NONE"
 *   的做法,該項不套固定門檻、threshold 只陳述「GSD 不可得」這個事實,
 *   僅以 pxPerModule 判定(<5 FAIL、<8 WARN、否則 OK)。
 *   不可得的成因不只一種(比例尺卡未偵測是最常見的一種,也可能是四角未解出、
 *   換算失敗等),故文案不歸因,由呼叫端自行說明情境。NaN 視同 null。
 * - pxPerModule 不可得:整道檢查失去唯一剩下的判準,直接 FAIL(NaN 若不擋會
 *   兩個比較都為 false 而落到 WARN,那是放行側;null 則 coerce 成 0 判 FAIL,
 *   方向不一致)。
 * 兩個門檻數字(pxPerModule≥8、gsd≤0.20)來自規格 A4.3,任何分支都不放寬。
 */
function classifyResolution(
  gsdMmPerPx: number | null | undefined,
  pxPerModule: number,
): GateCheck {
  let status: GateStatus;
  if (!isMeasured(pxPerModule))
    return unavailable("resolution", "FAIL", "pxPerModule>=8 OK, <8 WARN, <5 FAIL");
  if (!isMeasured(gsdMmPerPx)) {
    // GSD 不可得:只用像素密度判定,不因缺 GSD 而放行、也不因缺 GSD 而硬判 FAIL。
    // threshold 只說「不可得」不斷定成因(null 可能來自比例尺卡未偵測,也可能來自
    // 換算失敗等其他情況),避免在報告上寫出未經查證的歸因。
    if (pxPerModule < 5) status = "FAIL";
    else if (pxPerModule < 8) status = "WARN";
    else status = "OK";
    return check(
      "resolution",
      status,
      pxPerModule,
      "GSD unavailable: pxPerModule>=8 OK, <8 WARN, <5 FAIL",
    );
  }
  if (pxPerModule < 5) status = "FAIL";
  else if (gsdMmPerPx <= 0.2 && pxPerModule >= 8) status = "OK";
  else status = "WARN";
  return check(
    "resolution",
    status,
    pxPerModule,
    "gsd<=0.20 & pxPerModule>=8 OK, <8 WARN, <5 FAIL",
  );
}

/** Classify all six checks plus the additional release checks (C4.2). */
export function classifyChecks(m: GateMeasurements): GateCheck[] {
  return [
    classifyFocus(m.varLap),
    classifyGlare(m.glareRatio),
    classifyWashboard(m.washboardAmpRatio, m.fluteType),
    classifyWhiteBalance(m.wbGainDeviation),
    classifyScaleRef(m.scaleRefDetected),
    classifyPicket(m.picketAngleDeg),
    classifyPerspective(m.perspectiveTiltDeg),
    classifyResolution(m.gsdMmPerPx, m.pxPerModule),
  ];
}

/**
 * 由各檢查結果推導閘門狀態(C4.1)。
 * 輸入:是否偵測到符號 ROI、各檢查結果;輸出:SCANNING / LOCKED / ARMED。
 * C4.2:scaleRef 未偵測只「量測停用,仍可解碼」,不鎖快門;
 * 其餘任一檢查 FAIL 才 LOCKED。
 */
export function gateState(symbolDetected: boolean, checks: GateCheck[]): GateState {
  if (!symbolDetected) return "SCANNING";
  return checks.some((c) => c.status === "FAIL" && c.key !== "scaleRef")
    ? "LOCKED"
    : "ARMED";
}

/** Result of evaluating the gate: the report plus the C4.1 state. */
export interface GateEvaluation {
  state: GateState;
  report: CaptureQualityReport;
}

/**
 * 評估拍攝品質閘門(C4.3)。
 * 輸入:上游已算好的量測數值;輸出:CaptureQualityReport 與閘門狀態。
 * - 未偵測到符號 ROI → SCANNING,passedAll=false。
 * - passedAll:ARMED 且無任何 FAIL(scaleRef 未偵測時可 ARMED 但 passedAll=false)。
 * - measurementEnabled:scaleRef 偵測到才可量測(C4.2:未偵測→量測停用,仍可解碼)。
 */
export function evaluateGate(m: GateMeasurements): GateEvaluation {
  const checks = classifyChecks(m);
  const state = gateState(m.symbolDetected, checks);
  const passedAll =
    state === "ARMED" && checks.every((c) => c.status !== "FAIL");
  return {
    state,
    report: {
      passedAll,
      measurementEnabled: m.scaleRefDetected,
      // GSD 不可得時報告以 NaN 表示「量不出來」,不可補 0 或任何假值
      // (CaptureQualityReport.gsdMmPerPx 目前型別為 number,不在本次改動範圍)。
      gsdMmPerPx: isMeasured(m.gsdMmPerPx) ? m.gsdMmPerPx : NaN,
      // pxPerModule 同理:不可得一律正規化成 NaN,至少不讓 null 直接躺在 number 欄位裡。
      // 註:報告頂層這兩欄用 NaN 是既有約定(GateCheck.value 則用 -1,見 UNAVAILABLE 說明);
      // 兩者不一致的根因是這兩欄型別在 domain/types.ts,不在本次改動範圍。
      pxPerModule: isMeasured(m.pxPerModule) ? m.pxPerModule : NaN,
      checks,
    },
  };
}
