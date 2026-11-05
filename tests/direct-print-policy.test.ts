import { describe, it, expect } from "vitest";
import {
  SEED_ACCEPTANCE_POLICIES, plateDirectPrintPolicy, GS1_ITF14_PLATE_DIRECT_X_MIN_MM,
  GS1_BEARER_BAR_PLATE_MM, GS1_BEARER_BAR_PLATELESS_MIN_X,
} from "../src/data/policies.js";
import { checkDirectPrintXDim, evaluateAcceptance } from "../src/engines/acceptance.js";
import { buildGradeResult } from "../src/engines/grade.js";
import type { AcceptancePolicy } from "../src/domain/types.js";

// 直印瓦楞 policy 欄位(測試方案 docs/testplan20261104-1.md 目標 B:T2-B1 ~ T2-B7)。
//
// 這些欄位 2026-11-04 經 Eric 同意新增(動到規格 §6.1 的欄位,**不動既有門檻**)。
// 護欄重點有二:欄位未填時行為與先前完全相同;欄位**數值**在取得 GS1 原文前不得填入。

const base: AcceptancePolicy = {
  id: "t", symbology: "ITF14", requiredGrade: "C", xDimSpecMm: 1.016, quietZoneMinX: 10,
};
const direct = (over: Partial<AcceptancePolicy> = {}): AcceptancePolicy => ({
  ...base, substrate: "corrugated-direct", directPrintXMinMm: 0.5, ...over,
});

describe("T2-B1 欄位未填時行為與現行完全相同", () => {
  const grade = buildGradeResult("ITF14", {
    photometric: { rLight: 0.8, rDark: 0.1, rDarkMin: 0.05, edgeContrasts: [0.6, 0.65] },
    geometric: { maxWidthDeviation: 0.1, tolerance: 0.5, maxElementReflectanceNonUniformity: 0.1 },
  });
  it("evaluateAcceptance 對有無新欄位的 policy 輸出逐欄相同(只要新欄位都沒填)", () => {
    const withKeys: AcceptancePolicy = {
      ...base, substrate: undefined, directPrintXMinMm: undefined, bearerBarX: undefined,
    };
    expect(evaluateAcceptance(grade, withKeys)).toEqual(evaluateAcceptance(grade, base));
  });
  it("填了新欄位也不影響等級判定(欄位目前只服務 X 寬下限)", () => {
    expect(evaluateAcceptance(grade, direct())).toEqual(evaluateAcceptance(grade, base));
  });
});

describe("T2-B2 / T2-B3 X 寬下限判定", () => {
  it("正常:大於下限 OK、小於下限 BELOW", () => {
    expect(checkDirectPrintXDim(direct(), 0.71)).toBe("OK");
    expect(checkDirectPrintXDim(direct(), 0.3)).toBe("BELOW");
  });
  it("邊界:剛好等於下限 OK;差一點點 BELOW", () => {
    expect(checkDirectPrintXDim(direct(), 0.5)).toBe("OK");
    expect(checkDirectPrintXDim(direct(), 0.5 - 1e-9)).toBe("BELOW");
  });
});

describe("T2-B4 壞值不得被靜默採用", () => {
  for (const bad of [-1, 0, NaN, Infinity, -Infinity, "0.5" as unknown as number]) {
    it(`directPrintXMinMm = ${String(bad)} → N/A`, () => {
      expect(checkDirectPrintXDim(direct({ directPrintXMinMm: bad }), 0.7)).toBe("N/A");
    });
  }
  it("下限缺漏 → N/A", () => {
    expect(checkDirectPrintXDim(direct({ directPrintXMinMm: undefined }), 0.7)).toBe("N/A");
  });
  for (const bad of [NaN, Infinity, 0, -0.2, null, undefined]) {
    it(`量測 X 寬 = ${String(bad)} → N/A(量不到不能當達標也不能當不足)`, () => {
      expect(checkDirectPrintXDim(direct(), bad as number | null | undefined)).toBe("N/A");
    });
  }
});

