import {
  BLUEMOJI_ITEM,
  NAGI,
  type BluemojiItem,
  type BluemojiFormats,
  type BluemojiMediaType,
  type NagiChannel,
  type NagiDiary,
  type NagiNews,
  type NagiPost,
  type NagiProfile,
  type NagiReaction,
} from "@bsky-affirmative-bot/nagi-lexicon";
const graphemes = (value: string) =>
  [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    .length;
const date = (value: unknown) =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const did = (value: unknown) =>
  typeof value === "string" && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value);
const ref = (value: any) =>
  typeof value?.uri === "string" &&
  value.uri.startsWith("at://") &&
  typeof value?.cid === "string";
const image = (value: any) =>
  typeof value?.image?.ref?.$link === "string" &&
  ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
    value.image.mimeType,
  ) &&
  Number.isInteger(value.image.size) &&
  value.image.size >= 0 &&
  value.image.size <= 2_000_000 &&
  typeof value.alt === "string" &&
  graphemes(value.alt) <= 1000 &&
  Buffer.byteLength(value.alt) <= 10_000 &&
  (value.contentWarning === undefined ||
    typeof value.contentWarning === "boolean") &&
  (!value.aspectRatio ||
    (Number.isInteger(value.aspectRatio.width) &&
      value.aspectRatio.width > 0 &&
      Number.isInteger(value.aspectRatio.height) &&
      value.aspectRatio.height > 0));
const images = (value: unknown) =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= 4 &&
  value.every(image);
const facets = (value: unknown, text: string) => {
  if (!Array.isArray(value)) return false;
  const boundaries = new Set<number>([0]);
  let offset = 0;
  for (const character of text) {
    offset += Buffer.byteLength(character);
    boundaries.add(offset);
  }
  return value.every((facet: any) => {
    const start = facet?.index?.byteStart;
    const end = facet?.index?.byteEnd;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      !boundaries.has(start) ||
      !boundaries.has(end) ||
      !Array.isArray(facet.features)
    )
      return false;
    const label = Buffer.from(text).subarray(start, end).toString("utf8");
    return facet.features.every((feature: any) => {
      if (feature?.$type === "app.bsky.richtext.facet#mention")
        return did(feature.did);
      if (feature?.$type === "blue.moji.richtext.facet")
        return (
          did(feature.did) &&
          feature.name === label &&
          BLUEMOJI_NAME.test(feature.name) &&
          feature.adultOnly !== true &&
          feature.formats?.$type === "blue.moji.richtext.facet#formats_v0"
        );
      if (feature?.$type === "com.suibari.nagi.richtext#bluemoji")
        return (
          ref(feature.ref) &&
          feature.ref.uri.split("/")[3] === BLUEMOJI_ITEM &&
          feature.ref.uri.split("/")[2] === feature.did &&
          feature.name === label &&
          BLUEMOJI_NAME.test(feature.name) &&
          typeof feature.mediaType === "string" &&
          (feature.mediaType.startsWith("image/") ||
            feature.mediaType === "application/lottie+zip") &&
          (feature.alt === undefined || typeof feature.alt === "string")
        );
      return true;
    });
  });
};
const linkCard = (value: any) => {
  let uri: URL;
  try {
    uri = new URL(value?.uri);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(uri.protocol) &&
    value.uri.length <= 2048 &&
    typeof value.title === "string" &&
    graphemes(value.title) <= 300 &&
    Buffer.byteLength(value.title) <= 3000 &&
    (value.description === undefined ||
      (typeof value.description === "string" &&
        graphemes(value.description) <= 1000 &&
        Buffer.byteLength(value.description) <= 10000)) &&
    (value.thumb === undefined ||
      (typeof value.thumb?.ref?.$link === "string" &&
        ["image/jpeg", "image/png", "image/webp"].includes(
          value.thumb.mimeType,
        ) &&
        Number.isInteger(value.thumb.size) &&
        value.thumb.size >= 0 &&
        value.thumb.size <= 1_000_000))
  );
};
/** Nagi のリアクション参照で利用できる Bluemoji エイリアス。新規作成UIもこの範囲にする。 */
const BLUEMOJI_NAME = /^:[a-zA-Z0-9_-]{1,32}:$/;
const FORMATS_V0 = `${BLUEMOJI_ITEM}#formats_v0`;
const CID = /^[a-zA-Z0-9]+$/;
const blobAsset = (
  value: any,
  maxSize: number,
  accepts: (mimeType: string) => boolean,
) =>
  typeof value?.ref?.$link === "string" &&
  CID.test(value.ref.$link) &&
  typeof value.mimeType === "string" &&
  accepts(value.mimeType) &&
  Number.isInteger(value.size) &&
  value.size >= 0 &&
  value.size <= maxSize;
