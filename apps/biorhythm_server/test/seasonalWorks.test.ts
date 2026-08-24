import assert from "node:assert/strict";
import test from "node:test";
import {
  applyUsedMarks,
  buildSeasonalWorksSection,
  findGenericMediaEvents,
  isInFailureBackoff,
  isSeasonalWorksFresh,
  markSeasonalWorksUsed,
  normalizeForMatch,
  parseSeasonalWorks,
  recentlyUsedTitles,
  seasonKey,
  seasonLabel,
  type SeasonalWorksState,
} from "../src/seasonalWorks.js";

test("種別とタイトルの行をパースする", () => {
  const works = parseSeasonalWorks(
    ["anime\t蒼穹のカノン", "game: 星辰クロニクル", "novel：夜半の観測者"].join("\n"),
  );

  assert.deepEqual(works, [
    { kind: "anime", title: "蒼穹のカノン" },
    { kind: "game", title: "星辰クロニクル" },
    { kind: "novel", title: "夜半の観測者" },
  ]);
});

test("日英タイトルと検索確認済みネタフックをパースする", () => {
  const works = parseSeasonalWorks(
    "anime\t機動戦士テスト\tMobile Test\t主人公が試作機を動かす。\tThe hero pilots a prototype.",
  );
  assert.deepEqual(works, [{
    kind: "anime",
    title: "機動戦士テスト",
    titleEn: "Mobile Test",
    hookJa: "主人公が試作機を動かす。",
    hookEn: "The hero pilots a prototype.",
  }]);
});

test("一部だけ欠けたネタフックと長すぎるネタフックは捨てる", () => {
  const works = parseSeasonalWorks([
    "anime\t欠損作品\tMissing Work\t日本語だけ。",
    `movie\t長文作品\tLong Work\t${"長".repeat(181)}\tA verified hook.`,
    "anime\t旧形式作品",
  ].join("\n"));
  assert.deepEqual(works, [{ kind: "anime", title: "旧形式作品" }]);
});

test("箇条書き記号・連番・検索引用マーカーを落とす", () => {
  const works = parseSeasonalWorks(
    ["- anime\t蒼穹のカノン[1]", "2. manga\t「銀鱗のリフレイン」"].join("\n"),
  );

  assert.deepEqual(works, [
    { kind: "anime", title: "蒼穹のカノン" },
    { kind: "manga", title: "銀鱗のリフレイン" },
  ]);
});

test("未知の種別・見出し行・長すぎるタイトルは捨てる", () => {
  const works = parseSeasonalWorks(
    [
      "以下が今期の話題作です。",
      "podcast\t深夜のラジオ",
      "anime\t" + "あ".repeat(41),
      "anime\t蒼穹のカノン",
    ].join("\n"),
  );

  assert.deepEqual(works, [{ kind: "anime", title: "蒼穹のカノン" }]);
});

test("重複を除く", () => {
  const works = parseSeasonalWorks(
    ["anime\t蒼穹のカノン", "anime\t蒼穹のカノン", "manga\t蒼穹のカノン"].join("\n"),
  );

  assert.equal(works.length, 2);
});

test("実在の出来事を主題とするものは除外し、フィクションのホラーは残す", () => {
  const works = parseSeasonalWorks(
    [
      "movie\t太平洋戦争の記録",
      "movie\t実録・銀行強盗",
      "movie\t深紅のスプラッターハウス",
    ].join("\n"),
  );

  assert.deepEqual(works, [{ kind: "movie", title: "深紅のスプラッターハウス" }]);
});

test("種別ごと8件・合計64件の上限で丸める", () => {
  const lines: string[] = [];
  for (const kind of ["anime", "manga", "game", "drama", "movie", "novel", "music", "hobby"]) {
    for (let i = 0; i < 12; i += 1) lines.push(`${kind}\t${kind}作品${i}`);
  }
  const works = parseSeasonalWorks(lines.join("\n"));

  assert.equal(works.length, 64);
  assert.equal(works.filter((work) => work.kind === "anime").length, 8);
  assert.equal(works.filter((work) => work.kind === "hobby").length, 8);
});

test("一部の種別が0件でも壊れない", () => {
  const works = parseSeasonalWorks("hobby\t深海生物のフィギュア");
  assert.deepEqual(works, [{ kind: "hobby", title: "深海生物のフィギュア" }]);
});

test("パースできる行が無ければ空", () => {
  assert.deepEqual(parseSeasonalWorks("見つかりませんでした。"), []);
});

test("季節キーはクール境界で切り替わる", () => {
  assert.equal(seasonKey(new Date("2026-03-31T23:59:00+09:00")), "2026-winter");
  assert.equal(seasonKey(new Date("2026-04-01T00:00:00+09:00")), "2026-spring");
  assert.equal(seasonKey(new Date("2026-08-10T12:00:00+09:00")), "2026-summer");
  assert.equal(seasonKey(new Date("2026-10-01T00:00:00+09:00")), "2026-autumn");
  assert.equal(seasonLabel(new Date("2026-08-10T12:00:00+09:00")), "2026年 夏クール");
});

