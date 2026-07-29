import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SEED_DIAGNOSIS_RULES } from "../src/data/rules.js";
import type { DiagnosisRule } from "../src/domain/types.js";

// 規格 ↔ 程式的長期同步機制(規格 C8)。
// 主規劃書 §C8 的種子規則 JSON 是規格面 SSOT,src/data/rules.ts 為逐字轉寫;
// 本測試直接解析規格書該段 JSON 與程式常數逐欄比對,任一邊單獨改動即失敗,
// 逼規格與程式同一個 commit 一起改,避免靜默漂移。

// 從主規劃書取出 §C8 的種子規則 JSON。
// 輸入:無(讀 repo 根的主規劃書);輸出:解析後的規則陣列。
// 邏輯:切出 "## C8" 到 "## C9" 之間的章節,抓其中第一個 ```json 區塊再 JSON.parse。
function readSpecRules(): DiagnosisRule[] {
  const md = readFileSync(
    new URL("../corrugated_barcode_qc_app_master_v1.md", import.meta.url),
    "utf8",
  );
  const start = md.indexOf("## C8 診斷引擎");
  expect(start, "主規劃書找不到 §C8 章節標題").toBeGreaterThan(-1);
  const end = md.indexOf("## C9", start);
  expect(end, "主規劃書找不到 §C9(無法界定 C8 章節範圍)").toBeGreaterThan(start);

  const block = /```json\n([\s\S]*?)```/.exec(md.slice(start, end));
  expect(block, "§C8 章節內找不到 ```json 種子規則區塊").not.toBeNull();
  return JSON.parse(block![1]!) as DiagnosisRule[];
}

describe("種子診斷規則:規格 §C8 與 src/data/rules.ts 同步", () => {
  const specRules = readSpecRules();

  it("規則 id 與順序完全一致", () => {
    expect(specRules.map((r) => r.id)).toEqual(SEED_DIAGNOSIS_RULES.map((r) => r.id));
  });

  it("每條規則逐欄一致(條件、病因、處方、severity、適用符號/基材)", () => {
    expect(specRules).toEqual(SEED_DIAGNOSIS_RULES);
  });

  it("LOW_CONTRAST / NO_DECODE 為跨符號通則,須含 CODE128 與 DATAMATRIX", () => {
    for (const id of ["LOW_CONTRAST", "NO_DECODE"]) {
      const rule = SEED_DIAGNOSIS_RULES.find((r) => r.id === id);
      expect(rule, `找不到規則 ${id}`).toBeDefined();
      expect(rule!.appliesTo).toContain("CODE128");
      expect(rule!.appliesTo).toContain("DATAMATRIX");
    }
  });
});
