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
  labels?: SelfLabels;
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
  /** true の返信は直接の返信先へ通知しない。返信以外では効果を持たない。 */
  silentReply?: boolean;
  /** 所属チャンネル（com.suibari.nagi.channel）への参照。返信は親の channel を継承する。 */
  channel?: StrongRef;
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
export type SelfLabels = {
  $type: "com.atproto.label.defs#selfLabels";
  values: Array<{ val: string }>;
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
  /** OGP画像のURL。画像データはNagiに保存せず、表示時に配信元から直接取得する。 */
  image?: string;
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
/**
 * 全肯定ニュースの「動的枠」。時系列の items とは別枠で返し、items[0] が最新であることを
 * 崩さない（クライアントの未読判定が items[0] に依存している）。
 */
export type RecommendedNewsView = NewsView & {
  /** 「おすすめの理由：〜」に出す関心ジャンル。 */
  reason?: { genre: string };
};
export type NewsPageOutput = Page<NewsView> & {
  recommended?: RecommendedNewsView[];
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
  labels?: SelfLabels;
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
 * botたんが書くユーザーの日記。本人だけが読むので PDS には置かず、AppView にだけ作る。
 * rkey は `${subject の ":" を "_" にしたもの}-${date}` で決定論的にする。
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
  /** その日の材料にこっそり投稿が含まれていたか。表示の出し分けには使わない。 */
  isPrivate?: boolean;
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
  /** その日のリアクション・返信・引用で、本人から多く関わった相手（最大10人）。 */
  involvedActors?: ActorView[];
  /** 11人目以降の関わった相手がいる。 */
  involvedActorsHasMore?: boolean;
  langs?: string[];
  createdAt: string;
  indexedAt: string;
};
/**
 * 自分年表の1件。
 *
 * **固定文言の kind（nagi_joined など）は、サーバでは ja/en を作らない。** 表示文言は
 * クライアントの i18n が持つので、閲覧者がいま選んでいる言語に追従する
 * （サーバで作ると、その行を作った時点の言語で固まってしまう）。
 * title/detail が入るのは LLM が書いた highlight と news_context だけ。
 */
export type ChronicleEventKind =
  /** Nagi にやってきた日。年表の起点。 */
  | "nagi_joined"
  /** botたん（Bluesky側）と出会った日。Nagi 登録より前のこともある。 */
  | "bot_met"
  | "first_post"
  | "first_diary"
  | "first_card_ur"
  | "first_card_aar"
  /** 記念日カードを受け取った日。 */
  | "anniversary_card"
  /** 本人がリアクションしたニュース。 */
  | "news_reaction"
  /** 本人がブックマークしたニュース。 */
  | "news_bookmark"
  /** そのころ世の中では。月次ロールアップが選ぶ。 */
  | "news_context"
  /** 日記から抜いた、その月の大きな出来事。 */
  | "highlight";

export type ChronicleEventView = {
  /**
   * 決定論的に導出した安定キー。keyed each と、同日内の並び順の決定に使う。
   * 同じ材料からは常に同じ値になること（ページをまたいで重複排除できる必要がある）。
   */
  id: string;
  kind: ChronicleEventKind;
  /** "YYYY-MM-DD"。timestamptz 由来のものは JST 4:00 始まりで丸めてある。 */
  date: string;
  /** highlight / news_context のときだけ入る。 */
  titleJa?: string;
  titleEn?: string;
  detailJa?: string;
  detailEn?: string;
  /** highlight の由来。UI は /diary?date= へ飛ばす。 */
  diaryDate?: string;
  /** anniversary_card / first_card_* のとき。 */
  card?: CardView;
  /** news_reaction / news_bookmark / news_context のとき。 */
  news?: NewsView;
};

export type ChroniclePage = {
  items: ChronicleEventView[];
  /** 次に返す年（"2025"）。これ以上さかのぼれないときは省略する。 */
  cursor?: string;
  hasMore: boolean;
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
  /**
   * 「今日のナギカツ部長」＝ 直前に閉じた日の受賞者。
   *
   * **毎日ひとりだけが持ち、1日で消える。** 累積は出さない（累積表示は競争圧力になるとして
   * 超ポジティブLvが既に非表示にされている。docs/zenkatsu.md）。
   * プロフィールとフィードなどの投稿者情報に埋める。
   */
  zenkatsuChief?: boolean;
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
  /** 投稿者自身がレコードへ埋め込んだNagiセルフラベル。 */
  selfLabels?: string[];
  /** 現在CIDについて自動判定が付けたラベル。AppViewのPostgresが唯一の出所。 */
  moderationLabels?: string[];
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
  /** 投稿後に編集された（AppView が cid 変化を観測した）か。UI の「編集済み」バッジ用。 */
  edited?: boolean;
  deleted?: boolean;
  /** 投稿者による削除と AppView の保存拒否を表示側で区別する。 */
  unavailableReason?: "moderation-policy" | "processing-failed";
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
  /** 当日だけ true。非公開の生年月日・生年・月日は返さない。 */
  isBirthday?: boolean;
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
  /** プロフィールUIに表示する興味テーマの候補。表示側で3件をランダム選出する。 */
  interestKeywords?: string[];
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
  /**
   * subject がゼンカツの提出・ドローの控えのときの中身。post には入らないので、
   * これが無いと「リアクションされた」とだけ出て何にされたのか分からなくなる。
   */
  cardSubject?: NotificationCardSubject;
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
export type ModerationPreference = "warn" | "hide" | "ignore";
export type SyncedModerationPreferences = {
  automatic: ModerationPreference;
  selfAi: ModerationPreference;
  selfNsfw: ModerationPreference;
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
  moderationPreferences?: SyncedModerationPreferences;
  moderationPreferencesUpdatedAt?: string;
  lastBookmarkFolderId?: string;
  lastBookmarkFolderUpdatedAt?: string;
  /**
   * 年齢確認の状態。本人にだけ返す（getPreferences は requiredServiceAuth 必須で、
   * 他人の分は引けない）。declared が false なら未申告＝未成年扱い。
   */
  ageAssurance?: {
    isAdult: boolean;
    declared: boolean;
    /** 申告済みなら本人が確認できるよう返す。legacy 扱いの既存ユーザーは未申告なので省略。 */
    birthDate?: string;
  };
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
  moderationPreferences?: SyncedModerationPreferences;
  moderationPreferencesUpdatedAt?: string;
  lastBookmarkFolderId?: string | null;
  lastBookmarkFolderUpdatedAt?: string;
  /**
   * 生年月日の申告。YYYY-MM-DD。設定できるのは1度だけで、以後は 409 を返す
   * （成人向けコンテンツを見るために年齢を上書きされないようにするため）。
   * 18歳未満なら parentalConsent: true が必須。
   */
  birthDate?: string;
  parentalConsent?: boolean;
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
  /**
   * まだ PDS に控えを書いていないドロー。actor がビューア本人のときだけ返す。
   *
   * ドローは AppView 側で先に確定するので、そのあとの createRecord が失敗すると
   * 控えだけが欠ける（オフライン、PDS 落ち、アプリを閉じた）。正しさではなく遅延の問題なので、
   * クライアントは次に開いたときにここを順に書けばよい。過去ぶんもここから埋まる。
   */
  unmirroredDraws?: UnmirroredDraw[];
};
/** 控えがまだ無いドロー1件。rkey は cardGetRkey() で組み立てる。 */
export type UnmirroredDraw = {
  drawDate: string;
  source: CardDrawSource;
  volume: number;
  id: number;
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
   * この1枚を引いた日（JST 4:00 始まりの "YYYY-MM-DD"）。
   * クライアントが PDS へ控え（cardGet）を書くときの rkey に使う。日付境界の計算を
   * クライアントへ二重定義しないよう、サーバが返す。
   */
  drawDate: string;
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

// ゼンカツ！（1日1回、お題に手持ちのカード1〜3枚で答える遊び）
/**
 * 提出レコード（ユーザー自身の repo・rkey = themeDate）。
 *
 * PDS 権威にできるのは、提出が「既に所持している札を参照するだけ」だから。
 * AppView は所持・クールダウン・当日かを照合して、合わないレコードを索引しない。
 * ドローは乱数から価値を生むので照合先が無く、同じことはできない。
 */
export type NagiZenkatsu = {
  $type?: "com.suibari.nagi.zenkatsu";
  /** 答えるお題の日付。JST 4:00 始まりの "YYYY-MM-DD"。rkey と一致していること。 */
  themeDate: string;
  /** 出した札（1〜3枚）。並びは意味を持つ。同じ札の重複は不可。 */
  cards: { volume: number; id: number }[];
  createdAt: string;
};
/** お題のトーン。ネタ8割・素直2割で混ぜる。 */
export type ZenkatsuTone = "neta" | "sunao";
/** その日のお題。初回アクセス時に確定し、以後は動かない。 */
export type ZenkatsuThemeView = {
  volume: number;
  id: number;
  themeDate: string;
  textJa: string;
  textEn: string;
  /** 追い風の属性。その日「噛み合う」札を決める主軸。 */
  attribute: CardAttribute;
  /** 追い風の種族（任意）。持っていない人が出るので副次的な扱い。 */
  raceJa?: string;
  tone: ZenkatsuTone;
};
/**
 * 記録に出す1件。**スコアも順位も含まない**（全肯定なので勝敗を作らない）。
 * 出した札と botたんの総評だけ。内部の「読み」ラベルはクライアントへ返さない。
 */
export type ZenkatsuSubmissionView = {
  uri: string;
  cid: string;
  author: ActorView;
  /** 出した札。プレイヤーが置いた順。 */
  cards: CardView[];
  /** botたんの総評。生成待ちの間は undefined。 */
  commentJa?: string;
  commentEn?: string;
  /** true の間は総評を生成中。クライアントは取り直す。 */
  commentPending: boolean;
  /**
   * その日の追い風に乗っていた枚数。**得点ではない**（得点は隠しで、どこにも出さない）。
   * 「何が起きたか」だけを見せる。
   */
  tailwindCount: number;
  /**
   * 成立したコンボ。**成立したものだけ**を送る。
   * 定義そのものをクライアントへ配ると、バンドルを読むだけで全部わかってしまい、
   * 隠し要素にした意味が無くなる。
   */
  combos: ZenkatsuSubmissionCombo[];
  /**
   * 提出レコードに付いたリアクション。subject は本人の repo にある提出そのものなので、
   * 投稿・ニュースとまったく同じ経路で付き、通知も同じ経路で飛ぶ。
   */
  reactions: ReactionView[];
  /** レコードに書かれた時刻（表示用）。 */
  createdAt: string;
  /** AppView が索引した時刻。**並び順はこちら**（createdAt は遡れてしまう）。 */
  indexedAt: string;
};
/** 記録に出す、成立したコンボの要約。 */
export type ZenkatsuSubmissionCombo = {
  volume: number;
  id: number;
  nameJa: string;
  nameEn: string;
  descJa: string;
  descEn: string;
};
/** 今日出せる札1種。所持している札だけが並ぶ。 */
export type ZenkatsuPlayableCard = {
  volume: number;
  id: number;
  /** 在庫のうち、今日出せる枚数。0 なら全部クールダウン中。 */
  available: number;
  /** available が 0 のとき、いちばん早く戻る1枚があと何日でおきるか。 */
  restingDays?: number;
};
/** 認証した本人にだけ返す状態。 */
export type ZenkatsuViewerState = {
  /** 今日すでに提出したか。提出は1日1回・確定。 */
  submitted: boolean;
  submissionUri?: string;
  /** 所持している札の、今日の可否。クールダウン中のものも残り日数付きで含む。 */
  playable: ZenkatsuPlayableCard[];
  /** 1回に出せる最大枚数。手持ちが少ないうちは少なく出してよい。 */
  maxCards: number;
};
export type ZenkatsuFeed = {
  theme: ZenkatsuThemeView;
  submissions: ZenkatsuSubmissionView[];
  cursor?: string;
  viewer?: ZenkatsuViewerState;
};

/**
 * ドローの控え（ユーザーの repo）。**権威ではない。**
 * 結果を決めるのは AppView で、AppView は card_draws と突き合わせて一致しないものを索引しない。
 */
export type NagiCardGet = {
  $type?: "com.suibari.nagi.cardGet";
  card: { volume: number; id: number };
  /** 引いた日。JST 4:00 始まりの "YYYY-MM-DD"。 */
  drawDate: string;
  source: CardDrawSource;
  createdAt: string;
};
/** ニュース1件。レアドローとゼンカツのハイライトが同じ列に並ぶ。 */
export type CardNewsItem = {
  uri: string;
  cid: string;
  /**
   * "comboFound" は**そのコンボを世界で最初に成立させた回**。中身はゼンカツの回そのもので、
   * 変わるのは見出しだけ。同じ提出を "zenkatsu" としては返さない（同じ uri の項目が
   * 2つ並ぶと、クライアント側の一覧キーが重複する）。
   */
  type: "cardGet" | "zenkatsu" | "comboFound";
  author: ActorView;
  /** 並びと表示に使う時刻。cardGet は実際に引いた時刻、zenkatsu は索引時刻。 */
  at: string;
  /** type=cardGet のとき。引いた1枚。 */
  card?: CardView;
  /** type=zenkatsu のとき。出した札とお題、botたんの総評。 */
  cards?: CardView[];
  themeJa?: string;
  themeEn?: string;
  commentJa?: string;
  commentEn?: string;
  /**
   * type=zenkatsu のとき。成立したコンボ。
   *
   * ニュースに出すのは、**攻略がコミュニティに伝わる道**にするため。コンボは隠し要素で
   * 4060通りの総当たりは現実的でないので、誰かが出したものを見て広がる形にしている。
   * 未成立のぶんは送らないので、これで定義が漏れることはない。
   */
  combos?: ZenkatsuSubmissionCombo[];
  /**
   * type=comboFound のとき。`combos` のうち、この回が世界初だったぶんだけ。
   * 真実源は zenkatsu_combo_discoveries（発見者は不変）なので、マイデッキの
   * pioneer 表示と必ず一致する。
   */
  pioneerCombos?: ZenkatsuSubmissionCombo[];
  /** type=zenkatsu のとき。追い風に乗っていた枚数。**得点ではない。** */
  tailwindCount?: number;
  /** 項目そのものに付いたリアクション。subject は uri/cid の実レコード。 */
  reactions: ReactionView[];
};
export type CardNewsFeed = {
  items: CardNewsItem[];
  cursor?: string;
};

/**
 * 通知が指している、全肯定カードまわりの対象。
 *
 * ゼンカツの提出とドローの控えはどちらも投稿ではないので、`post` には入らない。
 * リアクション通知の subject がこれらのときに載る。
 */
export type NotificationCardSubject = {
  uri: string;
  type: "cardGet" | "zenkatsu";
  /** type=zenkatsu のとき。 */
  themeJa?: string;
  themeEn?: string;
  /** 出した札、または引いた1枚。 */
  cards: CardView[];
};

/** マイデッキに出す、成立させたことのあるコンボ1件。 */
export type ZenkatsuComboView = {
  volume: number;
  id: number;
  nameJa: string;
  nameEn: string;
  descJa: string;
  descEn: string;
  /** スロットごとの構成札。1スロットに複数あるのは「どちらでもよい」という意味。 */
  slots: CardView[][];
  /** 自分が初めて成立させた日（"YYYY-MM-DD"）。 */
  firstPlayedDate: string;
  /** 世界で最初に見つけた人。自分なら isPioneer が立つ。 */
  pioneer?: ActorView;
  isPioneer: boolean;
};
/** 受け取ったトロフィー1件。 */
export type ZenkatsuTrophyView = {
  /** 6種類の賞。既存の kind 値を維持し、表示名はクライアントが持つ。 */
  kind: string;
  /** 対象の日（"YYYY-MM-DD"）。 */
  themeDate: string;
  themeJa?: string;
  themeEn?: string;
  submissionUri: string;
  /** 今日のナギカツ部長に選んだ理由。 */
  commentJa?: string;
  commentEn?: string;
};
export type ZenkatsuDeckView = {
  /** 存在するコンボの総数。未発見のぶんは中身を伏せる（隠し要素なので）。 */
  comboTotal: number;
  combos: ZenkatsuComboView[];
  trophies: ZenkatsuTrophyView[];
};
