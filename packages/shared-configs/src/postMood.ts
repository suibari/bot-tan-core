/**
 * 日記の感情グラフの採点基準の版。上げると NagiPostMoodWorker が全投稿を採点し直す。
 *
 * 採点する側（bot_brain の scorePostMood）と表示する側（AppView の loadDiaryMoods）の
 * 両方が参照するので、両者が依存する shared-configs に置く。AppView は版違いの点を
 * 未採点として扱い、古い基準の点をグラフに出さない。
 */
export const POST_MOOD_VERSION = "post-mood-v2";
