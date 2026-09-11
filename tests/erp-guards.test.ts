// A-07 / A-09 稽核補強測試(spec20260911-src-audit-v1 §1、§2)。
// 守的是兩件事:
//   A-07 — getWorkOrder 不再裸 cast,壞掉的 requiredGrade 不可能流到 evaluateAcceptance;
//   A-09 — token 端點「200 + 格式錯」是永久性設定錯誤,必須收斂成 FAILED 而非無限重送。
import { describe, it, expect } from "vitest";
import type { ErpConnection, GradeResult, AcceptancePolicy } from "../src/domain/types.js";
import {
  ErpClient,
  ErpHttpError,
  ErpMalformedResponseError,
  isWorkOrder,
  type Transport,
  type TransportResponse,
  type HttpMethod,
  type TransportRequestOptions,
  type QueuedInspection,
  type InspectionPostBody,
} from "../src/erp/client.js";
import { evaluateAcceptance } from "../src/engines/acceptance.js";
import { LETTER_NOMINAL_SCORE } from "../src/domain/scale.js";

const conn: ErpConnection = {
  baseUrl: "https://erp.example/",
  clientId: "cid",
  clientSecret: "secret",
};

/** 可程式化的假 Transport:依 (method, path) 決定回應,沿用 erp.test.ts 的慣例。 */
class FakeTransport implements Transport {
  readonly calls: Array<{ method: HttpMethod; path: string }> = [];
  constructor(
    private readonly responder: (
      method: HttpMethod,
      path: string,
    ) => TransportResponse | Promise<TransportResponse>,
  ) {}
  async request(
    method: HttpMethod,
    path: string,
    _opts?: TransportRequestOptions,
  ): Promise<TransportResponse> {
    this.calls.push({ method, path });
    return this.responder(method, path);
  }
}

const tokenOk: TransportResponse = {
  status: 200,
  body: { access_token: "tok-abc", expires_in: 3600 },
};

/** 以指定的 work order body 建一個 client,token 端點固定正常。 */
function clientWithWorkOrderBody(body: unknown, status = 200): ErpClient {
  const fake = new FakeTransport((method, path) =>
    path === "/oauth/token" ? tokenOk : { status, body },
  );
  return new ErpClient(conn, fake, () => 0);
}

const validWo = {
  id: "WO-42",
  customer: "ACME",
  symbology: "ITF14",
  expectedGtin: "10012345678902",
  acceptance: { requiredGrade: "C", xDimSpecMm: 1.0, quietZoneMinX: 10 },
};

