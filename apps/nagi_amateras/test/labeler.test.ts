import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AmaterasLabeler,
  isPermanentModerationInputError,
} from "../src/labeler.js";
import { CONFIG } from "../src/config.js";
import fs from "fs";
import path from "path";

describe("AmaterasLabeler Internal API", () => {
  let labeler: AmaterasLabeler;
  const testDbPath = path.join("/tmp", `amateras-labeler-${process.pid}.db`);
  let originalToken: string;
  let originalDbPath: string;

  beforeEach(() => {
    originalToken = CONFIG.internalToken;
    originalDbPath = CONFIG.dbPath;
    CONFIG.internalToken = "";
    CONFIG.dbPath = testDbPath;
    labeler = new AmaterasLabeler();
  });

  afterEach(async () => {
    await labeler.internalApi.close();
    labeler.server.db.close();
    CONFIG.internalToken = originalToken;
    CONFIG.dbPath = originalDbPath;
    for (const suffix of ["", "-shm", "-wal"])
      fs.rmSync(`${testDbPath}${suffix}`, { force: true });
  });

  it("responds to /health with status ok and labeler DID", async () => {
    const response = await labeler.internalApi.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("nagi_amateras");
    expect(body.did).toBeDefined();
  });

  it("accepts only Nagi post URIs for evaluation", async () => {
    const response = await labeler.internalApi.inject({
      method: "POST",
      url: "/api/evaluate",
      payload: {
        uri: "at://did:plc:test/app.bsky.feed.post/1",
        cid: "bafytest",
        did: "did:plc:test",
        record: { $type: "app.bsky.feed.post", text: "test" },
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it("does not expose manual label write endpoints", async () => {
    const response = await labeler.internalApi.inject({
      method: "POST",
      url: "/api/label",
      payload: {
        uri: "at://did:plc:test/com.suibari.nagi.post/1",
        labels: ["sexual"],
      },
    });

    expect(response.statusCode).toBe(404);
  });

  it("requires a bearer token when the internal token is configured", async () => {
    CONFIG.internalToken = "test-secret";
    const response = await labeler.internalApi.inject({
      method: "POST",
      url: "/api/evaluate",
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("classifies only permanent input failures as non-retryable", () => {
    expect(isPermanentModerationInputError({ status: 400 })).toBe(true);
    expect(isPermanentModerationInputError({ status: 413 })).toBe(true);
    expect(isPermanentModerationInputError({ status: 422 })).toBe(true);
    expect(isPermanentModerationInputError({ status: 401 })).toBe(false);
    expect(isPermanentModerationInputError({ status: 429 })).toBe(false);
    expect(isPermanentModerationInputError({ status: 500 })).toBe(false);
  });
});
