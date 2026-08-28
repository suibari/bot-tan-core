import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { NAGI } from "@bsky-affirmative-bot/nagi-lexicon";
import {
  optionalServiceAuth,
  requiredServiceAuth,
} from "../auth/serviceAuth.js";
import {
  createSsoTicket,
  isAllowedAudience,
  ssoTicketEnabled,
} from "../services/ssoTicket.js";
import { getTimeline } from "../queries/timeline.js";
import { searchPostsByText, type SearchMode } from "../queries/search.js";
import {
  getChannel,
  getChannelTimeline,
  getChannels,
  searchChannels,
  searchChannelsTypeahead,
} from "../queries/channels.js";
import { getActorProfile, getReactedFeed } from "../queries/profile.js";
import { resolveActorDid, searchActors } from "../queries/actors.js";
import { getThread } from "../queries/thread.js";
import {
  getNotifications,
  getUnreadCount,
  updateSeen,
} from "../queries/notifications.js";
import { getDiaries } from "../queries/diaries.js";
import { getPositiveNews, searchNews } from "../queries/positiveNews.js";
import {
  invalidateInstallation,
  invalidateOwnSubscription,
  refreshSubscription,
  upsertSubscription,
} from "../queries/pushSubscriptions.js";
import { translatePost, translatePosts } from "../services/translation.js";
import { ApiError } from "../middleware/errors.js";
import { deleteAccountData } from "../services/deleteAccountData.js";
import {
  getAppIcon,
  getLinkMetadata,
  getLinkThumbnail,
} from "../services/linkMetadata.js";
import { getEmoji, searchEmojis } from "../services/emoji.js";
import { resolveLexicon } from "../queries/resolveLexicon.js";
import { getMutesView, setMute } from "../queries/mutes.js";
import {
  getPrivateList,
  setPrivateListMember,
} from "../queries/privateList.js";
import { getPreferences, putPreferences } from "../queries/preferences.js";
import {
  createKossoriPost,
  deleteKossoriPost,
} from "../queries/kossoriPosts.js";
import {
  deleteBookmark,
  deleteBookmarkFolder,
  getBookmarkFolders,
  getBookmarks,
  getBookmarkStates,
  putBookmark,
  putBookmarkFolder,
} from "../queries/bookmarks.js";
import { setChannelSubscription } from "../queries/channelSubscriptions.js";
import { getMyNagi } from "../queries/myNagi.js";
import {
  claimAnniversaryCards,
  drawCard,
  drawGuestCard,
  getCards,
} from "../queries/cards.js";
import { getCommunityAffirmations } from "../queries/communityAffirmations.js";
import { putCommunityAffirmationDismissals } from "../queries/communityAffirmationDismissals.js";
import {
  deleteDraft,
  getDraft,
  getDrafts,
  putDraft,
} from "../queries/drafts.js";
import { getProfileWebsiteCard } from "../services/profileWebsite.js";
import { config } from "../config.js";
import {
  getMyNewsSubmissions,
  getNewsSubmissionPreview,
  requestNewsReview,
} from "../services/userNewsSubmissions.js";
import {
  ensurePdsRecord,
  isReconcilableCollection,
} from "../ingest/reconcileRepo.js";
import { prioritizeReconcile } from "../ingest/reconcileWorker.js";
import { parseRecordUri } from "../ingest/recordUri.js";
import {
  createGuestAffirmation,
  deleteGuestAffirmation,
  getGuestAffirmation,
} from "../queries/guestAffirmations.js";
export const xrpc = Router();
const limit = (value: unknown) =>
  Math.min(100, Math.max(1, Number(value ?? 50) || 50));

const pushSubscriptionInput = (body: any) => {
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    !endpoint.startsWith("https://") ||
    endpoint.length > 4096 ||
    typeof p256dh !== "string" ||
    !p256dh ||
    p256dh.length > 512 ||
    typeof auth !== "string" ||
    !auth ||
    auth.length > 512
  ) {
    throw new ApiError(400, "invalid_request", "Invalid push subscription");
  }
  return { endpoint, keys: { p256dh, auth } };
};

const pushInstallationInput = (body: any) => {
  const installationId = body?.installationId;
  const capability = body?.capability;
  if (
    typeof installationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      installationId,
    ) ||
    typeof capability !== "string" ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(capability)
  ) {
    throw new ApiError(400, "invalid_request", "Invalid push installation");
  }
  return { installationId, capability };
};

// DIDを持たない利用者向け。既存のこっそり投稿APIの認証は緩めず、短命な返信ジョブだけを
// 別の低レート経路で受ける。本文はタイムライン・検索・みんなで全肯定へ取り込まれない。
const guestAffirmationLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const guestCardLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
xrpc.post(
  `/${NAGI.createGuestAffirmation}`,
  guestAffirmationLimiter,
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await createGuestAffirmation(req.body));
    } catch (error) {
      next(error);
    }
  },
);
xrpc.post(`/${NAGI.getGuestAffirmation}`, async (req, res, next) => {
  try {
    res
      .set("Cache-Control", "private, no-store")
      .json(await getGuestAffirmation(req.body));
  } catch (error) {
    next(error);
  }
});
xrpc.post(`/${NAGI.deleteGuestAffirmation}`, async (req, res, next) => {
  try {
    res
      .set("Cache-Control", "private, no-store")
      .json(await deleteGuestAffirmation(req.body));
  } catch (error) {
    next(error);
  }
});
/**
 * 検索の 🔍一致 / botたんの気まぐれ の出し分け。未知の値は 400 にせず従来の hybrid に倒す
 * （古いクライアントや手打ちの URL を壊さない）。
 */
