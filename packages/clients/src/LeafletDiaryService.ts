import { AtpAgent } from '@atproto/api';
import { TID } from '@atproto/common-web';
import { generateBotDiary } from '@bsky-affirmative-bot/bot-brain';
import { fetchDiaryData } from './diaryUtils.js';
import {
  buildStandardSiteDocument,
  findLeafletStandardPublication,
  STANDARD_SITE_DOCUMENT,
  standardSiteDocumentUrl,
} from './LeafletStandardSite.js';
import { trackedPutRecord } from './RepoWritePointService.js';
// Types derived from @atcute/leaflet (pub.leaflet lexicon)
type LeafletFacet = {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'pub.leaflet.richtext.facet#link'; uri: string }
    | { $type: 'pub.leaflet.richtext.facet#bold' }
    | { $type: 'pub.leaflet.richtext.facet#italic' }
    | { $type: 'pub.leaflet.richtext.facet#code' }
  >;
};
type LeafletBlockText = { $type: 'pub.leaflet.blocks.text'; plaintext: string; facets?: LeafletFacet[] };
type LeafletBlockHeader = { $type: 'pub.leaflet.blocks.header'; plaintext: string; level?: number; facets?: LeafletFacet[] };
type LeafletBlockHR = { $type: 'pub.leaflet.blocks.horizontalRule' };
type LeafletLinearBlock = { $type: 'pub.leaflet.pages.linearDocument#block'; block: LeafletBlockText | LeafletBlockHeader | LeafletBlockHR };

function parseInline(rawText: string): { plaintext: string; facets: LeafletFacet[] } {
  const facets: LeafletFacet[] = [];
  let plaintext = '';
  let i = 0;

  while (i < rawText.length) {
    // [text](url) link
    if (rawText[i] === '[') {
      const textEnd = rawText.indexOf(']', i + 1);
      if (textEnd !== -1 && rawText[textEnd + 1] === '(') {
        const urlEnd = rawText.indexOf(')', textEnd + 2);
        if (urlEnd !== -1) {
          const linkText = rawText.slice(i + 1, textEnd);
          const uri = rawText.slice(textEnd + 2, urlEnd);
          const byteStart = Buffer.byteLength(plaintext, 'utf8');
          plaintext += linkText;
          facets.push({
            index: { byteStart, byteEnd: Buffer.byteLength(plaintext, 'utf8') },
            features: [{ $type: 'pub.leaflet.richtext.facet#link', uri }],
          });
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // **bold** → strip markers, keep text
    if (rawText[i] === '*' && rawText[i + 1] === '*') {
      const end = rawText.indexOf('**', i + 2);
      if (end !== -1) { plaintext += rawText.slice(i + 2, end); i = end + 2; continue; }
    }
    // *italic* or _italic_
    if (rawText[i] === '*' || rawText[i] === '_') {
      const marker = rawText[i];
      const end = rawText.indexOf(marker, i + 1);
      if (end !== -1) { plaintext += rawText.slice(i + 1, end); i = end + 1; continue; }
    }
    // `code`
    if (rawText[i] === '`') {
      const end = rawText.indexOf('`', i + 1);
      if (end !== -1) { plaintext += rawText.slice(i + 1, end); i = end + 1; continue; }
    }
    plaintext += rawText[i];
    i++;
  }

  return { plaintext, facets };
}

function markdownToBlocks(md: string): LeafletLinearBlock[] {
  const blocks: LeafletLinearBlock[] = [];
  const lines = md.split('\n');
  let paraLines: string[] = [];
  let inCodeFence = false;

  function flushParagraph() {
    const raw = paraLines.join('\n').trim();
    paraLines = [];
    if (!raw) return;
    const { plaintext, facets } = parseInline(raw);
    if (!plaintext) return;
    const block: LeafletBlockText = {
      $type: 'pub.leaflet.blocks.text',
      plaintext,
      ...(facets.length > 0 && { facets }),
    };
    blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block', block });
  }

  for (const line of lines) {
    if (line.startsWith('```')) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence) { paraLines.push(line); continue; }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      flushParagraph();
      const { plaintext, facets } = parseInline(headingMatch[2]);
      const block: LeafletBlockHeader = {
        $type: 'pub.leaflet.blocks.header',
        level: headingMatch[1].length,
        plaintext,
        ...(facets.length > 0 && { facets }),
      };
      blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block', block });
      continue;
    }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      flushParagraph();
      const block: LeafletBlockHR = { $type: 'pub.leaflet.blocks.horizontalRule' };
      blocks.push({ $type: 'pub.leaflet.pages.linearDocument#block', block });
      continue;
    }

    if (line.trim() === '') { flushParagraph(); continue; }

    paraLines.push(line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, ''));
  }
  flushParagraph();

  return blocks;
}

