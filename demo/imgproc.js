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
 *   而規格 §3.3 說「一維是最硬的一段」,quadFrom1DEdges 的條端四角正靠這道把關。
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
 *   條端擬合,那是 quadFrom1DEdges 的事(它要吃像素,本函式只做幾何、不碰影像)
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

// ── 1D 四角偵測(規格 §3.3「1D 四角偵測」節 · 階段 ⑤)────────────────────
// 由掃描線兩端點出發,**四條邊各自獨立擬合**,交點得四角。
//
// **C1:絕不可把下邊取成上邊的平行線,也不可用單一「條高帶」推對邊。**
// 兩組對邊平行 ⇒ 四邊形是平行四邊形 ⇒ 映到矩形的單應矩陣是**仿射** ⇒ 消失線在無窮遠
// ⇒ tiltFromHomography 不論真實傾角一律回 0.00°,而 0° 正是 gate.ts「≤5° 否則 FAIL」
// **最寬鬆的放行值**。2026-08-03 已在 QR 補點四角上犯過一次(見 quadFromZxingPoints
// 的實測表),不可再犯。這條禁的是**強制**平行,不是禁止結果剛好平行 —— 真的拍正時
// 四條線本來就近乎平行、傾角本來就是 0°,那是正確答案,不得因此判失敗。

/**
 * 走 1D 條端擬合的符號別(規格 §3.1)。**權威定義是 src/domain/types.ts 的 Symbology**,
 * 符號別是跨層契約,散成兩份遲早對不起來(2026-08-03 的 QR 就是「四個點對 DataMatrix
 * 是四個角、對 QR 是三角加一個 alignment 中心」分不出來才踩坑)。
 * 本檔是瀏覽器直載的純 JS、不能 import TS 型別,下面這行字面值是**技術上不得不有的副本**;
 * 同源改由機制強制:tests/imgproc.test.ts 直接讀 types.ts 解析 Symbology 聯集,要求
 * 「1D 清單 ∪ 2D 清單 = Symbology」,日後在 types.ts 增列符號別卻沒同步這裡就會當場變紅
 * (不加這道守門的話,rectifyQuad 的 includes() 會靜默退回「四角不足」,理由看起來還很正常)。
 * QR / DATAMATRIX 不在內:它們的 result points 本來就 ≥3 個,走 quadFromZxingPoints 那條路。
 */
export const ONE_D_SYMBOLOGIES = Object.freeze(["ITF14", "GS1_128", "CODE128"]);

/**
 * 1D 直線擬合與四角求交的門檻(**權威表在規格 §3.3「1D 四角偵測」節,改這裡就要改那裡**)。
 * 比照 QUAD_CONFIDENCE_LIMITS 凍結匯出,
 * 測試直接引用本表而非重寫字面值;另有一條守門測試**直接讀 docs/spec20260731-1.md §3.3
 * 的權威表**逐項比對(不是在測試檔裡再抄一份字面值 —— 那只擋得住改程式不改測試,
 * 一次改兩邊規格就靜默過期),值、欄位集合與順序任一邊單獨改動都會當場變紅。
 * 每個數字的理由:
 * - **samples = 48**:沿定位線的取樣位置數。1D 符號的暗/亮元素各占約一半,落在空白的
 *   位置一律作廢(不補值),故有效位置只剩約一半;再扣掉離群,48 才穩定給得出
 *   ≥ minInliers 的內點。規格草稿建議的 24 實測只剩約 13 個有效位置,離 8 太近。
 * - **crossSamples = 21**:求左右邊時,條高帶內的平行掃描線數。ITF-14 的條與 bearer bar
 *   之間有空白間隙,落在間隙的掃描線整條都是亮的、一律作廢,實測 21 條會廢掉約 2 條;
 *   規格草稿建議的 9 條在同一情境只剩 7 條 < minInliers,永遠過不了。
 * - **minInliers = 8**:兩點就定得出一條線,但兩點的線沒有殘差可算,信心無從判斷。
 *   8 個點在 maxRmsPx 下才有統計意義,也與 QUAD_CONFIDENCE_LIMITS.minEdgePx = 8 同源
 *   (一條邊短於 8px 連一個模組都放不下)。
 * - **minInlierRatio = 0.6**:每條線的最低內點比例。分母是**實際餵進 fitLineTLS 的點數**
 *   (已作廢的取樣位置不算在內)—— 作廢過多由 minInliers 這一關擋,本項專擋「點都取到了
 *   但散成一片」,兩關語意不重疊。
 * - **maxRmsPx = 1.5**:子像素內插後,合成無雜訊情形殘差應 ≪ 1px;1.5px 是給實拍的模糊
 *   與印刷毛邊留的餘裕,再大就不是一條直線了。
 * - **madK = 2.5**:離群剔除的 MAD 倍數(1.4826 × median|r| 為尺度,即常態下的 σ)。
 * - **minBarHeightPx = 12**:上下兩線在定位線中點的間距。GS1-128 最低條高 13mm,取樣密度
 *   ≥8px/module 時遠高於 12px;低於 12px 的條高帶擠不下 crossSamples 條掃描線。
 * - **minCornerAngleDeg = 20**:相鄰兩線的最小夾角,與 QUAD_CONFIDENCE_LIMITS.minAngleDeg
 *   同值同源 —— DLT 在近共線組態下對 1px 誤差極度敏感。**只判相鄰線對**:上下兩線近乎
 *   平行是拍正時的正常結果,不得因此判失敗。
 * - **minLocatorLenPx = 24**:定位線最短長度。短於此的兩點連方向都不可信。
 * - **searchHalfSpanRatio = 0.6**:沿 ±n 找條端的搜尋半徑,以定位線長度的倍率表示
 *   (規格草稿寫的是絕對值 searchHalfSpanPx,但條高與符號寬是綁在一起的:ITF-14 約
 *   4.5:1、GS1-128 最細長約 12.7:1,絕對像素值會隨拍攝距離失效)。0.6 對應「條高可達
 *   符號寬的 1.2 倍」,連近正方形標籤都涵蓋得到(規格 §6 的 edge case)。
 * - **trackHalfSpanRatio = 0.08**:沿 ±n 走的時候,每一步重新對準所在暗 run 中心的側向
 *   搜尋半徑。**為什麼要對準:** 繞畫面水平軸傾斜時,條在影像中是**會聚**的、並不平行於
 *   n,直直往上走會走出條外,在 GS1-128(沒有 bearer bar 兜底)上會把條端記錯位置。
 *   0.08 倍符號寬容得下任何單一元素(最寬的元素也才幾個模組,約符號寬的 1/17),
 *   又遠小於整條 bearer bar 的寬度 —— 對準得到單根條,對不準整條 bearer bar
 *   (兩側都搜不到亮 ⇒ 維持原側向偏移),兩種情形都是要的行為。
 * - **crossOverscanRatio = 0.15**:求左右邊時,掃描線往定位線兩端各外延的倍率。
 *   ZXing 的兩個定位點落在最外側暗元素的**中心**附近,不是符號的左右緣;透視傾斜下
 *   上下兩端的左右緣還會再外移。不外延就會把左右緣切在掃描邊界上(那種樣本一律作廢)。
 * - **minBandContrast = 24**:定位線周邊帶內「亮類平均 − 暗類平均」的最小值(0–255)。
 *   Otsu 在單峰直方圖上照樣回得出一個閾值,分出來的兩類卻毫無意義 —— 全白/全黑由
 *   「某一類是空的」擋下,極低對比則靠本項。24/255 ≈ 0.094,與 roiPhotometric 的
 *   edgeContrasts 同一個尺度。
 */
export const LINE_FIT_LIMITS = Object.freeze({
  samples: 48,
  crossSamples: 21,
  minInliers: 8,
  minInlierRatio: 0.6,
  maxRmsPx: 1.5,
  madK: 2.5,
  minBarHeightPx: 12,
  minCornerAngleDeg: 20,
  minLocatorLenPx: 24,
  searchHalfSpanRatio: 0.6,
  trackHalfSpanRatio: 0.08,
  crossOverscanRatio: 0.15,
  minBandContrast: 24,
});

// 相鄰兩個取樣值跨越閾值 t 的次像素比例(0–1);兩值相同時回 0.5(無從內插,取中點)。
// **整數像素量化在 ±1° 的判準下會直接吃掉誤差預算**,故所有邊界點一律做這一步。
function crossFraction(v0, v1, t) {
  const d = v1 - v0;
  if (!d) return 0.5;
  const s = (t - v0) / d;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}

// 已排序陣列的中位數(偶數個取中間兩個的平均)
function medianOfSorted(sorted) {
  const n = sorted.length, m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

// 總體最小平方(TLS)直線擬合的核心:輸入點陣列,輸出 { nx, ny, c } 法式直線,
// 全部點重合(二階中心矩為 0)時回 null。
// 以二階中心矩矩陣 [[Sxx,Sxy],[Sxy,Syy]] 的**最小特徵向量**取法向 —— 這才是
// 「垂直距離平方和最小」的解;y = ax + b 的最小平方在條垂直(符號旋轉 90°)時斜率發散。
function tlsOf(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const trace = sxx + syy;
  if (!(trace > 0)) return null; // 全部點重合:沒有任何方向可言
  const lmin = (trace - Math.hypot(sxx - syy, 2 * sxy)) / 2;
  // 特徵向量兩種等價寫法,取模長較大的那一組(另一組在退化方向上會整個歸零)
  let nx = sxy, ny = lmin - sxx;
  if (Math.hypot(nx, ny) < Math.hypot(lmin - syy, sxy)) { nx = lmin - syy; ny = sxy; }
  const len = Math.hypot(nx, ny);
  if (!(len > 0)) return null;
  nx /= len; ny /= len;
  return { nx, ny, c: -(nx * mx + ny * my) };
}

/**
 * 總體最小平方直線擬合 + MAD 離群剔除(規格 §3.2)。純函式、**無亂數**。
 * 輸入:
 * - pts:`[{x, y}, ...]`,座標非有限的點直接略過
 * - opts = { madK }:離群剔除的 MAD 倍數,預設取自 LINE_FIT_LIMITS
 * 輸出:`{ nx, ny, c, rmsPx, inliers, samples }` —— 直線以**法式** nx·x + ny·y + c = 0
 *   表示(nx² + ny² = 1),rmsPx 為**內點**殘差的 RMS,inliers / samples 為內點數 /
 *   餵進來的有限點數;點數不足(< 2)或退化(全部點重合)回 **null**。
 * 邏輯:第一輪用全部點做 TLS → 算殘差 → 以 MAD(1.4826 × median|r|,常態下即 σ)為尺度
 *   剔除 |r| > madK × scale 的離群點 → 用內點重擬合一次。
 * **尺度下限 0.1px 的用意:** 一組近乎完美的點,MAD 會小到 0.01px 等級,
 *   `|r| > madK × 0.01` 就把散度只有次像素內插誤差的**完美內點**剔成離群,內點比例
 *   莫名其妙掉下去。子像素邊界內插的解析度約 0.1px,比它更小的散度是量化不是離群,
 *   故尺度不低於 0.1px。這個下限只影響「本來就很準」的情形,擋不到真正的離群點
 *   (真離群的殘差是好幾個 px,遠大於 madK × 0.1)。
 */
export function fitLineTLS(pts, opts = {}) {
  const madK = typeof (opts && opts.madK) === "number" && Number.isFinite(opts.madK) && opts.madK > 0
    ? opts.madK : LINE_FIT_LIMITS.madK;
  const src = [];
  if (pts && typeof pts.length === "number") {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) src.push({ x: p.x, y: p.y });
    }
  }
  const samples = src.length;
  if (samples < 2) return null;
  const first = tlsOf(src);
  if (!first) return null;
  const res = src.map((p) => Math.abs(first.nx * p.x + first.ny * p.y + first.c));
  const scale = Math.max(1.4826 * medianOfSorted(res.slice().sort((a, b) => a - b)), 0.1);
  const cut = madK * scale;
  const keep = src.filter((p, i) => res[i] <= cut);
  if (keep.length < 2) return null;
  const line = tlsOf(keep);
  if (!line) return null;
  let sum2 = 0;
  for (const p of keep) {
    const r = line.nx * p.x + line.ny * p.y + line.c;
    sum2 += r * r;
  }
  return { nx: line.nx, ny: line.ny, c: line.c, rmsPx: Math.sqrt(sum2 / keep.length), inliers: keep.length, samples };
}

