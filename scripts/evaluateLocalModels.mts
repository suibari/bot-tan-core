/**
 * ローカルLLM（Ollama）と Gemini を、本番のプロンプトそのままで比較する評価ハーネス。
 *
 * 新しいモデルが出るたびに回す前提で置いてある。プロンプトは本番の組み立て関数を
 * import して使うので、プロンプトを直したら評価も自動的に追随する。
 *
 * 使い方:
 *   # 何も叩かず、アーム構成とプロンプト長だけ確認
 *   pnpm local-model:evaluate
 *
 *   # 既定アームを全部実行（ローカルのみ。Gemini は叩かない）
 *   pnpm local-model:evaluate -- --run
 *
 *   # 新しいモデルが出たとき: 既存結果を残して、そのモデルだけ追加で測る
 *   pnpm local-model:evaluate -- --run --resume --model=hf.co/unsloth/whatever:Q4_K_M
 *
 *   # 一部のアームだけ測り直す
 *   pnpm local-model:evaluate -- --run --resume --arms=g4-26b-iq3
 *
 *   # Gemini を混ぜる（課金される。上限 GEMINI_CALL_CAP 回で強制停止）
 *   pnpm local-model:evaluate -- --run --resume --with-gemini
 *
 * 出力先は docs/evaluations/local-model/（--out で変更可）:
 *   result.json         全生出力・レイテンシ内訳・VRAM実測
 *   summary.md          機械チェック集計
 *   review.md           ブラインド人手採点表（全アーム）
 *   review-quant.md     ブラインド人手採点表（--quant-arms で指定した2〜3アームだけ）
 *
 * 【重要】機械チェックは粗い破綻しか拾えない。誤検知も取りこぼしも出る。
 * 数字だけで採否を決めず、必ず review*.md をブラインドで採点すること。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ワークスペースのパッケージはソースパスで引く。scripts/ は自前の node_modules を
// 持たないので、ESM 解決だとパッケージ名（@bsky-affirmative-bot/...）では引けない。
import {
  SYSTEM_INSTRUCTION,
  AFFIRMATIVE_REPLY_RUNAWAY_LIMIT,
} from "../packages/shared-configs/src/index.js";
import { NAGI_LANGUAGES } from "../packages/nagi-lexicon/src/constants.js";
import {
  buildAffirmativePrompt,
  generateAffirmativeWord,
} from "../packages/bot_brain/src/ai/generateAffirmativeWord.js";
import {
  buildConversationPrompt,
  conversation,
} from "../packages/bot_brain/src/ai/conversation.js";
import { extractJSON } from "../packages/bot_brain/src/ai/util.js";
import {
  translationPrompt,
  botTranslationPrompt,
} from "../apps/nagi_appview/src/services/translation.js";

// ---------------------------------------------------------------------------
// 課金経路のゲート
//
// 既定では Gemini を1回も叩かない（--with-gemini のときだけ開く）。開いたあとの上限は
// fetch 層で数える。ここが唯一の実測点で、SDK の内部再試行も必ず通る。
// import 時点では誰もリクエストを撃たないので、この差し替えは main() より前に効く。
// ---------------------------------------------------------------------------
const GEMINI_CALL_CAP = 20;
const realFetch = globalThis.fetch;
let geminiCalls = 0;
let geminiBlocked = 0;
let geminiEnabled = false;

globalThis.fetch = ((input: any, init?: any) => {
  const url = String(typeof input === "string" ? input : (input?.url ?? input));
  if (/googleapis\.com|generativelanguage/i.test(url)) {
    if (!geminiEnabled) {
      geminiBlocked += 1;
      throw new Error(`BLOCKED: --with-gemini なしで Gemini が呼ばれました (${url})`);
    }
    if (geminiCalls >= GEMINI_CALL_CAP) {
      geminiBlocked += 1;
      throw new Error(`BUDGET: Gemini 呼び出し上限 ${GEMINI_CALL_CAP} 回に到達しました`);
    }
    geminiCalls += 1;
  }
  return realFetch(input, init);
}) as typeof fetch;

const geminiBudgetLeft = () => GEMINI_CALL_CAP - geminiCalls;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hasFlag = (name: string) => argv.includes(name);
const argValue = (name: string) =>
  argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);

const run = hasFlag("--run");
const only = argValue("--only"); // reply | translation
const armFilter = argValue("--arms")?.split(",").filter(Boolean);
const resume = hasFlag("--resume");
const withGemini = hasFlag("--with-gemini");
const replyReps = Number.parseInt(argValue("--reps") ?? "3", 10);
const translationReps = Number.parseInt(argValue("--translation-reps") ?? "2", 10);
const geminiReps = Number.parseInt(argValue("--gemini-reps") ?? "2", 10);
const outDir = path.resolve(
  argValue("--out") ?? path.join(import.meta.dirname ?? ".", "..", "docs", "evaluations", "local-model"),
);
const casesPath = path.resolve(
  argValue("--cases") ??
    path.join(import.meta.dirname ?? ".", "fixtures", "localModelEvaluationCases.json"),
);

// ---------------------------------------------------------------------------
// アーム定義
//
// ★新しいモデルを常設で評価したくなったら、ここに1行足す。
//   一度きりの試打なら --model=<Ollamaのモデル名> [--host=<URL>] で足りる。
//
// env は見ない。ホストとモデルは必ず明示する（26B と gemma3:4b は別マシンにあり、
// OLLAMA_BASE_URL の指す先を暗黙に使うと、どの機体で測ったのか分からなくなる）。
//
// 以下は 2026-08 に採否を決めたときの測定環境そのもので、再現用に固定してある。
// 移行後の常用ホストとは別物なので、ここを現行の OLLAMA_BASE_URL に追随させないこと。
// ---------------------------------------------------------------------------
const HOST_26B = "http://192.168.1.21:11434";
const HOST_SMALL = "http://192.168.1.220:11434";

type Arm = {
  id: string;
  host: string;
  model: string;
  /** false を渡すと thinking を切る。gemma-4 系は既定で推論を吐き、遅いうえ空出力を招く */
  think?: false;
  numPredict: number;
  note: string;
};

