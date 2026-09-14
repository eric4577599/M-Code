import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 「本張閘門」的守門測試(稽核 A-10 / A-01,規格 docs/spec20260914-a10a01-v1.md)。
//
// 由來:demo/mobile.html 快門後的「本張閘門」報告,講的不是這張照片的實話 ——
//   · A-10 量錯對象:src/engines/gate.ts:30 的定義是「Laplacian variance over the ROI」,
//     實際卻對整張降取樣照片算 varLap / glare / wash / wb。分母是整個畫面 ⇒ 站遠一點
//     就能任意稀釋:失焦條碼配銳利印刷背景,全幀量到 30247(OK)、ROI 只有 58(FAIL)。
//   · A-01「全部 OK」把從未量過的項目算進 OK:state.gate.pxm 唯一寫入點在 1D 的
//     if (g1.modulePx) 內,2D 從不寫入 ⇒ 讀到的永遠是放行假值 9 ⇒ 9 >= 8 ⇒ 解析度恆 OK。
//
// 這兩種故障**沒有症狀**:不會當掉、不會噴錯,只會一直印出好看的結論。所以必須有一道
// 靜態守門把「結構本身」釘死。沿用 expected-gtin-sync.test.ts 的作法:readFileSync 直讀
// 原始碼做斷言,不啟動瀏覽器、不做 DOM 模擬、不引入任何新相依套件。
// 執行期行為(相機、快門、實際顯示、PDF 產出)**不在本測試涵蓋範圍**,由人在測試台驗。

const PAGE = "demo/mobile.html";
const raw = () => readFileSync(PAGE, "utf8");

/**
 * 去掉行註解後的全檔原始碼。輸入:原始碼字串;輸出:同樣行數但無 // 註解的字串。
 * 為何一定要先去註解:本檔的註解裡就寫著「不得出現全部 OK」「舊寫法 gateOn(shotQFull)」
 * 這類字樣,不去掉的話守門測試會變成假警報 —— 而假警報的下場是有人把測試改寬。
 */