// 兩條法式直線求交。輸入兩個 fitLineTLS 形狀的物件;
// 輸出 { p, angleDeg } —— 交點與**兩線夾角**(0–90°),平行或算不出有限交點時回 null。
// 兩個單位法向的行列式恰是夾角的正弦,故 angleDeg = asin(|det|)。
function intersectLines(l1, l2) {
  if (!l1 || !l2) return null;
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  const angleDeg = (Math.asin(Math.min(1, Math.abs(det))) * 180) / Math.PI;
  if (!det) return null;
  const x = (l1.ny * l2.c - l2.ny * l1.c) / det;
  const y = (l2.nx * l1.c - l1.nx * l2.c) / det;
  return Number.isFinite(x) && Number.isFinite(y) ? { p: { x, y }, angleDeg } : null;
}

/**
 * 1D 四角偵測(規格 §3.3「1D 四角偵測」節,該節為權威定義)。純函式,**恆回物件、永不 throw、永不代填數字**。
 * 輸入:
 * - gray / w / h:來源灰階與尺寸,**與 points 同一座標系**(即 rectifyQuad 收到的那組)
 * - points:ZXing 的 result points,**只用前兩個有限點**(1D 掃描線兩端)
 * - opts = { sym, samples, crossSamples },皆可省略(預設取自 LINE_FIT_LIMITS)
 * 輸出:
 * - 成功:`{ ok:true, corners, source:"1d-edges", fit, metrics, reason:"" }`
 *   - corners:4 個 { x, y },**未排序**(交給既有 orderCornersRaw)
 *   - fit:`{ top, bottom, left, right }`,各為 fitLineTLS 的輸出 —— **四條線各自可讀**,
 *     護欄測試要靠它證明上下邊不是同一條的平移
 *   - metrics:`{ samples, minInliers, minInlierRatio, maxRmsPx, minCornerAngleDeg, barHeightPx }`
 *     全是**實測值**(同名門檻在 LINE_FIT_LIMITS,兩者不要混看)。其中 **samples 的語意是
 *     「上下端點取樣時成功產出端點對的位置數」**(即演算法 3. 沒有作廢的 q_i 個數,上下
 *     兩群等長),**不含**左右兩條線的掃描線數,也不是 LINE_FIT_LIMITS.samples;
 *     minInliers / minInlierRatio / maxRmsPx 取四條線中最差的那條,算不到的維持 null
 * - 失敗:`{ ok:false, corners:null, reason:"1D 邊界擬合失敗（…）", fit, metrics }`,
 *   reason 逐項指名**是哪一項不過 + 實測值 + 門檻**(比照 confidenceReason 的寫法)
 *
 * 演算法:
 * 1. **定位線與法向。** 取前兩個有限點 p0、p1,u = normalize(p1 − p0)、n = (−u.y, u.x)。
 *    |p1 − p0| < minLocatorLenPx 判端點退化,退回。
 * 2. **閾值。** 以定位線周邊帶(沿 n 各取 searchHalfSpanRatio × 定位線長、沿 u 全長)的子影像算 otsu,
 *    **不用整張 gray** —— ROI 外的背景會把閾值拉偏。帶內只有一類、或兩類平均差
 *    < minBandContrast 時判對比不足,退回。
 * 3. **上下端點取樣。** 沿定位線取 samples 個位置 q_i = p0 + u·L·(i+0.5)/samples。
 *    q_i 本身不是暗 ⇒ 落在空白/靜區 ⇒ **作廢**(不補值);否則沿 ±n 逐像素走,
 *    走到**最後一次**「暗 → 亮」的跨越點即該側的條端,跨越點**線性內插到子像素**。
 *    走的時候每一步都重新對準所在暗 run 的側向中心(見 trackHalfSpanRatio):條在影像中
 *    是會聚的,直直走會走出條外。走出畫面或走滿搜尋半徑仍未跨越 ⇒ 該位置作廢,
 *    **不得用畫面邊界當條端**。
 * 4. **上下兩條線分別擬合**(C1:兩次獨立呼叫、兩組獨立資料,絕不取平行線)。
 * 5. **左右兩條線分別擬合。** 取 crossSamples 條掃描線,**每條都沿上下兩線做線性內插**
 *    ——第 k 條的每一點都是「該處上邊界與下邊界之間走固定比例 f」的位置(f 取
 *    (k+1)/(crossSamples+1)),而**不是**平行於定位線的直線:透視下上下兩線是會聚的,
 *    平行線會在一端跑出條高帶外(實測見下方 railAt 上方的註解)。各條線 scanlineRuns:
 *    第一個暗 run 的起點得左邊界點、最後一個暗 run 的終點得右邊界點(同樣做子像素內插)。
 *    掃描線兩端各外延 crossOverscanRatio 倍定位線長,以涵蓋定位點外側的真正左右緣;
 *    整條都亮、或暗 run 貼到掃描邊界(代表被切掉)的那條作廢。
 * 6. **求交點。** corners = [上×左, 上×右, 下×右, 下×左](順序無所謂,orderCornersRaw 會重排)。
 *    **只檢查相鄰線對** —— 上下兩線近乎平行是拍正時的正常結果,不得因此判失敗(C1 註)。
 * 7. 通過後把 corners 交還 rectifyQuad,由既有鏈(orderCornersRaw → quadConfidence →
 *    targetRectSize → solveHomography → warpPerspective)**再把一次關**,不繞過、不放寬。
 */
