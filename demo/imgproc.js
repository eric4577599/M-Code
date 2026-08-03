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

// 由 capabilities 的區間欄位取出可用上限:只接受有限正數,
// 缺欄位、null、0、字串、NaN 一律視為不可得並回 0(呼叫端據此降級)
function capabilityMax(range) {
  if (!range || typeof range !== "object") return 0;
  const v = range.max;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 挑選快門時要請求的解析度(規格 §3.1 三層降級)。純函式,不碰 MediaStream,
 * 能力表由呼叫端讀好再注入,才測得到。
 * 輸入:
 * - caps:`MediaStreamTrack.getCapabilities()` 的回傳,可能為 null 或殘缺(Safari)
 * - photoCaps:`ImageCapture.getPhotoCapabilities()` 的回傳,可能為 null / undefined
 * 輸出:{ width, height, source, tier, widthOnly }
 * - tier 1 / source 'photo':photoCaps 的 imageWidth.max 與 imageHeight.max 皆可用
 *   (Android Chrome 的照片上限通常遠高於視訊)
 * - tier 2 / source 'track':退而用 caps 的 width.max 與 height.max
 * - tier 3 / source 'fallback':兩者皆不可得 → 4096×4096,語意是「請求 ideal
 *   讓瀏覽器自己 clamp」,不猜裝置能力
 * 任何殘缺輸入都不得 throw;寬高必須同時可得才採用,只有其中一邊視為不可得。
 *
 * widthOnly 的意思:**true 時呼叫端只准拿 width 下 ideal 約束,不得連 height 一起下**。
 * 為什麼要分:getUserMedia / applyConstraints 的 ideal 是靠 fitness distance 挑模式,
 * 寬與高各算一份距離再相加。
 * - tier 2 的 caps.width.max 與 caps.height.max 是兩個獨立區間的上限,**不保證來自
 *   同一個可用模式**(例:1920×1080 與 1280×960 並存時,上限組出 1920×960 這種
 *   不存在的組合),兩邊一起下約束會把瀏覽器推去選一個折衷的怪模式。
 * - tier 3 的 4096×4096 是為了「讓瀏覽器自己 clamp」而寫的請求值,1:1 長寬比不是
 *   任何實機的真實比例,一起下高度只會讓 fitness distance 偏向接近正方形的模式。
 * - tier 1 的寬高是給 ImageCapture.takePhoto() 的 photoSettings,由 UA 直接挑最接近的
 *   照片尺寸,不走 fitness distance,故 widthOnly 為 false,寬高可一起帶。
 * 高度一律交給裝置依原生長寬比決定 —— 分析只吃寬度(§3.1 只對 ROI 取像素)。
 */
export function pickBestResolution(caps, photoCaps) {
  const pw = capabilityMax(photoCaps && photoCaps.imageWidth);
  const ph = capabilityMax(photoCaps && photoCaps.imageHeight);
  if (pw && ph) return { width: pw, height: ph, source: "photo", tier: 1, widthOnly: false };
  const tw = capabilityMax(caps && caps.width);
  const th = capabilityMax(caps && caps.height);
  if (tw && th) return { width: tw, height: th, source: "track", tier: 2, widthOnly: true };
  return { width: 4096, height: 4096, source: "fallback", tier: 3, widthOnly: true };
}

/**
 * ROI 座標放大並夾回畫布邊界(規格 §3.1:解碼與定位跑降取樣版,ROI 座標再放大回
 * 全解析度,只對放大後的 ROI 取像素)。
 * 輸入:
 * - roi:降取樣版座標的 { x0, y0, x1, y1 }
 * - k:降取樣版 → 全解析度的放大倍率(全解析度寬 / 降取樣版寬)
 * - maxW / maxH:全解析度畫布的寬高,夾回用
 * 輸出:全解析度座標的新 roi { x0, y0, x1, y1 },整數。
 * 邏輯:左上取 floor、右下取 ceil(寧可多包一點也不切到符號邊緣),再夾進
 *   [0, maxW] / [0, maxH];退化(x1 ≤ x0,含原始寬或高為 0)時往右下補 1 px,
 *   保證回傳至少 1×1 且完全落在畫布內 —— 下游 getImageData 取到畫布外會直接壞掉。
 */
export function scaleRoi(roi, k, maxW, maxH) {
  const w = Math.max(1, Math.floor(maxW)), h = Math.max(1, Math.floor(maxH));
  const clamp = (v, hi) => Math.min(Math.max(0, v), hi);
  const x0 = clamp(Math.floor(roi.x0 * k), w - 1), y0 = clamp(Math.floor(roi.y0 * k), h - 1);
  const x1 = Math.max(x0 + 1, clamp(Math.ceil(roi.x1 * k), w));
  const y1 = Math.max(y0 + 1, clamp(Math.ceil(roi.y1 * k), h));
  return { x0, y0, x1, y1 };
}

/**
 * ROI 取樣預算(規格 §3.1 記憶體護欄):4032×3024 全張 getImageData 是 48MB RGBA、
 * toGray 再吃 12MB,iOS Safari 舊機會被系統回收分頁,故 ROI 過大時先等比縮再取像素。
 * 輸入:ROI 寬 rw、高 rh、像素數上限 maxPixels(非有限正數視為無上限)。
 * 輸出:{ w, h, scale } —— 該取的取樣寬高與縮放倍率。
 * 邏輯:面積在上限內 → 原尺寸、scale 為 1;超過 → scale = √(上限/面積),寬高等比
 *   縮放後四捨五入,至少 1 px(量測值即以該取樣尺寸為準,不再是原始 ROI 尺寸)。
 */
export function fitRoiToBudget(rw, rh, maxPixels) {
  const w0 = Math.max(1, Math.round(rw)), h0 = Math.max(1, Math.round(rh));
  const area = w0 * h0;
  const budget = typeof maxPixels === "number" && Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : Infinity;
  if (area <= budget) return { w: w0, h: h0, scale: 1 };
  const scale = Math.sqrt(budget / area);
  return { w: Math.max(1, Math.round(w0 * scale)), h: Math.max(1, Math.round(h0 * scale)), scale };
}

// ── 梯形矯正(規格 §3.3 提案 B)────────────────────────────────────────────
// 整段共用的座標與矩陣約定,呼叫端請照此傳值:
// - 點一律是 { x, y },影像座標(x 向右、y 向下),單位像素。
// - 單應矩陣 H 是 row-major 的 9 元素陣列 [h11,h12,h13,h21,h22,h23,h31,h32,h33],
//   齊次式 (u,v,w)ᵀ = H·(x,y,1)ᵀ,實際座標為 (u/w, v/w)。
// - **方向固定為「來源影像 → 正射輸出」**,即 solveHomography(影像四角, 正射四角)。
//   warpPerspective 與 tiltFromHomography 吃的都是同一個 H,呼叫端不必自己反轉。
// - 任何退化輸入(點數不足、四點共線、矩陣奇異、焦距不可得)一律回 **null 代表不可得**,
//   不 throw、不代填數字 —— 規格 §3.3 明訂「信心不足時誠實退回不矯正」,不得硬套一個
//   錯的矩陣;同理也不得代填一個「看起來正常」的量測值,閘門語意下那通常正好是放行值
//   (見 tiltFromHomography)。要退回哪條路徑由呼叫端決定。

// 取出前 n 個座標有限的點(座標非有限的點直接略過);不足 n 個回 null
function takeFinitePoints(points, n) {
  if (!points || typeof points.length !== "number") return null;
  const out = [];
  for (let i = 0; i < points.length && out.length < n; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    out.push({ x: p.x, y: p.y });
  }
  return out.length === n ? out : null;
}

// 四邊形 shoelace 面積的兩倍(帶正負號)。y 向下的影像座標系中,正值代表
// 畫面上的順時針(即 TL→TR→BR→BL)方向。
function polygonArea2(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

// 最小面積外接矩形(oriented bbox)。輸入:環狀順序的 4 點;
// 輸出:{ area, long, short } —— 矩形面積與長短兩邊的邊長,完全退化時皆為 0。
// 候選方向只取**四條邊自己的方向**:凸多邊形的最小面積外接矩形必與其中一邊貼齊
// (rotating calipers 定理),凹四邊形取到的則是上界(偏保守,寧可低估填充率)。
// **不得把「軸對齊」列為候選** —— 那會讓量測值隨畫面內旋轉角改變,正是 2026-07-31
// 修掉的病灶:以軸對齊外接框當分母時,10:1 的 1D 四邊形只要 picket 轉 25°
// (閘門本身只判 WARN、明確放行)填充率就掉到 0.205,再多一點雜訊就靜默退回。
function minAreaRect(q) {
  let best = null;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue; // 重複點:這條邊給不出方向
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    let uMin = Infinity, uMax = -Infinity, nMin = Infinity, nMax = -Infinity;
    for (const p of q) {
      const pu = p.x * ux + p.y * uy, pn = -p.x * uy + p.y * ux;
      if (pu < uMin) uMin = pu;
      if (pu > uMax) uMax = pu;
      if (pn < nMin) nMin = pn;
      if (pn > nMax) nMax = pn;
    }
    const w = uMax - uMin, h = nMax - nMin, area = w * h;
    if (!best || area < best.area) best = { area, long: Math.max(w, h), short: Math.min(w, h) };
  }
  return best || { area: 0, long: 0, short: 0 }; // 四點完全重合:沒有任何方向可用
}

/**
 * 四角擬合信心的門檻(規格 §3.3「擬合信心不足時誠實退回不矯正」)。
 * 四項互相獨立、任一項不過即判退化;數字的理由見 quadConfidence 的 JSDoc。
 * 這些門檻都與四邊形的整體尺度**無關**(不是「相對 span 的比例」),
 * 才擋得住「整體很大、但某一邊薄如紙片」的近退化四邊形;而且都是**旋轉不變**的量,
 * 同一個四邊形在畫面內轉任意角度,四個實測值都不變(picket 角由閘門去判,不由本函式)。
 */
export const QUAD_CONFIDENCE_LIMITS = Object.freeze({
  minEdgePx: 8,
  minFillRatio: 0.55,
  maxAspectRatio: 25,
  minAngleDeg: 20,
});

/**
 * 四角擬合信心(規格 §3.3):判斷這組四角值不值得拿去解單應矩陣。
 * 輸入:corners,4 個 { x, y },**必須已是環狀順序**(orderCorners 的輸出);
 *   非環狀順序會構成自交多邊形,面積與內角都失去意義。
 * 輸出:{ ok, areaPx, minEdgePx, fillRatio, aspectRatio, minAngleDeg };點數不足回 null。
 * 邏輯:單看「面積是否為 0」只擋得住**完全**共線 —— 近退化四邊形(例如 1000×0.001 的
 *   紙片)照樣解得出 mapErr=0 的「合法」H,warpPerspective 會把 0.001px 高的來源
 *   拉伸成整張正射圖,下游 roi1DGeometry 還照樣算得出看似正常的 maxWidthDeviation。
 *   故改為四重把關,任一項不過就 ok=false,由呼叫端誠實退回不矯正:
 * - **minEdgePx = 8**:最短邊的像素長度。與 resolution 檢查的 pxPerModule ≥ 8 同源
 *   —— 一條邊短於 8px 連一個模組都放不下,矯正出來的細節必然是內插憑空生出來的。
 *   用絕對像素而非相對 span,才擋得住紙片狀四邊形。
 * - **minFillRatio = 0.55**:四邊形面積 / **最小面積外接矩形**面積(見 minAreaRect)。
 *   分母用 oriented bbox 而非軸對齊外接框,量才是**旋轉不變**的:正矩形不論轉幾度都是
 *   1.0,45° 旋轉的正方形也是 1.0(舊定義是 0.5),透視梯形則隨遠近端比例下降。
 *   凸四邊形此值的**下界恰是 0.5**(退化成三角形時等號成立,即三點共線、DLT 已不可解),
 *   故 0.55 的語意是「離三角形退化至少留 10% 餘裕」。換算成看得懂的量:等腰梯形的
 *   fillRatio = (遠端邊 + 近端邊) / (2 × 近端邊),0.55 恰好對應「**遠端邊只剩近端邊的
 *   1/10**」才擋 —— 本輪針孔合成實測(f=900、距離 833、長寬比 4.5)繞軸傾到 85° 時
 *   fillRatio 仍有 0.736,離門檻還很遠,5° 透視閘門下更是 0.970。共線四邊形此值為 0,
 *   故本項同時涵蓋舊的共線判定。
 *   **2026-07-31 修正:** 舊版分母是軸對齊外接框、門檻 0.2,那組數字是以近正方形符號推的
 *   (正矩形 1.0、45° 正方形 0.5),對 1D 不成立 —— 長寬比 10:1 的四邊形只要在畫面內轉
 *   25°(picket 閘門本身只判 WARN、明確放行)填充率就掉到 0.205,15:1 轉 20° 更直接
 *   0.171 → ok=false → orderCorners 回 null,角點稍有雜訊就靜默退回不矯正,
 *   而規格 §3.3 說「一維是最硬的一段」,階段 ⑤ 的 bearer bar 擬合正靠這道把關。
 * - **maxAspectRatio = 25**:最小面積外接矩形的長邊 / 短邊,即「細長斜帶」的獨立判準
 *   (旋轉不變性由 minFillRatio 交還之後,細長與否得自己明講,不能再靠填充率順便擋)。
 *   數字用真實 1D 幾何定,不沿用正方形推來的值:ITF-14 100% 總寬約 142.7mm(§D2)、
 *   條高 32mm → 約 4.5:1;GS1-128 最長 165mm、最低條高 13mm → 約 12.7:1,是合法符號裡
 *   最細長的一種。再留約 2 倍餘裕吸收透視壓縮(繞長軸傾 60° 時高度只剩 cos60=0.5)
 *   → 25。超過 25:1 已不可能是任何 1D 符號的四角,通常是擬合塌陷成幾條 bar 的殘骸;
 *   真的是「拍得太斜」則由 picket / perspective 閘門去報原因,不該由本函式靜默吃掉。
 * - **minAngleDeg = 20**:最小內角。透視再嚴重,矩形投影的內角也不會小於約 30°,
 *   小於 20° 代表兩角幾乎重合或三點近共線 —— DLT 在這種組態下對 1px 的角點誤差
 *   極度敏感,解得出來也不可信。
 * 注意:minAngleDeg 取的是兩邊的**非反向夾角**(≤180°),凹四邊形的反角會被記成補角,
 *   故本函式是退化判定、**不是凸性檢查**(凹點附近的夾角變小時仍會被擋下)。
 */
export function quadConfidence(corners) {
  const q = takeFinitePoints(corners, 4);
  if (!q) return null;
  const rect = minAreaRect(q);
  const areaPx = Math.abs(polygonArea2(q)) / 2;
  let minEdgePx = Infinity, minAngleDeg = 180;
  for (let i = 0; i < 4; i++) {
    const p = q[i], next = q[(i + 1) % 4], prev = q[(i + 3) % 4];
    const edge = Math.hypot(next.x - p.x, next.y - p.y);
    if (edge < minEdgePx) minEdgePx = edge;
    const a = { x: prev.x - p.x, y: prev.y - p.y }, b = { x: next.x - p.x, y: next.y - p.y };
    const la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y);
    // 邊長為 0(重複點)時內角無定義,直接記 0 讓判定失敗
    const cos = la && lb ? (a.x * b.x + a.y * b.y) / (la * lb) : 1;
    const deg = la && lb ? (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI : 0;
    if (deg < minAngleDeg) minAngleDeg = deg;
  }
  const fillRatio = rect.area > 0 ? areaPx / rect.area : 0;
  // 短邊為 0(共線或四點重合)時長寬比視為無限大,不回 NaN —— NaN 的比較恆為 false,
  // 語意上會變成「不知道就當它過不了」的巧合,不如直接寫成「無限細長」明確。
  const aspectRatio = rect.short > 0 ? rect.long / rect.short : Infinity;
  const ok =
    minEdgePx >= QUAD_CONFIDENCE_LIMITS.minEdgePx &&
    fillRatio >= QUAD_CONFIDENCE_LIMITS.minFillRatio &&
    aspectRatio <= QUAD_CONFIDENCE_LIMITS.maxAspectRatio &&
    minAngleDeg >= QUAD_CONFIDENCE_LIMITS.minAngleDeg;
  return { ok, areaPx, minEdgePx, fillRatio, aspectRatio, minAngleDeg };
}

/**
 * 四角排序(**只排序、不判定退化**):任意順序的 4 點 → [TL, TR, BR, BL](規格 §3.3)。
 * 輸入:points,≥4 個 { x, y };超過 4 個只取前 4 個座標有限者。
 * 輸出:長度 4 的陣列;**只有點數不足時**回 null(排不出來),擬合信心一概不管。
 * 邏輯:各符號別回傳的點順序不一致(QR 是 finder 中心、DataMatrix 是 L 型端點),
 *   故先以重心極角排成環狀(y 向下時,極角遞增即畫面順時針),再把「x+y 最小」
 *   的點轉到開頭當 TL —— 環狀順序 + 固定起點,同一組點不論輸入順序都給同一結果。
 *   注意:起點用 x+y 最小,在符號旋轉超過 45° 時會挑到相鄰角(印向本來就該先過
 *   picket 閘門),此處不另做旋轉推測。
 * **為什麼要單獨匯出這一支(2026-07-31):** quadConfidence 回傳實測值而非只回布林,
 *   是為了「讓呼叫端在退回時說明是哪一項不過」(規格 §3.3),但它的輸入前提是
 *   **已經環狀排序**,而唯一產出環狀順序的公開入口是 orderCorners —— 呼叫端拿到 null
 *   之後就再也問不出原因,那個設計目的在舊的 API 形狀下根本達不到。
 *   階段 ④/⑤ 的護欄要的正是「退回時講得出原因」,故拆成:
 *   `const raw = orderCornersRaw(pts); const conf = quadConfidence(raw);`
 *   —— 排序與判定分離,orderCorners 則保留為「排序 + 判定」的便利包裝。
 */
export function orderCornersRaw(points) {
  const q = takeFinitePoints(points, 4);
  if (!q) return null;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const ring = q
    .map((p) => ({ p, a: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((m, n) => m.a - n.a)
    .map((e) => e.p);
  let start = 0;
  for (let i = 1; i < 4; i++) {
    if (ring[i].x + ring[i].y < ring[start].x + ring[start].y) start = i;
  }
  let out = [0, 1, 2, 3].map((i) => ring[(start + i) % 4]);
  const area2 = polygonArea2(out);
  // 極角排序理應給出順時針環,萬一重心落在四邊形外而反向,就翻回來(保住起點)
  if (area2 < 0) out = [out[0], out[3], out[2], out[1]];
  return out;
}

/**
 * 四角排序 + 擬合信心判定(規格 §3.3):任意順序的 4 點 → [TL, TR, BR, BL] 或 null。
 * 輸入同 orderCornersRaw;輸出:點數不足,或 quadConfidence 判定擬合信心不足(重複點、
 *   四點共線、紙片狀、過度細長等近退化四邊形)時回 null,其餘回排好的四角。
 * 退化判定交給 quadConfidence 的四重把關(最短邊 / 填充率 / 長寬比 / 最小內角)。
 * 舊版只比「面積 vs span²」,實質等於「面積 ≥ 1px² 就放行」,近退化四邊形照樣通過。
 * **要知道是哪一項不過**(退回時要對使用者說明原因)就別用本函式的 null,改走
 * `quadConfidence(orderCornersRaw(points))` 拿實測值 —— 兩者判定完全同源。
 */
export function orderCorners(points) {
  const out = orderCornersRaw(points);
  if (!out) return null;
  const conf = quadConfidence(out);
  if (!conf || !conf.ok) return null;
  return out;
}

/**
 * 正射目標矩形尺寸(規格 §3.3):寬取上下兩邊長的**最大值**、高取左右兩邊長的最大值。
 * 輸入:corners,orderCorners 的輸出([TL, TR, BR, BL]);輸出:{ w, h } 整數,
 *   點數不足回 null。
 * 邏輯:取最大而非平均,是為了**少損失一部分解析度** —— resolution 檢查的
 *   pxPerModule ≥ 8 直接依賴取樣密度(規格 §1.5)。
 *   **但這不等於「不降取樣」**:只有仿射變形(整張等比)才可能一點都不損失。
 *   透視變形下同一條掃描線上近端與遠端的取樣密度本來就不同,矯正輸出是單一均勻網格,
 *   取邊長最大值仍會把近端壓下來 —— 本輪合成測試實測:模組寬 10.0–14.5px 的傾斜影像
 *   矯正後落在 12.0–12.5px,近端的 14.5 被降到 12.5。
 *   **矯正不能替代把手機拍正**(現場教育訓練請照這個說法,不要說「矯正後就不損失」)。
 *   退化四邊形至少回 1×1,避免下游配出 0 面積的緩衝區。
 */
export function targetRectSize(corners) {
  const c = takeFinitePoints(corners, 4);
  if (!c) return null;
  const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const w = Math.max(d(c[0], c[1]), d(c[3], c[2])); // 上邊、下邊
  const h = Math.max(d(c[0], c[3]), d(c[1], c[2])); // 左邊、右邊
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

// 8 元線性方程組的高斯消去(含部分主元選取)。輸入:8×8 係數列陣列 A 與常數項 b;
// 輸出:解陣列,主元過小(奇異)或解含非有限值時回 null。
// 門檻用相對值 1e-9 × 最大元素:DLT 的係數量級橫跨 1 到 u·x(千像素時達 1e6),
// 用絕對門檻會在大座標下把正常解誤判成奇異。
function solveLinear8(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  let scaleMax = 0;
  for (const row of M) for (const v of row) {
    if (!Number.isFinite(v)) return null;
    const a = Math.abs(v);
    if (a > scaleMax) scaleMax = a;
  }
  if (!(scaleMax > 0)) return null;
  const tol = 1e-9 * scaleMax;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) <= tol) return null; // 奇異:四點共線或退化四邊形
    if (piv !== c) { const t = M[piv]; M[piv] = M[c]; M[c] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

// 3×3 反矩陣(row-major 9 元素)。輸入:H;輸出:H⁻¹ 或 null(奇異/含非有限值)。
// 行列式門檻取 1e-12 × 三個列向量長度的乘積(Hadamard 上界的相對量):
// 直接用「最大元素³」會在含大平移量的正常矩陣上把門檻抬到比行列式還大而誤殺。
function invert3x3(H) {
  if (!H || H.length !== 9) return null;
  for (const v of H) if (!Number.isFinite(v)) return null;
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const bound = Math.hypot(a, b, c) * Math.hypot(d, e, f) * Math.hypot(g, h, i);
  if (!Number.isFinite(det) || Math.abs(det) <= 1e-12 * bound) return null;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

/**
 * 解單應矩陣(規格 §3.3):兩組 4 點 → 3×3 或 null。
 * 輸入:src / dst 各 ≥4 個 { x, y },**索引一一對應**(通常兩邊都先過 orderCorners)。
 * 輸出:row-major 9 元素矩陣(h33 固定為 1),奇異時回 null,絕不回含 NaN 的矩陣。
 * 邏輯:DLT 標準式,每組對應點給兩條方程
 *   x·h11 + y·h12 + h13 − u·x·h31 − u·y·h32 = u
 *   x·h21 + y·h22 + h23 − v·x·h31 − v·y·h32 = v
 *   共 8 條、8 個未知數,以自寫 8×8 高斯消去(部分主元)求解;
 *   四點共線時消去過程主元趨近 0 → null,退化 dst(四點重合)則由行列式檢查攔下。
 */
export function solveHomography(src, dst) {
  const s = takeFinitePoints(src, 4);
  const d = takeFinitePoints(dst, 4);
  if (!s || !d) return null;
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const x = s[i].x, y = s[i].y, u = d[i].x, v = d[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solveLinear8(A, b);
  if (!h) return null;
  const H = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  if (!invert3x3(H)) return null; // 解得出來但矩陣本身奇異(例如 dst 四點重合)
  return H;
}

// 雙線性取樣。輸入:灰階、寬高、次像素座標;輸出:內插後的亮度(0–255)。
// 越界處理:座標先夾回 [0, w−1]×[0, h−1],即**複製邊界像素**。
// 為什麼不用 0 填:0 是全黑,會在正射影像四周造出不存在的暗 run,直接污染
// scanlineRuns 的分段與 edgeContrasts;複製邊界則沿用該處原有的亮度(靜區通常是亮的)。
function sampleBilinear(gray, w, h, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  const cx = Math.min(Math.max(x, 0), w - 1), cy = Math.min(Math.max(y, 0), h - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = cx - x0, fy = cy - y0;
  const p00 = gray[y0 * w + x0], p10 = gray[y0 * w + x1];
  const p01 = gray[y1 * w + x0], p11 = gray[y1 * w + x1];
  const top = p00 + (p10 - p00) * fx, bot = p01 + (p11 - p01) * fx;
  return top + (bot - top) * fy;
}

/**
 * 正射輸出的面積預算(規格 §3.1「記憶體護欄(硬性)」)。與 mobile.html 的
 * MAX_ROI_PIXELS 同值同源:4032×3024 的來源下 targetRectSize 最壞可給到影像對角線
 * 量級(約 5040),25M 像素等於 25MB 陣列加同步的雙線性重採樣迴圈,行動裝置會當掉。
 * 階段 ④ 接線時 mobile.html 應改為引用本常數,不要再各寫一份數字。
 */
export const MAX_WARP_PIXELS = 4e6;

/**
 * 透視矯正(規格 §3.3):灰階 + H → 正射灰階。
 * 輸入:gray 來源灰階、w/h 來源寬高、H(來源→輸出,見本節開頭約定)、outW/outH 輸出寬高、
 *   maxPixels 輸出面積上限(預設 MAX_WARP_PIXELS;非有限正數 = 不設上限,記憶體自負)。
 * 輸出:{ data, w, h, scale };來源或尺寸不合法、H 為 null 或奇異時回 null,不 throw。
 * - w / h 是**實際**輸出尺寸,超出預算時已等比縮小,不等於請求的 outW/outH。
 * - scale = 實際輸出寬 / 請求寬(未縮時恰為 1)。呼叫端據此把量測值換算回請求尺度,
 *   並標註「取樣密度已降低」—— 比照 fitRoiToBudget 與 mobile.html 的 roiScale 用法。
 * 邏輯:反向映射 —— 對每個輸出像素套 H⁻¹ 求來源座標,再以**雙線性內插**取值。
 *   不用最近鄰:最近鄰會在模組邊界造成鋸齒,直接污染 edgeContrasts 與
 *   maxWidthDeviation(規格 §3.3)。落在消失線上(分母為 0)的輸出像素填 0。
 *   縮小輸出時不改動 H,而是把輸出座標乘回取樣格距(sx/sy ≥ 1)再做反向映射,
 *   故四角的對應關係與未縮時一致,只是取樣得比較稀。
 */
export function warpPerspective(gray, w, h, H, outW, outH, maxPixels = MAX_WARP_PIXELS) {
  const sw = Number.isFinite(w) ? Math.floor(w) : 0, sh = Number.isFinite(h) ? Math.floor(h) : 0;
  if (!gray || !(sw > 0) || !(sh > 0) || gray.length < sw * sh) return null;
  if (!Number.isFinite(outW) || !Number.isFinite(outH) || outW < 1 || outH < 1) return null;
  const rw = Math.floor(outW), rh = Math.floor(outH); // 請求尺寸
  const Hi = invert3x3(H);
  if (!Hi) return null;
  const fit = fitRoiToBudget(rw, rh, maxPixels);
  const ow = fit.w, oh = fit.h;
  const sx = rw / ow, sy = rh / oh; // 取樣格距,未縮時為 1
  const out = new Uint8ClampedArray(ow * oh);
  for (let y = 0; y < oh; y++) {
    const yf = y * sy;
    for (let x = 0; x < ow; x++) {
      const xf = x * sx;
      const den = Hi[6] * xf + Hi[7] * yf + Hi[8];
      if (!den) continue; // 消失線上,無對應來源點 → 留 0
      out[y * ow + x] = sampleBilinear(gray, sw, sh, (Hi[0] * xf + Hi[1] * yf + Hi[2]) / den, (Hi[3] * xf + Hi[4] * yf + Hi[5]) / den);
    }
  }
  return { data: out, w: ow, h: oh, scale: ow / rw };
}

/**
 * 由單應矩陣求透視傾角(規格 §3.3 / §5.4),取代 quadGeometry 的臂長差代理值。
 * 輸入:
 * - H:與 warpPerspective 同一個矩陣(來源影像 → 正射輸出)
 * - focalPx:相機焦距(像素);cx / cy:主點(通常是分析影像中心),預設 0
 * 輸出:0–90 的度數,或 **null 代表「不可得」**(H 為 null / 奇異 / 含 NaN,
 *   或 focalPx 不是有限正數)。不 throw。
 * **為什麼不可得時回 null 而不是 0:** gate.ts 的語意是 perspectiveTiltDeg ≤ 5° 否則 FAIL,
 *   0 度是**最寬鬆的放行值**,不是安全值 —— 回 0 等於讓透視閘門永遠綠燈,正是規格
 *   §1.3 在批判的 state.gate.tilt = 0 那個病灶。瀏覽器的 MediaStreamTrack 一般拿不到
 *   像素焦距,若本函式代填 0,接線後會恆走這條路徑,比現行的臂長差代理值更糟。
 *   **退回路徑由呼叫端決定**(例如沿用 quadGeometry 的 tiltDeg 臂長差代理值,並在
 *   結果標註該值為代理),本函式不代填任何放行數字(規格 §3.3 護欄)。
 * 邏輯:H⁻¹ 是「正射平面 → 影像」的投影,其前兩欄即平面兩軸方向的消失點(齊次),
 *   兩者外積得平面的消失線 l;以內參 K = [[f,0,cx],[0,f,cy],[0,0,1]] 還原,
 *   平面法線 n ∝ Kᵀ·l,傾角 = n 與光軸 (0,0,1) 的夾角
 *   = atan2(f·√(l₁²+l₂²), |cx·l₁ + cy·l₂ + l₃|)。
 *   此式只用到消失線,與正射矩形的尺度、長寬比無關(目標矩形換算只差一個軸對齊
 *   仿射,消失線不變),故 targetRectSize 的估計誤差不會傳進角度。
 * **為什麼焦距必須由呼叫端給:** 只有 H 推不出絕對角度 —— 同一條消失線在不同視野角
 *   的相機下對應不同傾角。沒有焦距就誠實回 null 讓呼叫端走退回路徑,不猜一個值。
 */
export function tiltFromHomography(H, focalPx, cx = 0, cy = 0) {
  const G = invert3x3(H); // 正射平面 → 影像
  if (!G) return null;
  if (!Number.isFinite(focalPx) || focalPx <= 0) return null;
  const px = Number.isFinite(cx) ? cx : 0, py = Number.isFinite(cy) ? cy : 0;
  const a = [G[0], G[3], G[6]], b = [G[1], G[4], G[7]]; // 前兩欄:兩軸消失點
  const l = [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const lateral = focalPx * Math.hypot(l[0], l[1]);
  const axial = Math.abs(px * l[0] + py * l[1] + l[2]);
  const deg = (Math.atan2(lateral, axial) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : null; // 算不出有限度數同樣是「不可得」,不代填 0
}

/**
 * 像素焦距的合理範圍,以「分析影像寬度的倍率」表示(規格 §3.3 焦距來源,
 * 2026-08-03 裁示:先試 getSettings().focalLength,不可得則退回代理值)。
 * **這道範圍檢查存在的理由是單位不明。** W3C Image Capture 的 focalLength 欄位
 * 各家實作單位不一致(部分回**毫米**,如 4.5),而本專案要的是**像素焦距**。
 * 直接拿 4.5 去餵 tiltFromHomography 不會出錯 —— 它是有限正數,會算出一個
 * 「看起來像角度」的數字,而那個數字毫無意義。這正是規格 §1.3 / §1.5 一再批判的
 * 病灶:用一個能通過型別檢查的假數字讓量測看起來有在跑。
 * 數字來源:手機主鏡頭水平視角約 60–80°,f = W / (2·tan(FOV/2)) 約 0.6–0.87 W;
 * 望遠鏡頭可到 2–3 W。取 [0.3 W, 5 W] 已涵蓋所有實機鏡頭並留足餘裕,
 * 而毫米值(個位數)在任何分析影像寬度下都遠低於 0.3 W → 必然被擋。
 */
export const FOCAL_PX_LIMITS = Object.freeze({ minRatio: 0.3, maxRatio: 5 });

/**
 * 由 MediaStreamTrack.getSettings() 取像素焦距(規格 §3.3)。純函式,不碰 MediaStream。
 * 輸入:
 * - settings:getSettings() 的回傳,可能為 null / 殘缺;讀 focalLength 與 width
 * - imageWidthPx:**分析影像**的寬度(不是預覽寬度)—— 焦距與影像尺度綁在一起,
 *   換算不到同一尺度的焦距推出來的角度是錯的
 * 輸出:像素焦距(number),或 **null 代表不可得**(呼叫端據此退回代理值)。
 * 邏輯:
 * 1. focalLength 必須是有限正數,否則不可得。
 * 2. settings.width 可得時視為「焦距量在該寬度上」,等比換算到 imageWidthPx
 *    —— 第一層 ImageCapture 的照片寬(如 4032)遠大於串流寬(如 1280),
 *    不換算會低估焦距約 3 倍,傾角直接算成三倍大。
 *    settings.width 不可得時只能假設兩者同尺度,並由下一步的範圍檢查把關。
 * 3. 換算後的值必須落在 FOCAL_PX_LIMITS 的合理帶內,否則視為**單位不是像素**
 *    (或裝置回報離譜)→ 回 null。**寧可退回代理值,不可用一個尺度錯的焦距。**
 */
export function focalPxFromSettings(settings, imageWidthPx) {
  if (!Number.isFinite(imageWidthPx) || imageWidthPx <= 0) return null;
  const s = settings && typeof settings === "object" ? settings : null;
  const raw = s ? s.focalLength : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  const sw = s && typeof s.width === "number" && Number.isFinite(s.width) && s.width > 0 ? s.width : 0;
  const px = sw ? (raw * imageWidthPx) / sw : raw;
  if (!Number.isFinite(px) || px <= 0) return null;
  if (px < FOCAL_PX_LIMITS.minRatio * imageWidthPx) return null; // 多半是毫米值
  if (px > FOCAL_PX_LIMITS.maxRatio * imageWidthPx) return null; // 離譜的回報值
  return px;
}

// 以單應矩陣映射單點(齊次除法)。輸入:H(9 元素 row-major)與點;
// 輸出:映射後的點,或 null(落在消失線上、或算出非有限座標)。
function mapPoint(H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  if (!w) return null;
  const x = (H[0] * p.x + H[1] * p.y + H[2]) / w;
  const y = (H[3] * p.x + H[4] * p.y + H[5]) / w;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * 還原 QR 的邊長模組數 N(dimension)。**算法刻意照抄 ZXing 自己的 computeDimension**
 * —— 它才是決定 alignment pattern 該擺在哪個模組座標的那一份定義,自己另想一套會
 * 在邊界情形跟 ZXing 的解碼結果不一致。
 * 輸入:tl/tr/bl 三個 finder 中心、moduleSizePx 估計模組寬;
 * 輸出:N(21–177 且 ≡1 mod 4),不可得或不合法回 null。
 * 邏輯:兩條中心距各除以模組寬四捨五入(得中心間的模組數),取整數平均再 +7
 *   (兩端各半個 finder 的 3.5 模組);合法 QR 尺寸恆為 4k+17 即 ≡1 mod 4,
 *   故餘 0 進位、餘 2 退位、餘 3 直接視為量錯 —— 這三行是 ZXing 的原樣。
 */
function qrDimensionOf(tl, tr, bl, moduleSizePx) {
  if (!Number.isFinite(moduleSizePx) || moduleSizePx <= 0) return null;
  const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const tltr = Math.round(d(tl, tr) / moduleSizePx);
  const tlbl = Math.round(d(tl, bl) / moduleSizePx);
  let dim = Math.floor((tltr + tlbl) / 2) + 7;
  switch (dim & 0x03) {
    case 0: dim++; break;
    case 2: dim--; break;
    case 3: return null;
    default: break;
  }
  return dim >= 21 && dim <= 177 ? dim : null;
}

/**
 * QR 的四角(規格 §3.3 四角來源表 · §6.5 決策 ③ 2026-08-03 裁示選 (c))。純函式。
 * 輸入:
 * - points:ZXing QR 的 result points,順序為 **[bl, tl, tr] 或 [bl, tl, tr, alignment]**
 * - moduleSizePx:三個 finder pattern 的估計模組寬(px)。ZXing 的前三個 result point
 *   是 FinderPattern,帶 `getEstimatedModuleSize()`;拿不到就傳 null
 * 輸出:{ corners, derived, dimension, source } 或 null(點數不足)。
 *
 * **這裡處理的是一個會讓所有 v≥2 QR 都 FAIL 的陷阱(2026-08-03 實測)。**
 * ZXing 的 QR Detector 找到 alignment pattern 時會回**四個**點,但第四個是
 * **alignment pattern 的中心,不是右下角** —— 它在模組座標 (N−6.5, N−6.5),
 * 而右下角在 (N−3.5, N−3.5),差約 3 個模組。把它直接當角點餵進 solveHomography,
 * 解出來的是一個數值合法、幾何錯誤的矩陣。針孔合成實測(dimension 25、每模組 12px):
 *
 * | 真實傾角 | alignment 當角點推得 | 本函式還原後推得 |
 * |---|---|---|
 * | **0°(完全拍正)** | **53.74°** | 0.00° |
 * | 5° | 52.55° | 5.00° |
 * | 30° | 47.81° | 30.00° |
 *
 * 53.74° ≫ gate.ts 的 ≤5° 門檻 → **每一張 v≥2 的 QR 都會 FAIL**,而 quadConfidence
 * 的四重把關全程 ok=true(它是個正常的凸四邊形,擋不住)。方向雖與補點四角的
 * 「恆綠」相反,同樣是「檢查在跑但量的是錯的東西」。
 *
 * 還原方式:alignment 的模組座標已知,故四個點的模組座標全部已知(下表),
 * 解出「模組平面 → 影像」的單應矩陣後,把符號真正的四角 (0,0)(N,0)(N,N)(0,N)
 * 映回影像即可。dimension N 依 ZXing 自己的 computeDimension 算法還原
 * (兩條中心距 ÷ 模組寬 + 7,再修正到 ≡1 mod 4)。
 *
 * | 點 | 模組座標 |
 * |---|---|
 * | tl finder 中心 | (3.5, 3.5) |
 * | tr finder 中心 | (N−3.5, 3.5) |
 * | bl finder 中心 | (3.5, N−3.5) |
 * | alignment 中心 | (N−6.5, N−6.5) |
 *
 * 註:傾角與「映回哪一個矩形」無關 —— 同一平面上的兩個矩形只差一個仿射,消失線不變。
 * 取符號真四角而非 finder 中心方框,是為了讓矯正輸出涵蓋整個符號(含最外圈模組)。
 *
 * **拿不到 alignment 或拿不到模組寬時退回平行四邊形補點(derived = true)**,
 * 語意與下方 quadFromZxingPoints 的三點路徑相同:v1 QR 本來就沒有 alignment pattern。
 */
export function qrQuadFromPoints(points, moduleSizePx) {
  const three = takeFinitePoints(points, 3);
  if (!three) return null;
  const [bl, tl, tr] = three;
  const parallelogram = () => ({
    corners: [bl, tl, tr, { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y }],
    derived: true, dimension: null, source: "parallelogram",
  });
  const four = takeFinitePoints(points, 4);
  if (!four) return parallelogram();
  const align = four[3];
  const N = qrDimensionOf(tl, tr, bl, moduleSizePx);
  if (!N) return parallelogram();
  // 模組平面 → 影像。四點順序必須與 [bl, tl, tr, align] 對齊
  const H = solveHomography(
    [{ x: 3.5, y: N - 3.5 }, { x: 3.5, y: 3.5 }, { x: N - 3.5, y: 3.5 }, { x: N - 6.5, y: N - 6.5 }],
    [bl, tl, tr, align],
  );
  if (!H) return parallelogram();
  const corners = [{ x: 0, y: 0 }, { x: N, y: 0 }, { x: N, y: N }, { x: 0, y: N }].map((p) => mapPoint(H, p));
  if (corners.some((p) => !p)) return parallelogram();
  return { corners, derived: false, dimension: N, source: "qr-alignment" };
}

/**
 * 由 ZXing result points 補出四角(規格 §3.3「四角來源依符號別分流」)。純函式。
 * 輸入:
 * - points:ZXing 的定位點陣列(座標系由呼叫端決定,本函式只做幾何)
 * - sym:符號別字串。**必須傳** —— 見下方「為什麼要知道符號別」
 * - moduleSizePx:僅 QR 用,見 qrQuadFromPoints
 * 輸出:{ corners, derived, dimension, source } 或 null 代表湊不出四角。
 * - corners:4 個 { x, y }(**未排序**)
 * - derived:**這組四角是不是全都可信的實測角點**。true 代表其中有推算成分或來源不明,
 *   由 rectifyPlan 統一擋掉,不得拿去推傾角
 * - source:"corners"(全實測)/ "qr-alignment"(由 alignment 還原)/
 *   "parallelogram"(三點補點)/ "unknown"(符號別不明,保守不信任)
 * 邏輯:
 * - **QR** → 交給 qrQuadFromPoints。**不可以直接取前四點**:第四點是 alignment
 *   pattern 中心而不是角點,詳見該函式的實測表
 * - **其他符號別且 ≥4 個有限點**(DataMatrix:L 型兩端 + timing 兩端)→ 直接取前 4 個,
 *   derived = false
 * - 恰 3 個 → 第四角以 **tr + bl − tl** 推算,derived = **true**
 * - 少於 3 個(**1D 只有掃描線兩端點**)→ null。1D 的四角要靠 bearer bar /
 *   條端擬合,屬**階段 ⑤**,本函式不猜
 *
 * **derived = true 的四邊形絕不可拿去推傾角(2026-08-03 階段 ④ 實測發現)。**
 * tr + bl − tl 造出來的四邊形依定義是**平行四邊形**,而平行四邊形映到矩形的單應
 * 矩陣是**仿射**的 —— 兩組對邊平行即消失點在無窮遠、消失線亦在無窮遠,
 * tiltFromHomography 由消失線反推,故**不論真實傾角多少一律算出 0.00°**。
 * 本輪針孔合成實測(400×400 方形、f=900、距離 833):
 *
 * | 真實傾角 | 補點與真實第四角的距離 | 三點推得的傾角 |
 * |---|---|---|
 * | 2° | 7.2 px | **0.00°** |
 * | 5° | 18.0 px | **0.00°** |
 * | 25° | 88.2 px | **0.00°** |
 *
 * 繞 X 軸與繞 Y 軸的結果完全相同。0° 是 gate.ts「≤5° 否則 FAIL」最寬鬆的放行值,
 * 這與規格 §1.3 的即時迴圈 tilt = 0、§1.5 的 pxm = 9、tiltFromHomography 初版的
 * 「焦距不可得回 0」是**同一個病灶**:用一個能通過型別檢查的假數字讓檢查看起來
 * 有在跑,而且比現行的臂長差代理值更糟(代理值至少會隨傾斜變大)。
 *
 * **為什麼要知道符號別:** 「四個點」對 DataMatrix 是四個角,對 QR 卻是三個角加一個
 * alignment 中心 —— 同樣的陣列長度、完全不同的幾何意義。少了 sym 就分不出來,
 * 而分錯的代價是 QR 全數 FAIL(見 qrQuadFromPoints 的實測表)。故 **sym 不明時
 * 一律保守標 derived = true**:寧可退回代理值,不可拿一組意義不明的點去解矩陣。
 */
export function quadFromZxingPoints(points, sym, moduleSizePx) {
  if (sym === "QR") return qrQuadFromPoints(points, moduleSizePx);
  const four = takeFinitePoints(points, 4);
  if (four) {
    const known = typeof sym === "string" && sym.length > 0;
    return { corners: four, derived: !known, dimension: null, source: known ? "corners" : "unknown" };
  }
  const three = takeFinitePoints(points, 3);
  if (!three) return null;
  const [bl, tl, tr] = three;
  return {
    corners: [bl, tl, tr, { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y }],
    derived: true, dimension: null, source: "parallelogram",
  };
}

// 把 quadConfidence 的實測值翻成「是哪一項不過」的中文原因(規格 §3.3:
// 退回時要講得出原因,不能只回一個 null 讓呼叫端無話可說)。
function confidenceReason(conf) {
  const L = QUAD_CONFIDENCE_LIMITS;
  const bad = [];
  if (conf.minEdgePx < L.minEdgePx) bad.push(`最短邊 ${conf.minEdgePx.toFixed(1)}px < ${L.minEdgePx}`);
  if (conf.fillRatio < L.minFillRatio) bad.push(`填充率 ${conf.fillRatio.toFixed(2)} < ${L.minFillRatio}`);
  if (conf.aspectRatio > L.maxAspectRatio) bad.push(`長寬比 ${Number.isFinite(conf.aspectRatio) ? conf.aspectRatio.toFixed(1) : "∞"} > ${L.maxAspectRatio}`);
  if (conf.minAngleDeg < L.minAngleDeg) bad.push(`最小內角 ${conf.minAngleDeg.toFixed(1)}° < ${L.minAngleDeg}`);
  return "擬合信心不足（" + (bad.join("、") || "未指明") + "）";
}

/**
 * 四角 → 正射 ROI 的完整管線(規格 §3.3,**階段 ④ 接線用的單一入口**)。純函式。
 * 輸入:gray/w/h 來源灰階與尺寸、points 定位點(**須與 gray 同一座標系**)、
 *   opts = { sym, moduleSizePx, maxPixels }。**sym 必須傳** —— 「四個點」對
 *   DataMatrix 是四個角、對 QR 卻是三個角加一個 alignment 中心,分錯的代價見
 *   qrQuadFromPoints 的實測表;不傳則保守走不信任路徑。
 * 輸出恆為物件、**永不 throw、永不代填數字**:
 * - 成功:{ ok:true, gray, w, h, scale, H, corners, conf, requested, reason:"" }
 *   —— w/h 是實際輸出尺寸(超預算已等比縮),scale 為實際/請求寬比,
 *      H 是「來源 → 正射」矩陣,可直接餵 tiltFromHomography。
 * - 退回:{ ok:false, reason, corners, conf, H },reason 講明是哪一關不過。
 * 邏輯即把既有五支純函式串起來:quadFromZxingPoints → orderCornersRaw →
 *   quadConfidence → targetRectSize → solveHomography → warpPerspective。
 * **為什麼要有這一支:** 這條鏈的每一環都可能回 null,而每個 null 的意思都不同。
 *   把串接寫在 demo/*.html 裡等於把「退回哪一條路徑」這個判斷放進**沒有自動化測試
 *   可覆蓋**的檔案(專案 CLAUDE.md 已載明這條界線),退回邏輯就再也驗不了。
 *   放在這裡則整條鏈連同退回原因都在 tests/imgproc.test.ts 的覆蓋範圍內。
 */
export function rectifyQuad(gray, w, h, points, opts = {}) {
  const { sym = null, moduleSizePx = null, maxPixels = MAX_WARP_PIXELS } = opts || {};
  const fail = (reason, corners, conf, H, derived, q) => ({
    ok: false, reason, corners: corners || null, conf: conf || null, H: H || null,
    derivedCorner: !!derived, quadSource: (q && q.source) || null, dimension: (q && q.dimension) || null,
  });
  const quad = quadFromZxingPoints(points, sym, moduleSizePx);
  if (!quad) return fail("四角不足（1D 掃描線僅兩端點,四角偵測屬階段 ⑤）");
  const derived = quad.derived;
  const corners = orderCornersRaw(quad.corners);
  if (!corners) return fail("四角排序失敗（座標非有限）", null, null, null, derived, quad);
  const conf = quadConfidence(corners);
  if (!conf) return fail("四角信心無法計算", corners, null, null, derived, quad);
  if (!conf.ok) return fail(confidenceReason(conf), corners, conf, null, derived, quad);
  const size = targetRectSize(corners);
  if (!size) return fail("正射尺寸無法估計", corners, conf, null, derived, quad);
  const dst = [
    { x: 0, y: 0 },
    { x: size.w, y: 0 },
    { x: size.w, y: size.h },
    { x: 0, y: size.h },
  ];
  const H = solveHomography(corners, dst);
  if (!H) return fail("單應矩陣奇異", corners, conf, null, derived, quad);
  const out = warpPerspective(gray, w, h, H, size.w, size.h, maxPixels);
  if (!out) return fail("正射重採樣失敗", corners, conf, H, derived, quad);
  return { ok: true, reason: "", corners, conf, H, derivedCorner: derived,
    quadSource: quad.source, dimension: quad.dimension,
    gray: out.data, w: out.w, h: out.h, scale: out.scale, requested: size };
}

/**
 * 由 rectifyQuad 的結果決定「量測吃哪張影像、傾角走哪條路徑」(階段 ④ 的接線判斷)。
 * 純函式,輸入 rectifyQuad 的輸出(可為 null);輸出
 * { useRectified, useHomography, note }。
 * **為什麼這個判斷要獨立成純函式:** 它只有兩個布林值,寫進 demo/*.html 只是兩行 if,
 * 但那兩行決定的是「量測吃不吃得到正射影像」與「透視閘門收到的是真值還是恆 0 的假值」
 * —— 專案 CLAUDE.md 已載明 demo/*.html 無自動化測試可覆蓋,放在那裡等於這兩個判斷
 * 永遠驗不了。放這裡則連同下方三條規則都在 tests/imgproc.test.ts 的覆蓋範圍內。
 * 三條規則:
 * 1. 矯正失敗(含 1D 四角不足)→ 兩者皆 false,note 為 rectifyQuad 給的原因。
 * 2. **四角含補點(QR 三定位點)→ 兩者皆 false。** 補點四邊形是平行四邊形,其單應
 *    矩陣為仿射:傾角必為 0.00°(恆綠,見 quadFromZxingPoints 的實測表),而矯正
 *    本身也只還原得了旋轉與剪切、還原不了透視 —— 對 2D 的光度/FPD 量測是白付一次
 *    雙線性內插的模糊代價,故一併不採用。傾角改走臂長差代理值(2026-08-03 裁示)。
 * 3. 四角皆為實測(DataMatrix 四點,或階段 ⑤ 之後的 1D)→ 兩者皆 true。
 */
export function rectifyPlan(rect) {
  if (!rect || !rect.ok) return { useRectified: false, useHomography: false, note: (rect && rect.reason) || "未矯正" };
  if (rect.derivedCorner) {
    const why = rect.quadSource === "unknown"
      ? "四角來源不明（未指定符號別）"
      : "四角含推算點,平行四邊形不帶透視資訊";
    return { useRectified: false, useHomography: false, note: `未矯正（${why}）` };
  }
  const how = rect.quadSource === "qr-alignment"
    ? `,QR 四角由 alignment pattern 還原（N=${rect.dimension}）` : "";
  return { useRectified: true, useHomography: true,
    note: `已矯正 ${rect.w}×${rect.h}` + (rect.scale < 1 ? `（密度 ${(rect.scale * 100).toFixed(0)}%）` : "") + how };
}

/** 透視傾角的來源標籤(結果頁與掃描紀錄照這三個字串顯示,不另外造詞)。 */
export const TILT_SOURCE_LABEL = Object.freeze({
  homography: "單應矩陣實算",
  proxy: "臂長差代理值",
  none: "未量測",
});

/**
 * 決定要送進閘門的透視傾角與其來源(規格 §3.3 焦距來源 · 2026-08-03 裁示)。純函式。
 * 輸入:H(來源→正射,可為 null)、focalPx(像素焦距,**須與 H 同一座標尺度**)、
 *   cx/cy 主點(同上尺度)、proxyDeg 呼叫端可用的代理傾角(quadGeometry 的臂長差,
 *   沒有就傳 null)。
 * 輸出:{ deg, source } —— source 為 "homography" / "proxy" / "none";
 *   source 為 "none" 時 deg 為 **null**,呼叫端不得把它當 0 度餵進閘門。
 * **裁示內容(2026-08-03):** 先試單應矩陣實算(需焦距);焦距不可得就退回臂長差
 *   代理值,並在結果頁標註該值為代理。**兩者都拿不到時回 null,不代填 0** ——
 *   gate.ts 的 classifyPerspective 對「不可得」判 FAIL 是刻意的(0° 是 ≤5° 最寬鬆的
 *   放行值),本函式不繞過那道守衛。
 */
export function resolveTiltDeg(H, focalPx, cx, cy, proxyDeg) {
  const real = tiltFromHomography(H, focalPx, cx, cy);
  if (real !== null) return { deg: real, source: "homography" };
  if (typeof proxyDeg === "number" && Number.isFinite(proxyDeg) && proxyDeg >= 0) return { deg: proxyDeg, source: "proxy" };
  return { deg: null, source: "none" };
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
