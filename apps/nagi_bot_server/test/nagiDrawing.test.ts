import assert from "node:assert/strict";
import test from "node:test";
import {
  createNagiDrawingQueue,
  nagiDrawingGiftText,
  nagiDrawingLang,
  nagiDrawingReplyThread,
  prepareNagiDrawingRequest,
  processNagiDrawingJob,
  type NagiDrawingDeps,
  type NagiDrawingJob,
  type NagiDrawingRequestDeps,
} from "../src/nagiDrawing.js";

const thread = {
  sourceUri: "at://did:plc:alice/com.suibari.nagi.post/3abc",
  authorDid: "did:plc:alice",
  lang: "ja" as const,
  root: { uri: "at://did:plc:alice/com.suibari.nagi.post/3abc", cid: "bafy-source" },
  parent: { uri: "at://did:plc:alice/com.suibari.nagi.post/3abc", cid: "bafy-source" },
};

const gift = (overrides: Partial<NagiDrawingJob> = {}): NagiDrawingJob =>
  ({ ...thread, kind: "gift", text: "第一志望に合格した！！", ...overrides }) as NagiDrawingJob;

const request = (overrides: Partial<NagiDrawingJob> = {}): NagiDrawingJob =>
  ({ ...thread, kind: "request", subject: "猫", day: "2026-09-14", ...overrides }) as NagiDrawingJob;

const image = { data: Buffer.from("png"), mimeType: "image/png", width: 832, height: 1216 };

function fakeDeps(overrides: Partial<NagiDrawingDeps> = {}) {
  const calls: string[] = [];
  const published: Array<{ text: string; hasImage: boolean }> = [];
  const deps: NagiDrawingDeps = {
    async hasDrawnToday() {
      calls.push("hasDrawnToday");
      return false;
    },
    async judgeGift() {
      calls.push("judgeGift");
      return { gift: true, mood: "very_happy", scene: "botたんがケーキで一緒に喜んでいる" };
    },
    async claim() {
      calls.push("claim");
      return { status: "claimed", day: "2026-09-14" };
    },
    async release(sourceUri, day) {
      calls.push(`release:${sourceUri}:${day}`);
    },
    async draw(sourceText) {
      calls.push(`draw:${sourceText.split("\n")[0]}`);
      return image;
    },
    async publish(_thread, content) {
      calls.push("publish");
      published.push({ text: content.text, hasImage: Boolean(content.image) });
    },
    ...overrides,
  };
  return { deps, calls, published };
}

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await run();
  } finally {
    Object.assign(console, { log, warn, error });
  }
};

test("2段階目は会話のルートではなく、起点のユーザー投稿へ直接返信する", () => {
  const root = { uri: "at://did:plc:bot/com.suibari.nagi.post/scheduled", cid: "bafy-root" };
  const source = { uri: thread.sourceUri, cid: "bafy-request" };
  assert.deepEqual(nagiDrawingReplyThread(source, root), { root, parent: source });
});

// ---------------------------------------------------------------------------
// 依頼
// ---------------------------------------------------------------------------

function fakeRequestDeps(overrides: Partial<NagiDrawingRequestDeps> = {}) {
  const calls: string[] = [];
  const enqueued: NagiDrawingJob[] = [];
  const deps: NagiDrawingRequestDeps = {
    available: () => true,
    async judgeRequest() {
      calls.push("judgeRequest");
      return { intent: "request", allowed: true, concern: "none", subject: "猫" };
    },
    async claim() {
      calls.push("claim");
      return { status: "claimed", day: "2026-09-14" };
    },
    enqueue(job) {
      enqueued.push(job);
      return true;
    },
    ...overrides,
  };
  return { deps, calls, enqueued };
}

const input = {
  sourceUri: thread.sourceUri,
  authorDid: thread.authorDid,
  text: "botたん、猫の絵描いて！",
  langs: ["ja"],
};