function stripLineComments(code: string): string {
  return code
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * 取出某個具名函式的本體(含大括號)。輸入:原始碼字串、函式名;輸出:本體字串。
 * 邏輯:從 `function 名稱(` 起找到第一個 `{`,再做大括號配對數到 0。
 * 用途:AC-10 要斷言的是「measureFrame 這個函式內」仍是全幀,拿全檔比對會被別處的
 * 字樣汙染,必須縮到函式本體才是有效斷言。
 */
function functionBody(code: string, name: string): string {
  const at = code.indexOf(`function ${name}(`);
  expect(at, `找不到函式 ${name}`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") { depth--; if (depth === 0) return code.slice(open, i + 1); }
  }
  throw new Error(`函式 ${name} 的大括號不成對`);
}

/**
 * 從某個片語起算的區塊本體(含大括號)。輸入:原始碼、起始片語;輸出:區塊字串。
 * 用途:AC-9② 要證明「量到 px/module」與「設立量測旗標」是**同一個區塊**裡的事,
 * 兩者若分屬不同分支,旗標就可能在沒量到的路徑上也是真。
 */
function blockAfter(code: string, phrase: string): string {
  const at = code.indexOf(phrase);
  expect(at, `找不到片語 ${phrase}`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") { depth--; if (depth === 0) return code.slice(open, i + 1); }
  }
  throw new Error(`片語 ${phrase} 之後的大括號不成對`);
}

/** 取出一段「從某個左式起到分號為止」的敘述(跨行)。用於檢查賦值的來源鏈。 */
function statementFrom(code: string, lhs: string): string {
  const at = code.indexOf(lhs);
  expect(at, `找不到賦值 ${lhs}`).toBeGreaterThanOrEqual(0);
  const end = code.indexOf(";", at);
  expect(end).toBeGreaterThan(at);
  return code.slice(at, end + 1);
}

describe("本張閘門改量 ROI(A-10)", () => {
  it("AC-5 shotQRoi 由 measureQuality 量在 roiCanvasOf(photo, roiFull) 的裁切影像上", () => {
    const code = stripLineComments(raw());
    expect(code).toMatch(
      /const\s+shotQRoi\s*=\s*measureQuality\(\s*roiCanvasOf\(\s*photo\s*,\s*roiFull\s*\)/,
    );
  });

  it("AC-5 roiCanvasOf 是具名函式,座標夾回走既有純函式 scaleRoi,且不自行縮放", () => {
    const code = stripLineComments(raw());
    const body = functionBody(code, "roiCanvasOf");
    expect(body).toMatch(/scaleRoi\(\s*roi\s*,\s*1\s*,\s*photo\.width\s*,\s*photo\.height\s*\)/);
    // drawImage 的來源矩形與目的矩形寬高必須相同 —— 先縮一次等於改變取樣鏈
    expect(body).toMatch(/drawImage\(\s*photo\s*,\s*r\.x0\s*,\s*r\.y0\s*,\s*rw\s*,\s*rh\s*,\s*0\s*,\s*0\s*,\s*rw\s*,\s*rh\s*\)/);
  });

  it("AC-6 報告用的閘門是 gateOn(shotQRoi),且 shotGate 的來源鏈不含全幀讀數", () => {
    const code = stripLineComments(raw());
    expect(code).toMatch(/const\s+shotGateRoi\s*=\s*gateOn\(\s*shotQRoi\s*\)/);
    const stmt = statementFrom(code, "lastShotInfo.shotGate =");
    expect(stmt).toContain("summarizeShotGate");
    expect(stmt).toContain("shotGateRoi.report.checks");
    // 來源鏈裡不得混進全幀那一對,也不得直接吃 small / photo 的光度讀數
    for (const forbidden of ["shotQFull", "shotGateFull", "measureQuality(small", "measureQuality(photo"]) {
      expect(stmt).not.toContain(forbidden);
    }
  });

  it("AC-10 預覽路徑仍為全幀:measureFrame 本體不碰 ROI", () => {
    const code = stripLineComments(raw());
    const body = functionBody(code, "measureFrame");
    expect(body).toContain("measureQuality(v, v.videoWidth, v.videoHeight)");
    expect(body).not.toMatch(/roi/i);
    // 幾何項仍由 resetPreviewGeometry 還原,收尾仍 recompute —— 呼叫關係不變
    expect(body).toContain("resetPreviewGeometry();");
    expect(body).toContain("recompute();");
  });

  it("AC-11 取幀新鮮度仍比全幀:四個布林來自 previewGate 與 shotGateFull", () => {
    const code = stripLineComments(raw());
    const stmt = statementFrom(code, "const fresh = assessShotFreshness(");
    expect(stmt).toContain('okOf(previewGate, "focus")');
    expect(stmt).toContain('okOf(shotGateFull, "focus")');
    expect(stmt).toContain('okOf(previewGate, "glare")');
    expect(stmt).toContain('okOf(shotGateFull, "glare")');
    expect(stmt).toContain("shotQFull.varLap");
    // 拿 ROI 去比全幀就不是同尺度比較,新鮮度會開始無差別誤報
    expect(stmt).not.toContain("shotGateRoi");
    expect(stmt).not.toContain("shotQRoi");
  });
});

describe("本張閘門三態呈現(A-01)", () => {
  it("AC-7 去除行註解後的 mobile.html 不存在「全部 OK」字面", () => {
    expect(stripLineComments(raw())).not.toContain("全部 OK");
  });

  it("AC-9② px/module 的閘門賦值與量測旗標同區塊,且只在 1D 分支", () => {
    const code = stripLineComments(raw());
    const assigns = code.split("\n").filter((l) => l.includes("state.gate.pxm ="));
    // 兩處:resetPreviewGeometry 的放行假值,以及 1D 真的量到時的實測值
    expect(assigns).toHaveLength(2);
    expect(assigns.filter((l) => l.includes("pxm = 9"))).toHaveLength(1);
    const reset = functionBody(code, "resetPreviewGeometry");
    expect(reset).toContain("state.gate.pxm = 9");
    expect(reset).not.toContain("pxmMeasured");
    // 實測值那一處必須與旗標同處於 if (g1.modulePx) 區塊內
    const block = blockAfter(code, "if (g1.modulePx)");
    expect(block).toContain("state.gate.pxm = g1.modulePx;");
    expect(block).toContain("pxmMeasured = true;");
    // 旗標全檔只有這一個設真點,才談得上「2D 恆為未量測」
    expect(code.split("pxmMeasured = true").length - 1).toBe(1);
    expect(code).toMatch(/let\s+pxmMeasured\s*=\s*false\s*;/);
  });

  it("AC-9②/AC-12 measured 三項取自實際狀態,不得寫成常數", () => {
    const code = stripLineComments(raw());
    const stmt = statementFrom(code, "const measured = {");
    expect(stmt).toMatch(/resolution:\s*pxmMeasured\s*,/);
    expect(stmt).toMatch(/perspective:\s*tilt\.source\s*!==\s*"none"\s*,/);
    expect(stmt).toMatch(/picket:\s*!!zx\s*,/);
    // 恆真 / 恆假的寫法一律不接受 —— 那等於把三態悄悄退回兩態
    expect(stmt).not.toMatch(/(resolution|perspective|picket):\s*(true|false)\b/);
  });

  it("AC-12 三態敘述交給 imgproc.js 的純函式,HTML 不自己拼字串", () => {
    const code = stripLineComments(raw());
    expect(code).toMatch(/import\s*\{[\s\S]*summarizeShotGate[\s\S]*\}\s*from\s*"\.\/imgproc\.js"/);
    expect(code).toContain("labels: CHECK_LABEL");
  });

  it("§2.5 新增 shotGateBase 版本標記,PDF 明細印得出閘門量在哪裡", () => {
    const code = stripLineComments(raw());
    expect(code).toMatch(/lastShotInfo\.shotGateBase\s*=\s*"ROI(（|\()裁切後(）|\))"/);
    expect(code).toContain("shot.shotGateBase");
  });
});
