import { PartListUnion } from "@google/genai";
import { SYSTEM_INSTRUCTION } from "@bsky-affirmative-bot/shared-configs";
import { gemini } from "./index.js";

import { extractJSON, generateContentWithRetry } from "./util.js";
import { getFullDateAndTimeString } from "@bsky-affirmative-bot/shared-configs";
import { UserInfoGemini, LanguageName } from "@bsky-affirmative-bot/shared-configs";
import { SpotifyTrack } from "../api/spotify/index.js";

type GeminiRecommendation = [
  {
    title: string;
    artist: string;
    comment: string;
  }
]

export class MyMoodSongGenerator {
  private historyMap: Record<string, { title: string; artist: string }[]> = {};

  constructor(private maxHistory = 3) { }

  async generate(currentMood: string, langStr: LanguageName, spotifyPlaylist?: SpotifyTrack[]) {
    const history = this.historyMap[langStr] ?? [];
    const prompt = this.PROMPT_DJ(currentMood, langStr, history);
    const contents: PartListUnion = [prompt];

    const response = await generateContentWithRetry({
      feature: "BSKY_MY_MOOD_SONG",
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: [
          {
            googleSearch: {},
          }
        ]
      }
    });
    
    const result = extractJSON(response.text || "") as GeminiRecommendation;
    const parsedSong = Array.isArray(result) ? result[0] : (result as any);
    if (!parsedSong || !parsedSong.title || !parsedSong.artist) {
      throw new Error("Invalid DJ song recommendation JSON structure");
    }
    
    const song = {
      title: parsedSong.title,
      artist: parsedSong.artist,
      comment: parsedSong.comment || "今の気分にぴったりな曲を選んだよ！"
    };

    this.saveHistory(langStr, { title: song.title, artist: song.artist });

    return song;
  }

  private saveHistory(lang: string, song: { title: string; artist: string }) {
    if (!this.historyMap[lang]) this.historyMap[lang] = [];
    this.historyMap[lang].unshift(song);
    if (this.historyMap[lang].length > this.maxHistory) {
      this.historyMap[lang].pop();
    }
  }

  private PROMPT_DJ(currentMood: string, langStr: LanguageName, history: { title: string; artist: string }[]) {
    return `あなたの今の気分と現在の時間にあった曲を選曲してください。
以下のJSON形式で出力してください。
\`\`\`json
[
  {
    "title": "曲名",
    "artist": "アーティスト名",
    "comment": "コメント"
  }
]
\`\`\`
# ルール
* 実在しない曲は挙げてはいけません。
* ${langStr}の曲を挙げてください。
* titleに曲名、artistにアーティスト名を、正確に出力してください
* commentには選曲に関するあなたのコメントを出力してください
* 過去に選曲した曲は選んではいけません
-----
現在の時間: ${getFullDateAndTimeString()}
今の気分: ${currentMood}
過去に選曲した曲: ${history ? JSON.stringify(history) : "なし"}
`
  };
}
