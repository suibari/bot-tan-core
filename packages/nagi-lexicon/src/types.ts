export type StrongRef = { uri: string; cid: string };
export type AspectRatio = { width: number; height: number };
export type BlobRef = {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
};
export type LinkFacetFeature = {
  $type: "app.bsky.richtext.facet#link";
  uri: string;
};
export type MentionFacetFeature = {
  $type: "app.bsky.richtext.facet#mention";
  did: string;
};
export type TagFacetFeature = {
  $type: "app.bsky.richtext.facet#tag";
  tag: string;
};
export type Facet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    LinkFacetFeature | MentionFacetFeature | TagFacetFeature | unknown
  >;
};
export type NagiImage = {
  image: BlobRef;
  alt: string;
  contentWarning?: boolean;
  aspectRatio?: AspectRatio;
};
export type NagiLinkCard = {
  uri: string;
  title: string;
  description?: string;
  thumb?: BlobRef;
};
export type NagiPost = {
  $type: "com.suibari.nagi.post";
  text: string;
  facets?: Facet[];
  langs?: string[];
  createdAt: string;
  /**
   * 作成時に本文または画像へ CW があった投稿。true になった投稿は編集で戻さず、
   * CW をすべて外した後も外部コピーを作らない。
   */
  cwRestricted?: boolean;
  /**
   * こっそりモード。スレッドの公開範囲はルート投稿だけが所有するため、
   * 新しい返信レコードには設定しない。
   */
  kossori?: boolean;
  /** true の投稿には botたんが返信しない。 */
  botSilent?: boolean;
  /** 所属チャンネル（com.suibari.nagi.channel）への参照。返信は親の channel を継承する。 */
  channel?: StrongRef;
  /** true なら CH 限定＝グローバルTL非表示（kossori と同じ除外扱い）。 */
  channelOnly?: boolean;
  reply?: { root: StrongRef; parent: StrongRef };
  linkCards?: NagiLinkCard[];
  embed?:
    | { $type: "com.suibari.nagi.post#images"; images: NagiImage[] }
    | {
        $type: "com.suibari.nagi.post#quote";
        record: StrongRef;
        images?: NagiImage[];
      };
};
/** ユーザーが作るチャンネル。作成者の PDS に置くレコード。 */
export type NagiChannel = {
  $type: "com.suibari.nagi.channel";
  name: string;
  description?: string;
  banner?: BlobRef;
  /** チャンネル上部へ固定する投稿。URI を基準に現在の投稿内容を解決する。 */
  pinnedPost?: StrongRef;
  createdAt: string;
};
/** AppView が返すチャンネルのビュー。banner は blob プロキシへの相対パス。 */
export type ChannelView = {
  uri: string;
  cid: string;
  did: string;
  name: string;
  description?: string;
  banner?: string;
  createdAt: string;
  indexedAt: string;
  /** 最新投稿時刻（活動順の並べ替え・過疎判定に使う）。投稿ゼロなら付けない。 */
  lastPostAt?: string;
  /** PDS のチャンネルレコードに保存された参照。取得不能でも解除できるよう返す。 */
  pinnedPostRef?: StrongRef;
  /** 非削除かつこのチャンネル所属であることを確認して hydrate した投稿。 */
  pinnedPost?: PostView;
  /**
   * ビューアがこの CH をミュートしているか。ミュート済み CH は一覧・検索から消えるが、
   * URL 直打ちでは開けるので、そのページで解除できるように getChannel だけが返す。
   */
  viewerMuted?: boolean;
  /**
   * ビューアがこの CH を購読（参加）しているか。my Nagi の「参加中チャンネル」枠の対象になる。
   * ミュートと同じく本人にしか意味のない情報なので、未認証のときは付けない。
   */
  viewerSubscribed?: boolean;
};
export type NagiNews = {
  $type: "com.suibari.nagi.news";
  articleId: string;
  url: string;
  titleJa: string;
  sourceName?: string;
  sourceUrl?: string;
  publishedAt?: string;
  langs: string[];
  createdAt: string;
};
export type NewsView = {
  uri: string;
  cid: string;
  articleId: string;
  url: string;
  title: string;
  sourceName?: string;
  sourceUrl?: string;
  publishedAt?: string;
  botComment: string;
  lang: "ja" | "en";
  createdAt: string;
  indexedAt: string;
  reactions: ReactionView[];
  /** ユーザー追加ニュースの投稿者。botたん所有ニュースでは省略する。 */
  submittedBy?: ActorView;
  unavailable?: boolean;
};
export type NewsSubmissionPreview = {
  articleId: string;
  url: string;
  title: string;
  sourceName: string;
  sourceUrl: string;
  publishedAt?: string;
  image?: string;
};
export type NewsSubmissionState =
  "pending" | "processing" | "approved" | "rejected" | "failed" | "cancelled";
