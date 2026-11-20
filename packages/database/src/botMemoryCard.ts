/**
 * bot-tan.com の /memory で、ノードを選んだときに見せる「botたんの知識カード」。
 *
 * ## 何を出して、何を出さないか
 *
 * 出すのは **source_type='web_research' の行だけ**。botたんが外の公開ページを調べて
 * まとめた知識で、誰かとの会話ではない。会話由来の記憶（返信・いいね・配信コメント）は
 * この経路に一切現れない。
 *
 * それでも「どの語を調べたか」は会話から来ているので、呼び出し側（publicApi）は
 * **公開グラフにいま載っているラベルについてだけ** ここを呼ぶ。グラフ側の
 * MIN_OCCURRENCES / ラベル健全性チェックを通った語に限ることで、1回きりの会話の
 * 話題をカード経由で覗けないようにしている。
 *
 * deleted_at / visibility は findWebResearchByTerms と違ってここで必ず見る。
 * あちらは内部の返信生成用で、消した記憶を公開ページに出さない保証は持っていない。
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { bot_memory_documents, db } from "./db.js";

export interface PublicKnowledgeCardSection {
  /** 見出し。検索抜粋ならページタイトル。見出しの無い段落は空文字。 */
  heading: string;
  detail: string;
  sources: string[];
}

export interface PublicKnowledgeCard {
  term: string;
  /** 調べたときのジャンル（「遊戯王」など）。裏で調べた古いカードには無い。 */
  context: string | null;
  format: string | null;
  learnedAt: string;
  /** 「それは何か」の2〜4文。knowledge_card_v1 以外には無い。 */
  overview: string | null;
  sections: PublicKnowledgeCardSection[];
  sources: string[];
}

/** 1ラベルあたり何枚まで返すか。ジャンル違いで同じ語のカードが複数ありうる。 */
const MAX_CARDS_PER_LABEL = 3;
const MAX_SOURCES = 8;

const SOURCES_MARKER = "\n\nSources:\n";
const SNIPPET_LINE = /^「(.+?)」より[:：]\s*(.*)$/;
const RESOLVED_ABBREVIATION_LINE = /^（「.*」の検索結果）$/;

function safeUrls(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => /^https?:\/\/\S+$/i.test(value)))];
}

/**
 * 保存済みのカード本文を、見出しと段落に組み立て直す。
 *
 * 本文の形は保存した経路で違う:
 * - knowledge_card_v1（botMemoryResearchWorker / grounding.renderKnowledgeCard）
 *     語\n概要\n…\n\n見出し\n本文\n出典: URL / URL\n\nSources:\n- URL
 * - web_snippet_v1 / wikipedia_excerpt_v1（liveResearch.cardText）
 *     語（ジャンル）\n「ページ名」より: 抜粋\n「ページ名」より: 抜粋
 * - それより古い調査テキスト: 「- 」始まりの箇条書き + Sources
 *
 * どれにも当てはまらない行は見出し無しの段落として残す。読めない形でも
 * 落とさずに素のまま見せるほうが、黙って空のカードを出すよりましなので。
 */
export function parseKnowledgeCardText(input: {
  term: string;
  context: string | null;
  format: string | null;
  content: string;
  learnedAt: string;
}): PublicKnowledgeCard {
  const markerAt = input.content.indexOf(SOURCES_MARKER);
  const body = markerAt >= 0 ? input.content.slice(0, markerAt) : input.content;
  const sourcesPart = markerAt >= 0 ? input.content.slice(markerAt + SOURCES_MARKER.length) : "";
  const sources = safeUrls(
    sourcesPart.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2)),
  ).slice(0, MAX_SOURCES);

  // 1行目は保存時に置いた見出し語（「語」または「語（ジャンル）」）。本文ではない。
  const lines = body.split("\n");
  const term = input.term.trim();
  if (term && lines[0]?.trim().startsWith(term)) lines.shift();

  let overview: string | null = null;
  const sections: PublicKnowledgeCardSection[] = [];

  for (const block of lines.join("\n").split(/\n{2,}/)) {
    const blockLines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !RESOLVED_ABBREVIATION_LINE.test(line));
    if (!blockLines.length) continue;

    const [first, ...rest] = blockLines as [string, ...string[]];
    if (first === "概要" && rest.length) {
      overview = rest.join("\n");
      continue;
    }

    const isHeaded = rest.length > 0 && !SNIPPET_LINE.test(first) && !first.startsWith("- ");
    if (isHeaded) {
      const citation = rest.filter((line) => line.startsWith("出典:") || line.startsWith("出典："));
      const detail = rest.filter((line) => !citation.includes(line)).join("\n");
      if (!detail) continue;
      sections.push({
        heading: first,
        detail,
        sources: safeUrls(citation.flatMap((line) => line.slice(3).split(" / "))),
      });
      continue;
    }

    const loose: string[] = [];
    for (const line of blockLines) {
      const snippet = SNIPPET_LINE.exec(line);
      if (snippet?.[2]) sections.push({ heading: snippet[1]!, detail: snippet[2], sources: [] });
      else loose.push(line.startsWith("- ") ? line.slice(2) : line);
    }
    if (loose.length) sections.push({ heading: "", detail: loose.join("\n"), sources: [] });
  }

  return {
    term: input.term,
    context: input.context,
    format: input.format,
    learnedAt: input.learnedAt,
    overview,
    sections,
    sources,
  };
}

/**
 * ラベルに対応する知識カードを引く。公開・未削除の web_research だけ。
 *
 * **呼ぶ前に、ラベルが公開グラフに載っていることを確かめること**（冒頭コメント）。
 */
export async function getPublicKnowledgeCards(label: string): Promise<PublicKnowledgeCard[]> {
  const key = label.trim().toLowerCase();
  if (!key) return [];
  const termExpression = sql<string>`lower(${bot_memory_documents.metadata}->>'term')`;
  const rows = await db
    .select({
      content: bot_memory_documents.content,
      metadata: bot_memory_documents.metadata,
      occurredAt: bot_memory_documents.occurred_at,
    })
    .from(bot_memory_documents)
    .where(and(
      eq(bot_memory_documents.source_type, "web_research"),
      eq(bot_memory_documents.visibility, "public"),
      isNull(bot_memory_documents.deleted_at),
      inArray(termExpression, [key]),
    ))
    .orderBy(desc(bot_memory_documents.occurred_at))
    .limit(MAX_CARDS_PER_LABEL);

  return rows
    .map((row) => {
      const metadata = (row.metadata ?? {}) as Record<string, unknown>;
      return parseKnowledgeCardText({
        term: typeof metadata.term === "string" ? metadata.term : label,
        context: typeof metadata.context === "string" ? metadata.context : null,
        format: typeof metadata.format === "string" ? metadata.format : null,
        content: row.content,
        learnedAt: new Date(row.occurredAt).toISOString(),
      });
    })
    .filter((card) => card.overview || card.sections.length);
}
