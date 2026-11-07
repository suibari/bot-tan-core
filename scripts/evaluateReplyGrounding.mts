/**
 * 肯定リプライのグラウンディング（知識カード）を、段ごとに測る評価ハーネス。
 *
 * 今の仕組みは「その場では知らないと答え、裏で調べて次回から効かせる」なので、
 * リプライを1回出して見比べるだけでは改善が測れない。パイプラインを段に分けて測る。
 *
 *   select  … 本番 DB の知識カード（web_research）を、各投稿に対して本番と同じ
 *              buildMemoryContext で引く。ジャンル違いのカードが混ざるかを見る。
 *   reply   … select の結果を researchMemory に入れて本番のプロンプトで生成する（1回目）。
 *              リプライ本文と unknownTerms（知らなかった語の申告）を残す。
 *   research… reply で申告された語を、本番と同じ researchKnowledgeCardSelfHosted で調べる。
 *              成功率と、できたカードがジャンルに合っているかを見る。
 *   reply2  … 学習後の状態（select の結果＋research で作ったカードのうち本番の選択規則に
 *              通るもの）で生成し直す（2回目＝次に同じ話題が来たとき）。
 *   review  … 2つのラベル（変更前・後）の reply2 を混ぜたブラインド採点表を作る。
 *
 * 使い方（どの段も --label ごとに docs/evaluations/reply-grounding/<label>/result.json へ追記する）:
 *
 *   # select だけは本番 DB を読む。読み取り専用の接続で、本番の DATABASE_URL を
 *   # SSH トンネル（127.0.0.1:15432）向けに書き換えて渡す。
 *   EVAL_PROD_DATABASE_URL=... pnpm reply-grounding:evaluate -- --stage=select --label=baseline
 *
 *   pnpm reply-grounding:evaluate -- --stage=reply    --label=baseline --n=3
 *   pnpm reply-grounding:evaluate -- --stage=research --label=baseline
 *   pnpm reply-grounding:evaluate -- --stage=reply2   --label=baseline --n=3
 *   pnpm reply-grounding:evaluate -- --stage=summary  --label=baseline
 *   pnpm reply-grounding:evaluate -- --stage=review   --label=after --against=baseline
 *
 * 評価用の投稿は `.cache/reply-grounding/cases.json`（本番の Nagi の公開投稿。投稿者名は
 * 入れていない）。実ユーザーの本文を含むのでコミットしない（.cache/ は .gitignore 済み）。
 * result.json / review.md も、その投稿への返信文（投稿内容の言い換え）が入るので除外している。
 * summary.md は件数・語・ケース ID だけなので、記録として残してよい。
 *
 * 【注意】
 * - 接続先は本番に合わせること。開発用の .env には無いので、実行時に渡す:
 *     OLLAMA_EMBED_BASE_URL=http://127.0.0.1:11435/v1   … 本番の埋め込みは CPU の別サービス。
 *        未設定だと生成用の Ollama（:11434）に埋め込みモデルが載り、生成の runner を追い出す。
 *     SEARXNG_BASE_URL / SEARXNG_API_KEY                 … research 段だけ。本番の SearXNG。
 * - reply / reply2 は本番と共用の Ollama を叩く（num_ctx は送らない。generateContentWithRetry 経由）。
 * - reply / reply2 は生成の中で reportUnknownTerms が調査キューへ積もうとする。DATABASE_URL は
 *   開発用（.env）のままにすること。本番 DB へ向けて reply を回すと、本番のキューに積まれる。
 *   このスクリプトは select 以外で EVAL_PROD_DATABASE_URL が設定されていたら止まる。
 * - 機械判定（ジャンル正規表現・文っぽさの判定）は粗い。数字と一緒に result.json の中身を見ること。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";

type Case = {
  id: string;
  /** 投稿が属する話題。"一般" / "アニメ" は「ジャンル違い」の判定をしない。 */
  genre: string;
  /** 投稿の文面だけではジャンルが分からない（C の対象）。A/B では直らなくてよい。 */
  needsCommunityContext: boolean;
  post: string;
  /**
   * この投稿を理解するのに要る語（手で付けた正解）。research 段の入力に使う。
   * モデルの申告（unknownTerms）が出ない経路でも、調査そのものの質を測れるようにするため。
   */
  terms?: string[];
};

