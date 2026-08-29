# Zenkoutei Bot-tan on Bluesky

[← Back to the Bot-tan Project README](../README.md) | [日本語](./bluesky-bot_ja.md)

![bot header](https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:qcwhrvzx6wmi5hz775uyi6fh/bafkreicd74lb33ywyc54lzgqfyotfuzs55x2cnxztpob5ifg2nr4kiji2e@jpeg)

[Zenkoutei Bot-tan](https://bsky.app/profile/bot-tan.com) is a Bluesky bot designed to send replies that completely affirm its followers. By combining a local LLM with generative AI, its goal is to encourage and uplift its followers.

---

## Overview

This repository contains the code and configuration files for Affirmation Bot-tan.
The bot has the following features:

1. **AI-generated replies**: Uses generative AI (Google Gemini) to reply to follower posts (text or images).
2. **Template replies**: Uses high-precision greeting rules followed by three-way sentiment classification on Gemma 3 4B. A response is randomly selected from the resulting category by default. Non-Japanese/English replies use an English template translated by the local LLM. See the [evaluation record](./evaluations/predefined-reply/2026-08-11-summary.md).
3. **Fortune-telling**: Provides fortunes upon user request and presents you with a "Lucky Badge" of the day (valid for 24 hours).
4. **Reply frequency adjustment**: Users can adjust how often the bot replies (0–100%).
5. **Conversation mode**: Allows continuous conversation with the bot.
6. **Personality analysis**: Analyzes your recent posts to generate a personality report image and gifts you a "Title Badge" (valid for 1 week).
7. **Promotion support (Cheering)**: Reposts user content with cheering messages to promote to all followers.
8. **DJ mode**: Recommends songs tailored to your mood from your recent posts, complete with YouTube video links.
9. **Diary mode**: Summarizes your daily posts and replies every evening at around 22:00 with a diary image and a daily "Title Badge" (valid for 24 hours).
10. **Anniversary mode**: Celebrates preset holidays, your personal registered anniversaries, and your Bluesky registration date. For personal registered anniversaries, it gifts you an "Anniversary Badge" (valid for 24 hours).
11. **Year Recap**: Collects your posts for the past year (up to 1,000 posts) and analyzes monthly activity, top words, and top interacted users to reply with a yearly summary image.
12. **Badge (Bluesky Label) Feature**: Gifts special badges and titles directly onto your Bluesky profile under specific conditions.

Joining the bot community unlocks additional features.

- 🎮 **Discord Community**: Join the [Bot-tan Discord Server](https://discord.gg/hshXWQEMgu) and link your Bluesky account to access the Diary feature, Cheering feature, Anniversary feature, Year Recap feature, and Team Affirmation Badge.
- 💖 **Subscription (Pixiv Fanbox)**: Support on [Fanbox](https://suibari.fanbox.cc/posts/10174305) to additionally access the Conversation feature and high-quality AI replies.

Below is a summary of features available at each tier.

| Tier | Template Replies | AI Replies | Fortune | Frequency Control | Conversation | Analysis | Cheering | DJ | Diary | Anniversary | Year Recap | Badges※1 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Regular Follower | ✓ | ✓※2 | ✓ | ✓ | | ✓ | | ✓ | | | | ✓ |
| Discord Member   | ✓ | ✓※2 | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Subscriber       | ✓ | ✓   | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

※1: Regular followers and Discord members can earn all badges except the Team Affirmation Badge. Discord members can also earn the Team Affirmation Badge.
※2: AI-generated replies for regular followers and Discord members occur randomly.

---

## How to Use
1. Follow the bot on Bluesky.
2. After some time, the bot will follow you back and start replying to your posts.

Unfollowing or blocking the bot will stop all future replies.

The flowchart below illustrates how the bot responds to your posts:

![bot flow](https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:uixgxpiqf4i63p6rgpu7ytmx/bafkreihxgiteyk25cpv3e7lkdsggntpb3jj6ybha4btq5ykf2fzdyq7j6u@jpeg)

### Fortune-telling
1. Make sure you are followed back by the bot.
2. Mention or reply to the bot with **"fortune"** (or "うらない", "占い", "占って", "うらなって").
3. The bot will reply with your fortune result. At the same time, you'll receive a **"Lucky Badge of the Day (valid for 24 hours)"** applied directly onto your Bluesky profile.

(*You can only use this once every **8 hours**.*)

### Reply Frequency Control
1. Make sure you are followed back by the bot.
2. Mention or reply with **"freqN"** (N = 0–100).
3. The bot will confirm your setting and adjust how frequently it replies to your normal posts.

### Conversation Mode
*(※Subscriber Member Only)*
1. Make sure you are followed back by the bot.
2. Reply to the bot within a thread where you are the thread root (main poster).
3. The bot will like your post.
4. The bot will reply.
5. If you reply to that, the conversation continues (repeating from step 3).

The flowchart below illustrates the Conversation Mode:

![Conversation Mode](https://cdn.bsky.app/img/feed_fullsize/plain/did:plc:qcwhrvzx6wmi5hz775uyi6fh/bafkreib5x75mtoy7md2eegafwgl6ug4vr23bwy7wyorqrmlwxbyhppzim4@jpeg)

### Personality Analysis
1. Make sure you are followed back by the bot.
2. Mention or reply to the bot with **"analyze me"** (or "分析して").
3. The bot will analyze your last 100 posts and 100 liked posts to reply with a personality report image. At the same time, you will receive a unique **"Title Badge (valid for 1 week)"** matching your analyzed personality!

(*You can only use this once every **6 days**.*)

### Promotion Support (Cheering)
*(※Discord Member or Subscriber Member Only)*
1. Make sure you are followed back by the bot.
2. Post with the hashtag **"#SuiBotCheerSquad"** (or **"#全肯定応援団"**) containing the text and/or images you want promoted (no need to reply directly to the bot).
3. The bot will evaluate the content and repost it with a cheering reply to promote it to other followers.
*Note: If the content is flagged as inappropriate or violates the safety policy, the bot may skip cheering.*

(*You can only use this once every **8 hours**.*)

### DJ Mode
1. Make sure you are followed back by the bot.
2. Mention or reply to the bot with **"DJ please"** (or "djお願い", "djおねがい", "dj頼む", "djたのむ", "dj, please").
3. The bot will analyze your recent posts to gauge your mood, recommend a matching song with a comment, and automatically search and provide a **YouTube video link** for the song.

(*You can only use this once every **5 minutes**.*)

### Diary Mode
*(※Discord Member or Subscriber Member Only)*
The bot will compile your posts of the day and send you a daily diary **every evening at around 22:00 local time**.

1. Make sure you are followed back by the bot.
2. Mention or reply to the bot with **"keep diary"** (or "keep a diary", "日記つけて", "日記をつけて", "日記を付けて", "日記付けて").
3. The bot will reply every evening with your customized diary image. At the same time, you'll be gifted a daily **"Title Badge (valid for 24 hours)"** summarizing your day (this will overwrite any title badge obtained from the Personality Analysis).
4. To stop the diary, mention or reply with **"stop diary"** (or "stop a diary", "日記やめて", "日記をやめて").

### Anniversary Mode
*(※Discord Member or Subscriber Member Only)*

When an anniversary arrives, the bot will celebrate it in reply to the first user post of that day.
There are three types of anniversaries: **preset anniversaries**, **your Bluesky registration date (auto-detected)**, and **user-registered anniversaries**.

* **Preset anniversaries** refer to common holidays such as Christmas or New Year’s Day. (New Year's Day triggers a special **Omikuji/Fortune Draw**).
* **Bluesky registration date** celebrates the day you joined Bluesky.
* **User-registered anniversaries** are personal anniversaries that each user can set once.

During celebration, the bot will search for your posts from the same date in the previous year and quote-repost it (if found) to reflect on old memories. Celebrating a user-registered anniversary also gifts you an **"Anniversary Badge (valid for 24 hours)"**.

You can register your user anniversary using the following steps:

1. Make sure you are followed back by the bot.
2. Post a mention or reply to this bot with **"Remember anniversary, MM/DD"** (or "記念日登録、MM/DD") (e.g., "Remember anniversary, 12/31").
3. Upon successful registration, the bot will confirm it. (Once registered, you cannot change it for **6 days**).
4. To check your registered anniversary, mention or reply with **"Tell me anniversary"** (or "記念日確認").
5. You can turn anniversary celebrations on or off at any time by posting **"enable anniversary"** / **"disable anniversary"** (or "記念日オン" / "記念日オフ"). (Default is ON).

### Year Recap
*(※Discord Member or Subscriber Member Only)*

Extracts a beautiful summary of your entire year's activities on Bluesky!

1. Make sure you are followed back by the bot.
2. Mention or reply to the bot with **"summarize this year"** (or "一年のまとめ", "1年のまとめ", "１年のまとめ", "summarize year").
3. The bot collects your posts from the past 365 days (up to 1000 posts), analyzes monthly activity distributions, lists your top 20 nouns used, and finds your top 5 interacted friends. Gemini then generates a yearly recap text and replies with it along with a special image.

(*You can only use this once every **6 days**.*)

---

## Badge (Bluesky Label) Feature

This bot leverages the Bluesky Labeler protocol to gift special emojis and titles directly onto your profile as **"Badges (Bluesky Labels)"** upon triggering specific features.

> [!IMPORTANT]
> **Prerequisites to show badges on your profile**
> To make the gifted badges appear on your Bluesky profile, you must subscribe to our official Labeler account:
>
> 👉 **[Bot-tan Labeler (labeler.bot-tan.com)](https://bsky.app/profile/labeler.bot-tan.com)**
>
> Go to the profile link above and click the **"Subscribe"** button. That's it!

### Available Badges

| Badge Type | Label Key | Gift Condition | Duration | Display Example |
| :--- | :--- | :--- | :--- | :--- |
| **Team Affirmation Badge** | `team-affirmation` | Join and link your Bluesky account to the [Bot-tan Discord Server](https://discord.gg/hshXWQEMgu) | During community membership (Persistent) | `Team Affirmation` |
| **Lucky Badge** | `today-lucky-xxx` | Use the Fortune-telling feature | 24 Hours | `Today's Lucky: 🔮✨🍀` |
| **Title Badge (Analysis)** | `title-xxx` | Use the Personality Analysis feature | 1 Week | `Title: 〇〇` |
| **Title Badge (Diary)** | `title-xxx` | Use the Daily Diary feature | 24 Hours | `Title: 〇〇` (Overwrites Analysis) |
| **Morning Talk Badge** | `morning-talk-xxx` | Reply to the bot's morning talk question | 24 Hours | `Morning Talk: 〇〇` (Answer summary) |
| **Anniversary Badge** | `anniversary-xxx` | Welcome your registered user anniversary day | 24 Hours | `Anniversary: 〇〇` |

When a badge is applied, the bot-tan labeler account will post a public celebration notification to notify you (mention tags are bypassed as clean links to avoid spamming notification feeds). Show off your custom badges on your profile and enjoy chatting with bot-tan!

---

## Privacy Policy

### Information Collection

This bot collects and processes the following types of information:

- **Follower Post Content**: Post content is used solely to generate replies and is neither stored nor reused.
- **User Metadata**: Basic metadata such as usernames or profile details may be accessed to personalize responses, but this information is never stored.

### Purpose of Information Use

Collected information is only used to generate replies. Reply text is generated by the home-hosted local model. When current information must be verified, Google Gemini Grounding receives only locally anonymized search queries and target URLs; the original post, conversation history, DID, and bot system prompt are not sent to Google LLC.

### Age Restriction
AI-based features comply with Google Gemini’s Terms of Service and are only available to users **18 years and older**.
Template replies and generated reply text use the home-hosted local model. Gemini is limited to optional Grounding research and image generation.

### Regional Restriction
AI-based features cannot be used in the following regions (per Google Gemini’s Terms of Service):

- United Kingdom (UK)
- Switzerland
- EU Member States

Template replies use the home-hosted local model.

### Privacy Policy Updates

The privacy policy may be updated from time to time. Any significant changes will be communicated through this repository.

### Contact

For inquiries about this bot or its privacy policy, please contact:
[Suibari (suibari.com)](https://bsky.app/profile/suibari.com)

---

## License
This project is OSS, released under the MIT License.
See [LICENSE](../LICENSE) for details.

### Historical references
Earlier versions of the classifier used:
- [Japanese Sentiment Polarity Dictionary](https://www.cl.ecei.tohoku.ac.jp/Open_Resources-Japanese_Sentiment_Polarity_Dictionary.html), Tohoku University (Inui/Okazaki Laboratory).
- [English Sentiment Polarity Dictionary](http://www.lr.pi.titech.ac.jp/~takamura/pndic_en.html), Tokyo Institute of Technology (Okumura/Takamura Laboratory).

---

## Disclaimer

This bot was developed, operated, and managed personally by Suibari for the purpose of improving technical skills and understanding the AT Protocol. As such, extensive support or updates like those offered by companies may not be possible.

While every effort is made to ensure the bot functions correctly, please use it at your own risk. The developer assumes no responsibility for any errors, damages, or losses resulting from the use of this bot. Your understanding is appreciated.
