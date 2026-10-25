import { CommitCreateEvent } from "@skyware/jetstream";
import { AppBskyActorDefs } from "@atproto/api";
import { AppBskyFeedPost } from "@atproto/api";
import { getLangStr, uniteDidNsidRkey } from "../bsky/util.js";
import { postContinuous } from "../bsky/postContinuous.js";
import { loadPreferredName } from "@bsky-affirmative-bot/clients";
import {
  THREE_WAY_LABEL_VERSION,
  createPredefinedReply,
  isLlmPolarityClassification,
} from "@bsky-affirmative-bot/bot-brain/predefined-reply-pipeline";
import { recordPolaritySample } from "@bsky-affirmative-bot/database";

type ProfileView = AppBskyActorDefs.ProfileView;
type Record = AppBskyFeedPost.Record;

export async function replyRandom(
  follower: ProfileView,
  event: CommitCreateEvent<"app.bsky.feed.post">,
) {
  const record = event.commit.record as Record;
  const uri = uniteDidNsidRkey(
    follower.did,
    event.commit.collection,
    event.commit.rkey,
  );
  const cid = event.commit.cid;
  const postText = record.text;
  const languageName = getLangStr(record.langs);

  if (process.env.NODE_ENV === "development") {
    console.log("[DEBUG] user>>> " + postText);
    console.log("[DEBUG] lang: " + languageName);
  }

  const preferredName = await loadPreferredName(follower.did);
  const reply = await createPredefinedReply(
    {
      text: postText,
      languageName,
      displayName: preferredName || follower.displayName || follower.handle,
    },
    { surface: "bsky" },
    {
      // 3値分類を埋め込み＋軽い分類器へ移すための教師データ。LLM の判定だけを積む。
      onClassified: (classification) => {
        if (!isLlmPolarityClassification(classification)) return;
        recordPolaritySample({
          text: postText,
          languageName,
          label: classification.label,
          labelVersion: THREE_WAY_LABEL_VERSION,
        });
      },
    },
  );
  await postContinuous(reply, { uri, cid, record });
  return null;
}