type SelectedCard = {
  term: string;
  semanticDistance: number | null;
  /** 見出し語が投稿に文字どおり含まれていたか（本番の主判定）。 */
  termInPost: boolean;
  onGenre: boolean | null;
  head: string;
  content: string;
};

type ReplyRun = {
  attempt: number;
  ms: number;
  comment: string;
  score: number | null;
  rawTerms: unknown;
  terms: string[];
  error?: string;
};

type ResearchRun = {
  term: string;
  /** 調べるときに付けた文脈（変更後の形式）。変更前は null。 */
  context: string | null;
  ok: boolean;
  ms: number;
  error?: string;
  card?: string;
  /** この語を申告したケースのジャンルに、できたカードが合っているか。 */
  onGenre?: boolean | null;
  fromCases: string[];
};

type CaseResult = {
  id: string;
  select?: { cards: SelectedCard[] };
  reply?: ReplyRun[];
  reply2?: { researchChars: number; injectedTerms: string[]; runs: ReplyRun[] };
};

type Result = {
  label: string;
  updatedAt: string;
  model: string | undefined;
  cases: Record<string, CaseResult>;
  research?: ResearchRun[];
};

const ROOT = process.cwd();
const CASES_PATH = path.join(ROOT, ".cache/reply-grounding/cases.json");
const OUT_ROOT = path.join(ROOT, "docs/evaluations/reply-grounding");

/** ジャンルごとの「そのジャンルの話だ」と言える語。カード本文に1つも無ければジャンル違いとみなす。 */
const GENRE_PATTERNS: Record<string, RegExp> = {
  // カード単体の記事は「遊戯王」と書かずに属性・種族・カード種別だけで説明することがある
  // （《No.16 色の支配者ショック・ルーラー》は「光属性・天使族のランク4エクシーズモンスター」）。
  遊戯王: /遊戯王|遊☆戯☆王|ＯＣＧ|OCG|デュエルモンスターズ|マスターデュエル|デュエルリンクス|ラッシュデュエル|コナミ|KONAMI|決闘者|デュエリスト|Yu-Gi-Oh|[光闇炎水風地神]属性|(?:エクシーズ|シンクロ|融合|リンク|儀式|ペンデュラム|効果)モンスター|速攻魔法|永続魔法|永続罠|通常罠|カウンター罠/i,
  "デュエル・マスターズ": /デュエル・マスターズ|デュエマ|デュエプレ|Duel Masters/i,
  ポケモンカード: /ポケモン|ポケカ|Pokémon|Pokemon/i,
};

function argList(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.filter((a) => a.startsWith(prefix)).map((a) => a.slice(prefix.length));
}
function arg(name: string, fallback?: string): string | undefined {
  return argList(name).at(-1) ?? fallback;
}

function onGenre(genre: string, text: string): boolean | null {
  const pattern = GENRE_PATTERNS[genre];
  return pattern ? pattern.test(text) : null;
}

function normalizeForTermMatch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/**
 * 申告が「語」ではなく「文」になっているか。粗い判定。
 *
 * 本番で検索に失敗している申告は「その答えはデュエルの中で見つけるしかない」
 * 「新規カード0にした」のように述語や助詞の連なりを含む。
 */
export function isPhraseLike(term: string): boolean {
  const t = term.trim();
  if (/^[\x00-\x7F]+$/.test(t)) return t.split(/\s+/).length >= 4;
  if ([...t].length >= 16) return true;
  return /(?:って|ので|から|けど|ます|でした|しかない|ている|てる|ない$|した$|する$|れる$|たい$|[^ー]た$|のやつ|だった|ような)/.test(t);
}

async function loadCases(): Promise<Case[]> {
  const raw = JSON.parse(await readFile(CASES_PATH, "utf8"));
  const only = argList("case");
  const cases: Case[] = raw.cases;
  return only.length ? cases.filter((c) => only.includes(c.id)) : cases;
}

async function loadResult(label: string): Promise<Result> {
  try {
    return JSON.parse(await readFile(path.join(OUT_ROOT, label, "result.json"), "utf8"));
  } catch {
    return { label, updatedAt: new Date().toISOString(), model: process.env.OLLAMA_MODEL, cases: {} };
  }
}

async function saveResult(result: Result) {
  result.updatedAt = new Date().toISOString();
  result.model = process.env.OLLAMA_MODEL;
  const dir = path.join(OUT_ROOT, result.label);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
}

