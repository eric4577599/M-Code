// A-11 稽核補強測試(spec20260911-src-audit-v1 §4)。純測試,不動 demo/imgproc.js。
// SCANLINE_SPREAD_HINT 是稽核 A-06(結果頁可同時顯示 F 級與全 A 參數)唯一的緩解機制,
// 原本 241 支 imgproc 測試裡一次都沒被提及 —— 這裡把它的值與邊界行為全部釘死。
// @ts-expect-error — 純 JS 模組,無型別宣告
import { explainGrade, SCANLINE_SPREAD_HINT } from "../demo/imgproc.js";
import { describe, it, expect } from "vitest";

/** 造一個參數項,沿用 imgproc.test.ts 的 P() 慣例。 */
const P = (code: string, score: number, letter = "B") =>
  ({ code, letter, score, label: code, kind: "PHOTOMETRIC" });

/** 以指定的逐條分數呼叫 explainGrade(1D 路徑),參數組固定,便於比對評級不受影響。 */
function explain(scanlineScores: unknown[]) {
  return explainGrade({
    is2D: false,
    overallScore: 2,
    parameters: [P("SC", 2), P("DEC", 1.5)],
    scanlineScores,
    scanlineLimiters: scanlineScores.map(() => "DEC"),
  });
}

describe("A-11 — SCANLINE_SPREAD_HINT 與 spreadHint 行為", () => {
  it("AC-11-1:常數值為 1.0(任何人改動它都會紅)", () => {
    expect(SCANLINE_SPREAD_HINT).toBe(1.0);
  });

  it("AC-11-2:spread 剛好等於門檻 → 不觸發(嚴格大於)", () => {
    const r = explain([2.0, 3.0]);
    expect(r.spread).toBeCloseTo(1.0, 10);
    expect(r.spreadHint).toBe("");
  });

  it("AC-11-3:spread 略高於門檻 → 提示為非空字串", () => {
    const r = explain([2.0, 3.01]);
    expect(r.spread).toBeGreaterThan(SCANLINE_SPREAD_HINT);
    expect(typeof r.spreadHint).toBe("string");
    expect(r.spreadHint.length).toBeGreaterThan(0);
  });

  it("AC-11-4:spread 略低於門檻 → 不觸發", () => {
    const r = explain([2.0, 2.99]);
    expect(r.spread).toBeLessThan(SCANLINE_SPREAD_HINT);
    expect(r.spreadHint).toBe("");
  });

  it("AC-11-5:有效分數不足 2 筆時 spread 為 null、提示為空、不擲錯", () => {
    for (const scores of [[], [2.0]]) {
      const r = explain(scores);
      expect(r.spread).toBe(null);
      expect(r.spreadHint).toBe("");
    }
    // 完全未提供 scanlineScores 也一樣
    const r = explainGrade({ is2D: false, parameters: [P("SC", 2)] });
    expect(r.spread).toBe(null);
    expect(r.spreadHint).toBe("");
  });

  it("AC-11-6:NaN / Infinity / 非數字項先被濾除再算 spread", () => {
    // 濾除後剩 [2.0, 3.5] → spread 1.5 > 門檻
    const r = explain([2.0, NaN, Infinity, -Infinity, "3", null, undefined, 3.5]);
    expect(r.spread).toBeCloseTo(1.5, 10);
    expect(r.spreadHint.length).toBeGreaterThan(0);
    // 濾除後不足 2 筆 → null
    const few = explain([NaN, Infinity, "2.0", 2.0]);
    expect(few.spread).toBe(null);
    expect(few.spreadHint).toBe("");
  });

  it("AC-11-7:提示措辭指向「重拍」,不得怪罪印刷", () => {
    const r = explain([1.0, 3.5]);
    expect(r.spreadHint).toContain("重拍");
    for (const bad of ["印壞", "印刷不均", "不合格"]) {
      expect(r.spreadHint).not.toContain(bad);
    }
  });

  it("AC-11-8:spreadHint 觸發與否不改變 limiting 與 rule(不參與評級)", () => {
    const quiet = explain([2.0, 2.1]);
    const loud = explain([1.0, 3.5]);
    expect(quiet.spreadHint).toBe("");
    expect(loud.spreadHint.length).toBeGreaterThan(0);
    expect(loud.rule).toBe(quiet.rule);
    expect(loud.limiting).toEqual(quiet.limiting);
  });

  it("AC-11-9:lines 等於有效分數筆數", () => {
    expect(explain([2.0, 2.5, 3.0]).lines).toBe(3);
    expect(explain([2.0, NaN, "x", 3.0]).lines).toBe(2);
    expect(explain([]).lines).toBe(0);
  });
});
