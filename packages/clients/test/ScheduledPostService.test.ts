import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEDULED_POST_BODY_LIMIT_BYTES,
  scheduledPostErrorDetails,
} from "../src/ScheduledPostService.js";

test("最大画像をbase64化した予約投稿がbody上限に収まる", () => {
  const request = {
    kind: "good-night",
    text: "おやすみ".repeat(1_000),
    translations: [{ lang: "en", text: "Good night".repeat(1_000) }],
    image: {
      dataBase64: Buffer.alloc(950_000).toString("base64"),
      mimeType: "image/jpeg",
      width: 1200,
      height: 900,
      alt: "今日のできごと".repeat(100),
    },
  };

  assert.ok(Buffer.byteLength(JSON.stringify(request)) < SCHEDULED_POST_BODY_LIMIT_BYTES);
});

test("Axiosエラー要約へ送信payloadを含めない", () => {
  const details = scheduledPostErrorDetails({
    isAxiosError: true,
    message: "Request failed with status code 413",
    code: "ERR_BAD_REQUEST",
    config: { data: "secret-image-base64" },
    response: {
      status: 413,
      statusText: "Payload Too Large",
      data: "Payload Too Large",
    },
  });

  assert.deepEqual(details, {
    message: "Request failed with status code 413",
    code: "ERR_BAD_REQUEST",
    status: 413,
    statusText: "Payload Too Large",
    response: "Payload Too Large",
  });
  assert.doesNotMatch(JSON.stringify(details), /secret-image-base64/);
});
