/**
 * 実体は `@bsky-affirmative-bot/bot-runtime` へ移した（biorhythm_server のワーカーも同じ
 * ループで回すため）。既存の import を変えずに済むよう、ここから再エクスポートする。
 */
export { startWorkerLoop, type WorkerLoopOptions } from "@bsky-affirmative-bot/bot-runtime";
