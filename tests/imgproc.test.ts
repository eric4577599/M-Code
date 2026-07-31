import { describe, it, expect } from "vitest";
// 影像處理層(demo/imgproc.js)為純函式,可直接在 Node 測試
// @ts-expect-error — 純 JS 模組,無型別宣告
import {
  toGray,
  varianceOfLaplacian,
  glareRatio,
  grayWorldWbDeviation,
  washboardAmpRatio,
  otsu,
  scanlineRuns,
  roiPhotometric,
  roi1DGeometry,
  quadGeometry,
  lineAngleDeg,
  finderDamageProxy,
  pickBestResolution,
  scaleRoi,
  fitRoiToBudget,
  orderCorners,
  quadConfidence,
  QUAD_CONFIDENCE_LIMITS,
  targetRectSize,
  solveHomography,
  warpPerspective,
  MAX_WARP_PIXELS,
  tiltFromHomography,
} from "../demo/imgproc.js";

// 產生單色 RGBA 影像
function rgbaFill(w: number, h: number, r: number, g: number, b: number) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < a.length; p += 4) { a[p] = r; a[p + 1] = g; a[p + 2] = b; a[p + 3] = 255; }
  return a;
}
// 產生灰階影像(以填值函式)
function grayFrom(w: number, h: number, fn: (x: number, y: number) => number) {
  const g = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fn(x, y);
  return g;
}
// 垂直條紋「條碼」:barW px 暗(40)、barW px 亮(220)交錯,左右各留亮邊
function syntheticBarcode(w: number, h: number, barW: number) {
  return grayFrom(w, h, (x) => {
    if (x < 12 || x >= w - 12) return 220; // quiet zone
    return Math.floor((x - 12) / barW) % 2 === 0 ? 40 : 220;
  });
}

describe("toGray / glareRatio / grayWorldWbDeviation", () => {
  it("白色 RGBA → 灰階 255;黑色 → 0", () => {
    expect(toGray(rgbaFill(2, 2, 255, 255, 255), 2, 2)[0]).toBe(255);
    expect(toGray(rgbaFill(2, 2, 0, 0, 0), 2, 2)[0]).toBe(0);
  });
  it("glareRatio:一半像素為高光 → 0.5", () => {
    const g = grayFrom(10, 10, (x) => (x < 5 ? 255 : 100));
    expect(glareRatio(g)).toBeCloseTo(0.5, 10);
  });
  it("白平衡:中性灰 → 0;偏紅 → 明顯偏差", () => {
    expect(grayWorldWbDeviation(rgbaFill(4, 4, 128, 128, 128))).toBeCloseTo(0, 10);
    expect(grayWorldWbDeviation(rgbaFill(4, 4, 180, 128, 128))).toBeGreaterThan(0.3);
  });
});

describe("varianceOfLaplacian(對焦度)", () => {
  it("平坦影像 → 0;棋盤格(銳利)遠大於模糊漸層", () => {
    const flat = grayFrom(32, 32, () => 128);
    const checker = grayFrom(32, 32, (x, y) => ((x + y) % 2 ? 255 : 0));
    const smooth = grayFrom(32, 32, (x) => 100 + x); // 緩漸層
    expect(varianceOfLaplacian(flat, 32, 32)).toBe(0);
    expect(varianceOfLaplacian(checker, 32, 32)).toBeGreaterThan(1000);
    expect(varianceOfLaplacian(checker, 32, 32)).toBeGreaterThan(
      varianceOfLaplacian(smooth, 32, 32) * 100,
    );
  });
});

describe("washboardAmpRatio(楞痕週期)", () => {
  it("平坦 → 接近 0;16px 週期正弦波紋 → 明顯振幅比", () => {
    const flat = grayFrom(160, 60, () => 128);
    const ripple = grayFrom(160, 60, (x) => 128 + 40 * Math.sin((2 * Math.PI * x) / 16));
    expect(washboardAmpRatio(flat, 160, 60)).toBeLessThan(0.02);
    expect(washboardAmpRatio(ripple, 160, 60)).toBeGreaterThan(0.15);
  });
});

describe("otsu / scanlineRuns", () => {
  it("雙峰(50/200)的閾值落在兩峰之間", () => {
    const g = grayFrom(20, 20, (x) => (x < 10 ? 50 : 200));
    const t = otsu(g);
    expect(t).toBeGreaterThan(50);
    expect(t).toBeLessThan(200);
  });
  it("run 分段:寬度與明暗正確", () => {
    const row = new Uint8ClampedArray([220, 220, 40, 40, 40, 220, 220]);
    const runs = scanlineRuns(row, 128);
    expect(runs.map((r: { len: number; dark: boolean }) => [r.len, r.dark])).toEqual([
      [2, false], [3, true], [2, false],
    ]);
  });
});

describe("roiPhotometric / roi1DGeometry(合成條碼)", () => {
  const W = 140, H = 40;
  const bars = syntheticBarcode(W, H, 4);
  const roi = { x0: 0, y0: 0, x1: W, y1: H };

  it("光度:rLight/rDark 對應亮暗值,邊緣對比高", () => {
    const pm = roiPhotometric(bars, W, roi);
    expect(pm.rLight).toBeCloseTo(220 / 255, 1);
    expect(pm.rDark).toBeCloseTo(40 / 255, 1);
    expect(Math.min(...pm.edgeContrasts)).toBeGreaterThan(0.5);
  });

  it("幾何:等寬條 → 寬度偏差≈0,模組寬=條寬", () => {
    const g1 = roi1DGeometry(bars, W, roi);
    expect(g1.scanlines.length).toBeGreaterThan(0);
    expect(g1.modulePx).toBe(4);
    for (const s of g1.scanlines) {
      expect(s.maxWidthDeviation).toBeLessThan(0.1);
      expect(s.maxElementReflectanceNonUniformity).toBeLessThan(0.05);
    }
  });

  it("finderDamageProxy:均勻暗模組 → 接近 0", () => {
    const pm = roiPhotometric(bars, W, roi);
    expect(finderDamageProxy(bars, W, roi, pm)).toBeLessThan(0.1);
  });
});