test("依頼なら枠を取って「描いてみるね」を返し、返信を投稿できたら描画を積む", async () => {
  const { deps, calls, enqueued } = fakeRequestDeps();
  const prepared = await prepareNagiDrawingRequest(input, deps);
  assert.ok(prepared);
  assert.match(prepared.comment, /「猫」、いまから描いてみるね/);
  assert.deepEqual(calls, ["judgeRequest", "claim"]);
  // 返信の cid が決まるまでは積まない（絵をぶら下げる先が無い）。
  assert.equal(enqueued.length, 0);

  prepared.onReplyPosted?.({ root: thread.root, parent: thread.parent });
  assert.deepEqual(enqueued, [request()]);
});

test("絵の話をしていない投稿や描けない状態では判定しない", async () => {
  const noHint = fakeRequestDeps();
  assert.equal(await prepareNagiDrawingRequest({ ...input, text: "今日は晴れ" }, noHint.deps), undefined);
  assert.deepEqual(noHint.calls, []);

  const unavailable = fakeRequestDeps({ available: () => false });
  assert.equal(await prepareNagiDrawingRequest(input, unavailable.deps), undefined);
  assert.deepEqual(unavailable.calls, []);
});

test("依頼でなければ通常の返信へ流す", async () => {
  const { deps, calls } = fakeRequestDeps({ judgeRequest: async () => ({ intent: "none" }) });
  assert.equal(await prepareNagiDrawingRequest(input, deps), undefined);
  assert.equal(calls.includes("claim"), false);
});

test("描けない依頼は枠を取らずに断る", async () => {
  const { deps, calls } = fakeRequestDeps({
    judgeRequest: async () => ({
      intent: "request",
      allowed: false,
      concern: "real_person",
      subject: "有名人",
    }),
  });
  const prepared = await quiet(() => prepareNagiDrawingRequest(input, deps));
  assert.ok(prepared);
  assert.match(prepared.comment, /描けないんだ/);
  assert.equal(prepared.onReplyPosted, undefined);
  assert.equal(calls.includes("claim"), false);
});

test("サービス枠が無ければ理由を返して描かない。機能停止中は通常の返信へ流す", async () => {
  const limited = fakeRequestDeps({ claim: async () => ({ status: "service_limit", day: "2026-09-14" }) });
  const prepared = await prepareNagiDrawingRequest(input, limited.deps);
  assert.ok(prepared);
  assert.match(prepared.comment, /手がくたくた/);
  assert.equal(prepared.onReplyPosted, undefined);

  const disabled = fakeRequestDeps({ claim: async () => ({ status: "disabled", day: "2026-09-14" }) });
  assert.equal(await prepareNagiDrawingRequest(input, disabled.deps), undefined);
});

test("依頼の絵は描いて投稿し、描けなければ枠を返して知らせる", async () => {
  const drawn = fakeDeps();
  assert.equal(await processNagiDrawingJob(request(), drawn.deps), "drawn");
  assert.deepEqual(drawn.calls, ["draw:### 描いてほしいと頼まれた絵", "publish"]);
  assert.deepEqual(drawn.published, [{ text: "できたよ！「猫」を描いてみたよ。受け取ってくれたらうれしいな。", hasImage: true }]);

  const failed = fakeDeps({ draw: async () => null });
  assert.equal(await processNagiDrawingJob(request(), failed.deps), "failed");
  assert.ok(failed.calls.includes(`release:${thread.sourceUri}:2026-09-14`));
  assert.equal(failed.published.length, 1);
  assert.equal(failed.published[0].hasImage, false);
  assert.match(failed.published[0].text, /うまく描けなかった/);
});

// ---------------------------------------------------------------------------
// 贈り物
// ---------------------------------------------------------------------------

test("気持ちが大きく動いた投稿には、判定後に枠を取ってその場面を描いて贈る", async () => {
  const { deps, calls, published } = fakeDeps();
  assert.equal(await processNagiDrawingJob(gift(), deps), "drawn");
  assert.deepEqual(calls, ["hasDrawnToday", "judgeGift", "claim", "draw:### botたんが贈る絵の場面", "publish"]);
  assert.equal(published[0].hasImage, true);
});

