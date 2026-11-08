/**
 * アドベントカレンダーの選出を、DB に書かずに25日分シミュレーションする。
 *
 *   ADVENT_SIM_DATABASE_URL=postgres://... \
 *   pnpm advent:simulate -- [--days=25] [--newcomer-days=30] [--out=path.md]
 *
 * - 接続は default_transaction_read_only=on で開く（本番DBへ向けても書き込めない）。
 * - advent_cards テーブルは使わない。選出履歴（使ったポスト・選ばれた人）はメモリで持つ。
 * - 対象ポストの上限は「いま」。12月より前に試すので、「12月に始めた人」は
 *   「直近 N 日に始めた人」で代用する。
 * - LLM は本番と同じ経路（AI_TEXT_PROVIDER 未設定なら Ollama の Gemma）。
 */
import { writeFileSync } from "node:fs";

const arg = (name: string, fallback: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const source = process.env.ADVENT_SIM_DATABASE_URL;
if (!source) throw new Error("ADVENT_SIM_DATABASE_URL is required");
const url = new URL(source);
url.searchParams.set("default_transaction_read_only", "on");
process.env.DATABASE_URL = url.toString();

const days = Number(arg("days", "25"));
const newcomerDays = Number(arg("newcomer-days", "30"));
const out = arg("out", "");
const now = new Date();
const newcomerSince = now.getTime() - newcomerDays * 24 * 60 * 60_000;

const { client } = await import("@bsky-affirmative-bot/database");
const { chooseAdventCard } = await import("../src/NagiAdventFeature.js");
type BatchLog = import("../src/NagiAdventFeature.js").AdventBatchLog;

const [{ readonly }] = await client`select current_setting('default_transaction_read_only') as readonly`;
if (readonly !== "on") throw new Error("connection is not read-only");

const history = {
  usedUris: new Set<string>(),
  pickedDids: new Set<string>(),
  rejectedUris: new Set<string>(),
  isNewcomer: (joinedAt: Date) => joinedAt.getTime() >= newcomerSince,
};
const flat = (text: string, limit = 120) => {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
};

const lines: string[] = [
  `# アドカレ選出シミュレーション（${now.toISOString()}）`,
  "",
  `- 対象: ${days}日分、ポストの上限は実行時点、新規扱いは直近${newcomerDays}日に始めた人`,
  "",
];
const summary: string[] = ["| 日 | 名前 | 新規 | 再選 | 見出し | botたんの一言 | 試行 |", "|---|---|---|---|---|---|---|"];

for (let day = 1; day <= days; day += 1) {
  const batches: BatchLog[] = [];
  const started = Date.now();
  const chosen = await chooseAdventCard(2026, day, {
    history,
    until: now,
    onBatch: (log) => batches.push(log),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  lines.push(`## 12月${day}日`);
  if (!chosen) {
    lines.push("", "**選べませんでした**（候補切れ、またはモデルが全部を不採用）", "");
    summary.push(`| ${day} | — | | | **選出なし** | | ${batches.length} |`);
    console.log(`day ${day}: none (${batches.length} batches, ${seconds}s)`);
    continue;
  }
  const again = history.pickedDids.has(chosen.post.did);
  const newcomer = batches.at(-1)?.candidates.find((c) => c.did === chosen.post.did)?.newcomer;
  history.usedUris.add(chosen.post.uri);
  history.pickedDids.add(chosen.post.did);
  const name = chosen.profile.displayName || chosen.profile.handle;
  lines.push(
    "",
    `- **${name}**（@${chosen.profile.handle}）${newcomer ? " 🆕新規" : ""}${again ? " 🔁再選" : ""}`,
    `- 見出し: **${chosen.result.titleJa}** / ${chosen.result.titleEn}`,
    `- 一言(en): ${chosen.result.commentEn}`,
    `- 一言: ${chosen.result.commentJa}`,
    `- 元ポスト（気分 ${chosen.post.valence}）: ${flat(chosen.post.text, 200)}`,
    `- ${chosen.post.uri}`,
    `- 試行 ${batches.length} 回 / ${seconds}秒`,
    "",
  );
  for (const [index, batch] of batches.entries()) {
    lines.push(
      `<details><summary>試行${index + 1}（足切り ${batch.minValence} / 候補 ${batch.candidates.length} 件 / 選択 ${batch.pick || (batch.rejectedAll ? "なし（回ごと不採用）" : "なし（文面が書けず）")}）</summary>`,
      "",
      ...batch.candidates.map(
        (c, i) =>
          `${i + 1}. ${i + 1 === batch.pick ? "✅ " : ""}${c.name}${c.newcomer ? "🆕" : ""}${c.picked ? "🔁" : ""}（${c.valence}）${flat(c.text)}`,
      ),
      "",
      "</details>",
      "",
    );
  }
  summary.push(
    `| ${day} | ${name} | ${newcomer ? "🆕" : ""} | ${again ? "🔁" : ""} | ${chosen.result.titleJa} | ${flat(chosen.result.commentJa, 60)} | ${batches.length} |`,
  );
  console.log(`day ${day}: ${name} — ${chosen.result.titleJa} (${batches.length} batches, ${seconds}s)`);
}

lines.splice(3, 0, `- 回ごと不採用で除外したポスト: ${history.rejectedUris.size} 件`);
const report = [...lines.slice(0, 5), "## 一覧", "", ...summary, "", ...lines.slice(5)].join("\n");
if (out) writeFileSync(out, report);
else console.log(report);
await client.end();
