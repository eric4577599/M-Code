import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { SEED_ACCEPTANCE_POLICIES } from "../src/data/policies.js";
import type { Symbology } from "../src/domain/types.js";

// 允收門檻的治理護欄(稽核 A-08,2026-08-22)。
//
// 問題不是「C 這個值對不對」,是**那個值住在哪裡**:CODE128 / QR / DATAMATRIX 從來沒有
// policy,`demo/*.html` 的 `policyOf()` 找不到就退回一行寫在 HTML 裡的 `requiredGrade:"C"`。
// 後果是這三種符號別的允收標準不受規格 §6.1 的門檻凍結治理、沒有守門測試,
// 而且改它不必碰 `src/` —— 審 diff 的人看不到有人動了允收標準。
//
// 這支測試釘兩件事:① 每個 Symbology 都有 policy(呼叫端就沒有機會自己生一個);
// ② demo 的 fallback 只能是告警,不得長得像一份預設門檻。
//
// ⚠ 補進來的三筆**沿用 fallback 一直在用的 C,不改變任何現行嚴格度**。
//   要調門檻仍受 §6.1 凍結,必須先有實拍對照。

const ALL_SYMBOLOGIES: Symbology[] = ["ITF14", "GS1_128", "CODE128", "QR", "DATAMATRIX"];
const DEMOS = ["demo/mobile.html", "demo/index.html"];

describe("允收 policy 覆蓋每一個符號別(A-08)", () => {
  it("Symbology 聯集與 policies.ts 一一對應,沒有漏網的", () => {
    const covered = SEED_ACCEPTANCE_POLICIES.map((p) => p.symbology).sort();
    expect(covered).toEqual([...ALL_SYMBOLOGIES].sort());
  });

  it("ALL_SYMBOLOGIES 本身與型別定義同步(漏一個就等於漏測一個)", () => {
    // 型別是編譯期的,執行期測不到 —— 改用原始碼比對,types.ts 加了新符號別這裡會紅
    const src = readFileSync("src/domain/types.ts", "utf8");
    const m = src.match(/export type Symbology =([^;]+);/);
    expect(m, "types.ts 找不到 Symbology 定義").toBeTruthy();
    const declared = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]!).sort();
    expect(declared).toEqual([...ALL_SYMBOLOGIES].sort());
  });

  it("每筆 policy 的 id 唯一,且 requiredGrade 是合法字母", () => {
    const ids = SEED_ACCEPTANCE_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of SEED_ACCEPTANCE_POLICIES) {
      expect(["A", "B", "C", "D", "F"]).toContain(p.requiredGrade);
    }
  });

  it("補進來的三筆維持 C —— 這是搬家不是調門檻(§6.1 凍結)", () => {
    for (const id of ["code128-default", "qr-default", "datamatrix-default"]) {
      const p = SEED_ACCEPTANCE_POLICIES.find((x) => x.id === id);
      expect(p, `${id} 不見了`).toBeTruthy();
      expect(p!.requiredGrade).toBe("C");
    }
  });

  it("2D 與 CODE128 不編造 X 寬與靜區規格(沒有適用規格就是 0)", () => {
    // 填一個看起來合理的數字等於編造規格,下游的尺寸判定會據此給出無意義的結論
    for (const id of ["code128-default", "qr-default", "datamatrix-default"]) {
      const p = SEED_ACCEPTANCE_POLICIES.find((x) => x.id === id)!;
      expect(p.xDimSpecMm).toBe(0);
      expect(p.quietZoneMinX).toBe(0);
    }
  });
});

describe("demo 的 policyOf fallback 是告警不是門檻(A-08)", () => {
  for (const f of DEMOS) {
    const src = readFileSync(f, "utf8");

    it(`${f}:找不到 policy 時會出聲,不靜默給值`, () => {
      const i = src.indexOf("const policyOf");
      expect(i, `${f} 找不到 policyOf`).toBeGreaterThan(-1);
      const body = src.slice(i, i + 900);
      expect(body).toContain("console.error");
      expect(body).toContain("policies.ts");
    });

    it(`${f}:fallback 的 id 自報未受治理,不偽裝成 default`, () => {
      const i = src.indexOf("const policyOf");
      const body = src.slice(i, i + 900);
      expect(body).toContain("ungoverned-fallback");
      // 舊寫法 `state.symbology.toLowerCase()+"-default"` 讓 fallback 看起來像一筆
      // 正式 policy,紀錄與報告上也就看不出這張的門檻是 HTML 給的
      expect(body).not.toContain('"-default"');
    });
  }
});
