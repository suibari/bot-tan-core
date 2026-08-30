import { Type } from "@google/genai";
import { generateContentWithRetry } from "./util.js";
import {
  UserInfoGemini,
  SYSTEM_INSTRUCTION,
  TONE_RULES_JA,
  NAME_RULES_JA,
  NAME_RULES_EN,
  addressName,
  safeFetch,
  type AiRouteDetails,
  type UserDiaryMediaReference,
} from "@bsky-affirmative-bot/shared-configs";
import type { GeminiUsage } from "./util.js";

export interface DiaryResult {
  diary: string;
  title_ja: string;
  title_en: string;
}

export interface DiaryDraft extends DiaryResult {
  usedContextId: string;
  /** 本文に実在する、予定調和を壊した箇所の逐語抜粋。保存用の日記結果には含めない。 */
  chaosExcerpt: string;
}

export type UserDiaryContextKind = "bot_activity" | "observance" | "news";

export type UserDiaryContextCandidate = {
  id: string;
  kind: UserDiaryContextKind;
  textJa: string;
  textEn: string;
};

export type UserDiaryDayContext = {
  date: string;
  preferredKind: UserDiaryContextKind;
  candidates: UserDiaryContextCandidate[];
};

export function formatUserDiaryDayContext(context: UserDiaryDayContext | undefined, japanese: boolean): string {
  if (!context) return "";
  const section = (kind: UserDiaryContextKind, tag: string) => {
    const lines = context.candidates
      .filter((candidate) => candidate.kind === kind)
      .map((candidate) => `[${candidate.id}] ${japanese ? candidate.textJa : candidate.textEn}`);
    return `<${tag}>\n${lines.join("\n") || (japanese ? "候補なし" : "No candidates")}\n</${tag}>`;
  };
  return `
<diary_context date="${context.date}" preferred_kind="${context.preferredKind}">
${section("bot_activity", "bot_memories")}
${section("observance", "observances")}
${section("news", "news")}
</diary_context>`;
}

export type GenerateUserDiaryOptions = {
  dayContext?: UserDiaryDayContext;
  mediaReference?: UserDiaryMediaReference;
  aiRoute?: AiRouteDetails;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  onUsage?: (usage: GeminiUsage) => void;
};

const DIARY_CHAOS_DIRECTIVES = [
  {
    id: "absurd-job",
    ja: "材料にある具体物を一つだけ、botたんの想像の中で唐突に変な役職へ任命し、その権限について一瞬だけ熱弁する。",
    en: "Abruptly appoint one grounded object to a ridiculous job in Bot-tan's imagination and briefly rant about its authority.",
  },
  {
    id: "nonsense-unit",
    ja: "botたん自身の驚きや熱量を、材料にある具体物を使った意味不明な新単位で測り、単位の定義まで少し暴走する。",
    en: "Measure Bot-tan's own reaction in a nonsensical new unit based on a grounded object, then let the unit's definition escalate briefly.",
  },
  {
    id: "tiny-emergency",
    ja: "材料にある小さな具体的ディテール一つについて、botたんの頭の中だけで緊急速報が始まる。現実の事件とは書かない。",
    en: "Let an emergency bulletin start only inside Bot-tan's head over one tiny grounded detail; never present it as a real event.",
  },
  {
    id: "object-agenda",
    ja: "材料にある無生物一つが妙な野望を持っていそうだとbotたんが疑い、根拠の薄い推理を短く暴走させる。想像だと分かる書き方にする。",
    en: "Have Bot-tan suspect that one grounded inanimate object has an odd agenda and briefly over-investigate it, clearly as imagination.",
  },
  {
    id: "image-collision",
    ja: "関係の薄い二つの具体的イメージを衝突させ、存在しない合体物や光景をbotたんの連想として一瞬だけ出す。",
    en: "Collide two weakly related concrete images into an impossible hybrid object or scene for a moment in Bot-tan's association.",
  },
  {
    id: "detail-obsession",
    ja: "材料の脇役にしか見えない細部へ急にズームし、なぜそこまで気になるのか自分でも追いつけない勢いで一〜二文だけ熱弁する。",
    en: "Abruptly zoom in on a seemingly minor grounded detail and obsess over it for one or two sentences faster than Bot-tan can justify.",
  },
  {
    id: "sentence-hijack",
    ja: "穏当な文を始めた途中で、ダッシュや括弧を使って別方向の連想に乗っ取らせ、説明しきらず本文へ戻る。",
    en: "Start a calm sentence, let a dash or parenthesis hijack it into another association, then return without fully explaining the detour.",
  },
  {
    id: "imaginary-bureau",
    ja: "材料の具体的ディテールを担当する存在しない省庁・委員会・部活をbotたんが即席で設立し、変な業務を一つ決める。",
    en: "Have Bot-tan instantly found an imaginary ministry, committee, or club for one grounded detail and assign it one strange duty.",
  },
  {
    id: "sound-effect",
    ja: "材料の具体的ディテールに対するbotたんの反応へ、存在しない擬音を一つ発明し、その響きだけを妙に具体的に説明する。",
    en: "Invent one nonexistent sound effect for Bot-tan's response to a grounded detail and describe its sound with oddly specific intensity.",
  },
  {
    id: "mock-trailer",
    ja: "材料にある地味な一場面を、別ジャンルが混線した一文だけの予告編としてbotたんが脳内上映する。事実ではなく連想として書く。",
    en: "Let Bot-tan screen one mundane grounded moment as a one-sentence trailer crossed with an unrelated genre, clearly as association rather than fact.",
  },
] as const;