describe("A-07 — isWorkOrder 型別守衛", () => {
  it("AC-07-1:合法 body 原樣回傳,與 body 深度相等", async () => {
    const client = clientWithWorkOrderBody(validWo);
    await expect(client.getWorkOrder("WO-42")).resolves.toEqual(validWo);
    expect(isWorkOrder(validWo)).toBe(true);
  });

  it("AC-07-2:requiredGrade 為 'c'/'B+'/null/undefined/2 時一律擲 ErpHttpError", async () => {
    for (const bad of ["c", "B+", null, undefined, 2]) {
      const body = { ...validWo, acceptance: { ...validWo.acceptance, requiredGrade: bad } };
      expect(isWorkOrder(body)).toBe(false);
      const client = clientWithWorkOrderBody(body);
      await expect(client.getWorkOrder("WO-42")).rejects.toBeInstanceOf(ErpHttpError);
    }
  });

  it("AC-07-4:結構或數值欄位壞掉時一律擲 ErpHttpError", async () => {
    const bodies: unknown[] = [
      { ...validWo, acceptance: undefined },
      { ...validWo, acceptance: null },
      { ...validWo, acceptance: { ...validWo.acceptance, xDimSpecMm: NaN } },
      { ...validWo, acceptance: { ...validWo.acceptance, xDimSpecMm: "1.0" } },
      { ...validWo, acceptance: { ...validWo.acceptance, quietZoneMinX: Infinity } },
      { ...validWo, id: 42 },
      { ...validWo, customer: null },
      { ...validWo, symbology: "ITF-14" },
      { ...validWo, expectedGtin: 123 },
    ];
    for (const body of bodies) {
      expect(isWorkOrder(body)).toBe(false);
      const client = clientWithWorkOrderBody(body);
      await expect(client.getWorkOrder("WO-42")).rejects.toBeInstanceOf(ErpHttpError);
    }
  });

  it("AC-07-5:expectedGtin 缺席仍通過守衛(選填欄位不得被誤判)", async () => {
    const { expectedGtin: _omit, ...noGtin } = validWo;
    expect(isWorkOrder(noGtin)).toBe(true);
    const client = clientWithWorkOrderBody(noGtin);
    await expect(client.getWorkOrder("WO-42")).resolves.toEqual(noGtin);
  });

  it("AC-07-6:body 為 null / 字串 / 陣列時擲 ErpHttpError,不是 TypeError", async () => {
    for (const body of [null, "<html></html>", [validWo]]) {
      expect(isWorkOrder(body)).toBe(false);
      const client = clientWithWorkOrderBody(body);
      const err = await client.getWorkOrder("WO-42").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ErpHttpError);
      expect(err).not.toBeInstanceOf(TypeError);
    }
  });

  it("非 2xx 的既有路徑不變:先檢查狀態碼、再檢查格式", async () => {
    const client = clientWithWorkOrderBody(validWo, 404);
    const err = await client.getWorkOrder("WO-42").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpHttpError);
    expect((err as ErpHttpError).status).toBe(404);
  });

  it("AC-07-3:重演稽核情境 —— margin ≥ 0 ⟺ pass,且壞字母根本到不了 evaluateAcceptance", async () => {
    // overallScore 3.60 = 稽核報告裡出現「pass=false 配 margin=+3.60」的那個數字
    const grade: GradeResult = {
      overall: "A",
      overallScore: 3.6,
      isRelative: true,
      parameters: [],
    };
    // 凡是能通過守衛的 requiredGrade,不變量都成立
    for (const letter of Object.keys(LETTER_NOMINAL_SCORE)) {
      const body = { ...validWo, acceptance: { ...validWo.acceptance, requiredGrade: letter } };
      expect(isWorkOrder(body)).toBe(true);
      const wo = await clientWithWorkOrderBody(body).getWorkOrder("WO-42");
      const policy: AcceptancePolicy = {
        id: "pol-1",
        requiredGrade: wo.acceptance.requiredGrade,
        xDimSpecMm: wo.acceptance.xDimSpecMm,
        quietZoneMinX: wo.acceptance.quietZoneMinX,
      };
      const ev = evaluateAcceptance(grade, policy);
      expect(ev.marginScore >= 0).toBe(ev.pass);
    }
    // 而 'c' / 'B+' / null 這三種 body 在新行為下先被擋掉,evaluateAcceptance 拿不到
    for (const bad of ["c", "B+", null]) {
      const body = { ...validWo, acceptance: { ...validWo.acceptance, requiredGrade: bad } };
      await expect(clientWithWorkOrderBody(body).getWorkOrder("WO-42")).rejects.toBeInstanceOf(
        ErpHttpError,
      );
    }
  });
});

// ── A-09 ─────────────────────────────────────────────────────────────────────
function makeBody(id: string): InspectionPostBody {
  return {
    sessionId: id,
    workOrderId: "WO-1",
    processStage: "OUTBOUND",
    symbology: "ITF14",
    decodedData: "14712345678907",
    grade: { overall: "C", score: 1.8, relative: true },
    acceptance: { requiredGrade: "C", pass: true, marginScore: 0.3 },
    diagnosis: [],
    capturedAt: "2026-06-19T08:12:00+08:00",
    imageRef: null,
  };
}
const queue: QueuedInspection[] = [
  { id: "insp-1", body: makeBody("insp-1") },
  { id: "insp-2", body: makeBody("insp-2") },
];

