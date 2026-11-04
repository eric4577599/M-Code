#!/usr/bin/env node
// 誤判率計算腳本。用法:
//   npm run build && node scripts/ng-rate.mjs <mcode-log.jsonl> [--min-samples N]
//     [--false-alarm A,M] [--miss A,M] [--false-ng-share A,M]      (A=可接受上限, M=臨界上限, 0~1)
// 輸入是設定頁「複製記錄」得到的 JSONL。只量測,不改任何門檻。
import { readFileSync } from "node:fs";
import { computeNgRate, parseShotJsonl } from "../dist/index.js";

const args = process.argv.slice(2);
const flagsWithValue = new Set(["--min-samples", "--false-alarm", "--miss", "--false-ng-share"]);
let file;
for (let i = 0; i < args.length; i++) {
  if (flagsWithValue.has(args[i])) { i++; continue; }
  if (!args[i].startsWith("--")) { file = args[i]; break; }
}
if (!file) {
  console.error("用法:node scripts/ng-rate.mjs <log.jsonl> [--min-samples N] [--false-alarm A,M] [--miss A,M] [--false-ng-share A,M]");
  process.exit(2);
}
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const band = (s) => { if (s === undefined) return undefined; const [a, m] = s.split(",").map(Number); return { acceptable: a, marginal: m }; };
const params = {};
if (opt("--min-samples") !== undefined) params.minSamples = Number(opt("--min-samples"));
for (const [flag, key] of [["--false-alarm", "falseAlarm"], ["--miss", "miss"], ["--false-ng-share", "falseNgShare"]]) {
  const b = band(opt(flag)); if (b) params[key] = b;
}
const { shots, badLines } = parseShotJsonl(readFileSync(file, "utf8"));
const r = computeNgRate(shots, params);
const pct = (m) => (m.rate === null ? "—" : (m.rate * 100).toFixed(1) + "%");
const tag = { NOT_MEASURED: "尚未量測", ACCEPTABLE: "可接受", MARGINAL: "臨界", UNACCEPTABLE: "不可接受" };
const c = r.confusion;
console.log(`拍照紀錄 ${shots.length} 筆(壞行 ${badLines});有標註且可判定 ${c.tp + c.fp + c.fn + c.tn};未標註 ${c.unlabeled};無法判定 ${c.unjudged}`);
console.log(`混淆矩陣:抓到不良 ${c.tp}|誤殺良品 ${c.fp}|漏判不良 ${c.fn}|判對良品 ${c.tn}`);
console.log(`NG 中良品占比 ${pct(r.falseNgShare)} (${c.fp}/${r.falseNgShare.denominator}) → ${tag[r.falseNgShare.verdict]}`);
console.log(`良品被判 NG(誤警率) ${pct(r.falseAlarm)} (${c.fp}/${r.falseAlarm.denominator}) → ${tag[r.falseAlarm.verdict]}`);
console.log(`不良被判 OK(漏判率) ${pct(r.miss)} (${c.fn}/${r.miss.denominator}) → ${tag[r.miss.verdict]}`);
console.log(`參數:每項分母至少 ${r.params.minSamples} 筆;判準見 src/export/ngrate.ts 預設值註記(AIAG 級距憑記憶引用,未讀原文)`);