export type NewsSubmissionItem = {
  uri: string;
  cid: string;
  url: string;
  title: string;
  status: NewsSubmissionState;
  reasonCode?: string;
  requestedAt: string;
  finishedAt?: string;
};
export type MyNewsSubmissions = { items: NewsSubmissionItem[] };
export type BluemojiRef = {
  uri: string;
  cid: string;
  name: string;
  alt?: string;
};
export type NagiReaction = {
  $type: "com.suibari.nagi.reaction";
  subject: StrongRef;
  emoji: string;
  bluemoji?: BluemojiRef;
  createdAt: string;
};
/** Nagi で作成した Bluemoji を識別する、同じ rkey のサイドカーレコード。 */
export type NagiBluemoji = {
  $type: "com.suibari.nagi.bluemoji";
  subject: string;
  createdAt: string;
};
export type BluemojiMediaType = `image/${string}` | "application/lottie+zip";
export type BluemojiFacetFormats = {
  $type: "blue.moji.richtext.facet#formats_v0";
  png_128?: string;
  webp_128?: string;
  gif_128?: string;
  apng_128?: boolean;
  lottie?: boolean;
};
/** AppView DB に保存する、固定 Bluemoji Lexicon から選んだ表示資産。 */
export type BluemojiFormats = {
  version: 1;
  asset: {
    kind: "blob" | "bytes";
    mediaType: BluemojiMediaType;
    value: string;
  };
};
export type BluemojiItem = {
  $type: "blue.moji.collection.item";
  name: string;
  alt?: string;
  adultOnly?: boolean;
  labels?: {
    $type: "com.atproto.label.defs#selfLabels";
    values: Array<{ val: string }>;
  };
  copyOf?: string;
  fallbackText?: string;
  createdAt: string;
  formats: { $type: string } & Record<string, unknown>;
};
/** AppView が返すカスタム絵文字。url は blob / inline bytes 共通の資産配信URL。 */
export type EmojiView = {
  uri: string;
  cid: string;
  did: string;
  name: string;
  alt?: string;
  url: string;
  mediaType: BluemojiMediaType;
  formats?: BluemojiFacetFormats;
};
/**
 * botたんが書くユーザーの日記。bot のリポジトリに置く。
 * rkey は `${subject の ":" を "_" にしたもの}-${date}` で決定論的にし、putRecord で冪等にする。
 */
