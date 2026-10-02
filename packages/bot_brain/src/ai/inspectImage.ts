import { isOllamaConfigured, ollamaChat } from "../ollamaChat.js";
import { prepareModelImages } from "./imagePreprocess.js";
import type { GeneratedImage } from "./imageGenClient.js";

/**
 * 生成した絵の「腕の付き方」を、投稿する前に常駐の gemma で見る。
 *
 * ## 経緯
 * 2026-10-01 の Nagi お絵描きで、腕が反対側の肩から胸を横切って生え、もう片方の腕が
 * 消えている絵がそのまま投稿された。negative prompt の `bad anatomy` は確率を下げるだけで、
 * 出たものを止めはしない。投稿した絵は取り消せないので、出口で1枚ずつ見る。
 * おやすみポスト・お絵描き（Bluesky / Nagi）はすべて generateImage を通るので、ここで全部に効く。
 *
 * ## 何を聞くか（2026-10-02 実測、gemma-4-12B、本番の直近16枚）
 * 最初は「破綻を種類別に列挙させる」形にしたが、**16枚全部を不合格にした。**
 * クレヨン画風のミトン状の手を毎回 `malformed_hand` と読み、肝心の腕の左右逆は捉えなかった。
 *
 * 腕1本ずつ「どちらの肩から出て、手がどちらに来るか」を辿らせる形に変えると、
 * 不合格3枚（問題の絵、同じ型でマグを持つ絵、脚が1本の走る絵）はすべて目視でも破綻で、
 * 残り13枚に誤検出は無かった。1枚 3 秒前後。手の形や指の本数は聞かない（画風で必ず誤検出する）。
 *
 * ## 全体像だけを送る
 * 腕の繋がりは全体を見ないと分からない。タイルを足すと局所の手の形に引っ張られる。
 * 上の実測も全体像1枚で取った。
 *
 * ## 迷ったら落とす
 * 検査が失敗した（Ollama が落ちた・JSON が壊れた）ときも不合格に倒す。見逃した絵は
 * 取り消せないが、描かなかった絵は「描けなかった」で済む（judgeDrawing.ts と同じ方針）。
 */

export type ImageInspection =
  | { ok: true; skipped?: true }
  /** inspectionFailed: 絵ではなく検査が駄目だった。描き直しても同じなので描き直さない。 */
  | { ok: false; reasons: string[]; inspectionFailed?: true };

const SIDE = ["viewer_left", "viewer_right", "hidden"] as const;
const HAND_SIDE = ["viewer_left", "viewer_right", "center", "hidden"] as const;

const ARM_SCHEMA = {
  type: "object",
  properties: {
    visible: { type: "boolean" },
    shoulder_side: { type: "string", enum: SIDE },
    hand_side: { type: "string", enum: HAND_SIDE },
    crosses_body: { type: "boolean" },
    occluded_by: { type: "string" },
  },
  required: ["visible", "shoulder_side", "hand_side", "crosses_body", "occluded_by"],
};

const INSPECT_SCHEMA = {
  type: "object",
  properties: {
    right_arm: ARM_SCHEMA,
    left_arm: ARM_SCHEMA,
    arm_count: { type: "integer" },
    verdict: { type: "string", enum: ["ok", "wrong"] },
  },
  required: ["right_arm", "left_arm", "arm_count", "verdict"],
};

/** 文言は実測した形のまま。変えたら scripts 側で直近の絵を流し直すこと。 */
const INSPECT_SYSTEM = `You check AI-generated anime illustrations for one specific defect: arms attached to the wrong side of the body.
For the main character, trace each arm carefully from the shoulder, along the sleeve, to the hand. Use the character's own left/right (her right arm is on the viewer's LEFT when she faces the viewer).
For each of her arms report:
- visible: is any part of this arm drawn?
- shoulder_side: which side of her torso the sleeve starts from, as seen by the viewer ("viewer_left", "viewer_right", "hidden")
- hand_side: where the hand of that arm ends up ("viewer_left", "viewer_right", "center", "hidden")
- crosses_body: does the sleeve travel across the front of her chest to the other side?
- occluded_by: if the arm is not visible, what covers it (hair, object, frame, other body part) or "nothing"
Then set verdict:
- "wrong" if a sleeve starts from one shoulder and its hand appears on the other side while the other arm is missing with nothing covering it, if an arm grows from the wrong place, or if there are more than two arms.
- "ok" otherwise. Crayon/simple drawing style, mitten-like hands and hands hidden behind objects are fine.`;

type RawArm = { shoulder_side?: unknown; hand_side?: unknown };

const describeArm = (name: string, arm: RawArm | undefined) =>
  `${name}: ${String(arm?.shoulder_side ?? "?")} -> ${String(arm?.hand_side ?? "?")}`;

/**
 * 検査の JSON を合否にする。Ollama を起こさずにテストするため切り出してある。
 * 判定できない形はすべて不合格に倒す。
 *
 * arm_count は合否に使わない。人物が2人いる絵で全員ぶんを数えることがある（実測で4）。
 */
export function judgeImageInspection(parsed: unknown): ImageInspection {
  const value = parsed as { right_arm?: RawArm; left_arm?: RawArm; verdict?: unknown } | null;
  if (value?.verdict === "ok") return { ok: true };
  if (value?.verdict !== "wrong") return { ok: false, reasons: ["inspection result was malformed"] };
  return {
    ok: false,
    reasons: [describeArm("right_arm", value.right_arm), describeArm("left_arm", value.left_arm)],
  };
}

/** `IMAGEGEN_INSPECT=0` で検査を止める。module scope で読まない（dotenv より先に評価されるため）。 */
export function isImageInspectionEnabled(): boolean {
  return process.env.IMAGEGEN_INSPECT?.trim() !== "0";
}

/** 不合格のとき描き直す回数。既定1。GPU を占有するので最大2に抑える。 */
export function imageInspectionRedraws(): number {
  const value = Number(process.env.IMAGEGEN_INSPECT_REDRAWS?.trim() || 1);
  if (!Number.isFinite(value) || value < 0) return 1;
  return Math.min(Math.floor(value), 2);
}

export async function inspectGeneratedImage(image: GeneratedImage): Promise<ImageInspection> {
  if (!isImageInspectionEnabled()) return { ok: true, skipped: true };
  if (!isOllamaConfigured()) {
    console.warn("[WARN][IMGGEN_INSPECT] Ollama が未設定なので絵の検査をしない。");
    return { ok: true, skipped: true };
  }
  try {
    const prepared = (await prepareModelImages(image.data, image.mimeType, { strict: true }))
      .filter((item) => item.kind === "whole");
    if (!prepared.length) return { ok: false, reasons: ["image could not be decoded"], inspectionFailed: true };
    const raw = await ollamaChat(
      "BSKY_IMAGE_INSPECT",
      [
        { role: "system", content: INSPECT_SYSTEM },
        {
          role: "user",
          content: "Inspect this illustration.",
          images: prepared.map((item) => item.data),
        },
      ],
      { maxTokens: 600, temperature: 0, timeoutMs: 120_000, format: INSPECT_SCHEMA },
    );
    return judgeImageInspection(JSON.parse(raw || "null"));
  } catch (error) {
    console.warn("[WARN][IMGGEN_INSPECT] 絵の検査に失敗した。不合格として扱う:", error);
    return { ok: false, reasons: ["inspection failed"], inspectionFailed: true };
  }
}
