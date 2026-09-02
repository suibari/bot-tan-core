import {
  setGenerationTelemetrySinkForTest,
  type GenerationTelemetrySink,
} from "../src/gemini/aiCallStats.js";

const noOpTelemetrySink: GenerationTelemetrySink = {
  async incrementStats() {},
  async reportHeartbeat() {},
  async reportHealthFailure() {},
};

// bot-brainの単体テストは外部APIをmockしても、成功後の観測処理だけが実DBへ到達しうる。
// 各test workerの起動時に観測先を閉じ、DB接続とメトリクス汚染を防ぐ。
setGenerationTelemetrySinkForTest(noOpTelemetrySink);