export type NagiDiary = {
  $type: "com.suibari.nagi.diary";
  /** 日記の対象ユーザーの DID。 */
  subject: string;
  /** ユーザーのローカル日付 "YYYY-MM-DD"。 */
  date: string;
  text: string;
  /** その日の称号。 */
  titleJa?: string;
  titleEn?: string;
  /** 旧日記との読み込み互換用。新規生成では保存しない。 */
  emoji?: string;
  /** 日記生成の材料にした、返信を含むNagiポスト数。 */
  postCount?: number;
  langs?: string[];
  createdAt: string;
};
export type DiaryView = {
  uri: string;
  cid: string;
  subject: string;
  date: string;
  text: string;
  titleJa?: string;
  titleEn?: string;
  postCount?: number;
  /**
   * その日の材料にこっそり投稿が含まれる、本人限定の日記であることを示す。
   */
  isPrivate?: boolean;
  /**
   * 現在の閲覧者には本文を見せられないことを示す。true のとき text は空文字で、
   * titleJa / titleEn / involvedActors は返さない。
   */
  bodyHidden?: boolean;
  /** その日のリアクション・返信・引用で、本人から多く関わった相手（最大10人）。 */
  involvedActors?: ActorView[];
  /** 11人目以降の関わった相手がいる。 */
  involvedActorsHasMore?: boolean;
  langs?: string[];
  createdAt: string;
  indexedAt: string;
};
export type NagiProfile = {
  $type: "com.suibari.nagi.profile";
  displayName: string;
  description?: string;
  avatar?: BlobRef;
  createdAt: string;
};
export type ActorView = {
  did: string;
  handle: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  /** botたん本人か。バッジ表示はアクター単位で判定する（PostView.isBot は同じ式の派生）。 */
  isBot?: boolean;
  /** 超ポジティブLv（Blueskyと共通のカウンタ。100以上もそのまま返す）。0のときは付けない。 */
  superPositiveLevel?: number;
  /**
   * 現在の称号（Blueskyと共通の followers.current_title_*）。
   * Bluesky のラベルは24時間で失効するが、こちらは次の日記/占いが上書きするまで維持される。
   * 表示側が UI 言語で出し分けるので両方返す。
   */
  currentTitle?: { ja: string; en: string };
};
export type ReactionView = {
  emoji: string;
  bluemoji?: EmojiView;
  reactors: ActorView[];
  hasMoreReactors?: boolean;
  reactedByMe?: boolean;
  viewerReactionUri?: string;
};
export type PostView = {
  uri: string;
  cid: string;
  author: ActorView;
  text: string;
  facets?: Facet[];
  /** text 内の ||...|| から導出した、区切りを除く UTF-8 バイト範囲。 */
  contentWarning?: { byteStart: number; byteEnd: number };
  langs?: string[];
  createdAt: string;
  indexedAt: string;
  reply?: { root: StrongRef; parent: StrongRef };
  images?: Array<{
    url: string;
    alt: string;
    contentWarning?: boolean;
    aspectRatio?: AspectRatio;
  }>;
  linkCards?: Array<{
    uri: string;
    title: string;
    description?: string;
    thumb?: string;
  }>;
  quote?: { kind: "post"; post: PostView } | { kind: "news"; news: NewsView };
  reactions: ReactionView[];
  isBot: boolean;
  isAffirmation: boolean;
  /** 作成時から CW 運用であり、外部コピーを永久に作らない投稿。 */
  cwRestricted?: boolean;
  /** このレコード自身のこっそり値。新規データではスレッドルートだけが持つ。 */
  kossori?: boolean;
  /** ルート投稿から解決した、スレッド全体の有効なこっそり状態。 */
  threadKossori?: boolean;
  /** 所属チャンネル（あれば）。バッジ表示・返信時の継承元に使う。 */
  channel?: { uri: string; cid: string; name?: string };
  /** CH 限定投稿（グローバル非表示）か。 */
  channelOnly?: boolean;
  /** 投稿後に編集された（AppView が cid 変化を観測した）か。UI の「編集済み」バッジ用。 */
  edited?: boolean;
  deleted?: boolean;
};
export type BotReplyState = "pending" | "processing" | "posted" | "failed";
/**
 * 会話グループ化ビュー。group モードのタイムラインで付き、1スレッドを
 * 「ルート + 最新数件のバブル」に畳んで表示する。bot返信もバブルとして時刻順に含む。
 */
/** 会話グループ内の1バブル。depth はルートからの返信ホップ数(root=0, 直リプ=1, ...)。 */
export type ConversationBubble = { post: PostView; depth: number };
export type ConversationView = {
  /** スレッドルートURI。dedup/マージ/DOMキーの安定キー。 */
  threadRootUri: string;
  /** スレッドの起点。常に先頭に表示する。 */
  root: PostView;
  /** ルート以降の共有可視バブル（時刻昇順・bot返信含む・最大3件・深さ付き）。 */
  bubbles: ConversationBubble[];
  /** ルートと最新群の間に畳まれた件数。0 なら区切りを出さない。 */
  hiddenCount: number;
  /** 共有可視バブルの総数（root 含む）。1 なら単独投稿。 */
  totalCount: number;
  /** 代表(最新の人間投稿)が botたんの返信を待っている状態。返信 indexed 済みなら付かない。 */
  awaitingBotReply?: "pending" | "processing" | "failed";
};
export type FeedItem = PostView & {
  replyParent?: PostView;
  botReply?: PostView;
  botReplyState?: BotReplyState;
  /** group モード時のみ。会話ブロックとして描画するためのデータ。 */
  conversation?: ConversationView;
};
export type Page<T> = {
  items: T[];
  cursor?: string;
  hasMore: boolean;
  botActor?: ActorView;
};
export type CommunityAffirmationView = {
  uri: string;
  cid: string;
  summary: string;
  createdAt: string;
  reactions: ReactionView[];
  images?: Array<{
    url: string;
    alt: string;
    contentWarning?: boolean;
    aspectRatio?: AspectRatio;
  }>;
  linkCards?: Array<{
    uri: string;
    title: string;
    description?: string;
    thumb?: string;
  }>;
};
export type CommunityAffirmationPage = {
  items: CommunityAffirmationView[];
  cursor?: string;
  hasMore: boolean;
  botActor?: ActorView;
};
export type ProfileFeedFilter = "posts" | "replies" | "media" | "reactions";
export type ProfileDetail = ActorView & {
  postCount: number;
  firstPostAt?: string;
  joinedAt?: string;
  /** botたんの自動分析コメント。閲覧者の lang に合わせた本文（無ければ undefined）。 */
  comment?: string;
  /**
   * 名刺カード用の短いひとこと。閲覧者の lang に合わせた本文。
   * prompt_version が v1 のままの行では undefined になるので、名刺側は comment から詰める。
   */
  tagline?: string;
  /** 名刺カードに載せる、ユーザーを表すハッシュタグ3つ（`#` は含まない）。 */
  tags?: string[];
  /** 名刺の更新日（= 分析の更新日時）。 */
  cardUpdatedAt?: string;
};
export type ProfileNewsReactionItem = { kind: "news"; news: NewsView };
/**
 * こっそり投稿に対するリアクション。作者も本文も辿れないので、リアクションタブでは
 * 中身の代わりにこれを返す。黙って落とすと「押したはずのものが無い」になるため、
 * 件数と時系列の位置は保ったままプレースホルダとして描画する。
 */
