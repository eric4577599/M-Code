// 影像處理層 — 拍攝閘門量測與分級 proxy 的實際計算(demo 與付費版共用基礎)。
// 全部為純函式:輸入像素陣列(RGBA 或灰階)與尺寸,輸出數值;不碰 DOM,
// 因此可在 Node(vitest)直接測試。閾值語意對齊規格 C4.2 / C7.2。

/**
 * RGBA 轉灰階。輸入:RGBA 位元組陣列與寬高;輸出:Uint8ClampedArray 灰階(0–255)。
 * 使用 BT.601 亮度權重(299/587/114)。
 */
export function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return g;
}

/**
 * 對焦度:3×3 Laplacian 響應的變異數(C4.2 focus)。
 * 輸入:灰階陣列與寬高;輸出:varLap(越大越銳利;規格門檻 ≥120 OK)。
 */
export function varianceOfLaplacian(gray, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v; sum2 += v * v; n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/**
 * 眩光佔比:高光像素(L ≥ 250)佔全部像素的比例(C4.2 glare)。
 * 輸入:灰階陣列;輸出:0–1 比例(規格 ≤1% OK、1–4% WARN、>4% FAIL)。
 */
export function glareRatio(gray) {
  let hot = 0;
  for (let i = 0; i < gray.length; i++) if (gray[i] >= 250) hot++;
  return gray.length ? hot / gray.length : 0;
}

/**
 * 白平衡偏差:灰界假設(gray-world)下 R/G 與 B/G 增益偏離 1 的最大值
 * (C4.2 whiteBalance proxy;無參考卡白塊時的近似)。
 * 輸入:RGBA 陣列;輸出:0–1 偏差比例(規格 ≤5% OK)。
 */
export function grayWorldWbDeviation(rgba) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let p = 0; p < rgba.length; p += 4) { r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; n++; }
  if (!n || g === 0) return 0;
  r /= n; g /= n; b /= n;
  return Math.max(Math.abs(r / g - 1), Math.abs(b / g - 1));
}

// 針對單一亮度剖面找週期帶內主峰振幅(Goertzel 逐週期掃描)
function profilePeakAmp(profile, minPeriod, maxPeriod) {
  const n = profile.length;
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= n;
  let best = 0;
  const pMax = Math.min(maxPeriod, Math.floor(n / 3));
  for (let p = minPeriod; p <= pMax; p++) {
    let re = 0, im = 0;
    const wv = (2 * Math.PI) / p;
    for (let i = 0; i < n; i++) {
      const x = profile[i] - mean;
      re += x * Math.cos(wv * i);
      im -= x * Math.sin(wv * i);
    }
    const amp = (2 * Math.sqrt(re * re + im * im)) / n;
    if (amp > best) best = amp;
  }
  return { peakAmp: best, mean };
}

/**
 * 楞痕(washboard)振幅比:對「列平均」與「行平均」亮度剖面,在指定像素
 * 週期帶內找主峰,回傳 主峰振幅 / 平均亮度 的較大者(C4.2 washboard proxy;
 * 規格 2–10mm 帶,手機距離下約對應 8–96px)。
 * 輸入:灰階陣列與寬高,可選週期帶;輸出:ampRatio(≤0.08 OK、≤0.15 WARN)。
 */
export function washboardAmpRatio(gray, w, h, minPeriod = 8, maxPeriod = 96) {
  const colProf = new Float64Array(w), rowProf = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      colProf[x] += v; rowProf[y] += v;
    }
  }
  for (let x = 0; x < w; x++) colProf[x] /= h;
  for (let y = 0; y < h; y++) rowProf[y] /= w;
  const a = profilePeakAmp(colProf, minPeriod, maxPeriod);
  const b = profilePeakAmp(rowProf, minPeriod, maxPeriod);
  const meanLuma = (a.mean + b.mean) / 2 || 1;
  return Math.max(a.peakAmp, b.peakAmp) / meanLuma;
}

/**
 * Otsu 自動二值化閾值。輸入:灰階陣列;輸出:閾值 t,語意為
 * 「v < t 屬暗類、v ≥ t 屬亮類」(回傳暗類上界 +1,與下游判斷式一致)。
 * 用於把符號 ROI 分成暗(條/模組)與亮(底)兩類。
 */
