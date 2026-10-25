import {
  setGenerationTelemetrySinkForTest,
  type GenerationTelemetrySink,
} from "@bsky-affirmative-bot/bot-brain/ai-call-stats";

const noOpTelemetrySink: GenerationTelemetrySink = {
  async incrementStats() {},
  async reportHeartbeat() {},
  async reportHealthFailure() {},
};

// LLM 呼び出しを fetch の mock で済ませても、成功後の観測処理だけは実DBへ到達する。
// 開いた Postgres 接続でテストプロセスが終わらなくなるので、各 test worker の起動時に観測先を閉じる。
setGenerationTelemetrySinkForTest(noOpTelemetrySink);