export type ProfileKossoriReactionItem = {
  kind: "kossori";
  /** リアクションの識別用。ページングとキー付けにだけ使う。 */
  reactionUri: string;
  reactedAt: string;
  /** 元投稿を伏せたまま、本人が押したリアクションだけを表示する。 */
  emoji: string;
  bluemoji?: EmojiView;
};
export type ProfileFeedItem =
  FeedItem | ProfileNewsReactionItem | ProfileKossoriReactionItem;
export type ProfilePage = {
  profile: ProfileDetail;
  feed: Page<ProfileFeedItem>;
};
export type ThreadView = {
  post: FeedItem;
  replies: FeedItem[];
  botActor?: ActorView;
};
export type NotificationView = {
  id: string;
  /** "analysis" は名刺（自動分析）の更新。actor は常に botたん、post も diary も付かない。 */
  type: "reply" | "reaction" | "mention" | "diary" | "analysis";
  actor: ActorView;
  post?: PostView;
  /** type が "diary" のときの日記本体。post は付かない。 */
  diary?: DiaryView;
  /** type が "reaction" のときの、押された絵文字。 */
  reaction?: { emoji: string; bluemoji?: EmojiView };
  subjectUri: string;
  reasonUri: string;
  createdAt: string;
  readAt?: string;
};
export type SearchActorsResult = { actors: ActorView[] };
export type SearchEmojisResult = { emojis: EmojiView[]; cursor?: string };
export type GetEmojiResult = { emoji: EmojiView };
export type DeleteAccountDataResult = { success: true };
/** ミュート対象の種別。actor は相手の DID、channel はチャンネルの AT-URI を指す。 */
export type MuteSubjectType = "actor" | "channel";
/** 自分のミュート一覧。本人以外には決して返さない。 */
export type MutesView = { actors: ActorView[]; channels: ChannelView[] };
export type SetMuteInput = {
  subjectType: MuteSubjectType;
  subject: string;
  muted: boolean;
};
export type SetMuteResult = { muted: boolean };
/** ホームに表示するユーザーの非公開一覧。認証した所有者本人にしか返さない。 */
export type PrivateListView = { members: ActorView[]; limit: 200 };
/** 購読中チャンネルの上限。非公開リスト（200）より小さく取る。 */
export const CHANNEL_SUBSCRIPTION_LIMIT = 50;
export type SetChannelSubscriptionInput = {
  uri: string;
  subscribed: boolean;
};
export type SetChannelSubscriptionResult = {
  uri: string;
  subscribed: boolean;
};
/**
 * my Nagi の「リスト動向」セクション。1人/1チャンネルにつき最新1件しか返さないので、
 * 活発な相手が枠を埋め尽くさない。ページングはしない（もっと見るで既存 TL へ送る）。
 */