export function quadFrom1DEdges(gray, w, h, points, opts = {}) {
  const L = LINE_FIT_LIMITS;
  const o = opts || {};
  const posInt = (v, dflt) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : dflt);
  const sampleN = posInt(o.samples, L.samples);
  const crossN = posInt(o.crossSamples, L.crossSamples);
  const fit = { top: null, bottom: null, left: null, right: null };
  const metrics = {
    samples: 0, minInliers: null, minInlierRatio: null,
    maxRmsPx: null, minCornerAngleDeg: null, barHeightPx: null,
  };
  const fail = (reason) => ({ ok: false, corners: null, reason: `1D 邊界擬合失敗（${reason}）`, fit, metrics });

  const sw = Number.isFinite(w) ? Math.floor(w) : 0, sh = Number.isFinite(h) ? Math.floor(h) : 0;
  if (!gray || !(sw > 0) || !(sh > 0) || gray.length < sw * sh) return fail("來源影像不合法");
  const inside = (x, y) => x >= 0 && y >= 0 && x <= sw - 1 && y <= sh - 1;

  // 1. 定位線與法向
  const two = takeFinitePoints(points, 2);
  if (!two) return fail("定位點不足（需要 2 個座標有限的點,1D 掃描線兩端）");
  const [p0, p1] = two;
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (!(len >= L.minLocatorLenPx)) {
    return fail(`定位線過短（${len.toFixed(1)}px < ${L.minLocatorLenPx}px,兩定位點重合或過近）`);
  }
  const u = { x: (p1.x - p0.x) / len, y: (p1.y - p0.y) / len };
  const n = { x: -u.y, y: u.x };
  const span = Math.max(1, Math.round(L.searchHalfSpanRatio * len));
  const track = Math.max(1, Math.round(L.trackHalfSpanRatio * len));

  // 2. 帶內 Otsu(取樣格上限 256×96,避免大圖時掃出百萬點;格距固定,無亂數)
  const stepU = Math.max(1, Math.round(len / 256)), stepN = Math.max(1, Math.round((2 * span + 1) / 96));
  const band = [];
  for (let s = -span; s <= span; s += stepN) {
    for (let a = 0; a <= len; a += stepU) {
      const x = p0.x + u.x * a + n.x * s, y = p0.y + u.y * a + n.y * s;
      if (inside(x, y)) band.push(sampleBilinear(gray, sw, sh, x, y));
    }
  }
  if (band.length < 4) return fail("定位線周邊帶取不到樣本（定位點落在影像外）");
  const t = otsu(Uint8ClampedArray.from(band));
  let dSum = 0, dN = 0, lSum = 0, lN = 0;
  for (const v of band) { if (v < t) { dSum += v; dN++; } else { lSum += v; lN++; } }
  if (!dN || !lN) return fail(`對比不足,Otsu 分不出兩類（帶內只有${dN ? "暗" : "亮"}的一類）`);
  const contrast = lSum / lN - dSum / dN;
  if (contrast < L.minBandContrast) {
    return fail(`對比不足,Otsu 分不出兩類（暗亮兩類平均差 ${contrast.toFixed(1)} < ${L.minBandContrast}）`);
  }

  // 由 (bx,by) 沿 ±u 找出所在暗 run 的兩側邊界,回傳重新對準後的側向偏移;
  // 兩側在 track 內都找不到亮(例如寬達整個符號的 bearer bar)或走出畫面 → 回 null(維持原偏移)
  const recenter = (bx, by, lat) => {
    const edge = (dir) => {
      let prev = sampleBilinear(gray, sw, sh, bx, by);
      for (let k = 1; k <= track; k++) {
        const x = bx + u.x * dir * k, y = by + u.y * dir * k;
        if (!inside(x, y)) return null;
        const v = sampleBilinear(gray, sw, sh, x, y);
        if (v >= t) return dir * (k - 1 + crossFraction(prev, v, t));
        prev = v;
      }
      return null;
    };
    const a = edge(1), b = edge(-1);
    return a === null || b === null ? null : lat + (a + b) / 2;
  };

  // 從 q 沿 dir·n 追蹤同一根條到條端。回傳 { d, lat }(沿 n 的距離與側向偏移)或 null。
  const traceEnd = (q, dir) => {
    let lat = 0, prev = sampleBilinear(gray, sw, sh, q.x, q.y), last = null;
    for (let s = 1; s <= span; s++) {
      let bx = q.x + n.x * dir * s + u.x * lat, by = q.y + n.y * dir * s + u.y * lat;
      if (!inside(bx, by)) break; // 走出畫面:不得用畫面邊界當條端
      let v = sampleBilinear(gray, sw, sh, bx, by);
      if (v < t) {
        const c = recenter(bx, by, lat);
        if (c !== null && c !== lat) {
          lat = c;
          bx = q.x + n.x * dir * s + u.x * lat; by = q.y + n.y * dir * s + u.y * lat;
          v = inside(bx, by) ? sampleBilinear(gray, sw, sh, bx, by) : v;
        }
      }
      if (prev < t && v >= t) last = { d: s - 1 + crossFraction(prev, v, t), lat };
      prev = v;
    }
    return last;
  };

  // 3. 上下端點取樣
  const topPts = [], botPts = [];
  for (let i = 0; i < sampleN; i++) {
    const a = (len * (i + 0.5)) / sampleN;
    const q = { x: p0.x + u.x * a, y: p0.y + u.y * a };
    if (!inside(q.x, q.y)) continue;
    if (sampleBilinear(gray, sw, sh, q.x, q.y) >= t) continue; // 落在空白/靜區 → 作廢,不補值
    const up = traceEnd(q, -1), dn = traceEnd(q, 1);
    if (!up || !dn) continue;
    topPts.push({ x: q.x + u.x * up.lat - n.x * up.d, y: q.y + u.y * up.lat - n.y * up.d });
    botPts.push({ x: q.x + u.x * dn.lat + n.x * dn.d, y: q.y + u.y * dn.lat + n.y * dn.d });
  }
  metrics.samples = topPts.length;

  // 4. 上下兩條線**各自獨立**擬合(C1)
  fit.top = fitLineTLS(topPts, { madK: L.madK });
  fit.bottom = fitLineTLS(botPts, { madK: L.madK });
  // 逐條線判信心,回傳「是哪一項不過」的中文原因(含實測值 + 門檻),過關回 null。
  // raw 是餵進去之前的有效取樣點數 —— 擬合不出直線時 f 為 null,只報得出這個數字。
  const lineBad = (key, name, raw) => {
    const f = fit[key];
    if (!f) return `${name}取樣點不足（有效邊界點 ${raw} 個 < ${L.minInliers},擬合不出直線）`;
    if (f.inliers < L.minInliers) return `${name}內點數 ${f.inliers} < ${L.minInliers}`;
    if (f.inliers / f.samples < L.minInlierRatio) {
      return `${name}內點比例 ${(f.inliers / f.samples).toFixed(2)} < ${L.minInlierRatio}`;
    }
    if (f.rmsPx > L.maxRmsPx) return `${name}殘差 RMS ${f.rmsPx.toFixed(2)}px > ${L.maxRmsPx}px`;
    return null;
  };
  const updateStats = () => {
    const fs = ["top", "bottom", "left", "right"].map((k) => fit[k]).filter(Boolean);
    if (!fs.length) return;
    metrics.minInliers = Math.min(...fs.map((f) => f.inliers));
    metrics.minInlierRatio = Math.min(...fs.map((f) => f.inliers / f.samples));
    metrics.maxRmsPx = Math.max(...fs.map((f) => f.rmsPx));
  };
  updateStats();
  const tbBad = [lineBad("top", "上邊", topPts.length), lineBad("bottom", "下邊", botPts.length)].filter(Boolean);
  if (tbBad.length) return fail(tbBad.join("、"));

  // 由定位線上的一點沿 n 射到某條線的位移;n 與該線平行(分母為 0)時回 null
  const offsetAt = (f, base) => {
    const den = f.nx * n.x + f.ny * n.y;
    return den ? -(f.nx * base.x + f.ny * base.y + f.c) / den : null;
  };
  // 條高:上下兩線在定位線中點沿 n 的位置差
  const mid = { x: p0.x + (u.x * len) / 2, y: p0.y + (u.y * len) / 2 };
  const sTop = offsetAt(fit.top, mid), sBot = offsetAt(fit.bottom, mid);
  if (sTop === null || sBot === null || !Number.isFinite(sTop) || !Number.isFinite(sBot)) {
    return fail("上下邊界線與定位線法向平行,量不到條高");
  }
  metrics.barHeightPx = Math.abs(sBot - sTop);
  if (metrics.barHeightPx < L.minBarHeightPx) {
    return fail(`條高 ${metrics.barHeightPx.toFixed(1)}px < ${L.minBarHeightPx}px`);
  }

  // 5. 左右兩條線**各自獨立**擬合。
  // **掃描線不能真的「平行於定位線」**:透視下上下兩線是會聚的,一條水平掃描線會在
  // 一端落在條高帶內、另一端已經跑到帶外,量到的「第一個暗 run 起點」就變成上邊界與
  // 掃描線的交點而不是符號左緣(2026-08-04 實測:繞 Y 軸 25° 時左邊殘差 RMS 4.5px)。
  // 改為沿上下兩線做**線性內插**取掃描線:第 k 條線的兩個端點各自是「該處上下兩線之間
  // 走 f 比例」的點,整條線因此恆落在帶內。f 取 (k+1)/(crossSamples+1),兩端自然內縮。
  const over = L.crossOverscanRatio * len;
  const railAt = (a, f) => {
    const base = { x: p0.x + u.x * a, y: p0.y + u.y * a };
    const st = offsetAt(fit.top, base), sb = offsetAt(fit.bottom, base);
    if (st === null || sb === null || !Number.isFinite(st) || !Number.isFinite(sb)) return null;
    const s = st + (sb - st) * f;
    return { x: base.x + n.x * s, y: base.y + n.y * s };
  };
  const maxRow = Math.max(2, Math.ceil(len + 2 * over) + 2);
  const row = new Uint8ClampedArray(maxRow);
  const leftPts = [], rightPts = [];
  for (let k = 0; k < crossN; k++) {
    const f = (k + 1) / (crossN + 1);
    const A = railAt(-over, f), B = railAt(len + over, f);
    if (!A || !B) continue;
    const dx = B.x - A.x, dy = B.y - A.y;
    const count = Math.min(maxRow, Math.max(2, Math.round(Math.hypot(dx, dy)) + 1));
    let outside = false;
    for (let j = 0; j < count; j++) {
      const r = j / (count - 1);
      const x = A.x + dx * r, y = A.y + dy * r;
      if (!inside(x, y)) { outside = true; break; }
      row[j] = sampleBilinear(gray, sw, sh, x, y);
    }
    if (outside) continue;
    let idx = 0, firstDark = -1, lastDarkEnd = -1;
    for (const r of scanlineRuns(row.subarray(0, count), t)) {
      if (r.dark) { if (firstDark < 0) firstDark = idx; lastDarkEnd = idx + r.len - 1; }
      idx += r.len;
    }
    // 整條都亮(落在 bearer bar 與條之間的空白)或暗 run 貼到掃描邊界(被切掉)→ 作廢
    if (firstDark <= 0 || lastDarkEnd >= count - 1) continue;
    const lp = firstDark - 1 + crossFraction(row[firstDark - 1], row[firstDark], t);
    const rp = lastDarkEnd + crossFraction(row[lastDarkEnd], row[lastDarkEnd + 1], t);
    leftPts.push({ x: A.x + (dx * lp) / (count - 1), y: A.y + (dy * lp) / (count - 1) });
    rightPts.push({ x: A.x + (dx * rp) / (count - 1), y: A.y + (dy * rp) / (count - 1) });
  }
  fit.left = fitLineTLS(leftPts, { madK: L.madK });
  fit.right = fitLineTLS(rightPts, { madK: L.madK });
  updateStats();
  const lrBad = [lineBad("left", "左邊", leftPts.length), lineBad("right", "右邊", rightPts.length)].filter(Boolean);
  if (lrBad.length) return fail(lrBad.join("、"));

  // 6. 求交點(只檢查相鄰線對)
  const corners = [];
  let minAngle = 180;
  for (const [a, b] of [["top", "left"], ["top", "right"], ["bottom", "right"], ["bottom", "left"]]) {
    const r = intersectLines(fit[a], fit[b]);
    if (!r) { minAngle = 0; break; }
    if (r.angleDeg < minAngle) minAngle = r.angleDeg;
    corners.push(r.p);
  }
  metrics.minCornerAngleDeg = minAngle;
  if (corners.length < 4 || minAngle < L.minCornerAngleDeg) {
    return fail(`四線近乎平行,交點在無窮遠（相鄰線夾角 ${minAngle.toFixed(1)}° < ${L.minCornerAngleDeg}°）`);
  }
  return { ok: true, corners, source: "1d-edges", fit, metrics, reason: "" };
}

/** 條端擬合取像範圍的餘裕(見 edgeFitRoi)。裁切邊界不得被當成條端,故要留白。 */
export const EDGE_FIT_ROI_PAD = Object.freeze({ ratio: 0.15, minPx: 8 });

