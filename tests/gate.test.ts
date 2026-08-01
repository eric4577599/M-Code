import { describe, it, expect } from "vitest";
import {
  classifyChecks,
  evaluateGate,
  gateState,
  type GateMeasurements,
} from "../src/engines/gate.js";
import type { GateCheck, GateStatus } from "../src/domain/types.js";

// All-passing baseline; tweak one field per test to exercise a boundary.
const PASS: GateMeasurements = {
  symbolDetected: true,
  varLap: 120,
  glareRatio: 0.01,
  washboardAmpRatio: 0.08,
  wbGainDeviation: 0.05,
  scaleRefDetected: true,
  picketAngleDeg: 10,
  perspectiveTiltDeg: 5,
  gsdMmPerPx: 0.2,
  pxPerModule: 8,
};

function statusOf(checks: GateCheck[], key: string): GateStatus {
  const c = checks.find((x) => x.key === key);
  if (!c) throw new Error(`no check ${key}`);
  return c.status;
}

function focusStatus(m: Partial<GateMeasurements>): GateStatus {
  return statusOf(classifyChecks({ ...PASS, ...m }), "focus");
}

describe("focus (>=120 OK else FAIL)", () => {
  it("OK at boundary 120", () => expect(focusStatus({ varLap: 120 })).toBe("OK"));
  it("FAIL just below", () => expect(focusStatus({ varLap: 119.9 })).toBe("FAIL"));
});

describe("glare (<=1% OK, 1-4% WARN, >4% FAIL)", () => {
  const g = (v: number) => statusOf(classifyChecks({ ...PASS, glareRatio: v }), "glare");
  it("OK at 1%", () => expect(g(0.01)).toBe("OK"));
  it("WARN just above 1%", () => expect(g(0.0101)).toBe("WARN"));
  it("WARN at 4%", () => expect(g(0.04)).toBe("WARN"));
  it("FAIL just above 4%", () => expect(g(0.0401)).toBe("FAIL"));
});

describe("washboard (<=0.08 OK, 0.08-0.15 WARN, >0.15 FAIL)", () => {
  const w = (v: number) =>
    statusOf(classifyChecks({ ...PASS, washboardAmpRatio: v }), "washboard");
  it("OK at 0.08", () => expect(w(0.08)).toBe("OK"));
  it("WARN just above 0.08", () => expect(w(0.0801)).toBe("WARN"));
  it("WARN at 0.15", () => expect(w(0.15)).toBe("WARN"));
  it("FAIL just above 0.15", () => expect(w(0.1501)).toBe("FAIL"));
});

describe("washboard fluteType-aware (NONE substrate never FAILs/WARNs)", () => {
  const w = (v: number, fluteType?: GateMeasurements["fluteType"]) =>
    statusOf(classifyChecks({ ...PASS, washboardAmpRatio: v, fluteType }), "washboard");
  it("NONE substrate: value that would normally FAIL (0.5) → OK", () =>
    expect(w(0.5, "NONE")).toBe("OK"));
  it("NONE substrate: value that would normally WARN (0.1) → OK", () =>
    expect(w(0.1, "NONE")).toBe("OK"));
  it("flute C substrate: same 0.5 value → still FAIL (other substrates not relaxed)", () =>
    expect(w(0.5, "C")).toBe("FAIL"));
  it("fluteType undefined (legacy caller): unchanged, applies fixed thresholds", () =>
    expect(w(0.5, undefined)).toBe("FAIL"));
});

describe("whiteBalance (advisory: <=5% OK else WARN, never FAIL/locks)", () => {
  const wb = (v: number) =>
    statusOf(classifyChecks({ ...PASS, wbGainDeviation: v }), "whiteBalance");
  it("OK at 5%", () => expect(wb(0.05)).toBe("OK"));
  it("WARN (not FAIL) just above 5%", () => expect(wb(0.0501)).toBe("WARN"));
  it("even a large deviation stays WARN, never FAIL", () => expect(wb(0.9)).toBe("WARN"));
});

