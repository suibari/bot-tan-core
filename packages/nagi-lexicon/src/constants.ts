export const NAGI = {
  post: "com.suibari.nagi.post",
  reaction: "com.suibari.nagi.reaction",
  profile: "com.suibari.nagi.profile",
  /** ユーザーが curate する、任意 Atmosphere アプリへの連携宣言リスト（プロフィール下部に表示）。 */
  appLinks: "com.suibari.nagi.appLinks",
  /** botたんが書くユーザーの日記。書き手は bot のみなのでユーザーの書き込みスコープには含めない。 */
  diary: "com.suibari.nagi.diary",
  /** botたん（将来はユーザーも）がPDSへ保存する、タイムライン非表示のニュースレコード。 */
  news: "com.suibari.nagi.news",
  /** ユーザーが作る同好の集まり（チャンネル）。作成者のPDSに置く。post.channel から参照する。 */
  channel: "com.suibari.nagi.channel",
  /** Nagi で作成した Bluemoji を識別するサイドカー。対象 item と同じ rkey で本人の PDS に置く。 */
  bluemoji: "com.suibari.nagi.bluemoji",
  getTimeline: "com.suibari.nagi.getTimeline",
  /** 認証した本人向けの、自分・botたん・非公開リストからなるホーム。 */
  getHomeTimeline: "com.suibari.nagi.getHomeTimeline",
  getAffirmation: "com.suibari.nagi.getAffirmation",
  /** 作者名や本文を出さない、右サイドバー用の匿名要約候補。 */
  getCommunityAffirmations: "com.suibari.nagi.getCommunityAffirmations",
  putCommunityAffirmationDismissals:
    "com.suibari.nagi.putCommunityAffirmationDismissals",
  getDrafts: "com.suibari.nagi.getDrafts",
  getDraft: "com.suibari.nagi.getDraft",
  putDraft: "com.suibari.nagi.putDraft",
  deleteDraft: "com.suibari.nagi.deleteDraft",
  getThread: "com.suibari.nagi.getThread",
  getProfile: "com.suibari.nagi.getProfile",
  /** app.bsky.actor.profile の website を安全なリンクカードとして返す公開ビュー。 */
  getProfileWebsite: "com.suibari.nagi.getProfileWebsite",
  searchActors: "com.suibari.nagi.searchActors",
  getNotifications: "com.suibari.nagi.getNotifications",
  getUnreadCount: "com.suibari.nagi.getUnreadCount",
  updateSeen: "com.suibari.nagi.updateSeen",
  registerPushSubscription: "com.suibari.nagi.registerPushSubscription",
  deletePushSubscription: "com.suibari.nagi.deletePushSubscription",
  refreshPushSubscription: "com.suibari.nagi.refreshPushSubscription",
  deletePushInstallation: "com.suibari.nagi.deletePushInstallation",
  translatePost: "com.suibari.nagi.translatePost",
  translatePosts: "com.suibari.nagi.translatePosts",
  /** PDS書き込み直後に本人の正本をAppViewへ即時反映する。 */
  ensureRecord: "com.suibari.nagi.ensureRecord",
  getLinkMetadata: "com.suibari.nagi.getLinkMetadata",
  getLinkThumbnail: "com.suibari.nagi.getLinkThumbnail",
  deleteAccountData: "com.suibari.nagi.deleteAccountData",
  searchEmojis: "com.suibari.nagi.searchEmojis",
  getEmoji: "com.suibari.nagi.getEmoji",
  getDiaries: "com.suibari.nagi.getDiaries",
  getPositiveNews: "com.suibari.nagi.getPositiveNews",
  getNewsSubmissionPreview: "com.suibari.nagi.getNewsSubmissionPreview",
  requestNewsReview: "com.suibari.nagi.requestNewsReview",
  getMyNewsSubmissions: "com.suibari.nagi.getMyNewsSubmissions",
  resolveLexicon: "com.suibari.nagi.resolveLexicon",
  getAppIcon: "com.suibari.nagi.getAppIcon",
  getChannels: "com.suibari.nagi.getChannels",
  getChannel: "com.suibari.nagi.getChannel",
  getChannelTimeline: "com.suibari.nagi.getChannelTimeline",
  /** タグ検索/自由文検索。公開コンテンツなのでクライアントは AppView 直読み（getChannelTimeline と同方針）。 */
  searchPosts: "com.suibari.nagi.searchPosts",
  /** チャンネルの自由文検索（意味検索+語彙）。 */
  searchChannels: "com.suibari.nagi.searchChannels",
  /** ニュースの自由文検索（意味検索+語彙）。 */
  searchNews: "com.suibari.nagi.searchNews",
  /**
   * 自分のミュート一覧。ミュートは他ユーザーに公開してはならないので PDS レコードにはせず
   * AppView だけが持ち、認証した本人にしか返さない（requiredServiceAuth）。
   */
  getMutes: "com.suibari.nagi.getMutes",
  /** ユーザー/チャンネルのミュート設定・解除。 */
  setMute: "com.suibari.nagi.setMute",
  /** AppView だけが保持する本人の非公開ホームリスト。 */
  getPrivateList: "com.suibari.nagi.getPrivateList",
  /** 非公開ホームリストの追加・解除。 */
  setPrivateListMember: "com.suibari.nagi.setPrivateListMember",
  getBookmarkFolders: "com.suibari.nagi.getBookmarkFolders",
  putBookmarkFolder: "com.suibari.nagi.putBookmarkFolder",
  deleteBookmarkFolder: "com.suibari.nagi.deleteBookmarkFolder",
  getBookmarkStates: "com.suibari.nagi.getBookmarkStates",
  getBookmarks: "com.suibari.nagi.getBookmarks",
  putBookmark: "com.suibari.nagi.putBookmark",
  deleteBookmark: "com.suibari.nagi.deleteBookmark",
  /**
   * my Nagi（サインイン後の起点画面）専用の集約。非公開リストの各メンバーと購読中チャンネルの
   * 「最新1件」だけを返す。ページングしないので cursor は持たない。
   */
  getMyNagi: "com.suibari.nagi.getMyNagi",
  /**
   * チャンネルの購読（参加）・解除。ミュートと同じく他ユーザーに見せない情報なので
   * PDS レコードにはせず AppView だけが持ち、認証した本人にしか返さない。
   */
  setChannelSubscription: "com.suibari.nagi.setChannelSubscription",
  /**
   * 全肯定カードのコレクション。所持は公開情報なのでクライアントは AppView 直読みでも取れる
   * （getChannelTimeline と同方針）。自分を指定したときだけ drawStatus が付く。
   */
  getCards: "com.suibari.nagi.getCards",
  /** DID が無い端末向け。同日の1枚を端末秘密に対して冪等に返す公開手続き。 */
  drawGuestCard: "com.suibari.nagi.drawGuestCard",
  /**
   * カードを1枚引く（1日1回）。抽選結果が改竄されては困るので AppView が権威を持ち、
   * PDS レコードにはしない。要認証。
   */
  drawCard: "com.suibari.nagi.drawCard",
  /**
   * 姉妹アプリ（botたんのお部屋など）へサインイン済みのまま移動するための、
   * 短命・単回使用の署名付きチケットを発行する。チケットは「この利用者は指定の DID
   * である」という主張だけを運び、アクセストークンや権限は一切含まない。
   * 認可の実体は既存の service auth（viewerDid）なので、新しい認証経路は増えない。
   */
  createSsoTicket: "com.suibari.nagi.createSsoTicket",
  /**
   * 端末をまたいで同期する本人の設定（my Nagi の既読位置・お気に入り絵文字）。
   * ミュートと同じく他ユーザーに見せない情報なので PDS レコードにはせず AppView だけが持つ。
   */
  getPreferences: "com.suibari.nagi.getPreferences",
  putPreferences: "com.suibari.nagi.putPreferences",
  /**
   * こっそり投稿の作成・削除。ミュートや非公開リストと同じく「他人に見せてはならないので
   * PDS レコードにせず AppView だけが持つ」データなので、com.atproto.repo.createRecord では
   * なくこの手続きを通す。URI は著者 DID を含まない AppView 発行の不透明なものになる。
   */
  createKossoriPost: "com.suibari.nagi.createKossoriPost",
  deleteKossoriPost: "com.suibari.nagi.deleteKossoriPost",
  /** DIDを持たない端末ローカル投稿へ、期限付きで全肯定を返す。公開投稿にはしない。 */
  createGuestAffirmation: "com.suibari.nagi.createGuestAffirmation",
  getGuestAffirmation: "com.suibari.nagi.getGuestAffirmation",
  deleteGuestAffirmation: "com.suibari.nagi.deleteGuestAffirmation",
} as const;

