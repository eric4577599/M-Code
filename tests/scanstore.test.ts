import { describe, it, expect } from "vitest";
// @ts-expect-error — 純 JS 模組,無型別宣告
import { serializeScans, restoreScans, persistScans, SCAN_STORE_KEY } from "../demo/imgproc.js";

// 造一筆像 saveScan 產出的紀錄(含 Date、巢狀物件、縮圖)
const mk = (n: number) => ({
  n, ts: new Date(2026, 10, 5, 8, 0, n), symbology: "ITF14", data: "1234",
  grade: "B", pass: true, margin: 0.4, img: { type: "img", data: "data:image/jpeg;base64,AAAA" },
  shot: { path: "L3", settings: { width: 1920 } }, params: [{ code: "DEC", score: 3.2 }],
});
const header = { customer: "ACME", product: "P", workorder: "WO-1", expectedGtin: "" };
const fakeStorage = (limit = Infinity) => {
  const m = new Map<string, string>();
  return {
    m,
    setItem(k: string, v: string) { if (v.length > limit) throw new Error("QuotaExceeded"); m.set(k, v); },
    getItem: (k: string) => m.get(k) ?? null,
  };
};

describe("掃描清單持久化(稽核 C)", () => {
  it("來回一趟:ts 還原成 Date、n/結論/巢狀欄位逐項相等", () => {
    const src = [mk(1), mk(2)];
    const raw = JSON.stringify(serializeScans("admin", src, header));
    const r = restoreScans(raw, "admin");
    expect(r).not.toBeNull();
    expect(r!.scans).toEqual(src);
    expect(r!.scans[0].ts instanceof Date).toBe(true);
    expect(r!.header).toEqual(header);
  });

  it("擁有者不同 → null(A-12:B 不可讀到 A 的清單)", () => {
    const raw = JSON.stringify(serializeScans("admin", [mk(1)], header));
    expect(restoreScans(raw, "demo")).toBeNull();
  });

  it("無資料 / 壞 JSON / 版本不符 / 結構錯 / 壞 ts → 一律 null,不拋例外", () => {
    expect(restoreScans(null, "admin")).toBeNull();
    expect(restoreScans("", "admin")).toBeNull();
    expect(restoreScans("{壞", "admin")).toBeNull();
    expect(restoreScans(JSON.stringify({ v: 99, user: "admin", scans: [] }), "admin")).toBeNull();
    expect(restoreScans(JSON.stringify({ v: 1, user: "admin", scans: "x" }), "admin")).toBeNull();
    expect(restoreScans(JSON.stringify({ v: 1, user: "admin", scans: [null] }), "admin")).toBeNull();
    expect(restoreScans(JSON.stringify({ v: 1, user: "admin", scans: [{ ts: "不是日期" }] }), "admin")).toBeNull();
  });

  it("空清單也能來回(clearList 後存的就是空陣列,不是殘留舊資料)", () => {
    const raw = JSON.stringify(serializeScans("admin", [], header));
    expect(restoreScans(raw, "admin")!.scans).toEqual([]);
  });

  it("persistScans 正常寫入 → ok、未丟縮圖", () => {
    const st = fakeStorage();
    expect(persistScans(st, "admin", [mk(1)], header)).toEqual({ ok: true, dropped: false });
    expect(restoreScans(st.m.get(SCAN_STORE_KEY)!, "admin")!.scans[0].img.data).toContain("base64");
  });

  it("配額不足 → 丟縮圖重試,結論欄位保留,並回報 dropped(不得靜默)", () => {
    const big = { ...mk(1), img: { type: "img", data: "x".repeat(5000) } };
    const st = fakeStorage(2000);
    const r = persistScans(st, "admin", [big], header);
    expect(r).toEqual({ ok: true, dropped: true });
    const back = restoreScans(st.m.get(SCAN_STORE_KEY)!, "admin")!;
    expect(back.scans[0].grade).toBe("B");
    expect(back.scans[0].img.data).toBe("");
  });

  it("連瘦身版都寫不進 → ok=false;storage 丟例外也不外洩", () => {
    const st = fakeStorage(10);
    expect(persistScans(st, "admin", [mk(1)], header)).toEqual({ ok: false, dropped: true });
  });
});
