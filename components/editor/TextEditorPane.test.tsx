import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  canPromoteTextEditor,
  getTextEditorContentStats,
  isTextEditorReadOnly,
  shouldHandleMonacoCloseCommand,
  TextEditorPromoteButton,
} from "./TextEditorPane.tsx";
import { DEFAULT_KEY_BINDINGS } from "../../domain/models/keyBindings.ts";
import { TooltipProvider } from "../ui/tooltip.tsx";

const wrap = (child: React.ReactElement) =>
  React.createElement(TooltipProvider, null, child);

test("disables promoting a modal editor to a tab while a save is running", () => {
  assert.equal(canPromoteTextEditor({ saving: true }), false);
  assert.equal(canPromoteTextEditor({ saving: false }), true);
  assert.equal(isTextEditorReadOnly({ saving: true }), true);
  assert.equal(isTextEditorReadOnly({ saving: false }), false);
});

test("renders the promote button disabled while a save is running", () => {
  const savingMarkup = renderToStaticMarkup(
    wrap(
      React.createElement(TextEditorPromoteButton, {
        saving: true,
        onPromoteToTab: () => {},
        title: "Maximize",
      }),
    ),
  );
  const idleMarkup = renderToStaticMarkup(
    wrap(
      React.createElement(TextEditorPromoteButton, {
        saving: false,
        onPromoteToTab: () => {},
        title: "Maximize",
      }),
    ),
  );

  assert.match(savingMarkup, /disabled=""/);
  assert.doesNotMatch(idleMarkup, /disabled=""/);
});

test("counts editor content without allocating line arrays", () => {
  assert.deepEqual(getTextEditorContentStats(""), { lineCount: 1, charCount: 0 });
  assert.deepEqual(getTextEditorContentStats("one\ntwo\n"), { lineCount: 3, charCount: 8 });
});

test("Monaco close command follows disabled, default, and rebound close-tab settings", () => {
  const closeTabBinding = DEFAULT_KEY_BINDINGS.find((binding) => binding.action === "closeTab");
  assert.ok(closeTabBinding);

  assert.equal(shouldHandleMonacoCloseCommand({
    hotkeyScheme: "mac",
    closeTabBinding: { ...closeTabBinding, mac: "Disabled" },
    macPlatform: true,
  }), false);
  assert.equal(shouldHandleMonacoCloseCommand({
    hotkeyScheme: "mac",
    closeTabBinding,
    macPlatform: true,
  }), true);
  assert.equal(shouldHandleMonacoCloseCommand({
    hotkeyScheme: "mac",
    closeTabBinding: { ...closeTabBinding, mac: "⌘ + E" },
    macPlatform: true,
  }), false);
  assert.equal(shouldHandleMonacoCloseCommand({
    hotkeyScheme: "disabled",
    closeTabBinding,
    macPlatform: true,
  }), false);
});
