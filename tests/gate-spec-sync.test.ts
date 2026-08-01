import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyChecks,
  evaluateGate,
  type GateMeasurements,
} from "../src/engines/gate.js";
import type { GateCheck, GateStatus } from "../src/domain/types.js";

// 規格 ↔ 程式的長期同步機制,第二組(規格 C4.2 閘門判定 + C3.1 型別宣告)。
//
// 背景:tests/rules-spec-sync.test.ts 只涵蓋 §C8 的種子規則 JSON,C4.2 的門檻與
// C3.1 的欄位型別全靠人工記得回寫主規劃書,沒有任何測試會紅。同一類漂移在本專案
// 已實際發生過三次(CLAUDE.md 測試基線過期、spec 的權威表自己過期、C4.2 白平衡列
// 停在舊的 FAIL 語意),**人工紀律不是機制**。
//
// 做法比照 C8:直接解析主規劃書的表格與型別宣告,再對程式的實際行為/宣告逐項比對。
// 任一邊單獨改動即失敗,逼規格與程式在同一個 commit 一起改。
//
// 本檔刻意「跑程式、看行為」而不是比對程式碼字面:門檻寫在 if 判斷式裡,比字面等於
// 再抄一次規格,行為對了才是真的同步。

const SPEC_PATH = new URL("../corrugated_barcode_qc_app_master_v1.md", import.meta.url);
const TYPES_PATH = new URL("../src/domain/types.ts", import.meta.url);

/**
 * 取出主規劃書兩個標題之間的章節原文。
 * 輸入:起始標題、結束標題;輸出:區間內的 markdown 字串。
 * 找不到任一標題即讓測試失敗(標題被改名時要有人來看,不可靜默跳過整段比對)。
 */
function specSection(startHeading: string, endHeading: string): string {
  const md = readFileSync(SPEC_PATH, "utf8");
  const start = md.indexOf(startHeading);
  expect(start, `主規劃書找不到章節「${startHeading}」`).toBeGreaterThan(-1);
  const end = md.indexOf(endHeading, start);
  expect(end, `主規劃書找不到「${endHeading}」(無法界定章節範圍)`).toBeGreaterThan(start);
  return md.slice(start, end);
}

/**
 * 從 markdown 區段裡取出指定表格的資料列。
 * 輸入:區段原文、表頭必須含有的字串;輸出:每列一個 cell 陣列(已去頭尾空白)。
 * 邏輯:把連續的 `|` 開頭行切成表格區塊,選出表頭命中的那一塊,丟掉表頭與 `---` 分隔列。
 */
function parseTable(section: string, headerMustContain: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of section.split("\n")) {
    if (line.trimStart().startsWith("|")) current.push(line.trim());
    else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);

  const block = blocks.find((b) => b[0]!.includes(headerMustContain));
  expect(block, `找不到表頭含「${headerMustContain}」的表格`).toBeDefined();
  return block!
    .slice(1)
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split("|").map((c) => c.trim()));
}

