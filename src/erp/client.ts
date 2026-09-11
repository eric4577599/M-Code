// ERP client + offline queue (spec §C9). Frontend-agnostic and deterministic:
// all HTTP is injected via a Transport, and the clock is injected as a `now`
// function so token caching can be tested without Date.now.
//
//   C9.1 auth:           POST /oauth/token (client_credentials) → { access_token, expires_in }
//   C9.2 get work order: GET  /api/v1/workorders/{id} (Bearer)
//   C9.3 post inspection:POST /api/v1/inspections (Bearer, Idempotency-Key)
//   C9.5 offline queue:  2xx→SYNCED ; 4xx→FAILED+reason ; 5xx/timeout→keep QUEUED

import type {
  Symbology,
  GradeLetter,
  ProcessStage,
  ErpConnection,
} from "../domain/types.js";
import { LETTER_NOMINAL_SCORE } from "../domain/scale.js";

// ─── Transport abstraction (injected — no real I/O in core) ──────────────────
export type HttpMethod = "GET" | "POST";

export interface TransportRequestOptions {
  headers?: Record<string, string>;
  /** Already-serialized request body (e.g. JSON string or form-encoded). */
  body?: string;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

export interface Transport {
  request(
    method: HttpMethod,
    path: string,
    opts?: TransportRequestOptions,
  ): Promise<TransportResponse>;
}

/** Monotonic-ish clock in milliseconds since epoch. Injected for determinism. */
export type Clock = () => number;

// ─── C9.1 OAuth token response ───────────────────────────────────────────────
export interface OAuthTokenResponse {
  access_token: string;
  expires_in: number; // seconds
}

// ─── C9.2 work order payload ─────────────────────────────────────────────────
export interface WorkOrderAcceptance {
  requiredGrade: GradeLetter;
  xDimSpecMm: number;
  quietZoneMinX: number;
}
export interface WorkOrder {
  id: string;
  customer: string;
  symbology: Symbology;
  expectedGtin?: string;
  acceptance: WorkOrderAcceptance;
}

// ─── C9.3 inspection post body ───────────────────────────────────────────────
export interface InspectionGrade {
  overall: GradeLetter;
  score: number;
  relative: boolean;
}
export interface InspectionAcceptance {
  requiredGrade: GradeLetter;
  pass: boolean;
  marginScore: number;
}
export interface InspectionWashboard {
  periodMm: number;
  amplitudeRatio: number;
}
export interface InspectionMeasurement {
  xDimMm?: number;
  barWidthGainMm?: number;
  quietZoneX?: number;
  washboard?: InspectionWashboard;
}
export interface InspectionDiagnosis {
  ruleId: string;
  severity: number;
}
export interface InspectionPostBody {
  sessionId: string;
  workOrderId: string;
  processStage: ProcessStage;
  symbology: Symbology;
  decodedData: string | null;
  grade: InspectionGrade;
  acceptance: InspectionAcceptance;
  measurement?: InspectionMeasurement;
  diagnosis: InspectionDiagnosis[];
  capturedAt: string;
  imageRef: string | null;
}
export interface InspectionPostResult {
  inspectionId: string;
}

// ─── Offline queue (C9.5) ────────────────────────────────────────────────────
export type SyncOutcome = "SYNCED" | "FAILED" | "QUEUED";

export interface QueuedInspection {
  /** Stable id; also used as the Idempotency-Key so retries never duplicate. */
  id: string;
  body: InspectionPostBody;
}

export interface QueueItemResult {
  id: string;
  outcome: SyncOutcome;
  /** Set when outcome is FAILED (4xx) or kept QUEUED (5xx/timeout). */
  reason?: string;
  /** Server-assigned id on a successful (2xx) sync. */
  inspectionId?: string;
}

// ─── Errors ──────────────────────────────────────────────────────────────────
export class ErpHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`ERP HTTP ${status}`);
    this.name = "ErpHttpError";
  }
}

/**
 * 回應格式錯(A-09)。輸入:HTTP 狀態碼與原始 body;輸出:一個可與一般
 * ErpHttpError 區分的永久性錯誤。
 * 邏輯:狀態碼是 2xx 但 body 不符合約定格式(例如反向代理攔截回一頁 HTML)
 * 屬設定錯誤,重試一萬次也不會好,因此必須收斂成 FAILED 而非留在佇列重送。
 * 以繼承實作,既有 `err instanceof ErpHttpError` 判斷仍成立,故 syncOne 的
 * 分支順序必須先判 malformed。
 */
export class ErpMalformedResponseError extends ErpHttpError {
  constructor(status: number, body: unknown) {
    super(status, body);
    this.name = "ErpMalformedResponseError";
    this.message = `ERP HTTP ${status} malformed response`;
  }
}

