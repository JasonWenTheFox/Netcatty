const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { existsSync, mkdtempSync, rmSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const nodePty = require("node-pty");

const {
  execViaPty,
  execViaRawPty,
  startPtyJob,
  DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS,
  resolveEffectiveShellKind,
  execViaChannel,
} = require("./ptyExec.cjs");
const { buildWrappedCommand } = require("./ptyExecHelpers.cjs");

class ShellBackedPty extends EventEmitter {
  write(data) {
    const script = String(data);
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    queueMicrotask(() => {
      this.emit("data", Buffer.from(result.stdout));
    });
  }
}

function markerFromWrite(data) {
  return String(data).match(/(__NCMCP_[a-z0-9]+_[0-9a-f]+__)/i)?.[1] || null;
}

test("execViaPty writes the wrapper directly when user input is already submitted", async () => {
  const writes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
      const marker = markerFromWrite(data);
      if (!marker) return;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\nok\n${marker}_E:0\n`));
      });
    }
  }

  const result = await execViaPty(new CapturePty(), "uname -a", {
    shellKind: "posix",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /uname -a/);
});

test("execViaPty cancels pending input, waits for prompt redraw, then writes the wrapper (#2962)", async () => {
  const writes = [];
  let cleared = 0;
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
      if (data === "i") {
        queueMicrotask(() => this.emit("data", Buffer.from("i")));
        return;
      }
      if (data === "\x03") {
        queueMicrotask(() => this.emit("data", Buffer.from("^C\r\nuser@host:~$")));
        return;
      }
      const marker = markerFromWrite(data);
      if (!marker) return;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\nok\n${marker}_E:0\n`));
      });
    }
  }

  const result = await execViaPty(new CapturePty(), "uname -a", {
    shellKind: "posix",
    timeoutMs: 1000,
    expectedPrompt: "user@host:~$",
    pendingUserInput: true,
    onPendingInputCleared: () => {
      cleared += 1;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 3);
  assert.equal(writes[0], "i");
  assert.equal(writes[1], "\x03");
  assert.match(writes[2], /uname -a/);
  assert.equal(cleared, 1);
});

