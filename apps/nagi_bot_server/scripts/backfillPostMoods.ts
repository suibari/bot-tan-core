/**
 * 投稿ごとの気分（日記の感情グラフ）を、未採点がなくなるまで採点する。
 *
 * 常駐の NagiPostMoodWorker も同じ採点を少しずつ進めるので、このスクリプトは
 * 「導入直後に早く埋めたい」「採点基準の版を上げた直後」に使う。ワーカーと同時に動かしても
 * 結果は同じ（投稿ごとの upsert）だが、Ollama への同時リクエストが2本になる。
 *
 *   pnpm --filter nagi-bot-server mood:backfill
 * 1人だけ:
 *   pnpm --filter nagi-bot-server mood:backfill did:plc:...
 */
import { runPostMoodBatch } from "../src/NagiPostMoodWorker.js";

const onlyDid = process.argv[2];
if (onlyDid && !/^did:(plc|web):/.test(onlyDid)) {
  console.error(`invalid DID: ${onlyDid}`);
  process.exit(1);
}

const BATCH = 50;
let total = 0;
const started = Date.now();
for (;;) {
  const scored = await runPostMoodBatch(BATCH, onlyDid);
  total += scored;
  if (scored < BATCH) break;
  const minutes = (Date.now() - started) / 60_000;
  console.log(`scored ${total} posts (${(total / minutes).toFixed(0)}/min)`);
}
console.log(`done: ${total} posts scored`);
process.exit(0);