interface CachedToken {
  accessToken: string;
  /** Absolute epoch-ms at which the token can no longer be used. */
  expiresAtMs: number;
}

const AUTH_PATH = "/oauth/token";
const WORKORDER_PATH = "/api/v1/workorders";
const INSPECTION_PATH = "/api/v1/inspections";

/** Refresh a little before nominal expiry so an in-flight request never 401s. */
const EXPIRY_SKEW_MS = 30_000;

// OAuth token 回應的型別守衛:輸入任意值,輸出是否為合法 OAuthTokenResponse
function isOAuthTokenResponse(value: unknown): value is OAuthTokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OAuthTokenResponse).access_token === "string" &&
    typeof (value as OAuthTokenResponse).expires_in === "number"
  );
}

/** 允收字母的單一事實來源:直接取自 scale.ts 的 LETTER_NOMINAL_SCORE,避免手抄漂移。 */
const GRADE_LETTERS: ReadonlySet<string> = new Set(Object.keys(LETTER_NOMINAL_SCORE));

/** 符號別允許值;與 domain/types.ts 的 Symbology union 對齊(型別層由下方 satisfies 保證)。 */
const SYMBOLOGIES: ReadonlySet<string> = new Set([
  "ITF14",
  "GS1_128",
  "CODE128",
  "QR",
  "DATAMATRIX",
] satisfies Symbology[]);

/**
 * WorkOrder 回應的型別守衛(A-07)。輸入:任意值;輸出:是否為合法 WorkOrder。
 * 邏輯:逐欄驗型別與允許值 —— id/customer 為字串、symbology 在允許集合內、
 * expectedGtin 缺席或字串、acceptance 為物件且 requiredGrade 為大小寫敏感的
 * A|B|C|D|F、xDimSpecMm 與 quietZoneMinX 為有限數。
 * 為何要驗:requiredGrade 一旦是 'c' / 'B+' / null,下游 evaluateAcceptance 會
 * 算出 pass=false 配 margin>0,打破「margin ≥ 0 ⟺ pass」不變量,讓預警數字說謊。
 */
export function isWorkOrder(value: unknown): value is WorkOrder {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const wo = value as Record<string, unknown>;
  if (typeof wo["id"] !== "string") return false;
  if (typeof wo["customer"] !== "string") return false;
  if (typeof wo["symbology"] !== "string" || !SYMBOLOGIES.has(wo["symbology"])) return false;
  if (wo["expectedGtin"] !== undefined && typeof wo["expectedGtin"] !== "string") return false;

  const acc = wo["acceptance"];
  if (typeof acc !== "object" || acc === null || Array.isArray(acc)) return false;
  const a = acc as Record<string, unknown>;
  if (typeof a["requiredGrade"] !== "string" || !GRADE_LETTERS.has(a["requiredGrade"])) {
    return false;
  }
  if (!Number.isFinite(a["xDimSpecMm"])) return false;
  if (!Number.isFinite(a["quietZoneMinX"])) return false;
  return true;
}

export class ErpClient {
  private cached: CachedToken | undefined;

  constructor(
    private readonly conn: ErpConnection,
    private readonly transport: Transport,
    private readonly now: Clock,
  ) {}

  /**
   * C9.1 — fetch (and cache) a client_credentials access token. Returns the
   * cached token while it is still valid (per the injected clock); only
   * re-requests once it is within EXPIRY_SKEW_MS of expiry.
   */
  async getToken(): Promise<string> {
    const cached = this.cached;
    if (cached !== undefined && this.now() < cached.expiresAtMs - EXPIRY_SKEW_MS) {
      return cached.accessToken;
    }

    const form = [
      ["grant_type", "client_credentials"],
      ["client_id", this.conn.clientId],
      ["client_secret", this.conn.clientSecret],
    ]
      .map(([k, v]) => `${encodeURIComponent(k ?? "")}=${encodeURIComponent(v ?? "")}`)
      .join("&");

    const res = await this.transport.request("POST", AUTH_PATH, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new ErpHttpError(res.status, res.body);
    }
    // 2xx 但格式錯 → 永久性設定錯誤,擲可區分的 malformed 錯誤(A-09)。
    if (!isOAuthTokenResponse(res.body)) {
      throw new ErpMalformedResponseError(res.status, res.body);
    }

    this.cached = {
      accessToken: res.body.access_token,
      expiresAtMs: this.now() + res.body.expires_in * 1000,
    };
    return res.body.access_token;
  }

