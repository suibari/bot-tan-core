import { LabelerServer } from "@skyware/labeler";
import fastify, { type FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { timingSafeEqual } from "crypto";
import { AMATERAS_LABEL_VALUES, CONFIG } from "./config.js";
import { ContentEvaluator } from "./moderation/evaluator.js";

const NAGI_POST_URI =
  /^at:\/\/did:(?:plc|web):[^/]+\/com\.suibari\.nagi\.post\/[^/\s]+$/;

function validInternalToken(authorization: string | undefined): boolean {
  const expected = CONFIG.internalToken;
  const actual = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function validLabels(labels: unknown): labels is string[] {
  return (
    Array.isArray(labels) &&
    labels.length > 0 &&
    labels.length <= AMATERAS_LABEL_VALUES.size &&
    labels.every(
      (label) => typeof label === "string" && AMATERAS_LABEL_VALUES.has(label),
    )
  );
}

export function isPermanentModerationInputError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 400 || status === 413 || status === 422;
}

export class AmaterasLabeler {
  public server: LabelerServer;
  public internalApi: FastifyInstance;
  private evaluator?: ContentEvaluator;

  constructor() {
    if (!CONFIG.did) {
      throw new Error("LABELER_DID is required in environment variables.");
    }
    if (!CONFIG.signingKey && process.env.NODE_ENV !== "test")
      throw new Error(
        "AMATERAS_SIGNING_KEY is required in environment variables.",
      );
    if (!CONFIG.internalToken && process.env.NODE_ENV !== "test")
      throw new Error(
        "AMATERAS_INTERNAL_TOKEN is required in environment variables.",
      );
    if (!CONFIG.openaiApiKey && process.env.NODE_ENV !== "test")
      throw new Error("OPENAI_API_KEY is required in environment variables.");

    // データディレクトリの作成
    const dbDir = path.dirname(path.resolve(CONFIG.dbPath));
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // テストだけは実在しない固定鍵を使う。本番では上のguardにより必ず起動失敗する。
    const dummyKey =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    this.server = new LabelerServer({
      did: CONFIG.did,
      signingKey: CONFIG.signingKey || dummyKey,
      dbPath: CONFIG.dbPath,
    });

    this.internalApi = fastify({ logger: false });
    if (CONFIG.openaiApiKey)
      this.evaluator = new ContentEvaluator(CONFIG.openaiApiKey);
    this.setupInternalRoutes();
  }

  /**
   * ポスト（Post）へのラベル付与
   */
  async labelPost(uri: string, labels: string[], cid?: string) {
    if (!labels || labels.length === 0) return;
    if (!validLabels(labels))
      throw new Error("Evaluator produced unsupported labels.");
    console.log(
      `🏷️  [LABEL] Adding labels [${labels.join(", ")}] to post: ${uri}`,
    );
    try {
      for (const val of labels) {
        await this.server.createLabel({ uri, cid, val });
      }
    } catch (err) {
      console.error(`Failed to label post ${uri}:`, err);
      throw err;
    }
  }

  /**
   * AppView連携用の内部APIルートを設定する。
   */
  private setupInternalRoutes() {
    this.internalApi.get("/health", async () => ({
      status: "ok",
      service: "nagi_amateras",
      did: CONFIG.did,
    }));

    this.internalApi.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/api/")) return;
      if (process.env.NODE_ENV === "test" && !CONFIG.internalToken) return;
      if (!validInternalToken(req.headers.authorization))
        return reply.status(401).send({ error: "Unauthorized" });
    });

    this.internalApi.post<{
      Body: { uri: string; cid: string; did: string; record: any };
    }>("/api/evaluate", async (req, reply) => {
      const { uri, cid, did, record } = req.body ?? ({} as any);
      if (
        !NAGI_POST_URI.test(uri ?? "") ||
        typeof cid !== "string" ||
        cid.length === 0 ||
        typeof did !== "string" ||
        !uri.startsWith(`at://${did}/`) ||
        record?.$type !== "com.suibari.nagi.post" ||
        typeof record.text !== "string"
      ) {
        return reply
          .status(400)
          .send({ error: "Invalid Nagi post evaluation request." });
      }
      if (!this.evaluator)
        return reply
          .status(503)
          .send({ error: "Moderation evaluator is not configured." });

      const imageUrls = Array.isArray(record.embed?.images)
        ? record.embed.images.flatMap((image: any) => {
            const blobCid = image?.image?.ref?.$link;
            return typeof blobCid === "string"
              ? [
                  `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${blobCid}@jpeg`,
                ]
              : [];
          })
        : [];
      let decision;
      try {
        const output = await this.evaluator.evaluatePost({
          uri,
          text: record.text,
          imageUrls,
        });
        decision = output.evaluation;
      } catch (error) {
        // 存在しないblobなど、同じ入力を再送しても直らない4xxは保存拒否として確定する。
        // 5xx・429・認証/ネットワーク障害は投げ直し、AppView側の直列キューでfail closedにする。
        if (!isPermanentModerationInputError(error)) throw error;
        decision = {
          action: "drop" as const,
          labels: ["!hide"],
          reasons: ["[DROP] moderation input was permanently rejected"],
          maxScore: 1,
          highestCategory: "invalid-input",
        };
      }
      const { action, labels, reasons, maxScore, highestCategory } = decision;
      if ((action === "label" || action === "drop") && labels.length)
        await this.labelPost(uri, labels, cid);
      return { action, labels, reasons, maxScore, highestCategory };
    });
  }

  /**
   * サーバー起動
   */
  async start(
    port: number = CONFIG.port,
    internalPort: number = CONFIG.internalPort,
  ) {
    this.server.start(port, (err) => {
      if (err) {
        console.error("❌ Failed to start LabelerServer:", err);
      } else {
        console.log(
          `🌟 [nagi_amateras] Labeler XRPC server listening on port ${port} (DID: ${CONFIG.did})`,
        );
      }
    });

    await this.internalApi.listen({
      port: internalPort,
      host: CONFIG.internalHost,
    });
    console.log(
      `🔗 [nagi_amateras] Internal Control API listening on port ${internalPort}`,
    );
  }
}
