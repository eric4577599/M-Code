import { describe, it, expect } from "vitest";
import {
  SHOT_LOG_MAX, ERROR_LOG_MAX, STACK_MAX_BYTES, TRUNCATED_MARK,
  buildShotRecord, buildErrorRecord, truncateStack, appendWithCap, withHumanLabel,
  toJSONL, makeSessionId, finiteOrNull, cleanString, scrub,
} from "../src/export/shotlog.js";
import * as api from "../src/index.js";

// 拍照條件 log / 錯誤檔(測試方案 docs/testplan20261104-1.md 目標 C)。
// 全部是純函式,不碰 DOM / IndexedDB;真實儲存與失效注入在瀏覽器端驗(T2-C11 ~ C16)。

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const full = {
  ts: new Date(NOW), build: "77e6f7a2", sessionId: "abc123def456", seq: 3,
  device: { userAgent: "iPhone", facing: "environment", devicePixelRatio: 3, orientation: "portrait" },
  camera: { path: "L3", requested: "未請求", granted: "1920×1080", analysisWidth: 1920, frameSource: "preview" },
  timing: { shutterDelayMs: 44, settleFrames: 1, focusRelativePct: 97.5, candidates: [{ i: 0, v: 210 }] },
  gate: [{ key: "focus", status: "OK", value: 210 }, { key: "glare", status: "WARN", value: 0.02 }],
  geometry: { symbology: "ITF14", pxPerModule: 9.2, tiltDeg: 2.1, tiltSource: "homography", rectified: true },
  result: {
    overall: "B", overallScore: 2.9, measurable: true, unmeasReason: "", pass: true, requiredGrade: "C",
    parameters: [{ code: "SC", letter: "A", score: 3.9 }, { code: "DEC", letter: "B", score: 2.9 }],
  },
};

describe("T1-C1 純函式可在 Node 載入並從公開入口匯出", () => {
  it("src/index.ts 匯出 shotlog 的公開 API", () => {
    for (const k of ["buildShotRecord", "buildErrorRecord", "toJSONL", "appendWithCap",
      "withHumanLabel", "truncateStack", "makeSessionId"]) {
      expect(typeof (api as Record<string, unknown>)[k], k).toBe("function");
    }
  });
});

describe("T2-C1 buildShotRecord 正常路徑", () => {
  const r = buildShotRecord(full, NOW);
  it("設計 §5.3 的群組欄位齊全", () => {
    for (const k of ["id", "ts", "build", "sessionId", "device", "camera", "timing",
      "gate", "geometry", "result", "humanLabel"]) expect(r).toHaveProperty(k);
  });
  it("ts 為 ISO 8601;build 與 sessionId 原樣", () => {
    expect(r.ts).toBe("2026-11-04T12:00:00.000Z");
    expect(r.build).toBe("77e6f7a2");
    expect(r.sessionId).toBe("abc123def456");
    expect(r.id).toBe("abc123def456-s3");
  });
  it("數值與閘門原樣保留", () => {
    expect(r.camera.granted).toBe("1920×1080");
    expect(r.timing.shutterDelayMs).toBe(44);
    expect(r.gate).toEqual([
      { key: "focus", status: "OK", value: 210 },
      { key: "glare", status: "WARN", value: 0.02 },
    ]);
    expect(r.result.parameters).toHaveLength(2);
    expect(r.humanLabel).toBeNull();
  });
});

describe("T2-C2 buildErrorRecord 正常路徑", () => {
  it("含 kind / message / stack / where / lastShotId", () => {
    const e = buildErrorRecord({ ts: NOW, build: "b", sessionId: "s", seq: 1, kind: "camera",
      message: new Error("boom"), stack: "at x", where: "initCamera", lastShotId: "s-s3" }, NOW);
    expect(e).toMatchObject({ kind: "camera", message: "boom", stack: "at x", stackTruncated: false,
      where: "initCamera", lastShotId: "s-s3", id: "s-e1" });
  });
  it("kind 不合法 → 退回 error", () => {
    expect(buildErrorRecord({ kind: "weird" as never }, NOW).kind).toBe("error");
  });
  it("message 不是字串也不是 Error 時不丟例外", () => {
    expect(() => buildErrorRecord({ message: undefined }, NOW)).not.toThrow();
    expect(buildErrorRecord({ message: { message: "x" } }, NOW).message).toBe("x");
    // Symbol 也不丟例外;String(Symbol("s")) 本來就是 "Symbol(s)",這比空字串更有線索
    expect(buildErrorRecord({ message: Symbol("s") }, NOW).message).toBe("Symbol(s)");
  });
});

