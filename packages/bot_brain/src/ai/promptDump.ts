/**
 * 送信直前のプロンプトをファイルへ吐く、調査用の足場。
 *
 * これが無かったせいで「実際に何がどの順で送られたか」を知る手段が無く、
 * プロンプトの並びをコードから逆算するしかなかった（botContext と grounding が
 * ユーザ投稿の**後ろ**に着地していた事故は、そうやってしか見つけられなかった）。
 *
 * 本番のホットパスなので、`AI_PROMPT_DUMP_DIR` が無いときは fs に一切触れない。
 * 書き込みは待たない（生成のレイテンシに乗せない）。失敗しても生成は続ける。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** base64 の画像は数MBになるので、長さだけ残して捨てる。 */
function redactImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactImages);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === "images" && Array.isArray(item)) {
      result[key] = item.map((image) =>
        typeof image === "string" ? `[image ${image.length}B]` : image,
      );
      continue;
    }
    if (key === "inlineData" && item && typeof item === "object") {
      const inline = item as { mimeType?: unknown; data?: unknown };
      result[key] = {
        mimeType: inline.mimeType,
        data:
          typeof inline.data === "string"
            ? `[image ${inline.data.length}B]`
            : inline.data,
      };
      continue;
    }
    result[key] = redactImages(item);
  }
  return result;
}

/** ファイル名に使える形へ。モデル名には `/` や `:` が入る。 */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}

export function dumpPromptAsync(
  provider: string,
  model: string,
  payload: Record<string, unknown>,
): void {
  const dir = process.env.AI_PROMPT_DUMP_DIR?.trim();
  if (!dir) return;
  const name = `${Date.now()}-${provider}-${sanitize(model || "unknown")}.json`;
  void (async () => {
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, name),
        JSON.stringify(
          { provider, model, ...(redactImages(payload) as object) },
          null,
          2,
        ),
      );
    } catch (error) {
      console.warn(
        `[WARN][AI_PROMPT_DUMP] ${name} を書けなかった`,
        error instanceof Error ? error.message : error,
      );
    }
  })();
}
