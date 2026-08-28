import assert from "node:assert/strict";
import test from "node:test";
import type { EmojiView } from "@bsky-affirmative-bot/nagi-lexicon";
import {
  indexEmoji,
  selectEmojiAliasResolutions,
} from "../src/services/emoji.js";

type StoredEmoji = {
  uri: string;
  cid: string;
  did: string;
  name: string;
};

const record = (name: string, createdAt: string) => ({
  name,
  createdAt,
  formats: {
    $type: "blue.moji.collection.item#formats_v0",
    webp_128: {
      ref: { $link: "bafkreiemoji" },
      mimeType: "image/webp",
      size: 100,
    },
  },
});

const executor = (uniqueName: boolean) => {
  const rows = new Map<string, StoredEmoji>();
  let pendingUpdate: StoredEmoji | undefined;
  return {
    rows,
    db: {
      insert: () => ({
        values: (values: StoredEmoji) => ({
          onConflictDoNothing: async () => {
            const nameConflict = [...rows.values()].some(
              (row) =>
                uniqueName &&
                row.did === values.did &&
                row.name === values.name,
            );
            if (!rows.has(values.uri) && !nameConflict)
              rows.set(values.uri, { ...values });
          },
        }),
      }),
      update: () => ({
        set: (values: StoredEmoji) => {
          pendingUpdate = values;
          return {
            where: async () => {
              if (pendingUpdate && rows.has(pendingUpdate.uri))
                rows.set(pendingUpdate.uri, { ...pendingUpdate });
            },
          };
        },
      }),
    },
  };
};

test("indexes same-name Bluemoji by URI after the legacy unique index is removed", async () => {
  const did = "did:example:emoji";
  const first = {
    uri: `at://${did}/blue.moji.collection.item/first`,
    cid: "bafyreifirst",
    did,
    record: record(":thx:", "2026-07-30T04:53:35.603Z"),
  };
  const second = {
    uri: `at://${did}/blue.moji.collection.item/second`,
    cid: "bafyreisecond",
    did,
    record: record(":thx:", "2026-07-30T05:03:19.373Z"),
  };

  const legacy = executor(true);
  await indexEmoji(legacy.db as never, first);
  await indexEmoji(legacy.db as never, second);
  assert.deepEqual([...legacy.rows.keys()], [first.uri]);

  const migrated = executor(false);
  await indexEmoji(migrated.db as never, first);
  await indexEmoji(migrated.db as never, second);
  assert.deepEqual([...migrated.rows.keys()], [first.uri, second.uri]);
});

test("updates the current value of an existing Bluemoji URI", async () => {
  const did = "did:example:emoji";
  const uri = `at://${did}/blue.moji.collection.item/thx`;
  const target = executor(false);
  await indexEmoji(target.db as never, {
    uri,
    cid: "bafyreiold",
    did,
    record: record(":thx:", "2026-07-30T04:53:35.603Z"),
  });
  await indexEmoji(target.db as never, {
    uri,
    cid: "bafyreinew",
    did,
    record: record(":thanks:", "2026-08-08T08:00:00.000Z"),
  });

  assert.equal(target.rows.get(uri)?.cid, "bafyreinew");
  assert.equal(target.rows.get(uri)?.name, ":thanks:");
});

test("resolves an alias to the source URI before the newest same-name candidate", () => {
  const emoji = (uri: string, name = ":thx:"): EmojiView => ({
    uri,
    cid: `bafy${uri.slice(-3)}`,
    did: uri.split("/")[2],
    name,
    url: "/api/emoji-asset/test",
    mediaType: "image/webp",
  });
  const newest = emoji("at://did:plc:new/blue.moji.collection.item/new");
  const source = emoji("at://did:plc:source/blue.moji.collection.item/src");

  const resolved = selectEmojiAliasResolutions(
    [
      { name: ":thx:", preferredUri: source.uri },
      { name: ":thx:" },
      { name: ":missing:" },
    ],
    [newest, source],
  );

  assert.equal(resolved[0].emoji?.uri, source.uri);
  assert.equal(resolved[1].emoji?.uri, newest.uri);
  assert.equal(resolved[2].emoji, undefined);
});