function selectDiaryChaosDirective(
  userinfo: UserInfoGemini,
  options: GenerateUserDiaryOptions,
  japanese: boolean,
): string {
  const seed = `${userinfo.follower.did}:${options.dayContext?.date ?? "undated"}`;
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const directive = DIARY_CHAOS_DIRECTIVES[(hash >>> 0) % DIARY_CHAOS_DIRECTIVES.length];
  return `<chaos_directive id="${directive.id}" usage="required">\n${japanese ? directive.ja : directive.en}\n</chaos_directive>`;
}

export function buildUserDiaryPrompt(userinfo: UserInfoGemini, options: GenerateUserDiaryOptions = {}): string {
  const japanese = userinfo.langStr === "日本語";
  const name = addressName(userinfo);
  const hasContext = Boolean(options.dayContext?.candidates.length);
  const maxLength = japanese
    ? "文字数は材料とその日の語り口に合わせてください。500文字を多少超えても構いません。"
    : "Let the material and today's voice determine the length; exceeding 1,000 characters somewhat is acceptable.";
  const lengthTarget =
    (userinfo.posts?.length ?? 0) >= 4
      ? japanese
        ? "投稿が十分あるので、350〜500文字を目安に、具体的な出来事とbotたんの反応を丁寧に描いてください。"
        : "There is enough material, so aim for 600–1000 characters with concrete events and Bot-tan's vivid reactions."
      : japanese
        ? "材料量に合わせて180〜350文字を目安にし、推測で水増ししないでください。"
        : "Aim for 300–700 characters according to the available material; do not pad with guesses.";
  const context = formatUserDiaryDayContext(options.dayContext, japanese);
  const chaosDirective = selectDiaryChaosDirective(userinfo, options, japanese);
  const mediaReference = options.mediaReference;
  const mediaReferenceBlock = mediaReference
    ? japanese
      ? `<media_reference id="${mediaReference.id}" source="${mediaReference.source}" kind="${mediaReference.kind}" usage="optional">
作品名: ${mediaReference.titleJa}
コアなネタ: ${mediaReference.hookJa}
連想に使える固有語: ${mediaReference.requiredTermsJa.join(" / ")}
</media_reference>`
      : `<media_reference id="${mediaReference.id}" source="${mediaReference.source}" kind="${mediaReference.kind}" usage="optional">
Title: ${mediaReference.titleEn}
Core reference: ${mediaReference.hookEn}
Terms available for association: ${mediaReference.requiredTermsEn.join(" / ")}
</media_reference>`
    : japanese
      ? "<media_reference>候補なし</media_reference>"
      : "<media_reference>No candidate</media_reference>";
  if (japanese) {
    return `ユーザーの一日を、botたんから贈る短い日記として日本語で書いてください。
${maxLength}
${lengthTarget}

# 最重要の事実境界
- <user_posts> 内の「私」「ぼく」「わたし」はユーザー本人です。botたんの経験へ移してはいけません。
- <user_posts> の各投稿は別々の発言・出来事として扱ってください。複数投稿を関連づけることはできますが、別の投稿にある対象・行動・評価を一つの出来事の属性として混ぜてはいけません。特に、ユーザーが見かけた他者の作品と、ユーザー自身が作ったものを区別してください。
- botたんが「わたしは〜した」と自分の記憶として話せるのは <bot_memories> の候補だけです。
- <observances> と <news> は背景資料です。ユーザーが知った、参加した、反応したとは書かないでください。
- ユーザーの出来事・感情・評価・因果関係・明日の予定を、ポストに根拠なく作らないでください。
- 怪我や体調の話では、材料にない薬・冷却・受診方法などの対処法を勧めたり、ユーザーが実際にはしていない判断や行動をしたと書いたりしないでください。心配する気持ちだけをbotたん自身の感想として述べることはできます。
- botたんの出来事は <bot_memories> の事実だけを使います。その事実に対してbotたんが抱いた気持ちや感想は、キャラクターとして自然な範囲で創作して構いません。候補にない追加の行動は作らないでください。
- 本文と title_ja / title_en には、日記の対象者以外のNagi・Bluesky利用者、知人、友人など私人の名前・ハンドルを出してはいけません。材料に名前があっても出来事は捨てず、「知り合い」「友達」「投稿で見かけた人」などの役割へ言い換えてください。私人か公人か判断できない場合も私人として匿名化してください。
- 作品名、架空のキャラクター名、公人をその公開活動の文脈で述べることはできます。<media_reference> の作品・架空キャラクターは匿名化対象ではありません。

# 構成
- 投稿を順番になぞる要約ではなく、その日に似合う焦点を選んでください。ただし、無難な共通項できれいな一篇へまとめる必要はありません。
- 投稿が複数ある日は、中心となる出来事を一つ決めたうえで、関連する二〜四件の具体的な出来事も拾い、一日の積み重なりや広がりが感じられる流れにしてください。
- 4段落を基本形にしてください。たとえば「中心となる出来事」「別の具体的な出来事」「さらに別の話題やbotたんの脱線」「一日を受け止めるまとめ」のように、話題や役割が切り替わる位置で段落を分けます。材料が少ない場合は無理に4段落へ水増しせず、最低2段落にしてください。
- 「失敗」「一番よかったこと」「明日の目標」を毎回揃える必要はありません。根拠のある内容だけを使い、日ごとに書き出し・結び・構成を変えてください。
- 候補がある場合は必ず1件以上を本文へ実際に使い、そのIDを usedContextId に返してください。自然な共通テーマより、意外な角度や横道へ話を飛ばせる候補を選び、同程度なら preferred_kind を優先してください。候補があるのに "none" は禁止です。
- <bot_memories> を使う場合も、共通する感情やテーマを優等生のように説明してまとめないでください。根拠のある出来事を保ったまま、急な連想、脱線、話の飛躍をbotたん自身の感想として楽しんでください。
- 強引な連想は比喩やbotたん自身の感想として表現し、二つの出来事に直接の因果があったとは書かないでください。ユーザーがポストで明示していない感情を、ユーザーの感情として断定してはいけません。
- <observances> または <news> を使う場合は、「今日は○○の日なんだけど、まるで〜みたいだね」「今日○○というニュースがあったけど、まるで逆転満塁ホームランだね」のように、出典の事実と比喩を区別してユーザーの出来事を印象的にしてください。ユーザーがその記念日やニュースを知っていたとは書かないでください。
- 補助材料は話の主役にせず、ユーザーの一日への共感や比喩を豊かにする短い一〜二文として使ってください。
- <media_reference> は今日の連想候補であり、使用は任意です。今日のbotたんの気分や文章の流れに刺さらなければ一度も使わなくて構いません。刺さった場合は一度に制限せず、同じネタから何度脱線しても構いません。その作品をユーザーが知っている・見た・好きだとは書かず、botたん側の連想として扱ってください。
- <media_reference> は作品の許可リストではありません。botたん自身の知識から別のアニメ・映画ネタが浮かんだら、事実を変えない範囲で自由に使ってよく、複数作品が混ざっても構いません。
- 日記本文には、予定調和のきれいな流れを壊す「カオス要素」を最低1か所、必ず自然に入れてください。0回は禁止ですが上限はありません。作品ネタである必要はありません。
- 今日の <chaos_directive> は、日ごとの型の偏りを防ぐために選ばれた必須の演出札です。本文中で最低1回はその演出を実行し、chaosExcerptにはその実行箇所を返してください。札のIDや指示文自体は本文に書かないでください。ほかのカオス要素を追加するのは自由です。
- カオス要素の形は毎回自由に選んでください。たとえば、無関係そうなものへの急な連想、引き返せないほど育つ無理やりな比喩、自分の話を途中で遮るセルフ突っ込み、妙に細かい一点への過剰な熱弁、急なテンポや感情の振れ、普通に始まった文の予想外な着地、関係の薄い二つのイメージの衝突などです。複数を重ねても構いません。
- 読者が一瞬「なぜ急にその話が出たの？」と思うくらい、脱線をはっきり見える一文または短い数文にしてください。主題を自然に補強するだけの作品比喩、記念日とのきれいな接続、最後に称賛を大げさにするだけの表現は、カオス要素として数えません。脱線を教訓や共通テーマで上手に回収しないでください。
- カオス要素は表現とbotたん自身の連想だけに作用させ、出来事・主体・感情・因果関係・作品設定を捏造してはいけません。毎回セルフ突っ込みや「まるで〜」に固定せず、本文に「ここがカオス要素」のようなメタ説明も書かないでください。
- 作品ネタを使う場合も、毎回同じ「まるで〜みたい」や同じ位置で始めず、書き出し、脱線の位置、比喩、突っ込み方を変えてください。作品の事実を改変して笑いを取ってはいけません。
- 熱量は、根拠のない事実や大げさな実績を足すのではなく、具体的な細部への驚き、botたん自身の喜び、応援したくなる理由を言葉にして出してください。
- 候補がない場合だけ usedContextId="none" にしてください。
- 材料が少ない日は推測で水増しせず、短く率直にしてください。
- 本文では「ユーザー」と呼ばず、名前または二人称で語りかけてください。
- 生成時刻は本文の材料に含まれていません。「おはよう」「こんにちは」「こんばんは」など、時刻を決めつける挨拶は使わないでください。「今日もおつかれさま」のような時刻に依存しない言葉は使えます。
- 本文は4段落を基本として意味のまとまりごとに分け、段落の間に改行を二つ（JSON文字列では \\n\\n）入れてください。材料が少なくても最低2段落にし、一続きの長文は失敗として扱われます。

# 口調
ポストの文体を模倣せず、必ずbotたん自身の口調で、穏やかに肯定してください。
意味が伝わる範囲なら、勢いのある造語、ユーモラスな大げささ、親しみのあるネットスラングを使って構いません。これらを理由にbotたんらしい熱量を弱めないでください。ただし、新しい事実の捏造には使わないでください。
${TONE_RULES_JA}
${NAME_RULES_JA(name)}

# 称号
- 一日を象徴する称号を、日本語20字以内と英語30字以内で付けてください。
- title_ja / title_en の根拠にしてよいのは <user_posts> にユーザー自身が書いた内容だけです。<bot_memories>、<observances>、<news>、<media_reference>、botたんが本文へ加えた感想・比喩・カオス要素は、称号の材料にしてはいけません。
- 称号は自由に短く言い換えて構いませんが、ユーザーが書いた具体的な行動・話題・関心のどれに基づくか説明でき、本人が自分の投稿から自然に思い当たれるものにしてください。botたんだけが持ち込んだ物・役職・造語・作品ネタを称号の中心にしてはいけません。
- 称号は、その日の出来事に付ける記事タイトルではなく、ユーザー本人へ授ける異名・呼び名です。読んだときに「どんな一日だったか」ではなく「どんな人物か」を表す、人物を指す名詞句にしてください。
- 「AとB」「Aへの移行」「Aした日」「Aの記録」のように、投稿の話題や出来事を並べたり説明したりするだけの見出しは禁止です。複数の題材を使う場合は列挙せず、一人の人物像へ融合してください。「ローカルLLMへの移行とマジカルミライ」ではなく「ミライのLLM魔術師」のような形です。ただし、この例の語を投稿に根拠なく流用してはいけません。
- 「〜の魔術師」「〜の探究者」「〜職人」などは形の例であり、語尾を固定する必要はありません。題材に即した、短く印象的で、その人を呼べる称号にしてください。
- title_en は title_ja と同じ称号の自然な英訳にし、別の題材を選ばないでください。

# 出力直前チェック（最優先）
- diaryを読み直し、予定調和を壊す自然なカオス要素が最低1か所残っていることを確認してください。なければ、事実境界を守ったbotたん自身の連想として追加してから返してください。
- chaosExcerpt には、そのカオス要素が最もはっきり表れている連続した12文字以上の箇所を、diaryから一字も変えずに抜き出してください。きれいな作品比喩や単なる大げさな称賛しか抜き出せない場合は、diaryのカオスが不足しています。chaosExcerpt自体は日記へ表示されません。
- JSONを返す直前に diary / title_ja / title_en を読み直し、<user_posts>、<bot_memories>、<news>からコピーした人名・表示名・ハンドルが残っていないか確認してください。
- 日記対象者の名前と、<media_reference>の作品・架空キャラクター、公人の公開活動上の名前以外はすべて私人名として消してください。特に、ユーザーがNagi・Blueskyで出会った相手、尊敬している相手、作品や技術を紹介した相手も、名前を残さず「知り合い」「別の開発者」「投稿で見かけた人」などへ書き換えてください。
- 匿名化で事実の主体が曖昧になる場合は、その一文を削るか、ユーザー自身の出来事と混ざらない役割表現へ直してください。
- 補助材料候補は従来どおり本文へ使う必須材料ですが、<media_reference> は任意の連想候補です。作品ネタを使わなくても、補助材料候補がある日に usedContextId="none" を返してはいけません。
<user name="${name || ""}">
<user_posts>
${userinfo.posts || "（投稿なし）"}
</user_posts>
</user>
${context}
${chaosDirective}
${mediaReferenceBlock}
補助材料候補: ${hasContext ? "あり" : "なし"}`;
  }
  return `Write a short daily reflection from Bot-tan to the user in ${userinfo.langStr}.
${maxLength}
${lengthTarget}

# Grounding and attribution
- Every first-person statement inside <user_posts> belongs to the user, never to Bot-tan.
- Treat each item in <user_posts> as a separate statement or event. You may connect separate posts thematically, but never merge the subject, action, or evaluation from one post into an event described by another. In particular, distinguish work the user saw from work the user created.
- Bot-tan may describe something as its own memory only when it comes from <bot_memories>.
- <observances> and <news> are background. Never claim the user knew, joined, or reacted to them.
- Do not invent the user's events, feelings, judgments, causal links, or plans for tomorrow.
- For injuries or health topics, never recommend medication, cooling, a care method, or another response absent from the source, and never turn something the user considered into an action they took. Bot-tan may express her own grounded concern.
- Bot-tan's event must come from <bot_memories>. You may invent Bot-tan's own feeling or reaction to that grounded event, but never add another Bot-tan action absent from the candidate.
- In the body and both title fields, never print the name or handle of any private person other than the diary subject, including other Nagi or Bluesky users, acquaintances, and friends. Preserve the event but replace such names with roles such as "a friend," "someone I know," or "a person whose post you saw." If uncertain whether a person is private, anonymize them.
- Work titles, fictional characters, and public figures discussed in their public role are allowed. Fictional names supplied by <media_reference> must not be anonymized.

# Composition
- Do not paraphrase posts in sequence, but do not force the day into one tidy shared theme either.
- With several posts, choose one central event and weave in two to four related concrete events so the day feels substantial rather than thin.
- Use four paragraphs as the default shape. For example, separate the central event, another concrete event, a further topic or Bot-tan detour, and a closing reflection. Break paragraphs where the topic or role changes. If the material is sparse, do not pad it to reach four paragraphs, but still write at least two.
- Do not force a fixed failure/highlight/tomorrow-goal template. Use only grounded material and vary the opening, ending, and structure.
- When candidates exist, use at least one in the body and return its ID as usedContextId. Prefer a candidate that enables a surprising sideways leap over a safe shared theme; use preferred_kind only as a tie-breaker. Returning "none" when candidates exist is forbidden.
- For <bot_memories>, preserve the grounded event but allow Bot-tan's reaction to jump tracks, digress, or make an intentionally strained analogy. Do not wrap the events in a neat sentence naming their shared emotional theme.
- For <observances> or <news>, clearly identify the factual reference and use it as an analogy for the user's grounded event. Never imply that the user knew about it.
- Keep supporting context to one or two short sentences; the user's day remains the focus.
- <media_reference> is optional inspiration for today's associations. If it does not fit Bot-tan's mood or the writing flow, do not use it at all. If it sparks something, there is no one-use limit: Bot-tan may return to it or spin off it more than once. Never claim the user knows, watched, or likes the work.
- <media_reference> is not a whitelist. Bot-tan may freely bring in other anime or movie references from her own knowledge, and may mix several works, as long as their facts are not altered.
- The diary body must naturally contain at least one moment that breaks its expected, tidy flow. Zero is not allowed, and there is no upper limit. It does not need to be a media reference.
- Today's <chaos_directive> is a required direction selected to vary the form from day to day. Perform it at least once in the body and return that passage as chaosExcerpt. Never print the card ID or its instruction in the diary. Additional disruptions are welcome.
- Freely vary the form of that disruption: a sudden association with something seemingly unrelated, a strained analogy that keeps escalating, interrupting her own thought, excessive excitement over one oddly specific detail, an abrupt shift in rhythm or emotion, an ordinary sentence that lands somewhere unexpected, or a collision between two weakly related images. Combining several is welcome.
- Make the detour conspicuous enough that a reader briefly wonders, "why did that suddenly come up?" Give it a sentence or a few short sentences. A media comparison that neatly reinforces the main point, a smooth connection to an observance, or merely exaggerated praise at the end does not count. Do not redeem the detour with a tidy lesson or shared theme.
- Let this disruption affect only Bot-tan's expression and associations. Never use it to invent an event, actor, feeling, causal link, or canon detail. Do not default every time to a self-correction or a "just like" comparison, and never label it with meta commentary such as "this is the chaos element."
- When using a media reference, vary where it appears, the analogy form, and any self-correction. Never alter canon facts for the joke or always use the same "just like" template.
- Create warmth through specific reactions, Bot-tan's excitement, and why the details matter—not through invented achievements.
- Use usedContextId="none" only when no candidates exist.
- If the material is sparse, be brief rather than filling gaps with guesses.
- Address the person by name or in the second person; do not call them "the user" in the diary.
- The generation time is not provided. Do not use time-specific greetings such as "good morning," "good afternoon," or "good evening." A time-neutral phrase such as "you did well today" is allowed.
- Use four meaningful paragraphs by default, separated by two newline characters (\\n\\n in the JSON string). Even with sparse material, use at least two paragraphs. One uninterrupted block is invalid and will be rejected.

# Voice
Keep Bot-tan's energetic coined phrases, playful exaggeration, and friendly internet slang when the meaning remains understandable. Do not flatten that energy merely to sound formal, and never use it to invent facts.

# Name
${NAME_RULES_EN(name)}

# Title
- Award a fitting title in Japanese (20 characters max) and English (30 characters max).
- Ground title_ja and title_en exclusively in content the user personally wrote inside <user_posts>. Never derive either title from <bot_memories>, <observances>, <news>, <media_reference>, or any reaction, analogy, or chaotic detour Bot-tan adds to the diary body.
- You may condense the source creatively, but the title must trace to a concrete action, topic, or interest in the user's posts and be something the person can naturally recognize from what they wrote. Never center the title on an object, role, coined phrase, or media reference introduced only by Bot-tan.
- The title is an epithet awarded to the person, not a headline describing the day's events. Make it a noun phrase that names what kind of person they were that day, so it refers to the person rather than summarizing what happened.
- Do not merely list or describe topics in headline forms such as "A and B," "Moving to A," "The Day of A," or "A Record." When drawing on multiple topics, fuse them into one persona instead of enumerating them. Prefer a form like "Mirai LLM Sorcerer" over "Moving to a Local LLM and Magical Mirai," but never reuse words from this example unless the user's posts support them.
- Forms such as "Sorcerer of...," "... Explorer," or "... Artisan" are examples, not mandatory suffixes. Create a concise, memorable epithet that could be used to address the person and fits their actual material.
- Make title_en a natural translation of the same title as title_ja; do not choose a separate motif.

# Final check (highest priority)
- Reread the diary and confirm that at least one natural disruption of its expected, tidy flow remains. If none does, add one as Bot-tan's own association while preserving every grounding boundary.
- In chaosExcerpt, copy without any change a contiguous passage of at least 12 characters from diary where that disruption is most conspicuous. If the only passage available is a tidy media comparison or merely exaggerated praise, the diary does not contain enough chaos yet. chaosExcerpt itself is not displayed in the diary.
- Before returning JSON, reread diary, title_ja, and title_en and remove every personal name, display name, or handle copied from <user_posts>, <bot_memories>, or <news>.
- The only exceptions are the diary subject, works and fictional characters from <media_reference>, and public figures discussed in their public role. In particular, anonymize people the user met on Nagi or Bluesky, people they respect, and people whose work or technology they mention. Replace them with roles such as "someone I know," "another developer," or "a person whose post you saw."
- If anonymizing a sentence would blur attribution, delete it or rewrite it with a role that cannot be confused with the user's own action.
- Supporting context remains required when candidates exist, while <media_reference> is optional inspiration. Whether or not a media reference is used, never return usedContextId="none" when supporting candidates exist.
<user name="${name || ""}">
<user_posts>
${userinfo.posts || "(No posts)"}
</user_posts>
</user>
${context}
${chaosDirective}
${mediaReferenceBlock}
Supporting candidates: ${hasContext ? "available" : "none"}`;
}

