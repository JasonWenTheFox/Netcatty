import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidePanelSource = readFileSync(new URL("../SftpSidePanel.tsx", import.meta.url), "utf8");

test("locate-path write skips sessions waiting on sensitive/password prompts", () => {
  assert.match(
    sidePanelSource,
    /isTerminalSensitiveInputActive\(action\.sessionId\)[\s\S]*?writeToSession\(action\.sessionId, action\.data/,
  );
  assert.match(
    sidePanelSource,
    /if \(isTerminalSensitiveInputActive\(action\.sessionId\)\) return;/,
  );
});