export function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumB = 0, wB = 0, best = 0, bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return bestT + 1; // 暗類含 bestT 本身;+1 使 v < t 的判斷把邊界劃入暗類
}

// 取出 ROI 內的灰階子陣列(列優先)
function roiSlice(gray, w, roi) {
  const { x0, y0, x1, y1 } = roi;
  const rw = x1 - x0, rh = y1 - y0;
  const out = new Uint8ClampedArray(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) out[y * rw + x] = gray[(y0 + y) * w + (x0 + x)];
  }
  return { data: out, w: rw, h: rh };
}

// 單條掃描線的黑白 run 分段:輸入灰階列與閾值,輸出 [{len, dark, min, max, mean}]
export function scanlineRuns(row, t) {
  const runs = [];
  let cur = null;
  for (let x = 0; x < row.length; x++) {
    const v = row[x], dark = v < t;
    if (!cur || cur.dark !== dark) {
      cur = { len: 1, dark, min: v, max: v, sum: v };
      runs.push(cur);
    } else {
      cur.len++; cur.sum += v;
      if (v < cur.min) cur.min = v;
      if (v > cur.max) cur.max = v;
    }
  }
  for (const r of runs) { r.mean = r.sum / r.len; delete r.sum; }
  return runs;
}

/**
 * ROI 光度量測(C7.1/C7.2 photometric proxy):Otsu 分兩類後,
 * rLight=亮類平均/255、rDark=暗類平均/255、rDarkMin=暗類 5 百分位/255,
 * edgeContrasts=每條掃描線上「相鄰 run 平均亮度差」的最小值(0–1)。
 * 輸入:灰階、寬、ROI、掃描線數;輸出 PhotometricProxyInputs 形狀的物件。
 */
export function roiPhotometric(gray, w, roi, scanlines = 10) {
  const r = roiSlice(gray, w, roi);
  const t = otsu(r.data);
  let lSum = 0, lN = 0, dSum = 0, dN = 0;
  const darks = [];
  for (let i = 0; i < r.data.length; i++) {
    const v = r.data[i];
    if (v < t) { dSum += v; dN++; darks.push(v); }
    else { lSum += v; lN++; }
  }
  if (!dN || !lN) {
    return { rLight: lN ? lSum / lN / 255 : 0, rDark: dN ? dSum / dN / 255 : 0, rDarkMin: 0, edgeContrasts: [0], threshold: t };
  }
  darks.sort((a, b) => a - b);
  const p5 = darks[Math.floor(darks.length * 0.05)];
  const edgeContrasts = [];
  for (let k = 0; k < scanlines; k++) {
    const y = Math.floor((r.h * (k + 0.5)) / scanlines);
    const row = r.data.subarray(y * r.w, (y + 1) * r.w);
    const runs = scanlineRuns(row, t).filter((x) => x.len >= 2);
    let minEdge = 1;
    for (let i = 1; i < runs.length; i++) {
      const c = Math.abs(runs[i].mean - runs[i - 1].mean) / 255;
      if (c < minEdge) minEdge = c;
    }
    edgeContrasts.push(runs.length >= 2 ? minEdge : 0);
  }
  return { rLight: lSum / lN / 255, rDark: dSum / dN / 255, rDarkMin: p5 / 255, edgeContrasts, threshold: t };
}

/**
 * 1D 幾何量測(C7.2 DEC/DEF proxy):對 ROI 取 N 條掃描線,每條:
 * - 以最窄 run(10 百分位)當模組寬,run 寬對模組整數倍的最大偏差(模組分數)
 *   為 maxWidthDeviation,tolerance=0.5(ISO 容差半模組)
 * - 暗 run 內(max−min)/255 的最大值為 DEF 的反射不均輸入
 * 另回傳模組寬中位數(px)供解析度檢查。
 * 輸入:灰階、寬、ROI、掃描線數;輸出:{ scanlines:[{geometric...}], modulePx }。
 */
