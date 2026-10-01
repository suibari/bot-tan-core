import { Jetstream } from "@skyware/jetstream";
import ws from "ws";
import {
  db,
  nagiIngestState,
  reportHealthFailure,
  reportHeartbeat,
} from "@bsky-affirmative-bot/database";
import { NAGI_INGEST_COLLECTIONS } from "@bsky-affirmative-bot/nagi-lexicon";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { botWriteWatch } from "./botWriteWatch.js";
import { withDidLock } from "./didLock.js";
import { processEvent } from "./processEvent.js";
import { prioritizeReconcile, setIngestDegraded } from "./reconcileWorker.js";
import { SerialRetryQueue } from "./serialQueue.js";

/**
 * 同一エンドポイントへの再接続をここまで続けても繋がらなければ、次の候補へ移る。
 * 短い瞬断は @skyware/jetstream 内部の partysocket が勝手に張り直すので、こちらは
 * 「そのインスタンス自体が死んでいる」と判断できるだけの時間を待ってから動く。
 */
const ROTATE_AFTER_MS = 20_000;
/** 切断がこれ以上続いたら、reconcile を短周期に切り替えて PDS 直読みで追従する。 */
const DEGRADED_AFTER_MS = 60_000;
/** botたんの書き込みが届いているかを確かめる間隔。しきい値は config.jetstreamStallSeconds。 */
const STALL_CHECK_MS = 30_000;