export class LeafletDiaryService {
  static async generateAndPostDiary(agent: AtpAgent, diaryCount: number, lang: 'en' | 'ja' = 'en'): Promise<string | undefined> {
    const leafletUser = process.env.LEAFLET_USERNAME;
    const botDid = agent.session?.did;

    if (!leafletUser) {
      console.warn("[WARN][LEAFLET] LEAFLET_USERNAME is not set in environment.");
      return undefined;
    }

    if (!botDid) {
      console.warn("[WARN][LEAFLET] AtpAgent is not authenticated. Session DID is missing.");
      return undefined;
    }

    // Resolve the publication before generating paid content. A document without
    // this relationship is valid as a loose standard.site document, but it would
    // not appear in Bot-tan's Leaflet publication.
    const publication = await findLeafletStandardPublication(
      agent,
      botDid,
      process.env.LEAFLET_PUBLICATION_URL,
    );

    const isJa = lang === 'ja';
    const locale = isJa ? 'ja-JP' : 'en-US';
    const langStr = isJa ? "日本語" : "English";
    const langLabel = isJa ? "Japanese" : "English";

    const { dateStr, sinceDate, activityLogs, affirmationPosts, receivedReplies } = await fetchDiaryData(locale);

    console.log(`[INFO][LEAFLET] Gathering logs since ${sinceDate.toISOString()} for ${dateStr} (${langLabel})...`);
    console.log(`[INFO][LEAFLET] Generating ${langLabel} diary for Diary Day ${diaryCount}...`);

    const diaryResult = await generateBotDiary({
      dateStr,
      diaryDayCount: diaryCount,
      activityLogs,
      affirmationPosts,
      receivedReplies,
      langStr,
    });

    console.log(
      `[INFO][LEAFLET] Using standard.site publication: ${publication.uri} (URL: ${publication.value.url})`,
    );

    const rkey = TID.nextStr();
    const titleWithDay = isJa
      ? `日記${diaryCount}日目: ${diaryResult.title}`
      : `Diary Day ${diaryCount}: ${diaryResult.title}`;
    const footer = isJa
      ? `\n\n---\n[全肯定botたんのBlueskyアカウントはこちら](https://bsky.app/profile/bot-tan.com)`
      : `\n\n---\n[Follow Affirmative Bot-tan on Bluesky!](https://bsky.app/profile/bot-tan.com)`;
    const markdownContent = `${diaryResult.content}${footer}`;

    const pages = [
      {
        $type: "pub.leaflet.pages.linearDocument",
        blocks: markdownToBlocks(markdownContent),
      },
    ];
    const record = buildStandardSiteDocument({
      rkey,
      site: publication.uri,
      title: titleWithDay,
      description: diaryResult.title,
      publishedAt: new Date().toISOString(),
      pages,
    });

    console.log(`[INFO][LEAFLET] Publishing ${STANDARD_SITE_DOCUMENT} record to PDS with rkey: ${rkey}...`);

    try {
      await trackedPutRecord(agent, {
        repo: botDid,
        collection: STANDARD_SITE_DOCUMENT,
        rkey,
        validate: false,
        record,
      }, "standard.site.diary");

      const leafletUrl = standardSiteDocumentUrl(publication.value.url, rkey);

      console.log(`[INFO][LEAFLET] Successfully published diary to Leaflet.pub: ${leafletUrl}`);
      return leafletUrl;
    } catch (e: any) {
      console.error(`[ERROR][LEAFLET] Failed to create ${STANDARD_SITE_DOCUMENT} record on PDS:`, e.message);
      throw e;
    }
  }
}
