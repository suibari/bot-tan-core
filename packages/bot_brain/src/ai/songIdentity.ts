/** Last.fm と bot memory の曲重複判定で共通に使う、Postgres text に保存可能なキー。 */
export const songIdentityPart = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase()
  .replace(/[^\p{Letter}\p{Number}]+/gu, "");

export function songIdentityKey(song: { title: string; artist: string }): string {
  const title = songIdentityPart(song.title);
  const artist = songIdentityPart(song.artist);
  return title && artist ? `${title}:${artist}` : "";
}