export type MyNagiListUser = { actor: ActorView; post: FeedItem };
export type MyNagiChannel = { channel: ChannelView; post: FeedItem };
export type MyNagiView = {
  listUsers: MyNagiListUser[];
  channels: MyNagiChannel[];
};
export type SetPrivateListMemberInput = {
  memberDid: string;
  included: boolean;
};
export type SetPrivateListMemberResult = {
  memberDid: string;
  included: boolean;
};

export type BookmarkSubjectType = "post" | "news" | "diary";
export type BookmarkFolderView = {
  id: string;
  name: string;
  isDefault: boolean;
  count: number;
  createdAt: string;
  updatedAt: string;
};
export type BookmarkStateView = {
  subjectUri: string;
  folderId?: string;
  createdAt?: string;
};
export type BookmarkUnavailableView = {
  kind: "unavailable";
  subjectType: BookmarkSubjectType;
  subjectUri: string;
};
export type BookmarkItemView = {
  id: string;
  folderId: string;
  subjectUri: string;
  createdAt: string;
  content:
    | { kind: "post"; post: PostView }
    | { kind: "news"; news: NewsView }
    | { kind: "diary"; diary: DiaryView }
    | BookmarkUnavailableView;
};
export type BookmarkFoldersView = {
  folders: BookmarkFolderView[];
  folderLimit: number;
  bookmarkLimit: number;
  lastFolderId?: string;
  lastFolderUpdatedAt?: string;
};
export type BookmarksPage = {
  items: BookmarkItemView[];
  cursor?: string;
  hasMore: boolean;
  botActor?: ActorView;
};

// ---------------------------------------------------------------------------
// 端末をまたいで同期する設定（既読位置・お気に入り絵文字）
// ---------------------------------------------------------------------------
/** my Nagi のドットを持つセクション。既読位置はセクションごとに1つ。 */
export type ReadPositionSection =
  "bot" | "community" | "list" | "channels" | "news";
export const READ_POSITION_SECTIONS: readonly ReadPositionSection[] = [
  "bot",
  "community",
  "list",
  "channels",
  "news",
] as const;
/**
 * 「ここまで読んだ」位置。新旧は (indexedAt, uri) の辞書順で比較する
 * （AppView のタイムライン順 indexedAt DESC, uri DESC と同じ規則）。
 */
export type ReadPosition = {
  section: ReadPositionSection;
  indexedAt: string;
  uri: string;
};
/** お気に入り絵文字1つ。クライアントの localStorage と同じ形をそのまま保存する。 */
export type EmojiFavorite =
  { kind: "unicode"; emoji: string } | { kind: "custom"; emoji: EmojiView };
/** お気に入りパレットの上限。クライアントの MAX_FAVORITES と揃える。 */
export const EMOJI_FAVORITES_LIMIT = 32;
/**
 * フィードのタブ1枚の種別。
 * list / custom は「入れ物」で、どれを指すかは source が持つ（list はいまホームだけ、
 * custom はいま全肯定だけ）。将来ユーザーが定義したカスタムフィードも custom に入る。
 */
export type FeedTabKind = "list" | "global" | "custom" | "channel" | "search";
export const FEED_TAB_KINDS: readonly FeedTabKind[] = [
  "list",
  "global",
  "custom",
  "channel",
  "search",
] as const;
/** list / custom が指す組み込みの中身。ユーザー定義のフィードは将来 uri で指す。 */
export type FeedTabSource = "home" | "affirmation";
export const FEED_TAB_SOURCES: readonly FeedTabSource[] = [
  "home",
  "affirmation",
] as const;
/**
 * フィードのタブ1枚。種別ごとの union にせずフラットに持つのは、lexicon で
 * タグ付き union を表しづらく、将来の種別追加を optional フィールドの追加で
 * 吸収したいため。どのフィールドが要るかは kind ごとに parse 側で見る。
 */
