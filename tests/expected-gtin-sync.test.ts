import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// 「預期 GTIN」輸入欄的守門測試(稽核 A-02 / A-03,規格 docs/spec20260913-a02a03-v1.md)。
//
// 由來:兩支 demo 的「預期值」原本不是使用者給的,而是程式自己從解碼結果抄過來的 ——
//   · demo/mobile.html:`expectedGtin: zx ? zx.text : state.expected`,而 decoder 回傳的也是 zx.text
//   · demo/index.html:`state.expected = state.decoded`,三者恆等
// 結果是 expectedDataMatch **結構上恆為 true**:畫面上那句「比對符合」拿自己比自己比出來的。
// 這種故障**沒有症狀** —— 它不會當掉、不會噴錯,只會一直顯示綠燈,接上 CSV / ERP 之後
// 就變成一整欄保證為 true 的「相符」。所以必須有一道靜態守門把「樣式本身」釘死。
//
// 沿用本檔案夾既有 sync test 的作法:以 readFileSync 直讀 HTML 原始碼做斷言,
// 不啟動瀏覽器、不做 DOM 模擬、不引入任何新相依套件。執行期行為(相機、實際掃描、
// 比對結果是否正確顯示)**不在本測試的涵蓋範圍內**,由人在測試台以瀏覽器驗證。

const PAGES = ["demo/index.html", "demo/mobile.html"];
const src = (p: string) => readFileSync(p, "utf8");

/**
 * 取出原始碼中「出現某字樣的那些行」,並先把行註解(// 之後)去掉。
 * 輸入:原始碼字串、要找的字樣;輸出:去註解後的行陣列。
 * 為何要去註解:沿用 pwa-shell-sync.test.ts 對 skipWaiting / caches.match 的教訓 ——
 * 「解釋自己為何不能這樣寫」的註解會被字樣比對當成違規,把守門測試變成假警報,
 * 而假警報的下場是有人把測試改寬,守門就沒了。
 */
function codeLinesContaining(code: string, needle: string): string[] {
  return code
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .filter((line) => line.includes(needle));
}