const searchMode = (value: unknown): SearchMode => {
  const raw = String(value ?? "");
  return raw === "exact" || raw === "semantic" ? raw : "hybrid";
};

xrpc.get(
  `/${NAGI.getCommunityAffirmations}`,
  requiredServiceAuth(NAGI.getCommunityAffirmations),
  async (req, res, next) => {
    try {
      const lang = String(req.query.lang ?? "ja");
      if (lang !== "ja" && lang !== "en")
        throw new ApiError(400, "invalid_request", "lang must be ja or en");
      const data = await getCommunityAffirmations({
        viewerDid: req.viewerDid!,
        lang,
        limit: Math.min(20, limit(req.query.limit)),
        cursor: String(req.query.cursor ?? "") || undefined,
      });
      res.set("Cache-Control", "private, no-store").json(data);
    } catch (error) {
      next(error);
    }
  },
);

xrpc.post(
  `/${NAGI.putCommunityAffirmationDismissals}`,
  requiredServiceAuth(NAGI.putCommunityAffirmationDismissals),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(
          await putCommunityAffirmationDismissals(req.viewerDid!, req.body),
        );
    } catch (error) {
      next(error);
    }
  },
);

xrpc.get(
  `/${NAGI.getDrafts}`,
  requiredServiceAuth(NAGI.getDrafts),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getDrafts(req.viewerDid!));
    } catch (error) {
      next(error);
    }
  },
);
xrpc.get(
  `/${NAGI.getDraft}`,
  requiredServiceAuth(NAGI.getDraft),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getDraft(req.viewerDid!, req.query.id));
    } catch (error) {
      next(error);
    }
  },
);
xrpc.post(
  `/${NAGI.putDraft}`,
  requiredServiceAuth(NAGI.putDraft),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await putDraft(req.viewerDid!, req.body));
    } catch (error) {
      next(error);
    }
  },
);
xrpc.post(
  `/${NAGI.deleteDraft}`,
  requiredServiceAuth(NAGI.deleteDraft),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await deleteDraft(req.viewerDid!, req.body?.id));
    } catch (error) {
      next(error);
    }
  },
);

xrpc.get(
  `/${NAGI.getHomeTimeline}`,
  requiredServiceAuth(NAGI.getHomeTimeline),
  async (req, res, next) => {
    try {
      const data = await getTimeline({
        limit: limit(req.query.limit),
        cursor: String(req.query.cursor ?? "") || undefined,
        viewerDid: req.viewerDid!,
        homeDid: req.viewerDid!,
        group: true,
      });
      res.set("Cache-Control", "private, no-store").json(data);
    } catch (e) {
      next(e);
    }
  },
);

// こっそり投稿は PDS レコードにせず AppView だけが持つので、com.atproto.repo.createRecord
// ではなくここを通す。ミュートや非公開リストと同じ「他人に見せてはならないデータ」の扱い。
xrpc.post(
  `/${NAGI.createKossoriPost}`,
  requiredServiceAuth(NAGI.createKossoriPost),
  async (req, res, next) => {
    try {
      const created = await createKossoriPost(req.viewerDid!, req.body ?? {});
      res.set("Cache-Control", "private, no-store").json(created);
    } catch (e) {
      next(e);
    }
  },
);

xrpc.post(
  `/${NAGI.deleteKossoriPost}`,
  requiredServiceAuth(NAGI.deleteKossoriPost),
  async (req, res, next) => {
    try {
      const uri = req.body?.uri;
      if (typeof uri !== "string")
        throw new ApiError(400, "invalid_request", "uri is required");
      res
        .set("Cache-Control", "private, no-store")
        .json(await deleteKossoriPost(req.viewerDid!, uri));
    } catch (e) {
      next(e);
    }
  },
);

