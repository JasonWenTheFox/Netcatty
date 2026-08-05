import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldAdoptExternalImeControlledValue,
  shouldCommitImeControlledChange,
} from "./imeControlledInput.ts";

test("does not commit controlled changes while an IME composition session is open", () => {
  assert.equal(
    shouldCommitImeControlledChange({
      isComposingSession: true,
      nativeEventIsComposing: true,
    }),
    false,
  );
  assert.equal(
    shouldCommitImeControlledChange({
      isComposingSession: true,
      nativeEventIsComposing: false,
    }),
    false,
  );
});

test("does not commit when the native event still reports composing", () => {
  assert.equal(
    shouldCommitImeControlledChange({
      isComposingSession: false,
      nativeEventIsComposing: true,
    }),
    false,
  );
});

test("commits ordinary keystrokes outside composition", () => {
  assert.equal(
    shouldCommitImeControlledChange({
      isComposingSession: false,
      nativeEventIsComposing: false,
    }),
    true,
  );
  assert.equal(
    shouldCommitImeControlledChange({
      isComposingSession: false,
    }),
    true,
  );
});

test("adopts external value into draft only when not composing and values differ", () => {
  assert.equal(
    shouldAdoptExternalImeControlledValue({
      isComposingSession: false,
      draftValue: "sou",
      externalValue: "",
    }),
    true,
  );
  assert.equal(
    shouldAdoptExternalImeControlledValue({
      isComposingSession: true,
      draftValue: "sou",
      externalValue: "",
    }),
    false,
  );
  assert.equal(
    shouldAdoptExternalImeControlledValue({
      isComposingSession: false,
      draftValue: "搜",
      externalValue: "搜",
    }),
    false,
  );
});
