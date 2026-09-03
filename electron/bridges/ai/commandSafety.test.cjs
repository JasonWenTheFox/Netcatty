"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  checkBlocklistForShell,
  checkBlocklistCommonOnly,
  resolveSessionBlocklistShellKind,
} = require("./commandSafety.cjs");

test("checkBlocklistForShell selects default groups by shell kind", () => {
  // Unknown / empty kinds keep the strict full default table.
  assert.equal(checkBlocklistForShell("echo $(whoami)", "").blocked, true);
  assert.equal(checkBlocklistForShell("echo $(whoami)", "unknown").blocked, true);
  // POSIX kinds keep the command-substitution rule.
  assert.equal(checkBlocklistForShell("echo $(whoami)", "posix").blocked, true);
  assert.equal(checkBlocklistForShell("echo $(whoami)", "fish").blocked, true);
  // PowerShell kind frees the POSIX substitution rules.
  assert.equal(checkBlocklistForShell('Write-Host "now: $(Get-Date)"', "powershell").blocked, false);
  assert.equal(checkBlocklistForShell("Remove-Item -Recurse -Force C:\\x", "powershell").blocked, true);
  // Native Unix commands remain dangerous when launched from pwsh on Unix.
  assert.equal(checkBlocklistForShell("mkfs.ext4 /dev/sda", "powershell").blocked, true);
  assert.equal(checkBlocklistForShell("dd if=/dev/zero of=/dev/sda", "powershell").blocked, true);
  assert.equal(checkBlocklistForShell("chmod -R 777 /", "powershell").blocked, true);
  // cmd keeps only the shell-independent guards.
  assert.equal(checkBlocklistForShell("echo $(date)", "cmd").blocked, false);
  assert.equal(checkBlocklistForShell("shutdown /r /t 0", "cmd").blocked, true);
});

test("checkBlocklistCommonOnly never applies POSIX or PowerShell patterns", () => {
  assert.equal(checkBlocklistCommonOnly("echo $(whoami)").blocked, false);
  assert.equal(checkBlocklistCommonOnly("echo `whoami`").blocked, false);
  assert.equal(checkBlocklistCommonOnly("Remove-Item -Recurse -Force C:\\x").blocked, false);
  assert.equal(checkBlocklistCommonOnly("rm -rf /").blocked, true);
  assert.equal(checkBlocklistCommonOnly("shutdown /r /t 0").blocked, true);
});

test("user-added settings patterns always apply regardless of shell kind", () => {
  const settingsList = ["forbidden-thing"];
  assert.equal(checkBlocklistForShell("forbidden-thing", "powershell", settingsList).blocked, true);
  assert.equal(checkBlocklistCommonOnly("forbidden-thing", settingsList).blocked, true);
  // Settings entries that match default patterns are not user additions.
  const withDefaults = ["\\$\\(", "forbidden-thing"];
  assert.equal(checkBlocklistCommonOnly("echo $(date)", withDefaults).blocked, false);
  assert.equal(checkBlocklistForShell("echo $(date)", "posix", withDefaults).blocked, true);
});

test("configured removal of defaults remains authoritative", () => {
  const defaults = require("../../../lib/commandBlocklist.cjs");
  const withoutRm = defaults.filter((pattern) => !pattern.startsWith("\\brm\\s+"));
  assert.equal(checkBlocklistForShell("rm -rf /", "posix", withoutRm).blocked, false);
  assert.equal(checkBlocklistForShell("rm -rf /", "posix", []).blocked, false);
  assert.equal(checkBlocklistCommonOnly("rm -rf /", []).blocked, false);
});

test("resolveSessionBlocklistShellKind mirrors the PTY wrapper inputs", () => {
  // Confirmed shell kind wins as-is.
  assert.equal(
    resolveSessionBlocklistShellKind({ shellKind: "powershell" }),
    "powershell",
  );
  // Empty kind + a live PowerShell prompt resolves to powershell (issue #841
  // live-prompt override).
  assert.equal(
    resolveSessionBlocklistShellKind({
      shellKind: "",
      lastIdlePrompt: "PS C:\\Users\\dev> ",
      _promptTrackTail: "some output\r\nPS C:\\Users\\dev> ",
    }),
    "powershell",
  );
  // Remote login-shell probe hint (soft) resolves when no prompt is known.
  assert.equal(
    resolveSessionBlocklistShellKind({ shellKind: "", _loginShellKind: "powershell" }),
    "powershell",
  );
  // POSIX live prompt overrides a Windows DefaultShell cmd hint (WSL nesting).
  assert.equal(
    resolveSessionBlocklistShellKind({
      shellKind: "",
      _loginShellKind: "cmd",
      lastIdlePrompt: "user@host:~$ ",
      _promptTrackTail: "\r\nuser@host:~$ ",
    }),
    "posix",
  );
  // No information stays unknown so safety retains the strict all-groups
  // fallback instead of inheriting the wrapper's POSIX compatibility default.
  assert.equal(resolveSessionBlocklistShellKind({}), "");
  assert.equal(resolveSessionBlocklistShellKind(null), "");
});
