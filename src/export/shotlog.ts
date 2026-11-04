// 拍照條件 log 與錯誤檔的純函式核心(設計說明 docs/design20261104-1.md §5)。
//
// 這一層只做「組裝 / 清理 / 截斷 / 淘汰 / 序列化」,不碰 DOM、IndexedDB 或時鐘 ——
// 真實 I/O(儲存、剪貼簿、亂數、現在時間)一律由呼叫端注入,與庫內其他模組一致。
//
// 隱私與誠實三條硬規則(測試逐條釘住):
//   1. 只收錄「條件與結果」,**不收錄影像**:任何 data: URI 字串一律剔除。
//   2. **不收錄帳號**:record 是白名單組裝,輸入多帶的欄位不會被複製進來。
//   3. 量不到的數字寫 null,**不寫 NaN / Infinity / -1**:JSON.stringify(NaN) 本來就會
//      靜默變 null,我們改成明確、可預期地輸出 null(語意 = 不可得),不靠序列化碰巧。
//
// 與 domain 型別無相依:收到的是呼叫端已算好的數字與字串。

/** log 筆數上限(設計 §5.5)。超過就淘汰最舊的。 */
export const SHOT_LOG_MAX = 500;
export const ERROR_LOG_MAX = 200;
/** 單筆錯誤 stack 的位元組上限(UTF-8)。 */
export const STACK_MAX_BYTES = 4096;
/** stack 被截斷時附在尾端的標記。 */
export const TRUNCATED_MARK = "…[已截斷]";

/** 人工判定標註。null = 尚未標註。 */
export type HumanLabel = "good" | "bad" | null;

export type ErrorKind =
  | "error"
  | "unhandledrejection"
  | "camera"
  | "decode"
  | "storage";

/** 一道閘門檢查的紀錄(value 為 null = 不可得)。 */
export interface LoggedGateCheck {
  key: string;
  status: string;
  value: number | null;
}

/** 一個參數的紀錄(逐條掃描線最差值)。 */
export interface LoggedParameter {
  code: string;
  letter: string;
  score: number | null;
}

/** 呼叫端餵進來的原料。欄位皆可缺,缺的一律記 null / 空陣列。 */
export interface ShotRecordInput {
  ts?: Date | number;
  build?: string;
  sessionId?: string;
  seq?: number;
  device?: {
    userAgent?: string;
    facing?: string;
    devicePixelRatio?: number;
    orientation?: string;
  };
  camera?: {
    path?: string;
    requested?: string;
    granted?: string;
    analysisWidth?: number;
    frameSource?: string;
  };
  timing?: {
    shutterDelayMs?: number | null;
    settleFrames?: number;
    focusRelativePct?: number | null;
    candidates?: unknown;
  };
  gate?: Array<{ key: string; status: string; value?: number | null }>;
  geometry?: {
    symbology?: string;
    pxPerModule?: number | null;
    tiltDeg?: number | null;
    tiltSource?: string;
    rectified?: boolean;
  };
  result?: {
    overall?: string | null;
    overallScore?: number | null;
    parameters?: Array<{ code: string; letter: string; score?: number | null }>;
    measurable?: boolean;
    unmeasReason?: string;
    pass?: boolean | null;
    requiredGrade?: string;
  };
  humanLabel?: HumanLabel;
}

export interface ShotRecord {
  id: string;
  ts: string;
  build: string;
  sessionId: string;
  device: {
    userAgent: string;
    facing: string;
    devicePixelRatio: number | null;
    orientation: string;
  };
  camera: {
    path: string;
    requested: string;
    granted: string;
    analysisWidth: number | null;
    frameSource: string;
  };
  timing: {
    shutterDelayMs: number | null;
    settleFrames: number | null;
    focusRelativePct: number | null;
    candidates: unknown;
  };
  gate: LoggedGateCheck[];
  geometry: {
    symbology: string;
    pxPerModule: number | null;
    tiltDeg: number | null;
    tiltSource: string;
    rectified: boolean | null;
  };
  result: {
    overall: string | null;
    overallScore: number | null;
    parameters: LoggedParameter[];
    measurable: boolean | null;
    unmeasReason: string;
    pass: boolean | null;
    requiredGrade: string;
  };
  humanLabel: HumanLabel;
}

export interface ErrorRecordInput {
  ts?: Date | number;
  build?: string;
  sessionId?: string;
  seq?: number;
  kind?: ErrorKind;
  message?: unknown;
  stack?: unknown;
  where?: string;
  lastShotId?: string | null;
}

