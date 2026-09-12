/**
 * 全肯定ニュースの取得を、botたんが覚えた嗜好へ寄せるためのワーカー。
 *
 * bot_memory_impressions（会話から抽出した作品名・固有名詞）を数え、ローカルLLMで
 * 広いジャンルへ一般化して nagi.news_interest_topics へ置く。取得側
 * （positiveNewsUpdater）はそこから1ジャンル引いて NewsData の q に使う。
 *
 * ## 置くのは固有名ではなくジャンル
 *
 * 固有名をそのまま検索に使うと、当たるのは公式発表と宣伝ばかりで、当たらない日は
 * 0件になる。1日20クレジットしかない取得枠をそれに賭けられない。一段上のジャンルまで
 * 広げれば記事は毎日あり、そのうちどれが誰に刺さるかは掲載後のニュース推薦
 * （NagiThemeWorker / nagi.news_reasons と埋め込み最近傍）が決める。
 * **取得を広く、選択を細かく。**
 *
 * ## スケジューリング
 *
 * 嗜好はそう速く変わらないので日次で十分。LLM 呼び出しは印象語120件に対して最大4回。
 * 失敗しても取得側は「ジャンル無し」＝従来どおりの無指定取得に落ちるだけなので、
 * ここが止まってもニュースは出続ける。
 */
import {
  generalizeInterestLabels,
  isOllamaConfigured,
  MAX_INTEREST_LABELS,
} from "@bsky-affirmative-bot/bot-brain";
import {
  loadBotMemoryInterestLabels,
  newsInterestTopicsRefreshedAt,
  replaceNewsInterestTopics,
} from "@bsky-affirmative-bot/database";

/** 作り直す間隔。みんなの関心はそう速く変わらない。 */
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
/** TTL を見に行く間隔。再起動直後にも1回見る。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * 保存するジャンル数の上限。
 *
 * 1日4スロットなので、これだけあれば1周に3日以上かかる。多すぎると裾の当たらない
 * ジャンルまで取得に使われ、クレジットが空振りに変わる。
 */
const MAX_TOPICS = 12;
const LOG_PREFIX = "[news-interest]";

/** 関心ジャンルを作り直す。戻り値は保存したジャンル数。 */
export async function refreshNewsInterestTopics(now = new Date()): Promise<number> {
  const labels = await loadBotMemoryInterestLabels({
    now,
    limit: MAX_INTEREST_LABELS,
  });
  if (!labels.length) {
    console.info(LOG_PREFIX, { event: "skip", reason: "no-labels" });
    return 0;
  }
  const topics = await generalizeInterestLabels(labels);
  const kept = topics.slice(0, MAX_TOPICS);
  await replaceNewsInterestTopics(kept, now);
  console.info(LOG_PREFIX, {
    event: "refresh",
    labels: labels.length,
    topics: kept.map((item) => `${item.topic}:${item.score}`),
  });
  return kept.length;
}

let running = false;

export function startNewsInterestWorker() {
  if (running) return;
  // 一般化はローカルLLM専用。Ollama が無い環境では静かに何もしない
  // （取得側はジャンル無しで従来どおり動く）。
  if (!isOllamaConfigured()) {
    console.log(`[INFO]${LOG_PREFIX} OLLAMA が未設定のため起動しない`);
    return;
  }
  running = true;

  const tick = async () => {
    const refreshedAt = await newsInterestTopicsRefreshedAt();
    const now = new Date();
    if (refreshedAt && now.getTime() - refreshedAt.getTime() < REFRESH_TTL_MS) return;
    await refreshNewsInterestTopics(now);
  };

  const loop = async () => {
    try {
      await tick();
    } catch (error) {
      // Ollama 不通・DB 一時障害など。次の tick で取り直せばよい。
      console.error(`[ERROR]${LOG_PREFIX}`, error);
    }
    setTimeout(() => void loop(), CHECK_INTERVAL_MS);
  };

  void loop();
}
