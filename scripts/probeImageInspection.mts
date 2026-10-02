/**
 * 絵の出口検査（inspectImage.ts）を、botたんが実際に投稿した絵へまとめて流す。
 *
 * 検査の設問を変えたら必ず流し直すこと。最初の設問は単体テストでは何も問題が無かったのに、
 * 本番の16枚では全部を不合格にした（クレヨン画風の手を毎回「溶けた手」と読んだ）。
 * 合否は目視と突き合わせる。`--save` で画像を out/ へ保存しておくと見比べやすい。
 *
 * 使い方:
 *   pnpm imagegen:inspect-probe                 # 直近16枚
 *   pnpm imagegen:inspect-probe -- --limit=40 --save
 *
 * 【前提】OLLAMA_BASE_URL / OLLAMA_MODEL が .env にあること。PDS は公開APIで読むので認証不要。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { inspectGeneratedImage } from "../packages/bot_brain/src/ai/inspectImage.js";

function argValue(name: string): string | undefined {
  return process.argv
    .filter((arg) => arg.startsWith(`--${name}=`))
    .map((arg) => arg.slice(name.length + 3))
    .at(-1);
}

const BOT_DID = process.env.BSKY_DID ?? "did:plc:qcwhrvzx6wmi5hz775uyi6fh";
const COLLECTIONS = ["com.suibari.nagi.post", "app.bsky.feed.post"];
const limit = Number(argValue("limit") ?? 16);
const save = process.argv.includes("--save");
const outDir = path.resolve("out/image-inspection");

async function pdsEndpoint(did: string): Promise<string> {
  const doc = (await (await fetch(`https://plc.directory/${did}`)).json()) as any;
  return doc.service.find((s: any) => s.id === "#atproto_pds").serviceEndpoint;
}

type Target = { uri: string; cid: string; mimeType: string; createdAt: string };

async function recentImages(pds: string): Promise<Target[]> {
  const targets: Target[] = [];
  for (const collection of COLLECTIONS) {
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const url = `${pds}/xrpc/com.atproto.repo.listRecords?repo=${BOT_DID}&collection=${collection}&limit=100` +
        (cursor ? `&cursor=${cursor}` : "");
      const data = (await (await fetch(url)).json()) as any;
      for (const record of data.records ?? []) {
        const embed = record.value?.embed?.media ?? record.value?.embed;
        for (const image of embed?.images ?? []) {
          const cid = image?.image?.ref?.$link;
          if (cid) targets.push({ uri: record.uri, cid, mimeType: image.image.mimeType, createdAt: record.value.createdAt });
        }
      }
      cursor = data.cursor;
      if (!cursor || targets.length >= limit * 2) break;
    }
  }
  return targets.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

const pds = await pdsEndpoint(BOT_DID);
const targets = await recentImages(pds);
if (save) await mkdir(outDir, { recursive: true });

let failed = 0;
for (const [index, target] of targets.entries()) {
  const response = await fetch(`${pds}/xrpc/com.atproto.sync.getBlob?did=${BOT_DID}&cid=${target.cid}`);
  const data = Buffer.from(await response.arrayBuffer());
  const name = `${String(index).padStart(2, "0")}-${target.uri.split("/").at(-1)}.jpg`;
  if (save) await writeFile(path.join(outDir, name), data);
  const started = Date.now();
  const result = await inspectGeneratedImage({ data, mimeType: target.mimeType, width: 0, height: 0 });
  if (!result.ok) failed++;
  console.log(
    `${name}\t${result.ok ? "PASS" : `FAIL ${result.reasons.join(" / ")}`}\t${Date.now() - started}ms\t${target.uri}`,
  );
}
console.log(`\n${failed}/${targets.length} を不合格にした。`);
// bot-brain の観測処理が DB 接続を握ったままになるので明示的に抜ける。
process.exit(0);