describe("T2-C3 stack 截斷", () => {
  it("超過 4 KB 截在上限內並標示", () => {
    const { text, truncated } = truncateStack("a".repeat(10_000));
    expect(truncated).toBe(true);
    expect(text.endsWith(TRUNCATED_MARK)).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(STACK_MAX_BYTES);
  });
  it("剛好等於上限不截", () => {
    const s = "a".repeat(STACK_MAX_BYTES);
    expect(truncateStack(s)).toEqual({ text: s, truncated: false });
  });
  it("多位元組字元不被切一半", () => {
    const { text } = truncateStack("錯".repeat(5000));
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(STACK_MAX_BYTES);
    expect(text).not.toContain("�");
  });
  it("buildErrorRecord 套用截斷並設旗標", () => {
    const e = buildErrorRecord({ stack: "x".repeat(10_000) }, NOW);
    expect(e.stackTruncated).toBe(true);
    expect(new TextEncoder().encode(e.stack).length).toBeLessThanOrEqual(STACK_MAX_BYTES);
  });
});

describe("T2-C4 上限淘汰", () => {
  it("第 501 筆 shot:淘汰最舊、筆數維持上限、最新在尾端", () => {
    let list: number[] = []; const evictedAll: number[] = [];
    for (let i = 1; i <= SHOT_LOG_MAX + 1; i++) {
      const r = appendWithCap(list, i, SHOT_LOG_MAX); list = r.list; evictedAll.push(...r.evicted);
    }
    expect(list).toHaveLength(SHOT_LOG_MAX);
    expect(list[0]).toBe(2); expect(list.at(-1)).toBe(SHOT_LOG_MAX + 1);
    expect(evictedAll).toEqual([1]);
  });
  it("第 201 筆 error 同理", () => {
    let list: number[] = [];
    for (let i = 1; i <= ERROR_LOG_MAX + 1; i++) list = appendWithCap(list, i, ERROR_LOG_MAX).list;
    expect(list).toHaveLength(ERROR_LOG_MAX); expect(list[0]).toBe(2);
  });
  it("不修改輸入陣列;上限壞值退回 1", () => {
    const a = [1, 2]; appendWithCap(a, 3, 2); expect(a).toEqual([1, 2]);
    expect(appendWithCap([1, 2], 3, NaN).list).toEqual([3]);
  });
});

describe("T2-C5 / C6 匯出", () => {
  it("空 log → 空字串,不丟例外", () => {
    expect(toJSONL([])).toBe("");
  });
  it("每行可獨立 JSON.parse;含換行、引號、反斜線的 message 不破壞行格式", () => {
    const recs = [
      buildShotRecord(full, NOW),
      buildErrorRecord({ message: 'a\nb "q" \\ c\r\n d', sessionId: "s", seq: 1 }, NOW),
    ];
    const lines = toJSONL(recs).split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[1].message).toBe('a\nb "q" \\ c\r\n d');
  });
});

describe("T2-C7 不收錄影像", () => {
  it("data: URI 在任何欄位都被剔除", () => {
    const img = "data:image/jpeg;base64," + "A".repeat(5000);
    const r = buildShotRecord({
      ...full, camera: { ...full.camera, granted: img },
      timing: { ...full.timing, candidates: [{ thumb: img, ok: 1 }] },
      result: { ...full.result, unmeasReason: "  " + img },
    }, NOW);
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/data:/i);
    expect(s).not.toContain("base64");
    expect(s.length).toBeLessThan(3000);
  });
});

describe("T2-C8 不含帳號(白名單組裝)", () => {
  it("輸入多帶 user / account / img / token 欄位都不會進 record", () => {
    const dirty = { ...full, user: "admin", account: "admin", token: "T0K", img: "x", password: "admin" };
    const s = JSON.stringify(buildShotRecord(dirty as never, NOW));
    for (const leak of ["admin", "T0K", "password", "account"]) expect(s).not.toContain(leak);
  });
  it("巢狀欄位同樣只收白名單", () => {
    const dirty = { ...full, device: { ...full.device, owner: "eric@example.com" } };
    expect(JSON.stringify(buildShotRecord(dirty as never, NOW))).not.toContain("eric@example.com");
  });
});