describe("quadGeometry / lineAngleDeg(幾何角度)", () => {
  it("正交等臂 → gridDeviation≈0、印向 0°", () => {
    const q = quadGeometry([{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(q.gridDeviation).toBeCloseTo(0, 5);
    expect(q.picketAngleDeg).toBeCloseTo(0, 5);
  });
  it("斜切/不等臂 → gridDeviation 上升", () => {
    const q = quadGeometry([{ x: 20, y: 100 }, { x: 0, y: 0 }, { x: 60, y: 10 }]);
    expect(q.gridDeviation).toBeGreaterThan(0.1);
  });
  it("lineAngleDeg:水平 0°、45° 斜線 45°、垂直 90°", () => {
    expect(lineAngleDeg([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBeCloseTo(0, 5);
    expect(lineAngleDeg([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBeCloseTo(45, 5);
    expect(lineAngleDeg([{ x: 0, y: 0 }, { x: 0, y: 10 }])).toBeCloseTo(90, 5);
  });
});

describe("pickBestResolution(解析度三層降級)", () => {
  // Android Chrome 典型能力表:照片上限遠高於視訊
  const fullTrackCaps = {
    width: { min: 1, max: 1920 },
    height: { min: 1, max: 1080 },
    frameRate: { min: 1, max: 60 },
    facingMode: ["environment"],
  };
  const fullPhotoCaps = {
    imageWidth: { min: 96, max: 4032, step: 1 },
    imageHeight: { min: 96, max: 3024, step: 1 },
  };

  it("完整 capabilities:照片上限優先於視訊上限(tier 1)", () => {
    expect(pickBestResolution(fullTrackCaps, fullPhotoCaps)).toEqual({
      width: 4032, height: 3024, source: "photo", tier: 1, widthOnly: false,
    });
  });

  it("缺欄位:無 photoCaps → 退到 track 上限(tier 2);photoCaps 只有寬也一樣", () => {
    expect(pickBestResolution(fullTrackCaps, null)).toEqual({
      width: 1920, height: 1080, source: "track", tier: 2, widthOnly: true,
    });
    expect(pickBestResolution(fullTrackCaps, undefined).tier).toBe(2);
    // 寬高必須同時可得,只有 imageWidth 不足以採用
    expect(pickBestResolution(fullTrackCaps, { imageWidth: { max: 4032 } })).toEqual({
      width: 1920, height: 1080, source: "track", tier: 2, widthOnly: true,
    });
  });

  it("只有 max(無 min/step)仍可用", () => {
    expect(pickBestResolution({ width: { max: 3840 }, height: { max: 2160 } }, null)).toEqual({
      width: 3840, height: 2160, source: "track", tier: 2, widthOnly: true,
    });
    expect(
      pickBestResolution(fullTrackCaps, { imageWidth: { max: 4032 }, imageHeight: { max: 3024 } }).source,
    ).toBe("photo");
  });

  it("回報 0:視為不可得,逐層降級", () => {
    // 照片上限回報 0 → 降到 track
    expect(pickBestResolution(fullTrackCaps, { imageWidth: { max: 0 }, imageHeight: { max: 0 } })).toEqual({
      width: 1920, height: 1080, source: "track", tier: 2, widthOnly: true,
    });
    // 兩層都是 0 → 回退 4096 請求 ideal
    expect(
      pickBestResolution({ width: { max: 0 }, height: { max: 0 } }, { imageWidth: { max: 0 }, imageHeight: { max: 0 } }),
    ).toEqual({ width: 4096, height: 4096, source: "fallback", tier: 3, widthOnly: true });
  });

  it("Safari 式殘缺表:讀不到寬高 → fallback 4096(tier 3)", () => {
    const safariCaps = { deviceId: "abc", facingMode: [], groupId: "g1" };
    expect(pickBestResolution(safariCaps, undefined)).toEqual({
      width: 4096, height: 4096, source: "fallback", tier: 3, widthOnly: true,
    });
  });

  // widthOnly 是給呼叫端的約束指示:true 代表只准用 width 下 ideal。
  // tier 2 的 width.max 與 height.max 來自兩個獨立區間,不保證是同一個可用模式;
  // tier 3 的 4096×4096 是 1:1 的請求值,不是任何實機的真實長寬比 —— 兩者連 height
  // 一起下約束都會讓瀏覽器的 fitness distance 選到非預期模式。
  // tier 1 的寬高是餵給 ImageCapture.takePhoto() 的 photoSettings,不走 fitness
  // distance,故可以寬高一起帶。
  it("widthOnly:tier 2 / tier 3 只准約束寬度,tier 1 可寬高並用", () => {
    expect(pickBestResolution(fullTrackCaps, fullPhotoCaps).widthOnly).toBe(false);
    expect(pickBestResolution(fullTrackCaps, null).widthOnly).toBe(true);
    expect(pickBestResolution(null, null).widthOnly).toBe(true);
    // 長寬比不可信的兩層必為 true:tier 3 的長寬比恆為 1:1
    const t3 = pickBestResolution(null, null);
    expect(t3.width / t3.height).toBe(1);
    expect(t3.widthOnly).toBe(true);
  });

  it("容錯:null / 缺欄位 / 字串 / NaN 都不 throw,一律回退", () => {
    const cases = [
      [null, null],
      [undefined, undefined],
      [{}, {}],
      [{ width: null, height: null }, { imageWidth: null, imageHeight: null }],
      [{ width: { max: "1920" }, height: { max: "1080" } }, null],
      [{ width: { max: NaN }, height: { max: NaN } }, null],
      [{ width: { max: Infinity }, height: { max: -1080 } }, null],
      [{ width: 1920, height: 1080 }, null], // 非區間物件
    ];
    for (const [caps, photoCaps] of cases) {
      const r = pickBestResolution(caps, photoCaps);
      expect(r).toEqual({ width: 4096, height: 4096, source: "fallback", tier: 3, widthOnly: true });
    }
  });
});

describe("scaleRoi(ROI 座標放大並夾回畫布)", () => {
  it("k=1:ROI 原封不動,貼齊畫布邊也不被裁掉", () => {
    expect(scaleRoi({ x0: 10, y0: 20, x1: 90, y1: 60 }, 1, 100, 80))
      .toEqual({ x0: 10, y0: 20, x1: 90, y1: 60 });
    // 四邊都貼齊畫布:上界是 maxW / maxH 本身(右下為開區間,不必 −1)
    expect(scaleRoi({ x0: 0, y0: 0, x1: 100, y1: 80 }, 1, 100, 80))
      .toEqual({ x0: 0, y0: 0, x1: 100, y1: 80 });
  });

  it("放大:左上 floor、右下 ceil(寧可多包也不切到符號邊緣)", () => {
    // 7×1.5=10.5 → 10;13×1.5=19.5 → 20
    expect(scaleRoi({ x0: 7, y0: 7, x1: 13, y1: 13 }, 1.5, 1000, 1000))
      .toEqual({ x0: 10, y0: 10, x1: 20, y1: 20 });
  });

  it("典型路徑:1024 降取樣版 ROI × 3.9375 放大回 4032×3024", () => {
    const r = scaleRoi({ x0: 100, y0: 80, x1: 900, y1: 700 }, 4032 / 1024, 4032, 3024);
    expect(r).toEqual({ x0: 393, y0: 315, x1: 3544, y1: 2757 });
    expect(r.x1).toBeLessThanOrEqual(4032);
    expect(r.y1).toBeLessThanOrEqual(3024);
  });

  it("k 使 ROI 超出畫布:夾回邊界,不得回傳畫布外座標", () => {
    // 放大倍率比實際大,右下角會衝出畫布
    const r = scaleRoi({ x0: 900, y0: 700, x1: 1024, y1: 768 }, 4, 4032, 3024);
    expect(r).toEqual({ x0: 3600, y0: 2800, x1: 4032, y1: 3024 });
    // 整個 ROI 都在畫布外 → 夾成右下角的 1×1,而不是負寬或畫布外座標
    const out = scaleRoi({ x0: 5000, y0: 5000, x1: 6000, y1: 6000 }, 1, 640, 480);
    expect(out).toEqual({ x0: 639, y0: 479, x1: 640, y1: 480 });
  });

  it("負座標與退化 ROI(寬或高為 0)→ 至少 1×1 且落在畫布內", () => {
    expect(scaleRoi({ x0: -50, y0: -50, x1: 10, y1: 10 }, 1, 100, 100))
      .toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
    // 寬為 0
    expect(scaleRoi({ x0: 10, y0: 10, x1: 10, y1: 20 }, 1, 100, 100))
      .toEqual({ x0: 10, y0: 10, x1: 11, y1: 20 });
    // 高為 0
    expect(scaleRoi({ x0: 10, y0: 10, x1: 20, y1: 10 }, 1, 100, 100))
      .toEqual({ x0: 10, y0: 10, x1: 20, y1: 11 });
    // 寬高皆 0 且落在右下角
    expect(scaleRoi({ x0: 100, y0: 100, x1: 100, y1: 100 }, 1, 100, 100))
      .toEqual({ x0: 99, y0: 99, x1: 100, y1: 100 });
    // k=0(倍率算壞)也不得回傳 0 面積
    const z = scaleRoi({ x0: 10, y0: 10, x1: 90, y1: 90 }, 0, 100, 100);
    expect(z.x1 - z.x0).toBeGreaterThanOrEqual(1);
    expect(z.y1 - z.y0).toBeGreaterThanOrEqual(1);
  });
});

describe("fitRoiToBudget(ROI 取樣預算)", () => {
  const MAX = 4e6; // 與 mobile.html 的 MAX_ROI_PIXELS 同值

  it("未超過上限:尺寸原封不動,scale=1", () => {
    expect(fitRoiToBudget(800, 600, MAX)).toEqual({ w: 800, h: 600, scale: 1 });
  });

  it("面積剛好等於上限:仍算未超過,scale=1", () => {
    expect(fitRoiToBudget(2000, 2000, MAX)).toEqual({ w: 2000, h: 2000, scale: 1 });
    // 只多一個像素就要縮
    expect(fitRoiToBudget(2001, 2000, MAX).scale).toBeLessThan(1);
  });

  it("遠超上限(4032×3024 全張):等比縮進預算內,長寬比不變", () => {
    const r = fitRoiToBudget(4032, 3024, MAX);
    expect(r.scale).toBeCloseTo(Math.sqrt(MAX / (4032 * 3024)), 10);
    expect(r.w * r.h).toBeLessThanOrEqual(MAX);
    expect(r.w / r.h).toBeCloseTo(4032 / 3024, 2);
    expect(r.w).toBeLessThan(4032);
  });

  it("極端窄長與退化尺寸:寬高至少 1px", () => {
    const thin = fitRoiToBudget(100000, 1, MAX);
    expect(thin.h).toBeGreaterThanOrEqual(1);
    expect(thin.w * thin.h).toBeLessThanOrEqual(MAX);
    // 寬或高為 0 的退化 ROI 一律當 1px,不回傳 0 面積
    expect(fitRoiToBudget(0, 0, MAX)).toEqual({ w: 1, h: 1, scale: 1 });
    expect(fitRoiToBudget(0, 500, MAX)).toEqual({ w: 1, h: 500, scale: 1 });
    // 預算小於 1px 也要保住 1×1
    expect(fitRoiToBudget(10, 10, 0.5).w).toBe(1);
  });

  it("maxPixels 非有限正數 → 視為無上限,不縮", () => {
    for (const bad of [0, -1, NaN, Infinity, undefined, null, "4000000"]) {
      expect(fitRoiToBudget(4032, 3024, bad)).toEqual({ w: 4032, h: 3024, scale: 1 });
    }
  });
});

// ── 特性化測試(characterization test)─────────────────────────────────────
// 這是特性化測試,用來記錄「取樣密度對 DEC 代理值的系統性影響」,不是允收門檻。
// 斷言的是兩種取樣密度下的相對關係,不得把這裡的數值當成品質標準或門檻依據。
//
// 背景(規格 §1.5 / §4):roi1DGeometry 以「最窄 run 的 10 百分位」當模組寬,再算各
// run 對模組整數倍的偏差。當每模組只有 3.5 px 時,1 模組的元素被量化成 3 或 4 px、
// 2 模組的元素量化成 7 px,而模組寬估計本身也被壓成 3 px(低估) —— 於是 7/3 = 2.33,
// 偏差 0.33 模組全部被記成印刷缺陷,實際上是取樣不足造成的。
//
// 2026-07-31 實測(下方固定合成圖樣,無亂數):
//   每模組 3.5 px → modulePx 估為 3、maxWidthDeviation = 0.3333(tolerance 0.5 的 2/3)
//   每模組 14  px → modulePx 估為 14、maxWidthDeviation = 0.0000
// 亦即光是把取樣密度從 3.5 px/module 拉到 14 px/module,同一個「完美」條碼的 DEC
// 代理值就從 0.3333 掉到 0。DEC 門檻要標定時必須連同取樣密度一起標,否則同一張標籤
// 換台手機拍就會換一個等級。
const CHAR_PATTERN = [1, 1, 2, 2, 1, 1, 2, 1, 2, 1, 1, 2, 2, 1, 1, 1, 2, 2, 1, 2, 1, 1, 2, 1];
const CHAR_QUIET = 10;   // 兩側靜區(模組數)
const CHAR_PHASE = 0.37; // 固定次像素相位,避免元素邊界剛好落在整數像素上(不是亂數)

// 以指定取樣密度合成同一個條碼圖樣的灰階位元圖。
// 輸入:pxPerModule 每模組像素數、h 影像高;輸出:{ gray, w, h }。
// 邏輯:模組序列 CHAR_PATTERN 明暗交錯展開成模組座標的線段,每個像素以「暗部覆蓋率」
//   做面積抗鋸齒(模擬真實取樣的部分覆蓋),亮 220 / 暗 40 線性內插;各列完全相同,
//   故結果完全決定於 pxPerModule,不含任何亂數。
function charBarcodeAt(pxPerModule: number, h = 40) {
  const segs: { a: number; b: number }[] = [];
  let m = CHAR_QUIET + CHAR_PHASE;
  for (let i = 0; i < CHAR_PATTERN.length; i++) {
    const width = CHAR_PATTERN[i]!;
    if (i % 2 === 0) segs.push({ a: m, b: m + width }); // 偶數索引為暗元素
    m += width;
  }
  const w = Math.round((m + CHAR_QUIET) * pxPerModule);
  const row = new Uint8ClampedArray(w);
  for (let x = 0; x < w; x++) {
    const a = x / pxPerModule, b = (x + 1) / pxPerModule;
    let dark = 0;
    for (const s of segs) {
      const overlap = Math.min(b, s.b) - Math.max(a, s.a);
      if (overlap > 0) dark += overlap;
    }
    row[x] = Math.round(220 + (40 - 220) * (dark / (b - a)));
  }
  const gray = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) gray.set(row, y * w);
  return { gray, w, h };
}

// 取該圖樣所有掃描線的最大 maxWidthDeviation
function decProxyOf(img: { gray: Uint8ClampedArray; w: number; h: number }) {
  const g1 = roi1DGeometry(img.gray, img.w, { x0: 0, y0: 0, x1: img.w, y1: img.h });
  const devs = g1.scanlines.map((s: { maxWidthDeviation: number }) => s.maxWidthDeviation);
  return { maxDev: Math.max(...devs), modulePx: g1.modulePx, n: g1.scanlines.length };
}

describe("特性化:取樣密度對 DEC 代理值的系統性影響(記錄用,非允收門檻)", () => {
  it("同一圖樣,每模組 14px 的 maxWidthDeviation 明顯低於每模組 3.5px", () => {
    const low = decProxyOf(charBarcodeAt(3.5));   // 1024px 寬、視野 300mm 的實況
    const high = decProxyOf(charBarcodeAt(14));   // 4032px 寬、視野 300mm 的實況
    expect(low.n).toBeGreaterThan(0);
    expect(high.n).toBeGreaterThan(0);
    // 核心特性:取樣密度提高 → DEC 代理值下降(此為記錄的系統性偏差,不是門檻)
    expect(high.maxDev).toBeLessThan(low.maxDev);
    // 鎖住 2026-07-31 實測到的量級,日後演算法改動會在此暴露
    expect(low.maxDev).toBeCloseTo(0.3333, 3);
    expect(high.maxDev).toBeCloseTo(0, 3);
  });

  it("模組寬估計本身在低取樣密度下被低估(3.5px/module → 估成 3px)", () => {
    // 這是上一項偏差的根因:10 百分位取到被量化成 3px 的窄元素,
    // 後續所有 run 都以 3 為基準算整數倍,自然對不齊。
    expect(decProxyOf(charBarcodeAt(3.5)).modulePx).toBe(3);
    expect(decProxyOf(charBarcodeAt(14)).modulePx).toBe(14);
  });

  it("合成圖樣完全決定於取樣密度(無亂數,跑兩次結果相同)", () => {
    const a = decProxyOf(charBarcodeAt(3.5)), b = decProxyOf(charBarcodeAt(3.5));
    expect(a).toEqual(b);
  });
});

// ── 梯形矯正(規格 §3.3 / 驗收 §5.4)──────────────────────────────────────
type Pt = { x: number; y: number };
type H3 = number[]; // row-major 9 元素

// 以 H 映射單點(齊次除法),用來驗證 solveHomography 的解
function applyH(H: H3, p: Pt): Pt {
  const w = H[6]! * p.x + H[7]! * p.y + H[8]!;
  return { x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / w, y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / w };
}
// 由 { w, h } 展開成正射目標矩形的四角(TL/TR/BR/BL),與 orderCorners 的順序對應
function rectCorners(size: { w: number; h: number }): Pt[] {
  return [
    { x: 0, y: 0 }, { x: size.w - 1, y: 0 },
    { x: size.w - 1, y: size.h - 1 }, { x: 0, y: size.h - 1 },
  ];
}

describe("orderCorners(四角排序)", () => {
  // 一個明顯非矩形的凸四邊形,四角彼此可辨識
  const TL = { x: 10, y: 20 }, TR = { x: 110, y: 15 }, BR = { x: 120, y: 90 }, BL = { x: 5, y: 95 };
  const want = [TL, TR, BR, BL];

  it("順時針 / 逆時針 / 任意起點的輸入都排出同一組 TL,TR,BR,BL", () => {
    const inputs = [
      [TL, TR, BR, BL],       // 已排好
      [TR, BR, BL, TL],       // 順時針但起點不同
      [BR, BL, TL, TR],       // 順時針,再換起點
      [BL, BR, TR, TL],       // 逆時針
      [TL, BL, BR, TR],       // 逆時針,起點在 TL
      [BR, TL, BL, TR],       // 亂序
    ];
    for (const pts of inputs) expect(orderCorners(pts)).toEqual(want);
  });

  it("透視梯形(上短下長)也排得出來,且不改動座標值", () => {
    const quad = [{ x: 40, y: 10 }, { x: 90, y: 10 }, { x: 120, y: 80 }, { x: 10, y: 80 }];
    expect(orderCorners([quad[2], quad[0], quad[3], quad[1]])).toEqual(quad);
  });

  it("超過 4 點只取前 4 個(不猜哪些是真正的角)", () => {
    expect(orderCorners([TL, TR, BR, BL, { x: 999, y: 999 }])).toEqual(want);
  });

  it("退回路徑:點數不足 → null,不 throw", () => {
    for (const bad of [null, undefined, [], [TL], [TL, TR], [TL, TR, BR]]) {
      expect(orderCorners(bad)).toBeNull();
    }
    // 有 4 個元素但其中兩個座標非有限 → 有效點只剩 2 個
    expect(orderCorners([TL, TR, { x: NaN, y: 5 }, { x: 1, y: Infinity }])).toBeNull();
    expect(orderCorners([TL, TR, BR, null])).toBeNull();
  });

  it("退回路徑:四點共線 / 重複點(面積退化)→ null", () => {
    expect(orderCorners([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }])).toBeNull();
    expect(orderCorners([{ x: 0, y: 5 }, { x: 10, y: 5 }, { x: 20, y: 5 }, { x: 30, y: 5 }])).toBeNull();
    expect(orderCorners([TL, TL, TL, TL])).toBeNull();
    expect(orderCorners([TL, TR, TL, TR])).toBeNull();
  });

  // 只擋「完全共線」是不夠的:紙片狀四邊形照樣解得出 mapErr=0 的「合法」H,
  // warpPerspective 會把它拉伸成整張正射圖,下游還算得出看似正常的 maxWidthDeviation。
  // 階段 ⑤ 的 1D bearer bar 擬合失敗產出的正是這種近退化四邊形(規格 §3.3)。
  it("退回路徑:近退化(紙片狀)四邊形 → null,不只擋完全共線", () => {
    // 1000×0.001 的紙片:面積 1px²,舊版「面積 ≥ 1px² 就放行」的門檻正好放它過
    expect(orderCorners([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 0.001 }, { x: 0, y: 0.001 }])).toBeNull();
  });

  it("退化門檻:逐步縮高掃過最短邊門檻,門檻內回 null、門檻外通過", () => {
    // 寬度取 100:高度掃到 8px 時長寬比仍只有 12.5:1,遠在 maxAspectRatio 之內,
    // 才隔離得出「這一關是被 minEdgePx 擋的」(用 1000 寬會同時觸發長寬比,驗不到本項)。
    const strip = (hh: number) => orderCorners([
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: hh }, { x: 0, y: hh },
    ]);
    const limit = QUAD_CONFIDENCE_LIMITS.minEdgePx; // 8px:一條邊連一個模組都放不下
    // 門檻內(不足 8px 高)一律退回
    for (const hh of [0.001, 0.5, 2, 5, 7, limit - 1e-6]) expect(strip(hh)).toBeNull();
    // 門檻上與門檻外通過,且座標原封不動
    expect(strip(limit)).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 8 }, { x: 0, y: 8 }]);
    for (const hh of [limit + 1e-6, 12, 60, 400]) expect(strip(hh)).not.toBeNull();
  });

  it("退化門檻:最短邊 / 長寬比 / 填充率 各自單獨擋得住(與整體尺度無關)", () => {
    const L = QUAD_CONFIDENCE_LIMITS;
    const blockers = (q: { x: number; y: number }[]) => {
      const c = quadConfidence(q)!;
      return {
        edge: c.minEdgePx < L.minEdgePx,
        fill: c.fillRatio < L.minFillRatio,
        aspect: c.aspectRatio > L.maxAspectRatio,
        angle: c.minAngleDeg < L.minAngleDeg,
      };
    };

    // 只被最短邊擋:100×5,長寬比 20:1 仍合格、填充率 1、內角 90°
    const thin = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 5 }, { x: 0, y: 5 }];
    expect(blockers(thin)).toEqual({ edge: true, fill: false, aspect: false, angle: false });
    expect(orderCorners(thin)).toBeNull();

    // 只被長寬比擋:1000×12,最短邊 12px 合格、填充率 1、內角 90°,但 83:1 已不可能是任何 1D 符號
    const overLong = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 12 }, { x: 0, y: 12 }];
    expect(blockers(overLong)).toEqual({ edge: false, fill: false, aspect: true, angle: false });
    expect(orderCorners(overLong)).toBeNull();

    // 只被填充率擋:鏢形(其中一角向內凹),四邊都長、長寬比 1:1、最小內角 28° 皆合格
    const dart = [{ x: 0, y: 0 }, { x: 200, y: 60 }, { x: 400, y: 0 }, { x: 200, y: 200 }];
    expect(blockers(dart)).toEqual({ edge: false, fill: true, aspect: false, angle: false });
    expect(orderCorners(dart)).toBeNull();

    // 尖角四邊形:同時被填充率與最小內角擋下。
    // **最小內角無法單獨隔離**,這是幾何必然而非測試偷懶:凸四邊形 fillRatio 的下界 0.5
    // 恰好在「退化成三角形」時取到,而尖銳內角正意味著逼近三角形,故兩項必然重疊
    // (實測最接近的 trapA:內角 17.3° 時 fillRatio 已掉到 0.5167,仍在 0.55 之下)。
    const spike = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 300 }, { x: 40, y: 5 }];
    expect(blockers(spike)).toEqual({ edge: false, fill: true, aspect: false, angle: true });
    expect(orderCorners(spike)).toBeNull();
  });
});

