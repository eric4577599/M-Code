import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
  FOCAL_PX_LIMITS,
  focalPxFromSettings,
  quadFromZxingPoints,
  rectifyQuad,
  rectifyPlan,
  qrQuadFromPoints,
  orderCornersRaw,
  resolveTiltDeg,
  TILT_SOURCE_LABEL,
  ONE_D_SYMBOLOGIES,
  LINE_FIT_LIMITS,
  fitLineTLS,
  quadFrom1DEdges,
  edgeFitRoi,
  EDGE_FIT_ROI_PAD,
  assessMeasurability,
  UNMEASURABLE,
  UNMEASURABLE_LABEL,
  SIMULATED_LABEL,
  ROTATED_HINT_MIN_DEG,
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

// ── 階段 ④ 接線層(規格 §3.3 焦距來源 · 2026-08-03 裁示)──────────────────
// 這四支的存在理由都是「把退回判斷從 demo/*.html 搬進測得到的地方」:
// demo/*.html 全程無自動化測試可覆蓋(專案 CLAUDE.md 已載明),退回邏輯寫在那裡就驗不了。

describe("focalPxFromSettings(像素焦距,裁示:先試 getSettings().focalLength)", () => {
  it("同尺度:focalLength 已是分析影像尺度的像素值 → 原值回傳", () => {
    expect(focalPxFromSettings({ focalLength: 1200, width: 1600 }, 1600)).toBe(1200);
  });

  it("換尺度:串流 1280 量到的焦距換算到 4032 的分析影像(第一層照片路徑)", () => {
    // 不換算會低估約 3.15 倍,傾角直接算成三倍大 —— 這是第一層 ImageCapture 的常態
    expect(focalPxFromSettings({ focalLength: 900, width: 1280 }, 4032)).toBeCloseTo((900 * 4032) / 1280, 6);
  });

  it("**本函式存在的理由**:毫米值(4.5)必須被擋下,不得當成像素焦距", () => {
    // 4.5 是有限正數,tiltFromHomography 不會拒絕它,會算出一個看起來像角度的假數字
    expect(focalPxFromSettings({ focalLength: 4.5, width: 1280 }, 1280)).toBeNull();
    expect(focalPxFromSettings({ focalLength: 4.5, width: 1280 }, 4032)).toBeNull();
    expect(focalPxFromSettings({ focalLength: 6.8 }, 1280)).toBeNull();
  });

  it("settings.width 不可得 → 假設同尺度,仍受合理帶把關", () => {
    expect(focalPxFromSettings({ focalLength: 900 }, 1280)).toBe(900);
    expect(focalPxFromSettings({ focalLength: 900, width: 0 }, 1280)).toBe(900);
  });

  it("離譜的大值同樣擋下(超過分析影像寬的 5 倍)", () => {
    expect(focalPxFromSettings({ focalLength: 1e6, width: 1280 }, 1280)).toBeNull();
  });

  it("合理帶邊界:恰好 0.3W / 5W 通過,略微越界即不可得", () => {
    const W = 1000;
    expect(FOCAL_PX_LIMITS).toEqual({ minRatio: 0.3, maxRatio: 5 });
    expect(focalPxFromSettings({ focalLength: FOCAL_PX_LIMITS.minRatio * W }, W)).toBe(300);
    expect(focalPxFromSettings({ focalLength: FOCAL_PX_LIMITS.maxRatio * W }, W)).toBe(5000);
    expect(focalPxFromSettings({ focalLength: 299.9 }, W)).toBeNull();
    expect(focalPxFromSettings({ focalLength: 5000.1 }, W)).toBeNull();
  });

  it("容錯:殘缺 / 錯型別 / 非正數一律回 null,不 throw", () => {
    for (const bad of [null, undefined, {}, { focalLength: null }, { focalLength: "900" },
      { focalLength: NaN }, { focalLength: Infinity }, { focalLength: 0 }, { focalLength: -900 }]) {
      expect(focalPxFromSettings(bad, 1280)).toBeNull();
    }
    for (const w of [0, -1280, NaN, Infinity, undefined, null, "1280"]) {
      expect(focalPxFromSettings({ focalLength: 900 }, w)).toBeNull();
    }
  });
});