const state = (overrides: Partial<SeasonalWorksState> = {}): SeasonalWorksState => ({
  season: "2026-summer",
  fetchedAt: "2026-08-08T00:00:00Z",
  works: [{ kind: "anime", title: "蒼穹のカノン" }],
  ...overrides,
});

test("7日以内かつ同じクールなら再取得しない", () => {
  const now = new Date("2026-08-10T00:00:00Z");
  assert.equal(isSeasonalWorksFresh(state(), now), true);
  assert.equal(
    isSeasonalWorksFresh(state({ fetchedAt: "2026-08-01T00:00:00Z" }), now),
    false,
  );
  assert.equal(isSeasonalWorksFresh(state({ season: "2026-spring" }), now), false);
  assert.equal(isSeasonalWorksFresh(state({ works: [] }), now), false);
  assert.equal(isSeasonalWorksFresh(undefined, now), false);
});

test("失敗後6時間は再試行しない（stepは最短5分間隔なので失敗ループを防ぐ）", () => {
  const now = new Date("2026-08-10T06:00:00Z");
  assert.equal(
    isInFailureBackoff(state({ failedAt: "2026-08-10T03:00:00Z" }), now),
    true,
  );
  assert.equal(
    isInFailureBackoff(state({ failedAt: "2026-08-09T20:00:00Z" }), now),
    false,
  );
  assert.equal(isInFailureBackoff(state(), now), false);
});

test("作品が無ければセクションごと出さない（無い日を語らせない）", () => {
  assert.equal(buildSeasonalWorksSection([]), "");
  assert.match(
    buildSeasonalWorksSection([{ kind: "anime", title: "蒼穹のカノン" }]),
    /候補にない名前を書いてはいけません/,
  );
});

test("日次予定表へは日記用ネタフックを渡さない", () => {
  const section = buildSeasonalWorksSection([{
    kind: "anime",
    title: "蒼穹のカノン",
    titleEn: "Canon of the Blue Sky",
    hookJa: "この文字列は予定表へ渡さない。",
    hookEn: "Do not pass this hook to the daily plan.",
  }]);
  assert.match(section, /蒼穹のカノン/);
  assert.doesNotMatch(section, /この文字列は予定表へ渡さない/);
  assert.doesNotMatch(section, /Canon of the Blue Sky/);
});

test("夢にこそ作品名を出させ、禁止するのは勉強中だけ", () => {
  // 「かっこいいロボットが戦ってる夢」のような一般名詞で終わらせないため。
  const section = buildSeasonalWorksSection([{ kind: "anime", title: "蒼穹のカノン" }]);

  assert.match(section, /Sleep（夢の中）の予定こそ作品名を出してください/);
  assert.match(section, /Study 中の予定にだけは作品名を入れないこと/);
  assert.doesNotMatch(section, /Sleep 中の予定に作品名を入れないこと/);
});

test("種別は日本語で並べる（日本語プロンプトに英語キーを混ぜない）", () => {
  const section = buildSeasonalWorksSection([{ kind: "anime", title: "蒼穹のカノン" }]);

  assert.match(section, /アニメ・漫画・ゲーム・ドラマ・映画・小説・音楽・ホビー/);
  // 種別キーは JSON データ側にだけ残る。
  assert.doesNotMatch(section.split("\n")[1] ?? "", /anime・manga/);
});

test("メディアに触れる予定は一般名詞のままにさせない", () => {
  const section = buildSeasonalWorksSection([{ kind: "music", title: "蒼穹のカノン" }]);

  // 「4〜6件だけ具体化」だと残りが一般名詞で書かれてしまう。触れるなら必ず固有名詞、が正しい。
  assert.match(section, /必ず下の候補から具体的な名前を選んで予定文に書いてください/);
  assert.match(section, /「アニメ」「アニソン」/);
  assert.match(section, /その予定は作品に触れない別の内容にしてください/);
});

const works = [
  { kind: "anime", title: "蒼穹のカノン" },
  { kind: "music", title: "夜明けのオルカ" },
] as const;

test("固有名詞の無いメディア予定を見つける", () => {
  const events = [
    { status: "WakeUp", activity: "お気に入りのアニソンを聴きながらストレッチするよ" },
    { status: "Relax", activity: "「夜明けのオルカ」を聴いて今日を振り返るんだ" },
    { status: "FreeTime", activity: "モルフォと公園までサイクリングするんだ" },
    { status: "Sleep", activity: "かっこいいロボットのアニメの夢を見てる" },
  ];

  const generic = findGenericMediaEvents(events, [...works]);

  assert.deepEqual(
    generic.map((event) => event.status),
    ["WakeUp", "Sleep"],
  );
});