describe("quadConfidence(四角擬合信心)", () => {
  it("門檻數字為規格 §3.3 的權威值,改動會在此暴露", () => {
    expect(QUAD_CONFIDENCE_LIMITS).toEqual({
      minEdgePx: 8,
      minFillRatio: 0.55,
      maxAspectRatio: 25,
      minAngleDeg: 20,
    });
  });

  it("正矩形:填充率 1、內角 90°、ok", () => {
    const c = quadConfidence([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]);
    expect(c.ok).toBe(true);
    expect(c.areaPx).toBeCloseTo(20000, 6);
    expect(c.fillRatio).toBeCloseTo(1, 6);
    expect(c.minAngleDeg).toBeCloseTo(90, 6);
    expect(c.minEdgePx).toBeCloseTo(100, 6);
  });

  it("正常透視梯形(上短下長)仍遠在三個門檻之上", () => {
    const c = quadConfidence([{ x: 40, y: 10 }, { x: 90, y: 10 }, { x: 120, y: 80 }, { x: 10, y: 80 }]);
    expect(c.ok).toBe(true);
    expect(c.minEdgePx).toBeGreaterThan(40);
    expect(c.fillRatio).toBeGreaterThan(0.6);
    expect(c.minAngleDeg).toBeGreaterThan(60);
  });

  it("45° 旋轉的正方形:填充率為 1(旋轉不變),不可誤殺旋轉", () => {
    // 分母改用最小面積外接矩形之後,正方形不論在畫面內轉幾度都是 1.0。
    // 舊的軸對齊定義在這裡會給 0.5 —— 同一個形狀因為「轉了 45 度」就掉一半,
    // 那正是 1D 長四邊形被誤殺的根因(見下方長寬比 × picket 掃描)。
    const c = quadConfidence([{ x: 100, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 200 }, { x: 0, y: 100 }]);
    expect(c.fillRatio).toBeCloseTo(1, 6);
    expect(c.aspectRatio).toBeCloseTo(1, 6);
    expect(c.ok).toBe(true);
  });

  // 迴歸保護:1D 長四邊形在「閘門本身放行的 picket 角」下不得被誤殺(規格 §3.3)。
  // 舊版填充率的分母是**軸對齊**外接框,對細長四邊形會隨畫面內旋轉急遽衰減 ——
  // 同一組形狀在舊定義下實測:10:1 轉 25°→0.2054、15:1 轉 20°→0.1712,雙雙跌破舊門檻 0.2,
  // 於是 orderCorners 回 null、靜默退回不矯正,而 picket 閘門對 25° 只判 WARN(明確放行)。
  // 規格 §3.3 說「一維是最硬的一段」,階段 ⑤ 的 bearer bar 擬合正是靠這道把關,
  // 誤殺的是合法輸入。改用最小面積外接矩形之後,填充率與畫面內旋轉無關。
  it("1D 長四邊形 × picket 角掃描:閘門放行(≤25°)的組合一律不得被誤殺", () => {
    // 長寬比 R 的矩形,在畫面內旋轉 deg 度(純旋轉,形狀本身沒有任何改變)
    const rotatedRect = (R: number, deg: number) => {
      const w = 100 * R, h = 100;
      const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
      return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => ({ x: x! * c - y! * s, y: x! * s + y! * c }));
    };
    // 4.5:1 = ITF-14 100%(總寬約 142.7mm / 條高 32mm);15:1 已比 GS1-128 最細長的 12.7:1 更嚴苛
    for (const R of [4.5, 7.5, 10, 15]) {
      for (const deg of [0, 10, 20, 25]) { // picket 閘門:≤10 OK、10–25 WARN,皆放行
        const c = quadConfidence(rotatedRect(R, deg))!;
        expect(c.fillRatio).toBeCloseTo(1, 6); // 旋轉不變:轉幾度都一樣
        expect(c.aspectRatio).toBeCloseTo(R, 6);
        expect(c.ok).toBe(true);
        expect(orderCorners(rotatedRect(R, deg))).not.toBeNull();
      }
    }
  });

  it("完全共線 / 重複點:填充率 0、不 ok", () => {
    expect(quadConfidence([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }]).ok).toBe(false);
    const same = { x: 7, y: 7 };
    const c = quadConfidence([same, same, same, same]);
    expect(c.ok).toBe(false);
    expect(c.fillRatio).toBe(0);
    expect(c.minEdgePx).toBe(0);
  });

  it("點數不足 / 非有限座標 → null,不 throw", () => {
    expect(quadConfidence(null)).toBeNull();
    expect(quadConfidence([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    expect(quadConfidence([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])).toBeNull();
  });
});

describe("targetRectSize(正射目標矩形尺寸)", () => {
  it("寬取上下兩邊的最大值、高取左右兩邊的最大值(不降取樣掉解析度)", () => {
    // 上邊 100、下邊 140;左邊 80、右邊 hypot(40,80)=89.4
    const quad = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 140, y: 80 }, { x: 0, y: 80 }];
    expect(targetRectSize(quad)).toEqual({ w: 140, h: 89 });
  });

  it("正矩形:原尺寸(四捨五入)", () => {
    expect(targetRectSize([{ x: 10, y: 10 }, { x: 210, y: 10 }, { x: 210, y: 60 }, { x: 10, y: 60 }]))
      .toEqual({ w: 200, h: 50 });
  });

  it("退回路徑:點數不足 → null;退化四邊形至少 1×1,不回 0 面積", () => {
    expect(targetRectSize(null)).toBeNull();
    expect(targetRectSize([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toBeNull();
    const zero = { x: 7, y: 7 };
    expect(targetRectSize([zero, zero, zero, zero])).toEqual({ w: 1, h: 1 });
  });
});

describe("solveHomography(DLT + 8×8 高斯消去)", () => {
  const rect = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
  const quad = [{ x: 20, y: 12 }, { x: 180, y: 4 }, { x: 200, y: 90 }, { x: 8, y: 70 }];

  it("src=dst → 單位矩陣(h33 固定為 1)", () => {
    const H = solveHomography(rect, rect);
    expect(H).not.toBeNull();
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (let i = 0; i < 9; i++) expect(H[i]).toBeCloseTo(I[i]!, 9);
  });

  it("解出的 H 把 src 四點準確映射到 dst 四點(往返皆成立)", () => {
    const H = solveHomography(quad, rect);
    expect(H).not.toBeNull();
    expect(H[8]).toBe(1);
    for (let i = 0; i < 4; i++) {
      const p = applyH(H, quad[i]!);
      expect(p.x).toBeCloseTo(rect[i]!.x, 6);
      expect(p.y).toBeCloseTo(rect[i]!.y, 6);
    }
    // 反方向也解得出來,且與正向互為反矩陣(合成後回到原點)
    const Hi = solveHomography(rect, quad);
    expect(Hi).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      const p = applyH(Hi, applyH(H, quad[i]!));
      expect(p.x).toBeCloseTo(quad[i]!.x, 6);
      expect(p.y).toBeCloseTo(quad[i]!.y, 6);
    }
  });

  it("大座標(4032px 級)仍解得出來,不被奇異判定誤殺", () => {
    const big = [{ x: 120, y: 90 }, { x: 3900, y: 40 }, { x: 4010, y: 2900 }, { x: 60, y: 2800 }];
    const dst = [{ x: 0, y: 0 }, { x: 3800, y: 0 }, { x: 3800, y: 2700 }, { x: 0, y: 2700 }];
    const H = solveHomography(big, dst);
    expect(H).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      expect(applyH(H, big[i]!).x).toBeCloseTo(dst[i]!.x, 3);
      expect(applyH(H, big[i]!).y).toBeCloseTo(dst[i]!.y, 3);
    }
  });

  it("退回路徑:四點共線 → null(絕不回 NaN 矩陣)", () => {
    const collinear = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }];
    expect(solveHomography(collinear, rect)).toBeNull();
    expect(solveHomography(rect, collinear)).toBeNull();
    // 三點共線 + 一點離群也是退化(無法決定唯一單應)
    const threeOnLine = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 5, y: 40 }];
    const H = solveHomography(threeOnLine, rect);
    expect(H === null || H.every((v: number) => Number.isFinite(v))).toBe(true);
  });

  it("退回路徑:dst 四點重合(H 奇異)→ null", () => {
    const same = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
    expect(solveHomography(rect, same)).toBeNull();
    expect(solveHomography(same, rect)).toBeNull();
  });

  it("退回路徑:點數不足 / 非有限座標 → null,不 throw", () => {
    expect(solveHomography(rect.slice(0, 3), rect)).toBeNull();
    expect(solveHomography(rect, rect.slice(0, 3))).toBeNull();
    expect(solveHomography(null, null)).toBeNull();
    expect(solveHomography(undefined, rect)).toBeNull();
    expect(solveHomography([{ x: NaN, y: 0 }, ...rect.slice(1)], rect)).toBeNull();
  });
});

