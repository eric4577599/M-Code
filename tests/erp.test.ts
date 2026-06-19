import { describe, it, expect } from "vitest";
import type { ErpConnection } from "../src/domain/types.js";
import {
  ErpClient,
  ErpHttpError,
  type Transport,
  type TransportResponse,
  type HttpMethod,
  type TransportRequestOptions,
  type QueuedInspection,
  type InspectionPostBody,
} from "../src/erp/client.js";

const conn: ErpConnection = {
  baseUrl: "https://erp.example/",
  clientId: "cid",
  clientSecret: "secret",
};

interface Recorded {
  method: HttpMethod;
  path: string;
  opts?: TransportRequestOptions;
}

/** Programmable fake transport: responses are resolved per (method, path). */
class FakeTransport implements Transport {
  readonly calls: Recorded[] = [];
  constructor(
    private readonly responder: (
      method: HttpMethod,
      path: string,
      opts: TransportRequestOptions | undefined,
      callIndex: number,
    ) => TransportResponse | Promise<TransportResponse>,
  ) {}

  async request(
    method: HttpMethod,
    path: string,
    opts?: TransportRequestOptions,
  ): Promise<TransportResponse> {
    const callIndex = this.calls.length;
    this.calls.push({ method, path, opts });
    return this.responder(method, path, opts, callIndex);
  }
}

function tokenOk(expiresIn = 3600): TransportResponse {
  return { status: 200, body: { access_token: "tok-abc", expires_in: expiresIn } };
}

function makeBody(overrides: Partial<InspectionPostBody> = {}): InspectionPostBody {
  return {
    sessionId: "s1",
    workOrderId: "WO-1",
    processStage: "OUTBOUND",
    symbology: "ITF14",
    decodedData: "104712345678904",
    grade: { overall: "C", score: 1.8, relative: true },
    acceptance: { requiredGrade: "C", pass: true, marginScore: 0.3 },
    diagnosis: [],
    capturedAt: "2026-06-19T08:12:00+08:00",
    imageRef: null,
    ...overrides,
  };
}

describe("getToken (C9.1) — caching with injected clock", () => {
  it("posts client_credentials form and returns the token", async () => {
    let t = 0;
    const fake = new FakeTransport(() => tokenOk());
    const client = new ErpClient(conn, fake, () => t);

    const tok = await client.getToken();
    expect(tok).toBe("tok-abc");

    const call = fake.calls[0];
    expect(call).toBeDefined();
    expect(call?.method).toBe("POST");
    expect(call?.path).toBe("/oauth/token");
    const body = call?.opts?.body ?? "";
    expect(body).toContain("grant_type=client_credentials");
    expect(body).toContain("client_id=cid");
    expect(body).toContain("client_secret=secret");
  });

  it("reuses the cached token before expiry (no refetch)", async () => {
    let t = 0;
    const fake = new FakeTransport(() => tokenOk(3600));
    const client = new ErpClient(conn, fake, () => t);

    await client.getToken();
    t = 1000 * 1000; // ~1000s later, well inside 3600s
    await client.getToken();

    expect(fake.calls.length).toBe(1); // only one /oauth/token request
  });

  it("re-fetches once the token has expired (clock advanced past expiry)", async () => {
    let t = 0;
    const fake = new FakeTransport(() => tokenOk(3600));
    const client = new ErpClient(conn, fake, () => t);

    await client.getToken();
    t = 3600 * 1000; // exactly at nominal expiry → within skew → refresh
    await client.getToken();

    expect(fake.calls.length).toBe(2);
  });

  it("throws ErpHttpError on a non-2xx token response", async () => {
    const fake = new FakeTransport(() => ({ status: 401, body: { error: "bad" } }));
    const client = new ErpClient(conn, fake, () => 0);
    await expect(client.getToken()).rejects.toBeInstanceOf(ErpHttpError);
  });
});

