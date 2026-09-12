import test from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGES,
  TRANSLATIONS,
  setLocale,
  getLocale,
  t,
  roleName,
} from "../public/i18n.js";
test("eight UI languages have complete keys and matching placeholders, with native direction", () => {
  assert.equal(LANGUAGES.length, 8);
  const keys = Object.keys(TRANSLATIONS.en).sort();
  for (const language of LANGUAGES) {
    assert.deepEqual(Object.keys(TRANSLATIONS[language.code]).sort(), keys);
    setLocale(language.code);
    for (const key of keys) {
      assert.ok(t(key).length);
      assert.deepEqual(
        t(key).match(/\{\w+\}/g),
        TRANSLATIONS.en[key].match(/\{\w+\}/g),
      );
    }
    assert.equal(
      roleName({ id: "custom", name: "Original name" }),
      "Original name",
    );
  }
  assert.equal(LANGUAGES.find((l) => l.code === "ar").dir, "rtl");
  setLocale("en-US");
  assert.equal(getLocale(), "en");
  assert.equal(t("roleAdded", { name: "Support" }).includes("Support"), true);
  setLocale("ja");
});