describe("warpPerspective(反向映射 + 雙線性內插)", () => {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  it("單位矩陣 → 逐像素原樣複製", () => {
    const src = grayFrom(5, 4, (x, y) => (x * 37 + y * 11) % 256);
    const out = warpPerspective(src, 5, 4, I, 5, 4);
    expect(out.w).toBe(5);
    expect(out.h).toBe(4);
    expect(Array.from(out.data)).toEqual(Array.from(src));
  });

  it("半像素平移:取相鄰兩點的平均,證明用的是雙線性而非最近鄰", () => {
    const src = new Uint8ClampedArray([0, 100, 200, 255]);
    // 來源→輸出 平移 +0.5px,故輸出 x 對應來源 x−0.5
    const out = warpPerspective(src, 4, 1, [1, 0, 0.5, 0, 1, 0, 0, 0, 1], 4, 1);
    expect(out.data[1]).toBe(50);   // (0+100)/2 —— 最近鄰只會給 0 或 100
    expect(out.data[2]).toBe(150);  // (100+200)/2
  });

  it("來源座標落在影像外:夾取邊界像素(不是填 0)", () => {
    // 左右兩端為亮靜區:若越界填 0(全黑)會在正射影像邊緣造出假的暗 run
    const src = new Uint8ClampedArray([220, 40, 40, 220]);
    const out = warpPerspective(src, 4, 1, [1, 0, 2, 0, 1, 0, 0, 0, 1], 4, 1);
    expect(out.data[0]).toBe(220);
    expect(out.data[1]).toBe(220);
    expect(out.data[2]).toBe(220); // 來源 x=0
  });

  it("輸出尺寸與來源不同時,依 H 重採樣(縮小一半)", () => {
    const src = grayFrom(8, 8, (x) => (x < 4 ? 40 : 220));
    // 來源→輸出 縮小 0.5 倍
    const out = warpPerspective(src, 8, 8, [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1], 4, 4);
    expect(out.w).toBe(4);
    expect(out.data[0]).toBe(40);
    expect(out.data[3]).toBe(220);
  });

  it("退回路徑:H 為 null / 奇異 / 含 NaN → null,不 throw", () => {
    const src = grayFrom(4, 4, () => 128);
    expect(warpPerspective(src, 4, 4, null, 4, 4)).toBeNull();
    expect(warpPerspective(src, 4, 4, [1, 2, 3, 2, 4, 6, 3, 6, 9], 4, 4)).toBeNull(); // rank 1
    expect(warpPerspective(src, 4, 4, [0, 0, 5, 0, 0, 7, 0, 0, 1], 4, 4)).toBeNull(); // 全部映到同一點
    expect(warpPerspective(src, 4, 4, [NaN, 0, 0, 0, 1, 0, 0, 0, 1], 4, 4)).toBeNull();
    expect(warpPerspective(src, 4, 4, [1, 0, 0, 0, 1, 0, 0, 0], 4, 4)).toBeNull(); // 長度不是 9
  });

  // 輸出面積預算(規格 §3.1「記憶體護欄(硬性)」):階段 ④ 接上 4032×3024 時
  // targetRectSize 最壞可給到影像對角線量級(約 5040)→ 25M 像素、25MB 陣列與同步的
  // 雙線性重採樣迴圈。與 fitRoiToBudget / mobile.html 的 MAX_ROI_PIXELS 同一條護欄。
  describe("輸出面積預算", () => {
    it("常數與 mobile.html 的 MAX_ROI_PIXELS 同值(4e6)", () => {
      expect(MAX_WARP_PIXELS).toBe(4e6);
    });

    it("未超預算:尺寸即請求值,scale=1", () => {
      const src = grayFrom(8, 8, (x) => x * 10);
      const out = warpPerspective(src, 8, 8, I, 8, 8);
      expect([out.w, out.h, out.scale]).toEqual([8, 8, 1]);
    });

    it("超過預設預算(5040×5040 ≈ 25M):等比縮進 4e6 內並回報 scale", () => {
      const src = grayFrom(4, 4, () => 128);
      const out = warpPerspective(src, 4, 4, I, 5040, 5040);
      expect(out.w * out.h).toBeLessThanOrEqual(MAX_WARP_PIXELS);
      expect(out.w).toBeLessThan(5040);
      expect(out.scale).toBeCloseTo(out.w / 5040, 10);
      expect(out.scale).toBeLessThan(1);
      expect(out.w / out.h).toBeCloseTo(1, 2); // 長寬比不變
      expect(out.data.length).toBe(out.w * out.h);
    });

    it("縮小輸出仍取到正確的來源像素(取樣變稀,不是換一張圖)", () => {
      // 來源亮度 = 2x,單位矩陣;請求 100×100、預算 100 → 輸出 10×10、取樣格距 10
      const src = grayFrom(100, 100, (x) => x * 2);
      const out = warpPerspective(src, 100, 100, I, 100, 100, 100);
      expect([out.w, out.h]).toEqual([10, 10]);
      expect(out.scale).toBeCloseTo(0.1, 10);
      for (const x of [0, 1, 5, 9]) expect(out.data[x]).toBe(x * 20);
      expect(out.data[9 * 10 + 3]).toBe(60); // 各列相同,證明 y 方向格距也套上了
    });

    it("maxPixels 非有限正數 → 不設上限(與 fitRoiToBudget 同語意)", () => {
      const src = grayFrom(4, 4, () => 128);
      // Infinity:連預設的 4e6 都不套用(請求 2100×2000 = 4.2M > 預設預算)
      const big = warpPerspective(src, 4, 4, I, 2100, 2000, Infinity);
      expect([big.w, big.h, big.scale]).toEqual([2100, 2000, 1]);
      // 其餘非有限正數同語意:不得被當成「預算極小」而縮到 1×1
      for (const noLimit of [0, -1, NaN, null]) {
        const out = warpPerspective(src, 4, 4, I, 500, 400, noLimit);
        expect([out.w, out.h, out.scale]).toEqual([500, 400, 1]);
      }
      // 對照組:給得出的小預算確實會縮
      expect(warpPerspective(src, 4, 4, I, 500, 400, 100).w).toBeLessThan(500);
    });
  });

  it("退回路徑:來源或輸出尺寸不合法 → null,不 throw", () => {
    const src = grayFrom(4, 4, () => 128);
    expect(warpPerspective(null, 4, 4, I, 4, 4)).toBeNull();
    expect(warpPerspective(src, 0, 4, I, 4, 4)).toBeNull();
    expect(warpPerspective(src, 4, 4, I, 0, 4)).toBeNull();
    expect(warpPerspective(src, 4, 4, I, 4, NaN)).toBeNull();
    expect(warpPerspective(src, 40, 40, I, 4, 4)).toBeNull(); // 宣稱的尺寸大於實際緩衝區
  });
});

