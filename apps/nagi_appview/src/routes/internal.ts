import { Router } from "express";
import { cidForCbor } from "@atproto/common";
import { db, nagiNotifications } from "@bsky-affirmative-bot/database";
import {
  BLUEMOJI_NAME_RE,
  NAGI,
  appviewRecordUri,
} from "@bsky-affirmative-bot/nagi-lexicon";
import { config } from "../config.js";
import { applyMutation } from "../ingest/applyMutation.js";
import { createKossoriPost } from "../queries/kossoriPosts.js";
import { dispatchPush } from "../services/pushDispatch.js";
import { resolveEmojiAliases } from "../services/emoji.js";
import {
  isNagiPostUri,
  normalizeSeedEntries,
  seedAuthoredTranslations,
} from "../services/translation.js";

/**
 * サービス間通信専用のルーター。ユーザー向け XRPC とは違い service auth を持たない。
 *
 * 認可は「127.0.0.1 にしか束縛しない」ことだけで担保する（index.ts で公開ポートとは
 * 別のリスナーに載せる）。nagi_bot_server の内部 HTTP と同じやり方で、共有シークレットを
 * 環境変数で配るより OS に閉じてもらうほうが確実だし、覚える設定も増えない。
 *
 * ⚠ このルーターを公開リスナー側に mount してはいけない。認可が消える。
 */
export const internal = Router();

/** botたんの生成文に含まれる Bluemoji エイリアスを投稿前に一括解決する。 */
internal.post("/emoji/resolve-aliases", async (req, res, next) => {
  try {
    const aliases = req.body?.aliases;
    if (
      !Array.isArray(aliases) ||
      aliases.length > 100 ||
      aliases.some(
        (alias) =>
          !alias ||
          typeof alias !== "object" ||
          typeof alias.name !== "string" ||
          !BLUEMOJI_NAME_RE.test(alias.name) ||
          (alias.preferredUri !== undefined &&
            (typeof alias.preferredUri !== "string" ||
              !alias.preferredUri.startsWith("at://"))),
      )
    ) {
      res.status(400).json({ error: "aliases must be valid Bluemoji names" });
      return;
    }
    res.status(200).json({ aliases: await resolveEmojiAliases(aliases) });
  } catch (e) {
    next(e);
  }
});

/**
 * 自動分析（名刺）の更新通知を作る。
 *
 * 他の通知はすべて Jetstream ingest が作るが、分析結果は PDS レコードではなく AppView の
 * Postgres にしか無いので ingest イベントが発生しない。生成側（nagi_bot_server）から
 * ここを叩いてもらうことで、通知行の挿入と Web Push の送出は AppView が持ち続ける。
 */
internal.post("/notifications/analysis", async (req, res, next) => {
  try {
    const did = String(req.body?.did ?? "");
    const updatedAt = String(req.body?.updatedAt ?? "");
    if (!did.startsWith("did:")) {
      res.status(400).json({ error: "did is required" });
      return;
    }
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) {
      res.status(400).json({ error: "updatedAt must be an ISO timestamp" });
      return;
    }

    // reasonUri に updatedAt を含めることで、(recipientDid, reasonUri) の unique index が
    // そのまま「同じ分析では通知を増やさない」冪等性になる。分析が再実行されれば
    // updatedAt が変わるので新しい通知が1件出る。
    const inserted = await db
      .insert(nagiNotifications)
      .values({
        recipientDid: did,
        type: "analysis",
        actorDid: config.botDid,
        subjectUri: `at://${did}`,
        reasonUri: `at://${did}/analysis/${updatedAt}`,
      })
      .onConflictDoNothing()
      .returning({ id: nagiNotifications.id });

    if (!inserted.length) {
      res.status(200).json({ created: false });
      return;
    }

    // ingest 側と同じく fire-and-forget。プッシュの失敗で通知そのものを取り消さない。
    void dispatchPush({
      recipientDid: did,
      type: "analysis",
      actorDid: config.botDid,
      notificationId: inserted[0].id,
    });

    res.status(200).json({ created: true, notificationId: inserted[0].id });
  } catch (e) {
    next(e);
  }
});

/**
 * botたん本人が生成した対訳を翻訳キャッシュへ投入する。
 *
 * 定時投稿は Gemini が textJa と textEn を同時に生成しているのに、Nagi へは日本語しか
 * 投げていなかったため、英語圏のユーザーには機械翻訳が表示されていた。投稿と同時に
 * ここへ本物の英文を渡してもらうことで、追加のLLMコストなしで本人の声のまま届く。
 *
 * 投稿レコードがまだ ingest されていなくても投入できる（translations に posts への
 * 外部キーは無い）。むしろ ingest 直後の英訳プリウォームより先に入れたい。
 */
internal.post("/translations", async (req, res, next) => {
  try {
    const uri = req.body?.uri;
    const entries = normalizeSeedEntries(req.body?.translations);
    if (!isNagiPostUri(uri) || !entries.length) {
      res.status(400).json({ error: "uri and translations are required" });
      return;
    }
    res.status(200).json({ seeded: await seedAuthoredTranslations(uri, entries) });
  } catch (e) {
    next(e);
  }
});

/**
 * こっそりスレッドへの botたんの返信。
 *
 * 通常の返信は bot が自分の PDS に書いて firehose 経由で入ってくるが、それだと返信本文が
 * bot の公開リポジトリから誰でも読めてしまう。こっそりスレッドの返信だけはここを通し、
 * 親の投稿と同じく AppView にだけ置く。
 */
internal.post("/kossori-replies", async (req, res, next) => {
  try {
    const reply = req.body?.reply;
    const text = req.body?.text;
    if (
      typeof text !== "string" ||
      typeof reply?.root?.uri !== "string" ||
      typeof reply?.parent?.uri !== "string"
    ) {
      res.status(400).json({ error: "text and reply are required" });
      return;
    }
    const created = await createKossoriPost(config.botDid, {
      text,
      ...(req.body?.facets !== undefined ? { facets: req.body.facets } : {}),
      langs: req.body?.langs,
      createdAt: req.body?.createdAt ?? new Date().toISOString(),
      reply,
      // ジョブのリトライで返信が二重にならないよう、rkey は呼び出し元が決める。
      rkey: typeof req.body?.rkey === "string" ? req.body.rkey : undefined,
    });
    res.status(200).json(created);
  } catch (e) {
    next(e);
  }
});

/**
 * こっそり投稿を含む日の日記。
 *
 * 日記は botたんの PDS に置くレコードなので、そのままだとこっそりの内容を要約した本文が
 * 公開リポジトリに出てしまう。プライベート日記だけはここを通して AppView にだけ置く。
 * 取り込み・通知・Web Push は applyMutation の日記分岐がそのまま担う。
 */
internal.post("/diaries", async (req, res, next) => {
  try {
    const record = req.body?.record;
    const rkey = req.body?.rkey;
    if (typeof rkey !== "string" || !record || typeof record !== "object") {
      res.status(400).json({ error: "rkey and record are required" });
      return;
    }
    const value = { ...record, $type: NAGI.diary, isPrivate: true };
    const cid = (await cidForCbor(value)).toString();
    await applyMutation(
      {
        did: config.botDid,
        time_us: Date.now() * 1_000,
        commit: {
          operation: "create",
          collection: NAGI.diary,
          rkey,
          cid,
          record: value,
        },
      },
      { appviewOnly: true, emitPush: true },
    );
    res.status(200).json({ uri: appviewRecordUri(NAGI.diary, rkey), cid });
  } catch (e) {
    next(e);
  }
});