describe("T2-B5 substrate 未知值視為未設定", () => {
  it("未知字串 / 空字串 / 未填 → N/A,不丟例外", () => {
    for (const s of ["label", "", "CORRUGATED-DIRECT", undefined]) {
      expect(checkDirectPrintXDim(direct({ substrate: s }), 0.7)).toBe("N/A");
    }
  });
});

describe("T2-B6 seed policy 不帶直印欄位;數值只存在具名常數(2026-11-05 取得 GS1 原文後)", () => {
  it("所有 seed policy 的直印欄位皆未填 —— 行為與現行相同", () => {
    for (const p of SEED_ACCEPTANCE_POLICIES) {
      expect(p.substrate, `${p.id}.substrate`).toBeUndefined();
      expect(p.directPrintXMinMm, `${p.id}.directPrintXMinMm`).toBeUndefined();
      expect(p.bearerBarX, `${p.id}.bearerBarX`).toBeUndefined();
      expect(p.bearerBarPlateMm, `${p.id}.bearerBarPlateMm`).toBeUndefined();
    }
  });
  it("三個 GS1 常數逐項對原文(Release 16.0:p.263 腳註、§5.3.2.4)", () => {
    expect(GS1_ITF14_PLATE_DIRECT_X_MIN_MM).toBe(0.635);
    expect(GS1_BEARER_BAR_PLATE_MM).toBe(4.83); // 需版:絕對毫米,不是 X 的倍數
    expect(GS1_BEARER_BAR_PLATELESS_MIN_X).toBe(2); // 無版:窄條寬倍數
  });
});

describe("T2-B8 plateDirectPrintPolicy(需版直印)", () => {
  const itf = SEED_ACCEPTANCE_POLICIES.find((p) => p.symbology === "ITF14")!;
  const p = plateDirectPrintPolicy(itf);
  it("X 寬邊界:0.634 → BELOW、0.635 → OK、0.636 → OK", () => {
    expect(checkDirectPrintXDim(p, 0.634)).toBe("BELOW");
    expect(checkDirectPrintXDim(p, 0.635)).toBe("OK");
    expect(checkDirectPrintXDim(p, 0.636)).toBe("OK");
  });
  it("量不到 → N/A(沿用既有語意)", () => {
    expect(checkDirectPrintXDim(p, null)).toBe("N/A");
  });
  it("不改動 base;requiredGrade / X 寬規格 / 靜區一個字都不動(§6.1 凍結)", () => {
    expect(itf.substrate).toBeUndefined();
    expect(p.requiredGrade).toBe(itf.requiredGrade);
    expect(p.xDimSpecMm).toBe(itf.xDimSpecMm);
    expect(p.quietZoneMinX).toBe(itf.quietZoneMinX);
    expect(p.bearerBarPlateMm).toBe(4.83);
    expect(p.bearerBarX).toBeUndefined(); // 需版用絕對值,不填倍數
  });
  it("對等級判定沒有影響", () => {
    const grade = buildGradeResult("ITF14", {
      photometric: { rLight: 0.8, rDark: 0.1, rDarkMin: 0.05, edgeContrasts: [0.6, 0.65] },
      geometric: { maxWidthDeviation: 0.1, tolerance: 0.5, maxElementReflectanceNonUniformity: 0.1 },
    });
    expect(evaluateAcceptance(grade, p)).toEqual(evaluateAcceptance(grade, itf));
  });
});

describe("T2-B7 既有允收門檻一個字母都沒動(§6.1 凍結)", () => {
  it("requiredGrade 逐筆釘住", () => {
    const got = Object.fromEntries(SEED_ACCEPTANCE_POLICIES.map((p) => [p.symbology, p.requiredGrade]));
    expect(got).toEqual({ ITF14: "C", GS1_128: "B", CODE128: "C", QR: "C", DATAMATRIX: "C" });
  });
  it("ITF-14 的 X 寬規格與靜區也沒動", () => {
    const itf = SEED_ACCEPTANCE_POLICIES.find((p) => p.symbology === "ITF14")!;
    expect(itf.xDimSpecMm).toBe(1.016);
    expect(itf.quietZoneMinX).toBe(10);
  });
});