/** 去掉行註解後的全檔原始碼(給「整份不得出現某樣式」這類斷言用)。 */
function codeWithoutLineComments(code: string): string {
  return code
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * 「拿解碼結果當預期值」的違規偵測。
 * 輸入:原始碼字串;輸出:違規行陣列(空陣列 = 乾淨)。
 * 邏輯:凡是實際出現 expectedGtin 的程式碼行(已去註解),都不得同時帶有
 * 解碼結果的來源字樣 —— zx.text(相機路徑)、state.decoded / SAMPLE_DATA(情境模擬路徑)、
 * decode.data(結果物件)。這是通則式的回歸網,不是只釘住當年那兩行寫法。
 */
const DECODED_SOURCES = ["zx.text", "state.decoded", "decode.data", "SAMPLE_DATA"];
function selfComparisonViolations(code: string): string[] {
  return codeLinesContaining(code, "expectedGtin").filter((line) =>
    DECODED_SOURCES.some((token) => line.includes(token)),
  );
}

describe("預期 GTIN 輸入欄(A-02 / A-03 守門)", () => {
  // ── (a) 欄位存在且兩檔一致 ──────────────────────────────────────────
  describe("(a) 欄位存在且 id / placeholder / 標籤一致", () => {
    it.each(PAGES)("%s 有唯一一個 f-expected-gtin 輸入欄", (page) => {
      const code = src(page);
      const ids = code.match(/id="f-expected-gtin"/g) || [];
      expect(ids.length, `${page} 的 id="f-expected-gtin" 出現次數`).toBe(1);
      expect(code).toMatch(/<input[^>]*id="f-expected-gtin"/);
    });

    it.each(PAGES)("%s 的 placeholder 與標籤文字符合規格", (page) => {
      const code = src(page);
      const input = code.match(/<input[^>]*id="f-expected-gtin"[^>]*>/)![0];
      expect(input).toContain('placeholder="選填，例：14712345678907"');
      expect(input).toContain('type="text"');
      // 標籤:同一行(欄位與 label 寫在一起)必須帶「預期 GTIN」字樣
      const fieldLine = code.split("\n").find((l) => l.includes('id="f-expected-gtin"'))!;
      expect(fieldLine).toContain("預期 GTIN");
    });

    it.each(PAGES)("%s 實際以 $(\"f-expected-gtin\") 讀取此欄", (page) => {
      const code = codeWithoutLineComments(src(page));
      expect(
        /\$\("f-expected-gtin"\)/.test(code) ||
          /getElementById\("f-expected-gtin"\)/.test(code),
      ).toBe(true);
    });

    it.each(PAGES)("%s 不預填任何解碼值(欄位無 value 屬性)", (page) => {
      const input = src(page).match(/<input[^>]*id="f-expected-gtin"[^>]*>/)![0];
      expect(input).not.toMatch(/\svalue=/);
    });
  });

  // ── (b) 「拿解碼結果當預期值」的樣式不存在 ──────────────────────────
  describe("(b) 不得拿解碼結果當預期值", () => {
    it.each(PAGES)("%s 沒有 expectedGtin: zx ? … 的寫法", (page) => {
      expect(codeWithoutLineComments(src(page))).not.toMatch(/expectedGtin\s*:\s*zx\s*\?/);
    });

    it.each(PAGES)("%s 沒有 state.expected = state.decoded", (page) => {
      expect(codeWithoutLineComments(src(page))).not.toMatch(/state\.expected\s*=\s*state\.decoded/);
    });

    it.each(PAGES)("%s 整份不再存在 state.expected 這個欄位", (page) => {
      // 規格 §4:它唯一的來源就是 state.decoded,留著只會被重新接回去,故整個移除。
      // (state.decoded 保留 —— 那是情境模擬的解碼內容,不是預期值。)
      expect(codeWithoutLineComments(src(page))).not.toMatch(/\bstate\.expected\b/);
    });

    it.each(PAGES)("%s 的 expectedGtin 行不含任何解碼結果來源", (page) => {
      expect(selfComparisonViolations(src(page))).toEqual([]);
    });

    // 斷言自身必須有效:沒有這一則,上面那條通則式回歸網可能寫成永遠通過的空斷言
    // (例如 codeLinesContaining 抓不到任何行時也會回傳 [])。
    it("違規樣式餵給同一組比對邏輯會被判為違規(self-check)", () => {
      const fake = [
        "  const decode = runDecode(d, s, { expectedGtin: zx ? zx.text : state.expected });",
        "  const decode2 = runDecode(d, s, { expectedGtin: state.decoded });",
        "  const decode3 = runDecode(d, s, { expectedGtin: SAMPLE_DATA.ITF14 });",
        "  const decode4 = runDecode(d, s, { expectedGtin: decode.data });",
      ].join("\n");
      expect(selfComparisonViolations(fake)).toHaveLength(4);
      expect(codeWithoutLineComments(fake)).toMatch(/expectedGtin\s*:\s*zx\s*\?/);
      expect(codeWithoutLineComments(fake)).toMatch(/\bstate\.expected\b/);
      // 反向:合規寫法不得被誤判為違規(避免守門測試寬到無意義或嚴到擋住正解)
      const good = '  const decode = runDecode(d, s, exp ? { expectedGtin: exp } : {});';
      expect(selfComparisonViolations(good)).toEqual([]);
      // 去註解確實有效:解釋「為何不能這樣寫」的註解不算違規
      const commented = '  // 不可寫成 { expectedGtin: zx.text } —— 那是拿自己比自己';
      expect(selfComparisonViolations(commented)).toEqual([]);
    });
  });

  // ── (c) 登出必須清掉本欄位(A-12 不得被重新開一個洞)────────────────
  describe("(c) doLogout 清掉新欄位", () => {
    it.each(PAGES)("%s 的 doLogout 區塊含 f-expected-gtin", (page) => {
      const code = src(page);
      const start = code.indexOf("function doLogout()");
      expect(start, `${page} 找不到 doLogout`).toBeGreaterThan(-1);
      const end = code.indexOf('$("loginBtn").onclick', start);
      expect(end, `${page} 找不到 doLogout 之後的 loginBtn 綁定`).toBeGreaterThan(start);
      const block = code.slice(start, end);
      expect(block).toContain("f-expected-gtin");
      // 與既有三欄同批清除,不是另外散在別處
      for (const id of ["f-customer", "f-product", "f-workorder"]) expect(block).toContain(id);
    });
  });

  // ── (d) 三態文案兩檔字面值一致 ──────────────────────────────────────
  describe("(d) 未比對 / 比對符合 / 比對不符 三態文案", () => {
    const LABELS = ["未比對", "比對符合", "比對不符"];

    it("兩檔的三個字面值完全相同", () => {
      const found = PAGES.map((page) => {
        const code = src(page);
        return LABELS.filter((t) => code.includes(`"${t}"`));
      });
      expect(found[0]).toEqual(LABELS);
      expect(found[1]).toEqual(found[0]);
    });

    it.each(PAGES)("%s 有 matchLabel 輔助函式且被實際呼叫", (page) => {
      const code = codeWithoutLineComments(src(page));
      expect(code).toMatch(/const\s+matchLabel\s*=/);
      expect(code).toMatch(/matchLabel\(/);
      expect(code).toMatch(/MATCH_UNSET_TEXT/);
    });
  });

  // ── 行為面(靜態可讀的部分)───────────────────────────────────────────
  describe("傳參與顯示的形狀", () => {
    it.each(PAGES)("%s 未填時不傳 expectedGtin 鍵,且無空值回退", (page) => {
      const code = codeWithoutLineComments(src(page));
      // 有填 → { expectedGtin: exp };沒填 → {}(整個鍵不出現)
      expect(code).toContain("{ expectedGtin:");
      expect(code).toMatch(/exp\s*\?\s*\{\s*expectedGtin:\s*exp\s*\}\s*:\s*\{\s*\}/);
      // 空字串會被 engines/decode.ts 當成「有預期值」而算出 false,把「沒比」誤報成「不符」
      expect(code).not.toMatch(/expectedGtin\s*:\s*""/);
      expect(code).not.toMatch(/expectedGtin\s*:\s*[a-zA-Z_$][\w$]*\s*(\|\||\?\?)/);
    });

    it.each(PAGES)("%s 每次檢驗都現讀欄位,不快取進 state", (page) => {
      const code = codeWithoutLineComments(src(page));
      expect(code).toMatch(/const\s+expectedGtinInput\s*=\s*\(\)\s*=>/);
      // 取值輔助函式必須 trim(規格 E2:"   " 不可被當成有填)
      expect(code).toMatch(/\$\("f-expected-gtin"\)\.value\.trim\(\)/);
    });

    it("demo/index.html 沒有把 undefined 折成「不符」的二元三元式", () => {
      expect(codeWithoutLineComments(src("demo/index.html"))).not.toMatch(/expectedDataMatch\s*\?/);
    });

    it("demo/mobile.html 的 saveScan 存下 expectedGtin 與 expectedMatch", () => {
      const code = src("demo/mobile.html");
      const start = code.indexOf("function saveScan(");
      expect(start).toBeGreaterThan(-1);
      const end = code.indexOf("function updateBadge()", start);
      expect(end).toBeGreaterThan(start);
      const block = code.slice(start, end);
      expect(block).toContain("expectedGtin:");
      expect(block).toContain("expectedMatch:");
      // 未比對存 null(不是 false)—— CSV 的 expected_match 欄該留空,不得輸出 false
      expect(block).toMatch(/expectedMatch:\s*decode\.expectedDataMatch\s*\?\?\s*null/);
    });
  });

  // ── tier:本欄位不加閘門(flags.ts 沒有對應旗標,不得自行發明)──────
  describe("本欄位不得出現 tier 判斷", () => {
    it.each(PAGES)("%s 含 f-expected-gtin 的行不帶 tier / PAID / FREE / isEnabled", (page) => {
      const offenders = codeLinesContaining(src(page), "f-expected-gtin").filter((line) =>
        ["tier", "PAID", "FREE", "isEnabled"].some((t) => line.includes(t)),
      );
      expect(offenders).toEqual([]);
    });
  });
});