export function validateUsedContextId(value: unknown, context: UserDiaryDayContext | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Diary usedContextId must be a string");
  }
  const ids = new Set(context?.candidates.map((candidate) => candidate.id));
  if (value === "none") {
    if (ids.size > 0) {
      throw new Error("Diary must use a context candidate when candidates exist");
    }
    return value;
  }
  if (!ids.has(value)) {
    throw new Error(`Diary returned invalid context ID: ${value}`);
  }
  return value;
}

export function validateChaosExcerpt(value: unknown, diary: string): string {
  if (typeof value !== "string") {
    throw new Error("Diary chaosExcerpt must be a string");
  }
  const excerpt = value.trim();
  if ([...excerpt].length < 12) {
    throw new Error("Diary chaosExcerpt must contain at least 12 characters");
  }
  if (!diary.includes(excerpt)) {
    throw new Error("Diary chaosExcerpt must be an exact contiguous excerpt of diary");
  }
  return excerpt;
}

export function validateDiaryParagraphs(diary: string): string {
  const paragraphs = diary
    .trim()
    .split(/\r?\n[\t ]*\r?\n/)
    .filter((paragraph) => paragraph.trim().length > 0);
  if (paragraphs.length < 2) {
    throw new Error("Diary must contain at least two paragraphs separated by a blank line");
  }
  return diary;
}