test("自動プレゼントは同じ人に1日1回だけで、判定の LLM も再実行しない", async () => {
  const { deps, calls } = fakeDeps({ hasDrawnToday: async () => true });
  assert.equal(await processNagiDrawingJob(gift(), deps), "already_drawn");
  assert.deepEqual(calls, []);
});

test("気持ちが動いていなければ枠を取らず、枠が無ければ描かない", async () => {
  const notMoved = fakeDeps({ judgeGift: async () => ({ gift: false }) });
  assert.equal(await processNagiDrawingJob(gift(), notMoved.deps), "not_moved");
  assert.deepEqual(notMoved.calls, ["hasDrawnToday"]);

  const limited = fakeDeps({ claim: async () => ({ status: "service_limit", day: "2026-09-14" }) });
  assert.equal(await processNagiDrawingJob(gift(), limited.deps), "limited");
  assert.equal(limited.calls.some((call) => call.startsWith("draw")), false);
});

test("贈れなかったときは枠を返すが、頼まれていないので知らせない", async () => {
  const noImage = fakeDeps({ draw: async () => null });
  assert.equal(await processNagiDrawingJob(gift(), noImage.deps), "failed");
  assert.ok(noImage.calls.includes(`release:${thread.sourceUri}:2026-09-14`));
  assert.equal(noImage.published.length, 0);

  const publishFails = fakeDeps({
    publish: async () => {
      throw new Error("PDS down");
    },
  });
  assert.equal(await quiet(() => processNagiDrawingJob(gift(), publishFails.deps)), "failed");
  assert.ok(publishFails.calls.includes(`release:${thread.sourceUri}:2026-09-14`));
});

test("本文の無い投稿（画像だけ）には贈り物の判定をしない", async () => {
  const { deps, calls } = fakeDeps();
  assert.equal(await processNagiDrawingJob(gift({ text: "  " }), deps), "empty");
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// キュー
// ---------------------------------------------------------------------------

test("キューは直列で処理し、同じ人の贈り物は新しい投稿で置き換える", async () => {
  await quiet(async () => {
    const judged: string[] = [];
    let release!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = fakeDeps({
      async judgeGift(text) {
        judged.push(text);
        if (judged.length === 1) await firstBlocked;
        return { gift: false };
      },
    });
    const queue = createNagiDrawingQueue(deps);

    assert.equal(queue.enqueue(gift({ authorDid: "did:plc:alice", text: "a1" })), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.enqueue(gift({ authorDid: "did:plc:bob", text: "b1" })), true);
    assert.equal(queue.enqueue(gift({ authorDid: "did:plc:bob", text: "b2" })), true);
    assert.equal(queue.size(), 1);

    release();
    await queue.idle();
    assert.deepEqual(judged, ["a1", "b2"]);
  });
});

test("溢れた贈り物は捨てるが、枠を取った依頼は捨てない", async () => {
  await quiet(async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps } = fakeDeps({
      async hasDrawnToday() {
        await blocked;
        return true;
      },
    });
    const queue = createNagiDrawingQueue(deps, 1);
    assert.equal(queue.enqueue(gift({ authorDid: "did:plc:a" })), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queue.enqueue(gift({ authorDid: "did:plc:b" })), true);
    assert.equal(queue.enqueue(gift({ authorDid: "did:plc:c" })), false);
    assert.equal(queue.enqueue(request({ authorDid: "did:plc:d" })), true);
    assert.equal(queue.size(), 2);
    release();
    await queue.idle();
  });
});

test("本文は投稿の言語に合わせ、贈り物の喜びの側でも祝福の断定をしない", () => {
  assert.equal(nagiDrawingLang(["ja-JP"]), "ja");
  assert.equal(nagiDrawingLang(["en"]), "en");
  assert.equal(nagiDrawingLang(undefined), "en");
  // very_happy は達成とは限らない。未完了のことを祝う事故を起こさない。
  assert.doesNotMatch(nagiDrawingGiftText("very_happy", "ja"), /おめでとう/);
  assert.doesNotMatch(nagiDrawingGiftText("very_happy", "en"), /congrat/i);
});
