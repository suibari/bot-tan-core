/**
 * おはようポストの「全肯定質問コーナー」のテーマ。
 *
 * 以前は「形容詞 × ジャンル × 名詞」の3軸を掛け合わせていたため、
 * 「尊敬するBlueskyの場所・風景」「推しのテレビの友達」「最近ハマってるインターネットの友達」
 * のような意味の通らないテーマが出た。また「好きな/推しの」と「ヒーロー/スーパースター」が
 * 毎朝のように並び、どれも似た問いに見えていた。
 *
 * そのためテーマは人が読んで1行で答えられる形で書いたものだけを並べ、
 * 直近に出したテーマとカテゴリを避けて選ぶ。テーマ文はそのまま
 * 回答へのリプライ（generateQuestionsAnswer）とおやすみポストの振り返りにも出るので、
 * 「〜は？」で終わる短い問いか、「A派？ B派？」の形にそろえる。
 */
export interface QuestionTheme {
  text: string;
  category: QuestionThemeCategory;
  /** JST の月（1〜12）。指定があるときはその月にだけ出す。 */
  months?: readonly number[];
}

export type QuestionThemeCategory =
  | "food"
  | "daily"
  | "hobby"
  | "memory"
  | "place"
  | "self"
  | "online"
  | "versus"
  | "season";

const t = (category: QuestionThemeCategory, texts: string[], months?: number[]): QuestionTheme[] =>
  texts.map((text) => (months ? { text, category, months } : { text, category }));

export const QUESTION_THEMES: readonly QuestionTheme[] = [
  ...t("food", [
    "最近いちばんおいしかった食べ物は？",
    "朝ごはんの定番メニューは？",
    "コンビニでつい買っちゃうものは？",
    "自分でよく作る得意料理は？",
    "地元の自慢の食べ物は？",
    "疲れた日に食べたくなるものは？",
    "好きなお菓子は？",
    "いちばん好きなパンは？",
    "好きなおにぎりの具は？",
    "ご褒美に食べたいものは？",
    "子どものころ苦手で、今は好きな食べ物は？",
    "お気に入りの飲み物は？",
  ]),
  ...t("daily", [
    "朝起きて最初にすることは？",
    "最近買ってよかったものは？",
    "毎日欠かさずやっていることは？",
    "寝る前のリラックス方法は？",
    "最近ちょっとうれしかったことは？",
    "愛用している文房具や道具は？",
    "気分が上がる服や小物は？",
    "休日の理想の過ごし方は？",
    "最近始めた小さな習慣は？",
    "部屋でいちばんお気に入りの場所は？",
    "元気が出ない日の立て直し方は？",
  ]),
  ...t("hobby", [
    "最近ハマっている作品は？",
    "何度も読み返したくなる本や漫画は？",
    "最近よく聴いている曲は？",
    "人生でいちばん遊んだゲームは？",
    "誰かにおすすめしたいアニメは？",
    "最近観た映画やドラマで心に残ったものは？",
    "好きなキャラクターとその理由は？",
    "いつかやってみたい趣味は？",
    "作業中に流しているものは？",
    "推しの魅力をひとことで言うと？",
    "最近つくったもの・描いたものは？",
    "好きなゲームのジャンルは？",
  ]),
  ...t("memory", [
    "子どものころ夢中だった遊びは？",
    "思い出に残っている旅行先は？",
    "子どものころの夢は？",
    "最初に好きになったアニメや漫画は？",
    "学生時代によく聴いていた曲は？",
    "懐かしいと感じるおやつは？",
    "今でも覚えている先生や友達のひとことは？",
    "人生でいちばん笑った出来事は？",
  ]),
  ...t("place", [
    "いつか行ってみたい場所は？",
    "近所のお気に入りスポットは？",
    "落ち着ける場所はどこ？",
    "住んでいる地域のいいところは？",
    "旅先で必ずすることは？",
    "好きな景色は？",
  ]),
  ...t("self", [
    "自分のちょっと自慢できるところは？",
    "最近がんばったことは？",
    "今年中にやってみたいことは？",
    "人から言われてうれしかった言葉は？",
    "自分を一文字で表すと？",
    "最近ちょっと成長したなと思うことは？",
    "密かに得意なことは？",
    "今いちばん楽しみにしていることは？",
  ]),
  ...t("online", [
    "Blueskyで見かけて好きになったものは？",
    "スマホのホーム画面に置いているアプリは？",
    "最近ネットで知って驚いたことは？",
    "よく見ている動画のジャンルは？",
  ]),
  ...t("versus", [
    "猫派？ 犬派？",
    "海派？ 山派？",
    "朝型？ 夜型？",
    "計画派？ 行き当たりばったり派？",
    "休日は外出派？ おうち派？",
    "コーヒー派？ 紅茶派？",
    "甘党？ 辛党？",
    "ラーメン派？ うどん派？",
    "肉派？ 魚派？",
    "お寿司はサーモン派？ マグロ派？",
    "インドア派？ アウトドア派？",
    "旅行するなら国内？ 海外？",
    "紙の本？ 電子書籍？",
    "iPhone派？ Android派？",
    "Mac派？ Windows派？",
    "きのこ派？ たけのこ派？",
    "ごはん派？ パン派？",
    "一人旅派？ 誰かと旅行派？",
  ]),
  ...t("season", ["春になったらやりたいことは？", "好きな春の食べ物は？"], [3, 4, 5]),
  ...t("season", ["梅雨の日の過ごし方は？"], [6]),
  ...t("season", ["夏といえば何を思い浮かべる？", "好きな夏の食べ物は？", "夏休みの思い出は？"], [7, 8]),
  ...t("season", ["秋にやりたいことは？", "食欲の秋、いま食べたいものは？", "読書の秋のおすすめは？"], [9, 10, 11]),
  ...t("season", ["寒い日に欠かせないものは？", "冬の好きな食べ物は？"], [12, 1, 2]),
  ...t("season", ["年末にやりたいことは？", "今年いちばんの思い出は？"], [12]),
  ...t("season", ["今年の目標は？", "お正月の過ごし方は？"], [1]),
];