// 實際使用者場景:有色光源下白平衡偏差超標,不該鎖死快門
// (條碼可讀性看色差對比,由解碼/分級把關,非白平衡)。
describe("whiteBalance does not lock the shutter (C4.2 advisory)", () => {
  it("large wb deviation alone stays ARMED and passedAll true", () => {
    const { state, report } = evaluateGate({ ...PASS, wbGainDeviation: 0.9 });
    expect(state).toBe("ARMED");
    expect(report.passedAll).toBe(true);
  });
});

describe("scaleRef (detected OK else FAIL)", () => {
  const sr = (v: boolean) =>
    statusOf(classifyChecks({ ...PASS, scaleRefDetected: v }), "scaleRef");
  it("OK when detected", () => expect(sr(true)).toBe("OK"));
  it("FAIL when not detected", () => expect(sr(false)).toBe("FAIL"));
});

describe("picket (<=10 OK, 10-25 WARN, >25 FAIL — D2 必須 picket fence)", () => {
  const p = (v: number) =>
    statusOf(classifyChecks({ ...PASS, picketAngleDeg: v }), "picket");
  it("OK at 10", () => expect(p(10)).toBe("OK"));
  it("WARN just above 10", () => expect(p(10.1)).toBe("WARN"));
  it("WARN at 25", () => expect(p(25)).toBe("WARN"));
  it("FAIL just above 25", () => expect(p(25.1)).toBe("FAIL"));
  it("FAIL when the barcode lies sideways (90° ladder)", () => expect(p(90)).toBe("FAIL"));
});

describe("perspective (<=5 OK else FAIL)", () => {
  const pe = (v: number) =>
    statusOf(classifyChecks({ ...PASS, perspectiveTiltDeg: v }), "perspective");
  it("OK at 5", () => expect(pe(5)).toBe("OK"));
  it("FAIL just above 5", () => expect(pe(5.1)).toBe("FAIL"));
});

describe("resolution (gsd<=0.20 & pxPerModule>=8 OK, <8 WARN, <5 FAIL)", () => {
  const r = (gsd: number, px: number) =>
    statusOf(classifyChecks({ ...PASS, gsdMmPerPx: gsd, pxPerModule: px }), "resolution");
  it("OK at gsd 0.20 & px 8", () => expect(r(0.2, 8)).toBe("OK"));
  it("WARN when gsd too coarse", () => expect(r(0.21, 8)).toBe("WARN"));
  it("WARN at px 7 (>=5, <8)", () => expect(r(0.2, 7)).toBe("WARN"));
  it("WARN at px 5 boundary", () => expect(r(0.2, 5)).toBe("WARN"));
  it("FAIL just below 5", () => expect(r(0.2, 4.9)).toBe("FAIL"));
});

