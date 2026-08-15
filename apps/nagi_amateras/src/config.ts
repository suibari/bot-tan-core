import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env を読み込み（アプリ直下およびモノレポルート）
dotenv.config({ path: path.resolve(__dirname, "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export interface LabelDefinitionConfig {
  identifier: string;
  severity: "inform" | "alert" | "none";
  blurs: "content" | "media" | "none";
  defaultSetting: "ignore" | "warn" | "hide";
  adultOnly?: boolean;
  locales: Array<{
    lang: string;
    name: string;
    description: string;
  }>;
}

export const CONFIG = {
  port: Number(process.env.AMATERAS_SERVER_PORT || 3500),
  internalPort: Number(process.env.AMATERAS_INTERNAL_PORT || 3501),
  internalHost: "127.0.0.1",
  internalToken: process.env.AMATERAS_INTERNAL_TOKEN || "",
  did: process.env.AMATERAS_DID || "did:plc:gvlryvidmd4yju24sdqi5rao",
  signingKey: process.env.AMATERAS_SIGNING_KEY || "",
  password: process.env.AMATERAS_PASSWORD || "",
  dbPath: process.env.AMATERAS_DB_PATH || "./data/amateras-labels.db",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  databaseUrl: process.env.DATABASE_URL || process.env.POSTGRES_URL || "",
  jetstreamUrl:
    process.env.JETSTREAM_URL ||
    "wss://jetstream2.us-east.bsky.network/subscribe",
};

export const AMATERAS_LABEL_VALUES = new Set([
  "sexual",
  "nudity",
  "graphic-media",
  "hate",
  "harassment",
  "!warn",
  "!hide",
]);

/**
 * nagi_amateras が提供する標準ラベル定義一覧
 */
export const LABEL_DEFINITIONS: LabelDefinitionConfig[] = [
  {
    identifier: "sexual",
    severity: "alert",
    blurs: "media",
    defaultSetting: "warn",
    adultOnly: true,
    locales: [
      {
        lang: "ja",
        name: "性的コンテンツ",
        description: "成人向けまたは性的な表現が含まれるコンテンツです。",
      },
      {
        lang: "en",
        name: "Sexually Explicit",
        description: "Contains sexually explicit or adult content.",
      },
    ],
  },
  {
    identifier: "nudity",
    severity: "alert",
    blurs: "media",
    defaultSetting: "warn",
    locales: [
      {
        lang: "ja",
        name: "露出度が高い画像",
        description: "露出度の高い画像・非性的なヌードが含まれます。",
      },
      {
        lang: "en",
        name: "Nudity",
        description: "Contains non-sexual nudity or exposed body parts.",
      },
    ],
  },
  {
    identifier: "graphic-media",
    severity: "alert",
    blurs: "media",
    defaultSetting: "warn",
    locales: [
      {
        lang: "ja",
        name: "暴力的・グロテスク",
        description: "流血、暴力、事故などショッキングな表現が含まれます。",
      },
      {
        lang: "en",
        name: "Graphic Media",
        description: "Contains violence, blood, gore, or shocking scenes.",
      },
    ],
  },
  {
    identifier: "hate",
    severity: "alert",
    blurs: "content",
    defaultSetting: "warn",
    locales: [
      {
        lang: "ja",
        name: "ヘイトスピーチ",
        description: "特定の属性や個人に対する差別・ヘイトスピーチです。",
      },
      {
        lang: "en",
        name: "Hate Speech",
        description:
          "Contains hate speech, discrimination, or severe harassment.",
      },
    ],
  },
  {
    identifier: "harassment",
    severity: "alert",
    blurs: "content",
    defaultSetting: "warn",
    locales: [
      {
        lang: "ja",
        name: "ハラスメント・誹謗中傷",
        description: "特定の個人に対する執拗な攻撃や嫌がらせです。",
      },
      {
        lang: "en",
        name: "Harassment",
        description: "Contains harassment, targeted attacks, or bullying.",
      },
    ],
  },
];
