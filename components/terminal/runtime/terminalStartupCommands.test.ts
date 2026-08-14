import test from "node:test";
import assert from "node:assert/strict";

import {
  appendAutomatedCompletionCommand,
  buildAutomatedCompletionCommand,
} from "./terminalStartupCommands";

const marker = "__NCAUTO_0123456789abcdef0123456789abcdef__";

test("automated completion commands reconstruct a marker without echoing it literally", () => {
  for (const shellType of ["posix", "fish", "powershell", "cmd"] as const) {
    const command = buildAutomatedCompletionCommand(marker, shellType);
    assert.equal(command.includes(marker), false);
    assert.ok(command.includes(marker.slice(0, Math.floor(marker.length / 2))));
    assert.ok(command.includes(marker.slice(Math.floor(marker.length / 2))));
  }
});

test("startup completion runs on a new shell line", () => {
  const input = appendAutomatedCompletionCommand("echo ready", marker, "posix");
  assert.match(input, /^echo ready\nprintf/u);
  assert.equal(input.includes(marker), false);
});
