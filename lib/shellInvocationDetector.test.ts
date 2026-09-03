import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

const require = createRequire(import.meta.url);
const { detectShellInvocations, detectInvokedShellGroups } = require("./shellInvocationDetector.cjs") as {
  detectShellInvocations: (
    command: string,
    shellKind: string,
  ) => Array<{ group: string; command: string }>;
  detectInvokedShellGroups: (command: string, shellKind: string) => string[];
};

test("detectInvokedShellGroups recognizes executable positions and wrappers", () => {
  assert.deepEqual(detectInvokedShellGroups("PAYLOAD=x pwsh -Command test", "posix"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups("env PAYLOAD=x pwsh -Command test", "posix"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups("sudo -u root pwsh -Command test", "posix"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups('start "" /wait powershell.exe -Command test', "cmd"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups('start /wait "" powershell.exe -Command test', "cmd"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups("call powershell.exe -Command test", "cmd"), ["powershell"]);
  assert.deepEqual(
    detectInvokedShellGroups('start "" /d C:\\Temp powershell.exe -Command test', "cmd"),
    ["powershell"],
  );
  assert.deepEqual(detectInvokedShellGroups("cmd /c powershell.exe -Command test", "cmd"), ["powershell"]);
  assert.deepEqual(
    detectInvokedShellGroups('cmd /c "powershell.exe -NoProfile -Command Remove-Item -Recurse -Force C:/important"', "cmd"),
    ["powershell"],
  );
  assert.deepEqual(
    detectInvokedShellGroups('"C:\\Program Files"\\PowerShell\\7\\pwsh.exe -Command test', "cmd"),
    ["powershell"],
  );
  assert.deepEqual(detectInvokedShellGroups("Start-Process bash.exe -ArgumentList '-c','eval echo'", "powershell"), ["posix"]);
  assert.deepEqual(detectInvokedShellGroups('& "bash" -c test', "powershell"), ["posix"]);
  assert.deepEqual(
    detectInvokedShellGroups('env -S "pwsh -Command \'Invoke-Expression $PAYLOAD\'"', "posix"),
    ["powershell"],
  );
  assert.deepEqual(
    detectInvokedShellGroups("sudo -D /tmp pwsh -Command Invoke-Expression", "posix"),
    ["powershell"],
  );
});

test("detectInvokedShellGroups ignores shell names inside ordinary quoted arguments", () => {
  assert.deepEqual(detectInvokedShellGroups('Write-Host "safe; bash $(Get-Date)"', "powershell"), []);
  assert.deepEqual(detectInvokedShellGroups('echo "safe; pwsh -Command Invoke-Expression"', "posix"), []);
  assert.deepEqual(detectInvokedShellGroups("echo safe; powershell.exe -Command Invoke-Expression", "cmd"), []);
});

test("detectInvokedShellGroups follows nested shell command arguments", () => {
  assert.deepEqual(
    detectInvokedShellGroups('bash -c "pwsh -Command \'Invoke-Expression $env:PAYLOAD\'"', "cmd"),
    ["posix", "powershell"],
  );
  assert.deepEqual(
    detectInvokedShellGroups('pwsh -Command "bash -c \'eval echo\'"', "cmd"),
    ["powershell", "posix"],
  );
  assert.deepEqual(
    detectInvokedShellGroups('bash -lc \'pwsh -Command "Invoke-Expression $env:PAYLOAD"\'', "posix"),
    ["posix", "powershell"],
  );
  assert.deepEqual(
    detectInvokedShellGroups("wsl -- pwsh -Command Invoke-Expression", "cmd"),
    ["powershell"],
  );
});

test("detectShellInvocations scopes nested checks to executable command text", () => {
  assert.deepEqual(
    detectShellInvocations('Write-Host "now: $(Get-Date)"; bash -c \'echo safe\'', "powershell"),
    [{ group: "posix", command: "echo safe" }],
  );
  assert.deepEqual(
    detectShellInvocations('Write-Host "$(bash -c \'eval echo PWNED\')"', "powershell"),
    [{ group: "posix", command: "eval echo PWNED" }],
  );
  assert.deepEqual(
    detectShellInvocations('# & powershell.exe -Command "Invoke-Expression $env:PAYLOAD"', "cmd"),
    [{ group: "powershell", command: "Invoke-Expression $env:PAYLOAD" }],
  );
  assert.deepEqual(
    detectShellInvocations('wsl pwsh -Command "Write-Host $(Get-Date)"', "cmd"),
    [
      { group: "native", command: "pwsh -Command Write-Host $(Get-Date)" },
      { group: "powershell", command: "Write-Host $(Get-Date)" },
    ],
  );
});
