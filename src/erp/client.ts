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

function isFormUrlEncoded(value: unknown): value is OAuthTokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OAuthTokenResponse).access_token === "string" &&
    typeof (value as OAuthTokenResponse).expires_in === "number"
  );
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

    if (res.status < 200 || res.status >= 300 || !isFormUrlEncoded(res.body)) {
      throw new ErpHttpError(res.status, res.body);
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

  /** C9.2 — GET a work order with its acceptance thresholds. */
  async getWorkOrder(id: string): Promise<WorkOrder> {
    const res = await this.transport.request(
      "GET",
      `${WORKORDER_PATH}/${encodeURIComponent(id)}`,
      { headers: await this.authHeaders() },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new ErpHttpError(res.status, res.body);
    }
    return res.body as WorkOrder;
  }

  /**
   * C9.3 — POST an inspection. The Idempotency-Key guarantees that retrying the
   * same logical inspection never creates a duplicate record server-side.
   */
  async postInspection(
    body: InspectionPostBody,
    idempotencyKey: string,
  ): Promise<TransportResponse> {
    return this.transport.request("POST", INSPECTION_PATH, {
      headers: await this.authHeaders({
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      }),
      body: JSON.stringify(body),
    });
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

  private async syncOne(item: QueuedInspection): Promise<QueueItemResult> {
    let res: TransportResponse;
    try {
      res = await this.postInspection(item.body, item.id);
    } catch (err) {
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
