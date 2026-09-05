import axios from 'axios';
import { generateBotDiary } from '@bsky-affirmative-bot/bot-brain';
import { fetchDiaryData } from './diaryUtils.js';

export class ZennDiaryService {
  static async generateAndPostDiary(diaryCount: number): Promise<string | undefined> {
    const pat = process.env.GITHUB_PAT;
    const repo = process.env.GITHUB_DIARY_REPO;
    const zennUser = process.env.ZENN_USERNAME;

    if (!pat || !repo || !zennUser) {
      console.warn("[WARN][DIARY] GITHUB_PAT, GITHUB_DIARY_REPO, or ZENN_USERNAME is not set in environment.");
      return undefined;
    }

    const { dateStr, sinceDate, activityLogs, affirmationPosts, receivedReplies } = await fetchDiaryData('ja-JP');

    const slugDate = dateStr.replace(/\//g, '-');
    const slug = `diary-${slugDate}`;
    const path = `articles/${slug}.md`;

    console.log(`[INFO][DIARY] Gathering logs since ${sinceDate.toISOString()} for ${dateStr}...`);
    console.log(`[INFO][DIARY] Generating diary for Diary Day ${diaryCount}...`);

    const diaryResult = await generateBotDiary({
      dateStr,
      diaryDayCount: diaryCount,
      activityLogs,
      affirmationPosts,
      receivedReplies,
      langStr: "日本語",
    });

    const titleWithDay = `日記${diaryCount}日目: ${diaryResult.title}`;
    const markdownContent = `---
title: "${titleWithDay}"
emoji: "${diaryResult.emoji}"
type: "idea"
topics: ["bluesky", "bot", "日記"]
published: true
---
${diaryResult.content}

---
[全肯定botたんのBlueskyアカウントはこちら](https://bsky.app/profile/bot-tan.com)
`;

    const branch = process.env.GITHUB_DIARY_BRANCH;

    console.log(`[INFO][DIARY] Posting to GitHub repository ${repo}${branch ? ` (branch: ${branch})` : ''}...`);

    const url = `https://api.github.com/repos/${repo}/contents/${path}`;
    const base64Content = Buffer.from(markdownContent).toString('base64');

    try {
      const requestBody: Record<string, unknown> = {
        message: `feat: add diary for ${slugDate}`,
        content: base64Content,
      };

      if (branch) {
        requestBody.branch = branch;
      }

      await axios.put(url, requestBody, {
        headers: {
          Authorization: `token ${pat}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }
      });

      console.log(`[INFO][DIARY] Successfully posted diary to GitHub path: ${path}`);
      return `https://zenn.dev/${zennUser}/articles/${slug}`;
    } catch (e: any) {
      console.error("[ERROR][DIARY] Failed to push diary to GitHub API:", e.response?.data || e.message);
      throw e;
    }
  }
}