/**
 * 造一個 token 端點回指定回應、inspection 端點固定 200 的 client。
 * 輸入:token 回應(或 "reject" 代表 Transport 直接拋);輸出:ErpClient。
 */
function clientWithTokenResponse(token: TransportResponse | "reject"): ErpClient {
  const fake: Transport = {
    async request(_m: HttpMethod, path: string): Promise<TransportResponse> {
      if (path === "/oauth/token") {
        if (token === "reject") throw new Error("network timeout");
        return token;
      }
      return { status: 200, body: { inspectionId: "srv-1" } };
    },
  };
  return new ErpClient(conn, fake, () => 0);
}

describe("A-09 — token 端點 200 + 格式錯收斂成 FAILED", () => {
  it("AC-09-1:重演稽核情境 —— 200 + 一頁 HTML,兩筆皆 FAILED(舊行為是 QUEUED)", async () => {
    const client = clientWithTokenResponse({ status: 200, body: "<html>502 Bad Gateway</html>" });
    const out = await client.processQueue(queue);
    expect(out.map((r) => r.outcome)).toEqual(["FAILED", "FAILED"]);
    for (const r of out) expect(r.reason).toContain("malformed");
  });

  it("AC-09-2:200 但 body 為 {} / null / access_token 非字串 / 缺 expires_in → FAILED", async () => {
    const bads: unknown[] = [{}, null, { access_token: 123 }, { access_token: "x" }];
    for (const body of bads) {
      const out = await clientWithTokenResponse({ status: 200, body }).processQueue(queue);
      expect(out.map((r) => r.outcome)).toEqual(["FAILED", "FAILED"]);
    }
  });

  it("AC-09-3:token 端點回 500 → 兩筆皆 QUEUED(不得被新分類誤吃)", async () => {
    const out = await clientWithTokenResponse({ status: 500, body: "<html>oops</html>" })
      .processQueue(queue);
    expect(out.map((r) => r.outcome)).toEqual(["QUEUED", "QUEUED"]);
  });

  it("AC-09-4:token 端點 Transport 直接 reject(timeout)→ QUEUED", async () => {
    const out = await clientWithTokenResponse("reject").processQueue(queue);
    expect(out.map((r) => r.outcome)).toEqual(["QUEUED", "QUEUED"]);
    expect(out[0]?.reason).toBe("network timeout");
  });

  it("AC-09-5:token 端點回 400 → FAILED(既有行為不變)", async () => {
    const out = await clientWithTokenResponse({ status: 400, body: { error: "bad_client" } })
      .processQueue(queue);
    expect(out.map((r) => r.outcome)).toEqual(["FAILED", "FAILED"]);
  });

  it("AC-09-6:getToken 單獨呼叫時擲的錯誤仍 instanceof ErpHttpError,且可辨識為 malformed", async () => {
    const client = clientWithTokenResponse({ status: 200, body: "<html></html>" });
    const err = await client.getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ErpHttpError);
    expect(err).toBeInstanceOf(ErpMalformedResponseError);
    expect((err as ErpMalformedResponseError).name).toBe("ErpMalformedResponseError");
    expect((err as ErpMalformedResponseError).status).toBe(200);
    expect((err as ErpMalformedResponseError).body).toBe("<html></html>");
  });

  it("AC-09-7:inspection 端點 200 但缺 inspectionId → 仍 SYNCED,inspectionId 為 undefined", async () => {
    const fake: Transport = {
      async request(_m: HttpMethod, path: string): Promise<TransportResponse> {
        return path === "/oauth/token" ? tokenOk : { status: 200, body: { ok: true } };
      },
    };
    const out = await new ErpClient(conn, fake, () => 0).processQueue(queue);
    expect(out.map((r) => r.outcome)).toEqual(["SYNCED", "SYNCED"]);
    expect(out[0]?.inspectionId).toBeUndefined();
  });
});