// 規格 §3.2 / §5.3:比例尺卡未偵測時無實體基準(A4.5),GSD 不可得,
// 該項僅以 pxPerModule 判定,且不得放寬 pxPerModule>=8 這個門檻。
describe("resolution with GSD unavailable (null/undefined — no scale ref)", () => {
  // gsd 允許傳 undefined 以模擬舊呼叫端未帶此欄位的情況,故此處放寬型別。
  const checkOf = (gsd: number | null | undefined, px: number) => {
    const m = { ...PASS, gsdMmPerPx: gsd, pxPerModule: px } as GateMeasurements;
    const c = classifyChecks(m).find((x) => x.key === "resolution");
    if (!c) throw new Error("no resolution check");
    return c;
  };
  const r = (gsd: number | null | undefined, px: number) => checkOf(gsd, px).status;

  it("null gsd & px 7 (<8) is not OK — WARN", () => expect(r(null, 7)).toBe("WARN"));
  it("null gsd & px 7.9 (just below 8) is not OK — WARN", () =>
    expect(r(null, 7.9)).toBe("WARN"));
  it("null gsd & px 5 boundary is not OK — WARN", () => expect(r(null, 5)).toBe("WARN"));
  it("null gsd & px 4.9 (<5) FAILs", () => expect(r(null, 4.9)).toBe("FAIL"));
  it("null gsd & px 8 boundary → OK (threshold not tightened either)", () =>
    expect(r(null, 8)).toBe("OK"));
  it("null gsd & px 12 → OK", () => expect(r(null, 12)).toBe("OK"));
  it("undefined gsd behaves the same as null", () => {
    expect(r(undefined, 7)).toBe("WARN");
    expect(r(undefined, 8)).toBe("OK");
    expect(r(undefined, 4.9)).toBe("FAIL");
  });

  it("threshold string states that GSD is unavailable", () => {
    const c = checkOf(null, 8);
    expect(c.threshold).toContain("GSD unavailable");
    expect(c.threshold).toContain("pxPerModule>=8 OK, <8 WARN, <5 FAIL");
  });

  // 文案只陳述狀態、不歸因:null 的成因不只「比例尺卡未偵測」一種,
  // threshold 不得斷定原因(reviewer minor #9)。
  it("threshold string does not attribute a cause for the missing GSD", () => {
    const c = checkOf(null, 8);
    expect(c.threshold).not.toContain("scale ref");
    expect(c.threshold).not.toContain("scaleRef");
  });

  it("value still carries pxPerModule for debugging", () =>
    expect(checkOf(null, 6.5).value).toBe(6.5));

  // 回歸保護:帶數字 gsd 的行為必須與現況完全一致
  it("numeric gsd path unchanged: coarse gsd still WARNs even at px 8", () =>
    expect(r(0.21, 8)).toBe("WARN"));
  it("numeric gsd path unchanged: 0.20 & px 8 still OK", () =>
    expect(r(0.2, 8)).toBe("OK"));
  it("numeric gsd path unchanged: threshold string keeps the gsd clause", () =>
    expect(checkOf(0.2, 8).threshold).toBe(
      "gsd<=0.20 & pxPerModule>=8 OK, <8 WARN, <5 FAIL",
    ));
  it("numeric gsd 0 (a real, very fine GSD) is not treated as unavailable", () =>
    expect(checkOf(0, 8).threshold).toContain("gsd<=0.20"));
});