xrpc.post(
  `/${NAGI.ensureRecord}`,
  requiredServiceAuth(NAGI.ensureRecord),
  async (req, res, next) => {
    try {
      const uri = req.body?.uri;
      const expectedCid = req.body?.cid;
      if (typeof uri !== "string" || typeof expectedCid !== "string")
        throw new ApiError(400, "invalid_request", "uri and cid are required");
      const parsed = parseRecordUri(uri);
      if (!parsed)
        throw new ApiError(400, "invalid_request", "Invalid record URI");
      const { did, collection, rkey } = parsed;
      if (did !== req.viewerDid)
        throw new ApiError(403, "forbidden", "Record owner does not match");
      if (!isReconcilableCollection(did, collection))
        throw new ApiError(
          400,
          "invalid_request",
          "Collection is not supported",
        );

      const ensured = await ensurePdsRecord(did, collection, rkey);
      if (ensured.status === "present" && ensured.record.uri !== uri)
        throw new ApiError(
          409,
          "invalid_record",
          "PDS returned a different record URI",
        );
      prioritizeReconcile(did);
      // 削除直後の呼び出しでは PDS にレコードが無い。AppView 側は削除を適用済みなので
      // 「PDS と一致した」意味で indexed を返し、cid は入力値をそのまま返す
      // （lexicon が cid 必須のため。スキーマを変えず削除も同じ経路で扱えるようにする）。
      res.set("Cache-Control", "private, no-store").json({
        uri,
        cid: ensured.status === "present" ? ensured.record.cid : expectedCid,
        indexed: true,
      });
    } catch (e) {
      next(e);
    }
  },
);
for (const [nsid, affirmation] of [
  [NAGI.getTimeline, false],
  [NAGI.getAffirmation, true],
] as const)
  xrpc.get(`/${nsid}`, optionalServiceAuth(nsid), async (req, res, next) => {
    try {
      const data = await getTimeline({
        limit: limit(req.query.limit),
        cursor: String(req.query.cursor ?? "") || undefined,
        viewerDid: req.viewerDid,
        affirmation,
        // 会話グループ化はメイン共有TLのみ。全肯定TLは Phase 2 まで従来表示。
        group: !affirmation,
      });
      res
        .set(
          "Cache-Control",
          req.viewerDid ? "private, no-store" : "public, max-age=15",
        )
        .json(data);
    } catch (e) {
      next(e);
    }
  });
