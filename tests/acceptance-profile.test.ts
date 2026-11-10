import { describe, it, expect } from "vitest";
import {
  SEED_ACCEPTANCE_POLICIES, acceptancePoliciesFor, policyForProfile,
  ACCEPTANCE_PROFILES, DEFAULT_ACCEPTANCE_PROFILE,
} from "../src/data/policies.js";

const grades = (list: { symbology: string; requiredGrade: string }[]) =>
  Object.fromEntries(list.map((p) => [p.symbology, p.requiredGrade]));

describe("允收標準檔位:高標 / 標準", () => {
  it("預設是高標,且高標與 seed 逐筆相同(§6.1 凍結)", () => {
    expect(DEFAULT_ACCEPTANCE_PROFILE).toBe("high");
    expect(acceptancePoliciesFor("high")).toEqual(SEED_ACCEPTANCE_POLICIES);
    expect(grades(acceptancePoliciesFor("high"))).toEqual({ ITF14: "C", GS1_128: "B", CODE128: "C", QR: "C", DATAMATRIX: "C" });
  });
  it("標準檔位只有 GS1-128 降到 C;ITF-14 仍是 C(不採 D,牛皮紙決策未決)", () => {
    expect(grades(acceptancePoliciesFor("standard"))).toEqual({ ITF14: "C", GS1_128: "C", CODE128: "C", QR: "C", DATAMATRIX: "C" });
  });
  it("標準檔位被改的 policy id 帶 -standard,其餘欄位(X 寬、靜區)不變", () => {
    const hi = policyForProfile("GS1_128", "high")!, st = policyForProfile("GS1_128", "standard")!;
    expect(st.id).toBe("gs1-128-default-standard");
    expect({ ...st, id: hi.id, requiredGrade: hi.requiredGrade }).toEqual(hi);
  });
  it("未知 / 空值檔位一律當高標,不得意外放寬", () => {
    for (const bad of [undefined, null, "", "STANDARD", "x"]) expect(policyForProfile("GS1_128", bad)!.requiredGrade).toBe("B");
  });
  it("取用不改動 seed(回傳的是副本)", () => {
    acceptancePoliciesFor("standard")[1]!.requiredGrade = "F";
    expect(SEED_ACCEPTANCE_POLICIES.find((p) => p.symbology === "GS1_128")!.requiredGrade).toBe("B");
  });
  it("檔位清單恰為 高標 / 標準,每個符號別兩檔都有 policy", () => {
    expect(ACCEPTANCE_PROFILES.map(([, n]) => n)).toEqual(["高標", "標準"]);
    for (const [id] of ACCEPTANCE_PROFILES) expect(acceptancePoliciesFor(id).length).toBe(SEED_ACCEPTANCE_POLICIES.length);
  });
});
