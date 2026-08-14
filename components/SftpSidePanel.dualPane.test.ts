import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "SftpSidePanel.tsx"),
  "utf8",
);

test("terminal SFTP side panel renders remote and local panes together", () => {
  assert.match(source, /data-sftp-side="left"/);
  assert.match(source, /data-sftp-side="right"/);
  assert.match(source, /shouldEnsureSftpSidePanelCompanionLocal/);
  assert.match(source, /rightPanes\.map/);
  // Panel-width container query (not viewport min-*), so narrow side panels stack.
  assert.match(source, /@container/);
  assert.match(source, /@min-\[420px\]:flex-row/);
});

test("transfer queue scopes local downloads to active remotes and reveals either pane", () => {
  assert.match(source, /matchesActiveRemoteSource/);
  assert.match(source, /task\.targetConnectionId === "local" && matchesActiveRemoteSource/);
  assert.match(source, /findRemoteTransferTargetTab/);
  assert.match(source, /isLocalFilesystemTransferTarget/);
  assert.match(source, /pane\?\.connection\?\.isLocal/);
  assert.match(source, /navigateTo\(targetTab\.side, revealPath/);
});