// ── 合成梯形變形:針孔相機 + 已知傾角(規格 §5.4 的核心判準)────────────
// 相機模型固定(無亂數):焦距 900px、900×600 影像、主點在中心、平面距離 833。
// 平面上鋪的是特性化測試那張條碼(CHAR_PATTERN,已知每個元素的模組數),
// 繞相機座標的 Y 軸(畫面垂直軸)或 X 軸旋轉指定角度後投影成「拍攝影像」。
// 繞 Y 軸是規格 §1.4 描述的情境:同一條掃描線上近端模組寬、遠端窄。
const CAM = { w: 900, h: 600, f: 900, cx: 450, cy: 300, dist: 833 };

// 平面座標 (s,t) → 相機座標(繞指定軸轉 deg 度,平面中心在光軸上)
function planePoint(axis: "x" | "y", s: number, t: number, deg: number): number[] {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
  return axis === "x" ? [s, t * c, t * sn] : [s * c, t, -s * sn];
}
// 針孔投影:相機座標 → 影像座標
function project(P: number[]): Pt {
  const Z = P[2]! + CAM.dist;
  return { x: (CAM.f * P[0]!) / Z + CAM.cx, y: (CAM.f * P[1]!) / Z + CAM.cy };
}
// 把正射位元圖當成貼在平面上的標籤,合成一張「傾斜拍攝」的影像。
// 輸出:{ img(相機影像), quad(標籤四角在影像中的位置)}。完全決定於參數,無亂數。
function renderTilted(ortho: { gray: Uint8ClampedArray; w: number; h: number }, tiltDeg: number, axis: "x" | "y" = "y") {
  const corners = rectCorners({ w: ortho.w, h: ortho.h });
  const quad: Pt[] = corners.map((c) =>
    project(planePoint(axis, c.x - (ortho.w - 1) / 2, c.y - (ortho.h - 1) / 2, tiltDeg)));
  const H = solveHomography(corners, quad); // 正射 → 影像
  const img = warpPerspective(ortho.gray, ortho.w, ortho.h, H, CAM.w, CAM.h);
  return { img, quad };
}
// 走完整條矯正管線:四角排序 → 目標尺寸 → 單應 → 正射重採樣
function rectify(img: { data: Uint8ClampedArray; w: number; h: number }, quad: Pt[]) {
  const ordered = orderCorners(quad);
  const size = targetRectSize(ordered);
  const H = solveHomography(ordered, rectCorners(size)); // 影像 → 正射
  return { H, size, flat: warpPerspective(img.data, img.w, img.h, H, size.w, size.h) };
}
// 取 ROI 子影像(測試自用,對應 imgproc 內部的 roiSlice)
function cropGray(gray: Uint8ClampedArray, w: number, roi: { x0: number; y0: number; x1: number; y1: number }) {
  const rw = roi.x1 - roi.x0, rh = roi.y1 - roi.y0;
  const out = new Uint8ClampedArray(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) out[y * rw + x] = gray[(roi.y0 + y) * w + (roi.x0 + x)]!;
  }
  return { data: out, w: rw, h: rh };
}
// 每個元素的「實測模組寬」:中間掃描線的 run 長度 ÷ 該元素已知的模組數。
// 正射時各元素應給出同一個模組寬(變異數≈0);透視傾斜時近端寬、遠端窄。
function moduleWidthStats(gray: Uint8ClampedArray, w: number, roi: { x0: number; y0: number; x1: number; y1: number }) {
  const r = cropGray(gray, w, roi);
  const t = otsu(r.data);
  const row = r.data.subarray(Math.floor(r.h / 2) * r.w, (Math.floor(r.h / 2) + 1) * r.w);
  // 去頭尾兩段靜區後,剩下的 run 與 CHAR_PATTERN 前 23 個元素一一對應
  const runs = scanlineRuns(row, t).slice(1, -1) as { len: number }[];
  const per = runs.map((run, i) => run.len / CHAR_PATTERN[i]!);
  const mean = per.reduce((a, b) => a + b, 0) / per.length;
  const variance = per.reduce((a, b) => a + (b - mean) ** 2, 0) / per.length;
  return { n: runs.length, mean, variance, min: Math.min(...per), max: Math.max(...per) };
}
// 該 ROI 所有掃描線的最大 maxWidthDeviation(DEC proxy)
function decMaxDev(gray: Uint8ClampedArray, w: number, roi: { x0: number; y0: number; x1: number; y1: number }) {
  const g = roi1DGeometry(gray, w, roi);
  return Math.max(...g.scanlines.map((s: { maxWidthDeviation: number }) => s.maxWidthDeviation));
}
// 傾斜四邊形的內接矩形 ROI(完全落在標籤內,不吃到 warp 邊界外的複製像素)
function innerRoi(quad: Pt[]) {
  return {
    x0: Math.ceil(Math.max(quad[0]!.x, quad[3]!.x)),
    x1: Math.floor(Math.min(quad[1]!.x, quad[2]!.x)),
    y0: Math.ceil(Math.max(quad[0]!.y, quad[1]!.y)),
    y1: Math.floor(Math.min(quad[2]!.y, quad[3]!.y)),
  };
}

