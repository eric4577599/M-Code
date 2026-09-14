import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 付費文案必須對得上實作(稽核 A-05,2026-08-22)。
//
// 原文案承諾六項:完整參數報告 / 尺寸量測（X寬·BWR·Quiet Zone）/ 印刷掉級診斷 /
// CSV 匯出 / ERP 回寫 / 趨勢監控。`demo/mobile.html` 實際做得到的約一項半。
// 其中**尺寸量測是結構性不可得**,不是還沒做 —— 相機一開就把 `scaleRef` 壓成 false,
// 沒有實體尺寸基準就沒有毫米可換算。承諾一個交付不了的功能是另一回事,不是 roadmap。
//
// 而且寫死文案本身就直接牴觸專案 CLAUDE.md:「功能是否解鎖一律走 isEnabled,
// 不要在 HTML 裡寫死 tier 判斷或文案」。
//
// ⚠ 桌面測試台 `demo/index.html` **不在此列** —— 它真的有 evaluateDiagnosis /
//   buildMeasurement / toCsvRow,同一句文案在那邊是誠實的。

const MOBILE = readFileSync("demo/mobile.html", "utf8");
const FLAGS = readFileSync("src/domain/flags.ts", "utf8");

/** 取 mobile.html 裡某個陣列常數的原始文字。 */
function arrayLiteral(name: string): string {
  const m = MOBILE.match(new RegExp(`const ${name} = \\[([^]*?)\\n\\];`));
  expect(m, `mobile.html 找不到 ${name}`).toBeTruthy();
  return m![1]!;
}

describe("mobile 付費文案對得上實作(A-05)", () => {
  it("升級文案不寫死在 HTML,由 renderUpsell 依 isEnabled 生成", () => {
    expect(MOBILE).toContain("function renderUpsell()");
    expect(MOBILE).toContain('isEnabled(tier, f.flag)');
    // 承諾句只能出現在 renderUpsell 裡,不可再有一份寫死的
    const promises = [...MOBILE.matchAll(/升級付費版可解鎖/g)];
    expect(promises.length).toBe(1);
    const i = MOBILE.indexOf("function renderUpsell()");
    expect(promises[0]!.index!).toBeGreaterThan(i);
  });

  it("承諾清單不含手機交付不了的四項", () => {
    const promised = arrayLiteral("MOBILE_PAID_FEATURES");
    for (const bad of ["尺寸量測", "診斷", "ERP", "趨勢"]) {
      expect(promised, `「${bad}」不該出現在承諾清單`).not.toContain(bad);
    }
  });

  it("承諾的每個 flag 都是 flags.ts 裡真實存在的 FeatureFlag", () => {
    const promised = arrayLiteral("MOBILE_PAID_FEATURES");
    const flags = [...promised.matchAll(/flag:\s*"([^"]+)"/g)].map((m) => m[1]!);
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) expect(FLAGS).toContain(`| "${f}"`);
  });

  it("交付不了的項目仍要說明去哪裡拿,不是默默拿掉", () => {
    // 悄悄刪掉承諾也是一種不誠實:使用者會以為這些功能不存在
    const elsewhere = arrayLiteral("MOBILE_ELSEWHERE");
    expect(elsewhere).toContain("尺寸量測");
    expect(elsewhere).toContain("實體尺寸基準");
    expect(elsewhere).toContain("桌面版");
  });

  it("「尺寸量測結構性不可得」這個前提仍然成立(成立就別承諾,不成立就回來改文案)", () => {
    // 相機一開就把 scaleRef 壓成 false。哪天這行沒了 = 手機可能真的量得到毫米,
    // 那時 A-05 的結論要重新談,而不是讓文案繼續照舊。
    expect(MOBILE).toMatch(/if \(camVideo\) state\.gate\.scaleRef = false;/);
    expect(MOBILE).not.toContain("measurement_scaleref");
  });
});

describe("桌面測試台不受影響(它真的有那些功能)", () => {
  const INDEX = readFileSync("demo/index.html", "utf8");
  it("index.html 仍呼叫 diagnosis / measurement / CSV", () => {
    for (const fn of ["evaluateDiagnosis", "buildMeasurement", "toCsvRow"]) {
      expect(INDEX).toContain(fn);
    }
  });
});