/** これだけ前までのテーマは出さない。候補が尽きたら古いものから戻す。 */
export const QUESTION_THEME_HISTORY_SIZE = 60;
/** 直近これだけの回とはカテゴリも変える。 */
const RECENT_CATEGORY_WINDOW = 2;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const jstMonth = (now: Date) => new Date(now.getTime() + JST_OFFSET_MS).getUTCMonth() + 1;

/**
 * recentThemes は新しい順のテーマ文。カテゴリの判定にも使うので、
 * プールから消えた古いテーマが混じっていても無視するだけで済む。
 */
export function pickQuestionTheme(input: {
  recentThemes?: readonly string[];
  now?: Date;
  random?: () => number;
  themes?: readonly QuestionTheme[];
} = {}): QuestionTheme {
  const themes = input.themes ?? QUESTION_THEMES;
  const random = input.random ?? Math.random;
  const month = jstMonth(input.now ?? new Date());
  const recent = (input.recentThemes ?? []).slice(0, QUESTION_THEME_HISTORY_SIZE);

  const inSeason = themes.filter((theme) => !theme.months || theme.months.includes(month));
  const byText = new Map(themes.map((theme) => [theme.text, theme]));
  const recentCategories = new Set(
    recent
      .slice(0, RECENT_CATEGORY_WINDOW)
      .map((text) => byText.get(text)?.category)
      .filter((category): category is QuestionThemeCategory => Boolean(category)),
  );

  // 条件をきつい順に試し、空になったら1段ゆるめる。最後は季節内の全部。
  let pool: QuestionTheme[] = [];
  for (let size = recent.length; size >= 0; size = size === 0 ? -1 : Math.floor(size / 2)) {
    const excluded = new Set(recent.slice(0, size));
    const fresh = inSeason.filter((theme) => !excluded.has(theme.text));
    const otherCategory = fresh.filter((theme) => !recentCategories.has(theme.category));
    pool = otherCategory.length > 0 ? otherCategory : fresh;
    if (pool.length > 0) break;
  }
  if (pool.length === 0) pool = inSeason.length > 0 ? inSeason : [...themes];

  // 季節のテーマは数が少ないので、その時期は少しだけ出やすくする。
  const weights = pool.map((theme) => (theme.months ? 3 : 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let roll = random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll < 0) return pool[i];
  }
  return pool[pool.length - 1];
}
