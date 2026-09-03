import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";

const require = createRequire(import.meta.url);
const { detectInvokedShellGroups } = require("./shellInvocationDetector.cjs") as {
  detectInvokedShellGroups: (command: string, shellKind: string) => string[];
};

test("detectInvokedShellGroups recognizes executable positions and wrappers", () => {
  assert.deepEqual(detectInvokedShellGroups("PAYLOAD=x pwsh -Command test", "posix"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups("env PAYLOAD=x pwsh -Command test", "posix"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups("sudo -u root pwsh -Command test", "posix"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups('start "" /wait powershell.exe -Command test', "cmd"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups('start /wait "" powershell.exe -Command test', "cmd"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups("call powershell.exe -Command test", "cmd"), ["powershell"]);
  assert.deepEqual(detectInvokedShellGroups("cmd /c powershell.exe -Command test", "cmd"), ["powershell"]);
  assert.deepEqual(
    detectInvokedShellGroups('"C:\\Program Files"\\PowerShell\\7\\pwsh.exe -Command test', "cmd"),
    ["powershell"],
  );
  assert.deepEqual(detectInvokedShellGroups("Start-Process bash.exe -ArgumentList '-c','eval echo'", "powershell"), ["posix"]);
  assert.deepEqual(detectInvokedShellGroups('& "bash" -c test', "powershell"), ["posix"]);
});

test("detectInvokedShellGroups ignores shell names inside ordinary quoted arguments", () => {
  assert.deepEqual(detectInvokedShellGroups('Write-Host "safe; bash $(Get-Date)"', "powershell"), []);
  assert.deepEqual(detectInvokedShellGroups('echo "safe; pwsh -Command Invoke-Expression"', "posix"), []);
});

test("detectInvokedShellGroups follows nested shell command arguments", () => {
  assert.deepEqual(
    detectInvokedShellGroups('bash -c \'pwsh -Command "Invoke-Expression $env:PAYLOAD"\'', "cmd"),
    ["posix", "powershell"],
  );
  assert.deepEqual(
    detectInvokedShellGroups('pwsh -Command \'bash -c "eval echo"\'', "cmd"),
    ["powershell", "posix"],
  );
});