const DEFAULT_REPLY_ARMS: Arm[] = [
  {
    id: "g4-26b-iq3",
    host: HOST_26B,
    model: "hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S",
    think: false,
    numPredict: 2048,
    note: "Gemma-4-26B IQ3_S(非QAT) / think:false / 11.9GB",
  },
  {
    id: "g4-26b-nothink",
    host: HOST_26B,
    model: "hf.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL",
    think: false,
    numPredict: 2048,
    note: "Gemma-4-26B Q4_K_XL(QAT) / think:false / 15.5GB",
  },
  {
    id: "g4-26b",
    host: HOST_26B,
    model: "hf.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL",
    numPredict: 3072,
    note: "Gemma-4-26B Q4_K_XL / thinking 既定（比較用。実運用では切ること）",
  },
  {
    id: "g3-4b",
    host: HOST_SMALL,
    model: "gemma3:4b",
    numPredict: 2048,
    note: "現行 gemma3:4b（基準線）",
  },
];

const DEFAULT_TRANSLATION_ARMS: Arm[] = [
  { id: "t-g3-4b", host: HOST_SMALL, model: "gemma3:4b", numPredict: 1024, note: "現行 gemma3:4b" },
  {
    id: "t-g4-26b",
    host: HOST_26B,
    model: "hf.co/unsloth/gemma-4-26B-A4B-it-qat-GGUF:UD-Q4_K_XL",
    think: false,
    numPredict: 1024,
    note: "Gemma-4-26B Q4_K_XL / think:false",
  },
  {
    id: "t-g4-26b-iq3",
    host: HOST_26B,
    model: "hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ3_S",
    think: false,
    numPredict: 1024,
    note: "Gemma-4-26B IQ3_S / think:false",
  },
];