export type FeedTab = {
  id: string;
  kind: FeedTabKind;
  /** kind が list / custom のときの参照先（list=home, custom=affirmation）。 */
  source?: FeedTabSource;
  /** kind==='channel' のときのチャンネル AT-URI。 */
  uri?: string;
  /** kind==='search' のときの保存クエリ。 */
  query?: string;
  queryKind?: "keyword" | "tag";
  /** 表示名のスナップショット。権威は uri / query 側で、これは初回描画用。 */
  label?: string;
};
/** タブ数の上限。チャンネル追加の上限（50）より意図的に少ない。 */
export const FEED_TABS_LIMIT = 16;
export const NAGI_SUPPORTED_LANGUAGES = [
  "ar",
  "bn",
  "bg",
  "zh",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "lv",
  "lt",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sw",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
] as const;
export type NagiSupportedLanguage = (typeof NAGI_SUPPORTED_LANGUAGES)[number];
export type SyncedLanguagePreference = "browser" | NagiSupportedLanguage;
export type SyncedLanguagePreferences = {
  post: SyncedLanguagePreference;
  translation: SyncedLanguagePreference;
  provider: "kagi" | "deepl" | "google";
  autoTranslate: boolean;
};
export type PreferencesView = {
  readPositions: ReadPosition[];
  emojiFavorites: EmojiFavorite[];
  /** 未同期（まだ一度も書き込んでいない）なら undefined。 */
  emojiFavoritesUpdatedAt?: string;
  feedTabs: FeedTab[];
  /** 未設定（一度もカスタムしていない）なら undefined。クライアントは既定タブを使う。 */
  feedTabsUpdatedAt?: string;
  /** botたんからの返信確率（0〜100%）。未設定なら undefined。 */
  replyFreq?: number;
  /** botたんに呼んでほしい名前。未設定なら undefined＝表示名で呼ばれる。 */
  preferredName?: string;
  languagePreferences?: SyncedLanguagePreferences;
  languagePreferencesUpdatedAt?: string;
  lastBookmarkFolderId?: string;
  lastBookmarkFolderUpdatedAt?: string;
};
export type PutPreferencesInput = {
  readPositions?: ReadPosition[];
  emojiFavorites?: EmojiFavorite[];
  /** emojiFavorites を送るときは必須。保存済みより古ければ書き込まない。 */
  emojiFavoritesUpdatedAt?: string;
  feedTabs?: FeedTab[];
  /** feedTabs を送るときは必須。保存済みより古ければ書き込まない。 */
  feedTabsUpdatedAt?: string;
  /** botたんからの返信確率（0〜100%）。送らなければ変更しない。 */
  replyFreq?: number;
  /**
   * botたんに呼んでほしい名前。空文字を送ると登録を解除して表示名に戻す。
   * 送らなければ変更しない（他の項目と同じく差分更新）。
   */
  preferredName?: string;
  languagePreferences?: SyncedLanguagePreferences;
  languagePreferencesUpdatedAt?: string;
  lastBookmarkFolderId?: string | null;
  lastBookmarkFolderUpdatedAt?: string;
};
export type PutPreferencesResult = PreferencesView;

export type DraftLinkCard = {
  uri: string;
  title: string;
  description?: string;
};
export type DraftContent = {
  text: string;
  mentions: Array<{ start: number; end: number; did: string; handle: string }>;
  channels: Array<{ start: number; end: number; uri: string; name: string }>;
  emojis: Array<{ start: number; end: number; uri: string }>;
  linkCards: DraftLinkCard[];
  dismissedUrls: string[];
  quoteUri?: string;
};
export type DraftView = DraftContent & {
  id: string;
  createdAt: string;
  updatedAt: string;
};
export type DraftSummary = {
  id: string;
  text: string;
  linkCardCount: number;
  createdAt: string;
  updatedAt: string;
};
export type DraftsView = { drafts: DraftSummary[]; limit: number };

// ---------------------------------------------------------------------------
// 全肯定カード（1日1回引けるトレカ）
// ---------------------------------------------------------------------------
/** N < R < SR < UR < AAR(All-Affirmation Rare)。 */
export type CardRarity = "N" | "R" | "SR" | "UR" | "AAR";
export type CardAttribute =
  "light" | "dark" | "fire" | "water" | "wind" | "earth";
/**
 * カード1枚のビュー。定義（名前/フレーバー/ATK）は shared-configs の JSON 由来、
 * owned 以下は所持情報。未所持でもコレクション表示のため定義部分だけ返す。
 * ja/en 双方を積んで返すのは、クライアントのロケール切替が再フェッチ無しで効くようにするため。
 */