describe("evaluateGate with no scale ref (規格 §5.3)", () => {
  it("resolution threshold states GSD unavailable when scaleRefDetected=false", () => {
    const { report } = evaluateGate({
      ...PASS,
      scaleRefDetected: false,
      gsdMmPerPx: null,
    });
    const res = report.checks.find((c) => c.key === "resolution");
    expect(res?.threshold).toContain("GSD unavailable");
    // 只說不可得,不在文案裡斷定是哪個成因造成的
    expect(res?.threshold).not.toContain("scale ref");
  });

  it("missing GSD with a poor pxPerModule locks the shutter (no free pass)", () => {
    const { state } = evaluateGate({
      ...PASS,
      scaleRefDetected: false,
      gsdMmPerPx: null,
      pxPerModule: 4,
    });
    expect(state).toBe("LOCKED");
  });

  it("missing GSD alone (px 8) does not lock — only scaleRef FAILs", () => {
    const { state, report } = evaluateGate({
      ...PASS,
      scaleRefDetected: false,
      gsdMmPerPx: null,
    });
    expect(state).toBe("ARMED");
    expect(report.measurementEnabled).toBe(false);
    expect(report.passedAll).toBe(false); // scaleRef 仍 FAIL
  });

  it("report gsdMmPerPx is null (量不出來),絕不補 0 或假值", () => {
    const { report } = evaluateGate({ ...PASS, scaleRefDetected: false, gsdMmPerPx: null });
    expect(report.gsdMmPerPx).toBeNull();
    // 絕不退回舊的 NaN 承載法:NaN 型別上仍是合法 number,消費端不會被逼著處理
    expect(Number.isNaN(report.gsdMmPerPx as unknown as number)).toBe(false);
    // 也絕不補 0 —— 0 是「非常細的 GSD」,是最寬鬆的放行值
    expect(report.gsdMmPerPx).not.toBe(0);
  });

  // NaN 會傳染的三條實際路徑,逐條斷言 null 都不會發生同樣的事。
  // 這是型別放寬的真正理由,不是風格偏好。
  it("不可得的 gsd / pxPerModule 序列化往返後仍是 null,不會 NaN→null 繞一圈", () => {
    const { report } = evaluateGate({
      ...PASS,
      scaleRefDetected: false,
      gsdMmPerPx: null,
      pxPerModule: NaN,
    });
    expect(report.pxPerModule).toBeNull();
    // InspectionSession(含本報告)會 JSON 序列化送 ERP(C9);NaN 在這一步會靜默變 null,
    // 等於「報告裡是 NaN、ERP 收到 null」兩種表示法並存。用 null 則往返前後一致。
    const roundTrip = JSON.parse(JSON.stringify(report)) as typeof report;
    expect(roundTrip.gsdMmPerPx).toBeNull();
    expect(roundTrip.pxPerModule).toBeNull();
    expect(roundTrip.gsdMmPerPx).toBe(report.gsdMmPerPx);
    expect(roundTrip.pxPerModule).toBe(report.pxPerModule);
  });

  it("可得的數值不受型別放寬影響,原樣帶進報告", () => {
    const { report } = evaluateGate({ ...PASS, gsdMmPerPx: 0.12, pxPerModule: 11 });
    expect(report.gsdMmPerPx).toBe(0.12);
    expect(report.pxPerModule).toBe(11);
  });
});