test("execViaPty refuses pending input when no editable prompt is proven", async () => {
  const writes = [];
  const result = await execViaPty({
    on() {},
    removeListener() {},
    write(data) {
      writes.push(String(data));
    },
  }, "uname -a", {
    shellKind: "posix",
    timeoutMs: 1000,
    pendingUserInput: true,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /unsubmitted terminal input/i);
  assert.deepEqual(writes, []);
});

test("cancelling during pending-input clear never writes the agent wrapper", async () => {
  const writes = [];
  const pty = new EventEmitter();
  pty.write = (data) => {
    writes.push(String(data));
  };

  const job = startPtyJob(pty, "touch should-not-run", {
    shellKind: "posix",
    expectedPrompt: "user@host:~$",
    pendingUserInput: true,
    timeoutMs: 1000,
  });
  job.cancel();
  pty.emit("data", Buffer.from("^C\r\nuser@host:~$"));

  const result = await job.resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.equal(writes.some((write) => write.includes("should-not-run")), false);
});

test("a delayed pending-input interrupt write failure resolves as a stream error", async () => {
  let writes = 0;
  const pty = new EventEmitter();
  pty.write = () => {
    writes += 1;
    if (writes === 2) throw new Error("terminal closed");
    queueMicrotask(() => pty.emit("data", Buffer.from("i")));
  };

  const result = await execViaPty(pty, "uname -a", {
    shellKind: "posix",
    expectedPrompt: "user@host:~$",
    pendingUserInput: true,
    timeoutMs: 1000,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Stream error: terminal closed/);
  assert.equal(writes, 2);
});

test("a delayed wrapper write failure resolves as a stream error", async () => {
  let writes = 0;
  const pty = new EventEmitter();
  pty.write = (data) => {
    writes += 1;
    if (writes === 1) {
      queueMicrotask(() => pty.emit("data", Buffer.from("i")));
      return;
    }
    if (writes === 2) {
      queueMicrotask(() => pty.emit("data", Buffer.from("^C\r\nuser@host:~$")));
      return;
    }
    throw new Error("terminal closed");
  };

  const result = await execViaPty(pty, "uname -a", {
    shellKind: "posix",
    expectedPrompt: "user@host:~$",
    pendingUserInput: true,
    timeoutMs: 1000,
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /Stream error: terminal closed/);
  assert.equal(writes, 3);
});

test("execViaPty clears shell state before synthetic echo and wrapper write", async () => {
  const writes = [];
  const echoes = [];
  class CapturePty extends EventEmitter {
    write(data) {
      writes.push(String(data));
      if (data === "i") {
        queueMicrotask(() => this.emit("data", Buffer.from("i")));
        return;
      }
      if (data === "\x03") {
        queueMicrotask(() => this.emit("data", Buffer.from("^C\r\nuser@host:~$")));
        return;
      }
      const marker = markerFromWrite(data);
      if (!marker) return;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\nok\n${marker}_E:0\n`));
      });
    }
  }

  const result = await execViaPty(new CapturePty(), "uname -a", {
    shellKind: "posix",
    timeoutMs: 1000,
    expectedPrompt: "user@host:~$",
    pendingUserInput: true,
    typedInput: true,
    echoCommand: (cmd) => {
      echoes.push({ cmd, writesSoFar: writes.slice() });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].cmd, "uname -a");
  assert.deepEqual(echoes[0].writesSoFar, ["i", "\x03"]);
  assert.equal(writes.length, 3);
  assert.equal(writes[0], "i");
  assert.equal(writes[1], "\x03");
  assert.match(writes[2], /uname -a/);
});

function waitForPtyText(ptyProcess, needle, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeoutId = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Timed out waiting for PTY text: ${needle}\n${output}`));
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

async function verifyRealEditorPendingInputClear({
  shellPath,
  args,
  shellKind,
  setup,
  initialPrompt,
  editorMode = "vi",
}) {
  const workDir = mkdtempSync(join(tmpdir(), "netcatty-2962-"));
  const splicedPath = join(workDir, "spliced");
  const agentPath = join(workDir, "agent");
  const expectedPrompt = "user@host:~$";
  let ptyProcess;

  try {
    ptyProcess = nodePty.spawn(shellPath, args, {
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: {
        ...process.env,
        PS1: expectedPrompt,
      },
    });

    await waitForPtyText(ptyProcess, initialPrompt || expectedPrompt);
    if (shellKind === "fish") {
      const promptReady = waitForPtyText(ptyProcess, expectedPrompt);
      ptyProcess.write(`function fish_prompt; echo -n '${expectedPrompt}'; end\r`);
      await promptReady;
    }
    if (setup) {
      const setupReady = waitForPtyText(ptyProcess, expectedPrompt);
      ptyProcess.write(`${setup}\r`);
      await setupReady;
    }

    // Reproduce the reviewer finding: leave a command suffix with the cursor
    // at the beginning. The old key-kill prefix left the suffix executable;
    // the new path must cancel the complete editor state.
    ptyProcess.write(`abc; touch '${splicedPath}'`);
    if (editorMode === "vi") {
      ptyProcess.write("\x1b");
      await new Promise((resolve) => setTimeout(resolve, 50));
      ptyProcess.write("0");
    } else {
      ptyProcess.write("\x01");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await execViaPty(ptyProcess, `touch '${agentPath}'`, {
      shellKind,
      expectedPrompt,
      pendingUserInput: true,
      timeoutMs: 5000,
    });

    assert.equal(result.ok, true, `${result.error || ""}\n${JSON.stringify(result.stdout)}`);
    assert.equal(existsSync(agentPath), true, "agent command must execute");
    assert.equal(existsSync(splicedPath), false, "unfinished user suffix must not execute");
  } finally {
    try {
      ptyProcess?.kill();
    } catch {}
    rmSync(workDir, { recursive: true, force: true });
  }
}

test("real bash vi editor cannot splice unfinished input into agent execution (#2962)", {
  skip: !existsSync("/bin/bash"),
}, async () => {
  await verifyRealEditorPendingInputClear({
    shellPath: "/bin/bash",
    args: ["--noprofile", "--norc", "-i"],
    shellKind: "posix",
    setup: "set -o vi",
  });
});

test("real bash emacs editor cannot splice a right-side unfinished suffix (#2962)", {
  skip: !existsSync("/bin/bash"),
}, async () => {
  await verifyRealEditorPendingInputClear({
    shellPath: "/bin/bash",
    args: ["--noprofile", "--norc", "-i"],
    shellKind: "posix",
    editorMode: "emacs",
  });
});

test("real zsh vi editor cannot splice unfinished input into agent execution (#2962)", {
  skip: !existsSync("/bin/zsh"),
}, async () => {
  await verifyRealEditorPendingInputClear({
    shellPath: "/bin/zsh",
    args: ["-f", "-i"],
    shellKind: "posix",
    setup: "bindkey -v",
  });
});

test("real fish vi editor cannot splice unfinished input into agent execution (#2962)", {
  skip: !existsSync("/opt/homebrew/bin/fish") && !existsSync("/usr/bin/fish"),
}, async () => {
  const shellPath = existsSync("/opt/homebrew/bin/fish")
    ? "/opt/homebrew/bin/fish"
    : "/usr/bin/fish";
  await verifyRealEditorPendingInputClear({
    shellPath,
    args: ["--no-config", "--interactive"],
    shellKind: "fish",
    setup: "fish_vi_key_bindings",
    initialPrompt: "> ",
  });
});

test("execViaRawPty does not prepend Ctrl+U before device commands", async () => {
  const writes = [];
  class CaptureRawPort extends EventEmitter {
    write(data) {
      writes.push(String(data));
      queueMicrotask(() => {
        this.emit("data", Buffer.from("ok\r\nRouter#"));
      });
    }
  }

  const result = await execViaRawPty(new CaptureRawPort(), "show version", {
    timeoutMs: 1000,
    idleMs: 20,
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], "show version\r");
  assert.equal(writes[0].includes("\x15"), false);
});

test("execViaPty completes when command output has no trailing newline", async () => {
  const result = await execViaPty(new ShellBackedPty(), "printf 'abc'", {
    shellKind: "posix",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "abc");
  assert.equal(result.exitCode, 0);
});

test("foreground PTY capture bounds a single 20 MiB output chunk and keeps its tail", async () => {
  class LargeOutputPty extends EventEmitter {
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker) return;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(
          `${marker}_S\n${"x".repeat(20 * 1024 * 1024)}TAIL\n${marker}_E:0\n`,
        ));
      });
    }
  }

  const result = await execViaPty(new LargeOutputPty(), "large-output", {
    shellKind: "posix",
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length <= DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS);
  assert.match(result.stdout, /TAIL$/u);
  assert.equal(result.outputTruncated, true);
  assert.ok(result.outputBaseOffset > 0);
});

test("foreground PTY capture preserves UTF-8 and markers split across chunks", async () => {
  class SplitOutputPty extends EventEmitter {
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker) return;
      queueMicrotask(() => {
        const start = Buffer.from(`${marker}_S\n`);
        const content = Buffer.from("中文回夝", "utf8");
        const end = Buffer.from(`\n${marker}_E:0\n`);
        this.emit("data", start.subarray(0, 7));
        this.emit("data", start.subarray(7));
        this.emit("data", content.subarray(0, 2));
        this.emit("data", content.subarray(2));
        this.emit("data", end.subarray(0, 9));
        this.emit("data", end.subarray(9));
      });
    }
  }

  const result = await execViaPty(new SplitOutputPty(), "split-output", {
    shellKind: "posix",
    timeoutMs: 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, "中文回夝");
});

test("foreground PTY timeout returns only a bounded tail", async () => {
  class TimedOutPty extends EventEmitter {
    signal() {}
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker || this.started) return;
      this.started = true;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\n${"y".repeat(20 * 1024 * 1024)}`));
      });
    }
  }

  const result = await execViaPty(new TimedOutPty(), "timeout-output", {
    shellKind: "posix",
    timeoutMs: 5,
    enforceWallTimeout: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/i);
  assert.ok(result.stdout.length <= DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS);
  assert.equal(result.outputTruncated, true);
});

test("foreground PTY cancellation returns only a bounded tail", async () => {
  class CancelledPty extends EventEmitter {
    signal() {}
    write(data) {
      const marker = markerFromWrite(data);
      if (!marker || this.started) return;
      this.started = true;
      queueMicrotask(() => {
        this.emit("data", Buffer.from(`${marker}_S\n${"z".repeat(20 * 1024 * 1024)}`));
      });
    }
  }

  const pty = new CancelledPty();
  const job = startPtyJob(pty, "cancel-output", {
    shellKind: "posix",
    timeoutMs: 1_000,
    expectedPrompt: "$ ",
  });
  await new Promise((resolve) => setImmediate(resolve));
  job.cancel();
  pty.emit("data", Buffer.from("$ "));
  const result = await job.resultPromise;
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/i);
  assert.ok(result.stdout.length <= DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS);
  assert.equal(result.outputTruncated, true);
});

test("background PTY jobs preserve output that has no trailing newline", async () => {
  const job = startPtyJob(new ShellBackedPty(), "printf 'abc'", {
    shellKind: "posix",
    timeoutMs: 1000,
    maxBufferedChars: 1024,
  });
  const result = await job.resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "abc");
  assert.equal(result.exitCode, 0);
});

test("uses PowerShell wrapping when a session with no confirmed shell sees a PowerShell prompt", () => {
  // SSH sessions don't set shellKind (sshBridge never assigns one), which
  // is exactly the issue #841 case the override targets.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("uses cmd wrapping when a session with no confirmed shell sees a cmd.exe prompt", () => {
  // Windows OpenSSH defaults to cmd.exe; without this override AI types a
  // posix wrapper into cmd and hangs until Stop (issue #2959).
  assert.equal(
    resolveEffectiveShellKind(undefined, "C:\\Users\\alice>"),
    "cmd",
  );
  assert.equal(resolveEffectiveShellKind("unknown", "C:\\>"), "cmd");
});

test("uses PowerShell wrapping when shellKind is 'unknown'", () => {
  assert.equal(
    resolveEffectiveShellKind("unknown", "PS C:\\Users\\alice>"),
    "powershell",
  );
});

test("does NOT override an explicit non-PowerShell shell kind even if the prompt looks like PowerShell", () => {
  // Defends against a malicious remote process spoofing a `PS ...>` line
  // on a real bash/zsh/cmd/fish/raw session to coerce a single
  // mis-wrapped command.
  assert.equal(
    resolveEffectiveShellKind("posix", "PS C:\\Users\\alice>"),
    "posix",
  );
  assert.equal(
    resolveEffectiveShellKind("fish", "PS C:\\Users\\alice>"),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind("cmd", "PS C:\\Users\\alice>"),
    "cmd",
  );
  assert.equal(
    resolveEffectiveShellKind("raw", "PS C:\\Users\\alice>"),
    "raw",
  );
});

test("keeps powershell wrapping for an explicit powershell session even when nested into a non-PS shell", () => {
  // After `wsl` or similar, a confirmed PowerShell session may show a
  // posix prompt. We currently keep PowerShell wrapping (the user's
  // configured shell is the source of truth). Reverse detection would
  // be a separate feature; this test locks the current behavior so a
  // future change is intentional.
  assert.equal(
    resolveEffectiveShellKind("powershell", "alice@host:~$"),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind("powershell", ""),
    "powershell",
  );
});

test("recognizes a PowerShell prompt that has trailing whitespace", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>   "),
    "powershell",
  );
});

test("recognizes a bare PowerShell prompt without a working directory", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PS>"), "powershell");
});

test("recognizes PowerShell on Linux/macOS prompts (`PS /home/alice>`)", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS /home/alice>"),
    "powershell",
  );
});

test("ignores ANSI-coloured PowerShell prompts when detecting the shell", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "[32mPS C:\\Users\\alice>[0m"),
    "powershell",
  );
});

test("treats a CR-redrawn last line as the effective prompt, not the doubled string", () => {
  // PSReadLine / ConPTY emit `\r` to repaint the current line. Without
  // CR-as-newline normalization the regex would match a doubled prompt
  // string that never round-trips through the live PTY tail.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\old>\rPS C:\\new>"),
    "powershell",
  );
});

test("rejects spoofed `PS >` (literal space then `>`) — default PowerShell never emits this", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PS >"), "posix");
});

test("falls back to posix when neither shell kind nor prompt is informative", () => {
  assert.equal(resolveEffectiveShellKind(undefined, ""), "posix");
  assert.equal(resolveEffectiveShellKind(null, undefined), "posix");
});

test("does not misclassify command output that happens to contain 'PS'", () => {
  assert.equal(resolveEffectiveShellKind(undefined, "PSO>"), "posix");
  assert.equal(resolveEffectiveShellKind(undefined, "ZIPS>"), "posix");
});

test("loginShellHint selects fish/posix/powershell/cmd without pinning confirmed shellKind", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "fish" }),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "posix" }),
    "posix",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "", { loginShellHint: "powershell" }),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "", { loginShellHint: "cmd" }),
    "cmd",
  );
  // Live PowerShell prompt still wins over a posix/fish login hint.
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>", { loginShellHint: "posix" }),
    "powershell",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>", { loginShellHint: "fish" }),
    "powershell",
  );
  // Live opposing Windows prompt wins over a Windows DefaultShell soft hint.
  assert.equal(
    resolveEffectiveShellKind(undefined, "C:\\Users\\alice>", { loginShellHint: "powershell" }),
    "cmd",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "PS C:\\Users\\alice>", { loginShellHint: "cmd" }),
    "powershell",
  );
  // Live POSIX prompt (e.g. WSL nested from Windows OpenSSH) overrides a
  // PowerShell/cmd soft hint so AI does not type a Windows wrapper into bash.
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "powershell" }),
    "posix",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "alice@wsl:/mnt/c$", { loginShellHint: "cmd" }),
    "posix",
  );
  // Confirmed shellKind is never overridden by a login hint.
  assert.equal(
    resolveEffectiveShellKind("posix", "user@host:~$", { loginShellHint: "fish" }),
    "posix",
  );
});

test("cmd wrapper uses interactive cmd variable expansion", () => {
  const wrapped = buildWrappedCommand("ipconfig /all", "cmd", "__NCMCP_TEST__");
  assert.match(wrapped, /"%__NCMCP_TEST___CMD%"/);
  assert.doesNotMatch(wrapped, /"%%__NCMCP_TEST___CMD%%"/);
});

// Issue #1850: agent-generated commands run inside a subshell so that
// shell-terminating constructs (set -e + failure, exit, ...) end only the
// subshell, never the user's active login shell / SSH session.
test("posix wrapper isolates set -e failures from the active shell", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand(
    "set -e\ncd /nonexistent-dir-1850\necho SHOULD_NOT_PRINT",
    "posix",
    marker,
  );
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_S`));
  assert.match(result.stdout, new RegExp(`${marker}_E:[1-9]`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
  assert.doesNotMatch(result.stdout, /SHOULD_NOT_PRINT/);
});

test("posix wrapper types multi-line commands as one physical line (no PS2 leak) and preserves semantics", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand(
    "echo first\necho \"it's quoted\"\n\necho last",
    "posix",
    marker,
  );
  // A single physical line: the interactive shell must never show PS2
  // ("> ") continuation echoes, which would leak past the preload filter.
  assert.equal(wrapped.indexOf("\n"), wrapped.length - 1);

  const result = spawnSync("sh", ["-c", wrapped], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /first\n/);
  assert.match(result.stdout, /it's quoted\n/);
  assert.match(result.stdout, /last\n/);
  assert.match(result.stdout, new RegExp(`${marker}_E:0`));
});

test("posix wrapper isolates explicit exit from the active shell and reports its code", () => {
  const marker = "__NCMCP_TEST__";
  const wrapped = buildWrappedCommand("exit 7", "posix", marker);
  const result = spawnSync("sh", ["-c", `${wrapped}printf 'PARENT_STILL_ALIVE\\n'`], {
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`${marker}_E:7`));
  assert.match(result.stdout, /PARENT_STILL_ALIVE/);
});

test("posix wrapper keeps cd contained in the subshell (documented trade-off)", () => {
  const marker = "__NCMCP_TEST__";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "netcatty-pty-cd-")));
  try {
    const wrapped = buildWrappedCommand("cd / && pwd", "posix", marker);
    const result = spawnSync("sh", ["-c", `${wrapped}pwd`], {
      encoding: "utf8",
      cwd,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(`${marker}_E:0`));
    const lines = result.stdout.trim().split("\n");
    // The command itself sees the cd take effect (pwd inside prints /)...
    assert.ok(lines.includes("/"), `expected command pwd "/" in: ${result.stdout}`);
    // ...but the active shell's cwd is untouched (trailing pwd prints cwd).
    assert.equal(lines[lines.length - 1], cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("execViaChannel registers a pending-cancel marker before the SSH channel opens", () => {
  // Regression for the IPC-transit race surfaced by codex on #1101
  // problem 3: if `cancelPtyExecsForSession` runs while we're still
  // waiting on `sshClient.exec`'s callback, the cancel finds nothing in
  // `activePtyExecs` and the channel opens anyway. The fix registers a
  // pending marker synchronously so the cancel has something to act on.
  const track = new Map();
  let execCallback;
  const fakeClient = {
    exec(_command, callback) {
      // Capture but do not invoke yet � simulates the channel-open
      // delay where the race window lives.
      execCallback = callback;
    },
  };
  void execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-1",
    timeoutMs: 5_000,
  });
  assert.equal(track.size, 1, "pending marker should be registered before the channel opens");
  const entry = Array.from(track.values())[0];
  assert.equal(entry.chatSessionId, "chat-1");
  assert.equal(typeof entry.cancel, "function");
  // Drain the callback so the timeout the test set doesn't fire later.
  execCallback(new Error("test teardown"), null);
});

test("execViaChannel drops the pending marker and resolves cleanly when sshClient.exec throws synchronously", async () => {
  const track = new Map();
  const fakeClient = {
    exec() {
      throw new Error("client destroyed");
    },
  };
  const result = await execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-throw",
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "client destroyed");
  assert.equal(track.size, 0, "pending marker must be removed even on sync throw");
});

test("execViaChannel short-circuits when cancel fires before the SSH channel opens", async () => {
  const track = new Map();
  let execCallback;
  let invalidations = 0;
  const fakeClient = {
    exec(_command, callback) {
      execCallback = callback;
    },
    destroy() { invalidations += 1; },
  };
  const resultPromise = execViaChannel(fakeClient, "sleep 5", {
    trackForCancellation: track,
    chatSessionId: "chat-2",
    timeoutMs: 5_000,
  });

  // Cancel while still waiting for the channel-open callback.
  assert.equal(track.size, 1);
  for (const entry of track.values()) {
    if (entry.chatSessionId === "chat-2") entry.cancel();
  }

  const result = await Promise.race([
    resultPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("pending cancel did not settle")), 25)),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.error, "Cancelled");
  assert.equal(track.size, 0, "pending marker should be removed as soon as cancel settles");
  assert.equal(invalidations, 1, "pending cancel must invalidate the uncancellable channel-open request");

  // Now the channel "opens" � even though `sshClient.exec` would
  // hand us a working stream, we must short-circuit because the user
  // already cancelled.
  const fakeExecStream = {
    closed: false,
    close() { this.closed = true; },
    stderr: { on() {} },
    on() {},
  };
  execCallback(null, fakeExecStream);
  assert.equal(fakeExecStream.closed, true, "should close the now-unwanted stream");
});