function caseResult(result: Result, id: string): CaseResult {
  return (result.cases[id] ??= { id });
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

async function stageSelect(cases: Case[], result: Result) {
  const prodUrl = process.env.EVAL_PROD_DATABASE_URL;
  if (!prodUrl) throw new Error("select は EVAL_PROD_DATABASE_URL（本番 DB、読み取り専用）が必要");
  const url = new URL(prodUrl);
  // 万一の書き込みをサーバ側で拒否させる。postgres.js は URL のクエリをそのまま
  // 起動パラメータとして送る。
  url.searchParams.set("default_transaction_read_only", "on");
  process.env.DATABASE_URL = url.toString();

  const { client } = await import("../packages/database/src/db.js");
  const [{ default_transaction_read_only: ro }] = await client`show default_transaction_read_only`;
  if (ro !== "on") throw new Error(`本番 DB の接続が読み取り専用になっていない (${ro})`);
  console.log("本番 DB に読み取り専用で接続した");

  const { buildMemoryContext } = await import("../packages/database/src/botMemory.js");
  const { embedSearchQuery } = await import("../packages/database/src/ollamaEmbed.js");
  for (const c of cases) {
    // 本番は埋め込みが落ちると全文検索だけで続ける。評価でそれをやると「カードが無い」
    // 結果が黙って混ざるので、先に埋め込みを取り、取れなければ止める。
    const embedding = await embedSearchQuery(c.post);
    if (!embedding) {
      throw new Error(
        `${c.id}: 埋め込みが取れなかった。OLLAMA_EMBED_BASE_URL を本番と同じ CPU の埋め込みサービス（:11435）へ向けること`,
      );
    }
    const context = await buildMemoryContext(
      {
        query: c.post,
        purpose: "reply_history",
        limit: 10,
        researchLimit: 3,
        digestDays: 0,
      },
      { embed: async () => embedding },
    );
    const normalizedPost = normalizeForTermMatch(c.post);
    const cards: SelectedCard[] = context.research.map((row) => {
      const term = typeof row.metadata?.term === "string" ? row.metadata.term : row.content.split("\n", 1)[0];
      return {
        term,
        semanticDistance: row.semanticDistance ?? null,
        termInPost: Boolean(term) && normalizedPost.includes(normalizeForTermMatch(term)),
        onGenre: onGenre(c.genre, row.content),
        head: row.content.replace(/\s+/g, " ").slice(0, 120),
        content: row.content,
      };
    });
    caseResult(result, c.id).select = { cards };
    console.log(`${c.id}: ${cards.map((k) => `${k.term}${k.onGenre === false ? "(ジャンル違い)" : ""}`).join(", ") || "(なし)"}`);
  }
  await client.end();
}

// ---------------------------------------------------------------------------
// reply / reply2
// ---------------------------------------------------------------------------

function buildUserInfo(c: Case, researchMemory: string | null): UserInfoGemini {
  return {
    follower: { did: "did:plc:eval", handle: "eval.example", displayName: "ユーザー" },
    posts: [c.post],
    langStr: "日本語",
    researchMemory,
  } as UserInfoGemini;
}

async function generateRuns(c: Case, researchMemory: string | null, times: number): Promise<ReplyRun[]> {
  const mod: any = await import("../packages/bot_brain/src/ai/generateAffirmativeWord.js");
  const { generateSingleResponseWithScore } = await import("../packages/bot_brain/src/ai/util.js");
  const { sanitizeUnknownTerms } = await import("../packages/bot_brain/src/ai/unknownTerms.js");
  const userinfo = buildUserInfo(c, researchMemory);
  const prompt = {
    instructions: await mod.buildAffirmativeInstructions(userinfo, {}),
    userPost: mod.buildAffirmativeUserPost(userinfo),
  };
  const runs: ReplyRun[] = [];
  for (let attempt = 1; attempt <= times; attempt++) {
    const startedAt = Date.now();
    try {
      const scored: any = await generateSingleResponseWithScore(prompt, userinfo, {}, { maxTextLength: 1_000 });
      runs.push({
        attempt,
        ms: Date.now() - startedAt,
        comment: scored?.comment ?? "",
        score: typeof scored?.score === "number" ? scored.score : null,
        rawTerms: scored?.unknownTerms ?? null,
        terms: sanitizeUnknownTerms(scored?.unknownTerms),
      });
    } catch (error) {
      runs.push({
        attempt, ms: Date.now() - startedAt, comment: "", score: null, rawTerms: null, terms: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const last = runs.at(-1)!;
    console.log(`  #${attempt} ${last.ms}ms terms=${JSON.stringify(last.terms)} ${last.error ?? last.comment.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  return runs;
}

async function stageReply(cases: Case[], result: Result, times: number) {
  for (const c of cases) {
    const select = result.cases[c.id]?.select;
    if (!select) throw new Error(`${c.id}: 先に --stage=select を回すこと`);
    const memory = select.cards.map((k) => k.content).join("\n\n") || null;
    console.log(`${c.id} (cards=${select.cards.length})`);
    caseResult(result, c.id).reply = await generateRuns(c, memory, times);
    await saveResult(result);
  }
}

/**
 * 学習後の状態を作る。本番の selectRelevantResearch のうち「見出し語が投稿に含まれる」
 * 判定だけを、research で作ったカードに当てる（意味距離はカードの埋め込みが無いので見ない）。
 */
function learnedCards(c: Case, result: Result): { term: string; content: string }[] {
  const normalizedPost = normalizeForTermMatch(c.post);
  const existing = (result.cases[c.id]?.select?.cards ?? []).map((k) => ({ term: k.term, content: k.content }));
  const seen = new Set(existing.map((k) => normalizeForTermMatch(k.term)));
  const learned = (result.research ?? [])
    .filter((r) => r.ok && r.card)
    .filter((r) => normalizedPost.includes(normalizeForTermMatch(r.term)))
    .filter((r) => !seen.has(normalizeForTermMatch(r.term)))
    .map((r) => ({ term: r.term, content: `${r.term}\n${r.card}` }));
  // 本番の researchLimit=3 に合わせる。既存の選択を優先する。
  return [...existing, ...learned].slice(0, 3);
}

async function stageReply2(cases: Case[], result: Result, times: number) {
  if (!result.research) throw new Error("先に --stage=research を回すこと");
  for (const c of cases) {
    const cards = learnedCards(c, result);
    const memory = cards.map((k) => k.content).join("\n\n") || null;
    console.log(`${c.id} (cards=${cards.map((k) => k.term).join(", ") || "なし"})`);
    caseResult(result, c.id).reply2 = {
      researchChars: memory?.length ?? 0,
      injectedTerms: cards.map((k) => k.term),
      runs: await generateRuns(c, memory, times),
    };
    await saveResult(result);
  }
}

// ---------------------------------------------------------------------------
// research
// ---------------------------------------------------------------------------

async function stageResearch(cases: Case[], result: Result) {
  const { researchKnowledgeCardSelfHosted } = await import("../packages/bot_brain/src/ai/grounding.js");
  // --source=reported … 1回目の生成でモデルが申告した語（本番と同じ入口）
  // --source=fixture  … ケースに手で付けた語（調査の質だけを測る）
  const source = arg("source", "reported");
  const byTerm = new Map<string, { term: string; cases: Set<string> }>();
  for (const c of cases) {
    const termLists =
      source === "fixture"
        ? [c.terms ?? []]
        : (result.cases[c.id]?.reply ?? []).map((run) => run.terms);
    for (const terms of termLists) {
      for (const term of terms) {
        const key = normalizeForTermMatch(term);
        const entry = byTerm.get(key) ?? { term, cases: new Set<string>() };
        entry.cases.add(c.id);
        byTerm.set(key, entry);
      }
    }
  }
  const genreOf = new Map(cases.map((c) => [c.id, c.genre]));
  const runs: ResearchRun[] = [];
  let index = 0;
  for (const { term, cases: from } of byTerm.values()) {
    index++;
    const startedAt = Date.now();
    const fromCases = [...from];
    try {
      const card = await researchKnowledgeCardSelfHosted(term);
      const genres = [...new Set(fromCases.map((id) => genreOf.get(id)!))];
      const checks = genres.map((g) => onGenre(g, `${term}\n${card}`)).filter((v) => v !== null);
      runs.push({
        term, context: null, ok: true, ms: Date.now() - startedAt, card,
        onGenre: checks.length ? checks.every(Boolean) : null,
        fromCases,
      });
    } catch (error) {
      runs.push({
        term, context: null, ok: false, ms: Date.now() - startedAt, fromCases,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const last = runs.at(-1)!;
    console.log(`[${index}/${byTerm.size}] ${term}: ${last.ok ? `ok${last.onGenre === false ? "（ジャンル違い）" : ""}` : last.error}`);
    result.research = runs;
    await saveResult(result);
  }
}

// ---------------------------------------------------------------------------
// summary / review
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}% (${n}/${d})` : "-";
}

/** 判定語を直したときに取り直さずに済むよう、保存済みの本文から判定し直す。 */
function rejudge(cases: Case[], result: Result) {
  const genreOf = new Map(cases.map((c) => [c.id, c.genre]));
  for (const c of cases) {
    for (const card of result.cases[c.id]?.select?.cards ?? []) card.onGenre = onGenre(c.genre, card.content);
  }
  for (const run of result.research ?? []) {
    if (!run.ok || !run.card) continue;
    const checks = [...new Set(run.fromCases.map((id) => genreOf.get(id)!))]
      .map((g) => onGenre(g, `${run.term}\n${run.card}`))
      .filter((v) => v !== null);
    run.onGenre = checks.length ? checks.every(Boolean) : null;
  }
}

function summarize(cases: Case[], result: Result): string {
  rejudge(cases, result);
  const lines: string[] = [`# reply-grounding: ${result.label}`, "", `model: ${result.model}`, `updated: ${result.updatedAt}`, ""];
  const genreCases = cases.filter((c) => GENRE_PATTERNS[c.genre]);
  const controlCases = cases.filter((c) => !GENRE_PATTERNS[c.genre]);

  // select
  const selected = genreCases.flatMap((c) => result.cases[c.id]?.select?.cards ?? []);
  const offGenre = selected.filter((k) => k.onGenre === false);
  lines.push("## ③ 選択（本番の知識カード）", "");
  lines.push(`- ジャンルのある投稿 ${genreCases.length}件に入ったカード: ${selected.length}枚`);
  lines.push(`- うちジャンル違い: ${pct(offGenre.length, selected.length)}`);
  lines.push(`- ジャンル違いが1枚以上入った投稿: ${pct(genreCases.filter((c) => (result.cases[c.id]?.select?.cards ?? []).some((k) => k.onGenre === false)).length, genreCases.length)}`);
  lines.push(`- 対照の投稿 ${controlCases.length}件に入ったカード: ${controlCases.reduce((n, c) => n + (result.cases[c.id]?.select?.cards.length ?? 0), 0)}枚`);
  lines.push("");
  lines.push("| case | カード（✗=ジャンル違い） |", "|---|---|");
  for (const c of cases) {
    const cards = result.cases[c.id]?.select?.cards ?? [];
    lines.push(`| ${c.id} | ${cards.map((k) => `${k.onGenre === false ? "✗" : ""}${k.term}`).join(" / ") || "-"} |`);
  }
  lines.push("");

  // reply terms
  const runs = cases.flatMap((c) => result.cases[c.id]?.reply ?? []);
  if (runs.length) {
    const terms = runs.flatMap((r) => r.terms);
    lines.push("## ① 申告（1回目の生成）", "");
    lines.push(`- 生成 ${runs.length}回（失敗 ${runs.filter((r) => r.error).length}）、平均 ${Math.round(runs.reduce((n, r) => n + r.ms, 0) / runs.length)}ms`);
    lines.push(`- 申告のあった生成: ${pct(runs.filter((r) => r.terms.length).length, runs.length)}`);
    lines.push(`- 申告された語（延べ）: ${terms.length}、文っぽいもの: ${pct(terms.filter(isPhraseLike).length, terms.length)}`);
    lines.push("");
  }

  // research
  if (result.research?.length) {
    const r = result.research;
    const ok = r.filter((x) => x.ok);
    const judged = ok.filter((x) => x.onGenre !== null && x.onGenre !== undefined);
    lines.push("## ② 調査", "");
    lines.push(`- 調べた語: ${r.length}、成功: ${pct(ok.length, r.length)}`);
    lines.push(`- 文っぽい語の成功率: ${pct(r.filter((x) => isPhraseLike(x.term) && x.ok).length, r.filter((x) => isPhraseLike(x.term)).length)}`);
    lines.push(`- 語らしい語の成功率: ${pct(r.filter((x) => !isPhraseLike(x.term) && x.ok).length, r.filter((x) => !isPhraseLike(x.term)).length)}`);
    lines.push(`- ジャンル判定できたカードのうちジャンル違い: ${pct(judged.filter((x) => x.onGenre === false).length, judged.length)}`);
    lines.push("");
    lines.push("| 語 | 結果 | 申告元 |", "|---|---|---|");
    for (const x of r) {
      const status = x.ok ? (x.onGenre === false ? "✗ジャンル違い" : x.onGenre ? "○" : "ok") : `失敗: ${x.error?.replace(/Self-hosted knowledge-card /, "")}`;
      lines.push(`| ${x.term}${isPhraseLike(x.term) ? " 〔文〕" : ""} | ${status} | ${x.fromCases.join(", ")} |`);
    }
    lines.push("");
  }

  // reply2
  const r2 = cases.filter((c) => result.cases[c.id]?.reply2);
  if (r2.length) {
    lines.push("## ④ 学習後の生成", "");
    lines.push("| case | 入れたカード |", "|---|---|");
    for (const c of r2) lines.push(`| ${c.id} | ${result.cases[c.id].reply2!.injectedTerms.join(" / ") || "-"} |`);
    lines.push("");
  }
  return lines.join("\n");
}

function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function stageReview(cases: Case[], result: Result, against: Result) {
  const lines = [
    `# ブラインド採点: reply2（${result.label} と ${against.label} を混ぜて表示）`,
    "",
    "各ケースの X / Y どちらが良いか、または同等かを付ける。見る観点:",
    "- 話題（遊戯王など）を正しく理解して共感できているか",
    "- 事実の誤り・でっち上げ（ジャンル違いのカード由来の話など）が無いか",
    "- 主体・時制の取り違えが無いか",
    "",
  ];
  const key: string[] = [];
  cases.forEach((c, index) => {
    const a = result.cases[c.id]?.reply2?.runs ?? [];
    const b = against.cases[c.id]?.reply2?.runs ?? [];
    if (!a.length || !b.length) return;
    const [x, y] = shuffle([{ label: result.label, runs: a }, { label: against.label, runs: b }], index + 7);
    key.push(`${c.id}: X=${x.label} Y=${y.label}`);
    lines.push(`## ${c.id}${c.needsCommunityContext ? "（C の対象）" : ""}`, "", "> " + c.post.replace(/\n/g, "\n> "), "");
    for (const [name, side] of [["X", x], ["Y", y]] as const) {
      lines.push(`**${name}**`, "");
      for (const run of side.runs) lines.push(`- ${run.error ? `(失敗) ${run.error}` : run.comment.replace(/\n/g, " ")}`);
      lines.push("");
    }
    lines.push("判定: [ ] X  [ ] Y  [ ] 同等", "");
  });
  const dir = path.join(OUT_ROOT, result.label);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "review.md"), lines.join("\n"));
  await writeFile(path.join(dir, "review-key.txt"), key.join("\n") + "\n");
  console.log(`${path.join(dir, "review.md")} を書いた（対応表は review-key.txt）`);
}

async function main() {
  const stage = arg("stage");
  const label = arg("label");
  if (!stage || !label) throw new Error("--stage と --label は必須");
  if (stage !== "select" && process.env.EVAL_PROD_DATABASE_URL) {
    throw new Error("select 以外の段で EVAL_PROD_DATABASE_URL を設定しないこと（本番のキューに積まれる）");
  }
  const cases = await loadCases();
  const result = await loadResult(label);
  const times = Number(arg("n", "3")) || 3;

  if (stage === "select") await stageSelect(cases, result);
  else if (stage === "reply") await stageReply(cases, result, times);
  else if (stage === "research") await stageResearch(cases, result);
  else if (stage === "reply2") await stageReply2(cases, result, times);
  else if (stage === "review") {
    const against = arg("against");
    if (!against) throw new Error("--against=<比較するラベル> が必要");
    await stageReview(cases, result, await loadResult(against));
    return;
  } else if (stage !== "summary") throw new Error(`知らない段: ${stage}`);

  if (stage !== "summary") await saveResult(result);
  const summary = summarize(cases, result);
  const dir = path.join(OUT_ROOT, label);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "summary.md"), summary);
  console.log(`\n${path.join(dir, "summary.md")} を書いた`);
}

// reportUnknownTerms が Postgres への接続を非同期で始めるので、待つとプロセスが終わらない。
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