/** 取出一段文字裡所有反引號內容(規格用它標 key 與 threshold 字串)。 */
const backticked = (s: string): string[] =>
  [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/**
 * 把規格門檻寫法轉成程式使用的數值。
 * 輸入:如 "120" / "1%" / "10°";輸出:120 / 0.01 / 10。
 * 百分比是規格的呈現單位,程式一律用 0–1 的比值(glare、Δgain 皆然),故除以 100。
 */
function toValue(raw: string): number {
  const m = /^(-?[\d.]+)\s*(%|°)?$/.exec(raw.trim());
  expect(m, `無法解析門檻數值「${raw}」`).not.toBeNull();
  const n = Number(m![1]);
  return m![2] === "%" ? n / 100 : n;
}

/**
 * 解析單邊門檻儲存格,如 "≥120" / "≤1%" / ">4%" / "<120"。
 * 輸出:比較方向與界線值;不是單邊門檻(範圍、"—"、文字)則回 null 由呼叫端處理。
 */
function parseBound(cell: string): { op: "≥" | "≤" | ">" | "<"; value: number } | null {
  const m = /^([≥≤><])\s*([\d.]+\s*[%°]?)/.exec(cell.trim());
  if (!m) return null;
  return { op: m[1] as "≥" | "≤" | ">" | "<", value: toValue(m[2]!) };
}

/** 解析範圍儲存格,如 "1–4%" / "0.08–0.15" / "10–25°"。單位標在尾端,兩端共用。 */
function parseRange(cell: string): { lo: number; hi: number } | null {
  const m = /^([\d.]+)\s*[–-]\s*([\d.]+\s*[%°]?)/.exec(cell.trim());
  if (!m) return null;
  const unit = /[%°]/.exec(m[2]!)?.[0] ?? "";
  return { lo: toValue(m[1]! + unit), hi: toValue(m[2]!) };
}

/** 空欄位(規格用 "—" 表示該狀態不存在)。 */
const isDash = (cell: string): boolean => /^[—–-]$/.test(cell.trim());

// ── 全綠基線 ────────────────────────────────────────────────────────────────
// 與 tests/gate.test.ts 的 PASS 同義,但本檔刻意各自持有一份:那邊改基線不該
// 靜默改變本檔「規格門檻是否被遵守」的結論。
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

/** 檢查 key ↔ GateMeasurements 欄位。缺項會讓下方的涵蓋率測試失敗,不會靜默略過。 */
const FIELD_OF: Record<string, keyof GateMeasurements> = {
  focus: "varLap",
  glare: "glareRatio",
  washboard: "washboardAmpRatio",
  whiteBalance: "wbGainDeviation",
  scaleRef: "scaleRefDetected",
  picket: "picketAngleDeg",
  perspective: "perspectiveTiltDeg",
};

/** 以單一欄位覆寫基線,回傳該檢查的狀態。 */
function statusWith(key: string, field: keyof GateMeasurements, value: unknown): GateStatus {
  const checks = classifyChecks({ ...PASS, [field]: value } as GateMeasurements);
  const c = checks.find((x) => x.key === key);
  if (!c) throw new Error(`classifyChecks 沒有回傳 ${key} 這項檢查`);
  return c.status;
}

/** 相對誤差意義下「剛好越過界線」的一小步(門檻值可能是 0.08 也可能是 120)。 */
const nudge = (v: number): number => Math.max(Math.abs(v), 1) * 1e-6;

const C42 = specSection("### C4.2 六項檢查", "### C4.3");
const C31 = specSection("### C3.1 核心實體", "### C3.2");

describe("閘門六項檢查:規格 §C4.2 表格與 src/engines/gate.ts 同步", () => {
  const rows = parseTable(C42, "量測方法");

  it("表列的檢查 key 與順序即 classifyChecks 前六項", () => {
    const specKeys = rows.map((r) => backticked(r[0]!)[0]);
    expect(specKeys).toEqual(
      classifyChecks(PASS)
        .slice(0, specKeys.length)
        .map((c) => c.key),
    );
  });

  it("每個表列的 key 都有對應的量測欄位(規格新增檢查時本檔必須跟上)", () => {
    for (const row of rows) {
      const key = backticked(row[0]!)[0]!;
      expect(FIELD_OF[key], `檢查 ${key} 尚未對應到 GateMeasurements 欄位`).toBeDefined();
    }
  });

  // 逐列把規格的 OK / WARN / FAIL 三欄還原成邊界值,實際跑 classifyChecks 比對。
  // 這是本檔的核心:門檻數字改了任一邊,這裡就紅。
  for (const row of rows) {
    const key = backticked(row[0]!)[0]!;
    const [okCell, warnCell, failCell] = [row[3]!, row[4]!, row[5]!];

    describe(`${key}(規格 OK=${okCell} / WARN=${warnCell} / FAIL=${failCell})`, () => {
      const field = FIELD_OF[key]!;
      const ok = parseBound(okCell);

      // scaleRef 的「數值」欄是 bool,OK 欄寫「偵測到」,不走數值邊界那條路。
      if (!ok) {
        it("bool 型檢查:偵測到 OK、未偵測 FAIL", () => {
          expect(row[2]).toBe("bool");
          expect(statusWith(key, field, true)).toBe("OK");
          expect(statusWith(key, field, false)).toBe("FAIL");
        });
        return;
      }

      it(`OK 邊界 ${okCell} 落在 OK 側,越界即非 OK`, () => {
        const inside = ok.value;
        const outside =
          ok.op === "≥" ? ok.value - nudge(ok.value) : ok.value + nudge(ok.value);
        expect(statusWith(key, field, inside)).toBe("OK");
        expect(statusWith(key, field, outside)).not.toBe("OK");
      });

      // WARN / FAIL 兩欄的三種寫法都要有斷言,沒有一種可以靜默略過 ——
      // 「解析不出來就不測」正是規格漂移得以躲過守門的方式。
      assertStatusCell("WARN", warnCell, key, field, ok.value);
      assertStatusCell("FAIL", failCell, key, field, ok.value);
    });
  }
});

/** 以門檻值為尺度掃一段合理讀數(0 到 20 倍門檻),用來驗證「某狀態不存在」。 */
function sweep(scale: number): number[] {
  const s = Math.abs(scale) || 1;
  return [0, s * 0.5, s, s * 1.01, s * 2, s * 5, s * 20];
}

/**
 * 為規格表的 WARN / FAIL 欄產生對應斷言。
 * 輸入:期望狀態、規格儲存格原文、檢查 key 與量測欄位、OK 邊界值(掃描尺度用)。
 * 三種寫法各有處理:區間(a–b)取中點與上界、單邊門檻(>N / <N)取剛越界處、
 * 「—」代表該狀態不存在則反向掃描全域。**都不符合就直接讓測試紅**,
 * 不可靜默略過 —— 略過等於這一欄從此無人看守。
 */
function assertStatusCell(
  want: GateStatus,
  cell: string,
  key: string,
  field: keyof GateMeasurements,
  okBoundary: number,
): void {
  const range = parseRange(cell);
  if (range) {
    it(`${want} 區間 ${cell} 全段判 ${want}`, () => {
      expect(statusWith(key, field, (range.lo + range.hi) / 2)).toBe(want);
      expect(statusWith(key, field, range.hi)).toBe(want);
    });
    return;
  }

  const bound = parseBound(cell);
  if (bound) {
    it(`${want} 條件 ${cell} 成立時判 ${want}`, () => {
      const v =
        bound.op === "<" || bound.op === "≤"
          ? bound.value - nudge(bound.value)
          : bound.value + nudge(bound.value);
      expect(statusWith(key, field, v)).toBe(want);
    });
    return;
  }

  if (isDash(cell)) {
    it(`規格標「—」:此檢查在任何讀數下都不得 ${want}`, () => {
      for (const v of sweep(okBoundary)) {
        expect(statusWith(key, field, v), `${key} @ ${v}`).not.toBe(want);
      }
      // 白平衡是建議燈、永不鎖快門(專案 CLAUDE.md 列為歷史誤判熱區)。
      // 這條把「不得改回硬閘門」變成機制,而不只是註解裡的叮嚀。
      if (want === "FAIL") {
        expect(
          evaluateGate({ ...PASS, [field]: okBoundary * 100 } as GateMeasurements).state,
        ).not.toBe("LOCKED");
      }
    });
    return;
  }

  it(`${key} 的 ${want} 欄「${cell}」無法解析 —— 規格改了寫法就要補解析,不得靜默不測`, () => {
    expect.fail(`無法從「${cell}」推出 ${want} 的判定條件`);
  });
}

describe("附加檢查:透視與解析度(規格 §C4.2「附加(並入放行)」)", () => {
  it("透視門檻取自規格原文,邊界內 OK、越界 FAIL", () => {
    const line = /附加(?:（|\()並入放行(?:）|\))[^\n]*/.exec(C42)?.[0];
    expect(line, "§C4.2 找不到「附加(並入放行)」那行").toBeDefined();
    const m = /透視傾斜\*{0,2}\s*≤\s*([\d.]+)°/.exec(line!);
    expect(m, `無法從「${line}」解析透視門檻`).not.toBeNull();
    const limit = Number(m![1]);
    expect(statusWith("perspective", "perspectiveTiltDeg", limit)).toBe("OK");
    expect(statusWith("perspective", "perspectiveTiltDeg", limit + nudge(limit))).toBe("FAIL");
  });

  const resRows = parseTable(C42, "`threshold` 字串");

  it("解析度判定表為兩支:GSD 可得 / 不可得", () => {
    expect(resRows).toHaveLength(2);
    expect(resRows[0]![0]).toContain("GSD 可得");
    expect(resRows[1]![0]).toContain("GSD 不可得");
  });

  it("GSD 可得分支:threshold 字串與判定逐項符合規格", () => {
    const expected = backticked(resRows[0]![2]!)[0]!;
    const res = (m: Partial<GateMeasurements>): GateCheck =>
      classifyChecks({ ...PASS, ...m }).find((c) => c.key === "resolution")!;

    expect(res({}).threshold).toBe(expected);
    // 規格判定欄:gsd≤0.20 且 pxPerModule≥8 OK;pxPerModule<5 FAIL;其餘 WARN
    const rule = resRows[0]![1]!;
    const gsdMax = toValue(/gsd\s*≤\s*([\d.]+)/i.exec(rule)![1]!);
    const pxOk = toValue(/pxPerModule\s*≥\s*([\d.]+)/.exec(rule)![1]!);
    const pxFail = toValue(/pxPerModule\s*<\s*([\d.]+)/.exec(rule)![1]!);

    expect(res({ gsdMmPerPx: gsdMax, pxPerModule: pxOk }).status).toBe("OK");
    expect(res({ gsdMmPerPx: gsdMax + 0.001, pxPerModule: pxOk }).status).toBe("WARN");
    expect(res({ gsdMmPerPx: gsdMax, pxPerModule: pxOk - 1 }).status).toBe("WARN");
    expect(res({ gsdMmPerPx: gsdMax, pxPerModule: pxFail - 1 }).status).toBe("FAIL");
  });

  it("GSD 不可得分支:threshold 字串與判定逐項符合規格,且門檻不放寬", () => {
    const expected = backticked(resRows[1]![2]!)[0]!;
    const res = (px: number): GateCheck =>
      classifyChecks({ ...PASS, gsdMmPerPx: null, pxPerModule: px }).find(
        (c) => c.key === "resolution",
      )!;

    expect(res(8).threshold).toBe(expected);
    // 規格判定欄:≥8 OK、<8 WARN、<5 FAIL —— 與可得分支的 pxPerModule 門檻必須同數字
    const rule = resRows[1]![1]!;
    const [okAt, warnUnder, failUnder] = [
      toValue(/≥\s*([\d.]+)/.exec(rule)![1]!),
      toValue(/<\s*([\d.]+)/.exec(rule)![1]!),
      toValue(/<\s*([\d.]+)`?\s*FAIL/.exec(rule)?.[1] ?? "5"),
    ];
    expect(warnUnder).toBe(okAt); // 少一個條件,不是降低標準
    expect(res(okAt).status).toBe("OK");
    expect(res(okAt - 1).status).toBe("WARN");
    expect(res(failUnder - 1).status).toBe("FAIL");
    // 不歸因:threshold 只陳述不可得這個事實
    expect(res(8).threshold).not.toMatch(/scale|比例尺/i);
  });
});

describe("「不可得」守衛:規格 §C4.2 守衛表與 gate.ts 同步", () => {
  const rows = parseTable(C42, "不可得時");
  // 量測失敗時呼叫端可能傳進來的三種值。規格明載 NaN 視同 null。
  const BAD: unknown[] = [null, undefined, NaN];

  /** 從「不可得時」欄取出狀態:優先取粗體標的,否則取句中的裸狀態字(如「沿用 falsy → FAIL」)。 */
  const statusIn = (cell: string): GateStatus | null => {
    const bold = /\*\*(OK|WARN|FAIL)\*\*/.exec(cell);
    const bare = /\b(OK|WARN|FAIL)\b/.exec(cell);
    return ((bold?.[1] ?? bare?.[1]) as GateStatus | undefined) ?? null;
  };

  /** 這列是否把判定委派給上方的「GSD 可得 / 不可得」兩支表(而非自己寫死一個狀態)。 */
  const delegatesToResolutionTable = (cell: string): boolean =>
    /GSD\s*不可得.*分支/.test(cell);

  it("守衛表每一列都被本測試消費(規格加列時必須有人來補對應)", () => {
    for (const row of rows) {
      const keys = backticked(row[0]!).filter((k) => k in FIELD_OF || k === "resolution");
      expect(keys.length, `守衛表這列沒有可辨識的檢查 key:${row[0]}`).toBeGreaterThan(0);
      // 一列要嘛自己給得出狀態,要嘛明確委派給解析度兩支表(由上一個 describe 涵蓋)。
      // 兩者皆非就是規格加了本檔看不懂的寫法,必須有人來補,不可當成沒這列。
      const cell = row[1]!;
      expect(
        statusIn(cell) !== null || delegatesToResolutionTable(cell),
        `這列讀不出狀態也不是委派:${cell}`,
      ).toBe(true);
    }
  });

  it("委派列名副其實:gsd 不可得時真的走「GSD 不可得」分支,而非另一套判定", () => {
    const row = rows.find((r) => delegatesToResolutionTable(r[1]!));
    expect(row, "守衛表找不到 gsd 不可得的委派列").toBeDefined();
    // 規格在該列括號裡明載「NaN 視同 null」,兩者行為必須逐字相同
    expect(row![1]).toMatch(/NaN/);
    const thresholdOf = (gsd: unknown): string =>
      classifyChecks({ ...PASS, gsdMmPerPx: gsd as number | null }).find(
        (c) => c.key === "resolution",
      )!.threshold;
    const expected = backticked(parseTable(C42, "`threshold` 字串")[1]![2]!)[0]!;
    expect(thresholdOf(null)).toBe(expected);
    expect(thresholdOf(NaN)).toBe(expected);
    expect(thresholdOf(undefined)).toBe(expected);
  });

  for (const row of rows) {
    // resolution 兩列的語意由上一個 describe 的兩支分支測試涵蓋(gsd 不可得走 GSD 分支、
    // pxPerModule 不可得 FAIL),此處只處理單值檢查,避免同一件事測兩遍卻可能不一致。
    const keys = backticked(row[0]!).filter((k) => k in FIELD_OF);
    if (!keys.length) continue;
    const want = statusIn(row[1]!)!;

    for (const key of keys) {
      it(`${key} 量測不可得時判 ${want}(規格:${row[1]!.replace(/\s+/g, " ")})`, () => {
        for (const bad of BAD) {
          expect(statusWith(key, FIELD_OF[key]!, bad), `${key} @ ${String(bad)}`).toBe(want);
        }
      });
    }
  }

  it("resolution:pxPerModule 不可得判 FAIL(唯一剩下的判準也沒了)", () => {
    const row = rows.find((r) => r[0]!.includes("pxPerModule"))!;
    expect(statusIn(row[1]!)).toBe("FAIL");
    for (const bad of BAD) {
      expect(
        classifyChecks({ ...PASS, pxPerModule: bad as number }).find(
          (c) => c.key === "resolution",
        )!.status,
      ).toBe("FAIL");
    }
  });

  it("GateCheck.value 的不可得哨兵值與規格一致,且絕不為 null/NaN", () => {
    const m = /`GateCheck.value`[^\n]*?一律填\s*\*{0,2}`?(-?\d+)`?/.exec(C42);
    expect(m, "§C4.2 找不到 GateCheck.value 的哨兵值宣告").not.toBeNull();
    const sentinel = Number(m![1]);
    const checks = classifyChecks({ ...PASS, varLap: null as unknown as number });
    const focus = checks.find((c) => c.key === "focus")!;
    expect(focus.value).toBe(sentinel);
    for (const c of checks) expect(Number.isFinite(c.value), `${c.key}.value`).toBe(true);
  });
});

describe("C3.1 型別宣告:規格 CaptureQualityReport 與 src/domain/types.ts 同步", () => {
  /**
   * 從一段原始碼文字裡取出指定 interface 的「欄位: 型別」對照。
   * 輸入:原始碼、interface 名稱;輸出:欄位名 → 正規化後的型別字串。
   * 邏輯:抓 interface 大括號內的內容,去掉註解與行內註解,逐行拆 `name: type;`。
   * 只做欄位型別比對,不比對註解與排版(那兩者本來就允許兩邊不同)。
   */
  function interfaceFields(source: string, name: string): Record<string, string> {
    const m = new RegExp(`interface\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(source);
    expect(m, `找不到 interface ${name}`).not.toBeNull();
    const body = m![1]!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const out: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const f = /^\s*([A-Za-z_$][\w$]*)\??\s*:\s*(.+?);?\s*$/.exec(line);
      if (f) out[f[1]!] = f[2]!.replace(/\s+/g, " ").replace(/;$/, "").trim();
    }
    return out;
  }

  const specFields = interfaceFields(C31, "CaptureQualityReport");
  const codeFields = interfaceFields(readFileSync(TYPES_PATH, "utf8"), "CaptureQualityReport");

  it("欄位名與順序完全一致", () => {
    expect(Object.keys(specFields)).toEqual(Object.keys(codeFields));
  });

  it("每個欄位的型別逐字一致", () => {
    expect(specFields).toEqual(codeFields);
  });

  // 這兩欄是本檔存在的直接理由:不可得必須由型別逼呼叫端處理,不能退回 NaN。
  it("gsdMmPerPx / pxPerModule 兩邊都必須含 null(不得退回以 NaN 承載)", () => {
    for (const field of ["gsdMmPerPx", "pxPerModule"]) {
      expect(specFields[field], `規格 C3.1 的 ${field}`).toBe("number | null");
      expect(codeFields[field], `types.ts 的 ${field}`).toBe("number | null");
    }
    const { report } = evaluateGate({ ...PASS, gsdMmPerPx: null, pxPerModule: NaN });
    expect(report.gsdMmPerPx).toBeNull();
    expect(report.pxPerModule).toBeNull();
  });
});