test("execViaChannel times out while SSH never opens the exec channel", async () => {
  const track = new Map();
  let execCallback;
  let invalidations = 0;
  const fakeClient = {
    exec(_command, callback) {
      execCallback = callback;
    },
    destroy() { invalidations += 1; },
  };
  const result = await Promise.race([
    execViaChannel(fakeClient, "echo hi", {
      trackForCancellation: track,
      chatSessionId: "chat-opening-timeout",
      timeoutMs: 5,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("opening timeout did not settle")), 50)),
  ]);

  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(track.size, 0);
  assert.equal(invalidations, 1);

  const lateStream = {
    closed: false,
    close() { this.closed = true; },
    stderr: { on() {} },
    on() {},
  };
  execCallback(null, lateStream);
  assert.equal(lateStream.closed, true, "late exec channels must be closed after opening timeout");
});

test("execViaChannel terminates the command when combined output exceeds its hard limit", async () => {
  const track = new Map();
  const execStream = new EventEmitter();
  execStream.stderr = new EventEmitter();
  execStream.closed = false;
  execStream.close = () => { execStream.closed = true; };
  execStream.destroy = () => { execStream.closed = true; };
  const fakeClient = {
    exec(_command, callback) {
      callback(null, execStream);
    },
  };

  const resultPromise = execViaChannel(fakeClient, "yes", {
    trackForCancellation: track,
    chatSessionId: "chat-output-limit",
    timeoutMs: 5_000,
    maxOutputBytes: 5,
  });
  execStream.emit("data", Buffer.from("abc"));
  execStream.stderr.emit("data", Buffer.from("de"));
  execStream.emit("data", Buffer.from("f"));

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "abc");
  assert.equal(result.stderr, "de");
  assert.equal(result.exitCode, -1);
  assert.match(result.error, /output exceeded.*5 byte/i);
  assert.equal(execStream.closed, true, "the noisy remote process must be terminated");
  assert.equal(track.size, 0, "the cancelled exec channel must not remain tracked");
  assert.equal(execStream.listenerCount("data"), 0);
  assert.equal(execStream.stderr.listenerCount("data"), 0);
  assert.equal(execStream.listenerCount("close"), 0);
});

