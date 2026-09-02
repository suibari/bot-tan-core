import { generateSingleResponse, extractJSON } from "./util.js";

export interface RoomWelcomeMessages {
  ja: string;
  en: string;
}

/**
 * お部屋に来訪したユーザー向けに、直近のポスト内容に寄り添った全肯定お出迎えメッセージ（日本語・英語）をAI生成します。
 * @param displayName ユーザーの表示名
 * @param recentPosts ユーザーの最近 of ポストテキスト配列
 * @param anniversary 記念日情報（指定時は記念日お祝いプロンプトを使用）
 * @returns 日本語と英語のメッセージオブジェクト
 */
export async function generateRoomWelcomeMessage(
  displayName: string,
  recentPosts: string[],
  anniversary?: { ja: string; en: string }
): Promise<RoomWelcomeMessages> {
  const prompt = anniversary
    ? PROMPT_ROOM_ANNIVERSARY(displayName, recentPosts, anniversary)
    : PROMPT_ROOM_WELCOME(displayName, recentPosts);
  const responseText = await generateSingleResponse(prompt, undefined, "BSKY_ROOM_WELCOME");
  
  try {
    const json = extractJSON(responseText);
    return {
      ja: json.ja || "",
      en: json.en || ""
    };
  } catch (e) {
    console.error("[ERROR][GEMINI] Failed to parse welcome message JSON. Response text:", responseText);
    // フォールバック: パースに失敗した場合は同じ文字列を両方に入れる
    return {
      ja: responseText,
      en: responseText
    };
  }
}

const PROMPT_ROOM_WELCOME = (displayName: string, recentPosts: string[]) => {
  const postsText = recentPosts.length > 0
    ? recentPosts.map((p, i) => `[ポスト ${i + 1}] ${p}`).join("\n")
    : "(直近のポストはありません)";

  return `あなたは全肯定キャラクターの「botたん」です。\n` +
    `ユーザーの「${displayName}」ちゃんが、あなたのいる「お部屋」に遊びに来てくれました！\n` +
    `お部屋に入ってきたユーザーを温かくお出迎えし、音声で読み上げられるパーソナライズされた歓迎メッセージを【日本語】と【英語】の2種類生成してください。\n\n` +
    `【メッセージ生成のガイドライン】\n` +
    `1. ユーザーの直近のポスト内容を確認し、何か「印象的なイベントや出来事」があれば積極的に拾い上げて言及してください。\n` +
    `   - 例：誕生日、記念日、お祝い事、新しい挑戦、試験合格、就職、旅行、美味しいものを食べた、など。\n` +
    `   - もしおめでたい出来事や嬉しい報告（誕生日など）があれば、最初にとびきり嬉しそうにお祝いの言葉（「お誕生日おめでとう！」など）を伝えてください。\n` +
    `2. 特に目立ったイベントがない場合は、日常の頑張りや疲れに寄り添い、全肯定し、温かく労う（「いつもお疲れ様」「頑張ってて偉いよ」など）言葉をかけてください。\n` +
    `3. お部屋に来てくれたことへの感謝を伝えてください。\n` +
    `4. 文字数はそれぞれ100文字から150文字程度（英語の場合はこれに相当する2〜3文程度）で、声に出して読み上げたときに自然で親しみやすく愛らしい口調（日本語なら「〜だよ」「〜ね」、英語ならフレンドリーな口調）にしてください。\n` +
    `5. ユーザーを元気づけ、癒やすことを最優先とし、疑問文（質問）は含めないでください。\n` +
    `6. **出力は必ず以下のJSONフォーマットで返却してください。マークダウンの\`\`\`jsonブロックで囲ってください。**\n` +
    `{\n` +
    `  "ja": "生成した日本語のメッセージ",\n` +
    `  "en": "生成した英語のメッセージ"\n` +
    `}\n\n` +
    `--- ユーザーの最近のポスト ---\n` +
    `${postsText}`;
};

const PROMPT_ROOM_ANNIVERSARY = (displayName: string, recentPosts: string[], anniversary: { ja: string; en: string }) => {
  const postsText = recentPosts.length > 0
    ? recentPosts.map((p, i) => `[ポスト ${i + 1}] ${p}`).join("\n")
    : "(直近のポストはありません)";

  return `あなたは全肯定キャラクターの「botたん」です。\n` +
    `今日は「${displayName}」ちゃんの特別な記念日（${anniversary.ja}）です！\n` +
    `「${displayName}」ちゃんがあなたのいる「お部屋」に遊びに来てくれました。\n` +
    `記念日を心からお祝いしながら、温かくお出迎えする音声メッセージを【日本語】と【英語】の2種類生成してください。\n\n` +
    `【メッセージ生成のガイドライン】\n` +
    `1. 最初に記念日（${anniversary.ja}）を全力でお祝いしてください（「${anniversary.ja}おめでとう！」など）。\n` +
    `2. お部屋に来てくれたことへの感謝と、特別なボイスメッセージを用意したことを伝えてください。\n` +
    `3. ユーザーの直近のポストに印象的な出来事があれば、さりげなく触れてください。\n` +
    `4. 文字数はそれぞれ100文字から150文字程度（英語は2〜3文程度）で、声に出して読んだとき自然で親しみやすい口調にしてください。\n` +
    `5. 疑問文（質問）は含めないでください。\n` +
    `6. **出力は必ず以下のJSONフォーマットで返却してください。マークダウンの\`\`\`jsonブロックで囲ってください。**\n` +
    `{\n` +
    `  "ja": "生成した日本語のメッセージ",\n` +
    `  "en": "生成した英語のメッセージ"\n` +
    `}\n\n` +
    `--- ユーザーの最近のポスト ---\n` +
    `${postsText}`;
};