xrpc.get(
  `/${NAGI.getThread}`,
  optionalServiceAuth(NAGI.getThread),
  async (req, res, next) => {
    try {
      res
        .set(
          "Cache-Control",
          req.viewerDid ? "private, no-store" : "public, max-age=15",
        )
        .json(await getThread(String(req.query.uri ?? ""), req.viewerDid));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getProfile}`,
  optionalServiceAuth(NAGI.getProfile),
  async (req, res, next) => {
    try {
      const actorParam = String(req.query.actor ?? "");
      if (!actorParam)
        throw new ApiError(400, "invalid_request", "actor is required");
      const actor = await resolveActorDid(actorParam);
      const filter = String(req.query.filter ?? "posts");
      if (!["posts", "replies", "media", "reactions"].includes(filter))
        throw new ApiError(400, "invalid_request", "Invalid filter");
      const cursor = String(req.query.cursor ?? "") || undefined;
      const group = String(req.query.group ?? "false") === "true";
      const lang = String(req.query.lang ?? "ja");
      if (lang !== "ja" && lang !== "en")
        throw new ApiError(400, "invalid_request", "lang must be ja or en");
      const [profile, feed] = await Promise.all([
        getActorProfile(actor, lang),
        filter === "reactions"
          ? getReactedFeed({
              actorDid: actor,
              limit: limit(req.query.limit),
              cursor,
              viewerDid: req.viewerDid,
              lang,
            })
          : getTimeline({
              limit: limit(req.query.limit),
              cursor,
              actorDid: actor,
              viewerDid: req.viewerDid,
              filter: filter as "posts" | "replies" | "media",
              group,
            }),
      ]);
      res
        .set(
          "Cache-Control",
          req.viewerDid ? "private, no-store" : "public, max-age=15",
        )
        .json({ profile, feed });
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(`/${NAGI.getProfileWebsite}`, async (req, res, next) => {
  try {
    const actorParam = String(req.query.actor ?? "");
    if (!actorParam)
      throw new ApiError(400, "invalid_request", "actor is required");
    const did = await resolveActorDid(actorParam);
    const card = await getProfileWebsiteCard(did);
    res.set("Cache-Control", "public, max-age=60").json({ card });
  } catch (e) {
    next(e);
  }
});
xrpc.get(
  `/${NAGI.getChannels}`,
  optionalServiceAuth(NAGI.getChannels),
  async (req, res, next) => {
    try {
      const rawView = String(req.query.view ?? "trend");
      const view = (["trend", "list", "mine"] as const).find(
        (candidate) => candidate === rawView,
      );
      if (!view) throw new ApiError(400, "invalid_request", "view is invalid");
      if ((view === "list" || view === "mine") && !req.viewerDid)
        throw new ApiError(
          401,
          "authentication_required",
          "Authentication required",
        );
      res
        .set(
          "Cache-Control",
          view === "list" || view === "mine" || req.viewerDid
            ? "private, no-store"
            : "public, max-age=15",
        )
        .json(
          await getChannels({
            limit: limit(req.query.limit),
            cursor: String(req.query.cursor ?? "") || undefined,
            viewerDid: req.viewerDid,
            view,
          }),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.searchChannels}`,
  optionalServiceAuth(NAGI.searchChannels),
  async (req, res, next) => {
    try {
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 200);
      if (!q) throw new ApiError(400, "invalid_request", "q is required");
      const typeahead = String(req.query.typeahead ?? "") === "true";
      res
        .set(
          "Cache-Control",
          // 候補は打鍵ごとに叩かれるので、ビューア付きでも15秒だけブラウザに持たせる
          // （private なので PDS プロキシを含む共有キャッシュには乗らない）。
          req.viewerDid
            ? typeahead
              ? "private, max-age=15"
              : "private, no-store"
            : "public, max-age=15",
        )
        .json(
          await (typeahead
            ? searchChannelsTypeahead({
                q,
                limit: Math.min(10, limit(req.query.limit)),
                viewerDid: req.viewerDid,
              })
            : searchChannels({
                q,
                mode: searchMode(req.query.mode),
                limit: limit(req.query.limit),
                cursor: String(req.query.cursor ?? "") || undefined,
                viewerDid: req.viewerDid,
              })),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getChannel}`,
  optionalServiceAuth(NAGI.getChannel),
  async (req, res, next) => {
    try {
      const uri = String(req.query.uri ?? "");
      if (!uri) throw new ApiError(400, "invalid_request", "uri is required");
      const channel = await getChannel(uri, req.viewerDid);
      if (!channel) throw new ApiError(404, "not_found", "Channel not found");
      res
        .set(
          "Cache-Control",
          req.viewerDid ? "private, no-store" : "public, max-age=15",
        )
        .json({ channel });
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getChannelTimeline}`,
  optionalServiceAuth(NAGI.getChannelTimeline),
  async (req, res, next) => {
    try {
      const uri = String(req.query.uri ?? "");
      if (!uri) throw new ApiError(400, "invalid_request", "uri is required");
      const filter = String(req.query.filter ?? "posts");
      if (!["posts", "media"].includes(filter))
        throw new ApiError(400, "invalid_request", "Invalid filter");
      res
        .set(
          "Cache-Control",
          req.viewerDid ? "private, no-store" : "public, max-age=15",
        )
        .json(
          await getChannelTimeline({
            uri,
            limit: limit(req.query.limit),
            cursor: String(req.query.cursor ?? "") || undefined,
            viewerDid: req.viewerDid,
            filter: filter as "posts" | "media",
          }),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.searchPosts}`,
  optionalServiceAuth(NAGI.searchPosts),
  async (req, res, next) => {
    try {
      // 自由文検索(q)を優先。無ければ従来のタグ検索(tag)にフォールバック。
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 200);
      const tag = String(req.query.tag ?? "")
        .trim()
        .replace(/^[#＃]+/, "")
        .toLowerCase();
      if (!q && !tag) {
        throw new ApiError(400, "invalid_request", "q or tag is required");
      }
      const cacheControl = req.viewerDid
        ? "private, no-store"
        : "public, max-age=15";
      if (q) {
        res.set("Cache-Control", cacheControl).json(
          await searchPostsByText({
            q,
            mode: searchMode(req.query.mode),
            limit: limit(req.query.limit),
            cursor: String(req.query.cursor ?? "") || undefined,
            viewerDid: req.viewerDid,
          }),
        );
        return;
      }
      res.set("Cache-Control", cacheControl).json(
        await getTimeline({
          tag,
          limit: limit(req.query.limit),
          cursor: String(req.query.cursor ?? "") || undefined,
          viewerDid: req.viewerDid,
          searchResults: true,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.searchEmojis}`,
  optionalServiceAuth(NAGI.searchEmojis),
  async (req, res, next) => {
    try {
      res.set("Cache-Control", "public, max-age=60").json(
        await searchEmojis({
          q: String(req.query.q ?? "") || undefined,
          repo: String(req.query.repo ?? "") || undefined,
          excludeRepo: String(req.query.excludeRepo ?? "") || undefined,
          limit: limit(req.query.limit),
          cursor: String(req.query.cursor ?? "") || undefined,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getEmoji}`,
  optionalServiceAuth(NAGI.getEmoji),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "public, max-age=60")
        .json(await getEmoji(String(req.query.uri ?? "")));
    } catch (e) {
      next(e);
    }
  },
);
// 任意アプリ連携のためのスキーマ解決。認証不要の公開クエリ（PDS プロキシを経由せず
// AppView へ直接呼ばれる）。DNS 解決を伴うため専用のレート制限を掛ける。
const resolveLexiconLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
xrpc.get(
  `/${NAGI.resolveLexicon}`,
  resolveLexiconLimiter,
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "public, max-age=300")
        .json(await resolveLexicon(String(req.query.nsid ?? "")));
    } catch (e) {
      next(e);
    }
  },
);
// アプリのアイコン（favicon）解決。外部ページを fetch するので同じレート制限を掛ける。
// 連携設定時に1回だけ呼ばれ、結果は appLinks レコードへ保存される想定。
xrpc.get(
  `/${NAGI.getAppIcon}`,
  resolveLexiconLimiter,
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "public, max-age=3600")
        .json(await getAppIcon(String(req.query.url ?? "")));
    } catch (e) {
      next(e);
    }
  },
);
// 日記は基本的に公開コンテンツ（Bluesky 側が公開リプライなのと同じ）なので認証は任意。
// ただしこっそり投稿を含む日の日記は本人にしか本文を返さないので、居るなら viewerDid を
// 使う。必須にはしない: 未認証でも日付と件数（＝コミットグラフ）は従来どおり見せたいのと、
// permission set の反映には最大24hかかるため、その間も 401 にせず伏せる側へ倒す。
xrpc.get(
  `/${NAGI.getDiaries}`,
  optionalServiceAuth(NAGI.getDiaries),
  async (req, res, next) => {
    try {
      res
        .set(
          "Cache-Control",
          // viewer 依存の出し分けが入るので、認証付きの応答は共有キャッシュに載せない。
          req.viewerDid ? "private, no-store" : "public, max-age=60",
        )
        .json(
          await getDiaries({
            actor: String(req.query.actor ?? ""),
            month: String(req.query.month ?? "") || undefined,
            from: String(req.query.from ?? "") || undefined,
            to: String(req.query.to ?? "") || undefined,
            limit: limit(req.query.limit),
            cursor: String(req.query.cursor ?? "") || undefined,
            viewerDid: req.viewerDid,
          }),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getPositiveNews}`,
  optionalServiceAuth(NAGI.getPositiveNews),
  async (req, res, next) => {
    try {
      const lang = String(req.query.lang ?? "ja");
      if (lang !== "ja" && lang !== "en")
        throw new ApiError(400, "invalid_request", "lang must be ja or en");
      res
        .set(
          "Cache-Control",
          req.viewerDid ? "private, no-store" : "public, max-age=60",
        )
        .json(
          await getPositiveNews({
            limit: Math.min(20, limit(req.query.limit)),
            cursor: String(req.query.cursor ?? "") || undefined,
            lang,
            viewerDid: req.viewerDid,
          }),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.searchNews}`,
  optionalServiceAuth(NAGI.searchNews),
  async (req, res, next) => {
    try {
      const q = String(req.query.q ?? "")
        .trim()
        .slice(0, 200);
      if (!q) throw new ApiError(400, "invalid_request", "q is required");
      const lang = String(req.query.lang ?? "ja");
      if (lang !== "ja" && lang !== "en")
        throw new ApiError(400, "invalid_request", "lang must be ja or en");
      res
        .set(
          "Cache-Control",
          req.viewerDid ? "private, no-store" : "public, max-age=60",
        )
        .json(
          await searchNews({
            q,
            mode: searchMode(req.query.mode),
            limit: Math.min(20, limit(req.query.limit)),
            cursor: String(req.query.cursor ?? "") || undefined,
            lang,
            viewerDid: req.viewerDid,
          }),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getNewsSubmissionPreview}`,
  requiredServiceAuth(NAGI.getNewsSubmissionPreview),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getNewsSubmissionPreview(String(req.query.url ?? "")));
    } catch (error) {
      next(error);
    }
  },
);
xrpc.post(
  `/${NAGI.requestNewsReview}`,
  requiredServiceAuth(NAGI.requestNewsReview),
  async (req, res, next) => {
    try {
      const subject = req.body?.subject;
      if (
        !subject ||
        typeof subject.uri !== "string" ||
        typeof subject.cid !== "string"
      )
        throw new ApiError(
          400,
          "invalid_request",
          "subject StrongRef is required",
        );
      res
        .set("Cache-Control", "private, no-store")
        .json(await requestNewsReview(req.viewerDid!, subject));
    } catch (error) {
      next(error);
    }
  },
);
xrpc.get(
  `/${NAGI.getMyNewsSubmissions}`,
  requiredServiceAuth(NAGI.getMyNewsSubmissions),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(
          await getMyNewsSubmissions(
            req.viewerDid!,
            Math.min(20, limit(req.query.limit)),
          ),
        );
    } catch (error) {
      next(error);
    }
  },
);
xrpc.get(`/${NAGI.searchActors}`, async (req, res, next) => {
  try {
    const query = String(req.query.q ?? "");
    res
      .set("Cache-Control", "public, max-age=15")
      .json(
        await searchActors(
          query,
          Math.min(20, limit(req.query.limit)),
          searchMode(req.query.mode),
        ),
      );
  } catch (e) {
    next(e);
  }
});
xrpc.get(
  `/${NAGI.getNotifications}`,
  requiredServiceAuth(NAGI.getNotifications),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getNotifications(req.viewerDid!, limit(req.query.limit)));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getUnreadCount}`,
  requiredServiceAuth(NAGI.getUnreadCount),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getUnreadCount(req.viewerDid!));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.updateSeen}`,
  requiredServiceAuth(NAGI.updateSeen),
  async (req, res, next) => {
    try {
      const seenAt = new Date(req.body.seenAt);
      if (Number.isNaN(seenAt.valueOf()))
        throw new ApiError(400, "invalid_request", "Invalid seenAt");
      res.json(await updateSeen(req.viewerDid!, seenAt));
    } catch (e) {
      next(e);
    }
  },
);
// ミュートは非公開情報。requiredServiceAuth により、JWT で本人だと証明できたリクエストに
// しか返さない（他ユーザーが誰かのミュート一覧を引く経路は存在しない）。
xrpc.get(
  `/${NAGI.getMutes}`,
  requiredServiceAuth(NAGI.getMutes),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getMutesView(req.viewerDid!));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.setMute}`,
  requiredServiceAuth(NAGI.setMute),
  async (req, res, next) => {
    try {
      const subjectType = req.body?.subjectType;
      const subject = req.body?.subject;
      const muted = req.body?.muted;
      if (subjectType !== "actor" && subjectType !== "channel")
        throw new ApiError(400, "invalid_request", "Invalid subjectType");
      if (typeof subject !== "string" || !subject)
        throw new ApiError(400, "invalid_request", "subject is required");
      if (typeof muted !== "boolean")
        throw new ApiError(400, "invalid_request", "muted must be a boolean");
      res
        .set("Cache-Control", "private, no-store")
        .json(await setMute(req.viewerDid!, subjectType, subject, muted));
    } catch (e) {
      next(e);
    }
  },
);
// ホームリストは本人以外へ存在すら知らせない。owner DID は入力で受け取らず、
// requiredServiceAuth が検証した viewerDid だけを使用する。
xrpc.get(
  `/${NAGI.getPrivateList}`,
  requiredServiceAuth(NAGI.getPrivateList),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getPrivateList(req.viewerDid!));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.setPrivateListMember}`,
  requiredServiceAuth(NAGI.setPrivateListMember),
  async (req, res, next) => {
    try {
      const memberDid = req.body?.memberDid;
      const included = req.body?.included;
      if (typeof memberDid !== "string" || !memberDid)
        throw new ApiError(400, "invalid_request", "memberDid is required");
      if (typeof included !== "boolean")
        throw new ApiError(
          400,
          "invalid_request",
          "included must be a boolean",
        );
      res
        .set("Cache-Control", "private, no-store")
        .json(await setPrivateListMember(req.viewerDid!, memberDid, included));
    } catch (e) {
      next(e);
    }
  },
);

// ブックマークは保存対象そのものが閲覧履歴なので、全経路を本人限定・no-store に固定する。
xrpc.get(
  `/${NAGI.getBookmarkFolders}`,
  requiredServiceAuth(NAGI.getBookmarkFolders),
  async (req, res, next) => {
    try {
      const lang = String(req.query.lang ?? "ja");
      if (lang !== "ja" && lang !== "en")
        throw new ApiError(400, "invalid_request", "lang must be ja or en");
      res
        .set("Cache-Control", "private, no-store")
        .json(await getBookmarkFolders(req.viewerDid!, lang));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.putBookmarkFolder}`,
  requiredServiceAuth(NAGI.putBookmarkFolder),
  async (req, res, next) => {
    try {
      const lang = req.body?.lang === "en" ? "en" : "ja";
      res.set("Cache-Control", "private, no-store").json(
        await putBookmarkFolder(req.viewerDid!, {
          id: typeof req.body?.id === "string" ? req.body.id : undefined,
          name: req.body?.name,
          lang,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.deleteBookmarkFolder}`,
  requiredServiceAuth(NAGI.deleteBookmarkFolder),
  async (req, res, next) => {
    try {
      if (typeof req.body?.id !== "string")
        throw new ApiError(400, "invalid_request", "id is required");
      res
        .set("Cache-Control", "private, no-store")
        .json(await deleteBookmarkFolder(req.viewerDid!, req.body.id));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.getBookmarkStates}`,
  requiredServiceAuth(NAGI.getBookmarkStates),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getBookmarkStates(req.viewerDid!, req.body?.uris));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getBookmarks}`,
  requiredServiceAuth(NAGI.getBookmarks),
  async (req, res, next) => {
    try {
      const lang = String(req.query.lang ?? "ja");
      if (lang !== "ja" && lang !== "en")
        throw new ApiError(400, "invalid_request", "lang must be ja or en");
      res.set("Cache-Control", "private, no-store").json(
        await getBookmarks({
          ownerDid: req.viewerDid!,
          folderId: String(req.query.folderId ?? "") || undefined,
          cursor: String(req.query.cursor ?? "") || undefined,
          limit: Math.min(30, limit(req.query.limit)),
          lang,
          q:
            String(req.query.q ?? "")
              .trim()
              .slice(0, 200) || undefined,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.putBookmark}`,
  requiredServiceAuth(NAGI.putBookmark),
  async (req, res, next) => {
    try {
      if (
        typeof req.body?.folderId !== "string" ||
        typeof req.body?.subjectUri !== "string"
      )
        throw new ApiError(
          400,
          "invalid_request",
          "folderId and subjectUri are required",
        );
      res
        .set("Cache-Control", "private, no-store")
        .json(
          await putBookmark(
            req.viewerDid!,
            req.body.folderId,
            req.body.subjectUri,
          ),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.deleteBookmark}`,
  requiredServiceAuth(NAGI.deleteBookmark),
  async (req, res, next) => {
    try {
      if (typeof req.body?.subjectUri !== "string")
        throw new ApiError(400, "invalid_request", "subjectUri is required");
      res
        .set("Cache-Control", "private, no-store")
        .json(await deleteBookmark(req.viewerDid!, req.body.subjectUri));
    } catch (e) {
      next(e);
    }
  },
);
// 端末間で同期する設定。既読位置は「いつ何を読んだか」そのものなので、ミュートと同じく
// 本人以外へは一切出さない。DID は入力で受け取らず viewerDid だけを使う。
xrpc.get(
  `/${NAGI.getPreferences}`,
  requiredServiceAuth(NAGI.getPreferences),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await getPreferences(req.viewerDid!));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.putPreferences}`,
  requiredServiceAuth(NAGI.putPreferences),
  async (req, res, next) => {
    try {
      // 中身の検証は putPreferences 側にまとめてある（形が入れ子で長いため）。
      res
        .set("Cache-Control", "private, no-store")
        .json(await putPreferences(req.viewerDid!, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  },
);
// my Nagi の集約。本人のリストと購読状況が丸ごと出るので、必ず認証必須かつ no-store。
xrpc.get(
  `/${NAGI.getMyNagi}`,
  requiredServiceAuth(NAGI.getMyNagi),
  async (req, res, next) => {
    try {
      const raw = req.query.limit;
      res.set("Cache-Control", "private, no-store").json(
        await getMyNagi({
          viewerDid: req.viewerDid!,
          ...(raw === undefined ? {} : { limit: Number(raw) || undefined }),
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);
// 参加中チャンネルもホームリストと同じく本人だけのもの。owner DID は入力で受け取らない。
xrpc.post(
  `/${NAGI.setChannelSubscription}`,
  requiredServiceAuth(NAGI.setChannelSubscription),
  async (req, res, next) => {
    try {
      const uri = req.body?.uri;
      const subscribed = req.body?.subscribed;
      if (typeof uri !== "string" || !uri)
        throw new ApiError(400, "invalid_request", "uri is required");
      if (typeof subscribed !== "boolean")
        throw new ApiError(
          400,
          "invalid_request",
          "subscribed must be a boolean",
        );
      res
        .set("Cache-Control", "private, no-store")
        .json(await setChannelSubscription(req.viewerDid!, uri, subscribed));
    } catch (e) {
      next(e);
    }
  },
);
// カードの所持状況は公開情報（他人のコレクションも見える）なので optional 認証。
// 自分を指定したときだけ drawStatus が付くので、キャッシュは常に private にしておく。
xrpc.get(
  `/${NAGI.getCards}`,
  optionalServiceAuth(NAGI.getCards),
  async (req, res, next) => {
    try {
      const actor = String(req.query.actor ?? "");
      if (!actor)
        throw new ApiError(400, "invalid_request", "actor is required");
      res
        .set("Cache-Control", "private, no-store")
        .json(await getCards(actor, req.viewerDid));
    } catch (e) {
      next(e);
    }
  },
);
// DID をまだ持たない端末の通常枠。同じ端末秘密・同じ日付はDBの一意索引で同じ1枚へ収束する。
xrpc.post(
  `/${NAGI.drawGuestCard}`,
  guestCardLimiter,
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await drawGuestCard(req.body));
    } catch (e) {
      next(e);
    }
  },
);
// 抽選結果は入力に取らずサーバ側で決める。リアクション枠だけ、本人のPDSにある
// 当日リアクションURIを検証してから別枠を解放する。
xrpc.post(
  `/${NAGI.drawCard}`,
  requiredServiceAuth(NAGI.drawCard),
  async (req, res, next) => {
    try {
      const source = req.body?.source ?? "my_nagi";
      const reactionUri = req.body?.reactionUri;
      const guestToken = req.body?.guestToken;
      if (
        source !== "my_nagi" &&
        source !== "reaction" &&
        source !== "anniversary"
      )
        throw new ApiError(400, "invalid_request", "Invalid draw source");
      if (reactionUri !== undefined && typeof reactionUri !== "string")
        throw new ApiError(
          400,
          "invalid_request",
          "reactionUri must be a string",
        );
      if (guestToken !== undefined && typeof guestToken !== "string")
        throw new ApiError(
          400,
          "invalid_request",
          "guestToken must be a string",
        );
      // 記念日は抽選ではなく「その日が記念日の人へ配る」ので、1日1回の枠とは別経路。
      res
        .set("Cache-Control", "private, no-store")
        .json(
          source === "anniversary"
            ? await claimAnniversaryCards(req.viewerDid!)
            : await drawCard(req.viewerDid!, source, reactionUri, guestToken),
        );
    } catch (e) {
      next(e);
    }
  },
);
// 姉妹アプリへ「サインイン済みのまま」移動するためのチケットを発行する。
// 発行対象の DID は requiredServiceAuth が検証した viewerDid だけで、
// リクエストから DID を受け取らない（他人のチケットを作れる余地を残さない）。
xrpc.post(
  `/${NAGI.createSsoTicket}`,
  requiredServiceAuth(NAGI.createSsoTicket),
  async (req, res, next) => {
    try {
      // 鍵が未設定なら発行できないことを明示する。クライアントはこれを見て
      // ?did= ヒント経路へフォールバックする。
      if (!ssoTicketEnabled()) {
        return res.status(501).json({
          error: "NotConfigured",
          message: "SSO ticket issuing is not configured",
        });
      }
      const audience = req.body?.audience;
      if (typeof audience !== "string" || !audience) {
        return res
          .status(400)
          .json({ error: "InvalidRequest", message: "audience is required" });
      }
      // 許可リスト外は 400。ここを緩めるとオープンリダイレクタになる。
      if (!isAllowedAudience(audience)) {
        return res.status(400).json({
          error: "InvalidRequest",
          message: "audience is not allowed",
        });
      }
      res
        .set("Cache-Control", "private, no-store")
        .json(await createSsoTicket(req.viewerDid!, audience));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.registerPushSubscription}`,
  requiredServiceAuth(NAGI.registerPushSubscription),
  async (req, res, next) => {
    try {
      if (!config.vapid)
        throw new ApiError(
          503,
          "push_unavailable",
          "Push notification delivery is not configured",
        );
      const sub = pushSubscriptionInput(req.body);
      const hasInstallation =
        req.body?.installationId !== undefined ||
        req.body?.capability !== undefined;
      const installation = hasInstallation
        ? pushInstallationInput(req.body)
        : undefined;
      const result = await upsertSubscription(
        req.viewerDid!,
        sub,
        installation,
      );
      if (!result.registered)
        throw new ApiError(
          409,
          result.reason,
          result.reason === "endpoint_conflict"
            ? "Push endpoint belongs to another account"
            : "Push installation belongs to another account",
        );
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.deletePushSubscription}`,
  requiredServiceAuth(NAGI.deletePushSubscription),
  async (req, res, next) => {
    try {
      const endpoint = req.body?.endpoint;
      if (typeof endpoint !== "string")
        throw new ApiError(400, "invalid_request", "Invalid endpoint");
      res.json(await invalidateOwnSubscription(req.viewerDid!, endpoint));
    } catch (e) {
      next(e);
    }
  },
);
// capabilityは十分なエントロピーを持つinstallation固有のbearer秘密。OAuth sessionを持てない
// Service Workerでも、紐付くDIDを変更せず自分のPush endpointだけをローテーションできる。
xrpc.post(`/${NAGI.refreshPushSubscription}`, async (req, res, next) => {
  try {
    if (!config.vapid)
      throw new ApiError(
        503,
        "push_unavailable",
        "Push notification delivery is not configured",
      );
    const result = await refreshSubscription(
      pushInstallationInput(req.body),
      pushSubscriptionInput(req.body),
    );
    if (!result.registered) {
      if (result.reason === "endpoint_conflict")
        throw new ApiError(
          409,
          "endpoint_conflict",
          "Push endpoint belongs to another installation",
        );
      throw new ApiError(
        401,
        "invalid_capability",
        "Push installation is no longer valid",
      );
    }
    res.set("Cache-Control", "private, no-store").json({ registered: true });
  } catch (error) {
    next(error);
  }
});
xrpc.post(`/${NAGI.deletePushInstallation}`, async (req, res, next) => {
  try {
    res
      .set("Cache-Control", "private, no-store")
      .json(await invalidateInstallation(pushInstallationInput(req.body)));
  } catch (error) {
    next(error);
  }
});
// 未サインインユーザーでも翻訳できるよう意図的に無認証にしている。
// キャッシュヒットまで一律に数えるHTTPリクエスト単位のLimiterは使わず、
// translation service がDB照会後の未生成投稿数だけをIP単位で制限する。
xrpc.post(`/${NAGI.translatePosts}`, async (req, res, next) => {
  try {
    res.json(
      await translatePosts(
        req.body?.uris,
        req.body?.targetLang,
        req.ip ?? "unknown",
        req.body?.cacheOnly === true,
      ),
    );
  } catch (e) {
    next(e);
  }
});
xrpc.post(`/${NAGI.translatePost}`, async (req, res, next) => {
  try {
    res.json(
      await translatePost(
        req.body?.uri,
        req.body?.targetLang,
        req.ip ?? "unknown",
      ),
    );
  } catch (e) {
    next(e);
  }
});
xrpc.get(
  `/${NAGI.getLinkMetadata}`,
  requiredServiceAuth(NAGI.getLinkMetadata),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(
          await getLinkMetadata(
            String(req.query.url ?? ""),
            String(req.query.fallback ?? "") === "true",
          ),
        );
    } catch (e) {
      next(e);
    }
  },
);
xrpc.get(
  `/${NAGI.getLinkThumbnail}`,
  requiredServiceAuth(NAGI.getLinkThumbnail),
  async (req, res, next) => {
    try {
      const thumbnail = await getLinkThumbnail(String(req.query.url ?? ""));
      res
        .set("Cache-Control", "private, no-store")
        .type(thumbnail.contentType)
        .send(Buffer.from(thumbnail.data));
    } catch (e) {
      next(e);
    }
  },
);
xrpc.post(
  `/${NAGI.deleteAccountData}`,
  requiredServiceAuth(NAGI.deleteAccountData),
  async (req, res, next) => {
    try {
      res
        .set("Cache-Control", "private, no-store")
        .json(await deleteAccountData(req.viewerDid!));
    } catch (e) {
      next(e);
    }
  },
);