  private async authHeaders(
    extra?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  /**
   * 收到 401 時清除 token 快取:伺服器可能提前撤銷 token(C11「OAuth 失效重取」),
   * 清掉後下一次呼叫會重新取 token,不必等名目 expires_in 走完。
   */
  private invalidateTokenOn401(status: number): void {
    if (status === 401) this.cached = undefined;
  }

  /** C9.2 — GET a work order with its acceptance thresholds. */
  async getWorkOrder(id: string): Promise<WorkOrder> {
    const res = await this.transport.request(
      "GET",
      `${WORKORDER_PATH}/${encodeURIComponent(id)}`,
      { headers: await this.authHeaders() },
    );
    if (res.status < 200 || res.status >= 300) {
      this.invalidateTokenOn401(res.status);
      throw new ErpHttpError(res.status, res.body);
    }
    // 先狀態碼、後格式:body 不合格時帶回實際狀態與原始 body 供除錯,
    // 不回半個物件、不就地補欄位(A-07)。
    if (!isWorkOrder(res.body)) {
      throw new ErpHttpError(res.status, res.body);
    }
    return res.body;
  }

  /**
   * C9.3 — POST an inspection. The Idempotency-Key guarantees that retrying the
   * same logical inspection never creates a duplicate record server-side.
   */
  async postInspection(
    body: InspectionPostBody,
    idempotencyKey: string,
  ): Promise<TransportResponse> {
    const res = await this.transport.request("POST", INSPECTION_PATH, {
      headers: await this.authHeaders({
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      }),
      body: JSON.stringify(body),
    });
    this.invalidateTokenOn401(res.status);
    return res;
  }

  /**
   * C9.5 — drain an offline queue. Each item is POSTed with its id as the
   * Idempotency-Key. Outcomes per spec:
   *   2xx          → SYNCED  (record inspectionId)
   *   4xx          → FAILED  (client error; do not retry)
   *   5xx/timeout  → QUEUED  (transient; stays for the next connectivity event)
   * A thrown transport error (network/timeout) is treated like 5xx.
   */
  async processQueue(items: QueuedInspection[]): Promise<QueueItemResult[]> {
    const results: QueueItemResult[] = [];
    for (const item of items) {
      results.push(await this.syncOne(item));
    }
    return results;
  }

  /**
   * 同步單筆佇列項目。輸入:佇列項目;輸出:C9.5 outcome。
   * - 2xx → SYNCED;401 → QUEUED(token 可能被撤銷,快取已清,下次帶新 token 重試);
   *   其餘 4xx → FAILED(客戶端錯誤,不重試);5xx/網路錯誤 → QUEUED。
   * - getToken() 擲出的 4xx(如 client_secret 錯)屬永久性憑證錯誤 → FAILED,
   *   避免整個佇列無限期滯留重送。
   * - getToken() 擲出的 ErpMalformedResponseError(2xx 但 body 非 OAuth 格式)同屬
   *   永久性設定錯誤 → FAILED。因其繼承 ErpHttpError,必須排在 4xx 判斷之前。
   */
  private async syncOne(item: QueuedInspection): Promise<QueueItemResult> {
    let res: TransportResponse;
    try {
      res = await this.postInspection(item.body, item.id);
    } catch (err) {
      if (err instanceof ErpMalformedResponseError) {
        // 回應格式錯(如 200 + 一頁 HTML):設定問題,重送無用 → FAILED。
        return { id: item.id, outcome: "FAILED", reason: err.message };
      }
      if (err instanceof ErpHttpError && err.status >= 400 && err.status < 500) {
        // 取 token 就 4xx:憑證/請求本身錯,重試也不會好 → FAILED。
        return { id: item.id, outcome: "FAILED", reason: err.message };
      }
      // Network failure / timeout → transient → keep QUEUED.
      const reason = err instanceof Error ? err.message : String(err);
      return { id: item.id, outcome: "QUEUED", reason };
    }

    const { status, body } = res;
    if (status >= 200 && status < 300) {
      const inspectionId =
        typeof body === "object" &&
        body !== null &&
        typeof (body as InspectionPostResult).inspectionId === "string"
          ? (body as InspectionPostResult).inspectionId
          : undefined;
      return { id: item.id, outcome: "SYNCED", inspectionId };
    }
    if (status === 401) {
      // token 遭提前撤銷:postInspection 已清快取,保留 QUEUED 待下次以新 token 重試;
      // 若憑證真的失效,下次 getToken() 會 4xx → 走上面的 FAILED 路徑收斂。
      return { id: item.id, outcome: "QUEUED", reason: `HTTP ${status}` };
    }
    if (status >= 400 && status < 500) {
      return {
        id: item.id,
        outcome: "FAILED",
        reason: `HTTP ${status}`,
      };
    }
    // 5xx (or anything else non-2xx/4xx) → transient → keep QUEUED.
    return { id: item.id, outcome: "QUEUED", reason: `HTTP ${status}` };
  }
}