/**
 * 1D 條端擬合要用的**取像範圍**(規格 §3.3「取像範圍」段)。純函式。
 * 輸入:points 兩個(以上)定位點、imgW / imgH 來源影像尺寸(**與 points 同一座標系**);
 * 輸出:{ x0, y0, x1, y1 } 整數矩形,或 `null`(點不足 / 座標非有限 / 定位線退化)。
 *
 * **為什麼不能沿用量測 ROI —— 2026-08-04 實測發現的整合缺口。**
 * 量測 ROI 由「定位點 bbox 外擴 25%(下限 24px)」而來。這對 2D 沒問題(三四個點
 * 撐得出高度),但 **1D 的兩個定位點 y 幾乎相同 ⇒ bbox 高度 ≈ 0 ⇒ 垂直只外擴到保底的
 * 24px,ROI 高度僅約 48px**,而條高動輒一兩百 px —— **條的上下端整個落在 ROI 之外**,
 * quadFrom1DEdges 必定回「上下邊取樣點不足(有效邊界點 0 個)」。
 * 實測(合成 ITF、900×600 相機影像):沿用量測 ROI(高 49px)→ 失敗;
 * 同一組點餵整張影像 → `ok`、`source: "1d-edges"`。
 * 也就是說**階段 ⑤ 的功能寫好了卻在真實呼叫端一次都走不到**,而單元測試餵的是整張圖,
 * 全綠也照樣看不出來。故取像範圍必須另算,不可與量測 ROI 共用。
 *
 * **為什麼不是把量測 ROI 一起放大:** 量測 ROI 一放大就多吃進大片靜區白底,
 * `roiPhotometric` 的 rLight / rDark / edgeContrasts 會系統性位移,而
 * `policies.ts` 的允收門檻是在舊取樣條件下定的(規格 §6.1 明令未經實拍對照不得動)。
 * 兩者職責不同,分開算才不會互相污染。
 *
 * 垂直半徑取 `searchHalfSpanRatio × 定位線長` —— 與 quadFrom1DEdges 的搜尋半徑**同源**,
 * 保證「搜尋搆得到的範圍」都在裁切內;再加 EDGE_FIT_ROI_PAD 的餘裕,避免條端正好壓在
 * 裁切邊界上被「不得用畫面邊界當條端」那道守衛擋掉。
 * 水平沿用 `crossOverscanRatio`(求左右邊時掃描線的外延量),同樣加餘裕。
 */
export function edgeFitRoi(points, imgW, imgH) {
  const two = takeFinitePoints(points, 2);
  if (!two || !(imgW > 0) || !(imgH > 0)) return null;
  const [p0, p1] = two;
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (!(len >= LINE_FIT_LIMITS.minLocatorLenPx)) return null;
  const pad = (v) => v * (1 + EDGE_FIT_ROI_PAD.ratio) + EDGE_FIT_ROI_PAD.minPx;
  const halfV = pad(LINE_FIT_LIMITS.searchHalfSpanRatio * len);
  const halfH = pad(LINE_FIT_LIMITS.crossOverscanRatio * len);
  // 以定位線 bbox 為中心外擴。定位線本身可能是斜的,故兩軸都由 bbox 起算而非中點。
  const bx0 = Math.min(p0.x, p1.x), bx1 = Math.max(p0.x, p1.x);
  const by0 = Math.min(p0.y, p1.y), by1 = Math.max(p0.y, p1.y);
  const x0 = Math.max(0, Math.floor(bx0 - halfH)), y0 = Math.max(0, Math.floor(by0 - halfV));
  const x1 = Math.min(imgW, Math.ceil(bx1 + halfH)), y1 = Math.min(imgH, Math.ceil(by1 + halfV));
  if (!(x1 - x0 >= 2 && y1 - y0 >= 2)) return null;
  return { x0, y0, x1, y1 };
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
  let quad = quadFromZxingPoints(points, sym, moduleSizePx);
  if (!quad) {
    // 定位點少於 3 個 = 1D 的掃描線兩端點。**只有已知的 1D 符號別才啟動條端擬合**:
    // 比照「符號別不明時一律保守」,寧可退回代理值,不可拿一組意義不明的點去擬合。
    if (ONE_D_SYMBOLOGIES.includes(sym)) {
      const e = quadFrom1DEdges(gray, w, h, points, { sym });
      if (!e.ok) return fail(e.reason);
      // derived 必為 false —— 四角是實測擬合出來的,不是推算的,rectifyPlan 依既有第 3 條
      // 規則放行,那支的判斷邏輯一行都不必改。
      quad = { corners: e.corners, derived: false, dimension: null, source: e.source };
    } else {
      const known = typeof sym === "string" && sym.length > 0;
      return fail(`四角不足（定位點少於 3 個,符號別${known ? ` ${sym} 不走 1D 條端擬合` : "不明"}）`);
    }
  }
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
 * 3. 四角皆為實測(DataMatrix 四點、QR 由 alignment 還原、1D 由條端擬合)→ 兩者皆 true。
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
    ? `,QR 四角由 alignment pattern 還原（N=${rect.dimension}）`
    : rect.quadSource === "1d-edges" ? ",1D 四角由條端擬合" : "";
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

// ═══ 1D 元素計量(規格 §3.5 · 2026-08-05 重新設計)═══════════════════════════
//
// 取代 roi1DGeometry 的量測路徑。動機是兩個**在像素完美、零雜訊合成圖上就成立**的失效
//(所以與鏡頭 / 光線 / 拍攝技巧全都無關):
//
//  失效 A —— 量測模型套錯符號別。roi1DGeometry 對所有 1D 符號一律算「元素寬 ÷ 模組寬,
//    離最近整數多遠」。這對**模組型**符號(Code 128 / QR / DataMatrix,元素是模組整數倍)
//    是對的,但 **ITF-14 是雙寬(two-width)符號** —— 元素只有窄與寬兩種,寬窄比是一個
//    允許落在 2.0–3.0 的比例,GS1 建議 2.5。於是 2.5 離最近整數剛好 0.5,而容差正是 0.5:
//    DEC = 1 − 0.5/0.5 = 0 → **F**,而且 6 / 12 / 24 px/元素全部一樣。提高解析度永遠無效。
//
//  失效 B —— 模組寬被量化成整數像素。scanlineRuns 以整數像素切 run,模組寬取十百分位,
//    所以永遠是整數;實拍時每模組像素數幾乎不可能是整數,誤差由全部元素繼承。
//    實測:5.5 px/模組 → DEC 0.80(F);9.7 px → 3.20(B);14.2 px → 3.43(A/B)。
//    **同一張完美圖,只是換個距離拍。**
//
// 業界(ISO/IEC 15416)的做法與此處採用的對應:
//   ① 量測孔徑 —— verifier 讀的是規定直徑圓孔徑內的平均反射率,本質是空間低通濾波,
//      把比孔徑細的紙紋 / 楞痕 / 網點抹平。**本檔只把孔徑施加在幾何掃描線上**,
//      光度量測(roiPhotometric)完全不經過它 —— 故不影響 SC / MOD / Rmin,
//      不觸及規格 §6.1 的門檻凍結(2026-08-05 裁示 D3 已把光度與幾何拆開,前提成立)。
//   ② 邊界取剖面**穿越全域門檻 GT=(Rmax+Rmin)/2 的次像素內插位置**,不是二值化後的整數 run。
//   ③ Decodability 依**該符號別自己的參考解碼演算法**定義,雙寬與模組型不是同一個量。
//   ④ 模組型用**邊到同向邊(E2SE)**,天生免疫於均勻墨量增益(柔印瓦楞的主要劣化)。
//
// **未做(留待後續)**:逐掃描線評級後平均(ISO 的聚合順序)—— 那要動 src/engines/grade.ts,
//   影響面最大,依落地順序排在實拍數字回來之後。

/** 1D 符號別的量測模型類別。改這裡就要改規格 §3.5 的對照表。 */
export const ONE_D_KIND = Object.freeze({
  ITF14: "twoWidth",   // 雙寬:元素只有窄 / 寬,比例 2.0–3.0(GS1 建議 2.5)
  GS1_128: "modular",  // 模組型:元素為 1–4 個模組的整數倍
  CODE128: "modular",
});

/** ITF(Interleaved 2 of 5)每個數字的五元素窄寬樣式。N=窄 W=寬。 */
const ITF_DIGIT = Object.freeze({
  0: "NNWWN", 1: "WNNNW", 2: "NWNNW", 3: "WWNNN", 4: "NNWNW",
  5: "WNWNN", 6: "NWWNN", 7: "NNNWW", 8: "WNNWN", 9: "NWNWN",
});

/**
 * 由解碼字串重建 ITF 的標稱窄/寬序列(規格 §3.5 的 S6「參考解碼取回標稱值」)。
 * **這是整個重新設計的樞紐**:解碼已經成功,所以真值是已知的 ——
 * 不必再從量到的數字裡「猜」模組寬,改成對已知答案做擬合。
 * 輸入:偶數長度的數字字串;輸出:Uint8Array(0=窄, 1=寬),長度 4 + 10×(n/2) + 3;
 *   位數為奇數 / 含非數字 / 空字串一律回 null(呼叫端據此走「不可量測」)。
 */
export function itfNominalPattern(digits) {
  const s = String(digits == null ? "" : digits);
  if (!s.length || s.length % 2 !== 0 || !/^\d+$/.test(s)) return null;
  const out = [];
  out.push(0, 0, 0, 0);                    // start pattern NNNN
  for (let i = 0; i < s.length; i += 2) {
    const a = ITF_DIGIT[s[i]], b = ITF_DIGIT[s[i + 1]];
    if (!a || !b) return null;
    for (let k = 0; k < 5; k++) {          // 交錯:前碼給條、後碼給空
      out.push(a[k] === "W" ? 1 : 0);
      out.push(b[k] === "W" ? 1 : 0);
    }
  }
  out.push(1, 0, 0);                       // stop pattern WNN
  return Uint8Array.from(out);
}

/**
 * 合成孔徑(規格 §3.5 的 S2)。圓形孔徑投影到一維掃描線上的等效權重是**弦長**
 * w(x) = 2√((d/2)² − x²) —— 不是方波也不是高斯,那是圓孔徑的幾何。
 * 輸入:剖面(Float64Array 或數值陣列)、孔徑直徑(px);輸出:新的 Float64Array。
 * 直徑 < 1.05 px 視為無孔徑,直接回傳複本(不做無意義的卷積)。
 */
export function apertureProfile(prof, diameterPx) {
  const n = prof.length;
  const out = new Float64Array(n);
  if (!(diameterPx > 1.05)) { for (let i = 0; i < n; i++) out[i] = prof[i]; return out; }
  const R = diameterPx / 2, r = Math.floor(R);
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.max(0, R * R - i * i);
    const w = 2 * Math.sqrt(v);
    k[i + r] = w; sum += w;
  }
  if (sum <= 0) { for (let i = 0; i < n; i++) out[i] = prof[i]; return out; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += prof[Math.min(n - 1, Math.max(0, i + j))] * k[j + r];
    out[i] = s;
  }
  return out;
}