const inlineBytes = (value: any) => {
  if (
    typeof value?.$bytes !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.$bytes)
  )
    return false;
  try {
    const decoded = Buffer.from(value.$bytes, "base64");
    return (
      decoded.byteLength <= 65_536 &&
      decoded.toString("base64").replace(/=+$/, "") ===
        value.$bytes.replace(/=+$/, "")
    );
  } catch {
    return false;
  }
};
const selfLabels = (value: any) =>
  value?.$type === "com.atproto.label.defs#selfLabels" &&
  Array.isArray(value.values) &&
  value.values.length <= 20 &&
  value.values.every(
    (label: any) =>
      typeof label?.val === "string" &&
      label.val.length > 0 &&
      label.val.length <= 128,
  );
const atUri = (value: unknown) =>
  typeof value === "string" && /^at:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(value);
const normalizedBlob = (
  value: any,
  mediaType = value?.mimeType,
): BluemojiFormats => ({
  version: 1,
  asset: { kind: "blob", mediaType, value: value.ref.$link },
});
const normalizedBytes = (
  value: any,
  mediaType: BluemojiMediaType,
): BluemojiFormats => ({
  version: 1,
  asset: { kind: "bytes", mediaType, value: value.$bytes },
});

/** 固定した Bluemoji formats_v0 から、Nagi が描画する最優先の資産を選ぶ。 */
export function normalizeBluemojiFormats(formats: any): BluemojiFormats | null {
  if (!formats || typeof formats !== "object" || formats.$type !== FORMATS_V0)
    return null;
  if (inlineBytes(formats.lottie))
    return normalizedBytes(formats.lottie, "application/lottie+zip");
  if (inlineBytes(formats.apng_128))
    return normalizedBytes(formats.apng_128, "image/apng");
  if (blobAsset(formats.gif_128, 262_144, (type) => type.length > 0))
    return normalizedBlob(formats.gif_128, "image/gif");
  if (blobAsset(formats.webp_128, 262_144, (type) => type.length > 0))
    return normalizedBlob(formats.webp_128, "image/webp");
  if (blobAsset(formats.png_128, 262_144, (type) => type.length > 0))
    return normalizedBlob(formats.png_128, "image/png");
  if (
    blobAsset(
      formats.original,
      1_000_000,
      (type) => type.startsWith("image/") || type === "application/lottie+zip",
    )
  )
    return normalizedBlob(formats.original);
  return null;
}

export const isNormalizedBluemojiFormats = (
  value: unknown,
): value is BluemojiFormats => {
  const formats = value as BluemojiFormats;
  return (
    formats?.version === 1 &&
    (formats.asset?.kind === "blob" || formats.asset?.kind === "bytes") &&
    typeof formats.asset.value === "string" &&
    formats.asset.value.length > 0 &&
    (formats.asset.mediaType?.startsWith("image/") ||
      formats.asset.mediaType === "application/lottie+zip")
  );
};

const bluemojiRef = (value: any) =>
  typeof value?.uri === "string" &&
  value.uri.startsWith("at://") &&
  value.uri.split("/")[3] === BLUEMOJI_ITEM &&
  value.uri.length <= 512 &&
  typeof value?.cid === "string" &&
  /^[a-zA-Z0-9]+$/.test(value.cid) &&
  typeof value?.name === "string" &&
  BLUEMOJI_NAME.test(value.name) &&
  (value.alt === undefined ||
    (typeof value.alt === "string" && graphemes(value.alt) <= 100));

/** 日記の日付は "YYYY-MM-DD"（ユーザーのローカル日付）。 */
const DIARY_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** チャンネルバナー（image blob、最大1MB）。 */
const bannerBlob = (value: any) =>
  typeof value?.ref?.$link === "string" &&
  ["image/jpeg", "image/png", "image/webp"].includes(value.mimeType) &&
  Number.isInteger(value.size) &&
  value.size >= 0 &&
  value.size <= 1_000_000;

