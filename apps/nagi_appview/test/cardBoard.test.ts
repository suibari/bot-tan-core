import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.NAGI_BOT_DID ??= "did:plc:bot";

const { giftLedgerIdOf, giftSubjectUri, pickDonor } = await import(
  "../src/queries/cardBoard.js"
);

test("提供者は枚数で重み付けして選ぶ（1枚ずつが等しく選ばれる）", () => {
  const stock = [
    { donorDid: "did:plc:a", count: 1 },
    { donorDid: "did:plc:b", count: 3 },
  ];
  const picked = [0, 1, 2, 3].map((r) => pickDonor(stock, () => r));
  assert.deepEqual(picked, ["did:plc:a", "did:plc:b", "did:plc:b", "did:plc:b"]);
});

test("届きました通知の subject から台帳の行を引き戻せる", () => {
  const uri = giftSubjectUri("did:plc:taker", "0d5f2c1e-0000-4000-8000-000000000000");
  assert.equal(giftLedgerIdOf(uri), "0d5f2c1e-0000-4000-8000-000000000000");
  assert.equal(giftLedgerIdOf("at://did:plc:x/com.suibari.nagi.post/abc"), undefined);
});