// 「不可得」守衛(C4.2)。demo/*.html 是原生 JS、不進 typecheck,量測失敗很容易把
// null / undefined / NaN 餵進來;JS 會把 null coerce 成 0,而 0 正是多數檢查最寬鬆的
// 放行值(≤5° 透視、≤10° 印向、≤1% 眩光、≤0.08 楞痕),不擋就是靜默恆綠。
// 重點斷言是 state !== "ARMED"(快門不得解鎖),不只看單項 status。
describe("不可得守衛:量測值為 null / undefined / NaN 時不得放行", () => {
  // 用 as 繞過型別,刻意模擬「原生 JS 呼叫端沒有型別保護」的實況。
  const withBad = (field: keyof GateMeasurements, bad: unknown) =>
    ({ ...PASS, [field]: bad } as GateMeasurements);
  const BAD_INPUTS: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["NaN", NaN],
  ];

  // 會鎖快門的檢查:不可得 → FAIL → LOCKED。
  const LOCKING: [keyof GateMeasurements, string][] = [
    ["varLap", "focus"],
    ["glareRatio", "glare"],
    ["washboardAmpRatio", "washboard"],
    ["picketAngleDeg", "picket"],
    ["perspectiveTiltDeg", "perspective"],
    ["pxPerModule", "resolution"],
  ];

  for (const [field, key] of LOCKING) {
    describe(`${key}(${field})`, () => {
      for (const [label, bad] of BAD_INPUTS) {
        it(`${label} → 不得 ARMED(鎖快門)`, () => {
          const { state, report } = evaluateGate(withBad(field, bad));
          expect(state).not.toBe("ARMED");
          expect(state).toBe("LOCKED");
          expect(report.passedAll).toBe(false);
          expect(statusOf(report.checks, key)).toBe("FAIL");
        });

        it(`${label} → threshold 標明不可得,value 不帶 null/NaN`, () => {
          const c = classifyChecks(withBad(field, bad)).find((x) => x.key === key)!;
          expect(c.threshold).toContain("unavailable");
          expect(c.value).not.toBeNull();
          expect(Number.isFinite(c.value)).toBe(true);
        });
      }
    });
  }

  // whiteBalance 是唯一例外:C4.2 明訂它是建議燈、永不鎖快門(歷史誤判熱區),
  // 故不可得取「不鎖快門前提下最嚴的一側」= WARN,而不是讓 null coerce 成 0 拿到 OK。
  describe("whiteBalance(建議燈例外:不可得 → WARN,仍不鎖快門)", () => {
    for (const [label, bad] of BAD_INPUTS) {
      it(`${label} → WARN 而非 OK,且不 FAIL`, () => {
        const c = classifyChecks(withBad("wbGainDeviation", bad)).find(
          (x) => x.key === "whiteBalance",
        )!;
        expect(c.status).toBe("WARN");
        expect(c.threshold).toContain("unavailable");
        expect(Number.isFinite(c.value)).toBe(true);
      });
      it(`${label} → 仍維持 ARMED(建議燈不得改回硬閘門)`, () => {
        const { state } = evaluateGate(withBad("wbGainDeviation", bad));
        expect(state).toBe("ARMED");
      });
    }
  });

  // gsd 不可得是既有的「少一個條件」語意,與上面「沒有替代量」的檢查不同:
  // pxPerModule 仍撐得住這道檢查,故 NaN 也要走 null 那一支,不得掉到 WARN 放行側。
  describe("resolution:gsd 的 NaN 視同 null(走既有不可得分支)", () => {
    const resOf = (gsd: unknown, px: number) =>
      classifyChecks({ ...PASS, gsdMmPerPx: gsd, pxPerModule: px } as GateMeasurements).find(
        (x) => x.key === "resolution",
      )!;
    it("NaN gsd & px 8 → OK,threshold 標 GSD unavailable", () => {
      const c = resOf(NaN, 8);
      expect(c.status).toBe("OK");
      expect(c.threshold).toContain("GSD unavailable");
    });
    it("NaN gsd & px 7 → WARN(門檻未放寬)", () => expect(resOf(NaN, 7).status).toBe("WARN"));
    it("NaN gsd & px 4.9 → FAIL", () => expect(resOf(NaN, 4.9).status).toBe("FAIL"));
    it("Infinity gsd 視同不可得,不得因比較為 false 而落到放行側", () => {
      const c = resOf(Infinity, 8);
      expect(c.threshold).toContain("GSD unavailable");
    });
  });

  // 規劃書 §1.3 病灶的直接回歸:tiltFromHomography 焦距不可得回 null,
  // 若閘門讓 null coerce 成 0° 就等於誠實白做。
  it("perspectiveTiltDeg = null 不得回 OK/ARMED(對應 tiltFromHomography 回 null)", () => {
    const { state, report } = evaluateGate(withBad("perspectiveTiltDeg", null));
    expect(state).not.toBe("ARMED");
    expect(statusOf(report.checks, "perspective")).not.toBe("OK");
  });

  // 一次掃過所有量測欄位:報告裡的 value 一律是有限數,null / NaN 不得流進報告。
  it("任一欄位不可得,所有 GateCheck.value 仍為有限數", () => {
    const fields: (keyof GateMeasurements)[] = [
      "varLap",
      "glareRatio",
      "washboardAmpRatio",
      "wbGainDeviation",
      "picketAngleDeg",
      "perspectiveTiltDeg",
      "gsdMmPerPx",
      "pxPerModule",
    ];
    for (const field of fields) {
      for (const [label, bad] of BAD_INPUTS) {
        for (const c of evaluateGate(withBad(field, bad)).report.checks) {
          expect(Number.isFinite(c.value), `${field}=${label} → ${c.key}.value`).toBe(true);
        }
      }
    }
  });

  // 無瓦楞材質的 N/A 前例不受影響:不看讀數,但 value 也不能是 NaN。
  it("fluteType=NONE 且 ampRatio 不可得:仍 OK 且 value 為有限數", () => {
    const c = classifyChecks({
      ...PASS,
      fluteType: "NONE",
      washboardAmpRatio: NaN,
    } as GateMeasurements).find((x) => x.key === "washboard")!;
    expect(c.status).toBe("OK");
    expect(Number.isFinite(c.value)).toBe(true);
  });

  // 回歸保護:守衛不得動到正常數值路徑,門檻數字一個都不准變。
  it("正常輸入行為不變(門檻未被守衛動到)", () => {
    const { state, report } = evaluateGate(PASS);
    expect(state).toBe("ARMED");
    expect(report.passedAll).toBe(true);
    expect(statusOf(report.checks, "perspective")).toBe("OK"); // 5° 邊界仍 OK
    expect(statusOf(report.checks, "picket")).toBe("OK"); // 10° 邊界仍 OK
  });
});