describe("合成梯形變形 → 矯正(規格 §5.4)", () => {
  const ORTHO = charBarcodeAt(12, 120); // 652×120,每模組 12px

  // 傾斜拍攝把「拍攝問題」記成「印刷缺陷」(規格 §1.4),矯正後應該還回去。
  // 2026-07-31 實測(繞 Y 軸 25°、每模組 12px):
  //   模組寬變異數 1.926 → 0.028(約 69 倍),模組寬 10.0–14.5px → 12.0–12.5px
  //   maxWidthDeviation 0.5000 → 0.0833
  // 矯正後的 0.0833 不是演算法殘差,而是「每模組 12px 下 ±1px 量化」的底限
  // —— 同一張圖不傾斜拍(0°)量到的也是 0.0769,見上方取樣密度特性化測試。
  it("繞 Y 軸 25°:模組寬變異數大幅下降,maxWidthDeviation 回到量化底限", () => {
    const { img, quad } = renderTilted(ORTHO, 25, "y");
    const roi = innerRoi(quad);
    const before = moduleWidthStats(img.data, img.w, roi);
    const beforeDev = decMaxDev(img.data, img.w, roi);

    const { size, flat } = rectify(img, quad);
    const froi = { x0: 0, y0: 0, x1: flat.w, y1: flat.h };
    const after = moduleWidthStats(flat.data, flat.w, froi);
    const afterDev = decMaxDev(flat.data, flat.w, froi);

    // 兩邊都要真的量到 23 個元素,否則下面的比較沒有意義
    expect(before.n).toBe(23);
    expect(after.n).toBe(23);

    // ① 模組寬變異數顯著下降(至少 10 倍)
    expect(before.variance).toBeGreaterThan(1.5);
    expect(after.variance).toBeLessThan(before.variance / 10);
    // ② 矯正前同一條掃描線上模組寬差距懸殊,矯正後幾乎一致
    expect(before.max / before.min).toBeGreaterThan(1.4);
    expect(after.max / after.min).toBeLessThan(1.1);
    // ③ DEC proxy 從 0.5 掉回量化底限
    expect(beforeDev).toBeCloseTo(0.5, 3);
    expect(afterDev).toBeCloseTo(0.0833, 3);
    expect(afterDev).toBeLessThan(beforeDev / 5);
    // ④ 此情境(25°)矯正後寬度不低於符號原寬:652 → 656。
    //    注意兩件事:
    //    (a) 繞 Y 軸時上下兩邊在影像中等長,拿 quad 上邊的水平投影當右式近乎恆真,
    //        驗不到「取 max 而非 avg」—— 該語意改由下一個測試(繞 X 軸)驗。
    //    (b) 這**不是**通則:同一張圖繞 Y 軸 40° 時 size.w = 576 < 652,取最大值只能
    //        少損失一部分解析度,擋不住整體被壓低(見 targetRectSize 的 JSDoc)。
    expect(size.w).toBeGreaterThanOrEqual(ORTHO.w);
  });

  // 繞 X 軸(畫面水平軸)旋轉時上下兩邊才會不等長,才驗得到 targetRectSize 的
  // 「取最大值」語意 —— 若改成取平均,size.w 會掉到兩邊的中間值。
  it("繞 X 軸 30°:目標矩形寬取上下兩邊的最大值,不是平均", () => {
    const { quad } = renderTilted(ORTHO, 30, "x");
    const ordered = orderCorners(quad) as Pt[];
    const d = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);
    const top = d(ordered[0]!, ordered[1]!), bottom = d(ordered[3]!, ordered[2]!);
    const size = targetRectSize(ordered);

    // 前提:這個情境的上下兩邊真的不等長(否則本測試同樣是恆真的)
    expect(Math.abs(top - bottom)).toBeGreaterThan(20);
    expect(size.w).toBe(Math.round(Math.max(top, bottom)));
    expect(size.w).toBeGreaterThan((top + bottom) / 2); // 取平均會落在這裡
  });

  it("繞 Y 軸 12°(較輕微)同樣改善,且矯正後不比未傾斜拍攝差", () => {
    const { img, quad } = renderTilted(ORTHO, 12, "y");
    const roi = innerRoi(quad);
    const beforeDev = decMaxDev(img.data, img.w, roi);
    const { flat } = rectify(img, quad);
    const afterDev = decMaxDev(flat.data, flat.w, { x0: 0, y0: 0, x1: flat.w, y1: flat.h });
    expect(beforeDev).toBeCloseTo(0.25, 3);
    expect(afterDev).toBeCloseTo(0.0769, 3);

    // 未傾斜(0°)拍同一張的基準值,矯正後不應該比它差
    const flat0 = renderTilted(ORTHO, 0, "y");
    const base = decMaxDev(flat0.img.data, flat0.img.w, innerRoi(flat0.quad));
    expect(afterDev).toBeLessThanOrEqual(base + 1e-9);
  });

  it("矯正結果完全決定於輸入(無亂數,跑兩次逐像素相同)", () => {
    const a = rectify(renderTilted(ORTHO, 25, "y").img, renderTilted(ORTHO, 25, "y").quad);
    const b = rectify(renderTilted(ORTHO, 25, "y").img, renderTilted(ORTHO, 25, "y").quad);
    expect(a.size).toEqual(b.size);
    expect(Array.from(a.flat.data)).toEqual(Array.from(b.flat.data));
  });
});