/**
 * 次像素邊界(規格 §3.5 的 S4)。回傳剖面穿越 gt 的內插座標陣列。
 * **用「明/暗狀態轉換」判定,不用乘積變號**:取樣值精確等於門檻時乘積為 0,
 * 嚴格變號判定會整個漏掉那條邊 —— 合成圖在非整數取樣密度下邊界覆蓋率剛好 0.5,
 * 會系統性踩到這個情形(實拍幾乎不會,但守門測試會)。
 */
export function subpixelEdges(prof, gt) {
  const e = [];
  if (!prof || prof.length < 2) return e;
  let prevLight = prof[0] >= gt;
  for (let i = 1; i < prof.length; i++) {
    const light = prof[i] >= gt;
    if (light !== prevLight) {
      const a = prof[i - 1], b = prof[i], d = b - a;
      e.push(d === 0 ? i - 0.5 : i - 1 + (gt - a) / d);
      prevLight = light;
    }
  }
  return e;
}

/**
 * 已知標稱模組數時的模組寬閉式最小平方解(規格 §3.5 的 S7)。
 *   w = argmin Σ (mᵢ − w·nᵢ)²  ⇒  w = Σ(mᵢnᵢ) / Σ(nᵢ²)
 * 比十百分位估計穩健:用上**全部**元素而非單一分位點,且不會被量化成整數。
 */
export function fitModuleLS(measured, nominal) {
  let num = 0, den = 0;
  for (let i = 0; i < measured.length; i++) { num += measured[i] * nominal[i]; den += nominal[i] * nominal[i]; }
  return den > 0 ? num / den : 0;
}

/**
 * Code 128 的總模組數 —— 由**元素數**推出,不需要 103 個樣式的編碼表。
 * 結構(ISO/IEC 15417)是固定的:start / 每個資料字元 / check 各為 **6 元素 11 模組**,
 * stop 為 **7 元素 13 模組**。故 元素數 E = 6n + 19、總模組數 = 11n + 35(n = 資料字元數)。
 * 輸入:元素數;輸出:總模組數,或 null(元素數不符 Code 128 結構 → 數錯了)。
 *
 * **為什麼需要它:** 無約束的模組寬估計在墨量增益下會收斂到錯誤的局部解 ——
 * 實測:條各胖 0.3 模組、空各瘦 0.3 模組時,迭代擬合收斂到 module 8.56(真值 12)、
 * 標稱序列整組錯位,DEC 與 BWR 一起被污染。而柔印墨量增益正是瓦楞箱的主要劣化,
 * 不能在那個情境下失效。總跨距 ÷ 已知總模組數是閉式解、沒有歧義,
 * 且對稱的墨量增益**不改變總跨距**,天生免疫。
 */
export function code128TotalModules(elementCount) {
  if (!Number.isInteger(elementCount)) return null;
  const n = (elementCount - 19) / 6;
  if (!Number.isInteger(n) || n < 0) return null;
  return 11 * n + 35;
}

/**
 * 模組型符號的模組寬與標稱序列(規格 §3.5 的 S7,模組型分支)。
 * 以 totalModules 為錨:w = 總跨距 ÷ 總模組數 → 四捨五入得標稱 → 閉式 LS 精修。
 * **捨入後的總模組數必須對得回 totalModules**,否則就是數錯了(回 ok:false,呼叫端作廢該掃描線)。
 * 輸入:量到的元素寬、總模組數;輸出:{ module, nominal, ok }。
 */
export function fitModuleAnchored(measured, totalModules) {
  if (!measured.length || !(totalModules > 0)) return { module: 0, nominal: null, ok: false };
  let span = 0;
  for (const m of measured) span += m;
  const w0 = span / totalModules;
  if (!(w0 > 0)) return { module: 0, nominal: null, ok: false };
  const nominal = measured.map((m) => Math.max(1, Math.round(m / w0)));
  let sum = 0;
  for (const n of nominal) sum += n;
  if (sum !== totalModules) return { module: 0, nominal: null, ok: false };
  const w = fitModuleLS(measured, nominal);
  return w > 0 ? { module: w, nominal, ok: true } : { module: 0, nominal: null, ok: false };
}

/**
 * 雙寬符號的擬合與判別餘裕(規格 §3.5 的 S8)。
 * 輸入:量到的元素寬、標稱窄寬序列(0/1);
 * 輸出:{ narrow, wide, ratio, margin } —— margin 是**最差元素離判別門檻還剩多少**,
 *   1 = 完美、0 = 剛好落在門檻上、< 0 = 已經會誤讀。語意對應 ISO 的 V=(RT−RM)/RT。
 * 判別門檻 RT 取窄寬兩群平均的中點(這是雙寬符號參考解碼的做法:窄寬分不分得開,
 * 而不是「離某個整數倍多遠」—— 後者正是失效 A)。
 */
