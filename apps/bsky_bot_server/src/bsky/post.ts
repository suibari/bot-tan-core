import { AppBskyFeedPost } from "@atproto/api"; type Record = AppBskyFeedPost.Record;
import { recordRepoWritePoint } from '@bsky-affirmative-bot/clients';
import { agent } from './agent.js';
import { AppBskyRichtextFacet, BlobRef, RichText } from "@atproto/api";
import ogs from 'open-graph-scraper'; // ← これを使ってOGP取得
import { assertPublicUrl, safeFetch, sanitizeBotPostFacets } from "@bsky-affirmative-bot/shared-configs";

export interface PostOptions {
  /** メンションとして残してよい DID。返信相手以外への通知を飛ばさないため。 */
  mentionDids?: readonly string[];
}

/**
 * postのオーバーライド
 * 開発環境ではなにもしない
 * @param {*} record 
 */
export async function post(record: Record, embedRecord?: Record, options: PostOptions = {}): Promise<{
  uri: string,
  cid: string,
}> {
  if (process.env.NODE_ENV === "production") {
    // リッチテキスト解釈。detectFacets の推測をそのまま使うと、名前に使ったハンドルが
    // リンクになったり、第三者へメンション通知が飛んだりするので、bot 投稿の規則で絞る。
    const rt = new RichText({ text: record.text });
    await rt.detectFacets(agent);
    record.text = rt.text;
    const facets = sanitizeBotPostFacets(rt.text, rt.facets, {
      allowedMentionDids: options.mentionDids,
    });
    record.facets = facets.length ? facets : undefined;

    // リンクカードは facet と同じ URL から選ぶ。本文を正規表現で拾い直すと、
    // URL の直後に続く日本語まで含んだ開けない URL で OGP を取りに行ってしまう。
    const urlMatch = facets
      .flatMap((facet) => facet.features)
      .flatMap((feature) => (AppBskyRichtextFacet.isLink(feature) ? [feature.uri] : []))
      .find(url => !url.includes(process.env.SPOTIFY_PLAYLIST_ID!)) ?? null; // Spotifyプレイリストのみは除外(なぜか404が返る)
    // embed: 引用ポスト付与
    if (embedRecord) {
      record.embed = embedRecord;
      // embed: リンクカード付与 (すでに画像などのembedがある場合は上書きしない)
    } else if (urlMatch && !record.embed) {
      const url = urlMatch;

      try {
        // open-graph-scraper が fetch する前にプライベート/ループバック宛てを拒否する。
        await assertPublicUrl(url);
        const { result } = await ogs({ url });
        if (result.success) {
          let thumbBlob: BlobRef | undefined = undefined;
          const imageUrl = result.ogImage?.[0]?.url;

          if (imageUrl) {
            try {
              const imageRes = await safeFetch(imageUrl);
              const arrayBuffer = await imageRes.arrayBuffer();
              const imageBuffer = Buffer.from(arrayBuffer);
              const contentType = imageRes.headers.get("content-type") || "image/jpeg";

              const response = await agent.uploadBlob(imageBuffer, {
                encoding: contentType,
              });
              thumbBlob = response.data.blob;
            } catch (err) {
              console.warn(`[WARN] Failed to upload image: ${imageUrl}`, err);
            }
          }

          record.embed = {
            $type: 'app.bsky.embed.external',
            external: {
              uri: url,
              title: result.ogTitle || url,
              description: result.ogDescription || '',
              thumb: thumbBlob,
            }
          };
        }
      } catch (err) {
        console.warn(`[WARN] Failed to fetch OGP for ${url}:`, err);
      }
    }

    // 投稿
    const response = await agent.post(record);
    await recordRepoWritePoint(agent.did, "create", "bsky.post");
    return {
      uri: response.uri,
      cid: response.cid,
    };
  }

  console.log(`[DEBUG] bot>>> ${record.text}`);
  return {
    uri: "dev-stub-uri",
    cid: "dev-stub-cid",
  };
}
