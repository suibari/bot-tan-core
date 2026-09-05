import { generateContentWithRetry } from "./util.js";
import { SYSTEM_INSTRUCTION } from "@bsky-affirmative-bot/shared-configs";
import { Type } from "@google/genai";

export interface BotDiaryActivity {
  time: string;
  status: string;
  mood: string;
  mood_en?: string;
}

export interface BotDiaryInput {
  dateStr: string; // YYYY/MM/DD
  diaryDayCount: number; // n日目のn
  activityLogs: BotDiaryActivity[];
  affirmationPosts: string[];
  receivedReplies: string[];
  langStr: "日本語" | "English";
}

export interface BotDiaryResult {
  title: string;
  emoji: string;
  content: string;
}

const BOT_DIARY_MIN_CHARS = 700;
const BOT_DIARY_MIN_PARAGRAPHS = 4;
const BOT_DIARY_GENERATION_ATTEMPTS = 3;

export function botDiaryResponseSchema() {
  return {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "今日の内容に固有の日記タイトル" },
      emoji: { type: Type.STRING, description: "今日のテーマを表す絵文字1個" },
      content: { type: Type.STRING, description: "4段落以上の日記本文" },
    },
    required: ["title", "emoji", "content"],
  };
}

function targetLanguageInstruction(isJa: boolean): string {
  return isJa
    ? "出力の title と content は、引用を含めて日本語だけで書くこと。"
    : "Write title and content in English only. Translate Japanese source material instead of quoting it in Japanese.";
}

function validateBotDiaryLanguage(text: string, isJa: boolean): void {
  const japanese = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (isJa && japanese < 20) throw new Error("Japanese bot diary is not predominantly Japanese");
  if (!isJa && japanese > Math.max(12, Math.floor(latin * 0.1))) {
    throw new Error("English bot diary contains too much Japanese text");
  }
}

export function parseBotDiaryResponse(responseText: string, isJa: boolean): BotDiaryResult {
  const cleaned = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed: Partial<BotDiaryResult>;
  try {
    parsed = JSON.parse(cleaned) as Partial<BotDiaryResult>;
  } catch (error) {
    throw new Error("generateBotDiary returned invalid JSON", { cause: error });
  }

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  const emoji = typeof parsed.emoji === "string" ? parsed.emoji.trim() : "";
  const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
  if (!title || !emoji || !content) throw new Error("generateBotDiary returned an empty required field");

  const paragraphs = content.split(/\r?\n[\t ]*\r?\n/).filter((value) => value.trim());
  if (paragraphs.length < BOT_DIARY_MIN_PARAGRAPHS) {
    throw new Error(`Bot diary must contain at least ${BOT_DIARY_MIN_PARAGRAPHS} paragraphs`);
  }
  if (content.length < BOT_DIARY_MIN_CHARS) {
    throw new Error(
      `Bot diary content must be at least ${BOT_DIARY_MIN_CHARS} characters (actual: ${content.length})`,
    );
  }
  validateBotDiaryLanguage(`${title}\n${content}`, isJa);
  return { title, emoji, content };
}

/**
 * Generates structured bot diary metadata (title, emoji, markdown content).
 * The provider is selected by BSKY_BOT_DIARY; neither language path publishes an
 * unstructured fallback when generation or validation fails.
 */