describe("tiltFromHomography(由單應矩陣推透視傾角)", () => {
  const ORTHO = charBarcodeAt(12, 120);

  // 規格 §5.4:對已知傾角的合成變形,誤差須在 ±1° 內。
  // 消失線只由 H 的前兩欄決定,與目標矩形的尺度、長寬比無關,故 targetRectSize
  // 的估計誤差不會傳進角度 —— 下面兩軸、七個角度實測誤差皆 < 0.001°。
  it("繞 Y 軸(畫面垂直軸)0–40°:誤差在 ±1° 內", () => {
    for (const deg of [0, 5, 12, 25, 30, 35, 40]) {
      const { img, quad } = renderTilted(ORTHO, deg, "y");
      const { H } = rectify(img, quad);
      expect(tiltFromHomography(H, CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(deg, 1);
    }
  });

  it("繞 X 軸(畫面水平軸)0–35°:誤差同樣在 ±1° 內", () => {
    for (const deg of [0, 8, 20, 35]) {
      const { img, quad } = renderTilted(ORTHO, deg, "x");
      const { H } = rectify(img, quad);
      expect(tiltFromHomography(H, CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(deg, 1);
    }
  });

  it("閘門語意:5° 門檻兩側判得出來(4° 過、8° 不過)", () => {
    const under = renderTilted(ORTHO, 4, "y"), over = renderTilted(ORTHO, 8, "y");
    expect(tiltFromHomography(rectify(under.img, under.quad).H, CAM.f, CAM.cx, CAM.cy)).toBeLessThan(5);
    expect(tiltFromHomography(rectify(over.img, over.quad).H, CAM.f, CAM.cx, CAM.cy)).toBeGreaterThan(5);
  });

  // 「不可得」必須與「真的沒傾斜」分得開:gate.ts 的語意是 ≤5° 否則 FAIL,
  // 0 度是**最寬鬆的放行值**而不是安全值,代填 0 等於讓透視閘門永遠綠燈
  // (規格 §1.3 批判的 state.gate.tilt = 0 是同一個病灶)。
  it("退回路徑:H 為 null / 奇異 / 含 NaN → 回 null(不可得),不 throw", () => {
    expect(tiltFromHomography(null, 900, 450, 300)).toBeNull();
    expect(tiltFromHomography(undefined, 900, 450, 300)).toBeNull();
    expect(tiltFromHomography([1, 2, 3, 2, 4, 6, 3, 6, 9], 900, 450, 300)).toBeNull(); // rank 1
    expect(tiltFromHomography([NaN, 0, 0, 0, 1, 0, 0, 0, 1], 900, 450, 300)).toBeNull();
    expect(tiltFromHomography([1, 0, 0, 0, 1, 0, 0, 0], 900, 450, 300)).toBeNull(); // 長度不是 9
  });

  it("退回路徑:焦距不可得 → 回 null,絕不回 0(0 是閘門的放行值)", () => {
    const { img, quad } = renderTilted(ORTHO, 25, "y");
    const { H } = rectify(img, quad);
    // 瀏覽器的 MediaStreamTrack 一般拿不到像素焦距,這是接線後的常態路徑
    for (const bad of [undefined, null, 0, -900, -1e-9, NaN, Infinity, -Infinity, "900"]) {
      const r = tiltFromHomography(H, bad, CAM.cx, CAM.cy);
      expect(r).toBeNull();
      expect(r).not.toBe(0); // null 與 0 在 gate.ts 的 ≤5° 語意下是天差地別的兩件事
    }
    // 同一個 H 給得到焦距時仍算得出原本的角度(回歸保護:不可得的處理不得動到數值)
    expect(tiltFromHomography(H, CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(25, 1);
  });

  it("主點不可得(cx/cy 省略或非有限)仍算得出角度,只有焦距是硬條件", () => {
    const { img, quad } = renderTilted(ORTHO, 25, "y");
    const { H } = rectify(img, quad);
    // 主點預設 0 / 非有限值退回 0,都不是「不可得」—— 不得回 null
    expect(tiltFromHomography(H, CAM.f)).not.toBeNull();
    expect(tiltFromHomography(H, CAM.f, NaN, undefined)).toBe(tiltFromHomography(H, CAM.f, 0, 0));
  });

  it("正射(完全無透視)→ 0°", () => {
    const rect = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }];
    const moved = rect.map((p) => ({ x: p.x * 1.3 + 50, y: p.y * 1.3 + 20 })); // 純縮放平移
    const H = solveHomography(moved, rect);
    expect(tiltFromHomography(H, CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(0, 6);
  });
});