describe("T2-C9 sessionId", () => {
  const seeded = (seed: number) => () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  it("同一個亂數源重複取同一個 session 內固定;不同亂數源不同", () => {
    const a = makeSessionId(seeded(1)); const b = makeSessionId(seeded(2));
    expect(a).toHaveLength(12); expect(a).toMatch(/^[0-9a-z]{12}$/);
    expect(a).not.toBe(b);
  });
  it("record 的 id 以 sessionId 為前綴,不含時間或帳號", () => {
    const r = buildShotRecord({ sessionId: "zzz", seq: 7 }, NOW);
    expect(r.id).toBe("zzz-s7");
  });
});

describe("T2-C10 量測值不可得 → 明確的 null,不洩漏 NaN / Infinity / -1", () => {
  it("NaN / Infinity / undefined / 字串數字都變 null", () => {
    expect(finiteOrNull(NaN)).toBeNull();
    expect(finiteOrNull(Infinity)).toBeNull();
    expect(finiteOrNull(undefined)).toBeNull();
    expect(finiteOrNull("5")).toBeNull();
    expect(finiteOrNull(0)).toBe(0); // 0 是合法讀數,不能被當成不可得
  });
  it("整筆 record 序列化後沒有 NaN / Infinity 字樣,且不可得的欄位是 null", () => {
    const r = buildShotRecord({
      ...full,
      timing: { shutterDelayMs: NaN, settleFrames: Infinity, focusRelativePct: undefined as never, candidates: [NaN, Infinity] },
      gate: [{ key: "focus", status: "FAIL", value: NaN }],
      geometry: { ...full.geometry, pxPerModule: undefined as never, tiltDeg: -Infinity },
      result: { ...full.result, overallScore: NaN, parameters: [{ code: "SC", letter: "F", score: NaN }] },
    }, NOW);
    const s = JSON.stringify(r);
    expect(s).not.toMatch(/NaN|Infinity/);
    expect(r.timing.shutterDelayMs).toBeNull();
    expect(r.gate[0]!.value).toBeNull();
    expect(r.geometry.pxPerModule).toBeNull();
    expect(r.result.parameters[0]!.score).toBeNull();
    expect(r.timing.candidates).toEqual([null, null]);
  });
  it("輸入全空也能組出完整形狀的 record,不丟例外", () => {
    const r = buildShotRecord({}, NOW);
    expect(r.gate).toEqual([]); expect(r.result.parameters).toEqual([]);
    expect(r.humanLabel).toBeNull(); expect(r.result.pass).toBeNull();
  });
  it("ts 無效時退回注入的現在時間,不丟 RangeError", () => {
    expect(buildShotRecord({ ts: NaN }, NOW).ts).toBe("2026-11-04T12:00:00.000Z");
    expect(buildShotRecord({ ts: new Date("x") }, NOW).ts).toBe("2026-11-04T12:00:00.000Z");
  });
});

describe("人工標註(誤判率的原料)", () => {
  const a = buildShotRecord({ ...full, seq: 1 }, NOW);
  const b = buildShotRecord({ ...full, seq: 2 }, NOW);
  it("只改指定 id,不修改輸入", () => {
    const out = withHumanLabel([a, b], b.id, "bad");
    expect(out.map((r) => r.humanLabel)).toEqual([null, "bad"]);
    expect(a.humanLabel).toBeNull();
  });
  it("找不到 id 原樣;壞標註值視為清除", () => {
    expect(withHumanLabel([a], "nope", "good")).toEqual([a]);
    const labelled = withHumanLabel([a], a.id, "good");
    expect(withHumanLabel(labelled, a.id, "maybe" as never)[0]!.humanLabel).toBeNull();
  });
  it("輸入的 humanLabel 只認 good / bad", () => {
    expect(buildShotRecord({ humanLabel: "good" }, NOW).humanLabel).toBe("good");
    expect(buildShotRecord({ humanLabel: "x" as never }, NOW).humanLabel).toBeNull();
  });
});

describe("基本清理工具", () => {
  it("cleanString:非字串 → 空;data: 開頭(含前導空白與大小寫)→ 空", () => {
    expect(cleanString(5)).toBe(""); expect(cleanString("  DATA:x")).toBe(""); expect(cleanString("ok")).toBe("ok");
  });
  it("scrub:深度上限避免循環結構", () => {
    const o: Record<string, unknown> = {}; o.self = o;
    expect(() => JSON.stringify(scrub(o))).not.toThrow();
  });
});