export async function startJetstream() {
  const endpoints = config.jetstreamUrls;
  const queue = new SerialRetryQueue<any>(
    (evt) =>
      withDidLock(String(evt.did ?? ""), async () => {
        // 取り込めたイベントの持ち主だけ優先巡回に回す。購読している site.standard.document は
        // ネットワーク全体から届くので、無条件に回すと Nagi と無関係なブログの持ち主まで
        // 15分おきに全コレクション照合することになり（2026-10-01 は1日で約1,400 DID）、
        // 本当に急ぐ DID の順番が回ってこなくなる。
        if (await processEvent(evt)) prioritizeReconcile(String(evt.did ?? ""));
      }),
    ({ item: evt, error, attempt, delayMs }) => {
      console.error("[ERROR][jetstream] Event processing failed; retrying", {
        did: evt?.did,
        collection: evt?.commit?.collection,
        rkey: evt?.commit?.rkey,
        attempt,
        delayMs,
        error,
      });
    },
  );

  const enqueue = (evt: any) => {
    // 到着の記録は処理待ちの列に入る前に取る。測りたいのは上流の遅れで、こちらの列の長さではない。
    botWriteWatch.observe(evt);
    queue.enqueue(evt);
  };

  let stream: Jetstream<any, any> | undefined;
  let stopping = false;
  let connected = false;
  /** 接続は生きているが、botたんの書き込みが期限内に届いていない。 */
  let stalled = false;
  let connectedAt = 0;
  let endpointIndex = 0;
  let rotations = 0;
  let rotateTimer: NodeJS.Timeout | undefined;
  let degradedTimer: NodeJS.Timeout | undefined;

  const endpoint = () => endpoints[endpointIndex];

  const reportConnected = () => {
    // 遅延中に ok を書くと、直前の失敗報告を上書きして監視上は正常に戻ってしまう。
    if (!connected || stalled) return;
    reportHeartbeat("jetstream-appview", {
      endpoint: endpoint(),
      rotations,
      ...botWriteWatch.snapshot(),
    }).catch((error) =>
      console.error("[ERROR][APPVIEW][JETSTREAM] Failed to report heartbeat:", error),
    );
  };
  const heartbeat = setInterval(reportConnected, 30_000);
  heartbeat.unref();

  /**
   * 再開位置は接続のたびに DB から読み直す。processEvent / applyMutation が受信のたびに
   * nagi_ingest_state を進めているので、別インスタンスへ乗り換えても続きから拾える。
   * カーソルは unix マイクロ秒の時刻ベースで、公式インスタンス間で共通に使える。
   */
  const loadCursor = async (): Promise<number | undefined> => {
    const saved = await db
      .select()
      .from(nagiIngestState)
      .where(eq(nagiIngestState.key, "jetstream"))
      .limit(1);
    if (!saved[0]) return undefined;
    return Math.max(0, saved[0].cursor - config.jetstreamReplaySeconds * 1_000_000);
  };

  const clearTimers = () => {
    if (rotateTimer) clearTimeout(rotateTimer);
    rotateTimer = undefined;
    if (degradedTimer) clearTimeout(degradedTimer);
    degradedTimer = undefined;
  };

  /** 切断中に走らせるタイマー群。接続できたら open ハンドラが全部畳む。 */
  const armDisconnectTimers = () => {
    if (stopping) return;
    // 候補が1本しかないなら、張り直しても同じ先なので partysocket に任せきる。
    if (!rotateTimer && endpoints.length > 1) {
      rotateTimer = setTimeout(rotate, ROTATE_AFTER_MS);
      rotateTimer.unref();
    }
    if (!degradedTimer) {
      degradedTimer = setTimeout(() => {
        degradedTimer = undefined;
        if (!connected && !stopping) setIngestDegraded(true);
      }, DEGRADED_AFTER_MS);
      degradedTimer.unref();
    }
  };

  /**
   * 次の候補へ乗り換える。カーソルは DB から読み直すので、遅れていた接続で
   * まだ受け取っていない区間は新しい接続先が埋める。
   */
  const switchEndpoint = (reason: "disconnected" | "lagging") => {
    endpointIndex = (endpointIndex + 1) % endpoints.length;
    rotations++;
    console.warn("[WARN][jetstream] Rotating endpoint", {
      endpoint: endpoint(),
      rotations,
      reason,
    });
    connected = false;
    // partysocket は close() で再接続を止めるので、旧接続と二重に走らせずに済む。
    const previous = stream;
    stream = undefined;
    previous?.close();
    connect().catch((error) => {
      console.error("[ERROR][jetstream] Failed to connect after rotation", error);
      armDisconnectTimers();
    });
  };

  const rotate = () => {
    rotateTimer = undefined;
    if (stopping || connected) return;
    switchEndpoint("disconnected");
  };

  /**
   * 接続は生きているのに、botたんの書き込みが期限を過ぎても届かない状態を拾う。
   * 2026-10-01 は jetstream2.us-east が約52分遅れて配り続け、接続が切れないので
   * 切り替えも degraded も一度も起きなかった。
   */
  const checkStall = () => {
    if (stopping || !connected) return;
    if (!botWriteWatch.isLagging()) {
      if (stalled) {
        stalled = false;
        console.log("[INFO][jetstream] Bot writes are arriving again", {
          endpoint: endpoint(),
          ...botWriteWatch.snapshot(),
        });
        setIngestDegraded(false);
        reportConnected();
      }
      return;
    }
    // 切り替え直後は延ばした期限まで新しい接続先の追いつきを待つ。
    const overdue = botWriteWatch.overdue();
    if (!overdue.length) return;
    stalled = true;
    const waitedMinutes = Math.round(overdue[0].waitedMs / 60_000);
    console.warn("[WARN][jetstream] Connected but bot writes are not arriving", {
      endpoint: endpoint(),
      overdue: overdue.length,
      oldest: overdue[0],
    });
    reportHealthFailure(
      "jetstream-appview",
      new Error(
        `接続中だが botたんの書き込みが${waitedMinutes}分届いていない (${endpoint()})`,
      ),
    ).catch(() => {});
    // 届くまでは PDS 直読みの短周期巡回で埋める。表示に効く bot の書き込みは
    // 取り込み依頼で反映済みなので、ここで拾うのはユーザー側の取りこぼし。
    setIngestDegraded(true);
    const abandoned = botWriteWatch.markStalled();
    if (abandoned.length)
      console.warn("[WARN][jetstream] Gave up waiting for bot writes", {
        uris: abandoned,
      });
    if (endpoints.length > 1) switchEndpoint("lagging");
  };
  const stallTimer = setInterval(checkStall, STALL_CHECK_MS);
  stallTimer.unref();

  const onDisconnect = (error: unknown) => {
    connected = false;
    reportHealthFailure("jetstream-appview", error).catch(() => {});
    armDisconnectTimers();
  };

  const connect = async () => {
    if (stopping) return;
    const cursor = await loadCursor();
    if (stopping) return;
    const current = endpoint();
    const started = new Jetstream({
      ws,
      endpoint: current,
      wantedCollections: [...NAGI_INGEST_COLLECTIONS],
      cursor,
    });
    stream = started;

    for (const collection of NAGI_INGEST_COLLECTIONS) {
      started.onCreate(collection, enqueue);
      started.onUpdate(collection, enqueue);
      started.onDelete(collection, enqueue);
    }
    started.on("open", () => {
      // ローテーション後に旧接続の open が遅れて届いても、現行接続の状態を壊さない。
      if (started !== stream) return;
      connected = true;
      connectedAt = Date.now();
      clearTimers();
      // 遅延判定中なら degraded を解かない。解くのは書き込みが届いたのを確かめてから。
      setIngestDegraded(stalled);
      // 再接続は partysocket が内部で張り直すので、カーソルは接続時の値ではなく
      // ライブラリが受信のたびに進めている現在値を出す。
      console.log("[INFO][jetstream] Connected", {
        endpoint: current,
        cursor: started.cursor,
      });
      reportConnected();
    });
    started.on("error", (error) => {
      if (started !== stream) return;
      console.error(error);
      onDisconnect(error);
    });
    started.on("close", () => {
      if (started !== stream || stopping) return;
      onDisconnect(new Error("Jetstream connection closed"));
    });
    started.start();
    // @skyware/jetstream は close の理由を捨てるので、下の WebSocket から拾う。
    // 理由が残らないと、短い周期で切れ続けても原因の当たりが付けられない。
    (started.ws as any)?.addEventListener?.("close", (event: any) => {
      if (started !== stream || stopping) return;
      console.warn("[WARN][jetstream] Connection closed", {
        endpoint: current,
        code: event?.code,
        reason: event?.reason || undefined,
        connectedForMs: connectedAt ? Date.now() - connectedAt : undefined,
      });
    });
    // 初回接続が open に至らない場合もローテーションできるよう、ここで先に仕掛けておく。
    armDisconnectTimers();
  };

  await connect();

  return {
    async close() {
      stopping = true;
      clearInterval(heartbeat);
      clearInterval(stallTimer);
      clearTimers();
      stream?.close();
      await queue.close();
    },
    get queued() {
      return queue.size;
    },
  };
}