/** Bluemoji (moji.blue) の絵文字定義レコード。カスタム絵文字はユーザー自身のPDSに置く。 */
export const BLUEMOJI_ITEM = "blue.moji.collection.item";
/** Nagi が本文・リアクションで扱う Bluemoji のコロン付きエイリアス。 */
export const BLUEMOJI_NAME_RE = /^:[a-zA-Z0-9_-]{1,32}:$/;

export const NAGI_LANGUAGES = [
  { code: "ar", name: "Arabic" },
  { code: "bn", name: "Bengali" },
  { code: "bg", name: "Bulgarian" },
  { code: "zh", name: "Chinese" },
  { code: "hr", name: "Croatian" },
  { code: "cs", name: "Czech" },
  { code: "da", name: "Danish" },
  { code: "nl", name: "Dutch" },
  { code: "en", name: "English" },
  { code: "et", name: "Estonian" },
  { code: "fi", name: "Finnish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "el", name: "Greek" },
  { code: "he", name: "Hebrew" },
  { code: "hi", name: "Hindi" },
  { code: "hu", name: "Hungarian" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "Korean" },
  { code: "lv", name: "Latvian" },
  { code: "lt", name: "Lithuanian" },
  { code: "no", name: "Norwegian" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ro", name: "Romanian" },
  { code: "ru", name: "Russian" },
  { code: "sr", name: "Serbian" },
  { code: "sk", name: "Slovak" },
  { code: "sl", name: "Slovenian" },
  { code: "es", name: "Spanish" },
  { code: "sw", name: "Swahili" },
  { code: "sv", name: "Swedish" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" },
] as const;

export const NAGI_COLLECTIONS = [
  NAGI.post,
  NAGI.reaction,
  NAGI.profile,
  NAGI.appLinks,
  NAGI.channel,
  NAGI.news,
  NAGI.bluemoji,
  BLUEMOJI_ITEM,
] as const;
/**
 * jetstream で購読するコレクション。
 * 日記は bot だけが書くのでユーザーの書き込みスコープ（NAGI_COLLECTIONS）には無いが、
 * AppView は取り込む必要があるためここにだけ足す。
 * 逆に appLinks と bluemoji サイドカーはユーザー書き込み可能（NAGI_COLLECTIONS に含む）だが、
 * AppView では使わない。よって NAGI_COLLECTIONS を spread せず明示列挙する。
 */
export const NAGI_INGEST_COLLECTIONS = [
  NAGI.post,
  NAGI.reaction,
  NAGI.profile,
  BLUEMOJI_ITEM,
  NAGI.diary,
  NAGI.news,
  NAGI.channel,
] as const;
export const NAGI_APPVIEW_DID =
  process.env.NAGI_APPVIEW_DID ?? "did:web:nagi-api.suibari.com";
/**
 * AppView が正本を持つレコードの URI に使う authority。著者の DID を URI に出さないための
 * もので、「みんなで全肯定」の匿名要約や、それに付いた他人のリアクションレコードから
 * 著者を辿れないようにする。実体は AppView の Postgres にしかなく、この DID の
 * リポジトリを引いても何も出てこない。
 */
export const NAGI_APPVIEW_URI_AUTHORITY = NAGI_APPVIEW_DID;

/** URI が AppView 発行（＝PDS に正本が無い）かどうか。 */
export const isAppviewOwnedUri = (uri: string): boolean =>
  uri.startsWith(`at://${NAGI_APPVIEW_URI_AUTHORITY}/`);

/** AppView 発行レコードの AT-URI。組み立てはここ1箇所に閉じる。 */
export const appviewRecordUri = (collection: string, rkey: string): string =>
  `at://${NAGI_APPVIEW_URI_AUTHORITY}/${collection}/${rkey}`;

export const NAGI_APPVIEW_SERVICE_ID = "nagi_appview";
export const NAGI_APPVIEW_AUD = `${NAGI_APPVIEW_DID}#${NAGI_APPVIEW_SERVICE_ID}`;
export const NAGI_BOT_DID = process.env.NAGI_BOT_DID ?? "";
export const NAGI_AFFIRMATION_THRESHOLD = Number(
  process.env.NAGI_AFFIRMATION_THRESHOLD ??
    process.env.NAGI_TREND_THRESHOLD ??
    86,
);
/** permission set の NSID。定義は lexicons/com/suibari/nagi/appviewAccess.json。 */
export const NAGI_PERMISSION_SET = "com.suibari.nagi.appviewAccess";
/** Nagi のプロフィール設定で app.bsky.actor.profile.website を更新する。 */
export const NAGI_BLUESKY_PROFILE_SCOPE =
  "repo:app.bsky.actor.profile?action=create&action=update";

/**
 * Nagi の OAuth スコープ（真実源はこの1箇所）。Nagi namespace の repo/rpc 権限は permission
 * set(appviewAccess) に集約し、公開済み lexicon 側を真実源にする。blob と別 namespace の
 * Bluemoji repo 権限は permission set に入れられないため、直接スコープで残す。
 * client.ts / client-metadata.json はこのバンドル参照形を使う。
 *
 * rpc の aud は permission set 側で `"aud": "*"`（wildcard）にハードコードしている。fragment 固定だと
 * proxy 時に service fragment を落として bare aud で照合する PDS（Spring 2026 以前挙動）で
 * "Missing required scope" になるため。wildcard は新旧 PDS 双方の照合にマッチする（cf. Skyblur）。
 * よって include には aud パラメータを付けない（付けると inheritAud と競合しうる）。
 *
 * 変更時の注意: バンドルの中身（repo/rpc）は appviewAccess.json 側を編集し `pnpm lex:publish`
 * （= goat lex publish）で再公開する。反映まで JSON 変更だけでは効かない。
 * スコープ文字列そのものを変える場合は全ユーザーに再同意が発生する。cf. [[atproto-roadmap-2026]]
 */
export const NAGI_OAUTH_SCOPE = [
  "atproto",
  "blob:image/*",
  `include:${NAGI_PERMISSION_SET}`,
  `repo:${BLUEMOJI_ITEM}`,
  NAGI_BLUESKY_PROFILE_SCOPE,
].join(" ");

/**
 * オプトイン時にだけ追加で要求するスコープ。通常のサインインでは付けない。
 *
 * どちらも別 namespace なので appviewAccess(permission set) には入れられず、直接スコープで持つ。
 * standard.site 側にも site.standard.authFull という permission set があるが、
 * subscription / recommend まで含む過剰な束なので採らない。
 * Nagi は記事の作成・編集・削除を投稿に追従させるため、standard.site 側は action を絞らない。
 */
export const NAGI_CROSSPOST_SCOPE = "repo:app.bsky.feed.post?action=create";
export const NAGI_STANDARD_SITE_SCOPES = [
  "repo:site.standard.publication",
  "repo:site.standard.document",
];

/** client-metadata.json に宣言する最大集合（実際に要求するのはオプトインの分だけ）。 */
export const NAGI_OAUTH_SCOPE_FULL = [
  NAGI_OAUTH_SCOPE,
  NAGI_CROSSPOST_SCOPE,
  ...NAGI_STANDARD_SITE_SCOPES,
].join(" ");
