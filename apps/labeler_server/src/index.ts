import { LabelerServer } from "@skyware/labeler";
import dotenv from "dotenv";
import { AtpAgent, RichText } from "@atproto/api";
import { assertExternalAccountAccessAllowed } from "@bsky-affirmative-bot/shared-configs/externalAccountAccess";

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load workspace root .env file relative to this script
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
assertExternalAccountAccessAllowed("Labeler", "ALLOW_DEV_LABELER_WRITES", {
  NODE_ENV: process.env.NODE_ENV,
  ALLOW_DEV_LABELER_WRITES: process.env.ALLOW_DEV_LABELER_WRITES,
});

const PORT = Number(process.env.LABELER_SERVER_PORT || 3400);
// 空文字で受けて下の guard に集約する。undefined のままだと、下の guard で narrowing しても
// getAgent のクロージャ内までは型が持ち越されない。
const DID: string = process.env.LABELER_DID ?? "";
const SIGNING_KEY: string = process.env.LABELER_SIGNING_KEY ?? "";

if (!DID || !SIGNING_KEY) {
  console.error("[CRITICAL] LABELER_DID and LABELER_SIGNING_KEY must be provided in .env.");
  process.exit(1);
}

const labeler = new LabelerServer({
  did: DID,
  signingKey: SIGNING_KEY,
  dbPath: process.env.LABELER_DB_PATH || "./labels.db",
});
import fastify, { type FastifyRequest, type FastifyReply } from "fastify";

// Initialize AtpAgent for label definition updates
const agent = new AtpAgent({ service: "https://bsky.social" });
let loggedIn = false;

async function getAgent() {
  if (!loggedIn) {
    // 識別子は起動時に検証済みの LABELER_DID を使い回す。ハンドルは可変なので識別子には使わない。
    const password = process.env.LABELER_PASSWORD;
    if (!password) {
      throw new Error("Missing LABELER_PASSWORD in env");
    }
    await agent.login({ identifier: DID, password });
    loggedIn = true;
  }
  return agent;
}

// Queue system (Mutex) for serialized Read-Modify-Write updates
let updateQueue = Promise.resolve();

async function enqueueUpdate<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    updateQueue = updateQueue.then(async () => {
      try {
        const res = await fn();
        resolve(res);
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Create internal Fastify app for private label write operations
const internalApp = fastify();

internalApp.post("/upsert-definition", async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      identifier?: string;
      locales?: Array<{ lang: string; name: string; description: string }>;
    } | null;

    if (!body || !body.identifier || !body.locales) {
      reply.status(400).send({ error: "Missing identifier or locales in request body" });
      return;
    }

    const { identifier, locales } = body;
    console.log(`[INFO][INTERNAL] Upserting label definition: ${identifier}`);

    await enqueueUpdate(async () => {
      const activeAgent = await getAgent();
      const repo = activeAgent.session!.did;

      let retries = 5;
      while (retries > 0) {
        try {
          // 1. Get current record
          let currentRecord: any = {
            $type: "app.bsky.labeler.service",
            policies: {
              labelValues: [],
              labelValueDefinitions: []
            },
            createdAt: new Date().toISOString()
          };
          let cid: string | undefined;

          try {
            const res = await activeAgent.api.com.atproto.repo.getRecord({
              repo,
              collection: "app.bsky.labeler.service",
              rkey: "self"
            });
            currentRecord = res.data.value;
            cid = res.data.cid;
          } catch (e: any) {
            if (e.status !== 404 && !e.message?.includes("Could not locate record")) {
              throw e;
            }
            // 404 (or not found) is okay, we will initialize a new record
          }

          // 2. Modify definitions
          const definitions = currentRecord.policies?.labelValueDefinitions || [];
          const index = definitions.findIndex((d: any) => d.identifier === identifier);

          const fullDef = {
            identifier,
            severity: "inform",
            blurs: "none",
            defaultSetting: "warn",
            locales
          };

          if (index >= 0) {
            definitions[index] = fullDef;
          } else {
            definitions.push(fullDef);
          }

          const labelValues = definitions.map((d: any) => d.identifier);

          const updatedRecord = {
            $type: "app.bsky.labeler.service",
            policies: {
              labelValues,
              labelValueDefinitions: definitions
            },
            createdAt: new Date().toISOString()
          };

          // 3. Put record with optimistic lock (swapRecord)
          const putParams: any = {
            repo,
            collection: "app.bsky.labeler.service",
            rkey: "self",
            record: updatedRecord
          };
          if (cid) {
            putParams.swapRecord = cid;
          }

          await activeAgent.api.com.atproto.repo.putRecord(putParams);
          console.log(`[INFO][INTERNAL] Successfully upserted label definition: ${identifier}`);
          return;
        } catch (err: any) {
          if (err.name === 'InvalidSwap' || err.message?.includes('swap')) {
            console.warn(`[WARN][INTERNAL] OCC conflict while upserting label ${identifier}, retrying...`);
            retries--;
            await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
            continue;
          }
          throw err;
        }
      }
      throw new Error("Failed to upsert label definition due to persistent race conditions.");
    });

    reply.send({ success: true });
  } catch (error: any) {
    console.error("[ERROR][INTERNAL] Failed to upsert label definition:", error);
    reply.status(500).send({ error: error.message || "Internal Server Error" });
  }
});

