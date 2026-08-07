import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  endDraftSend,
  endSend,
  tryBeginDraftSend,
  tryBeginSend,
} from "./draftSendGate.ts";

test("draft send gate allows only one in-flight draft send at a time", () => {
  const gate = { current: false };

  assert.equal(tryBeginDraftSend(gate), true);
  assert.equal(tryBeginDraftSend(gate), false);

  endDraftSend(gate);

  assert.equal(tryBeginDraftSend(gate), true);
});

test("send gate aliases cover session-mode re-entry the same way", () => {
  const gate = { current: false };
  assert.equal(tryBeginSend(gate), true);
  assert.equal(tryBeginSend(gate), false);
  endSend(gate);
  assert.equal(tryBeginSend(gate), true);
});

test("AIChatSidePanel gates every send including session mode", () => {
  const source = readFileSync(new URL("../AIChatSidePanel.tsx", import.meta.url), "utf8");
  assert.match(source, /tryBeginSend\(sendInFlightRef\)/);
  assert.match(source, /isAIChatSessionStreaming\(sessionId\)/);
  assert.doesNotMatch(
    source,
    /isDraftMode && !tryBeginDraftSend/,
    "session-mode sends must share the sync re-entry gate",
  );
});
