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
  // POSIX syntax is checked when PowerShell explicitly invokes a POSIX shell.
  for (const command of [
    "bash -c 'eval $(echo cm0gLXJmIC8= | base64 -d)'",
    "& wsl sh -c 'echo $(date)'",
    "& \"bash\" -c 'echo $(date)'",
    "'/usr/bin/bash' -c 'echo $(date)'",
    "wsl sh -c ': > /etc/passwd'",
    "wsl sh -c ':(){ :|:& };:'",
  ]) {
    assert.equal(checkBlocklistForShell(command, "powershell").blocked, true);
  }
  assert.equal(checkBlocklistForShell('Write-Host "bash text: $(Get-Date)"', "powershell").blocked, false);
  assert.equal(checkBlocklistForShell('Write-Host "safe; bash $(Get-Date)"', "powershell").blocked, false);
  assert.equal(
    checkBlocklistForShell('Write-Host "example: foo; bash -c echo $(Get-Date)"', "powershell").blocked,
    false,
  );
  assert.equal(
    checkBlocklistForShell('Write-Host "now: $(Get-Date)"; bash -c \'echo safe\'', "powershell").blocked,
    false,
  );
  assert.equal(
    checkBlocklistForShell('Write-Host "$(bash -c \'eval echo PWNED\')"', "powershell").blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell("Start-Process bash.exe -ArgumentList '-c','eval echo'", "powershell").blocked,
    true,
  );
  // cmd omits POSIX syntax while retaining guards for native tools it can launch.
  assert.equal(checkBlocklistForShell("echo $(date)", "cmd").blocked, false);
  assert.equal(checkBlocklistForShell("shutdown /r /t 0", "cmd").blocked, true);
  assert.equal(checkBlocklistForShell("wsl dd if=/dev/zero of=/dev/sda", "cmd").blocked, true);
  assert.equal(checkBlocklistForShell("wsl chmod -R 777 /", "cmd").blocked, true);
  assert.equal(checkBlocklistForShell('bash -c "echo $(date)"', "cmd").blocked, true);
});

test("explicit PowerShell invocations apply PowerShell guards from other shells", () => {
  for (const shellKind of ["posix", "fish", "cmd"]) {
    assert.equal(
      checkBlocklistForShell(
        'powershell.exe -NoProfile -Command "Invoke-Expression $env:PAYLOAD"',
        shellKind,
      ).blocked,
      true,
    );
    assert.equal(
      checkBlocklistForShell(
        'pwsh -Command "Remove-Item -Recurse -Force C:\\important"',
        shellKind,
      ).blocked,
      true,
    );
    assert.equal(
      checkBlocklistForShell(
        '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Invoke-Expression $env:PAYLOAD"',
        shellKind,
      ).blocked,
      true,
    );
    assert.equal(
      checkBlocklistForShell("'pwsh' -Command 'Invoke-Expression $PAYLOAD'", shellKind).blocked,
      shellKind !== "cmd",
    );
  }

  assert.equal(
    checkBlocklistForShell('pwsh -Command \'Write-Host "now: $(Get-Date)"\'', "posix").blocked,
    false,
  );

  for (const command of [
    "PAYLOAD='Remove-Item -Recurse -Force C:\\important' pwsh -NoProfile -Command 'Invoke-Expression $env:PAYLOAD'",
    "env PAYLOAD=x pwsh -Command 'Invoke-Expression $env:PAYLOAD'",
    "sudo -u root pwsh -Command 'Remove-Item -Recurse -Force C:\\important'",
  ]) {
    assert.equal(checkBlocklistForShell(command, "posix").blocked, true);
  }
  assert.equal(
    checkBlocklistForShell(
      'start "" /wait powershell.exe -Command "Invoke-Expression $env:PAYLOAD"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'start "" /d C:\\Temp powershell.exe -Command "Invoke-Expression $env:PAYLOAD"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'call powershell.exe -Command "Remove-Item -Recurse -Force C:\\important"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'cmd /c powershell.exe -Command "Invoke-Expression $env:PAYLOAD"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'cmd /c "powershell.exe -NoProfile -Command Remove-Item -Recurse -Force C:/important"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      '"C:\\Program Files"\\PowerShell\\7\\pwsh.exe -Command "Invoke-Expression $env:PAYLOAD"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'bash -c "pwsh -Command \'Invoke-Expression $env:PAYLOAD\'"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'bash -lc \'pwsh -NoProfile -Command "Remove-Item -Recurse -Force C:/important"\'',
      "posix",
    ).blocked,
    true,
  );
  for (const command of [
    "wsl pwsh -NoProfile -Command Remove-Item -Recurse -Force C:/important",
    "wsl -- pwsh -NoProfile -Command Remove-Item -Recurse -Force C:/important",
    "wsl -e pwsh -NoProfile -Command Remove-Item -Recurse -Force C:/important",
  ]) {
    assert.equal(checkBlocklistForShell(command, "cmd").blocked, true);
  }
  assert.equal(
    checkBlocklistForShell('wsl pwsh -Command "Write-Host $(Get-Date)"', "cmd").blocked,
    false,
  );
  assert.equal(
    checkBlocklistForShell(
      '# & powershell.exe -Command "Invoke-Expression $env:PAYLOAD"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'echo \'safe & powershell.exe -Command "Invoke-Expression $env:PAYLOAD"',
      "cmd",
    ).blocked,
    true,
  );
  assert.equal(
    checkBlocklistForShell(
      'echo safe; powershell.exe -Command "Invoke-Expression $env:PAYLOAD"',
      "cmd",
    ).blocked,
    false,
  );
  for (const command of [
    'env -S "pwsh -Command \'Invoke-Expression $PAYLOAD\'"',
    "sudo -D /tmp pwsh -Command Invoke-Expression",
    "env -S 'rm -rf /'",
    "wsl 'dd' if=/dev/zero of=/dev/sda",
  ]) {
    assert.equal(checkBlocklistForShell(command, "posix").blocked, true);
  }
  assert.equal(
    checkBlocklistForShell('Write-Output "safe; pwsh -Command Invoke-Expression"', "posix").blocked,
    false,
  );
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
