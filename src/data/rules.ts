// Seed diagnosis rules — faithful transcription of spec §C8 JSON.
// Loaded directly by the diagnosis engine; evaluated after grading.
import type { DiagnosisRule } from "../domain/types.js";

export const SEED_DIAGNOSIS_RULES: DiagnosisRule[] = [
  {
    id: "BWR_GAIN",
    appliesTo: ["ITF14", "GS1_128", "CODE128"],
    when: [
      { metric: "MOD.score", op: "<", value: 2.5 },
      { metric: "barWidthGainMm", op: ">", value: 0.04 },
    ],
    cause: "柔印墨量過多 / 版壓過大（BWR 補償不足）",
    remedy: "加大製版 BWR、降墨量、查版壓與膠輥",
    severity: 3,
  },
  {
    id: "WASHBOARD",
    appliesTo: ["ITF14", "GS1_128", "QR", "DATAMATRIX"],
    substrateCategories: ["DIRECT_COARSE"],
    when: [{ metric: "washboard.amplitudeRatio", op: ">", value: 0.12 }],
    cause: "楞痕 / washboard（粗楞透印）",
    remedy: "高階訂單改細楞 E/F 或表貼；調印壓",
    severity: 2,
  },
  {
    id: "LOW_CONTRAST",
    appliesTo: ["ITF14", "GS1_128", "QR"],
    when: [{ metric: "SC.score", op: "<", value: 2.0 }],
    cause: "牛皮基材吃光 / 墨色不足",
    remedy: "提高墨色濃度，或改面紙 / 加塗布",
    severity: 2,
  },
  {
    id: "QR_REGISTRATION",
    appliesTo: ["QR", "DATAMATRIX"],
    when: [{ metric: "GNU.score", op: "<", value: 2.5 }],
    cause: "套印不準 / 基材伸縮",
    remedy: "查版位、走紙張力、套印對位",
    severity: 2,
  },
  {
    id: "DEFECTS",
    appliesTo: ["ITF14", "GS1_128", "CODE128"],
    when: [{ metric: "DEF.score", op: "<", value: 2.5 }],
    cause: "柔版針孔 / 楞峰刮白 / 印頭元件失效",
    remedy: "查版 / 印頭、楞峰處理",
    severity: 2,
  },
  {
    id: "QUIET_ZONE",
    appliesTo: ["ITF14", "GS1_128", "CODE128"],
    when: [{ metric: "quietZoneX", op: "<", value: 10 }],
    cause: "落版排版空白區不足",
    remedy: "調整落版，留足 Quiet Zone",
    severity: 1,
  },
  {
    id: "NO_DECODE",
    appliesTo: ["ITF14", "GS1_128", "QR", "DATAMATRIX"],
    when: [{ metric: "decoded", op: "==", value: 0 }],
    cause: "不可讀（綜合崩壞）",
    remedy: "立即停線檢查版 / 墨 / 楞型",
    severity: 3,
  },
];