export interface ErrorRecord {
  id: string;
  ts: string;
  build: string;
  sessionId: string;
  kind: ErrorKind;
  message: string;
  stack: string;
  stackTruncated: boolean;
  where: string;
  lastShotId: string | null;
}

// ── 基本清理 ────────────────────────────────────────────────────────────────

/** 有限數字原樣,其餘(NaN / ±Infinity / null / undefined / 非數字)→ null。 */
export function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 字串原樣,非字串 → 空字串;data: URI(影像)一律剔除成空字串。 */
export function cleanString(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trimStart().toLowerCase().startsWith("data:") ? "" : v;
}

/**
 * 遞迴清理任意值(供 candidates 等自由結構使用):
 * 非有限數字 → null;data: URI 字串 → 剔除;函式 / symbol / bigint → 剔除;
 * 超過深度 6 層的部分截掉(避免循環參照或巨大物件灌進 log)。
 */
export function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6) return null;
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return cleanString(v);
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = scrub(x, depth + 1);
    }
    return out;
  }
  return null;
}

/** 時間戳 → ISO 8601。無效或缺漏時用 fallbackMs(由呼叫端注入現在時間)。 */
function isoOf(ts: Date | number | undefined, fallbackMs: number): string {
  const ms = ts instanceof Date ? ts.getTime() : typeof ts === "number" ? ts : NaN;
  const d = new Date(Number.isFinite(ms) ? ms : fallbackMs);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/**
 * 產生 session 識別碼。rand 由呼叫端注入(0 ≤ r < 1),測試可固定;
 * 不含帳號、不含時間,純隨機 —— 同一次開頁固定、兩次開頁不同。
 */
export function makeSessionId(rand: () => number): string {
  let s = "";
  for (let i = 0; i < 12; i++) {
    s += Math.floor(rand() * 36).toString(36);
  }
  return s;
}

/** 單一字元(以 code point 計)的 UTF-8 位元組數。不依賴 TextEncoder(tsconfig 未含該型別)。 */
function utf8Len(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** 以 UTF-8 位元組截斷字串,不會切斷多位元組字元。回傳 { text, truncated }。 */
export function truncateStack(
  stack: string,
  maxBytes: number = STACK_MAX_BYTES,
): { text: string; truncated: boolean } {
  let total = 0;
  for (const ch of stack) total += utf8Len(ch);
  if (total <= maxBytes) return { text: stack, truncated: false };
  let markBytes = 0;
  for (const ch of TRUNCATED_MARK) markBytes += utf8Len(ch);
  const budget = Math.max(0, maxBytes - markBytes);
  let out = "";
  let used = 0;
  for (const ch of stack) {
    const n = utf8Len(ch);
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return { text: out + TRUNCATED_MARK, truncated: true };
}

// ── 組裝 ───────────────────────────────────────────────────────────────────

/**
 * 組出一筆拍照條件紀錄。**白名單組裝**:只複製下列欄位,輸入多帶的 user / img /
 * token 之類全部不會進來。nowMs 由呼叫端注入,僅在 ts 缺漏或無效時使用。
 */
export function buildShotRecord(inp: ShotRecordInput, nowMs: number): ShotRecord {
  const sessionId = cleanString(inp.sessionId);
  const seq = finiteOrNull(inp.seq) ?? 0;
  const label: HumanLabel =
    inp.humanLabel === "good" || inp.humanLabel === "bad" ? inp.humanLabel : null;
  return {
    id: `${sessionId}-s${seq}`,
    ts: isoOf(inp.ts, nowMs),
    build: cleanString(inp.build),
    sessionId,
    device: {
      userAgent: cleanString(inp.device?.userAgent),
      facing: cleanString(inp.device?.facing),
      devicePixelRatio: finiteOrNull(inp.device?.devicePixelRatio),
      orientation: cleanString(inp.device?.orientation),
    },
    camera: {
      path: cleanString(inp.camera?.path),
      requested: cleanString(inp.camera?.requested),
      granted: cleanString(inp.camera?.granted),
      analysisWidth: finiteOrNull(inp.camera?.analysisWidth),
      frameSource: cleanString(inp.camera?.frameSource),
    },
    timing: {
      shutterDelayMs: finiteOrNull(inp.timing?.shutterDelayMs),
      settleFrames: finiteOrNull(inp.timing?.settleFrames),
      focusRelativePct: finiteOrNull(inp.timing?.focusRelativePct),
      candidates: scrub(inp.timing?.candidates),
    },
    gate: (inp.gate ?? []).map((g) => ({
      key: cleanString(g.key),
      status: cleanString(g.status),
      value: finiteOrNull(g.value),
    })),
    geometry: {
      symbology: cleanString(inp.geometry?.symbology),
      pxPerModule: finiteOrNull(inp.geometry?.pxPerModule),
      tiltDeg: finiteOrNull(inp.geometry?.tiltDeg),
      tiltSource: cleanString(inp.geometry?.tiltSource),
      rectified:
        typeof inp.geometry?.rectified === "boolean" ? inp.geometry.rectified : null,
    },
    result: {
      overall: typeof inp.result?.overall === "string" ? inp.result.overall : null,
      overallScore: finiteOrNull(inp.result?.overallScore),
      parameters: (inp.result?.parameters ?? []).map((p) => ({
        code: cleanString(p.code),
        letter: cleanString(p.letter),
        score: finiteOrNull(p.score),
      })),
      measurable:
        typeof inp.result?.measurable === "boolean" ? inp.result.measurable : null,
      unmeasReason: cleanString(inp.result?.unmeasReason),
      pass: typeof inp.result?.pass === "boolean" ? inp.result.pass : null,
      requiredGrade: cleanString(inp.result?.requiredGrade),
    },
    humanLabel: label,
  };
}

/** 把任何被丟出來的東西轉成訊息字串(Error / 字串 / 物件 / undefined 都不會再丟例外)。 */
function messageOf(m: unknown): string {
  if (typeof m === "string") return cleanString(m);
  if (m && typeof m === "object" && "message" in m) {
    return cleanString((m as { message: unknown }).message);
  }
  try {
    return cleanString(String(m));
  } catch {
    return "";
  }
}

/** 組出一筆錯誤紀錄。stack 截斷在 STACK_MAX_BYTES 內。 */
export function buildErrorRecord(inp: ErrorRecordInput, nowMs: number): ErrorRecord {
  const sessionId = cleanString(inp.sessionId);
  const seq = finiteOrNull(inp.seq) ?? 0;
  const kinds: ErrorKind[] = ["error", "unhandledrejection", "camera", "decode", "storage"];
  const kind = kinds.includes(inp.kind as ErrorKind) ? (inp.kind as ErrorKind) : "error";
  const st = truncateStack(cleanString(inp.stack));
  return {
    id: `${sessionId}-e${seq}`,
    ts: isoOf(inp.ts, nowMs),
    build: cleanString(inp.build),
    sessionId,
    kind,
    message: messageOf(inp.message),
    stack: st.text,
    stackTruncated: st.truncated,
    where: cleanString(inp.where),
    lastShotId: typeof inp.lastShotId === "string" ? inp.lastShotId : null,
  };
}

// ── 儲存策略 ────────────────────────────────────────────────────────────────

/**
 * 在尾端加入一筆並套用上限。回傳 { list, evicted }:list 為保留的(最新在尾端),
 * evicted 為被淘汰的最舊紀錄(呼叫端據此刪除持久層對應的鍵)。不修改輸入陣列。
 */
export function appendWithCap<T>(
  list: readonly T[],
  rec: T,
  max: number,
): { list: T[]; evicted: T[] } {
  const all = [...list, rec];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1;
  const over = Math.max(0, all.length - cap);
  return { list: all.slice(over), evicted: all.slice(0, over) };
}

/** 對指定 id 的拍照紀錄寫入人工標註。找不到 id 時原樣回傳(不丟例外)。不修改輸入。 */
export function withHumanLabel(
  list: readonly ShotRecord[],
  id: string,
  label: HumanLabel,
): ShotRecord[] {
  const lab: HumanLabel = label === "good" || label === "bad" ? label : null;
  return list.map((r) => (r.id === id ? { ...r, humanLabel: lab } : r));
}

// ── 匯出 ───────────────────────────────────────────────────────────────────

/**
 * 序列化成 JSONL:一筆一行,每行可獨立 JSON.parse。
 * JSON.stringify 會把字串內的換行與引號跳脫,故訊息再怪也不會破壞行格式。
 * 空輸入回傳空字串。
 */
export function toJSONL(records: readonly unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}
