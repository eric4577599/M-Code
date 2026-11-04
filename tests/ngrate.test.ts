import { describe, it, expect } from "vitest";
import {
  computeNgRate, confusionOf, normalizeParams, parseShotJsonl, DEFAULT_NG_RATE_PARAMS, type LabeledShot,
} from "../src/export/ngrate.js";

// 誤判率指標(工單 T-20261026)。DoD 2:標註樣本的算出值與人工計算逐格相符。
const mk = (label: "good" | "bad" | null, pass: boolean | null): LabeledShot => ({ humanLabel: label, result: { pass } });
const rep = (n: number, s: LabeledShot) => Array.from({ length: n }, () => s);

// 人工計算:抓到不良 tp=8,誤殺 fp=2,漏判 fn=1,判對良品 tn=39
//   NG 中良品占比 = 2/(2+8) = 0.2;誤警率 = 2/(2+39) = 2/41;漏判率 = 1/(1+8) = 1/9
const sample = [...rep(8, mk("bad", false)), ...rep(2, mk("good", false)), ...rep(1, mk("bad", true)), ...rep(39, mk("good", true))];

describe("混淆矩陣與三項指標", () => {
  it("逐格與人工計算相符", () => {
    const r = computeNgRate(sample, { minSamples: 1 });
    expect(r.confusion).toEqual({ tp: 8, fp: 2, fn: 1, tn: 39, unjudged: 0, unlabeled: 0 });
    expect(r.falseNgShare.rate).toBeCloseTo(0.2, 12);
    expect(r.falseAlarm.rate).toBeCloseTo(2 / 41, 12);
    expect(r.miss.rate).toBeCloseTo(1 / 9, 12);
    expect([r.falseNgShare.numerator, r.falseNgShare.denominator]).toEqual([2, 10]);
  });
  it("無標註、無法判定的紀錄不進矩陣但分開計數", () => {
    const c = confusionOf([mk(null, false), mk("good", null), mk("bad", true), { }, { humanLabel: "x" as never }]);
    expect(c).toEqual({ tp: 0, fp: 0, fn: 1, tn: 0, unjudged: 1, unlabeled: 3 });
  });
});

describe("樣本不足 → 尚未量測(不得用少量資料宣稱達標)", () => {
  it("預設 minSamples=30,上例各分母都不足", () => {
    const r = computeNgRate(sample);
    expect(r.falseNgShare.verdict).toBe("NOT_MEASURED");
    expect(r.miss.verdict).toBe("NOT_MEASURED");
  });
  it("空輸入:比值為 null,結論尚未量測", () => {
    const r = computeNgRate([]);
    expect(r.falseAlarm.rate).toBeNull();
    expect(r.falseAlarm.verdict).toBe("NOT_MEASURED");
  });
  it("全部都是良品 → 漏判率分母為 0,不得除以零", () => {
    const r = computeNgRate(rep(40, mk("good", true)), { minSamples: 1 });
    expect(r.miss.rate).toBeNull();
    expect(r.falseAlarm.verdict).toBe("ACCEPTABLE");
  });
});

describe("參數化的判準", () => {
  const data = [...rep(3, mk("good", false)), ...rep(97, mk("good", true))]; // 誤警率 3%
  it("預設 5%/10%:3% 可接受", () => {
    expect(computeNgRate(data).falseAlarm.verdict).toBe("ACCEPTABLE");
  });
  it("改參數 1%/2% → 不可接受", () => {
    expect(computeNgRate(data, { falseAlarm: { acceptable: 0.01, marginal: 0.02 } }).falseAlarm.verdict).toBe("UNACCEPTABLE");
  });
  it("邊界:剛好等於上限算在內", () => {
    const d = [...rep(5, mk("good", false)), ...rep(95, mk("good", true))]; // 5%
    expect(computeNgRate(d).falseAlarm.verdict).toBe("ACCEPTABLE");
    const e = [...rep(10, mk("good", false)), ...rep(90, mk("good", true))]; // 10%
    expect(computeNgRate(e).falseAlarm.verdict).toBe("MARGINAL");
  });
  it("壞參數退回預設,不丟例外也不靜默採用", () => {
    for (const bad of [
      { falseAlarm: { acceptable: 0.2, marginal: 0.1 } }, { falseAlarm: { acceptable: NaN, marginal: 0.1 } },
      { falseAlarm: { acceptable: -1, marginal: 2 } }, { minSamples: 0 }, { minSamples: 2.5 }, { minSamples: NaN },
    ]) {
      expect(normalizeParams(bad as never)).toEqual(DEFAULT_NG_RATE_PARAMS);
    }
    expect(normalizeParams(null)).toEqual(DEFAULT_NG_RATE_PARAMS);
  });
});

describe("預設值釘住(改動要有意識)", () => {
  it("minSamples 與三組級距", () => {
    expect(DEFAULT_NG_RATE_PARAMS).toEqual({
      minSamples: 30,
      falseAlarm: { acceptable: 0.05, marginal: 0.1 },
      miss: { acceptable: 0.02, marginal: 0.05 },
      falseNgShare: { acceptable: 0.05, marginal: 0.1 },
    });
  });
});

describe("parseShotJsonl", () => {
  it("只留 shot、壞行略過並計數", () => {
    const text = [
      JSON.stringify({ type: "shot", humanLabel: "good", result: { pass: true } }),
      "{壞掉", JSON.stringify({ type: "error", message: "x" }), "",
      JSON.stringify({ humanLabel: "bad", result: { pass: false } }),
    ].join("\n");
    const r = parseShotJsonl(text);
    expect(r.shots).toHaveLength(2);
    expect(r.badLines).toBe(1);
  });
});