export function validateRecord(
  collection: string,
  value: any,
): value is
  | NagiPost
  | NagiReaction
  | NagiProfile
  | BluemojiItem
  | NagiDiary
  | NagiNews
  | NagiChannel {
  if (!value || value.$type !== collection || !date(value.createdAt))
    return false;
  if (collection === NAGI.post) {
    if (
      typeof value.text !== "string" ||
      graphemes(value.text) > 3000 ||
      Buffer.byteLength(value.text) > 30000
    )
      return false;
    if (value.facets !== undefined && !facets(value.facets, value.text))
      return false;
    if (value.kossori !== undefined && typeof value.kossori !== "boolean")
      return false;
    if (value.botSilent !== undefined && typeof value.botSilent !== "boolean")
      return false;
    if (
      value.silentReply !== undefined &&
      typeof value.silentReply !== "boolean"
    )
      return false;
    if (
      value.cwRestricted !== undefined &&
      typeof value.cwRestricted !== "boolean"
    )
      return false;
    if (value.channel !== undefined && !ref(value.channel)) return false;
    if (value.channelOnly !== undefined && typeof value.channelOnly !== "boolean")
      return false;
    if (value.reply && (!ref(value.reply.root) || !ref(value.reply.parent)))
      return false;
    if (
      value.linkCards &&
      (!Array.isArray(value.linkCards) ||
        value.linkCards.length > 4 ||
        !value.linkCards.every(linkCard))
    )
      return false;
    if (value.embed) {
      if (value.embed.$type === `${NAGI.post}#images`) {
        if (!images(value.embed.images)) return false;
      } else if (value.embed.$type === `${NAGI.post}#quote`) {
        if (
          !ref(value.embed.record) ||
          (value.embed.images && !images(value.embed.images))
        )
          return false;
      } else return false;
    }
    return true;
  }
  if (collection === NAGI.reaction) {
    if (!ref(value.subject) || typeof value.emoji !== "string") return false;
    if (value.bluemoji !== undefined)
      // カスタム絵文字。emoji はフォールバックテキストなので参照先のエイリアスと一致させる。
      return bluemojiRef(value.bluemoji) && value.emoji === value.bluemoji.name;
    return (
      graphemes(value.emoji.normalize("NFC")) === 1 &&
      Buffer.byteLength(value.emoji) <= 64
    );
  }
  if (collection === BLUEMOJI_ITEM)
    return (
      typeof value.name === "string" &&
      (value.alt === undefined || typeof value.alt === "string") &&
      (value.adultOnly === undefined || typeof value.adultOnly === "boolean") &&
      (value.copyOf === undefined || atUri(value.copyOf)) &&
      (value.labels === undefined || selfLabels(value.labels)) &&
      (value.fallbackText === undefined ||
        (typeof value.fallbackText === "string" &&
          value.fallbackText.length <= 10 &&
          graphemes(value.fallbackText) <= 1)) &&
      normalizeBluemojiFormats(value.formats) !== null
    );
  if (collection === NAGI.diary)
    return (
      did(value.subject) &&
      typeof value.date === "string" &&
      DIARY_DATE.test(value.date) &&
      !Number.isNaN(Date.parse(value.date)) &&
      typeof value.text === "string" &&
      value.text.length > 0 &&
      graphemes(value.text) <= 3000 &&
      Buffer.byteLength(value.text) <= 30000 &&
      (value.titleJa === undefined ||
        (typeof value.titleJa === "string" && graphemes(value.titleJa) <= 64)) &&
      (value.titleEn === undefined ||
        (typeof value.titleEn === "string" && graphemes(value.titleEn) <= 64)) &&
      (value.emoji === undefined ||
        (typeof value.emoji === "string" &&
          // 廃止前の1絵文字・3絵文字レコードを読み込むためだけに互換維持する。
          [1, 3].includes(graphemes(value.emoji)) &&
          Buffer.byteLength(value.emoji) <= 192)) &&
      (value.postCount === undefined ||
        (Number.isInteger(value.postCount) && value.postCount > 0)) &&
      (value.isPrivate === undefined ||
        typeof value.isPrivate === "boolean") &&
      (value.langs === undefined ||
        (Array.isArray(value.langs) &&
          value.langs.length <= 4 &&
          value.langs.every((lang: unknown) => typeof lang === "string")))
    );
  if (collection === NAGI.news) {
    let url: URL;
    try { url = new URL(value.url); } catch { return false; }
    return (
      ["http:", "https:"].includes(url.protocol) &&
      typeof value.articleId === "string" && value.articleId.length > 0 && value.articleId.length <= 512 &&
      typeof value.titleJa === "string" && value.titleJa.length > 0 && graphemes(value.titleJa) <= 300 &&
      Array.isArray(value.langs) && value.langs.includes("ja") &&
      (value.publishedAt === undefined || date(value.publishedAt))
    );
  }
  if (collection === NAGI.profile)
    return (
      typeof value.displayName === "string" &&
      graphemes(value.displayName) <= 64 &&
      (!value.description || graphemes(value.description) <= 256)
    );
  if (collection === NAGI.channel)
    return (
      typeof value.name === "string" &&
      value.name.trim().length > 0 &&
      graphemes(value.name) <= 50 &&
      (value.description === undefined ||
        (typeof value.description === "string" &&
          graphemes(value.description) <= 300)) &&
      (value.banner === undefined || bannerBlob(value.banner)) &&
      (value.pinnedPost === undefined || ref(value.pinnedPost))
    );
  return false;
}