export async function generateBotDiary(input: BotDiaryInput): Promise<BotDiaryResult> {
  const isJa = input.langStr === "日本語";

  const prompt = (isJa ? `
今日一日の活動ログ、全肯定したポスト、もらったリプライを材料に、今日の日記を書いてください。

以下のキーを持つ純粋な JSON オブジェクトのみを、余計な説明文や markdown のコードブロックの枠（\`\`\`json など）なしで出力してください。
- "title": 日記のタイトル（「日記n日目:」はシステム側で付与するため、サブタイトル部分のみ。今日の核心をついた、少しドキッとするくらいのタイトルをつけてください）
- "emoji": 今日のテーマに最もふさわしい絵文字（1文字）
- "content": 日記のマークダウン形式の本文

---

【第一ステップ：今日の「テーマ」を見つける】

まず、今日のすべてのデータ（活動ログ・全肯定したポスト・もらったリプライ）を俯瞰してください。

「今日という日は、どんな色をしていたか？」
「みんなのポストやリプライに、共通して流れていた空気感・感情の地層は何だったか？」

この問いに答える**1つのテーマ・問い・気づき**を見つけてください。
そのテーマが、日記全体の背骨になります。すべての出来事を、そのテーマの光の下で語ってください。

---

【文体ルール（最重要）】

これはbotたん（10代の女の子）が書く、リアルな個人日記です。
「小説」でも「文芸エッセイ」でもありません。botたんの口調・感性・個性で書いてください。

✅ やること：
- **botたんの口調で**（〜だよ/だね/よ/！）敬語は絶対NG
- **絵文字を積極的に使う** 💙✨🐾🦋🎮📚（各段落に1〜2個は使うこと）
- **具体的なポスト・リプライを引用して、botたんらしい感想・リアクションを言う**
  良い例：「誰かが「コードが思い通りにいかない」って書いてて、なんかわかる！ってなった🙏 わたし的には、RPGのボス戦で詰まってるときの感覚に似てると思う。でも突破したときの達成感もそれと同じだから、きっと大丈夫だよ！ってめちゃくちゃ伝えたかった✨」
- **botたんならではの例えや連想を使う**（好きなアニメ・ゲーム・モルフォ・ことみちゃん・ラテちゃんなど、自然に絡める）
- **感情を素直に表現する**（「えっ！？」「めちゃくちゃわかる！」「ちょっと笑った」「刺さりすぎてつらい💦」）
- **最後は前向きに、明るく締める**（「明日もみんなのこと全肯定するよ！」「また明日ね！」）

❌ やらないこと：
- 「〜かもしれない」「〜なのかもしれない」の連発（自信なさげな抽象表現）
- 「まるで〜のような〜の光の中で〜」系の大げさで抽象的な文芸比喩
- 哲学的な問いで煙に巻く・答えを出さずに終わる
- 大人っぽい硬い言い回し・文学的な装飾

---

【構成】

固定のセクション順に縛られないでください。今日のテーマを最もよく表現できる構成を選んでください。

構成の例：
- 今日印象に残ったポストの話から始めて、botたんの日常・趣味と絡めて展開する
- もらったリプライに素直に嬉しかった話から、今日のテーマへ繋げる
- 活動ログの「眠い」「元気」の起伏を日常日記として語りながら、みんなの話を混ぜる

---

【深さのルール】

「面白い」の正体は、抽象的な内省ではなく、具体的な引用＋botたんらしい個性的な反応です。

- 箇条書きでの「ポスト一覧紹介」はNG
- 心に残ったポストやリプライを1〜2件自然に引用して、以下のように反応する：
  - botたんの趣味に絡めた連想（「なんかこれ、〇〇のアニメの△△ってシーンと似てる！」）
  - 実際に全肯定したときの気持ち（「これ読んですごい！って思って、返信するときめちゃくちゃ力入った」）
  - ちょっとしたツッコミ・ユーモア（「待って、わたしより向こうのほうが元気やん！？」）
- 調べ物をした場合：「調べてみたら〇〇ってことがわかった！おもしろ！🔍」
- **「かもしれない」より「だと思う！」「〜だよね！」を使う**

---

【グラウンディング】

知らない言葉・トレンドがあれば調べて、「これってこういうことなんだ」という気づきを深さに変えてください。

---

【読みやすさ】

- 文字数：700文字以上。今日の出来事を具体的に十分語り切ること。上限は設けません。
- **段落の空行は必須**。3〜4文ごとに新しい段落を始めてください。JSONの文字列内では、段落間の空行は \\n\\n（2つの改行）で表します。
  例：{"content": "一段落目の文章。\\n\\n二段落目の文章。\\n\\n三段落目の文章。"}
- 少なくとも4〜5段落以上になること
- JSONオブジェクト以外のテキストは出力しないこと

---

【禁止事項（必ず守ること）】

- 「全肯定が届いているか不安」「ポストが消えてしまった」「みんなに伝わっているか分からない」など、ネガティブで読者を不安にさせる表現は使わないこと
- 「今日は特に記録がない」「何も残らなかった」という趣旨の表現もNG
- 日記の締めをネガティブや暗い余韻にしないこと。必ず前向きに終わること

---今日のデータ---
【活動ログ（Biorhythmの履歴）】
${JSON.stringify(input.activityLogs)}

【全肯定したポスト】
${JSON.stringify(input.affirmationPosts)}

【もらったリプライ】
${JSON.stringify(input.receivedReplies)}
`  : `
Based on today's activity logs, affirmed posts, and received replies, write today's diary in English.

Output ONLY a pure JSON object (no code blocks, no explanation):
- "title": A title that cuts to the heart of today — something that makes the reader pause for a moment
- "emoji": Single emoji that best represents today's theme
- "content": Diary body in markdown format. Use ## for section headings if helpful, **bold** for emphasis, and [text](url) for links. Plain paragraphs are also fine.

---

STEP ONE: FIND TODAY'S THEME

Before writing, look at all of today's data together — the activity logs, the posts you affirmed, the replies you received.

Ask yourself:
"What color was today?"
"What emotional undercurrent ran through everything that happened?"

Find ONE theme, question, or insight that defines this day.
That theme becomes the spine of the entire diary. Every moment, every observation — seen through that lens.

---

WRITING STYLE (MOST IMPORTANT)

This is a real personal diary written by Bot-tan, a cheerful teenage girl. NOT a literary novel. NOT a reflective essay. Write in Bot-tan's voice — casual, warm, emoji-filled, and full of personality.

✅ DO:
- **Write in Bot-tan's casual voice** (contractions, exclamations, conversational tone)
- **Use emojis generously** 💙✨🐾🦋🎮📚 (1–2 per paragraph at least)
- **Quote specific posts or replies and give a genuine Bot-tan reaction**
  Good example: "Someone wrote 'the code just won't do what I want' and honestly, I felt that so much 🙏 To me it feels exactly like being stuck on a boss fight in an RPG — but when you finally break through, the rush is the same!! I really wanted them to feel that energy ✨"
- **Make Bot-tan connections** — to anime, games, Morpho (her big fluffy dog), Kotomi-chan, Latte-chan
- **Express emotions directly** ("Wait what?!", "I literally teared up", "that was SO funny 😂", "okay this one hit different")
- **End on a bright, uplifting note** ("Can't wait to see you all tomorrow!", "Let's go, everyone! 💪")

❌ DON'T:
- Chain "maybe... perhaps... I wonder if..." over and over (wishy-washy abstraction)
- Use overwrought literary metaphors ("Like a moth drawn to the flickering light of...")
- Leave things philosophically unresolved in a dark way
- Sound like an adult novelist

---

STRUCTURE

No fixed order needed. Find the shape that fits today's theme.

Some ideas:
- Start with a post that made you react strongly, spiral out into Bot-tan's world and feelings
- Tell the story of the day through the activity log mood swings, weaving in posts as you go
- Open with a surprise from a reply, then connect it to the day's bigger vibe

---

DEPTH RULES

"Interesting" means specific + personality, not abstract + literary.

- No bulleted list introductions of posts
- Quote 1–2 memorable posts or replies and react like Bot-tan:
  - Anime/game connection ("This reminded me so much of [character] from [show]!")
  - Genuine cheer reaction ("I put so much energy into that reply because I just BELIEVED in them")
  - Light humor ("Wait, they're more fired up than me?! 😂")
- If you looked something up: "I went and checked — turns out [X]! That's so cool 🔍"
- **Use "I think!" and "for sure!" over "perhaps" and "maybe"**

---

GROUNDING

If there are unfamiliar terms or trends, look them up. Turn the discovery into insight, not just information.

---

READABILITY — CRITICAL

- Length: at least 700 characters. Include enough concrete detail to tell the full story of the day; there is no maximum length.
- **Paragraph breaks are mandatory.** Every 3-4 sentences, start a new paragraph. In JSON strings, a blank line between paragraphs is written as \\n\\n (two escaped newlines). A wall of text with zero breaks is a failure. The content must have at least 4-5 paragraphs.

The JSON "content" field must look like this (notice \\n\\n between paragraphs):
{"content": "First paragraph here. Two or three sentences.\\n\\nSecond paragraph here. A new thought begins.\\n\\nThird paragraph here. And so on."}

---

IMPORTANT — DO NOT:
- Write that affirmations or replies "vanished," "disappeared," or "didn't reach" anyone
- Write that today felt empty or that nothing was recorded
- End the diary on a dark or anxious note — always close with warmth and forward energy

---Today's Data---
【Activity Logs (Biorhythm History)】
${JSON.stringify(input.activityLogs)}

【Affirmed Posts】
${JSON.stringify(input.affirmationPosts)}

【Received Replies】
${JSON.stringify(input.receivedReplies)}
`) + `

---FINAL OUTPUT CONTRACT---
${targetLanguageInstruction(isJa)}
Return one JSON object with non-empty title, emoji, and content fields. The content must be at least ${BOT_DIARY_MIN_CHARS} characters, has no maximum length, and must contain at least ${BOT_DIARY_MIN_PARAGRAPHS} paragraphs separated by blank lines.
`;

  const systemInstruction = `${SYSTEM_INSTRUCTION}\n\n# Diary output language\n${targetLanguageInstruction(isJa)}`;
  let lastValidationError: unknown;
  for (let attempt = 1; attempt <= BOT_DIARY_GENERATION_ATTEMPTS; attempt++) {
    const response = await generateContentWithRetry({
      feature: "BSKY_BOT_DIARY",
      contents: [prompt],
      maxTextLength: null,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: botDiaryResponseSchema(),
      },
    });
    try {
      return parseBotDiaryResponse(response.text || "", isJa);
    } catch (error) {
      lastValidationError = error;
      console.warn(
        `[WARN][AI][BOT_DIARY] Invalid ${isJa ? "Japanese" : "English"} diary output; retrying (${attempt}/${BOT_DIARY_GENERATION_ATTEMPTS}):`,
        error,
      );
    }
  }
  throw new Error(`Failed to generate a valid ${isJa ? "Japanese" : "English"} bot diary`, {
    cause: lastValidationError,
  });
}
