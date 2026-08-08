import test from "node:test";
import assert from "node:assert/strict";

import { stringCellWidth } from "./autocomplete/terminalStringCellWidth.ts";

test("stringCellWidth counts ASCII as one cell each", () => {
  assert.equal(stringCellWidth("docker"), 6);
});

test("stringCellWidth counts CJK ideographs as two cells each", () => {
  assert.equal(stringCellWidth("部署"), 4);
});

test("stringCellWidth collapses ZWJ emoji to one wide grapheme", () => {
  assert.equal(stringCellWidth("👨‍💻"), 2);
});

test("stringCellWidth ignores combining marks inside a grapheme", () => {
  // e + combining acute accent
  assert.equal(stringCellWidth("e\u0301"), 1);
});
