import type { PartListUnion } from "@google/genai";
import {
  SYSTEM_INSTRUCTION,
  getFullDateAndTimeString,
  type LanguageName,
} from "@bsky-affirmative-bot/shared-configs";
import { extractJSON, generateContentWithRetry } from "./util.js";

export interface MoodSongCandidate {
  title: string;
  artist: string;
  comment: string;
}

export type MoodSongHistoryItem = Pick<MoodSongCandidate, "title" | "artist">;

function parseCandidates(text: string): MoodSongCandidate[] {
  const parsed = extractJSON(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const candidates: MoodSongCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const value = row as Record<string, unknown>;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const artist = typeof value.artist === "string" ? value.artist.trim() : "";
    const comment = typeof value.comment === "string" ? value.comment.trim() : "";
    if (!title || !artist || title.length > 100 || artist.length > 100) continue;
    const key = `${title.toLocaleLowerCase()}\u0000${artist.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      title,
      artist,
      comment: comment || "今の投稿に合いそうな曲を選んだよ！",
    });
    if (candidates.length >= 3) break;
  }
  return candidates;
}

export class MyMoodSongGenerator {
  private historyMap = new Map<LanguageName, MoodSongHistoryItem[]>();

  constructor(private maxHistory = 30) {}

  async generateCandidates(
    postText: string,
    langStr: LanguageName,
    persistedHistory: MoodSongHistoryItem[] = [],
  ): Promise<MoodSongCandidate[]> {
    const history = [
      ...persistedHistory,
      ...(this.historyMap.get(langStr) ?? []),
    ].slice(0, this.maxHistory);
    const contents: PartListUnion = [this.prompt(langStr, history), postText.trim()];
    const response = await generateContentWithRetry({
      feature: "COMMON_MOOD_SONG",
      contents,
      maxTextLength: null,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [{ googleSearch: {} }],
        temperature: 0.3,
      },
    });
    const candidates = parseCandidates(response.text || "");
    if (!candidates.length) throw new Error("Invalid mood song recommendation JSON structure");
    return candidates;
  }

  /** 旧呼び出しとの互換用。新しい選曲経路は generateCandidates を使う。 */
  async generate(postText: string, langStr: LanguageName) {
    const song = (await this.generateCandidates(postText, langStr))[0];
    this.remember(langStr, song);
    return song;
  }

  remember(langStr: LanguageName, song: MoodSongHistoryItem) {
    const current = this.historyMap.get(langStr) ?? [];
    const key = `${song.title.toLocaleLowerCase()}\u0000${song.artist.toLocaleLowerCase()}`;
    const next = [song, ...current.filter((item) =>
      `${item.title.toLocaleLowerCase()}\u0000${item.artist.toLocaleLowerCase()}` !== key
    )].slice(0, this.maxHistory);
    this.historyMap.set(langStr, next);
  }

  private prompt(langStr: LanguageName, history: MoodSongHistoryItem[]) {
    return `次に渡すSNS定期ポストまたはDJリクエストに添える実在楽曲を、適合度順に3曲選んでください。
Google検索で各曲の実在、正確な曲名・アーティスト名、歌詞テーマを確認してください。
投稿が明るく穏やかな内容なら、自殺・死別・破局・暴力など重いテーマの曲は除外してください。
単語が一致するだけでなく、投稿全体の感情と歌詞テーマが合う曲を優先してください。
検索で裏付けられない曲、過去に選んだ曲、替え歌、非公式な架空曲は出してはいけません。
URLは出力せず、次のJSON配列だけを返してください。
[
  {"title":"正確な曲名","artist":"正確なアーティスト名","comment":"投稿との関係を簡潔に説明"}
]
# 条件
- 出力言語: ${langStr}
- 現在日時: ${getFullDateAndTimeString()}
- 過去30日以内の選曲: ${history.length ? JSON.stringify(history) : "なし"}
-----この下が選曲対象の投稿です-----`;
  }
}