test("勉強中は作品名を入れない方針なので検査から外す", () => {
  const events = [{ status: "Study", activity: "アニメの話は我慢して数学の課題をやる" }];
  assert.deepEqual(findGenericMediaEvents(events, [...works]), []);
});

test("候補が空なら検査しない（無い日を責めない）", () => {
  const events = [{ status: "WakeUp", activity: "アニソンを聴くよ" }];
  assert.deepEqual(findGenericMediaEvents(events, []), []);
});

test("会話由来の作品名も固有名詞として一般名詞検査に使う", () => {
  const events = [{ status: "FreeTime", activity: "葬送のフリーレンのアニメを見る" }];
  assert.deepEqual(findGenericMediaEvents(events, [], ["葬送のフリーレン"]), []);
});

// ── 使った作品を覚えて、しばらく避ける ──────────────────
//
// music の候補は4件しかないのに、キャッシュは7日もつ。使用済みを持たないと
// 同じ曲が週に何度も予定表に載る。2026-08-24 の配信で botたんが同じ曲の話を
// 61発話中14回したのは、これが元。

test("表記が揺れても同じ作品として突き合わせる", () => {
  // LLM は全角・半角や大小文字を勝手に変える。素の includes だと印が付かない。
  assert.equal(normalizeForMatch("ＦＬＡＳＨＢＵＬＢ"), normalizeForMatch("flashbulb"));
  assert.equal(normalizeForMatch(" 蒼穹の カノン "), normalizeForMatch("蒼穹のカノン"));
});

test("予定に出た作品にだけ使用済みの印を付ける", () => {
  const works = [
    { kind: "music", title: "FLASHBULB" },
    { kind: "anime", title: "蒼穹のカノン" },
  ] as const;
  const marked = applyUsedMarks([...works], ["ｆｌａｓｈｂｕｌｂ"], "2026-08-24T12:00:00Z");

  assert.ok(marked);
  assert.equal(marked[0].lastUsedAt, "2026-08-24T12:00:00Z");
  assert.equal(marked[1].lastUsedAt, undefined);
});

test("どれにも当たらなければ書き戻さない", () => {
  const works = [{ kind: "music", title: "FLASHBULB" }] as const;
  assert.equal(applyUsedMarks([...works], ["別の曲"], "2026-08-24T12:00:00Z"), undefined);
  assert.equal(applyUsedMarks([...works], [], "2026-08-24T12:00:00Z"), undefined);
});

test("使った作品は保存され、件数が返る", async () => {
  const saved: SeasonalWorksState[] = [];
  const state: SeasonalWorksState = {
    season: "2026-summer",
    fetchedAt: "2026-08-17T20:28:08.130Z",
    works: [{ kind: "music", title: "FLASHBULB" }, { kind: "anime", title: "蒼穹のカノン" }],
  };
  const marked = await markSeasonalWorksUsed(["FLASHBULB"], new Date("2026-08-24T12:00:00Z"), {
    load: async () => state,
    save: async (next) => void saved.push(next),
  });

  assert.equal(marked, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].works[0].lastUsedAt, "2026-08-24T12:00:00.000Z");
  // 取得日時などは保つ。ここを落とすとキャッシュが即座に失効する
  assert.equal(saved[0].fetchedAt, state.fetchedAt);
});

test("直近3日で使った作品だけを「避けて」に挙げる", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  const titles = recentlyUsedTitles([
    { kind: "music", title: "きのう使った", lastUsedAt: "2026-08-23T12:00:00Z" },
    { kind: "music", title: "先週使った", lastUsedAt: "2026-08-17T12:00:00Z" },
    { kind: "music", title: "使っていない" },
    { kind: "music", title: "壊れた日時", lastUsedAt: "not a date" },
  ], now);

  assert.deepEqual(titles, ["きのう使った"]);
});

test("直近で使った作品はプロンプトで避けさせる（候補からは外さない）", () => {
  const now = new Date("2026-08-24T12:00:00Z");
  const section = buildSeasonalWorksSection([
    { kind: "music", title: "FLASHBULB", lastUsedAt: "2026-08-23T12:00:00Z" },
    { kind: "music", title: "べつの曲" },
  ], now);

  assert.match(section, /今日は次の候補を避けてください/);
  assert.match(section, /「FLASHBULB」/);
  // 候補一覧からは消さない。music は候補が数件しかなく、外すと枠ごと消える
  assert.match(section, /\{"kind":"music","title":"FLASHBULB"\}/);
});

test("避ける候補が無ければ、その行は出さない", () => {
  const section = buildSeasonalWorksSection([{ kind: "music", title: "べつの曲" }]);
  assert.doesNotMatch(section, /今日は次の候補を避けてください/);
});