test("execViaChannel settles and releases listeners when the SSH channel errors", async () => {
  const track = new Map();
  const execStream = new EventEmitter();
  execStream.stderr = new EventEmitter();
  execStream.closed = false;
  execStream.close = () => { execStream.closed = true; };
  execStream.destroy = () => { execStream.closed = true; };
  const fakeClient = {
    exec(_command, callback) {
      callback(null, execStream);
    },
  };

  const resultPromise = execViaChannel(fakeClient, "echo hi", {
    trackForCancellation: track,
    chatSessionId: "chat-channel-error",
    timeoutMs: 5_000,
  });
  execStream.emit("data", Buffer.from("partial"));
  execStream.emit("error", new Error("channel fault"));

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "partial");
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, -1);
  assert.match(result.error, /channel fault/i);
  assert.equal(execStream.closed, true);
  assert.equal(track.size, 0);
  assert.equal(execStream.listenerCount("data"), 0);
  assert.equal(execStream.stderr.listenerCount("data"), 0);
  assert.equal(execStream.stderr.listenerCount("error"), 0);
  assert.equal(execStream.listenerCount("close"), 0);
  assert.equal(execStream.listenerCount("error"), 0);
});

function createExecChannelHarness() {
  const execStream = new EventEmitter();
  execStream.stderr = new EventEmitter();
  execStream.closed = false;
  execStream.close = () => { execStream.closed = true; };
  execStream.destroy = () => { execStream.closed = true; };
  return {
    execStream,
    fakeClient: {
      exec(_command, callback) {
        callback(null, execStream);
      },
    },
  };
}

