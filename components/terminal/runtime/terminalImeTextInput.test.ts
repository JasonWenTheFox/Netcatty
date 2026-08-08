import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAsciiPunctuationKey,
  isUnchangedDeferredImeTextInput,
  shouldBlockKeyPressForImeTextInput,
  shouldCommitDeferredImeTextInput,
  shouldDeferKeyDownForImeTextInput,
} from "./terminalImeTextInput";

const runtimeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "createXTermRuntime.ts"),
  "utf8",
);

test("isAsciiPunctuationKey accepts common remappable punctuation", () => {
  for (const key of [",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`", "?", "!", ":", '"', "<", ">", "{", "}", "|", "_", "+", "~", "@", "#", "$", "%", "^", "&", "*", "(", ")"]) {
    assert.equal(isAsciiPunctuationKey(key), true, key);
  }
});

test("isAsciiPunctuationKey rejects letters, digits, space, and CJK", () => {
  for (const key of ["a", "Z", "0", " ", "，", "、", "？", "Enter", "ArrowLeft"]) {
    assert.equal(isAsciiPunctuationKey(key), false, key);
  }
});

test("shouldDeferKeyDownForImeTextInput defers bare ASCII punctuation keydowns", () => {
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", keyCode: 188 }),
    true,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: "?", keyCode: 191 }),
    true,
  );
});

test("shouldDeferKeyDownForImeTextInput leaves composition and modified keys alone", () => {
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", keyCode: 229 }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", isComposing: true }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: ",", ctrlKey: true }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keydown", key: "a", keyCode: 65 }),
    false,
  );
  assert.equal(
    shouldDeferKeyDownForImeTextInput({ type: "keypress", key: "," }),
    false,
  );
});

test("shouldBlockKeyPressForImeTextInput only while a deferral is armed", () => {
  assert.equal(shouldBlockKeyPressForImeTextInput(",", { type: "keypress" }), true);
  assert.equal(shouldBlockKeyPressForImeTextInput(null, { type: "keypress" }), false);
  assert.equal(shouldBlockKeyPressForImeTextInput(",", { type: "keydown" }), false);
});

test("shouldCommitDeferredImeTextInput accepts insertText payloads while deferred", () => {
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertText", data: "，" }),
    true,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertText", data: "," }),
    true,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(null, { inputType: "insertText", data: "，" }),
    false,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertFromPaste", data: "，" }),
    false,
  );
  assert.equal(
    shouldCommitDeferredImeTextInput(",", { inputType: "insertText", data: null }),
    false,
  );
});

test("isUnchangedDeferredImeTextInput detects English punctuation flush", () => {
  assert.equal(isUnchangedDeferredImeTextInput(",", ","), true);
  assert.equal(isUnchangedDeferredImeTextInput(",", "，"), false);
  assert.equal(isUnchangedDeferredImeTextInput(null, ","), false);
});

test("createXTermRuntime defers ASCII punctuation keydowns to insertText", () => {
  assert.match(runtimeSource, /shouldDeferKeyDownForImeTextInput\(e\)/);
  assert.match(runtimeSource, /armImeTextInputDeferral\(e\)/);
  assert.match(runtimeSource, /shouldBlockKeyPressForImeTextInput\(imeTextInputDeferredKey, e\)/);
  assert.match(
    runtimeSource,
    /shouldCommitDeferredImeTextInput\(imeTextInputDeferredKey, event\)/,
  );
  assert.match(runtimeSource, /commitImeTextInput\(event\.data\)/);
  assert.match(runtimeSource, /isUnchangedDeferredImeTextInput\(deferredKey, text\)/);
  assert.match(runtimeSource, /imeTextInputDeferredKittyEvent/);
  // Must run before Kitty/xterm send the half-width key from keydown.
  const deferIdx = runtimeSource.indexOf("shouldDeferKeyDownForImeTextInput(e)");
  const kittySendIdx = runtimeSource.indexOf("if (kittySequenceForKeyDown)");
  assert.ok(deferIdx >= 0 && kittySendIdx > deferIdx);
  // Unchanged ASCII must encode via Kitty key events, not composition text.
  const unchangedIdx = runtimeSource.indexOf("isUnchangedDeferredImeTextInput(deferredKey, text)");
  const compositionIdx = runtimeSource.indexOf(
    "encodeKittyCompositionText(kittyKeyboardMode, text)",
  );
  assert.ok(unchangedIdx >= 0 && compositionIdx > unchangedIdx);
});