export function fitTwoWidth(measured, isWide) {
  const nArr = [], wArr = [];
  for (let i = 0; i < measured.length; i++) (isWide[i] ? wArr : nArr).push(measured[i]);
  if (!nArr.length || !wArr.length) return { narrow: 0, wide: 0, ratio: 0, margin: -1 };
  // 用**中位數**而非平均:單一個印歪的元素若把判別門檻拉向自己,就會遮掉自己的異常
  // (平均下實測 margin 0.33,中位數下 ≈ 0 —— 後者才是該回報的)。
  const med = (a) => { const s = [...a].sort((x, y) => x - y); const h = s.length >> 1;
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  const narrow = med(nArr), wide = med(wArr), rt = (narrow + wide) / 2;
  if (!(wide > narrow)) return { narrow, wide, ratio: 0, margin: -1 };
  let margin = Infinity;
  for (let i = 0; i < measured.length; i++) {
    // 窄元素應落在 RT 之下、寬元素在 RT 之上;各自以「到 RT 的半距」正規化
    const m = isWide[i] ? (measured[i] - rt) / (wide - rt) : (rt - measured[i]) / (rt - narrow);
    if (m < margin) margin = m;
    }
  return { narrow, wide, ratio: wide / narrow, margin: Math.min(1, margin) };
}

/** 幾何掃描的孔徑直徑(以模組寬計)。ISO 對大 X 尺寸的參考孔徑約 0.5 X。 */
export const GEOMETRY_APERTURE_X = 0.5;

/**
 * 1D 元素計量主入口(規格 §3.5)。取代 roi1DGeometry 的**量測**職責。
 * 輸入:ROI 灰階、寬、ROI 座標、opts { sym, text, scanlines, apertureX }
 * 輸出:{ scanlines:[{maxWidthDeviation, tolerance, maxElementReflectanceNonUniformity}],
 *        modulePx, kind, bwr, elementsExpected, elementsMatched, marginWorst }
 *   —— scanlines 的形狀與 roi1DGeometry 相同,呼叫端(buildGradeResult)不必改。
 *
 * 兩趟:第一趟不加孔徑求粗略模組寬,第二趟以 0.5 × 粗略模組寬的孔徑重量。
 * 孔徑直徑必須以**模組數**而非像素指定,否則它會隨拍攝距離漂移。
 */
export function roi1DMetrology(gray, w, roi, opts = {}) {
  const kind = ONE_D_KIND[opts.sym] || "modular";
  const nScan = opts.scanlines || 10;
  const apX = opts.apertureX === undefined ? GEOMETRY_APERTURE_X : opts.apertureX;
  const r = roiSlice(gray, w, roi);
  const nominalPat = kind === "twoWidth" ? itfNominalPattern(opts.text) : null;
  const expected = nominalPat ? nominalPat.length : null;

  const rows = [];
  for (let k = 0; k < nScan; k++) {
    const y = Math.floor((r.h * (k + 0.5)) / nScan);
    rows.push(Float64Array.from(r.data.subarray(y * r.w, (y + 1) * r.w)));
  }

  // 第一趟:無孔徑,取粗略模組寬(只為了決定孔徑大小)
  let seed = 0, seedN = 0;
  for (const row of rows) {
    const e = subpixelEdges(row, gtOf(row));
    if (e.length < 5) continue;
    const wid = [];
    for (let i = 1; i < e.length; i++) wid.push(e[i] - e[i - 1]);
    const s = [...wid].sort((a, b) => a - b);
    seed += s[Math.floor(s.length * 0.1)] || s[0]; seedN++;
  }
  const apDiam = seedN ? (seed / seedN) * apX : 0;

  const out = [];
  const modules = [];
  let bwrSum = 0, bwrN = 0, matched = 0, marginWorst = Infinity, elemResidualWorst = 0;

  for (const row of rows) {
    const prof = apDiam > 1.05 ? apertureProfile(row, apDiam) : row;
    const gt = gtOf(prof);
    const edges = subpixelEdges(prof, gt);
    if (edges.length < 5) { continue; }
    const meas = [];
    for (let i = 1; i < edges.length; i++) meas.push(edges[i] - edges[i - 1]);
    // 暗元素的反射不均(DEF 輸入):沿用原語意,量在**未經孔徑**的原始剖面上
    let maxDef = 0;
    for (let i = 0; i < meas.length; i += 2) {
      const a = Math.ceil(edges[i]), b = Math.floor(edges[i + 1]);
      let lo = 255, hi = 0;
      for (let x = a; x <= b && x < row.length; x++) { if (row[x] < lo) lo = row[x]; if (row[x] > hi) hi = row[x]; }
      if (hi >= lo) { const nu = (hi - lo) / 255; if (nu > maxDef) maxDef = nu; }
    }

    if (kind === "twoWidth") {
      // S5 元素數驗證:對不上就是數錯了,該掃描線作廢(不硬湊一個等級出來)
      if (!nominalPat || meas.length !== expected) continue;
      matched++;
      const f = fitTwoWidth(meas, nominalPat);
      if (!(f.narrow > 0)) continue;
      modules.push(f.narrow);
      if (f.margin < marginWorst) marginWorst = f.margin;
      // 條 / 空殘差差 → 條寬增益(BWR),偶數索引為條
      let bs = 0, bn = 0, ss = 0, sn = 0;
      for (let i = 0; i < meas.length; i++) {
        const nomW = nominalPat[i] ? f.wide : f.narrow;
        const res = meas[i] - nomW;
        if (i % 2 === 0) { bs += res; bn++; } else { ss += res; sn++; }
      }
      if (bn && sn) { bwrSum += (bs / bn - ss / sn) / f.narrow; bwrN++; }
      // margin 直接就是 DEC:令 tolerance=0.5、deviation=(1−margin)×0.5 ⇒ DEC = margin
      out.push({ maxWidthDeviation: (1 - Math.max(0, f.margin)) * 0.5, tolerance: 0.5,
                 maxElementReflectanceNonUniformity: maxDef });
    } else {
      // S5 元素數驗證(模組型):元素數必須符合 Code 128 的固定結構,
      // 且捨入後的總模組數要對得回去。任一條不成立就是數錯了 → 該掃描線作廢。
      const total = code128TotalModules(meas.length);
      if (total === null) continue;
      const f = fitModuleAnchored(meas, total);
      if (!f.ok) continue;
      matched++;
      modules.push(f.module);
      // E2SE(邊到同向邊):量「這個條的左緣到下一個條的左緣」,均勻墨量增益會抵銷掉。
      // 同時算「元素逐一殘差」只為了診斷與守門對照 —— 它**不**參與評級,
      // 因為它正是會被墨量增益污染的那個量(實測:條各胖 0.3 模組時,
      // 元素逐一殘差 0.330、E2SE 殘差 0.054,污染降到約 1/6)。
      let worst = 0, elemWorst = 0;
      for (let i = 0; i + 1 < meas.length; i++) {
        const me = meas[i] + meas[i + 1], no = f.nominal[i] + f.nominal[i + 1];
        const d = Math.abs(me - f.module * no) / f.module;   // 以模組為單位
        if (d > worst) worst = d;
      }
      for (let i = 0; i < meas.length; i++) {
        const d = Math.abs(meas[i] - f.module * f.nominal[i]) / f.module;
        if (d > elemWorst) elemWorst = d;
      }
      if (elemWorst > elemResidualWorst) elemResidualWorst = elemWorst;
      let bs = 0, bn = 0, ss = 0, sn = 0;
      for (let i = 0; i < meas.length; i++) {
        const res = meas[i] - f.module * f.nominal[i];
        if (i % 2 === 0) { bs += res; bn++; } else { ss += res; sn++; }
      }
      if (bn && sn) { bwrSum += (bs / bn - ss / sn) / f.module; bwrN++; }
      if (1 - worst / 0.5 < marginWorst) marginWorst = 1 - worst / 0.5;
      out.push({ maxWidthDeviation: worst, tolerance: 0.5,
                 maxElementReflectanceNonUniformity: maxDef });
    }
  }

  modules.sort((a, b) => a - b);
  return {
    scanlines: out,
    modulePx: modules.length ? modules[Math.floor(modules.length / 2)] : 0,
    kind,
    bwr: bwrN ? bwrSum / bwrN : null,
    elementsExpected: expected,
    elementsMatched: matched,
    marginWorst: Number.isFinite(marginWorst) ? marginWorst : null,
    // 診斷用:模組型的「元素逐一殘差」。**不參與評級** —— 它是會被墨量增益污染的量,
    // 留著是為了讓「E2SE 有沒有真的擋掉污染」變成可斷言的事實(見規格 §3.5)。
    elementResidualWorst: kind === "modular" ? elemResidualWorst : null,
  };
}

/** 單條剖面的全域門檻 GT = (Rmax + Rmin) / 2(ISO 15416 的定義)。 */
function gtOf(prof) {
  let hi = -Infinity, lo = Infinity;
  for (let i = 0; i < prof.length; i++) { const v = prof[i]; if (v > hi) hi = v; if (v < lo) lo = v; }
  return (hi + lo) / 2;
}

// ── 可量測性判定(規格 §3.4 · 2026-08-05 裁示 D4)──────────────────────────
// 由來:對抗性稽核 IMG-09 / IMG-03 / IMG-04 —— 解碼失敗時仍以「畫面中央 70%」的任意
// 像素產出等級與「通過/未通過」;1D 橫躺時掃描線全滅、落到硬寫的 {0.5,0.5,0.5} 最差值
// 判 F;無相機時情境模擬值走完整條結果頁 / 清單 / PDF 且無任何文字標記。
// 三者的共通點是「量到的不是符號本體,卻照樣輸出一個看起來正常的等級」。
//
// 判斷邏輯放這裡而非 mobile.html:demo/*.html 無自動化測試可覆蓋,一寫進 HTML 就再也
// 驗不了(handoff.md 的既有紀律)。本檔只做判定,呈現與匯出由呼叫端負責。

/** 不可量測的原因碼。 */
export const UNMEASURABLE = Object.freeze({
  NO_DECODE: "no-decode",
  NO_SCANLINE: "no-scanline",
});

/**
 * 原因碼 → 使用者可見說明。結果頁 / 清單 / PDF 一律照這張表顯示,不另外造詞。
 * 措辭刻意只描述「量不到」這件事實,不暗示符號本身的品質好壞 ——
 * 量不到不等於印壞了(規格 A3 定位護欄:本工具只出相對代理值)。
 */
export const UNMEASURABLE_LABEL = Object.freeze({
  "no-decode": "不可量測 — 影像中找不到可解碼的符號",
  "no-scanline": "不可量測 — 掃描線全數不可用,量到的不是符號本體",
});

/** 示範模式(無相機)的標記文字。等級照出,但全程標記且不計入通過率統計。 */
export const SIMULATED_LABEL = "示範模式 — 情境模擬值,非實拍量測";

/**
 * 判定「條碼橫躺」的定位線角度門檻(度)。1D 的量測沿影像水平列掃描,符號一旦轉到
 * 接近垂直就一條掃描線都取不到。45° 是兩個方位的分界,不是品質門檻 ——
 * 它只決定「要不要提示使用者轉正」,不參與任何分級或允收判定。
 */
export const ROTATED_HINT_MIN_DEG = 45;

/**
 * 可量測性判定(純函式)。輸入:
 *   - simulated:本次是否為無相機的情境模擬
 *   - decoded:是否解碼成功
 *   - isOneD:是否為 1D 符號別
 *   - scanlineCount:roi1DGeometry 實際取得的可用掃描線數(1D 才有意義)
 *   - lineAngleDeg:定位線相對水平的角度(lineAngleDeg 的輸出,可為 null)
 * 輸出:{ measurable, simulated, code, label, hint }
 *   - measurable 為 false 時呼叫端**不得輸出等級與通過/未通過**,改顯示 label。
 *   - simulated 為 true 時等級照出,但必須全程標記且排除於通過率統計之外
 *     (示範模式的用途就是展示結果頁,抽掉等級這個模式就沒有意義了;
 *      稽核 IMG-03 指的是「沒有標記」,不是「不該有等級」)。
 *   - hint 是可選的操作指引(目前只有橫躺轉正),沒有就是空字串。
 */
export function assessMeasurability(input) {
  const o = input || {};
  const simulated = !!o.simulated;
  // 模擬是**獨立的一軸**,不short-circuit 解碼判定:示範模式若也照樣對解碼失敗出等級,
  // 教給使用者的心智模型正是稽核 IMG-09 要拔掉的那一個。示範模式要忠實反映真實路徑。
  if (!o.decoded) {
    return { measurable: false, simulated, code: UNMEASURABLE.NO_DECODE,
      label: UNMEASURABLE_LABEL[UNMEASURABLE.NO_DECODE], hint: "" };
  }
  if (simulated) return { measurable: true, simulated: true, code: "", label: SIMULATED_LABEL, hint: "" };
  if (o.isOneD && !(o.scanlineCount > 0)) {
    // 解碼成功卻一條掃描線都取不到,最常見的成因是符號橫躺(量測沿水平列掃描)。
    // 角度拿得到且超過門檻才給指引,拿不到就不猜 —— 猜錯會把使用者推去做無效的重拍。
    const a = typeof o.lineAngleDeg === "number" && Number.isFinite(o.lineAngleDeg)
      ? Math.abs(o.lineAngleDeg) : null;
    const rotated = a !== null && a >= ROTATED_HINT_MIN_DEG;
    return { measurable: false, simulated: false, code: UNMEASURABLE.NO_SCANLINE,
      label: UNMEASURABLE_LABEL[UNMEASURABLE.NO_SCANLINE],
      hint: rotated ? "條碼橫躺,請轉正後重拍" : "" };
  }
  return { measurable: true, simulated: false, code: "", label: "", hint: "" };
}

// ── 快門延遲下的取幀誠實性(規格 §3.7 · 2026-08-06)──────────────────────────
// 由來:實機回報「拍照與取像有延遲,導致拍照有問題、無法判斷品質」。追下去是兩件事:
//   ① 燈號量的是快門**前** ≤500ms 的預覽幀(measureFrame 每 500ms 一跳,且按下快門後
//      整段停量),被分級的卻是快門**後**取到的照片(L1 takePhoto 的手機快門延遲典型
//      200–800ms、L2 applyConstraints 最多等 500ms 重新協商)。最壞情況兩張影像相隔
//      約 1.3 秒,手持位移與相機重新對焦都發生在這個窗口裡。
//   ② 「本張閘門」(裁示 D5③)本意是記錄這張照片的實際拍攝品質,但它讀的是
//      state.gate 的預覽殘值 —— 對焦 / 眩光 / 楞痕三項**從未量過被分析的那張影像**。
//      報告印「本張閘門 全部 OK」時,那三欄講的是另一張影像。
//
// 修法的核心不是「把延遲消掉」(消不掉:takePhoto 的延遲在瀏覽器與韌體裡),而是
// **把判定改成量在被分析的那張影像上** —— 延遲多久都不影響結論的正確性。本函式只負責
// 「預覽過了、照片沒過」這個組合的判讀,判定本身仍走既有的已校準門檻。
//
// ⚠ 刻意不做的事:不拿「照片 varLap ÷ 預覽 varLap」的比值當判準。兩者雖都取樣到
//   320px 寬,來源尺度不同(預覽 1280 縮下來、照片可能 4032 縮下來),後者抗鋸齒平均
//   更重、高頻能量被多吃掉一些,比值本身帶著系統性偏差。未經實拍校準就拿它當門檻會
//   造成偽陽性。比值仍算出來並記錄,但**只作診斷數字**,不參與任何判定。

/** 取幀不新鮮的原因碼。 */
export const SHOT_FRESHNESS = Object.freeze({
  FOCUS_DROP: "focus-drop",
  GLARE_JUMP: "glare-jump",
});

/**
 * 原因碼 → 使用者可見說明。措辭指向「這張照片」而非符號品質 ——
 * 延遲期間畫面變動不代表印刷有問題(規格 A3 定位護欄)。
 */
export const SHOT_FRESHNESS_LABEL = Object.freeze({
  "focus-drop": "拍攝當下畫面已變動 — 這張照片的對焦不足,量測值不可採信",
  "glare-jump": "拍攝當下角度已變動 — 這張照片的眩光超標,量測值不可採信",
});

/**
 * 標示「快門偏慢」的毫秒門檻。**純顯示用,不參與任何判定** ——
 * 它只決定報告要不要在延遲數字旁邊加一句提示,好讓實機驗收看得出哪台機器慢。
 * 400 是暫定值(手機 takePhoto 的常見範圍上緣),要靠規格 §5.2 的實機資料校準。
 */
export const SLOW_SHUTTER_MS = 400;

/**
 * 取幀新鮮度判定(純函式)。輸入:
 *   - previewFocusOk / shotFocusOk:對焦項在**預覽**與**被分析照片**上的閘門結果(布林)
 *   - previewGlareOk / shotGlareOk:眩光項的同上兩組結果
 *   - previewVarLap / shotVarLap:兩者的對焦讀數(僅供算診斷比值,不參與判定)
 *   - latencyMs:按下快門到取幀完成的實測毫秒數(拿不到傳 null)
 * 輸出:{ stale, code, label, focusRatio, latencyMs, slow, note }
 *   - stale 為 true 表示**預覽當下是好的、照片卻不是**,即劣化發生在延遲窗口內。
 *     呼叫端應顯示 label 並建議重拍;它不改分級、不動門檻(沿裁示 D5 的先例)。
 *   - 預覽本來就沒過的情形不算 stale:那是使用者沒對準,與延遲無關,
 *     而且閘門本來就會鎖住快門,走不到這裡。
 *   - note 是要印進報告的一行診斷文字,拿不到數字時為空字串。
 */
export function assessShotFreshness(input) {
  const o = input || {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const pv = num(o.previewVarLap), sv = num(o.shotVarLap);
  const latencyMs = num(o.latencyMs);
  // 比值在預覽讀數為 0 時無意義(除以零),此時不給比值而非給 Infinity
  const focusRatio = pv !== null && sv !== null && pv > 0 ? sv / pv : null;
  const slow = latencyMs !== null && latencyMs >= SLOW_SHUTTER_MS;

  let code = "";
  // 對焦優先於眩光:兩者同時劣化時,對焦是使用者更該先處理的那一個
  if (o.previewFocusOk === true && o.shotFocusOk === false) code = SHOT_FRESHNESS.FOCUS_DROP;
  else if (o.previewGlareOk === true && o.shotGlareOk === false) code = SHOT_FRESHNESS.GLARE_JUMP;

  const parts = [];
  if (latencyMs !== null) parts.push(`快門延遲 ${latencyMs}ms` + (slow ? "(偏慢)" : ""));
  if (focusRatio !== null) parts.push(`對焦相對預覽 ${Math.round(focusRatio * 100)}%`);

  return {
    stale: !!code,
    code,
    label: code ? SHOT_FRESHNESS_LABEL[code] : "",
    focusRatio,
    latencyMs,
    slow,
    note: parts.join(" · "),
  };
}

// ── 等級成因說明(規格 §3.8 · 2026-08-06)──────────────────────────────────
// 由來:實機回報「報告沒有照片,只能憑感覺」。結果頁只給一個字母加一排代號
// (`SC B(2.76)`),看的人無從判斷這個等級是怎麼來的、該去改什麼。
//
// **這支函式最重要的工作是不要說謊。** 聚合規則兩種符號別不同(src/engines/grade.ts):
//   · 2D:總分 = 所有參數的**最小值** ⇒ 講得出「就是這一項決定的」,精確。
//   · 1D:每條掃描線先取自己參數的最小值,再把 N 條**平均** ⇒ 總分不等於任何單一參數,
//        而且 GradeResult.parameters 回報的只是**第 1 條掃描線**的參數。
//        所以 1D 不可以說「等級由 X 決定」—— 那是錯的。只能說「最常成為限制項的是 X」,
//        並且要把逐條的離散度講出來(它本身就是拍攝穩定度的指標)。
// 呼叫端必須把逐條掃描線各自的結果傳進來(對每條各跑一次 buildGradeResult 即可,
// 那是純函式且很便宜),否則 1D 只能退化成「單條」敘述。

/** 參數代號 → 現場語言的成因。措辭只描述「可能的物理成因」,不下合規判定。 */
export const PARAM_CAUSE = Object.freeze({
  SC:   { name: "對比",     why: "條與空的反射差不夠 —— 墨太淡、箱面顏色太深,或現場光線不足" },
  MOD:  { name: "調變",     why: "條與空的反射分不開 —— 墨量不均、楞痕透印把空的地方壓暗" },
  Rmin: { name: "最低反射", why: "條不夠黑 —— 墨量不足或印版壓力不夠" },
  DEC:  { name: "可解碼性", why: "條空寬度偏離標稱值 —— 墨量增益(柔印最常見)、印版變形,或拍攝角度傾斜" },
  DEF:  { name: "缺陷",     why: "單一元素內部反射不均 —— 紙面瑕疵、楞痕、噴頭斷線或刮痕" },
  FPD:  { name: "定位圖形", why: "定位/時序圖形破損 —— 印壞、磨損,或取像時被遮到" },
  GNU:  { name: "網格均勻性", why: "模組位置偏離理想格點 —— 印版變形或拍攝透視沒矯正掉" },
  UEC:  { name: "錯誤更正", why: "已經吃掉較多錯誤更正餘裕 —— 符號本身有損傷" },
});

/** 聚合規則的說明文字,兩種符號別各一句。呈現端照這張表顯示,不另外造詞。 */
export const GRADE_RULE = Object.freeze({
  oneD: "1D:每條掃描線先取自己最差的參數,再把各條平均 —— 所以總等級不等於任何單一參數。",
  twoD: "2D:總等級就是所有參數裡最低的那一項。",
});

/** 逐條掃描線等級的離散度門檻(級)。超過就提示拍攝條件不穩,**不參與任何評級**。 */
export const SCANLINE_SPREAD_HINT = 1.0;

/**
 * 等級成因說明(純函式)。輸入:
 *   - is2D:是否為 2D 符號別
 *   - overallScore:總分
 *   - parameters:GradeResult.parameters(1D 時是第 1 條掃描線的)
 *   - scanlineScores:各掃描線的總分陣列(1D 才有;沒有就傳空陣列或省略)
 *   - scanlineLimiters:各掃描線各自的限制項代號陣列(1D 才有,與上面同長)
 * 輸出:{ rule, limiting, spread, spreadHint, lines }
 *   - limiting:[{ code, name, why, letter, score, count }],已依「成為限制項的次數」排序
 *   - spread:逐條總分的最大最小差(級);掃描線少於 2 條時為 null
 *   - lines:掃描線條數
 * 呼叫端只負責顯示,不得自行推導成因。
 */
export function explainGrade(input) {
  const o = input || {};
  const params = Array.isArray(o.parameters) ? o.parameters : [];
  const scores = Array.isArray(o.scanlineScores) ? o.scanlineScores.filter(
    (v) => typeof v === "number" && Number.isFinite(v)) : [];
  const limiters = Array.isArray(o.scanlineLimiters) ? o.scanlineLimiters : [];
  const byCode = new Map(params.map((p) => [p.code, p]));

  let limiting = [];
  if (o.is2D) {
    // 2D:總分就是最小值,取所有等於最小值的參數(可能不只一項)
    let lo = Infinity;
    for (const p of params) if (p.score < lo) lo = p.score;
    limiting = params.filter((p) => Number.isFinite(lo) && p.score === lo)
      .map((p) => ({ code: p.code, letter: p.letter, score: p.score, count: 1 }));
  } else if (limiters.length) {
    // 1D:統計「成為該條限制項」的次數。次數多的排前面,同次數時分數低的排前面。
    const n = new Map();
    for (const c of limiters) if (c) n.set(c, (n.get(c) || 0) + 1);
    limiting = [...n.entries()]
      .map(([code, count]) => {
        const p = byCode.get(code);
        return { code, count, letter: p ? p.letter : "", score: p ? p.score : null };
      })
      .sort((a, b) => (b.count - a.count) || ((a.score ?? 9) - (b.score ?? 9)));
  } else {
    // 沒有逐條資料就退化成「第 1 條的最差項」,並由呼叫端據 lines 判斷該怎麼講
    let lo = Infinity;
    for (const p of params) if (p.score < lo) lo = p.score;
    limiting = params.filter((p) => Number.isFinite(lo) && p.score === lo)
      .map((p) => ({ code: p.code, letter: p.letter, score: p.score, count: 1 }));
  }

  limiting = limiting.map((x) => ({
    ...x,
    name: (PARAM_CAUSE[x.code] || {}).name || x.code,
    why: (PARAM_CAUSE[x.code] || {}).why || "",
  }));

  const spread = scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : null;
  return {
    rule: o.is2D ? GRADE_RULE.twoD : GRADE_RULE.oneD,
    limiting,
    spread,
    // 離散度大 = 同一個符號在不同掃描線上量到差很多,通常是拍攝條件不穩(手震/反光/傾斜),
    // 不是印刷不均 —— 措辭要指向「重拍」而不是「這批印壞了」。
    spreadHint: spread !== null && spread > SCANLINE_SPREAD_HINT
      ? "各掃描線之間差異偏大,較可能是拍攝條件不穩(手震、反光或傾斜),建議重拍一次比對" : "",
    lines: scores.length,
  };
}

// ── 取幀候選挑選(規格 §3.9 · 2026-08-06)──────────────────────────────────
// 由來:實機(iPhone 14 Pro)實拍證據 —— 預覽畫面清晰有細節,按下快門後拿到的卻是
// 一張**糊掉且整片偏藍偏暗**的影像。兩個病徵各自獨立:糊 = 對焦沒收斂,
// 偏藍偏暗 = 白平衡與感光增益沒收斂。合起來就是「相機剛換模式、管線重啟後的過渡幀」。
// 也就是說 `applyConstraints` 升壓在該機**確實生效**,而我們抓到的正是重啟後那幾幀。
//
// 先前的做法是「多等幾幀讓它收斂」,但幀數是猜的:等太少沒用(1 幀實測不夠),
// 等太多又拉長使用者必須維持不動的時間 —— 而等待本身就是手震窗口。
// **改成不猜**:升壓前先留一張已收斂的預覽幀,升壓後兩張都量,誰通過閘門用誰。
//
// **不引入任何新門檻**:判準就是既有的、已校準的對焦與眩光閘門(policies.ts,§6.1 凍結)。
// 只在「升壓幀沒過、預覽幀過了」這個明確組合下才退回 —— 那是升壓幫了倒忙的鐵證。
// 兩張都過就用升壓幀(解析度較高);兩張都沒過就維持原本流程(交給既有的告警與
// 可量測性分流處理),不在這裡假裝挑得出好的。

/** 取幀候選的代號。 */
export const FRAME_CHOICE = Object.freeze({
  CAPTURED: "captured",  // 原本那條路取到的(L1 照片 / L2 升壓幀)
  PREVIEW: "preview",    // 升壓前留下的預覽幀(已收斂)
});

/** 退回預覽幀時要記進報告的理由。呈現端照這張表顯示,不另外造詞。 */
export const FRAME_FALLBACK_REASON = Object.freeze({
  focus: "取到的影像對焦不如升壓前的預覽,已改用預覽幀",
  glare: "取到的影像眩光高於升壓前的預覽,已改用預覽幀",
});

/**
 * 挑選要拿去分析的那一張(純函式)。輸入:
 *   - capturedFocusOk / previewFocusOk:兩張各自的**對焦**閘門結果(布林,拿不到傳 null)
 *   - capturedGlareOk / previewGlareOk:兩張各自的**眩光**閘門結果
 * 輸出:{ use, reason }
 *   - use 為 FRAME_CHOICE.PREVIEW 時呼叫端應改用預覽幀,並把 reason 記進取幀資訊。
 *   - 判斷刻意只看「沒過 / 過了」而不比分數:分數受來源尺度影響(高解析來源縮到同尺度時
 *     抗鋸齒平均更重,高頻能量被多吃掉),比分數會產生偽陽性;閘門的絕對門檻沒有這個問題。
 */
export function chooseCaptureFrame(input) {
  const o = input || {};
  const keep = { use: FRAME_CHOICE.CAPTURED, reason: "" };
  // 對焦優先於眩光:對焦垮掉時量到的根本不是符號的邊界
  if (o.capturedFocusOk === false && o.previewFocusOk === true) {
    return { use: FRAME_CHOICE.PREVIEW, reason: FRAME_FALLBACK_REASON.focus };
  }
  if (o.capturedGlareOk === false && o.previewGlareOk === true) {
    return { use: FRAME_CHOICE.PREVIEW, reason: FRAME_FALLBACK_REASON.glare };
  }
  return keep;
}

// ── 1D 條帶縱向範圍偵測(規格 §3.10 · 2026-08-06)──────────────────────────
// 由來:實機回報「取樣框為什麼會一直變?導致量測失敗」。
//
// 病灶:1D 解碼時 ZXing 只回傳**兩個點** —— 它成功解碼的那一條掃描線的左右兩端,
// 兩點的 y 幾乎相同。於是「定位點 bbox 外擴 25%」算出來的高度趨近於零,
// 程式只好用 `Math.max(24, ~0)` 硬撐成一條約 48px 的細帶。
// 那條帶:
//   ① **與條的實際高度完全無關** —— 它只是一個常數;
//   ② **每拍一次就換位置** —— ZXing 每次掃到的是不同的影像列;
//   ③ 飄到條的下緣就會掃到人眼可讀字,十條掃描線全數作廢 → 量測失敗。
//
// 解法:不猜也不靠定位點,**直接從影像量出條有多高**。
// 條碼所在的那些列有一個共同特徵:沿水平方向的明暗轉換次數很多且彼此接近;
// 一旦離開條的上下緣(進入靜區、人眼可讀字或背景),轉換次數會明顯掉下來。
// 以定位線那一列為基準往上下走,掉到基準的一定比例以下就停 —— 那就是條的邊界。
//
// 為什麼容許範圍寬一點也沒關係:roi1DMetrology 會逐條掃描線驗證元素數,
// 對不上的那條直接作廢。**多含幾列雜訊只是少幾條可用掃描線,少含則是全滅。**
// 所以這個偵測寧可略為保守地多含一點,也不要切太緊。

/** 條帶偵測的參數。ratio 是「相對基準列轉換次數」的保留比例,不是品質門檻。 */
export const BAR_BAND = Object.freeze({
  keepRatio: 0.5,   // 轉換次數掉到基準的一半以下就視為離開條區
  minRows: 8,       // 少於這麼多列就當偵測失敗(取樣不足以支撐十條掃描線)
  padRows: 2,       // 上下各留幾列餘裕,避免正好切在邊界上
});

/**
 * 數某一列的明暗轉換次數。輸入:灰階、寬、列索引、水平範圍、門檻;輸出:轉換次數。
 * 用「狀態轉換」而非乘積變號 —— 取樣值正好等於門檻時後者會漏數(同 subpixelEdges 的教訓)。
 */
function rowTransitions(gray, w, y, x0, x1, t) {
  let n = 0, prev = null;
  for (let x = x0; x < x1; x++) {
    const dark = gray[y * w + x] < t;
    if (prev !== null && dark !== prev) n++;
    prev = dark;
  }
  return n;
}

/**
 * 量出 1D 條帶的縱向範圍(純函式)。輸入:
 *   - gray / w / h:灰階影像
 *   - y:基準列(ZXing 定位線所在的影像列)
 *   - x0 / x1:水平掃描範圍(通常是定位點的左右端)
 * 輸出:{ y0, y1, rows, refTransitions } 或 null(基準列本身就不像條碼、或列數不足)。
 * y1 為**開區間**(與 ROI 的慣例一致)。
 */
export function barBandExtent(gray, w, h, y, x0, x1) {
  if (!gray || !(w > 0) || !(h > 0)) return null;
  const ax0 = Math.max(0, Math.min(w - 1, Math.floor(x0)));
  const ax1 = Math.max(ax0 + 1, Math.min(w, Math.ceil(x1)));
  const ay = Math.max(0, Math.min(h - 1, Math.round(y)));
  if (ax1 - ax0 < 8) return null;

  // 門檻取整張影像的 Otsu:逐列各自求門檻會讓近乎單色的列(靜區、背景)算出無意義的
  // 門檻並數出一堆假轉換,反而把邊界往外推。
  const t = otsu(gray);
  const ref = rowTransitions(gray, w, ay, ax0, ax1, t);
  // 基準列本身轉換次數太少 → 那條線根本不在條碼上,不要硬給範圍
  if (ref < 4) return null;
  const floor = ref * BAR_BAND.keepRatio;

  let up = ay;
  while (up - 1 >= 0 && rowTransitions(gray, w, up - 1, ax0, ax1, t) >= floor) up--;
  let dn = ay;
  while (dn + 1 < h && rowTransitions(gray, w, dn + 1, ax0, ax1, t) >= floor) dn++;

  const y0 = Math.max(0, up - BAR_BAND.padRows);
  const y1 = Math.min(h, dn + 1 + BAR_BAND.padRows);
  const rows = y1 - y0;
  if (rows < BAR_BAND.minRows) return null;
  return { y0, y1, rows, refTransitions: ref };
}

// ── 本張閘門的三態敘述(稽核 A-01,規格 spec20260914-a10a01-v1 §2.2)────────
// 由來:舊寫法只列非 OK 項,全綠就寫死「全部 OK」,於是「真的量過且通過」與
//   「因為承接放行假值而恆綠」在報告上完全無法區分。最強的一支是解析度 ——
//   state.gate.pxm 的唯一寫入點在 1D 的 if (g1.modulePx) 內,2D 從不寫入,讀到的
//   永遠是 resetPreviewGeometry() 的硬寫值 9 ⇒ 9 >= 8 ⇒ 解析度每一張都 OK。
//   同一份 PDF 上一行誠實地不印 px/module,下一行卻隱含斷言解析度通過。
//   「未量測」必須是**第三態**,在字面上讀得出來,不得被計入 OK 也不得講成非 OK。
/**
 * 把一組閘門檢查結果整理成單行的三態敘述(純函式)。輸入:
 *   - checks:gate.report.checks 形狀的陣列,元素為 { key, status },
 *             status ∈ {"OK","WARN","FAIL"}。
 *   - measured:{ [key]: boolean },某項在這張照片上是否真的量過。
 *             **鍵不存在視為已量測** —— 日後 gate.ts 新增檢查項時會落入 OK / 非 OK
 *             兩態,而不是被靜默算成「未量測」而從報告上消失。
 *   - labels:{ [key]: string } 檢查項的中文標籤(呼叫端傳 CHECK_LABEL;
 *             純函式不自帶 UI 字典,才測得起來也才不會兩地各寫一份而漂移)。
 * 輸出:單行字串,供結果頁與 PDF 直接顯示,例如
 *   「未過 對焦 FAIL、眩光 WARN · 未量測 解析度、透視 · 已量測通過 3 項」。
 * 邏輯:排除 scaleRef(沿用現況,比例尺卡不納入本張閘門敘述)→ 依
 *   未量測 / 非 OK / OK 分三組 → 以「非 OK、未量測、OK」的順序輸出,
 *   組間以 · 串接、組內以 、串接。全數已量測且 OK 時輸出「已量測通過 N 項」,
 *   **永不輸出「全部 OK」字樣**;全部未量測時只輸出未量測那一段,不得回傳空字串。
 */
export function summarizeShotGate(input) {
  const o = input || {};
  const list = Array.isArray(o.checks) ? o.checks : [];
  const measured = o.measured || {};
  const labels = o.labels || {};
  const nameOf = (key) => labels[key] || key;

  const bad = [], unmeasured = [];
  let okCount = 0;
  for (const c of list) {
    if (!c || c.key === "scaleRef") continue;          // scaleRef 沿用現況:不納入敘述
    if (measured[c.key] === false) { unmeasured.push(nameOf(c.key)); continue; }
    if (c.status !== "OK") bad.push(`${nameOf(c.key)} ${c.status}`);
    else okCount++;
  }

  const parts = [];
  if (bad.length) parts.push("未過 " + bad.join("、"));
  if (unmeasured.length) parts.push("未量測 " + unmeasured.join("、"));
  // okCount 為 0 時不輸出「已量測通過 0 項」—— 那一句只會讓人以為量過卻全掛
  if (okCount > 0) parts.push(`已量測通過 ${okCount} 項`);
  // 理論上不會走到(checks 為空):寧可輸出保守字樣,也不要回傳空字串讓報告該欄憑空消失
  return parts.length ? parts.join(" · ") : "未量測";
}
