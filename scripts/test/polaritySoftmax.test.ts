import assert from "node:assert/strict";
import test from "node:test";
import { hashBucket, predictProba, trainSoftmax } from "../lib/polaritySoftmax.mts";

const argmax = (values: number[]) => values.indexOf(Math.max(...values));

test("分離できる3クラスを学習し、標準化を畳み込んだ重みで生の入力を当てる", () => {
  // 軸ごとに平均もスケールも違う入力。標準化を畳み込み損ねると当たらなくなる。
  const centers = [
    [100, -5, 0.01],
    [120, 5, 0.01],
    [110, 0, 0.05],
  ];
  const xs: number[][] = [];
  const ys: number[] = [];
  for (let i = 0; i < 90; i++) {
    const c = i % 3;
    const jitter = ((i * 7) % 5) / 10 - 0.2;
    xs.push([centers[c][0] + jitter, centers[c][1] + jitter, centers[c][2] + jitter / 100]);
    ys.push(c);
  }
  const model = trainSoftmax(xs, ys, ["a", "b", "c"], { classes: 3, l2: 1e-4, epochs: 300 });
  assert.equal(model.weights.length, 3);
  assert.equal(model.weights[0].length, 3);
  for (const [c, center] of centers.entries()) {
    const proba = predictProba(model, center);
    assert.equal(argmax(proba), c);
    assert.ok(Math.abs(proba.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
});

test("バケットは content_hash だけで決まり、0〜9に収まる", () => {
  const hash = "a".repeat(64);
  assert.equal(hashBucket(hash), hashBucket(hash));
  assert.equal(hashBucket("0000000a" + "f".repeat(56)), 0);
  assert.equal(hashBucket("0000000b" + "0".repeat(56)), 1);
  for (const prefix of ["ffffffff", "12345678", "00000000"]) {
    const bucket = hashBucket(prefix + "0".repeat(56));
    assert.ok(bucket >= 0 && bucket <= 9);
  }
});
