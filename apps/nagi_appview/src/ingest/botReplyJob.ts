/**
 * 取り込んだ投稿に、AppView がその場で botたんの返信ジョブを積むか。
 *
 * もとは nagi_bot_server が自前の Jetstream で投稿に気づいて積んでいた。だがそちらが
 * 遅れると、AppView には数秒で載っている投稿に返信が付くまで最大23分待たされた
 * （2026-10-01）。AppView はクライアントの ensureRecord で投稿を即時に受け取っているので、
 * ここでも積む。両方から積まれても sourceUri の主キーで1件に畳まれる。
 *
 * 積むのは「新しい投稿を初めて見た」ときだけ。
 * - 再同期（reconcile）は過去の投稿を掘り起こすので、返事をしていない古い投稿へ
 *   今さら返信してしまう。
 * - こっそりは AppView の作成経路（kossoriPosts）が別に積む。
 * - Jetstream の update は編集なので、bot 側の onCreate と同じく対象にしない。
 *   ensureRecord は新規作成でも update として流れてくるので、Jetstream 以外では見ない。
 */
export function shouldEnqueueBotReply({
  isNewPost,
  reconcile,
  appviewOnly,
  trackJetstream,
  operation,
  kossori,
}: {
  isNewPost: boolean;
  reconcile: boolean;
  appviewOnly: boolean;
  trackJetstream: boolean;
  operation: unknown;
  kossori: boolean;
}): boolean {
  if (!isNewPost || reconcile || appviewOnly || kossori) return false;
  if (trackJetstream && operation !== "create") return false;
  return true;
}
