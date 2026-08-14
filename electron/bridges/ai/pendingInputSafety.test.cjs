const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const nodePty = require("node-pty");

const {
  parseLocalProcessTable,
  verifySessionForegroundShell,
} = require("./pendingInputSafety.cjs");

function waitForText(ptyProcess, needle, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeoutId = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Timed out waiting for ${needle}: ${output}`));
    }, timeoutMs);
    const disposable = ptyProcess.onData((chunk) => {
      output += chunk;
      if (!output.includes(needle)) return;
      clearTimeout(timeoutId);
      disposable.dispose();
      resolve(output);
    });
  });
}

test("parseLocalProcessTable accepts only a foreground descendant shell", () => {
  assert.equal(parseLocalProcessTable([
    "100 1 100 100 bash",
    "200 100 200 200 python3",
  ].join("\n"), 100), true);
  assert.equal(parseLocalProcessTable([
    "100 1 100 200 bash",
    "200 100 200 200 python3",
  ].join("\n"), 100), false);
  assert.equal(parseLocalProcessTable("300 1 300 300 bash\n", 100), false);
});

test("verifySessionForegroundShell distinguishes an idle shell from a foreground child", async (t) => {
  if (process.platform === "win32" || spawnSync("bash", ["--version"]).status !== 0) {
    t.skip("POSIX bash is unavailable");
    return;
  }
  const prompt = "verify-shell$";
  const ptyProcess = nodePty.spawn("bash", ["--noprofile", "--norc", "-i"], {
    cols: 100,
    rows: 30,
    env: { ...process.env, PS1: prompt },
  });
  const session = {
    protocol: "local",
    proc: ptyProcess,
    _hasPendingUserInput: true,
  };

  try {
    await waitForText(ptyProcess, prompt);
    assert.equal(await verifySessionForegroundShell(session), true);

    const childReady = waitForText(ptyProcess, "CHILD_READY");
    ptyProcess.write("python3 -c 'import time; print(\"CHILD_READY\", flush=True); time.sleep(30)'\r");
    await childReady;
    assert.equal(await verifySessionForegroundShell(session), false);
  } finally {
    ptyProcess.kill();
  }
});

test("remote foreground probe distinguishes an SSH shell from its foreground child", async (t) => {
  if (!existsSync("/proc/self/environ") || spawnSync("bash", ["--version"]).status !== 0) {
    t.skip("Linux procfs or bash is unavailable");
    return;
  }
  const sshConnection = `127.0.0.1 ${40_000 + (process.pid % 10_000)} 127.0.0.1 22`;
  const env = { ...process.env, SSH_CONNECTION: sshConnection, PS1: "remote-shell$" };
  const ptyProcess = nodePty.spawn("bash", ["--noprofile", "--norc", "-i"], {
    cols: 100,
    rows: 30,
    env,
  });
  const session = {
    protocol: "ssh",
    shellPid: ptyProcess.pid,
    _loginShellKind: "posix",
    _hasPendingUserInput: true,
    _shellKindExecProbe(command) {
      const result = spawnSync("sh", ["-c", command], { encoding: "utf8", env });
      return result.status === 0 ? result.stdout : null;
    },
  };

  try {
    await waitForText(ptyProcess, "remote-shell$");
    assert.equal(await verifySessionForegroundShell(session), true);

    const childReady = waitForText(ptyProcess, "REMOTE_CHILD_READY");
    ptyProcess.write("python3 -c 'import time; print(\"REMOTE_CHILD_READY\", flush=True); time.sleep(30)'\r");
    await childReady;
    assert.equal(await verifySessionForegroundShell(session), false);
  } finally {
    ptyProcess.kill();
  }
});