export type CardView = {
  /**
   * 段内の通し番号。カードの同一性は (volume, id) の組で決まる。表示は v1-001 形式。
   * 記念日カード（volume = 0）では 西暦*100 + slot が入るので、表示は year を使う。
   */
  id: number;
  volume: number;
  rarity: CardRarity;
  attribute: CardAttribute;
  atk: number;
  def: number;
  nameJa: string;
  nameEn: string;
  raceJa: string;
  raceEn: string;
  textJa: string;
  textEn: string;
  owned: boolean;
  /** 以下は owned のときだけ入る。 */
  instanceId?: string;
  /** botたんが引いた瞬間に付けたコメント。生成待ちの間は undefined。 */
  commentJa?: string;
  commentEn?: string;
  /** 同じカードを引いた回数（初回=1）。 */
  duplicateCount?: number;
  acquiredAt?: string;
  /** 最初にこの1枚を引いた人の DID。交換で流通しても出所が追える。 */
  firstOwnerDid?: string;
  /**
   * カード面に敷く背景画像のベース名。クライアントが `/card-art/{art}.webp` を引く。
   * 画像を持たないカードでは undefined（＝今までどおり文字だけのカード）。
   */
  art?: string;
  /** 記念日カードなら true。図鑑とは別枠に置き、コンプ率にも数えない。 */
  anniversary?: boolean;
  /** 記念日カードのみ。何年ぶんの1枚か。図鑑番号の代わりにこれを出す。 */
  year?: number;
};
/**
 * カードの入手経路。my_nagi と reaction はガチャの1日枠、anniversary は
 * その日が記念日の人に配る特別枠（抽選ではないので確率もコンプ率も関係しない）。
 */
export type CardDrawSource = "my_nagi" | "reaction" | "anniversary";
/**
 * 1日1回の抽選枠だけ。card_draws.draw_source の enum と対応するので、記念日は入らない
 * （記念日は抽選ではなく、日次ロックも card_instances 側の一意索引で取る）。
 */
export type CardGachaSource = Exclude<CardDrawSource, "anniversary">;
export type CardDrawSlotStatus = {
  canDraw: boolean;
  /** その枠で本日すでに引いている場合、そのカードの段と番号。 */
  cardVolume?: number;
  cardId?: number;
};
/** 本日の2つの取得枠。自分のコレクションを見ているときだけ返す。 */
export type CardDrawStatus = {
  /** 旧クライアント互換。myNagi.canDraw と同じ値。 */
  canDraw: boolean;
  /** 次に引ける時刻（ISO8601）。JST 4:00 が境界。 */
  nextDrawAt: string;
  /** 旧クライアント互換。通常枠で本日引いたカード。 */
  todayCardVolume?: number;
  todayCardId?: number;
  myNagi: CardDrawSlotStatus;
  reaction: CardDrawSlotStatus;
};
/** その日が記念日で、まだ受け取っていない1枚。 */
export type PendingAnniversary = {
  /** ANNIVERSARY_SLOTS の値。受け取りは slot 単位ではなく一括なので、表示用の識別子。 */
  slot: number;
  nameJa: string;
  nameEn: string;
  /** 背景画像のベース名。モーダルを開く前に先読みするために返す。 */
  art?: string;
};
export type CardCollectionView = {
  cards: CardView[];
  /** 図鑑の枚数。**記念日カードは含めない**（コンプ率を動かさないため）。 */
  ownedCount: number;
  totalCount: number;
  drawStatus?: CardDrawStatus;
  /** 所持している記念日カード。図鑑とは別枠で、取得の古い順。 */
  anniversaryCards?: CardView[];
  /** 本日ぶんの未受領の記念日。actor がビューア本人のときだけ返す。 */
  pendingAnniversary?: PendingAnniversary[];
};
export type DrawCardResult = {
  card: CardView;
  source: CardDrawSource;
  /** true ならその取得枠は引き済みで、返っているのはその枠のカード（冪等応答）。 */
  alreadyDrawn: boolean;
  /** コレクション初登場か。 */
  isNew: boolean;
  /** true の間は botたんコメントを生成中。クライアントは getCards で取り直す。 */
  commentPending: boolean;
  drawStatus: CardDrawStatus;
  /**
   * source=anniversary のみ。同じ日に複数の記念日が重なることがあるので、今回受け取った
   * ぶんを全部返す。card にはこの先頭が入る（1枚しか読まない旧クライアント互換）。
   */
  cards?: CardView[];
};
/** 未サインイン端末の当日カード。所持化前なので card.owned は false。 */
export type GuestCardDrawResult = DrawCardResult & {
  /** このローカル結果を破棄する時刻。通常カードと同じ JST 4:00 境界。 */
  expiresAt: string;
};