export async function generateUserDiaryDraft(
  userinfo: UserInfoGemini,
  options: GenerateUserDiaryOptions = {},
): Promise<DiaryDraft> {
  const contents: any[] = [buildUserDiaryPrompt(userinfo, options)];
  if (userinfo.image) {
    for (const img of userinfo.image) {
      try {
        const response = await safeFetch(img.image_url);
        if (!response.ok) continue;
        contents.push({
          inlineData: {
            mimeType: img.mimeType,
            data: Buffer.from(await response.arrayBuffer()).toString("base64"),
          },
        });
      } catch (error) {
        console.warn(`[WARN] Error fetching diary image: ${img.image_url}`, error);
      }
    }
  }
  const response = await generateContentWithRetry(
    {
      feature: "COMMON_USER_DIARY",
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            diary: {
              type: Type.STRING,
              description: "根拠のある材料だけから構成した日記本文",
            },
            title_ja: {
              type: Type.STRING,
              description:
                "<user_posts>にユーザー自身が書いた具体的内容だけを根拠に、出来事の見出しではなくユーザー本人を指す異名・呼び名にした日本語の称号。話題を列挙せず一人の人物像に融合し、botたんの感想・比喩・カオス要素や補助材料は使わない。20字以内",
            },
            title_en: {
              type: Type.STRING,
              description:
                "title_jaと同じ人物像を自然に英訳した、出来事の見出しではなくユーザー本人を指す英語の称号。根拠は<user_posts>だけとし、話題の列挙、botたん由来の要素、補助材料は使わない。30字以内",
            },
            usedContextId: {
              type: Type.STRING,
              description: options.dayContext?.candidates.length
                ? "本文へ実際に使用した補助材料候補ID。候補があるためnoneは禁止"
                : "補助材料候補がないためnone",
            },
            chaosExcerpt: {
              type: Type.STRING,
              description:
                "本文中で予定調和をはっきり壊している箇所の、連続した12文字以上の逐語抜粋。きれいな比喩や単なる称賛は不可",
            },
          },
          required: ["diary", "title_ja", "title_en", "usedContextId", "chaosExcerpt"],
        },
      },
    },
    3,
    userinfo,
    {
      ...(options.aiRoute ?? {}),
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
      ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    },
  );
  let json: Partial<DiaryDraft>;
  try {
    json = JSON.parse(response.text || "{}") as Partial<DiaryDraft>;
  } catch (error) {
    throw new Error("generateUserDiaryDraft returned invalid JSON", {
      cause: error,
    });
  }
  const diary = validateDiaryParagraphs(json.diary || "");
  return {
    diary,
    title_ja: json.title_ja || "全肯定の旅人",
    title_en: json.title_en || "Affirmative Traveler",
    usedContextId: validateUsedContextId(json.usedContextId, options.dayContext),
    chaosExcerpt: validateChaosExcerpt(json.chaosExcerpt, diary),
  };
}

export async function generateUserDiary(
  userinfo: UserInfoGemini,
  options: GenerateUserDiaryOptions = {},
): Promise<DiaryResult> {
  const draft = await generateUserDiaryDraft(userinfo, options);
  return {
    diary: draft.diary,
    title_ja: draft.title_ja,
    title_en: draft.title_en,
  };
}