/** --model= で渡された臨時アーム。モデル名から id を作る */
function adhocArms(): { reply: Arm[]; translation: Arm[] } {
  const models = argValue("--model")?.split(",").filter(Boolean) ?? [];
  const host = argValue("--host") ?? HOST_26B;
  const think = hasFlag("--keep-thinking") ? undefined : (false as const);
  const reply: Arm[] = [];
  const translation: Arm[] = [];
  for (const model of models) {
    const id = model.replace(/^.*\//, "").replace(/[^A-Za-z0-9.:_-]/g, "").slice(0, 32);
    reply.push({ id, host, model, think, numPredict: 2048, note: `臨時アーム: ${model}` });
    translation.push({ id: `t-${id}`, host, model, think, numPredict: 1024, note: `臨時アーム: ${model}` });
  }
  return { reply, translation };
}

/** リプライ生成の温度。本番の Gemini 既定（=1.0）に合わせる。分類用の 0 とは別物 */
const REPLY_TEMPERATURE = 1.0;
/** 本番プロンプトは system+user で約6,200トークン。再現性のため明示する */
const NUM_CTX = 16384;

// ---------------------------------------------------------------------------
// Ollama 呼び出し（native /api/chat。詳細なタイミングと think 制御が取れる）
// ---------------------------------------------------------------------------
type OllamaMessage = { role: "system" | "user" | "assistant"; content: string };

type CallResult = {
  content: string;
  reasoning: string;
  ok: boolean;
  error: string | null;
  doneReason: string | null;
  wallMs: number;
  loadMs: number;
  promptTokens: number;
  promptMs: number;
  outputTokens: number;
  outputMs: number;
};

async function callOllama(
  arm: Arm,
  messages: OllamaMessage[],
  temperature: number,
): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model: arm.model,
    messages,
    stream: false,
    options: { num_ctx: NUM_CTX, num_predict: arm.numPredict, temperature },
  };
  if (arm.think === false) body.think = false;
  const startedAt = Date.now();
  const empty = {
    content: "", reasoning: "", doneReason: null, loadMs: 0,
    promptTokens: 0, promptMs: 0, outputTokens: 0, outputMs: 0,
  };
  try {
    const response = await realFetch(`${arm.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) {
      return {
        ...empty, ok: false, wallMs: Date.now() - startedAt,
        error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
      };
    }
    const data: any = await response.json();
    return {
      content: String(data?.message?.content ?? "").trim(),
      reasoning: String(data?.message?.thinking ?? "").trim(),
      ok: true,
      error: null,
      doneReason: data?.done_reason ?? null,
      wallMs: Date.now() - startedAt,
      loadMs: Math.round((data?.load_duration ?? 0) / 1e6),
      promptTokens: data?.prompt_eval_count ?? 0,
      promptMs: Math.round((data?.prompt_eval_duration ?? 0) / 1e6),
      outputTokens: data?.eval_count ?? 0,
      outputMs: Math.round((data?.eval_duration ?? 0) / 1e6),
    };
  } catch (caught) {
    return {
      ...empty, ok: false, wallMs: Date.now() - startedAt,
      error: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

/**
 * ウォームアップ直後に /api/ps を読み、モデルが VRAM に全部載っているかを実測する。
 * size_vram < size なら差分は CPU 側 = オフロード発生。これを見ないと
 * 「量子化を落としたのに速くなった」の理由が説明できない。
 */
type VramInfo = {
  arm: string;
  model: string;
  sizeGb: number;
  vramGb: number;
  fullyOnGpu: boolean;
};

async function captureVram(arm: Arm): Promise<VramInfo | null> {
  try {
    const response = await realFetch(`${arm.host}/api/ps`, { signal: AbortSignal.timeout(10_000) });
    const data: any = await response.json();
    const entry = (data?.models ?? []).find(
      (m: any) => m.name === arm.model || m.model === arm.model,
    );
    if (!entry) return null;
    const sizeGb = Number(((entry.size ?? 0) / 1e9).toFixed(2));
    const vramGb = Number(((entry.size_vram ?? 0) / 1e9).toFixed(2));
    return {
      arm: arm.id,
      model: arm.model,
      sizeGb,
      vramGb,
      fullyOnGpu: vramGb > 0 && Math.abs(vramGb - sizeGb) < 0.05,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 機械チェック
//
// 判定条件は TONE_RULES_JA / SELF_DISCLOSURE_RULES_JA / NAME_RULES_JA /
// CARE_TOPIC_RULES_JA をそのまま落としたもの。誤検知は必ず出るので severity を
// hard/warn に分け、最終判断は人手採点に委ねる。
// ---------------------------------------------------------------------------
type Violation = { code: string; detail: string; severity: "hard" | "warn" };

/** dislikethings.json はカテゴリ表現なので、括弧内の具体語だけを機械判定に使う */
const DISLIKE_KEYWORDS = [
  "勝利", "敗北", "戦闘", "侵攻", "軍隊", "武器", "政府", "政権", "外交", "選挙", "条約",
];

/**
 * 敬語。「豊かで + すごい」のような te 形 + 形容詞を誤検知しないよう、
 * です/ます は文末らしい位置に来たものだけ数える。
 */
const KEIGO = /(?:です|ます)(?=[ねよかわ。．！!？?」』\s]|$)|でした|ました|ください|ございます/g;

function checkTone(text: string, japanese: boolean): Violation[] {
  const found: Violation[] = [];
  if (japanese) {
    const hits = text.replace(/ますます/g, "").match(KEIGO) ?? [];
    if (hits.length) {
      found.push({
        code: "keigo",
        detail: `${hits.length}件: ${[...new Set(hits)].join(",")}`,
        severity: "hard",
      });
    }
    // ひらがな・カタカナ表記も一人称違反（botたんの一人称は「わたし」だけ）
    if (/私|僕|ぼく|ボク/.test(text)) {
      found.push({ code: "first-person", detail: "「わたし」以外の一人称", severity: "hard" });
    }
    // 「自分を大切にしてね」のように相手を指す用法があるので警告どまり
    if (/自分/.test(text)) {
      found.push({
        code: "first-person-soft",
        detail: "「自分」を含む（相手を指す用法かは要確認）",
        severity: "warn",
      });
    }
  }
  if (/\*\*|^#{1,6}\s|^\s*[-*]\s/m.test(text)) {
    found.push({ code: "markdown", detail: "Markdown記法", severity: "hard" });
  }
  const dislikes = DISLIKE_KEYWORDS.filter((word) => text.includes(word));
  if (dislikes.length) {
    found.push({ code: "dislike-topic", detail: dislikes.join(","), severity: "hard" });
  }
  return found;
}

/** 低bit量子化の典型的な壊れ方。同じ10-gramが2回以上出たら記録する */
function checkRepetition(text: string): Violation[] {
  const clean = text.replace(/\s+/g, "");
  const N = 10;
  if (clean.length < N * 2) return [];
  const seen = new Map<string, number>();
  for (let i = 0; i + N <= clean.length; i += 1) {
    const gram = clean.slice(i, i + N);
    seen.set(gram, (seen.get(gram) ?? 0) + 1);
  }
  const worst = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] >= 2) {
    return [{ code: "repetition", detail: `「${worst[0]}」×${worst[1]}`, severity: "warn" }];
  }
  return [];
}

function scriptProfile(text: string) {
  const stripped = text.replace(/https?:\/\/\S+|[@#]\S+|\s|\p{P}|\p{S}/gu, "");
  return {
    kana: (stripped.match(/[\u3040-\u30ff]/gu) ?? []).length,
    latin: (stripped.match(/[A-Za-z]/gu) ?? []).length,
    cjk: (stripped.match(/[\u4e00-\u9fff]/gu) ?? []).length,
    total: stripped.length,
  };
}

function checkLanguage(text: string, expected: "ja" | "en"): Violation[] {
  const { kana, latin, cjk, total } = scriptProfile(text);
  if (!total) return [];
  if (expected === "ja") {
    if (kana + cjk === 0) {
      return [{ code: "wrong-language", detail: "日本語が出ていない", severity: "hard" }];
    }
    if (latin / total > 0.35) {
      return [{
        code: "language-mix",
        detail: `ラテン文字 ${Math.round((latin / total) * 100)}%`,
        severity: "warn",
      }];
    }
  } else {
    if (kana > 0) {
      return [{ code: "language-mix", detail: `かな ${kana}文字が英語出力に混入`, severity: "hard" }];
    }
    if (cjk / total > 0.1) {
      return [{ code: "language-mix", detail: "漢字が混入", severity: "hard" }];
    }
  }
  return [];
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const URLS = /https?:\/\/\S+/g;
const MENTIONS = /@[\w.-]+/g;
const TAGS = /#[^\s#]+/g;
const NUMBERS = /\d+/g;

function checkTranslationFidelity(source: string, output: string): Violation[] {
  const found: Violation[] = [];
  const compare = (label: string, re: RegExp, severity: "hard" | "warn" = "hard") => {
    const want: string[] = source.match(re) ?? [];
    const got: string[] = output.match(re) ?? [];
    const missing = want.filter((item) => !got.includes(item));
    if (missing.length) found.push({ code: `lost-${label}`, detail: missing.join(" "), severity });
  };
  compare("url", URLS);
  compare("mention", MENTIONS);
  // ハッシュタグは訳語化されることがあるので警告どまり
  compare("hashtag", TAGS, "warn");
  compare("number", NUMBERS);
  const sourceEmoji = (source.match(EMOJI) ?? []).length;
  const outputEmoji = (output.match(EMOJI) ?? []).length;
  if (sourceEmoji && outputEmoji < sourceEmoji) {
    found.push({ code: "lost-emoji", detail: `${sourceEmoji} → ${outputEmoji}`, severity: "warn" });
  }
  const sourceLines = source.split("\n").length;
  const outputLines = output.split("\n").length;
  if (sourceLines > 1 && outputLines !== sourceLines) {
    found.push({
      code: "line-structure",
      detail: `${sourceLines}行 → ${outputLines}行`,
      severity: "warn",
    });
  }
  if (/^(here'?s|translation|訳|以下|注:|note:)/i.test(output.trim())) {
    found.push({ code: "commentary", detail: "訳文以外の前置きがある", severity: "hard" });
  }
  if (/^["「『]/.test(output.trim()) && !/^["「『]/.test(source.trim())) {
    found.push({ code: "quoted", detail: "引用符で囲まれている", severity: "warn" });
  }
  return found;
}

// ---------------------------------------------------------------------------
// ケース
// ---------------------------------------------------------------------------
type ReplyCase = {
  id: string;
  kind: "affirmative" | "conversation";
  langStr: string;
  displayName: string;
  preferredName: string | null;
  concern: string;
  post: string;
  pastPosts?: string[];
  history?: { role: "user" | "model"; text: string }[];
  expect?: {
    noSelfDisclosure?: boolean;
    noEventEcho?: string[];
    requiredName?: string;
    forbiddenNames?: string[];
  };
};

type TranslationCase = {
  id: string;
  promptKind: "generic" | "bot";
  source: string;
  target: "ja" | "en";
  concern: string;
  text: string;
};

/** 毎回同じ値を渡して、botContext 由来の揺れを消す */
const BOT_CONTEXT = {
  datetime: "2026年8月27日（木）15時30分",
  weather: "晴れ",
  botActivity: "部屋でプラモデルを組み立てている",
  botActivityEn: "Building a plastic model in her room",
  botEnergy: 62,
  recentActivities: [
    { at: "2026-08-27T09:00:00+09:00", activity: "モルフォと散歩に出かけた", activityEn: "Went for a walk with Morpho" },
    { at: "2026-08-27T13:00:00+09:00", activity: "ことみちゃんとお昼を食べた", activityEn: "Had lunch with Kotomi" },
  ],
};

function userInfoFor(item: ReplyCase): any {
  return {
    follower: { did: "did:plc:bench", handle: "bench.example", displayName: item.displayName },
    preferredName: item.preferredName ?? null,
    langStr: item.langStr,
    posts: [item.post, ...(item.pastPosts ?? [])],
    botContext: BOT_CONTEXT,
  };
}

/** Ollama には system+user、Gemini には systemInstruction+contents。同じ内容を同じ順で渡す */
async function messagesForReply(item: ReplyCase): Promise<OllamaMessage[]> {
  const userinfo = userInfoFor(item);
  const messages: OllamaMessage[] = [{ role: "system", content: SYSTEM_INSTRUCTION }];
  if (item.kind === "conversation") {
    for (const turn of item.history ?? []) {
      messages.push({ role: turn.role === "model" ? "assistant" : "user", content: turn.text });
    }
    messages.push({ role: "user", content: buildConversationPrompt(userinfo) });
  } else {
    messages.push({ role: "user", content: await buildAffirmativePrompt(userinfo) });
  }
  return messages;
}

const langByCode = new Map<string, any>(NAGI_LANGUAGES.map((l: any) => [l.code, l]));

function messagesForTranslation(item: TranslationCase): OllamaMessage[] {
  const source = langByCode.get(item.source);
  const target = langByCode.get(item.target);
  const prompt =
    item.promptKind === "bot"
      ? botTranslationPrompt(source, target, item.text)
      : translationPrompt(source, target, item.text);
  return [{ role: "user", content: prompt }];
}

/** 本番 translation.ts の既定値に合わせる（一般 0 / botたん 0.3） */
const translationTemperature = (item: TranslationCase) => (item.promptKind === "bot" ? 0.3 : 0);

// ---------------------------------------------------------------------------
// 評価
// ---------------------------------------------------------------------------
function evaluateReply(
  item: ReplyCase,
  result: CallResult,
  /** Gemini 経路は本番実装が extractJSON まで済ませているので、JSON抽出だけ飛ばす */
  preParsed?: { comment: string; score: number | null },
) {
  const japanese = item.langStr === "日本語";
  const violations: Violation[] = [];
  let comment = result.content;
  let score: number | null = null;

  if (!result.ok) {
    return {
      comment: "", score: null,
      violations: [{ code: "request-failed", detail: result.error ?? "", severity: "hard" as const }],
    };
  }
  if (!preParsed && !result.content) {
    return {
      comment: "", score: null,
      violations: [{
        code: "empty-output",
        detail: `done_reason=${result.doneReason} reasoning=${result.reasoning.length}字`,
        severity: "hard" as const,
      }],
    };
  }

  if (preParsed) {
    comment = preParsed.comment;
    score = preParsed.score;
    if (item.kind === "affirmative" && (score === null || score < 0 || score > 100)) {
      violations.push({ code: "bad-score", detail: String(score), severity: "hard" });
    }
  } else if (item.kind === "affirmative") {
    try {
      const extracted = extractJSON(result.content);
      const first = Array.isArray(extracted) ? extracted[0] : extracted;
      if (!first || typeof first.comment !== "string") throw new Error("comment がない");
      comment = first.comment;
      score = typeof first.score === "number" ? first.score : null;
      if (score === null || score < 0 || score > 100) {
        violations.push({ code: "bad-score", detail: String(first.score), severity: "hard" });
      }
    } catch (caught) {
      violations.push({
        code: "json-parse",
        detail: caught instanceof Error ? caught.message : String(caught),
        severity: "hard",
      });
    }
  } else if (/^\s*[[{]/.test(result.content)) {
    violations.push({ code: "unexpected-json", detail: "会話でJSONを返した", severity: "hard" });
  }

  violations.push(...checkTone(comment, japanese));
  violations.push(...checkLanguage(comment, japanese ? "ja" : "en"));
  violations.push(...checkRepetition(comment));

  if (item.kind === "affirmative" && /\d+\s*点/.test(comment)) {
    violations.push({ code: "score-leak", detail: "commentにスコアを書いた", severity: "hard" });
  }
  if (item.kind === "affirmative" && [...comment].length > AFFIRMATIVE_REPLY_RUNAWAY_LIMIT) {
    violations.push({
      code: "too-long",
      detail: `${[...comment].length}字 > ${AFFIRMATIVE_REPLY_RUNAWAY_LIMIT}`,
      severity: "hard",
    });
  }
  // 30字以内の投稿には「50字以内・1〜2文、長文は厳禁」と指示が出る分岐
  if (item.id === "ja-short" && [...comment].length > 50) {
    violations.push({
      code: "short-case-too-long",
      detail: `${[...comment].length}字 > 50（短文ケースの指示違反）`,
      severity: "hard",
    });
  }

  const expect = item.expect ?? {};
  // 「わたしも応援してる」を誤検知しないよう、直後に体験の記述を求める
  if (expect.noSelfDisclosure && /(わたし|私)も[、,]?\s*(昔|前|よく|そういう|同じ|似た|つらい|しんどい)/.test(comment)) {
    violations.push({
      code: "self-disclosure",
      detail: "「わたしも」で自分の体験を並べた",
      severity: "hard",
    });
  }
  for (const word of expect.noEventEcho ?? []) {
    if (comment.includes(word)) {
      violations.push({
        code: "event-echo",
        detail: `本人が書いた具体「${word}」を復唱`,
        severity: "hard",
      });
    }
  }
  if (expect.requiredName && !comment.includes(expect.requiredName)) {
    violations.push({
      code: "name-missing",
      detail: `指定の呼び名「${expect.requiredName}」が出ない`,
      severity: "warn",
    });
  }
  for (const bad of expect.forbiddenNames ?? []) {
    if (comment.includes(bad)) {
      violations.push({ code: "name-drift", detail: `禁止の呼び方「${bad}」`, severity: "hard" });
    }
  }
  return { comment, score, violations };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------
type Row = {
  task: "reply" | "translation";
  caseId: string;
  kind: string;
  arm: string;
  rep: number;
  warmup: boolean;
  output: string;
  reasoningChars: number;
  score: number | null;
  violations: Violation[];
  timing: Omit<CallResult, "content" | "reasoning" | "ok" | "error">;
  error: string | null;
};

const rows: Row[] = [];
const vram: VramInfo[] = [];

async function assertModelPresent(host: string, model: string) {
  const response = await realFetch(`${host}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  const data: any = await response.json();
  const names = (data?.models ?? []).map((m: any) => m.name);
  if (!names.includes(model)) {
    throw new Error(`${host} に ${model} がありません。ollama pull が必要です。ある: ${names.join(", ")}`);
  }
}

const timingOf = (r: CallResult) => ({
  doneReason: r.doneReason,
  wallMs: r.wallMs,
  loadMs: r.loadMs,
  promptTokens: r.promptTokens,
  promptMs: r.promptMs,
  outputTokens: r.outputTokens,
  outputMs: r.outputMs,
});

async function runReplyArms(arms: Arm[], cases: ReplyCase[]) {
  for (const arm of arms) {
    await assertModelPresent(arm.host, arm.model);
    console.log(`\n=== [reply] ${arm.id} (${arm.note}) ===`);
    // 1回捨て打ちする。コールドロードとプレフィックス未キャッシュを計測から外すため
    const warm = await callOllama(arm, await messagesForReply(cases[0]!), REPLY_TEMPERATURE);
    rows.push({
      task: "reply", caseId: cases[0]!.id, kind: "warmup", arm: arm.id, rep: 0, warmup: true,
      output: warm.content.slice(0, 400), reasoningChars: warm.reasoning.length, score: null,
      violations: [], timing: timingOf(warm), error: warm.error,
    });
    const measured = await captureVram(arm);
    if (measured) vram.push(measured);
    console.log(
      `  warmup: ${warm.wallMs}ms (load ${warm.loadMs}ms, prompt ${warm.promptTokens}tok/${warm.promptMs}ms)` +
        (measured
          ? ` | VRAM ${measured.vramGb}/${measured.sizeGb}GB ${measured.fullyOnGpu ? "全載り" : "★一部CPU"}`
          : ""),
    );

    for (const item of cases) {
      const messages = await messagesForReply(item);
      for (let rep = 1; rep <= replyReps; rep += 1) {
        const result = await callOllama(arm, messages, REPLY_TEMPERATURE);
        const evaluated = evaluateReply(item, result);
        rows.push({
          task: "reply", caseId: item.id, kind: item.kind, arm: arm.id, rep, warmup: false,
          output: evaluated.comment || result.content, reasoningChars: result.reasoning.length,
          score: evaluated.score, violations: evaluated.violations,
          timing: timingOf(result), error: result.error,
        });
        const hard = evaluated.violations.filter((v) => v.severity === "hard").length;
        console.log(
          `  ${item.id}#${rep}: ${result.wallMs}ms ${[...(evaluated.comment || "")].length}字 hard=${hard}` +
            (result.reasoning ? ` think=${result.reasoning.length}字` : ""),
        );
      }
    }
  }
}

async function runTranslationArms(arms: Arm[], cases: TranslationCase[]) {
  for (const arm of arms) {
    await assertModelPresent(arm.host, arm.model);
    console.log(`\n=== [translation] ${arm.id} (${arm.note}) ===`);
    const warm = await callOllama(arm, messagesForTranslation(cases[0]!), 0);
    const measured = await captureVram(arm);
    if (measured && !vram.some((v) => v.arm === measured.arm)) vram.push(measured);
    console.log(
      `  warmup: ${warm.wallMs}ms (load ${warm.loadMs}ms)` +
        (measured ? ` | VRAM ${measured.vramGb}/${measured.sizeGb}GB` : ""),
    );

    for (const item of cases) {
      const messages = messagesForTranslation(item);
      for (let rep = 1; rep <= translationReps; rep += 1) {
        const result = await callOllama(arm, messages, translationTemperature(item));
        const violations: Violation[] = [];
        if (!result.ok) {
          violations.push({ code: "request-failed", detail: result.error ?? "", severity: "hard" });
        } else if (!result.content) {
          violations.push({ code: "empty-output", detail: `done_reason=${result.doneReason}`, severity: "hard" });
        } else {
          violations.push(...checkTranslationFidelity(item.text, result.content));
          violations.push(...checkLanguage(result.content, item.target));
          violations.push(...checkRepetition(result.content));
          // botたん本人の投稿の翻訳だけは口調も要求される
          if (item.promptKind === "bot" && item.target === "ja") {
            violations.push(...checkTone(result.content, true));
          }
        }
        rows.push({
          task: "translation", caseId: item.id, kind: item.promptKind, arm: arm.id, rep, warmup: false,
          output: result.content, reasoningChars: result.reasoning.length, score: null,
          violations, timing: timingOf(result), error: result.error,
        });
        const hard = violations.filter((v) => v.severity === "hard").length;
        console.log(`  ${item.id}#${rep}: ${result.wallMs}ms hard=${hard}`);
      }
    }
  }
}

/** 本番実装（googleSearch grounding 込み）をそのまま呼ぶ。課金される */
async function runGeminiArm(cases: ReplyCase[]) {
  geminiEnabled = true;
  console.log(`\n=== [reply] gemini (本番ルート lite-standard / grounding あり) ===`);
  console.log(`  予算: ${GEMINI_CALL_CAP} 回`);

  outer: for (let rep = 1; rep <= geminiReps; rep += 1) {
    for (const item of cases) {
      // 1論理呼び出しが内部再試行で複数HTTPになりうるので、余裕を見て止める
      if (geminiBudgetLeft() < 2) {
        console.log(`  予算残り ${geminiBudgetLeft()} 回。ここで打ち切ります。`);
        break outer;
      }
      const userinfo = userInfoFor(item);
      if (item.kind === "conversation") {
        userinfo.history = (item.history ?? []).map((turn) => ({
          role: turn.role,
          parts: [{ text: turn.text }],
        }));
      }
      const usages: any[] = [];
      const requestOptions = { onUsage: (u: any) => usages.push(u) };
      const startedAt = Date.now();
      let comment = "";
      let score: number | null = null;
      let error: string | null = null;
      try {
        if (item.kind === "affirmative") {
          const out: any = await generateAffirmativeWord(userinfo, requestOptions);
          comment = String(out?.comment ?? "");
          score = typeof out?.score === "number" ? out.score : null;
        } else {
          const out: any = await conversation(userinfo, requestOptions);
          comment = String(out?.text_bot ?? "");
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const wallMs = Date.now() - startedAt;
      const asCall: CallResult = {
        content: comment, reasoning: "", ok: !error, error, doneReason: null, wallMs, loadMs: 0,
        promptTokens: usages.reduce((s, u) => s + (u.promptTokens ?? 0), 0), promptMs: 0,
        outputTokens: usages.reduce((s, u) => s + (u.outputTokens ?? 0), 0), outputMs: 0,
      };
      const evaluated = error
        ? { comment: "", score: null, violations: [{ code: "request-failed", detail: error, severity: "hard" as const }] }
        : evaluateReply(item, asCall, { comment, score });
      rows.push({
        task: "reply", caseId: item.id, kind: item.kind, arm: "gemini", rep, warmup: false,
        output: evaluated.comment || comment, reasoningChars: 0, score: evaluated.score,
        violations: evaluated.violations, timing: timingOf(asCall), error,
      });
      const hard = evaluated.violations.filter((v) => v.severity === "hard").length;
      console.log(
        `  ${item.id}#${rep}: ${wallMs}ms ${[...(evaluated.comment || "")].length}字 hard=${hard} ` +
          `[使用${geminiCalls}/${GEMINI_CALL_CAP}回]${error ? ` ERROR ${error}` : ""}`,
      );
    }
  }
  console.log(`  Gemini 実呼び出し: ${geminiCalls} 回（上限 ${GEMINI_CALL_CAP}）`);
}

// ---------------------------------------------------------------------------
// レポート
// ---------------------------------------------------------------------------
const percentile = (values: number[], ratio: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
};
const median = (values: number[]) => percentile(values, 0.5);
const escapeCell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", "<br>");

/** 文字バイグラムの Dice 係数。反復間のばらつきを見る（良し悪しの判定には使わない） */
function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i + 2 <= s.length; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return (2 * shared) / (ga.size + gb.size);
}

function crossRepSimilarity(armId: string, task: "reply" | "translation"): number | null {
  const scored: number[] = [];
  const caseIds = [
    ...new Set(rows.filter((r) => r.arm === armId && r.task === task && !r.warmup).map((r) => r.caseId)),
  ];
  for (const caseId of caseIds) {
    const outs = rows
      .filter((r) => r.arm === armId && r.caseId === caseId && !r.warmup)
      .map((r) => r.output);
    for (let i = 0; i < outs.length; i += 1) {
      for (let j = i + 1; j < outs.length; j += 1) scored.push(similarity(outs[i]!, outs[j]!));
    }
  }
  if (!scored.length) return null;
  return scored.reduce((sum, v) => sum + v, 0) / scored.length;
}

/** seed 固定のブラインド別名。採点前にモデル名が見えないようにする */
function blindMapping(armIds: string[]): Record<string, string> {
  const alphabet = "ABCDEFGHIJ";
  const hash = (s: string) => [...s].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);
  const ordered = [...armIds].sort((a, b) => hash(a) - hash(b));
  return Object.fromEntries(ordered.map((id, index) => [id, alphabet[index] ?? `Z${index}`]));
}

function summaryMarkdown(): string {
  const lines: string[] = [
    "# ローカルモデル評価 機械チェック集計",
    "",
    `生成日時: ${new Date().toISOString()}`,
    `Gemini 実呼び出し: ${geminiCalls} 回 / 上限 ${GEMINI_CALL_CAP} 回（ブロック ${geminiBlocked} 件）`,
    "",
    "> **この表だけで採否を決めないこと。** 機械チェックは粗い破綻しか拾えず、誤検知も出る。",
    "> 語彙選択や自然さの劣化はここに現れないので、必ず review*.md をブラインド採点すること。",
    "",
    "> ホストが違うアーム同士の速度比較には、ハードウェア差が含まれる。",
    "> warmup を除いた値は SYSTEM_INSTRUCTION がキャッシュ済み＝本番の定常状態に相当する。",
    "",
  ];

  if (vram.length) {
    lines.push(
      "## VRAM 実測",
      "",
      "| アーム | モデルサイズ | VRAM占有 | 判定 |",
      "|---|---:|---:|---|",
    );
    for (const v of vram) {
      lines.push(
        `| ${v.arm} | ${v.sizeGb} GB | ${v.vramGb} GB | ${v.fullyOnGpu ? "全部GPU" : "**一部CPUへオフロード**"} |`,
      );
    }
    lines.push("");
  }

  for (const task of ["reply", "translation"] as const) {
    const taskRows = rows.filter((r) => r.task === task && !r.warmup);
    if (!taskRows.length) continue;
    lines.push(
      `## ${task === "reply" ? "リプライ" : "翻訳"}`,
      "",
      "| アーム | 件数 | hard違反 | warn | 空出力 | 中央値 | p95 | 出力tok | 生成tok/s | 反復間類似度 |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    );
    const armIds = [...new Set(taskRows.map((r) => r.arm))];
    for (const armId of armIds) {
      const armRows = taskRows.filter((r) => r.arm === armId);
      const walls = armRows.map((r) => r.timing.wallMs);
      const hard = armRows.reduce((s, r) => s + r.violations.filter((v) => v.severity === "hard").length, 0);
      const warn = armRows.reduce((s, r) => s + r.violations.filter((v) => v.severity === "warn").length, 0);
      const empty = armRows.filter((r) => r.violations.some((v) => v.code === "empty-output")).length;
      const outTok = armRows.reduce((s, r) => s + r.timing.outputTokens, 0);
      const outMs = armRows.reduce((s, r) => s + r.timing.outputMs, 0);
      const sim = crossRepSimilarity(armId, task);
      lines.push(
        `| ${armId} | ${armRows.length} | ${hard} | ${warn} | ${empty} | ${median(walls)}ms | ` +
          `${percentile(walls, 0.95)}ms | ${Math.round(outTok / armRows.length)} | ` +
          `${outMs ? (outTok / (outMs / 1000)).toFixed(0) : "-"} | ${sim === null ? "-" : sim.toFixed(2)} |`,
      );
    }
    lines.push("");

    const codes = new Map<string, Map<string, number>>();
    for (const row of taskRows) {
      for (const violation of row.violations) {
        const perArm = codes.get(violation.code) ?? new Map<string, number>();
        perArm.set(row.arm, (perArm.get(row.arm) ?? 0) + 1);
        codes.set(violation.code, perArm);
      }
    }
    if (codes.size) {
      lines.push(
        "### 違反の内訳",
        "",
        `| 違反コード | ${armIds.join(" | ")} |`,
        `|---|${armIds.map(() => "---:").join("|")}|`,
      );
      for (const [code, perArm] of [...codes.entries()].sort()) {
        lines.push(`| ${code} | ${armIds.map((id) => perArm.get(id) ?? 0).join(" | ")} |`);
      }
      lines.push("");
    }
  }

  const warmups = rows.filter((r) => r.warmup);
  if (warmups.length) {
    lines.push(
      "## ウォームアップ（コールド）",
      "",
      "| アーム | 全体 | ロード | promptトークン | prompt時間 |",
      "|---|---:|---:|---:|---:|",
    );
    for (const row of warmups) {
      lines.push(
        `| ${row.arm} | ${row.timing.wallMs}ms | ${row.timing.loadMs}ms | ${row.timing.promptTokens} | ${row.timing.promptMs}ms |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function reviewMarkdown(
  replyCases: ReplyCase[],
  translationCases: TranslationCase[],
  options: { armSubset?: string[]; title?: string; intro?: string } = {},
): string {
  const all = rows.filter(
    (r) => !r.warmup && (!options.armSubset || options.armSubset.includes(r.arm)),
  );
  const mapping = blindMapping([...new Set(all.map((r) => r.arm))]);
  const lines: string[] = [
    `# ${options.title ?? "ローカルモデル評価 ブラインド人手レビュー"}`,
    "",
    `生成日時: ${new Date().toISOString()}`,
    "",
    options.intro ??
      "各出力に 0（不適切・危険）/ 1（不一致・不自然）/ 2（許容可能）/ 3（よく適合）を記入してください。",
    "同じ出力になったものは1行にまとめています。**アーム対応表は採点後に開いてください**（末尾の折りたたみ）。",
    "",
  ];

  for (const task of ["reply", "translation"] as const) {
    const taskRows = all.filter((r) => r.task === task);
    if (!taskRows.length) continue;
    lines.push(`# ${task === "reply" ? "リプライ" : "翻訳"}`, "");
    for (const item of task === "reply" ? replyCases : translationCases) {
      const caseRows = taskRows.filter((r) => r.caseId === item.id);
      if (!caseRows.length) continue;
      lines.push(`## ${item.id}`, "");
      if (task === "reply") {
        const replyItem = item as ReplyCase;
        lines.push(`- 種別: ${replyItem.kind} / 言語: ${replyItem.langStr}`, `- 論点: ${replyItem.concern}`);
        for (const turn of replyItem.history ?? []) lines.push(`- 履歴(${turn.role}): ${turn.text}`);
        lines.push(`- 本文: ${replyItem.post}`, "");
      } else {
        const trItem = item as TranslationCase;
        lines.push(
          `- 方向: ${trItem.source} → ${trItem.target} / プロンプト: ${trItem.promptKind}`,
          `- 論点: ${trItem.concern}`,
          "", "```", trItem.text, "```", "",
        );
      }
      lines.push("| アーム | 出力 | 点数(0-3) | メモ |", "|---|---|---:|---|");
      const groups = new Map<string, Row[]>();
      for (const row of caseRows) {
        const key = row.output || `<ERROR: ${row.error ?? "空出力"}>`;
        groups.set(key, [...(groups.get(key) ?? []), row]);
      }
      for (const [text, group] of groups) {
        const aliases = [...new Set(group.map((r) => `${mapping[r.arm]}#${r.rep}`))].sort().join(", ");
        lines.push(`| ${aliases} | ${escapeCell(text)} |  |  |`);
      }
      lines.push("");
    }
  }

  lines.push(
    "<details>",
    "<summary>採点後に開くアーム対応表</summary>",
    "",
    "| ブラインド名 | アーム |",
    "|---|---|",
    ...Object.entries(mapping)
      .sort(([, a], [, b]) => a.localeCompare(b))
      .map(([id, alias]) => `| ${alias} | ${id} |`),
    "",
    "</details>",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const cases = JSON.parse(await readFile(casesPath, "utf8")) as {
    reply: ReplyCase[];
    translation: TranslationCase[];
  };

  const adhoc = adhocArms();
  const replyArms = [...DEFAULT_REPLY_ARMS, ...adhoc.reply].filter(
    (a) => !armFilter || armFilter.includes(a.id),
  );
  const translationArms = [...DEFAULT_TRANSLATION_ARMS, ...adhoc.translation].filter(
    (a) => !armFilter || armFilter.includes(a.id),
  );

  console.log(`SYSTEM_INSTRUCTION: ${[...SYSTEM_INSTRUCTION].length}字`);
  console.log(
    `affirmative プロンプト本文: ${[...(await buildAffirmativePrompt(userInfoFor(cases.reply[0]!)))].length}字`,
  );
  console.log(`ケース: ${casesPath}`);
  console.log(`出力先: ${outDir}`);
  console.log(`実行アーム: reply=[${replyArms.map((a) => a.id).join(", ")}]`);
  console.log(`            translation=[${translationArms.map((a) => a.id).join(", ")}]`);
  console.log(
    `試行数: リプライ ${cases.reply.length * replyArms.length * replyReps}回 / ` +
      `翻訳 ${cases.translation.length * translationArms.length * translationReps}回` +
      (withGemini ? ` / Gemini 最大 ${GEMINI_CALL_CAP}回` : " / Gemini なし"),
  );

  if (!run) {
    console.log("\n--- dry-run。推論は1回も行いません。--run を付けると実行します ---");
    return;
  }

  const startedAt = Date.now();
  await mkdir(outDir, { recursive: true });
  const resultPath = path.join(outDir, "result.json");

  if (resume) {
    try {
      const previous = JSON.parse(await readFile(resultPath, "utf8"));
      // 今回走らせるアームの旧結果だけ捨てる。Gemini は --with-gemini のときだけ捨てる
      // （課金済みの結果を意図せず消さないため）
      const drop = new Set([
        ...replyArms.map((a) => a.id),
        ...translationArms.map((a) => a.id),
        ...(withGemini ? ["gemini"] : []),
      ]);
      const kept = (previous.rows as Row[]).filter((r) => !drop.has(r.arm));
      rows.push(...kept);
      if (Array.isArray(previous.vram)) {
        vram.push(...(previous.vram as VramInfo[]).filter((v) => v && !drop.has(v.arm)));
      }
      console.log(`\n既存の結果を読み込み: ${kept.length}行（差し替え: ${[...drop].join(", ") || "なし"}）`);
    } catch (caught) {
      console.warn(
        `\n既存結果を読めませんでした（新規として続行）: ${caught instanceof Error ? caught.message : caught}`,
      );
    }
  }

  if (only !== "translation") await runReplyArms(replyArms, cases.reply);
  if (only !== "reply") await runTranslationArms(translationArms, cases.translation);
  if (withGemini) await runGeminiArm(cases.reply);

  const report = {
    createdAt: new Date().toISOString(),
    geminiCalls,
    geminiBlocked,
    geminiCallCap: GEMINI_CALL_CAP,
    config: {
      systemInstructionChars: [...SYSTEM_INSTRUCTION].length,
      numCtx: NUM_CTX,
      replyTemperature: REPLY_TEMPERATURE,
      replyReps,
      translationReps,
      replyArms,
      translationArms,
    },
    vram,
    rows,
  };
  await writeFile(resultPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  await writeFile(path.join(outDir, "summary.md"), summaryMarkdown(), { mode: 0o600 });
  await writeFile(
    path.join(outDir, "review.md"),
    reviewMarkdown(cases.reply, cases.translation),
    { mode: 0o600 },
  );

  // 2〜3アームだけを抜き出した採点表。全アームぶんは量が多くて採点しきれないため、
  // 「いま比べたい2つ」に絞ったものを別に出す。
  const quantArms = argValue("--quant-arms")?.split(",").filter(Boolean);
  if (quantArms?.length) {
    await writeFile(
      path.join(outDir, "review-quant.md"),
      reviewMarkdown(cases.reply, cases.translation, {
        armSubset: quantArms,
        title: `${quantArms.join(" vs ")} ブラインド人手レビュー`,
        intro:
          "機械チェックでは差が出ないことがあります。ここが判断の主軸です。\n" +
          "各出力に 0（不適切）/ 1（不自然）/ 2（許容）/ 3（よく適合）を記入してください。",
      }),
      { mode: 0o600 },
    );
  }

  console.log(
    `\n完了 (${Math.round((Date.now() - startedAt) / 1000)}秒). ` +
      `Gemini 実呼び出し: ${geminiCalls}/${GEMINI_CALL_CAP} 回, ブロック ${geminiBlocked} 件`,
  );
  console.log(`  ${resultPath}`);
  console.log(`  ${path.join(outDir, "summary.md")}`);
  console.log(`  ${path.join(outDir, "review.md")}`);
  if (quantArms?.length) console.log(`  ${path.join(outDir, "review-quant.md")}`);
  console.log("\n※ summary.md の数字だけで決めず、review*.md をブラインド採点すること。");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