internalApp.post("/label", async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = request.body as {
      did?: string;
      val?: string;
      negate?: boolean;
      exp?: string;
    } | null;

    if (!body || !body.did || !body.val) {
      reply.status(400).send({ error: "Missing did or val in request body" });
      return;
    }

    const { did, val, negate, exp } = body;
    console.log(`[INFO][INTERNAL] Received label request: did=${did}, val=${val}, negate=${!!negate}, exp=${exp}`);

    // Create the label via @skyware/labeler (negating previous label if negate=true)
    const result = await labeler.createLabel({
      uri: did,
      val: val,
      neg: negate,
      exp: exp,
    });

    // Post notification using the labeler account on successful creation
    if (!negate) {
      (async () => {
        try {
          console.log(`[INFO][LABEL_POST] Preparing to post notification for label "${val}" applied to ${did}`);
          const activeAgent = await getAgent();

          // 1. Resolve target profile to get their handle
          const { data: profile } = await activeAgent.getProfile({ actor: did });
          const userHandle = profile.handle;

          // 2. Fetch current labeler record to find the label definition details (name, description)
          let labelName = val;
          let labelDesc = "";
          try {
            const repo = activeAgent.session!.did;
            const res = await activeAgent.api.com.atproto.repo.getRecord({
              repo,
              collection: "app.bsky.labeler.service",
              rkey: "self"
            });
            const currentRecord = res.data.value as any;
            const definitions = currentRecord?.policies?.labelValueDefinitions || [];
            const definition = definitions.find((d: any) => d.identifier === val);
            if (definition && definition.locales) {
              const locale = definition.locales.find((l: any) => l.lang === "ja") || definition.locales[0];
              if (locale) {
                labelName = locale.name;
                labelDesc = locale.description || "";
              }
            }
          } catch (e: any) {
            console.warn(`[WARN][LABEL_POST] Failed to fetch label definition for "${val}":`, e.message);
          }

          // 3. Compose post text (concise English one-liner without @ prefix to prevent mention notifications)
          const text = `🏷️ Labeled "${labelName}" to ${userHandle} #BottanLabeler #botたんラベラー`;

          // 4. Handle RichText facets detection (mentions, hashtags, etc.)
          const rt = new RichText({ text });
          await rt.detectFacets(activeAgent);

          // Add a link facet for the user handle to make it clickable without triggering mention notifications
          const utf8Text = Buffer.from(text);
          const handleIndex = utf8Text.indexOf(userHandle);
          if (handleIndex !== -1) {
            const byteStart = handleIndex;
            const byteEnd = handleIndex + Buffer.from(userHandle).length;

            // Remove any overlapping facets automatically detected by detectFacets
            // (e.g. if the handle is a custom domain like chuuni.moe, detectFacets will treat it as a website link)
            if (rt.facets) {
              rt.facets = rt.facets.filter(facet => {
                const fStart = facet.index.byteStart;
                const fEnd = facet.index.byteEnd;
                const overlaps = (fStart < byteEnd && fEnd > byteStart);
                return !overlaps;
              });
            } else {
              rt.facets = [];
            }

            rt.facets.push({
              index: { byteStart, byteEnd },
              features: [
                {
                  $type: "app.bsky.richtext.facet#link",
                  uri: `https://bsky.app/profile/${userHandle}`
                }
              ]
            });
          }

          const record = {
            $type: "app.bsky.feed.post",
            text: rt.text,
            facets: rt.facets,
            createdAt: new Date().toISOString(),
          };

          // 5. Post to Bluesky if in production, otherwise log to console
          if (process.env.NODE_ENV === "production") {
            const response = await activeAgent.post(record as any);
            console.log(`[INFO][LABEL_POST] Successfully posted notification post: uri=${response.uri}`);
          } else {
            console.log(`[DEBUG][LABEL_POST] (Development mode - not posted)\n${record.text}`);
          }
        } catch (postErr: any) {
          console.error("[ERROR][LABEL_POST] Failed to post label notification:", postErr.message || postErr);
        }
      })();
    }

    reply.send({ success: true, label: result });
  } catch (error: any) {
    console.error("[ERROR][INTERNAL] Failed to process label request:", error);
    reply.status(500).send({ error: error.message || "Internal Server Error" });
  }
});

internalApp.get("/active-dids", async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const query = request.query as { val?: string } | null;
    const val = query?.val;

    if (!val) {
      reply.status(400).send({ error: "Missing val in query parameters" });
      return;
    }

    console.log(`[INFO][INTERNAL] Fetching active DIDs for label value: ${val}`);

    // Query SQLite directly using labeler.db
    const sql = `
      SELECT uri FROM labels
      WHERE id IN (
        SELECT MAX(id) FROM labels WHERE val = ? GROUP BY uri
      ) AND neg = 0
    `;
    const result = await labeler.db.execute({ sql, args: [val] });
    const dids = result.rows.map((row: any) => row.uri);

    reply.send({ success: true, dids });
  } catch (error: any) {
    console.error("[ERROR][INTERNAL] Failed to fetch active DIDs:", error);
    reply.status(500).send({ error: error.message || "Internal Server Error" });
  }
});

// Start the public XRPC server (binds to standard port, e.g. 3400)
labeler.start(PORT, (error: Error | null, address: string) => {
  if (error) {
    console.error("[CRITICAL] Public Labeler Server failed to start:", error);
    process.exit(1);
  }
  console.log(`Public Labeler Server (XRPC) running on address: ${address}`);
});

// Start the internal API server on 127.0.0.1 (localhost) only (binds to port 3401)
const INTERNAL_PORT = Number(process.env.LABELER_INTERNAL_PORT || 3401);
internalApp.listen({ port: INTERNAL_PORT, host: "127.0.0.1" }, (error: Error | null, address: string) => {
  if (error) {
    console.error("[CRITICAL] Internal API Server failed to start:", error);
    process.exit(1);
  }
  console.log(`Internal Write API Server running on address: ${address} (Localhost Only)`);
});