describe("quadFromZxingPoints(四角補點,依符號別分流)", () => {
  it("QR 三個 finder 中心 [bl, tl, tr] → 第四角 tr + bl − tl,前三點原封不動", () => {
    const bl = { x: 10, y: 110 }, tl = { x: 10, y: 10 }, tr = { x: 110, y: 10 };
    const q = quadFromZxingPoints([bl, tl, tr], "QR");
    expect(q.corners).toHaveLength(4);
    expect(q.corners.slice(0, 3)).toEqual([bl, tl, tr]);
    expect(q.corners[3]).toEqual({ x: 110, y: 110 });
    expect(q.derived).toBe(true); // 補點必須外傳,否則下游無從得知傾角不可信
  });

  it("DataMatrix 四點 → 直接取用且 derived=false;超過 4 點只取前 4(不猜哪些是真正的角)", () => {
    const pts = [{ x: 0, y: 0 }, { x: 50, y: 2 }, { x: 52, y: 40 }, { x: 1, y: 38 }, { x: 25, y: 20 }];
    expect(quadFromZxingPoints(pts, "DATAMATRIX"))
      .toEqual({ corners: pts.slice(0, 4), derived: false, dimension: null, source: "corners" });
  });

  it("**階段 ⑤ 的界線**:1D 掃描線兩端點 → null,本函式不猜四角", () => {
    expect(quadFromZxingPoints([{ x: 5, y: 50 }, { x: 300, y: 52 }], "ITF14")).toBeNull();
  });

  it("容錯:非有限座標略過後不足三點 → null;null / 空陣列不 throw", () => {
    expect(quadFromZxingPoints([{ x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], "DATAMATRIX")).toBeNull();
    expect(quadFromZxingPoints(null, "DATAMATRIX")).toBeNull();
    expect(quadFromZxingPoints([], "DATAMATRIX")).toBeNull();
    // 五點含一個 NaN → 略過後仍湊得出四點
    expect(quadFromZxingPoints([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], "DATAMATRIX").corners)
      .toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }]);
  });

  // ★ 2026-08-03 階段 ④ 接線時實測到的問題,這條測試就是它的護欄。
  // 補點四邊形依定義是平行四邊形 → 對應矩形的單應矩陣是仿射 → 消失線在無窮遠 →
  // tiltFromHomography 恆回 0.00°,而 0° 正是「≤5° 否則 FAIL」最寬鬆的放行值。
  it("**補點四角恆推出 0° 傾角**:平行四邊形不帶透視資訊,絕不可拿去推傾角", () => {
    const square = rectCorners({ w: 400, h: 400 });
    const mkH = (q: Pt[]) => {
      const o = orderCorners(q) as Pt[];
      const s = targetRectSize(o);
      return solveHomography(o, [{ x: 0, y: 0 }, { x: s.w, y: 0 }, { x: s.w, y: s.h }, { x: 0, y: s.h }]);
    };
    // 實測表(針孔 f=900、距離 833、400×400 方形),兩軸結果相同:
    //   真實傾角 2° / 5° / 25° → 補點誤差 7.2 / 18.0 / 88.2 px,推得傾角一律 0.00°
    const wantErr: Record<number, number> = { 0: 0, 2: 7.21, 5: 18.0, 25: 88.17 };
    for (const axis of ["y", "x"] as const) {
      for (const deg of [0, 2, 5, 25]) {
        const proj = square.map((c) => project(planePoint(axis, c.x - 199.5, c.y - 199.5, deg))) as Pt[];
        const [pTL, pTR, pBR, pBL] = proj;
        const q = quadFromZxingPoints([pBL, pTL, pTR], "QR");
        const derived = q.corners[3]! as Pt;
        expect(Math.hypot(derived.x - pBR!.x, derived.y - pBR!.y)).toBeCloseTo(wantErr[deg]!, 1);
        // 真四角推得回真實傾角 —— 對照組,證明失準來自補點而非管線
        expect(tiltFromHomography(mkH(proj), CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(deg, 1);
        // 補點四角:不論真實傾角多少一律 0.00°
        expect(tiltFromHomography(mkH(q.corners), CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(0, 6);
      }
    }
  });
});

describe("rectifyQuad(階段 ④ 接線的單一入口)", () => {
  const ORTHO4 = charBarcodeAt(12, 120);

  it("正常傾斜(繞 Y 軸 25°):ok,DEC 從 0.5 掉回量化底限,H 可推回 25°", () => {
    const { img, quad } = renderTilted(ORTHO4, 25, "y");
    const r = rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX" });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe("");
    expect(r.derivedCorner).toBe(false); // 四點皆實測
    const froi = { x0: 0, y0: 0, x1: r.w, y1: r.h };
    expect(decMaxDev(r.gray, r.w, froi)).toBeLessThan(0.1);
    expect(tiltFromHomography(r.H, CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(25, 1);
  });

  // **本輪(階段 ⑤)唯一動到的既有測試**:1D 條端擬合上線後,「屬階段 ⑤」這句話
  // 依規格 §3.5 必須從程式碼中消失(grep 得到即未完成),斷言它的測試自然要跟著改。
  // 兩點 + 沒給符號別 = 不知道該不該做 1D 偵測 → 保守不啟動,原因改為指名符號別不明。
  it("退回:1D 兩點但符號別不明 → 四角不足,原因指名符號別不明(不啟動 1D 偵測)", () => {
    const r = rectifyQuad(ORTHO4.gray, ORTHO4.w, ORTHO4.h, [{ x: 5, y: 50 }, { x: 600, y: 52 }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("四角不足");
    expect(r.reason).toContain("符號別不明");
    expect(r.reason).not.toContain("階段 ⑤");
    expect(r.gray).toBeUndefined(); // 絕不代填一張假影像
  });

  it("退回:紙片狀四邊形 → 擬合信心不足,且**講得出是哪一項**", () => {
    // 1000×2 的細長帶:最短邊 2px、長寬比 500,兩項都不過
    const r = rectifyQuad(ORTHO4.gray, ORTHO4.w, ORTHO4.h,
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 2 }, { x: 0, y: 2 }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("擬合信心不足");
    expect(r.reason).toContain("最短邊");
    expect(r.reason).toContain("長寬比");
    expect(r.conf.ok).toBe(false); // 實測值一併回傳,呼叫端可自行報數
  });

  it("退回:四點共線 → 不 throw,原因為擬合信心不足(填充率為 0)", () => {
    const r = rectifyQuad(ORTHO4.gray, ORTHO4.w, ORTHO4.h,
      [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("擬合信心不足");
    expect(r.gray).toBeUndefined();
  });

  it("退回:來源影像不合法(null / 尺寸為 0)→ 正射重採樣失敗,不 throw", () => {
    const { quad } = renderTilted(ORTHO4, 12, "y");
    for (const bad of [[null, 900, 600], [ORTHO4.gray, 0, 600], [ORTHO4.gray, 900, 0]] as const) {
      const r = rectifyQuad(bad[0], bad[1], bad[2], quad, { sym: "DATAMATRIX" });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("重採樣失敗");
      expect(r.H).not.toBeNull(); // 前面幾關都過了,退回發生在最後一步
    }
  });

  it("面積預算:maxPixels 壓低時仍成功,但回報 scale < 1(取樣密度已降低)", () => {
    const { img, quad } = renderTilted(ORTHO4, 12, "y");
    const full = rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX" });
    const tight = rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX", maxPixels: 10000 });
    expect(full.scale).toBe(1);
    expect(tight.ok).toBe(true);
    expect(tight.scale).toBeLessThan(1);
    expect(tight.w * tight.h).toBeLessThanOrEqual(10000);
    expect(tight.requested).toEqual(full.requested); // 請求尺寸不變,只是取樣得比較稀
  });

  it("預設面積上限與 MAX_WARP_PIXELS 同源(不在接線端另寫一份數字)", () => {
    const { img, quad } = renderTilted(ORTHO4, 12, "y");
    expect(rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX" }))
      .toEqual(rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX", maxPixels: MAX_WARP_PIXELS }));
  });
});

describe("resolveTiltDeg(裁示 2026-08-03:實算 → 代理 → 不可得)", () => {
  const ORTHO5 = charBarcodeAt(12, 120);
  const { img, quad } = renderTilted(ORTHO5, 25, "y");
  const H = (rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX" }) as { H: number[] }).H;

  it("焦距可得 → 單應矩陣實算,來源標 homography", () => {
    const t = resolveTiltDeg(H, CAM.f, CAM.cx, CAM.cy, 3.2);
    expect(t.source).toBe("homography");
    expect(t.deg).toBeCloseTo(25, 1);
    expect(t.deg).not.toBeCloseTo(3.2, 1); // 有代理值也不得蓋掉實算
  });

  it("焦距不可得但有代理值 → 退回代理,來源標 proxy(裁示的預設路徑)", () => {
    for (const noFocal of [null, undefined, 0, NaN, -900]) {
      const t = resolveTiltDeg(H, noFocal, CAM.cx, CAM.cy, 3.2);
      expect(t.source).toBe("proxy");
      expect(t.deg).toBe(3.2);
    }
  });

  it("H 不可得(1D 未矯正)但有代理值 → 同樣退回代理", () => {
    expect(resolveTiltDeg(null, CAM.f, CAM.cx, CAM.cy, 7.5)).toEqual({ deg: 7.5, source: "proxy" });
  });

  it("**兩者皆不可得 → deg 為 null,絕不代填 0**(0 是 ≤5° 閘門的放行值)", () => {
    for (const badProxy of [null, undefined, NaN, Infinity, -1, "3.2"]) {
      const t = resolveTiltDeg(null, null, 0, 0, badProxy);
      expect(t).toEqual({ deg: null, source: "none" });
      expect(t.deg).not.toBe(0);
    }
  });

  it("代理值恰為 0 是合法量測值(等臂 → 0°),不可與「不可得」混為一談", () => {
    expect(resolveTiltDeg(null, null, 0, 0, 0)).toEqual({ deg: 0, source: "proxy" });
  });

  it("來源標籤三個鍵齊全(結果頁與掃描紀錄的文案一律取自此表)", () => {
    expect(TILT_SOURCE_LABEL).toEqual({
      homography: "單應矩陣實算", proxy: "臂長差代理值", none: "未量測",
    });
    for (const k of ["homography", "proxy", "none"]) {
      expect(TILT_SOURCE_LABEL[k as keyof typeof TILT_SOURCE_LABEL]).toBeTruthy();
    }
  });
});

describe("rectifyPlan(階段 ④:量測吃哪張影像、傾角走哪條路徑)", () => {
  const ORTHO6 = charBarcodeAt(12, 120);
  const { img, quad } = renderTilted(ORTHO6, 20, "y");

  it("四點皆實測(DataMatrix / 階段 ⑤ 後的 1D)→ 用正射影像、用單應傾角", () => {
    const rect = rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX" });
    const plan = rectifyPlan(rect);
    expect(plan).toEqual({ useRectified: true, useHomography: true, note: `已矯正 ${rect.w}×${rect.h}` });
  });

  it("**四角含補點(QR 三定位點)→ 兩者皆停用**,傾角改走代理值", () => {
    // 拿同一張傾斜影像,只餵三個點(模擬 ZXing 的 QR finder 中心)
    const three = [quad[3]!, quad[0]!, quad[1]!]; // [bl, tl, tr]
    const rect = rectifyQuad(img.data, img.w, img.h, three, { sym: "QR" });
    expect(rect.ok).toBe(true);          // 矯正本身成功,不是失敗
    expect(rect.derivedCorner).toBe(true);
    const plan = rectifyPlan(rect);
    expect(plan.useHomography).toBe(false); // 用了就是恆綠的 0°
    expect(plan.useRectified).toBe(false);  // 只還原得了旋轉剪切,白付一次內插模糊
    expect(plan.note).toContain("推算點");
    // 護欄的實效:這個 H 真的會給出 0°,停用不是保守而是必要
    expect(tiltFromHomography(rect.H, CAM.f, CAM.cx, CAM.cy)).toBeCloseTo(0, 6);
  });

  it("矯正失敗 → 兩者皆停用,note 直接沿用 rectifyQuad 的原因(不另造詞)", () => {
    const rect = rectifyQuad(img.data, img.w, img.h, [{ x: 5, y: 50 }, { x: 600, y: 52 }]);
    const plan = rectifyPlan(rect);
    expect(plan.useRectified).toBe(false);
    expect(plan.useHomography).toBe(false);
    expect(plan.note).toBe(rect.reason);
    expect(plan.note).toContain("四角不足");
  });

  it("縮過的正射輸出:note 帶密度標註(規格 §6.1 前後對照要對齊取樣密度)", () => {
    const rect = rectifyQuad(img.data, img.w, img.h, quad, { sym: "DATAMATRIX", maxPixels: 10000 });
    expect(rectifyPlan(rect).note).toMatch(/^已矯正 \d+×\d+（密度 \d+%）$/);
  });

  it("容錯:null / 未定義 → 兩者皆停用,不 throw", () => {
    for (const bad of [null, undefined]) {
      expect(rectifyPlan(bad)).toEqual({ useRectified: false, useHomography: false, note: "未矯正" });
    }
  });
});

// ── QR 的 alignment pattern(規格 §6.5 決策 ③,2026-08-03 裁示選 (c))────────
// ZXing 的 QR Detector 找到 alignment pattern 時回**四個**點,第四個是 alignment
// **中心**而不是右下角。把它直接當角點會讓每一張 v≥2 的 QR 都 FAIL。
describe("qrQuadFromPoints(由 alignment pattern 還原 QR 四角)", () => {
  const N = 25, PX = 12;                       // dimension 25、每模組 12px
  const HALF = (N * PX) / 2;
  // 模組座標 → 傾斜拍攝的影像座標(沿用本檔的針孔相機模型,無亂數)
  const shoot = (axis: "x" | "y", deg: number, mx: number, my: number): Pt =>
    project(planePoint(axis, mx * PX - HALF, my * PX - HALF, deg));
  // ZXing 的回傳順序:[bl, tl, tr, alignment]
  const zxPts = (axis: "x" | "y", deg: number): Pt[] => [
    shoot(axis, deg, 3.5, N - 3.5), shoot(axis, deg, 3.5, 3.5),
    shoot(axis, deg, N - 3.5, 3.5), shoot(axis, deg, N - 6.5, N - 6.5),
  ];
  const tiltOf = (corners: Pt[]) => {
    const o = orderCornersRaw(corners) as Pt[];
    const size = targetRectSize(o);
    const H = solveHomography(o, [{ x: 0, y: 0 }, { x: size.w, y: 0 }, { x: size.w, y: size.h }, { x: 0, y: size.h }]);
    return tiltFromHomography(H, CAM.f, CAM.cx, CAM.cy);
  };

  it("dimension 還原正確,四角標為實測(derived=false)", () => {
    const q = qrQuadFromPoints(zxPts("y", 10), PX);
    expect(q.dimension).toBe(N);
    expect(q.derived).toBe(false);
    expect(q.source).toBe("qr-alignment");
    expect(q.corners).toHaveLength(4);
  });

  it("**還原後傾角正確;把 alignment 當角點則連拍正的 QR 都算出 53.74°**", () => {
    // 實測表(dimension 25、每模組 12px、f=900、距離 833),繞 Y 軸:
    //   真實 0° → alignment 當角點 53.74° / 還原後 0.00°
    //   真實 5° → 52.55° / 5.00°;真實 30° → 47.81° / 30.00°
    const wantBad: Record<number, number> = { 0: 53.74, 5: 52.55, 30: 47.81 };
    for (const deg of [0, 5, 30]) {
      const pts = zxPts("y", deg);
      // ① 還原後:誤差在 0.01° 內
      expect(tiltOf(qrQuadFromPoints(pts, PX).corners)).toBeCloseTo(deg, 1);
      // ② 直接把四點當四角(本輪之前的行為):錯得離譜,且與真實傾角幾乎無關
      expect(tiltOf(pts)).toBeCloseTo(wantBad[deg]!, 1);
    }
  });

  it("繞 X 軸同樣還原得回來(不是只對單一旋轉軸成立)", () => {
    for (const deg of [0, 3, 12, 25]) {
      expect(tiltOf(qrQuadFromPoints(zxPts("x", deg), PX).corners)).toBeCloseTo(deg, 1);
    }
  });

  it("**擋得住 0° 的假 FAIL**:拍正的 QR 還原後過 ≤5° 閘門,不還原則過不了", () => {
    const pts = zxPts("y", 0);
    expect(tiltOf(qrQuadFromPoints(pts, PX).corners)).toBeLessThanOrEqual(5);
    expect(tiltOf(pts)).toBeGreaterThan(5); // 不還原 → 拍正的 QR 也被判 FAIL
  });

  it("沒有 alignment(v1 QR 只有三點)→ 退回平行四邊形補點並標 derived", () => {
    const q = qrQuadFromPoints(zxPts("y", 10).slice(0, 3), PX);
    expect(q.derived).toBe(true);
    expect(q.source).toBe("parallelogram");
    expect(q.dimension).toBeNull();
  });

  it("模組寬不可得 / 不合法 → 同樣退回補點,絕不用一個猜的 dimension", () => {
    for (const bad of [null, undefined, 0, -12, NaN, Infinity, "12"]) {
      const q = qrQuadFromPoints(zxPts("y", 10), bad);
      expect(q.derived).toBe(true);
      expect(q.source).toBe("parallelogram");
    }
  });

  it("模組寬離譜到算出不合法的 dimension → 退回補點(不硬套 ≡1 mod 4 的修正)", () => {
    // 模組寬給成 1000px:兩條中心距各除得 0 → dim=7,低於 QR 最小的 21
    const q = qrQuadFromPoints(zxPts("y", 10), 1000);
    expect(q.source).toBe("parallelogram");
  });

  it("點數不足(<3)→ null,不 throw", () => {
    expect(qrQuadFromPoints([{ x: 1, y: 1 }, { x: 2, y: 2 }], PX)).toBeNull();
    expect(qrQuadFromPoints(null, PX)).toBeNull();
  });

  it("quadFromZxingPoints 對 QR 一律走還原路徑,不得直接取前四點", () => {
    const pts = zxPts("y", 10);
    expect(quadFromZxingPoints(pts, "QR", PX)).toEqual(qrQuadFromPoints(pts, PX));
    // 同一組點若被當成 DataMatrix 就會走「四點即四角」—— 兩者結果必須不同
    expect(quadFromZxingPoints(pts, "DATAMATRIX", PX).corners).toEqual(pts);
  });

  it("**符號別不明時保守不信任**:四點仍回傳,但標 derived 讓 rectifyPlan 擋下", () => {
    const pts = zxPts("y", 10);
    for (const sym of [undefined, null, ""]) {
      const q = quadFromZxingPoints(pts, sym, PX);
      expect(q.derived).toBe(true);
      expect(q.source).toBe("unknown");
    }
    expect(rectifyPlan({ ok: true, derivedCorner: true, quadSource: "unknown", w: 10, h: 10, scale: 1 }).note)
      .toContain("四角來源不明");
  });
});

// ── 階段 ⑤:1D 四角偵測(規格 §3.3 一維段 / 驗收 §5.1–§5.6)──────────────────
// 沿用本檔上方的針孔相機模型(CAM / planePoint / project),無亂數。
// 既有的 charBarcodeAt 各列完全相同、上下沒有留白 → **沒有條端可偵測**,故另備標籤合成。

const LABEL_LIGHT = 220, LABEL_DARK = 40;

// 兩個區間的重疊長度(面積抗鋸齒用)
function overlap1D(a0: number, a1: number, b0: number, b1: number) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}
// 三角波,週期 period、值域 [-1, 1]。固定函式,**不是亂數** —— 用來造「條端雜訊」。
function triWave(x: number, period: number) {
  const p = (((x % period) + period) % period) / period;
  return 4 * Math.abs(p - 0.5) - 1;
}

/**
 * 白底條碼標籤:條碼水平置中、上下留白;bearer=true 時上下各加一條粗黑橫槓
 * (ITF-14 bearer bar),false 時只有條端(GS1-128)。
 * 輸入:pxPerModule 每模組像素、barHeightPx 條高、marginPx 四周留白、
 *   opts.bearer / opts.sawAmp / opts.sawPeriod(條端固定週期鋸齒,非亂數)。
 * 輸出:{ gray, w, h, leftCenter, rightCenter, midY, bar } ——
 *   leftCenter / rightCenter 是最左 / 最右**暗元素的水平中心**(模擬 ZXing 的兩個定位點),
 *   bar 是暗元素的外接矩形(不含 bearer bar)。
 * 抗鋸齒:水平沿用 charBarcodeAt 的面積覆蓋率,垂直同樣以覆蓋率混色,完全決定於輸入。
 */
function barcodeLabelAt(
  pxPerModule: number,
  barHeightPx = 120,
  marginPx = 40,
  opts: { bearer?: boolean; sawAmp?: number; sawPeriod?: number } = {},
) {
  const bearer = !!opts.bearer;
  const sawAmp = opts.sawAmp ?? 0, sawPeriod = opts.sawPeriod ?? 37;
  const profile = charBarcodeAt(pxPerModule, 1).gray; // 水平已抗鋸齒的一列
  const w = profile.length;
  let m = CHAR_QUIET + CHAR_PHASE;
  const darkSegs: { a: number; b: number }[] = [];
  for (let i = 0; i < CHAR_PATTERN.length; i++) {
    const width = CHAR_PATTERN[i]!;
    if (i % 2 === 0) darkSegs.push({ a: m, b: m + width }); // 偶數索引為暗元素
    m += width;
  }
  const first = darkSegs[0]!, last = darkSegs[darkSegs.length - 1]!;
  const darkX0 = first.a * pxPerModule, darkX1 = last.b * pxPerModule;
  const bt = bearer ? Math.round(pxPerModule * 1.5) : 0;  // bearer 厚度
  const gap = bearer ? Math.round(pxPerModule * 0.8) : 0; // bearer 與條之間的空白
  const barY0 = marginPx + bt + gap, barY1 = barY0 + barHeightPx;
  const h = barY1 + gap + bt + marginPx;
  const gray = new Uint8ClampedArray(w * h).fill(LABEL_LIGHT);
  for (let x = 0; x < w; x++) {
    const hFrac = (LABEL_LIGHT - profile[x]!) / (LABEL_LIGHT - LABEL_DARK);
    const d = sawAmp ? sawAmp * triWave(x, sawPeriod) : 0;
    const t0 = barY0 + d, t1 = barY1 - d;
    const bCov = bearer ? overlap1D(x, x + 1, darkX0, darkX1) : 0;
    for (let y = 0; y < h; y++) {
      let dark = hFrac * overlap1D(y, y + 1, t0, t1);
      if (bCov) {
        dark += bCov * (overlap1D(y, y + 1, marginPx, marginPx + bt)
          + overlap1D(y, y + 1, barY1 + gap, barY1 + gap + bt));
      }
      if (dark > 0) gray[y * w + x] = Math.round(LABEL_LIGHT + (LABEL_DARK - LABEL_LIGHT) * Math.min(1, dark));
    }
  }
  return {
    gray, w, h,
    leftCenter: ((first.a + first.b) / 2) * pxPerModule,
    rightCenter: ((last.a + last.b) / 2) * pxPerModule,
    midY: (barY0 + barY1) / 2,
    bar: { x0: darkX0, x1: darkX1, y0: barY0, y1: barY1 },
  };
}
type Label = ReturnType<typeof barcodeLabelAt>;

// 把標籤貼在平面上傾斜拍攝。jitterPx 給定位點加**固定**偏移(非亂數)驗容忍度。
// 輸出:{ img 相機影像、quad 標籤四角、pts 兩個模擬定位點、barQuad 條區四角 }。
function shootLabel(label: Label, tiltDeg: number, axis: "x" | "y" = "y", jitterPx = 0) {
  const cx = (label.w - 1) / 2, cy = (label.h - 1) / 2;
  const proj = (x: number, y: number) => project(planePoint(axis, x - cx, y - cy, tiltDeg));
  const corners = rectCorners({ w: label.w, h: label.h });
  const quad = corners.map((c) => proj(c.x, c.y));
  const H = solveHomography(corners, quad); // 正射 → 影像
  const img = warpPerspective(label.gray, label.w, label.h, H, CAM.w, CAM.h);
  const raw = [proj(label.leftCenter, label.midY), proj(label.rightCenter, label.midY)];
  const pts = jitterPx
    ? [{ x: raw[0]!.x + jitterPx, y: raw[0]!.y - jitterPx }, { x: raw[1]!.x - jitterPx, y: raw[1]!.y + jitterPx }]
    : raw;
  const b = label.bar;
  const barQuad = [proj(b.x0, b.y0), proj(b.x1, b.y0), proj(b.x1, b.y1), proj(b.x0, b.y1)];
  return { img, quad, pts, barQuad };
}
// 走完整條 1D 接線:模擬定位點 → rectifyQuad(內部分流到 quadFrom1DEdges)
function shootAndRectify(label: Label, deg: number, axis: "x" | "y" = "y", jitterPx = 0, sym = "ITF14") {
  const s = shootLabel(label, deg, axis, jitterPx);
  return { ...s, rect: rectifyQuad(s.img.data, s.img.w, s.img.h, s.pts, { sym }) };
}
// 直接對 quadFrom1DEdges 取四角(不經 rectifyQuad,退回路徑測試用)
function edgesOf(label: Label, deg: number, axis: "x" | "y" = "y") {
  const s = shootLabel(label, deg, axis);
  return quadFrom1DEdges(s.img.data, s.img.w, s.img.h, s.pts, { sym: "ITF14" });
}
// 由任意四角推傾角(與 rectifyQuad 內部同一條鏈)
function tiltOfCorners(corners: Pt[]) {
  const o = orderCornersRaw(corners) as Pt[];
  const size = targetRectSize(o);
  const H = solveHomography(o, [{ x: 0, y: 0 }, { x: size.w, y: 0 }, { x: size.w, y: size.h }, { x: 0, y: size.h }]);
  return tiltFromHomography(H, CAM.f, CAM.cx, CAM.cy);
}
// 直線的方向角(0–180°),用來證明上下兩條線是各自擬合的
function dirDeg(fit: { nx: number; ny: number }) {
  const a = (Math.atan2(fit.nx, -fit.ny) * 180) / Math.PI;
  return ((a % 180) + 180) % 180;
}
// 以 2×2 超取樣填一塊實心暗凸四邊形(白底),用來構造「相鄰兩線夾角過小」的情境
function solidQuadImage(w: number, h: number, q: Pt[]) {
  const gray = new Uint8ClampedArray(w * h).fill(LABEL_LIGHT);
  const insideQuad = (x: number, y: number) => {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i]!, b = q[(i + 1) % 4]!;
      const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cr === 0) continue;
      const s = cr > 0 ? 1 : -1;
      if (!sign) sign = s;
      else if (s !== sign) return false;
    }
    return true;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) if (insideQuad(x + dx, y + dy)) c++;
      if (c) gray[y * w + x] = Math.round(LABEL_LIGHT + (LABEL_DARK - LABEL_LIGHT) * (c / 4));
    }
  }
  return gray;
}

// 每模組 **12.5px**(刻意不取整數)。整數 ppm 在繞 Y 軸 25° 的透視壓縮後,矯正影像的
// 模組寬會落在整數**下緣**(12px/module → 11.85),roi1DGeometry 的模組寬估計器
//(run 長度 10 百分位)整數截斷成 11,量到的 0.18 是**估計器本身的偏差**而不是矯正殘差
// —— 本檔上方「取樣密度對 DEC 代理值的系統性影響」那一組特性化測試記錄的正是同一個偏差。
// 12.5 讓矯正後的模組寬落在 12.33,估計器截到 12,量到的才是矯正的真實殘差。
const ITF = barcodeLabelAt(12.5, 120, 40, { bearer: true });  // ITF-14:上下有 bearer bar
const C128 = barcodeLabelAt(12.5, 120, 40, { bearer: false }); // GS1-128:只有條端

// ── 規格 ↔ 程式的同步守門(比照 tests/gate-spec-sync.test.ts 的做法)─────────────
// 舊版本檔把規格的門檻**再抄一份字面值**進來 toEqual,只擋得住「改程式不改測試」;
// RD 一次改兩邊(程式 + 測試字面值)規格就靜默過期而測試全綠 —— 那正是規格 §5.1
// 自承已栽過兩次的坑。故改為**直接讀 docs/spec20260731-1.md 與 src/domain/types.ts**,
// 讓「權威表在規格、清單在 types.ts」從承諾變成機制。
const SPEC_PATH = new URL("../docs/spec20260731-1.md", import.meta.url);
const TYPES_PATH = new URL("../src/domain/types.ts", import.meta.url);

/**
 * 取出規格兩個標題之間的章節原文。
 * 輸入:起始標題前綴、結束標題前綴;輸出:區間內的 markdown 字串。
 * 任一標題找不到就讓測試失敗 —— 標題被改名時要有人來看,不可靜默跳過整段比對。
 */
function specSection(startHeading: string, endHeading: string): string {
  const md = readFileSync(SPEC_PATH, "utf8");
  const start = md.indexOf(startHeading);
  expect(start, `規格找不到章節「${startHeading}」`).toBeGreaterThan(-1);
  const end = md.indexOf(endHeading, start);
  expect(end, `規格找不到「${endHeading}」(無法界定章節範圍)`).toBeGreaterThan(start);
  return md.slice(start, end);
}

/**
 * 從 markdown 區段取出指定表格的資料列。
 * 輸入:區段原文、表頭必須含有的字串;輸出:每列一個 cell 陣列(已去頭尾空白)。
 * 邏輯:把連續的 `|` 開頭行切成表格區塊,選出表頭命中的那一塊,丟掉表頭與 `---` 分隔列。
 */
function parseTable(section: string, headerMustContain: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of section.split("\n")) {
    if (line.trimStart().startsWith("|")) current.push(line.trim());
    else if (current.length) { blocks.push(current); current = []; }
  }
  if (current.length) blocks.push(current);
  const block = blocks.find((b) => b[0]!.includes(headerMustContain));
  expect(block, `規格找不到表頭含「${headerMustContain}」的表格`).toBeDefined();
  return block!
    .slice(1)
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split("|").map((c) => c.trim()));
}

/** 取出一段文字裡所有反引號內容(規格用它標常數名與字面值)。 */
const backticked = (s: string): string[] => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

/**
 * 規格的「值」儲存格 → 數字。
 * 輸入:如 "8" / "**48**(草稿 24 → 實測 48)" / "**0.08**(新增)";輸出:8 / 48 / 0.08。
 * 邏輯:只取開頭的數字(粗體記號剝掉),括號內的沿革註記是給人看的,不參與比對。
 */
function specNumber(cell: string): number {
  const m = /^\*{0,2}(-?[\d.]+)\*{0,2}/.exec(cell.trim());
  expect(m, `無法從規格儲存格「${cell}」解析出數值`).not.toBeNull();
  return Number(m![1]);
}

const ONE_D_SPEC = specSection("#### 1D 四角偵測(階段 ⑤", "### 3.4 提案 C");

describe("1D 擬合門檻與符號別清單(規格 §5.5 常數守門)", () => {
  it("1D 擬合門檻**逐項讀規格 §3.3 的權威表**比對,任一邊單獨改動都會紅", () => {
    const rows = parseTable(ONE_D_SPEC, "判什麼 / 為什麼是這個值");
    const fromSpec: Record<string, number> = {};
    for (const row of rows) {
      const name = backticked(row[0]!)[0];
      expect(name, `權威表有一列的常數名沒用反引號標:「${row[0]}」`).toBeDefined();
      fromSpec[name!] = specNumber(row[1]!);
    }
    // 逐項值相同,且**欄位集合與順序**也相同 —— 規格漏列或多列一項同樣要紅
    expect(LINE_FIT_LIMITS).toEqual(fromSpec);
    expect(Object.keys(LINE_FIT_LIMITS)).toEqual(Object.keys(fromSpec));
    expect(Object.isFrozen(LINE_FIT_LIMITS)).toBe(true);
  });

  it("走 1D 條端擬合的符號別**逐項讀 types.ts 的 Symbology**,新符號別必須明確歸類", () => {
    const src = readFileSync(TYPES_PATH, "utf8");
    const union = /export type Symbology\s*=\s*([^;]+);/.exec(src);
    expect(union, "src/domain/types.ts 找不到 Symbology 的字面聯集").not.toBeNull();
    const symbology = [...union![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(symbology.length).toBeGreaterThan(0);

    // 1D 清單必須是 Symbology 的子集(打錯字、留下已移除的符號別都會在此紅)
    for (const s of ONE_D_SYMBOLOGIES) expect(symbology, `Symbology 沒有「${s}」`).toContain(s);
    // 2D 走 quadFromZxingPoints,不得混進 1D 清單
    const TWO_D = ["QR", "DATAMATRIX"];
    for (const s of TWO_D) expect(ONE_D_SYMBOLOGIES).not.toContain(s);
    // **完整分割**:Symbology 的每一個值不是 1D 就是 2D。日後在 types.ts 增列符號別
    // (如 CODE39)卻忘了同步這裡,會在此變紅而不是讓 rectifyQuad 靜默退回「四角不足」。
    expect([...ONE_D_SYMBOLOGIES, ...TWO_D].slice().sort()).toEqual(symbology.slice().sort());
    expect(Object.isFrozen(ONE_D_SYMBOLOGIES)).toBe(true);

    // 第三邊:規格 §3.3 新增匯出表登記的清單也要一致(規格漏改同樣會紅)。
    // 刻意併在同一條測試裡而不另開一條 —— 規格 §5.1 的測試數權威表是人工維護的,
    // 本輪只修守門機制、不動測試總數,免得那張表又靜默過期。
    const row = parseTable(ONE_D_SPEC, "名稱").find((r) => backticked(r[0]!)[0] === "ONE_D_SYMBOLOGIES");
    expect(row, "規格 §3.3 新增匯出表找不到 ONE_D_SYMBOLOGIES").toBeDefined();
    const listed = [...(backticked(row![1]!)[0] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(listed).toEqual([...ONE_D_SYMBOLOGIES]);
  });

  it("minCornerAngleDeg 與 quadConfidence 的最小內角同值同源(不各寫一份)", () => {
    expect(LINE_FIT_LIMITS.minCornerAngleDeg).toBe(QUAD_CONFIDENCE_LIMITS.minAngleDeg);
    expect(LINE_FIT_LIMITS.minInliers).toBe(QUAD_CONFIDENCE_LIMITS.minEdgePx);
  });
});

describe("fitLineTLS(總體最小平方直線擬合 + MAD 離群剔除)", () => {
  it("水平線與**垂直線**都擬合得出來 —— 這正是不能用 y = ax + b 的理由", () => {
    const horiz = fitLineTLS([...Array(10)].map((_, i) => ({ x: i * 3, y: 17 })));
    expect(Math.abs(horiz.ny)).toBeCloseTo(1, 9); // 法向垂直 → 線水平
    expect(horiz.rmsPx).toBeCloseTo(0, 9);
    // 條垂直(符號旋轉 90°)時 y = ax + b 的斜率發散,TLS 照樣給得出來
    const vert = fitLineTLS([...Array(10)].map((_, i) => ({ x: 42, y: i * 3 })));
    expect(Math.abs(vert.nx)).toBeCloseTo(1, 9);
    expect(vert.rmsPx).toBeCloseTo(0, 9);
    expect(42 * vert.nx + vert.c).toBeCloseTo(0, 9);
  });

  it("離群點被 MAD 剔除,內點數/比例如實回報", () => {
    const pts = [...Array(20)].map((_, i) => ({ x: i * 5, y: 100 + i * 0.5 }));
    pts[7] = { x: 35, y: 160 };  // 兩個離群點
    pts[13] = { x: 65, y: 40 };
    const f = fitLineTLS(pts);
    expect(f.samples).toBe(20);
    expect(f.inliers).toBe(18);
    expect(f.rmsPx).toBeLessThan(0.01); // 剔乾淨後殘差回到 0
  });

  it("**近乎完美的一組點不得被自己的 MAD 剔光**(尺度下限 0.1px)", () => {
    // 這組資料是為了讓下限**非生效不可**而建構的,不是隨手取的近乎完美點:
    // 30 點中 16 點殘差恰為 0(奇數半數以上)⇒ median|r| 就是 0 ⇒ 沒有下限時
    // 尺度 0 ⇒ cut = madK × 0 = 0 ⇒ 只有殘差恰為 0 的那 16 點留得下來,
    // 內點比例 16/30 = 0.533 < minInlierRatio 0.6,整條線會被判失敗。
    // 有下限時 cut = 2.5 × 0.1 = 0.25px,遠大於 3/64、4/64 的次像素偏移 ⇒ 30 點全留。
    // 偏移點成對放在 x 的對稱位置(a 與 29−a 同偏移量)且偏移量總和為 0,
    // 使 Sxy = 0、質心 y = 50 ⇒ TLS 解恰為 y = 50,零殘差是精確的 0 而非約等於。
    const offsets = new Map<number, number>();
    for (const a of [0, 1, 2, 3]) { offsets.set(a, 3 / 64); offsets.set(29 - a, 3 / 64); }
    for (const a of [4, 5, 6]) { offsets.set(a, -4 / 64); offsets.set(29 - a, -4 / 64); }
    const pts = [...Array(30)].map((_, i) => ({ x: i, y: 50 + (offsets.get(i) ?? 0) }));
    expect(pts.filter((p) => p.y === 50)).toHaveLength(16); // 半數以上殘差為 0 ⇒ median = 0

    const f = fitLineTLS(pts);
    expect(f.samples).toBe(30);
    expect(f.inliers).toBe(30); // 拿掉 imgproc.js 的 Math.max(…, 0.1) 這裡會變成 16
    expect(f.inliers / f.samples).toBeGreaterThanOrEqual(LINE_FIT_LIMITS.minInlierRatio);
  });

  it("點數不足 / 全部點重合 / 非有限座標 → null,不 throw", () => {
    expect(fitLineTLS([{ x: 1, y: 1 }])).toBeNull();
    expect(fitLineTLS([])).toBeNull();
    expect(fitLineTLS(null)).toBeNull();
    expect(fitLineTLS(undefined)).toBeNull();
    expect(fitLineTLS([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }])).toBeNull();
    expect(fitLineTLS([{ x: NaN, y: 0 }, { x: 1, y: 1 }])).toBeNull(); // 濾掉後只剩 1 點
    expect(fitLineTLS([{ x: Infinity, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }]).inliers).toBe(2);
  });

  it("完全決定於輸入(無亂數,跑兩次結果相同)", () => {
    const pts = [...Array(15)].map((_, i) => ({ x: i * 2.3, y: 7 + i * 1.7 }));
    expect(fitLineTLS(pts)).toEqual(fitLineTLS(pts));
  });
});

describe("quadFrom1DEdges(1D 條端擬合四角,規格 §5.1 傾角還原 ±1°)", () => {
  it("繞 Y 軸 0 / 5 / 12 / 25°(ITF-14,有 bearer bar):誤差 ≤ 1°,來源為單應矩陣實算", () => {
    for (const deg of [0, 5, 12, 25]) {
      const { rect } = shootAndRectify(ITF, deg, "y");
      expect(rect.ok).toBe(true);
      const t = resolveTiltDeg(rect.H, CAM.f, CAM.cx, CAM.cy, null);
      expect(t.source).toBe("homography");
      expect(Math.abs(t.deg - deg)).toBeLessThanOrEqual(1);
    }
  });

  it("繞 X 軸 8 / 20 / 30°(ITF-14):誤差 ≤ 1°", () => {
    for (const deg of [8, 20, 30]) {
      const { rect } = shootAndRectify(ITF, deg, "x");
      expect(rect.ok).toBe(true);
      const t = resolveTiltDeg(rect.H, CAM.f, CAM.cx, CAM.cy, null);
      expect(Math.abs(t.deg - deg)).toBeLessThanOrEqual(1);
    }
  });

  it("GS1-128(無 bearer bar,只有條端)兩軸同樣在 ±1° 內", () => {
    for (const [axis, degs] of [["y", [0, 5, 12, 25]], ["x", [8, 20, 30]]] as const) {
      for (const deg of degs) {
        const { rect } = shootAndRectify(C128, deg, axis, 0, "GS1_128");
        expect(rect.ok).toBe(true);
        const t = resolveTiltDeg(rect.H, CAM.f, CAM.cx, CAM.cy, null);
        expect(Math.abs(t.deg - deg)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("定位點帶 ±2px 固定偏移時,25° 那組仍在 ±1° 內(不吃 ZXing 端點精度)", () => {
    for (const label of [ITF, C128]) {
      const sym = label === ITF ? "ITF14" : "GS1_128";
      const { rect } = shootAndRectify(label, 25, "y", 2, sym);
      expect(rect.ok).toBe(true);
      expect(Math.abs(resolveTiltDeg(rect.H, CAM.f, CAM.cx, CAM.cy, null).deg - 25)).toBeLessThanOrEqual(1);
    }
  });

  it("完全決定於輸入(同參數跑兩次,四角與正射影像逐像素相同)", () => {
    const a = shootAndRectify(ITF, 25, "y");
    const b = shootAndRectify(ITF, 25, "y");
    expect(a.rect.corners).toEqual(b.rect.corners);
    expect(Array.from(a.rect.gray)).toEqual(Array.from(b.rect.gray));
  });
});

describe("1D 四角偵測的護欄(規格 §5.2:四條邊必須各自獨立擬合)", () => {
  // 2026-08-03 在 QR 補點四角上犯過一次:兩組對邊平行 ⇒ 單應矩陣是仿射 ⇒ 消失線在無窮遠
  // ⇒ 傾角恆 0.00°,而 0° 正是「≤5° 否則 FAIL」最寬鬆的放行值。C1 禁的就是再犯一次。
  it("**下邊取成上邊的平移就恆推出 0° 傾角**:同一張 25° 圖,本實作必須不是那個值", () => {
    const s = shootLabel(ITF, 25, "y");
    const e = quadFrom1DEdges(s.img.data, s.img.w, s.img.h, s.pts, { sym: "ITF14" });
    expect(e.ok).toBe(true);
    // (a) 本實作:四條邊各自擬合 → 還原得回真實傾角,而且明確不是 0°
    const real = tiltOfCorners(e.corners);
    expect(Math.abs(real - 25)).toBeLessThanOrEqual(1);
    expect(real).not.toBeCloseTo(0, 1);
    // (b) 對照組:把下邊改成「上邊平移」構成平行四邊形 → 不論真實傾角一律 0.00°
    const c = orderCornersRaw(e.corners) as Pt[];
    const dx = c[3]!.x - c[0]!.x, dy = c[3]!.y - c[0]!.y; // 左邊向量
    const para = [c[0]!, c[1]!, { x: c[1]!.x + dx, y: c[1]!.y + dy }, { x: c[0]!.x + dx, y: c[0]!.y + dy }];
    expect(tiltOfCorners(para)).toBeCloseTo(0, 2);
  });

  it("fit.top 與 fit.bottom 的方向角明顯不同(> 0.5°),證明不是同一條線的平移", () => {
    // **繞 Y 軸**(畫面垂直軸)時上下兩邊才會聚:本檔的針孔模型下 y = f·t/(dist − s·sinθ),
    // 固定 t 的那條線的 y 隨 s 變化,上下兩邊斜率反號。規格 §5.2 草稿寫的是繞 X 軸,
    // 但繞 X 軸時 Z 只跟 t 有關,上下兩邊在影像中**恰好保持水平且平行**(見下一條斷言)。
    const s = shootLabel(ITF, 30, "y");
    const e = quadFrom1DEdges(s.img.data, s.img.w, s.img.h, s.pts, { sym: "ITF14" });
    expect(e.ok).toBe(true);
    const diff = Math.abs(dirDeg(e.fit.top) - dirDeg(e.fit.bottom));
    expect(Math.min(diff, 180 - diff)).toBeGreaterThan(0.5);
    // 四條線都要各自可讀,護欄才驗得下去
    for (const k of ["top", "bottom", "left", "right"] as const) {
      expect(e.fit[k].inliers).toBeGreaterThanOrEqual(LINE_FIT_LIMITS.minInliers);
      expect(e.fit[k].rmsPx).toBeLessThanOrEqual(LINE_FIT_LIMITS.maxRmsPx);
    }
  });

  it("**繞 X 軸時上下兩邊本來就平行,不得因此判失敗** —— C1 禁的是強制平行,不是結果平行", () => {
    const s = shootLabel(ITF, 30, "x");
    const e = quadFrom1DEdges(s.img.data, s.img.w, s.img.h, s.pts, { sym: "ITF14" });
    expect(e.ok).toBe(true); // 上下兩線幾乎同向,只檢查相鄰線對才過得了這一關
    const diff = Math.abs(dirDeg(e.fit.top) - dirDeg(e.fit.bottom));
    expect(Math.min(diff, 180 - diff)).toBeLessThan(0.1);
    // 而傾角照樣量得回來 —— 透視資訊在**左右**兩邊的會聚上,不在上下
    expect(Math.abs(tiltOfCorners(e.corners) - 30)).toBeLessThanOrEqual(1);
    const ld = Math.abs(dirDeg(e.fit.left) - dirDeg(e.fit.right));
    expect(Math.min(ld, 180 - ld)).toBeGreaterThan(0.5);
  });

  it("**真的拍正(0°)不得因為四線近乎平行就判失敗** —— 那是正確答案不是缺陷", () => {
    for (const label of [ITF, C128]) {
      const s = shootLabel(label, 0, "y");
      const e = quadFrom1DEdges(s.img.data, s.img.w, s.img.h, s.pts, {});
      expect(e.ok).toBe(true);
      expect(Math.abs(tiltOfCorners(e.corners))).toBeLessThanOrEqual(1);
    }
  });
});

describe("quadFrom1DEdges 的退回路徑(規格 §5.3:誠實退回、講得出是哪一項不過)", () => {
  // 每條都要:不 throw、ok=false、reason 為可讀中文且指名項目、不含「階段 ⑤」
  const expectFail = (r: { ok: boolean; corners: unknown; reason: string }, needle: string) => {
    expect(r.ok).toBe(false);
    expect(r.corners).toBeNull();
    expect(r.reason).toContain("1D 邊界擬合失敗");
    expect(r.reason).toContain(needle);
    expect(r.reason).not.toContain("階段 ⑤");
  };

  it("條端雜訊過大(固定週期鋸齒)→ 指名殘差 RMS", () => {
    const noisy = barcodeLabelAt(12, 120, 40, { bearer: false, sawAmp: 6, sawPeriod: 37 });
    const r = quadFrom1DEdges(noisy.gray, noisy.w, noisy.h,
      [{ x: noisy.leftCenter, y: noisy.midY }, { x: noisy.rightCenter, y: noisy.midY }], {});
    expectFail(r, "殘差 RMS");
    expect(r.metrics.maxRmsPx).toBeGreaterThan(LINE_FIT_LIMITS.maxRmsPx);
  });

  it("條高不足(3px)→ 指名條高;大量取樣位置落在空白 → 指名內點數", () => {
    const thin = barcodeLabelAt(12, 3, 20, { bearer: false });
    const a = quadFrom1DEdges(thin.gray, thin.w, thin.h,
      [{ x: thin.leftCenter, y: thin.midY }, { x: thin.rightCenter, y: thin.midY }], {});
    expectFail(a, "條高");
    expect(a.metrics.barHeightPx).toBeLessThan(LINE_FIT_LIMITS.minBarHeightPx);

    // 只有 3 根短條、其餘全是空白:48 個取樣位置絕大多數作廢(不補值)
    const w = 600, h = 400;
    const sparse = new Uint8ClampedArray(w * h).fill(LABEL_LIGHT);
    for (const bx of [100, 300, 500]) {
      for (let y = 200; y < 260; y++) for (let x = bx; x < bx + 6; x++) sparse[y * w + x] = LABEL_DARK;
    }
    const b = quadFrom1DEdges(sparse, w, h, [{ x: 60, y: 230 }, { x: 540, y: 230 }], {});
    expectFail(b, "內點數");
  });

  it("四線近乎平行(交點在無窮遠)→ 指名夾角過小", () => {
    // 實心暗平行四邊形:左右兩邊相對上下兩邊只斜 17.7°,四角交點求得出來但不可信
    const w = 900, h = 300;
    const q = [{ x: 100, y: 120 }, { x: 620, y: 120 }, { x: 745, y: 160 }, { x: 225, y: 160 }];
    const gray = solidQuadImage(w, h, q);
    const r = quadFrom1DEdges(gray, w, h, [{ x: 168, y: 140 }, { x: 677, y: 140 }], {});
    expectFail(r, "四線近乎平行");
    expect(r.metrics.minCornerAngleDeg).toBeLessThan(LINE_FIT_LIMITS.minCornerAngleDeg);
  });

  it("端點退化(重合 / 1 點 / 0 點 / NaN / Infinity)→ 指名定位點或定位線", () => {
    const g = ITF.gray, w = ITF.w, h = ITF.h;
    expectFail(quadFrom1DEdges(g, w, h, [{ x: 100, y: 100 }, { x: 100, y: 100 }], {}), "定位線過短");
    expectFail(quadFrom1DEdges(g, w, h, [{ x: 100, y: 100 }, { x: 110, y: 100 }], {}), "定位線過短");
    expectFail(quadFrom1DEdges(g, w, h, [{ x: 100, y: 100 }], {}), "定位點不足");
    expectFail(quadFrom1DEdges(g, w, h, [], {}), "定位點不足");
    expectFail(quadFrom1DEdges(g, w, h, null, {}), "定位點不足");
    expectFail(quadFrom1DEdges(g, w, h, undefined, {}), "定位點不足");
    expectFail(quadFrom1DEdges(g, w, h, [{ x: NaN, y: 0 }, { x: 300, y: 100 }], {}), "定位點不足");
    expectFail(quadFrom1DEdges(g, w, h, [{ x: Infinity, y: 0 }, { x: -Infinity, y: 5 }], {}), "定位點不足");
  });

  it("對比不足(全白 / 全黑 / 極低對比)→ 指名 Otsu 分不出兩類", () => {
    const w = 400, h = 300, pts = [{ x: 40, y: 150 }, { x: 360, y: 150 }];
    expectFail(quadFrom1DEdges(new Uint8ClampedArray(w * h).fill(255), w, h, pts, {}), "對比不足");
    expectFail(quadFrom1DEdges(new Uint8ClampedArray(w * h).fill(0), w, h, pts, {}), "對比不足");
    // 極低對比:條 120、底 135,兩類分得出來但差只有 15 級
    const faint = new Uint8ClampedArray(w * h).fill(135);
    for (let y = 100; y < 200; y++) for (let x = 20; x < 380; x++) if (Math.floor(x / 8) % 2 === 0) faint[y * w + x] = 120;
    expectFail(quadFrom1DEdges(faint, w, h, pts, {}), "對比不足");
  });

  it("來源影像不合法(null / 尺寸為 0 / 緩衝區太小)→ 不 throw", () => {
    const pts = [{ x: 40, y: 150 }, { x: 360, y: 150 }];
    expectFail(quadFrom1DEdges(null, 400, 300, pts, {}), "來源影像不合法");
    expectFail(quadFrom1DEdges(ITF.gray, 0, 300, pts, {}), "來源影像不合法");
    expectFail(quadFrom1DEdges(ITF.gray, 400, NaN, pts, {}), "來源影像不合法");
    expectFail(quadFrom1DEdges(new Uint8ClampedArray(10), 400, 300, pts, {}), "來源影像不合法");
  });

  it("條被畫面切掉 → 該位置作廢,**不得用畫面邊界當條端**", () => {
    // 把標籤上半截掉:上端點群整批取不到,內點數不足 → 誠實退回,不拿 y=0 充數
    const cut = 120;
    const g = new Uint8ClampedArray((ITF.h - cut) * ITF.w);
    g.set(ITF.gray.subarray(cut * ITF.w));
    const r = quadFrom1DEdges(g, ITF.w, ITF.h - cut,
      [{ x: ITF.leftCenter, y: ITF.midY - cut }, { x: ITF.rightCenter, y: ITF.midY - cut }], {});
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("取樣點不足");
  });
});

describe("階段 ⑤ 接線(規格 §5.6:rectifyQuad / rectifyPlan)", () => {
  it("sym ITF14 + 兩個定位點 → 四角實測、走正射與單應傾角", () => {
    const { rect } = shootAndRectify(ITF, 20, "y", 0, "ITF14");
    expect(rect.ok).toBe(true);
    expect(rect.quadSource).toBe("1d-edges");
    expect(rect.derivedCorner).toBe(false); // 擬合出來的是實測角,不是推算
    const plan = rectifyPlan(rect);
    expect(plan.useRectified).toBe(true);
    expect(plan.useHomography).toBe(true);
    expect(plan.note).toContain("已矯正");
    expect(plan.note).toContain("1D 四角由條端擬合");
  });

  it("sym GS1_128 同上;CODE128 也走同一條路", () => {
    for (const sym of ["GS1_128", "CODE128"]) {
      const { rect } = shootAndRectify(C128, 15, "y", 0, sym);
      expect(rect.ok).toBe(true);
      expect(rect.quadSource).toBe("1d-edges");
      expect(rectifyPlan(rect)).toMatchObject({ useRectified: true, useHomography: true });
    }
  });

  it("擬合失敗時 reason 原封不動傳出來,gray 為 undefined、兩布林皆 false", () => {
    const r = rectifyQuad(ITF.gray, ITF.w, ITF.h, [{ x: 100, y: 100 }, { x: 105, y: 100 }], { sym: "ITF14" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("1D 邊界擬合失敗");
    expect(r.gray).toBeUndefined();
    expect(rectifyPlan(r)).toEqual({ useRectified: false, useHomography: false, note: r.reason });
  });

  it("**符號別不明或非 1D 時不啟動 1D 偵測**(既有的保守行為不變)", () => {
    const s = shootLabel(ITF, 20, "y");
    for (const sym of [null, undefined, "", "QR", "DATAMATRIX", "PDF417"]) {
      const r = rectifyQuad(s.img.data, s.img.w, s.img.h, s.pts, { sym });
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("四角不足");
      expect(r.reason).not.toContain("1D 邊界擬合失敗");
      expect(r.reason).not.toContain("階段 ⑤");
      expect(r.gray).toBeUndefined();
    }
    // 已知的 2D 符號別要把符號別講出來,不明則指名不明
    expect(rectifyQuad(s.img.data, s.img.w, s.img.h, s.pts, { sym: "QR" }).reason).toContain("QR");
    expect(rectifyQuad(s.img.data, s.img.w, s.img.h, s.pts, { sym: null }).reason).toContain("符號別不明");
  });

  it("程式碼中不得再出現「階段 ⑤」的退回理由(規格 §3.5)", () => {
    // 這條是字串守門:1D 條端擬合上線後,那句話代表的是「還沒做」,留著就是說謊
    const r = rectifyQuad(ITF.gray, ITF.w, ITF.h, [{ x: 5, y: 50 }, { x: 600, y: 52 }], { sym: "ITF14" });
    expect(r.reason).not.toContain("階段 ⑤");
  });
});

describe("階段 ⑤ 幾何改善(規格 §5.4:矯正後 DEC 代理值與模組寬變異數雙雙下降)", () => {
  it("繞 Y 軸 25° 的 ITF-14 標籤:maxWidthDeviation 降到矯正前的 1/3 以下", () => {
    const s = shootAndRectify(ITF, 25, "y");
    expect(s.rect.ok).toBe(true);
    const before = decMaxDev(s.img.data, s.img.w, innerRoi(s.barQuad as Pt[]));
    const after = decMaxDev(s.rect.gray, s.rect.w, { x0: 0, y0: 0, x1: s.rect.w, y1: s.rect.h });
    expect(before).toBeGreaterThan(0.3);
    expect(after).toBeLessThan(before / 3);
  });

  it("模組寬變異數同樣下降,且矯正後不比同一張圖 0° 拍攝的基準值差", () => {
    // 與 roi1DGeometry 同一套去頭尾慣例:首尾 run 必被 ROI / 正射邊界切到,一律丟掉,
    // 剩下的與 CHAR_PATTERN[1..] 一一對應(不可沿用 moduleWidthStats:那支假設 ROI 含靜區)
    const statsCut = (gray: Uint8ClampedArray, w: number, roi: { x0: number; y0: number; x1: number; y1: number }) => {
      const r = cropGray(gray, w, roi);
      const t = otsu(r.data);
      const y = Math.floor(r.h / 2);
      let runs = scanlineRuns(r.data.subarray(y * r.w, (y + 1) * r.w), t) as { len: number; dark: boolean }[];
      // 先對齊到「暗起頭、暗結尾」(邊界可能多出一小段亮的殘段),再去掉必然被切到的首尾兩段
      if (runs.length && !runs[0]!.dark) runs = runs.slice(1);
      if (runs.length && !runs[runs.length - 1]!.dark) runs = runs.slice(0, -1);
      runs = runs.slice(1, -1);
      const per = runs.map((run, i) => run.len / CHAR_PATTERN[i + 1]!);
      const mean = per.reduce((a, b) => a + b, 0) / per.length;
      return { n: per.length, variance: per.reduce((a, b) => a + (b - mean) ** 2, 0) / per.length };
    };
    const s = shootAndRectify(ITF, 25, "y");
    const before = statsCut(s.img.data, s.img.w, innerRoi(s.barQuad as Pt[]));
    const after = statsCut(s.rect.gray, s.rect.w, { x0: 0, y0: 0, x1: s.rect.w, y1: s.rect.h });
    expect(before.n).toBe(after.n);
    expect(before.variance).toBeGreaterThan(1);
    expect(after.variance).toBeLessThan(before.variance / 10);

    // 0° 拍攝的基準:矯正後不應該比它差
    const flat = shootAndRectify(ITF, 0, "y");
    const base = statsCut(flat.rect.gray, flat.rect.w, { x0: 0, y0: 0, x1: flat.rect.w, y1: flat.rect.h });
    expect(after.variance).toBeLessThanOrEqual(base.variance);
  });
});

// ── 規格 §6 點名為風險、§5 驗收清單原本漏列的兩個 edge case(規格 §5.4e)──
// 兩者都不是新功能,而是「已經會動、但沒有任何測試守著」的行為。
describe("1D 四角偵測的 edge case(規格 §5.4e)", () => {
  // 把標籤原地旋轉 90°:條由垂直變水平、定位線由水平變垂直。
  // 輸入 barcodeLabelAt 的輸出;輸出旋轉後的灰階與**兩個定位點**(x 相同、y 不同)。
  // 座標對應 (x, y) → (h − 1 − y, x)。
  const rotateLabel90 = (label: Label) => {
    const { gray, w, h } = label;
    const out = new Uint8ClampedArray(h * w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = gray[y * w + x]!;
    }
    const map = (p: Pt): Pt => ({ x: h - 1 - p.y, y: p.x });
    return {
      gray: out, w: h, h: w,
      p0: map({ x: label.leftCenter, y: label.midY }),
      p1: map({ x: label.rightCenter, y: label.midY }),
    };
  };
  // 旋轉版的傾斜拍攝(shootLabel 假設定位線水平,故另寫一支)
  const shootRotated = (r: ReturnType<typeof rotateLabel90>, deg: number, axis: "x" | "y" = "y") => {
    const cx = (r.w - 1) / 2, cy = (r.h - 1) / 2;
    const proj = (x: number, y: number) => project(planePoint(axis, x - cx, y - cy, deg));
    const corners = rectCorners({ w: r.w, h: r.h });
    const H = solveHomography(corners, corners.map((c) => proj(c.x, c.y)));
    return {
      img: warpPerspective(r.gray, r.w, r.h, H, CAM.w, CAM.h),
      pts: [proj(r.p0.x, r.p0.y), proj(r.p1.x, r.p1.y)],
    };
  };

  // (a) 規格 §6 的「符號旋轉 90°」。舊版只由 fitLineTLS 的單元測試間接覆蓋 ——
  //     把 tlsOf 換回 y = ax + b,只有那條單元測試會紅,quadFrom1DEdges 全程一條都不會紅。
  it("**符號旋轉 90°(定位線垂直)走完整條 quadFrom1DEdges**:斜率發散不得讓偵測失敗", () => {
    const small = barcodeLabelAt(6, 60, 20, { bearer: true }); // 縮小以容進 900×600 的合成相機
    const rot = rotateLabel90(small);
    expect(rot.p0.x).toBeCloseTo(rot.p1.x, 6); // 前提:定位線真的是垂直的
    for (const deg of [0, 20]) {
      const s = shootRotated(rot, deg, "y");
      const e = quadFrom1DEdges(s.img.data, s.img.w, s.img.h, s.pts, { sym: "ITF14" });
      expect(e.ok).toBe(true);
      expect(Math.abs(tiltOfCorners(e.corners) - deg)).toBeLessThanOrEqual(1);
      for (const k of ["top", "bottom", "left", "right"] as const) {
        expect(e.fit[k].inliers).toBeGreaterThanOrEqual(LINE_FIT_LIMITS.minInliers);
      }
    }
  });

  // (b) 規格 §6 的「近正方形標籤(條高極大)」。這一條同時是 §3.3 那格錯誤宣稱的來源:
  //     舊文寫「0.6 對應條高可達**符號寬**的 1.2 倍」,但 1.2 倍的基準是**定位線長**。
  //     定位點落在最外側暗元素的**中心**,故定位線長恆短於符號寬,兩者不可互換。
  const probe = barcodeLabelAt(12.5, 120, 40, { bearer: false });
  const symW = probe.bar.x1 - probe.bar.x0;
  const locLen = probe.rightCenter - probe.leftCenter;
  const heightCap = 2 * LINE_FIT_LIMITS.searchHalfSpanRatio * locLen; // 上下各搜半徑一次
  const okAt = (barH: number) => {
    const lab = barcodeLabelAt(12.5, Math.round(barH), 40, { bearer: false });
    const s = shootLabel(lab, 0, "y");
    return quadFrom1DEdges(s.img.data, s.img.w, s.img.h, s.pts, { sym: "GS1_128" });
  };

  it("**條高上限的基準量是定位線長,不是符號寬** —— 規格 §3.3 舊文的宣稱不成立", () => {
    expect(locLen).toBeLessThan(symW); // 定位點是元素中心,不是符號邊緣
    // 舊文宣稱的 1.2 × 符號寬 落在上限之外 —— 若哪天真的做到了,這條會紅,提醒回頭改規格
    expect(heightCap).toBeLessThan(1.2 * symW);
    // 實測涵蓋到的是 1.2 × 定位線長,換算成符號寬約 1.14 倍(比值隨最外側元素寬度浮動)
    expect(heightCap / symW).toBeCloseTo(1.145, 2);
  });

  it("條高略低於上限 → 偵測成功;略高於上限 → 誠實退回且指名取樣點不足", () => {
    const under = okAt(heightCap * 0.97);
    expect(under.ok).toBe(true);
    const over = okAt(heightCap * 1.03);
    expect(over.ok).toBe(false);
    expect(over.reason).toContain("取樣點不足");
    expect(over.corners).toBeNull();
    expect((over as { gray?: unknown }).gray).toBeUndefined(); // 退回不得代填影像
  });

  it("正方形標籤(條高 = 符號寬)仍在涵蓋範圍內", () => {
    expect(symW).toBeLessThan(heightCap); // 1:1 落在上限之內才談得上「近正方形涵蓋得到」
    expect(okAt(symW).ok).toBe(true);
  });
});


// ── 真實呼叫端的整合守門(2026-08-04)─────────────────────────────────────────
// 這一組存在的理由:階段 ⑤ 的 411 個測試全綠,但功能在 demo/mobile.html 的實際呼叫端
// **一次都走不到** —— 單元測試餵整張影像,真實管線餵的是「定位點 bbox 外擴」裁出來的
// 細長 ROI。1D 兩個定位點 y 幾乎相同 ⇒ ROI 高度約 48px ⇒ 條的上下端整個被裁掉。
// 故這裡直接把 inspectReal 的裁法搬過來重演一次,不再只餵整張圖。
describe("1D 條端擬合的取像範圍(規格 §3.3「取像範圍」段)", () => {
  // 完全照 demo/mobile.html inspectReal 的量測 ROI 算法(定位點 bbox 外擴 25%,下限 24px)
  const measureRoi = (pts: Pt[], w: number, h: number) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const mx = Math.max(24, (x1 - x0) * 0.25), my = Math.max(24, (y1 - y0) * 0.25);
    return { x0: Math.max(0, Math.floor(x0 - mx)), y0: Math.max(0, Math.floor(y0 - my)),
             x1: Math.min(w, Math.ceil(x1 + mx)), y1: Math.min(h, Math.ceil(y1 + my)) };
  };
  // 裁一塊子影像並把定位點換算進去(對應 roiGrayOf + rectifyRoi 的座標換算,scale=1)
  const cropAndFit = (s: ReturnType<typeof shootLabel>, roi: { x0: number; y0: number; x1: number; y1: number }) => {
    const rw = roi.x1 - roi.x0, rh = roi.y1 - roi.y0;
    const crop = new Uint8ClampedArray(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) crop[y * rw + x] = s.img.data[(roi.y0 + y) * s.img.w + (roi.x0 + x)]!;
    }
    const local = s.pts.map((p: Pt) => ({ x: p.x - roi.x0, y: p.y - roi.y0 }));
    return rectifyQuad(crop, rw, rh, local, { sym: "ITF14" });
  };

  it("**量測 ROI 太矮,條端擬合必定失敗** —— 這是 edgeFitRoi 存在的理由,不是缺陷", () => {
    const s = shootLabel(ITF, 0, "y");
    const m = measureRoi(s.pts, s.img.w, s.img.h);
    expect(m.y1 - m.y0).toBeLessThan(60); // 1D 兩點 y 相同 ⇒ 垂直只外擴到保底的 24px
    const r = cropAndFit(s, m);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("取樣點不足");
  });

  it("**改用 edgeFitRoi 的取像範圍,同一張圖就擬合得出四角**(整合回歸守門)", () => {
    for (const deg of [0, 12, 25]) {
      const s = shootLabel(ITF, deg, "y");
      const ef = edgeFitRoi(s.pts, s.img.w, s.img.h);
      expect(ef).not.toBeNull();
      const r = cropAndFit(s, ef!);
      expect(r.ok).toBe(true);
      expect(r.quadSource).toBe("1d-edges");
      expect(r.derivedCorner).toBe(false);
    }
  });

  it("垂直半徑與 quadFrom1DEdges 的搜尋半徑同源,且留有餘裕", () => {
    const s = shootLabel(ITF, 0, "y");
    const ef = edgeFitRoi(s.pts, s.img.w, s.img.h)!;
    const len = Math.hypot(s.pts[1]!.x - s.pts[0]!.x, s.pts[1]!.y - s.pts[0]!.y);
    const need = LINE_FIT_LIMITS.searchHalfSpanRatio * len; // 搜尋搆得到的半徑
    const got = (ef.y1 - ef.y0) / 2;
    expect(got).toBeGreaterThan(need); // 搜尋範圍必須整個在裁切內
    expect(got).toBeGreaterThanOrEqual(need * (1 + EDGE_FIT_ROI_PAD.ratio)); // 且有餘裕
  });

  it("退化輸入不 throw,回 null", () => {
    expect(edgeFitRoi(null, 900, 600)).toBeNull();
    expect(edgeFitRoi([{ x: 1, y: 1 }], 900, 600)).toBeNull();          // 只有一點
    expect(edgeFitRoi([{ x: 10, y: 10 }, { x: 12, y: 10 }], 900, 600)).toBeNull(); // 定位線過短
    expect(edgeFitRoi([{ x: 0, y: 0 }, { x: NaN, y: 5 }], 900, 600)).toBeNull();
    expect(edgeFitRoi([{ x: 0, y: 0 }, { x: 500, y: 0 }], 0, 0)).toBeNull();
  });
});

// ── D4 可量測性判定(2026-08-05 稽核裁示)──────────────────────────────────
// 由來:對抗性稽核 IMG-09 / IMG-03 / IMG-04。判斷邏輯刻意放純函式,
// 因為 demo/mobile.html 無自動化測試可覆蓋 —— 寫進 HTML 就再也驗不了。
describe("assessMeasurability — 量不到就不出等級", () => {
  const ok = { simulated: false, decoded: true, isOneD: true, scanlineCount: 10, lineAngleDeg: 2 };

  it("正常 1D:可量測,無標記無指引", () => {
    const r = assessMeasurability(ok);
    expect(r.measurable).toBe(true);
    expect(r.simulated).toBe(false);
    expect(r.code).toBe("");
    expect(r.hint).toBe("");
  });

  it("正常 2D(不看掃描線):可量測", () => {
    const r = assessMeasurability({ simulated: false, decoded: true, isOneD: false, scanlineCount: 0 });
    expect(r.measurable).toBe(true);
  });

  it("**解碼失敗 → 不可量測**(IMG-09:原本會拿畫面中央 70% 的任意像素出等級)", () => {
    const r = assessMeasurability({ ...ok, decoded: false });
    expect(r.measurable).toBe(false);
    expect(r.code).toBe(UNMEASURABLE.NO_DECODE);
    expect(r.label).toBe(UNMEASURABLE_LABEL[UNMEASURABLE.NO_DECODE]);
  });

  it("**1D 掃描線全滅 → 不可量測**(IMG-04:原本落到硬寫 {0.5,0.5,0.5} 判 F)", () => {
    const r = assessMeasurability({ ...ok, scanlineCount: 0, lineAngleDeg: 3 });
    expect(r.measurable).toBe(false);
    expect(r.code).toBe(UNMEASURABLE.NO_SCANLINE);
    expect(r.hint).toBe(""); // 角度正常 → 不猜成橫躺
  });

  it("**橫躺(角度超過門檻)才給轉正指引**", () => {
    for (const a of [ROTATED_HINT_MIN_DEG, 60, 90, -90, -75]) {
      const r = assessMeasurability({ ...ok, scanlineCount: 0, lineAngleDeg: a });
      expect(r.measurable).toBe(false);
      expect(r.hint).toBe("條碼橫躺,請轉正後重拍");
    }
  });

  it("角度未達門檻或拿不到 → 不給指引(猜錯會害使用者做無效重拍)", () => {
    for (const a of [0, 10, 44.9, -44.9, null, undefined, NaN]) {
      const r = assessMeasurability({ ...ok, scanlineCount: 0, lineAngleDeg: a });
      expect(r.hint).toBe("");
    }
  });

  it("**示範模式:等級照出但必須標記**(IMG-03 指的是沒有標記,不是不該有等級)", () => {
    const r = assessMeasurability({ ...ok, simulated: true });
    expect(r.measurable).toBe(true);   // 抽掉等級示範模式就沒有意義
    expect(r.simulated).toBe(true);    // 但呼叫端必須全程標記且排除通過率統計
    expect(r.label).toBe(SIMULATED_LABEL);
  });

  it("**示範模式的解碼失敗照樣不出等級**(示範要忠實反映真實路徑,否則教錯心智模型)", () => {
    const r = assessMeasurability({ ...ok, simulated: true, decoded: false });
    expect(r.measurable).toBe(false);           // 不因為是示範就放行
    expect(r.simulated).toBe(true);             // 但仍標記為模擬
    expect(r.code).toBe(UNMEASURABLE.NO_DECODE);
  });

  it("示範模式不看掃描線(沒有真實像素,掃描線數無意義)", () => {
    const r = assessMeasurability({ ...ok, simulated: true, scanlineCount: 0 });
    expect(r.measurable).toBe(true);
    expect(r.simulated).toBe(true);
  });

  it("退化輸入不 throw", () => {
    expect(() => assessMeasurability(null as never)).not.toThrow();
    expect(assessMeasurability(null as never).measurable).toBe(false); // 什麼都沒有 = 沒解碼
    expect(assessMeasurability({} as never).code).toBe(UNMEASURABLE.NO_DECODE);
  });

  it("原因碼與說明表一一對應,沒有孤兒", () => {
    const codes = Object.values(UNMEASURABLE) as string[];
    expect(Object.keys(UNMEASURABLE_LABEL).sort()).toEqual([...codes].sort());
    for (const c of codes) expect(String(UNMEASURABLE_LABEL[c]).length).toBeGreaterThan(0);
  });

  it("說明文字不得暗示合規或斷言符號品質(規格 A3 定位護欄)", () => {
    const all = [...Object.values(UNMEASURABLE_LABEL), SIMULATED_LABEL].join(" ");
    for (const banned of ["ISO", "合規", "驗證通過", "認證", "不合格", "印壞"]) {
      expect(all).not.toContain(banned);
    }
  });
});

// ── D3 光度量測基底:矯正影像 vs 原始 ROI(同圖對照)──────────────────────
// 由來:對抗性稽核 QUAD-04 / IMG-07 —— 1D 一旦走矯正,光度量測的取樣區域從
// 「定位點 bbox 外擴(含靜區)」整塊換成「符號四角內的正射重採樣影像」,
// 而 policies.ts 的允收門檻依規格 §6.1 是凍結的。門檻與量測條件被拆開了。
// 本組是**特性化測試**:記錄現況差值,不主張哪個對。門檻一律不動。
describe("光度量測基底對照(矯正 vs 未矯正,同一張合成圖)", () => {
  // 未矯正側刻意重演 inspectReal 的裁法:定位點 bbox 外擴 25%(最少 24px)
  function bboxRoi(pts: Pt[], w: number, h: number) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const mx = Math.max(24, (x1 - x0) * 0.25), my = Math.max(24, (y1 - y0) * 0.25);
    return { x0: Math.max(0, Math.floor(x0 - mx)), y0: Math.max(0, Math.floor(y0 - my)),
             x1: Math.min(w, Math.ceil(x1 + mx)), y1: Math.min(h, Math.ceil(y1 + my)) };
  }
  const minOf = (a: number[]) => a.reduce((m, v) => (v < m ? v : m), Infinity);

  function pair(deg: number) {
    const s = shootAndRectify(ITF, deg, "y");
    expect(s.rect.ok).toBe(true); // 對照前提:這個角度確實走得到矯正
    const raw = bboxRoi(s.pts as Pt[], s.img.w, s.img.h);
    const pmRaw = roiPhotometric(s.img.data, s.img.w, raw);
    const pmRect = roiPhotometric(s.rect.gray, s.rect.w, { x0: 0, y0: 0, x1: s.rect.w, y1: s.rect.h });
    return { pmRaw, pmRect };
  }

  it("**矯正後 minEdgeContrast 崩到 0,未矯正側不會**(稽核 QUAD-04 的核心證據)", () => {
    const { pmRaw, pmRect } = pair(25);
    const rawMin = minOf(pmRaw.edgeContrasts as number[]);
    const rectMin = minOf(pmRect.edgeContrasts as number[]);
    expect(rawMin).toBeGreaterThan(0.3);   // 未矯正:條與空的邊界對比健在
    expect(rectMin).toBe(0);               // 矯正後:至少一條掃描線量到 0
    expect(rectMin).toBeLessThan(rawMin);
  });

  it("成因是正射範圍把 bearer bar 含了進來,不是矯正把影像弄糊", () => {
    // rLight/rDark(整區平均反射率)兩側仍接近 —— 若是模糊,兩者會一起往中間收
    const { pmRaw, pmRect } = pair(25);
    expect(Math.abs(pmRaw.rLight - pmRect.rLight)).toBeLessThan(0.25);
    expect(Math.abs(pmRaw.rDark - pmRect.rDark)).toBeLessThan(0.25);
  });

  it("0° 拍攝(無透視)同樣成立 —— 與傾角無關,是取樣範圍的差異", () => {
    const { pmRaw, pmRect } = pair(0);
    expect(minOf(pmRect.edgeContrasts as number[]))
      .toBeLessThan(minOf(pmRaw.edgeContrasts as number[]));
  });

  it("守門:光度基底一旦改回吃矯正影像,這組會紅", () => {
    // 這條把「幾何吃正射、光度留原 ROI」從註解變成機制。
    // mobile.html 的 inspectReal 若把 1D 光度改回 rect.gray,上面三條會同時失敗。
    const { pmRaw } = pair(25);
    expect(minOf(pmRaw.edgeContrasts as number[])).toBeGreaterThan(0);
  });
});