describe("gate state (C4.1)", () => {
  it("SCANNING when no symbol ROI", () => {
    const { state, report } = evaluateGate({ ...PASS, symbolDetected: false });
    expect(state).toBe("SCANNING");
    expect(report.passedAll).toBe(false);
  });

  it("ARMED when all OK/WARN", () => {
    const { state, report } = evaluateGate(PASS);
    expect(state).toBe("ARMED");
    expect(report.passedAll).toBe(true);
  });

  it("ARMED tolerates WARN-only checks", () => {
    const { state } = evaluateGate({ ...PASS, glareRatio: 0.02, picketAngleDeg: 20 });
    expect(state).toBe("ARMED");
  });

  it("LOCKED on any single FAIL", () => {
    const { state, report } = evaluateGate({ ...PASS, varLap: 50 });
    expect(state).toBe("LOCKED");
    expect(report.passedAll).toBe(false);
  });

  it("gateState helper: LOCKED requires symbol detected", () => {
    const failing = classifyChecks({ ...PASS, varLap: 0 });
    expect(gateState(false, failing)).toBe("SCANNING");
    expect(gateState(true, failing)).toBe("LOCKED");
  });

  // C4.2:scaleRef 未偵測 → 量測停用、仍可解碼,不鎖快門
  it("scaleRef missing alone does NOT lock (C4.2: measurement off, decode allowed)", () => {
    const { state, report } = evaluateGate({ ...PASS, scaleRefDetected: false });
    expect(state).toBe("ARMED");
    expect(report.measurementEnabled).toBe(false);
    expect(report.passedAll).toBe(false); // 仍有一項 FAIL,不算全過
  });

  it("scaleRef missing plus another FAIL still locks", () => {
    const { state } = evaluateGate({ ...PASS, scaleRefDetected: false, varLap: 50 });
    expect(state).toBe("LOCKED");
  });

  it("measurementEnabled is true when scaleRef is detected", () => {
    const { report } = evaluateGate(PASS);
    expect(report.measurementEnabled).toBe(true);
    expect(report.passedAll).toBe(true);
  });

  // 實際使用者場景:標籤材質(無瓦楞)不該被楞痕透印誤判鎖死快門
  it("NONE substrate with a high washboard reading stays ARMED, not LOCKED", () => {
    const { state } = evaluateGate({ ...PASS, fluteType: "NONE", washboardAmpRatio: 0.9 });
    expect(state).toBe("ARMED");
  });
});

describe("report shape", () => {
  it("carries gsd, pxPerModule and all eight checks", () => {
    const { report } = evaluateGate(PASS);
    expect(report.gsdMmPerPx).toBe(0.2);
    expect(report.pxPerModule).toBe(8);
    expect(report.checks.map((c) => c.key)).toEqual([
      "focus",
      "glare",
      "washboard",
      "whiteBalance",
      "scaleRef",
      "picket",
      "perspective",
      "resolution",
    ]);
    for (const c of report.checks) expect(typeof c.threshold).toBe("string");
  });
});
