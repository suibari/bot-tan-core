import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loopbackUrlFromPort } from "../src/config/loopbackUrl.js";

const PORT_ENV = "TEST_INTERNAL_SERVICE_PORT";

afterEach(() => {
  delete process.env[PORT_ENV];
});

test("内部APIのURLを指定portのloopbackへ固定する", () => {
  process.env[PORT_ENV] = "3205";
  assert.equal(loopbackUrlFromPort(PORT_ENV, 3004), "http://127.0.0.1:3205");
});

test("port未設定時はサービス固有の既定値を使う", () => {
  assert.equal(loopbackUrlFromPort(PORT_ENV, 3401), "http://127.0.0.1:3401");
});

test("不正なportを黙って別の接続先へ倒さない", () => {
  for (const value of ["0", "65536", "3.5", "not-a-port"]) {
    process.env[PORT_ENV] = value;
    assert.throws(
      () => loopbackUrlFromPort(PORT_ENV, 3004),
      new RegExp(`${PORT_ENV} must be an integer`),
    );
  }
});