describe("getWorkOrder (C9.2)", () => {
  it("fetches with a Bearer header and returns the parsed work order", async () => {
    const wo = {
      id: "WO-2406A-7741",
      customer: "ACME",
      symbology: "ITF14",
      expectedGtin: "104712345678904",
      acceptance: { requiredGrade: "C", xDimSpecMm: 1.016, quietZoneMinX: 10 },
    };
    const fake = new FakeTransport((method, path) => {
      if (path === "/oauth/token") return tokenOk();
      if (method === "GET" && path.startsWith("/api/v1/workorders/"))
        return { status: 200, body: wo };
      return { status: 404, body: {} };
    });
    const client = new ErpClient(conn, fake, () => 0);

    const result = await client.getWorkOrder("WO-2406A-7741");
    expect(result.acceptance.requiredGrade).toBe("C");

    const getCall = fake.calls.find((c) => c.method === "GET");
    expect(getCall?.path).toBe("/api/v1/workorders/WO-2406A-7741");
    expect(getCall?.opts?.headers?.["Authorization"]).toBe("Bearer tok-abc");
  });

  it("throws ErpHttpError on a 4xx work order response", async () => {
    const fake = new FakeTransport((_m, path) =>
      path === "/oauth/token" ? tokenOk() : { status: 404, body: {} },
    );
    const client = new ErpClient(conn, fake, () => 0);
    await expect(client.getWorkOrder("nope")).rejects.toBeInstanceOf(ErpHttpError);
  });
});

describe("postInspection (C9.3) — idempotency key passed through", () => {
  it("sends Bearer + Idempotency-Key headers", async () => {
    const fake = new FakeTransport((_m, path) =>
      path === "/oauth/token"
        ? tokenOk()
        : { status: 201, body: { inspectionId: "INSP-1" } },
    );
    const client = new ErpClient(conn, fake, () => 0);

    await client.postInspection(makeBody(), "idem-key-123");
    const postCall = fake.calls.find((c) => c.path === "/api/v1/inspections");
    expect(postCall?.opts?.headers?.["Authorization"]).toBe("Bearer tok-abc");
    expect(postCall?.opts?.headers?.["Idempotency-Key"]).toBe("idem-key-123");
  });
});

describe("processQueue (C9.5) — transitions + idempotency", () => {
  const items: QueuedInspection[] = [
    { id: "q-2xx", body: makeBody({ sessionId: "a" }) },
    { id: "q-4xx", body: makeBody({ sessionId: "b" }) },
    { id: "q-5xx", body: makeBody({ sessionId: "c" }) },
    { id: "q-timeout", body: makeBody({ sessionId: "d" }) },
  ];

  function responder(
    _m: HttpMethod,
    path: string,
    opts: TransportRequestOptions | undefined,
  ): TransportResponse {
    if (path === "/oauth/token") return tokenOk();
    const key = opts?.headers?.["Idempotency-Key"];
    switch (key) {
      case "q-2xx":
        return { status: 201, body: { inspectionId: "INSP-88231" } };
      case "q-4xx":
        return { status: 422, body: { error: "validation" } };
      case "q-5xx":
        return { status: 503, body: {} };
      case "q-timeout":
        throw new Error("network timeout");
      default:
        return { status: 500, body: {} };
    }
  }

  it("maps 2xx→SYNCED, 4xx→FAILED, 5xx→QUEUED, timeout→QUEUED", async () => {
    const fake = new FakeTransport(responder);
    const client = new ErpClient(conn, fake, () => 0);

    const results = await client.processQueue(items);
    const byId = new Map(results.map((r) => [r.id, r]));

    expect(byId.get("q-2xx")?.outcome).toBe("SYNCED");
    expect(byId.get("q-2xx")?.inspectionId).toBe("INSP-88231");

    expect(byId.get("q-4xx")?.outcome).toBe("FAILED");
    expect(byId.get("q-4xx")?.reason).toContain("422");

    expect(byId.get("q-5xx")?.outcome).toBe("QUEUED");
    expect(byId.get("q-5xx")?.reason).toContain("503");

    expect(byId.get("q-timeout")?.outcome).toBe("QUEUED");
    expect(byId.get("q-timeout")?.reason).toContain("timeout");
  });

  it("sends each item's id as the Idempotency-Key (no duplicate creation)", async () => {
    const fake = new FakeTransport(responder);
    const client = new ErpClient(conn, fake, () => 0);

    await client.processQueue(items);

    const postKeys = fake.calls
      .filter((c) => c.path === "/api/v1/inspections")
      .map((c) => c.opts?.headers?.["Idempotency-Key"]);
    expect(postKeys).toEqual(["q-2xx", "q-4xx", "q-5xx", "q-timeout"]);
  });
});
