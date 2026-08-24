export const SEASONAL_WORKS_STATE_KEY = "seasonal_works_v1";

export const SEASONAL_WORK_KINDS = [
  "anime",
  "manga",
  "game",
  "drama",
  "movie",
  "novel",
  "music",
  "hobby",
] as const;

export type SeasonalWorkKind = (typeof SEASONAL_WORK_KINDS)[number];

export interface SeasonalWork {
  kind: SeasonalWorkKind;
  title: string;
  titleEn?: string;
  /** 検索で確認した、日記の比喩に使える短い事実。旧キャッシュでは未定義。 */
  hookJa?: string;
  hookEn?: string;
  /**
   * 日次予定表でこの作品を使った最後の日時（ISO文字列）。旧キャッシュでは未定義。
   *
   * 候補は種別ごとに数件しかなく、キャッシュは7日もつ。使用済みを持たないと
   * 同じ作品が週に何度も予定に載る（2026-08-24 の配信で、botたんが同じ曲の話を
   * 61発話中14回した。その曲は music 候補4件のうちの1つで、8/20・8/23・8/24 の
   * 予定表に繰り返し出ていた）。
   */
  lastUsedAt?: string;
}

export interface SeasonalWorksState {
  season: string;
  fetchedAt: string;
  failedAt?: string;
  works: SeasonalWork[];
}

export const isSeasonalWorkKind = (value: string): value is SeasonalWorkKind =>
  (SEASONAL_WORK_KINDS as readonly string[]).includes(value);
