import assert from "node:assert/strict";
import test from "node:test";
import {
  ADULT_AGE,
  isAdultBirthDate,
  isBirthdayToday,
  jstCalendarDate,
} from "../src/services/ageAssurance.js";

const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

test("someone born exactly 18 years ago today is an adult", () => {
  assert.equal(isAdultBirthDate("2008-09-02", at("2026-09-02")), true);
});

test("someone one day short of 18 is still a minor", () => {
  assert.equal(isAdultBirthDate("2008-09-03", at("2026-09-02")), false);
});

/**
 * 成人判定は保存した生年月日との比較なので、誕生日を跨いだ瞬間に自動で成人になる。
 * 行を書き換えるバッチは要らない、という設計をここで固定する。
 */
test("a minor becomes an adult without any write when their birthday passes", () => {
  const birthDate = "2008-12-31";
  assert.equal(isAdultBirthDate(birthDate, at("2026-12-30")), false);
  assert.equal(isAdultBirthDate(birthDate, at("2026-12-31")), true);
});

test("clearly adult and clearly minor birth dates", () => {
  assert.equal(isAdultBirthDate("1990-01-01", at("2026-09-02")), true);
  assert.equal(isAdultBirthDate("2020-01-01", at("2026-09-02")), false);
});

test("garbage birth dates are treated as minors, never adults", () => {
  for (const value of ["", "not-a-date", "0000-00-00"])
    assert.equal(isAdultBirthDate(value, at("2026-09-02")), false);
});

test("the adult age is 18", () => {
  assert.equal(ADULT_AGE, 18);
});

test("誕生日はJSTの暦日で判定し、生年は一致条件にしない", () => {
  assert.equal(
    isBirthdayToday("1990-09-02", new Date("2026-09-01T15:00:00.000Z")),
    true,
  );
  assert.equal(
    isBirthdayToday("2008-09-02", new Date("2026-09-02T14:59:59.999Z")),
    true,
  );
  assert.equal(
    isBirthdayToday("1990-09-02", new Date("2026-09-02T15:00:00.000Z")),
    false,
  );
  assert.equal(
    jstCalendarDate(new Date("2026-12-31T15:00:00.000Z")),
    "2027-01-01",
  );
});

test("不正・未登録の生年月日は誕生日として扱わない", () => {
  for (const value of [undefined, null, "", "--09-02", "not-a-date"])
    assert.equal(
      isBirthdayToday(value, new Date("2026-09-02T03:00:00.000Z")),
      false,
    );
});