export function roi1DGeometry(gray, w, roi, scanlines = 10) {
  const r = roiSlice(gray, w, roi);
  const t = otsu(r.data);
  const out = [];
  const moduleWidths = [];
  for (let k = 0; k < scanlines; k++) {
    const y = Math.floor((r.h * (k + 0.5)) / scanlines);
    const row = r.data.subarray(y * r.w, (y + 1) * r.w);
    // 去掉貼邊 run(通常是 quiet zone / 邊框的殘段)
    const runs = scanlineRuns(row, t).slice(1, -1).filter((x) => x.len >= 2);
    if (runs.length < 4) { out.push(null); continue; }
    const lens = runs.map((x) => x.len).sort((a, b) => a - b);
    const module = lens[Math.floor(lens.length * 0.1)] || 1;
    moduleWidths.push(module);
    let maxDev = 0, maxDef = 0;
    for (const run of runs) {
      const m = run.len / module;
      const dev = Math.abs(m - Math.round(m));
      if (dev > maxDev) maxDev = dev;
      if (run.dark) {
        const nu = (run.max - run.min) / 255;
        if (nu > maxDef) maxDef = nu;
      }
    }
    out.push({ maxWidthDeviation: maxDev, tolerance: 0.5, maxElementReflectanceNonUniformity: maxDef });
  }
  moduleWidths.sort((a, b) => a - b);
  const modulePx = moduleWidths.length ? moduleWidths[Math.floor(moduleWidths.length / 2)] : 0;
  return { scanlines: out.filter(Boolean), modulePx };
}

/**
 * 2D 幾何量測(C7.2 GNU/FPD proxy)+ 印向/透視角:
 * 由 ZXing result points(QR:左下、左上、右上 finder 中心)計算
 * - gridDeviation:兩臂夾角偏離 90° 與臂長差的加權(0–1)
 * - picketAngleDeg:上緣向量相對水平的角度(印向)
 * - tiltDeg:兩臂長差換算的透視傾斜近似
 * 輸入:points [{x,y},...](至少 3 點);輸出:{ gridDeviation, picketAngleDeg, tiltDeg }。
 */
export function quadGeometry(points) {
  if (!points || points.length < 3) return { gridDeviation: 0, picketAngleDeg: 0, tiltDeg: 0 };
  const [bl, tl, tr] = points;
  const v1 = { x: tr.x - tl.x, y: tr.y - tl.y }; // 上緣
  const v2 = { x: bl.x - tl.x, y: bl.y - tl.y }; // 左緣
  const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
  if (!l1 || !l2) return { gridDeviation: 0, picketAngleDeg: 0, tiltDeg: 0 };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const angle = (Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2)))) * 180) / Math.PI;
  const angleDev = Math.abs(90 - angle) / 45; // 偏離直角,45° 拉滿
  const lenDev = Math.abs(l1 - l2) / Math.max(l1, l2);
  const gridDeviation = Math.max(0, Math.min(1, 0.6 * angleDev + 0.4 * lenDev));
  const picketAngleDeg = Math.abs((Math.atan2(v1.y, v1.x) * 180) / Math.PI);
  const tiltDeg = (Math.asin(Math.min(1, lenDev)) * 180) / Math.PI / 2;
  return { gridDeviation, picketAngleDeg: Math.min(picketAngleDeg, 180 - picketAngleDeg), tiltDeg };
}

/**
 * 1D 印向角:ZXing 1D result points 是掃描線上的兩端點,
 * 其連線相對「水平」的夾角即符號旋轉角(條直立時掃描線水平)。
 * 輸入:points(≥2 點);輸出:0–90 的角度。
 */
export function lineAngleDeg(points) {
  if (!points || points.length < 2) return 0;
  const dx = points[1].x - points[0].x, dy = points[1].y - points[0].y;
  if (!dx && !dy) return 0;
  const a = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  return Math.min(a, 180 - a);
}

/**
 * FPD(固定圖樣損傷)proxy:暗類像素的標準差相對符號對比的比例。
 * 印刷刮白/針孔會讓暗模組亮度發散 → 比例升高。輸入:灰階、寬、ROI 與
 * 光度量測結果;輸出 0–1 損傷比例(僅為 proxy,非 ISO 15415 FPD 實測)。
 */
export function finderDamageProxy(gray, w, roi, photometric) {
  const r = roiSlice(gray, w, roi);
  const t = photometric.threshold ?? otsu(r.data);
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < r.data.length; i++) {
    const v = r.data[i];
    if (v < t) { sum += v; sum2 += v * v; n++; }
  }
  if (n < 4) return 0;
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean)) / 255;
  const sc = Math.max(0.05, photometric.rLight - photometric.rDark);
  return Math.max(0, Math.min(1, (sd / sc) * 0.8));
}
