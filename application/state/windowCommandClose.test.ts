import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveWindowCommandCloseIntent,
  resolveWindowCommandCloseRequestIntent,
  shouldHandleWindowCommandCloseRequest,
} from "./windowCommandClose.ts";

const commandWRequest = {
  source: "keyboard" as const,
  input: {
    key: "w",
    code: "KeyW",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  },
};

test("keyboard close requests follow disabled, default, and rebound settings", () => {
  assert.equal(shouldHandleWindowCommandCloseRequest({
    request: commandWRequest,
    closeTabKeyStr: null,
    isMac: true,
  }), false);
  assert.equal(shouldHandleWindowCommandCloseRequest({
    request: commandWRequest,
    closeTabKeyStr: "Disabled",
    isMac: true,
  }), false);
  assert.equal(shouldHandleWindowCommandCloseRequest({
    request: commandWRequest,
    closeTabKeyStr: "⌘ + W",
    isMac: true,
  }), true);
  assert.equal(shouldHandleWindowCommandCloseRequest({
    request: commandWRequest,
    closeTabKeyStr: "⌘ + E",
    isMac: true,
  }), false);
});

test("menu close requests remain available when the keyboard shortcut is disabled", () => {
  assert.equal(shouldHandleWindowCommandCloseRequest({
    closeTabKeyStr: null,
    isMac: true,
  }), true);
});

test("disabled and rebound keyboard requests return to the general hotkey dispatcher", () => {
  assert.deepEqual(resolveWindowCommandCloseRequestIntent({
    request: commandWRequest,
    closeTabKeyStr: null,
    isMac: true,
    activeTabId: "vault",
    editorTabIds: [],
    sessionIds: [],
    workspaceIds: [],
    logViewIds: [],
  }), { kind: "hotkey", input: commandWRequest.input });
  assert.deepEqual(resolveWindowCommandCloseRequestIntent({
    request: commandWRequest,
    closeTabKeyStr: "⌘ + E",
    isMac: true,
    activeTabId: "log-1",
    editorTabIds: [],
    sessionIds: [],
    workspaceIds: [],
    logViewIds: ["log-1"],
  }), { kind: "hotkey", input: commandWRequest.input });
});

test("enabled keyboard requests preserve Vault and log-view close behavior", () => {
  assert.deepEqual(resolveWindowCommandCloseRequestIntent({
    request: commandWRequest,
    closeTabKeyStr: "⌘ + W",
    isMac: true,
    activeTabId: "vault",
    editorTabIds: [],
    sessionIds: [],
    workspaceIds: [],
    logViewIds: [],
  }), { kind: "closeWindow" });
  assert.deepEqual(resolveWindowCommandCloseRequestIntent({
    request: commandWRequest,
    closeTabKeyStr: "⌘ + W",
    isMac: true,
    activeTabId: "log-1",
    editorTabIds: [],
    sessionIds: [],
    workspaceIds: [],
    logViewIds: ["log-1"],
  }), { kind: "closeLogView", tabId: "log-1" });
});

test("menu requests preserve Vault close behavior with the shortcut disabled", () => {
  assert.deepEqual(resolveWindowCommandCloseRequestIntent({
    closeTabKeyStr: null,
    isMac: true,
    activeTabId: "vault",
    editorTabIds: [],
    sessionIds: [],
    workspaceIds: [],
    logViewIds: [],
  }), { kind: "closeWindow" });
});

test("Cmd+W closes the active closable tab first", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "s1",
      editorTabIds: [],
      sessionIds: ["s1", "s2"],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W on a log view closes the log view", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "log-1",
      editorTabIds: [],
      sessionIds: ["s1", "s2"],
      workspaceIds: [],
      logViewIds: ["log-1"],
    }),
    { kind: "closeLogView", tabId: "log-1" },
  );
});

test("Cmd+W closes an editor tab through the existing close flow", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "editor:1",
      editorTabIds: ["editor:1"],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W closes a native plugin view tab before the window", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "plugin-view:com.example.view:com.example.view.panel",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
      pluginViewTabIds: ["plugin-view:com.example.view:com.example.view.panel"],
    }),
    { kind: "closeTab" },
  );
});

test("Cmd+W closes the window from the Vault page", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: "vault",
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeWindow" },
  );
});

test("Cmd+W closes the window when nothing else is active", () => {
  assert.deepEqual(
    resolveWindowCommandCloseIntent({
      activeTabId: null,
      editorTabIds: [],
      sessionIds: [],
      workspaceIds: [],
      logViewIds: [],
    }),
    { kind: "closeWindow" },
  );
});