test("execViaChannel preserves UTF-8 split across stdout chunks", async () => {
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", { timeoutMs: 5_000 });
  const bytes = Buffer.from("中文", "utf8");
  execStream.emit("data", bytes.subarray(0, 2));
  execStream.emit("data", bytes.subarray(2, 4));
  execStream.emit("data", bytes.subarray(4));
  execStream.emit("close", 0);

  assert.deepEqual(await resultPromise, {
    ok: true,
    stdout: "中文",
    stderr: "",
    exitCode: 0,
  });
});

test("execViaChannel decodes interleaved stdout and stderr independently", async () => {
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", { timeoutMs: 5_000 });
  const stdoutBytes = Buffer.from("中", "utf8");
  const stderrBytes = Buffer.from("文", "utf8");
  execStream.emit("data", stdoutBytes.subarray(0, 2));
  execStream.stderr.emit("data", stderrBytes.subarray(0, 1));
  execStream.emit("data", stdoutBytes.subarray(2));
  execStream.stderr.emit("data", stderrBytes.subarray(1));
  execStream.emit("close", 0);

  assert.deepEqual(await resultPromise, {
    ok: true,
    stdout: "中",
    stderr: "文",
    exitCode: 0,
  });
});

test("execViaChannel omits an incomplete UTF-8 character at the output limit", async () => {
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", {
    timeoutMs: 5_000,
    maxOutputBytes: 2,
  });
  execStream.emit("data", Buffer.from("中", "utf8"));

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /�/u);
  assert.match(result.error, /output exceeded.*2 byte/i);
  assert.equal(execStream.closed, true);
});

test("execViaChannel cancellation never exposes an incomplete UTF-8 character", async () => {
  const track = new Map();
  const { execStream, fakeClient } = createExecChannelHarness();
  const resultPromise = execViaChannel(fakeClient, "printf unicode", {
    timeoutMs: 5_000,
    trackForCancellation: track,
    chatSessionId: "chat-unicode-cancel",
  });
  execStream.emit("data", Buffer.from("中", "utf8").subarray(0, 2));
  const entry = [...track.values()].find((candidate) => (
    candidate.chatSessionId === "chat-unicode-cancel"
  ));
  entry.cancel();

  const result = await resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stdout, /�/u);
  assert.equal(result.error, "Cancelled");
});
