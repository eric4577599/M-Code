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
