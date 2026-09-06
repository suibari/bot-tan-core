/**
 * 全肯定リプライを1件だけ、本番のプロンプト組み立てそのままで生成してみる。
 *
 * 投稿は一切しない。`generateAffirmativeWord` は userinfo を受け取るだけの関数で、
 * Bluesky / Nagi へ流すのはその外側（NormalReplyFeature / createNagiReply）なので、
 * userinfo を手で組めば生成だけを回せる。DB も要らない（唯一の書き込みである
 * unknownTerms の登録は失敗しても握り潰される）。
 *
 * 使い方:
 *   pnpm reply:probe -- --post="投稿本文"
 *   pnpm reply:probe -- --post="本文" --past="過去の投稿" --past="もう1件"
 *   pnpm reply:probe -- --post="本文" --link="https://example.com|タイトル|説明"
 *   pnpm reply:probe -- --post="本文" --dump=/tmp/nagi-prompts   # 送信内容をJSONで残す
 *   pnpm reply:probe -- --post="本文" --n=3                      # 同じ入力で3回振らせる
 *
 * プロンプトの並び順を A/B したいとき（--shape）:
 *   split  … 既定。指示とユーザ投稿を分けて渡す＝**今回のポストがプロンプト末尾**
 *   joined … 旧来どおり1本の文字列。grounding と botContext が投稿の後ろへ積まれる
 *
 *   pnpm reply:probe -- --post="本文" --shape=joined   # 直す前の並びを再現
 *   pnpm reply:probe -- --post="本文" --shape=split    # 直した後
 *
 * shape で切り替わるのは**並び順だけ**。読み取りルールの追加や過去ポストの行区切りは
 * 現在のコードに入ったままなので、それらも含めて完全に直す前へ戻したいなら
 * `git stash` してから --shape=joined を回すこと。
 *
 * 【重要】1回の出力で良し悪しを決めないこと。temperature は 0 ではないので同じ入力でも
 * 振れる。--n で複数回振らせて、外し方に傾向があるかを見る。
 */
import type { UserInfoGemini } from "@bsky-affirmative-bot/shared-configs";
import { generateSingleResponseWithScore } from "../packages/bot_brain/src/ai/util.js";

/**
 * プロンプト組み立ては動的に取る。
 *
 * `git stash` して**直す前のコード**へ戻したときも、このスクリプトだけは残して同じ
 * 入力を流せるようにするため。分割前のツリーには `buildAffirmativeInstructions` が
 * 無いので、その場合は 1 本の文字列を返す `buildAffirmativePrompt` へ落ちる。
 */
async function loadPromptBuilders() {
  const mod: any = await import(
    "../packages/bot_brain/src/ai/generateAffirmativeWord.js"
  );
  return {
    buildAffirmativePrompt: mod.buildAffirmativePrompt,
    buildAffirmativeInstructions: mod.buildAffirmativeInstructions,
    buildAffirmativeUserPost: mod.buildAffirmativeUserPost,
    /** 分割して渡せるツリーかどうか。 */
    canSplit:
      typeof mod.buildAffirmativeInstructions === "function" &&
      typeof mod.buildAffirmativeUserPost === "function",
  };
}

type Shape = "split" | "joined";

function argList(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function arg(name: string, fallback?: string): string | undefined {
  return argList(name).at(-1) ?? fallback;
}

/** `--link="uri|title|description"`。title と description は省略できる。 */
function parseLinks(): { uri: string; title?: string; description?: string }[] {
  return argList("link").map((raw) => {
    const [uri, title, description] = raw.split("|");
    return { uri, ...(title ? { title } : {}), ...(description ? { description } : {}) };
  });
}

function buildUserInfo(): UserInfoGemini {
  const post = arg("post");
  if (!post) {
    console.error('--post="投稿本文" は必須。使い方はこのファイルの先頭コメントを見ること。');
    process.exit(1);
  }
  const links = parseLinks();
  return {
    follower: {
      did: arg("did", "did:plc:probe"),
      handle: arg("handle", "probe.example"),
      displayName: arg("name", "すいぱり"),
    },
    posts: [post, ...argList("past")],
    langStr: (arg("lang", "日本語") as UserInfoGemini["langStr"]),
    ...(links.length
      ? {
          embed: {
            links_embed: links,
            uri_embed: links[0].uri,
            title_embed: links[0].title,
            description_embed: links[0].description,
          },
          // リンクを実際に読ませる（本番の URL Context 相当）。
          urlContextEnabled: true,
        }
      : {}),
    // botContext は意図的に渡していない。渡すと「## botたんの状況」+ 行動履歴が
    // プロンプトへ載る。並び順の影響を見たいときは --with-bot-context で足すこと。
    ...(process.argv.includes("--with-bot-context")
      ? {
          botContext: {
            datetime: new Date().toLocaleString("ja-JP"),
            weather: "晴れ",
            surface: "nagi",
            botActivity: "本を読んでる",
            botActivityEn: "reading a book",
            botEnergy: 70,
            recentActivities: Array.from({ length: 20 }, (_, index) => ({
              at: new Date(Date.now() - (20 - index) * 3_600_000),
              activity: `${index + 1}件目の行動`,
              activityEn: `activity ${index + 1}`,
            })),
            recentDigests: [{ date: "2026-09-05", summary: "散歩した" }],
          } as any,
        }
      : {}),
  } as UserInfoGemini;
}

async function main() {
  const dump = arg("dump");
  if (dump) process.env.AI_PROMPT_DUMP_DIR = dump;

  const shape = (arg("shape", "split") as Shape);
  if (shape !== "split" && shape !== "joined") {
    console.error(`--shape は split か joined。受け取った値: ${shape}`);
    process.exit(1);
  }
  const times = Number(arg("n", "1")) || 1;
  const userinfo = buildUserInfo();
  const builders = await loadPromptBuilders();

  if (shape === "split" && !builders.canSplit) {
    console.error(
      "このツリーの generateAffirmativeWord は分割前（buildAffirmativeInstructions が無い）。--shape=joined で回すこと。",
    );
    process.exit(1);
  }

  const prompt =
    shape === "split"
      ? {
          instructions: await builders.buildAffirmativeInstructions(userinfo),
          userPost: builders.buildAffirmativeUserPost(userinfo),
        }
      : await builders.buildAffirmativePrompt(userinfo);

  console.log(`shape=${shape} model=${process.env.OLLAMA_MODEL ?? "(レジストリ既定)"}`);
  console.log(`今回のポスト: ${userinfo.posts?.[0]}`);
  if ((userinfo.posts?.length ?? 0) > 1) {
    console.log(`過去のポスト: ${userinfo.posts!.length - 1}件`);
  }
  if (dump) console.log(`プロンプトを ${dump} へ出す`);
  console.log("");

  for (let attempt = 1; attempt <= times; attempt++) {
    const startedAt = Date.now();
    try {
      const result = await generateSingleResponseWithScore(prompt, userinfo, {}, {
        maxTextLength: 1_000,
      });
      console.log(`--- ${attempt}/${times} (${Date.now() - startedAt}ms, score=${result?.score}) ---`);
      console.log(result?.comment ?? "(comment が空)");
    } catch (error) {
      console.error(`--- ${attempt}/${times} 失敗 ---`);
      console.error(error instanceof Error ? error.message : error);
    }
    console.log("");
  }
}

// reportUnknownTerms が Postgres への接続を非同期で始めるので、待っているとイベント
// ループが閉じずプロセスが終わらない。生成結果はもう出ているので、ここで落とす。
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
