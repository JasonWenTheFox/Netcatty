const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { mkdtempSync, rmSync, realpathSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const {
  execViaPty,
  execViaRawPty,
  startPtyJob,
  DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS,
  resolveEffectiveShellKind,
  execViaChannel,
} = require("./ptyExec.cjs");
const {
  buildWrappedCommand,
  buildPendingInputClearPrefix,
  isCanonicalPosixLineEditor,
} = require("./ptyExecHelpers.cjs");

class ShellBackedPty extends EventEmitter {
  write(data) {
    // Interactive shells clear unfinished / continuation input before the
    // wrapper; this non-interactive mock only executes the wrapper body.
    let script = String(data);
    if (
      script === "\x03" ||
      script === "\x03i\x15\x0b" ||
      script === "\x03i\x15" ||
      script === "i\x15\x0b" ||
      script === "i\x15" ||
      script === "\x03\x15\x0b" ||
      script === "\x15\x0b" ||
      script === "\x03i\x15\x0b\x1b\x1bi\x08" ||
      script === "i\x15\x0b\x1b\x1bi\x08" ||
      script === "\x03\x1b\x15\x0b" ||
      script === "\x1b\x15\x0b" ||
      script === "\x03\x1b" ||
      script === "\x1b"
    ) {
      return;
    }
    if (script.startsWith("\x03")) script = script.slice(1);
    if (script.startsWith("i\x15\x0b\x1b\x1bi\x08")) script = script.slice(7);
    else if (script.startsWith("i\x15\x0b")) script = script.slice(3);
    else if (script.startsWith("i\x15")) script = script.slice(2);
    else if (script.startsWith("\x1b\x15\x0b")) script = script.slice(3);
    else if (script.startsWith("\x15\x0b")) script = script.slice(2);
    else if (script.charCodeAt(0) === 0x15 || script.charCodeAt(0) === 0x1b) {
      script = script.slice(1);
    }
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    queueMicrotask(() => {
      this.emit("data", Buffer.from(result.stdout));
    });
  }
}

function markerFromWrite(data) {
  return String(data).match(/(__NCMCP_[a-z0-9]+_[0-9a-f]+__)/i)?.[1] || null;
}

test("buildPendingInputClearPrefix clears the editable line without SIGINT by default", () => {
  assert.equal(buildPendingInputClearPrefix("posix"), "i\x15");
  assert.equal(buildPendingInputClearPrefix("fish"), "i\x15\x0b");
  assert.equal(buildPendingInputClearPrefix("powershell"), "i\x15\x0b\x1b\x1bi\x08");
  assert.equal(buildPendingInputClearPrefix("unknown"), "i\x15");
  assert.equal(buildPendingInputClearPrefix(""), "i\x15");
  assert.equal(buildPendingInputClearPrefix("cmd"), "\x1b");
  assert.equal(buildPendingInputClearPrefix("raw"), "");
});

test("buildPendingInputClearPrefix only sends Ctrl+C when allowInterrupt confirms an idle prompt", () => {
  assert.equal(buildPendingInputClearPrefix("posix", { allowInterrupt: true }), "\x03i\x15");
  assert.equal(buildPendingInputClearPrefix("powershell", { allowInterrupt: true }), "\x03i\x15\x0b\x1b\x1bi\x08");
  assert.equal(buildPendingInputClearPrefix("cmd", { allowInterrupt: true }), "\x03\x1b");
  assert.equal(buildPendingInputClearPrefix("raw", { allowInterrupt: true }), "");
  assert.equal(buildPendingInputClearPrefix("posix", { allowInterrupt: false }), "i\x15");
  assert.equal(buildPendingInputClearPrefix("powershell", { allowInterrupt: false }), "i\x15\x0b\x1b\x1bi\x08");
});

test("PowerShell clear prefix does not start with Escape and restores insert after RevertLine", () => {
  const prefix = buildPendingInputClearPrefix("powershell");
  assert.equal(prefix.startsWith("\x1b"), false, "leading Escape starts an Emacs chord / Vi command mode on Unix pwsh");
  assert.equal(prefix.startsWith("i\x15\x0b"), true, "Emacs/Vi must clear before Windows RevertLine");
  assert.match(prefix, /\x1b\x1bi\x08$/, "ESC ESC is Windows/Emacs RevertLine; i+BS returns Vi to insert");
});

test("posix/fish clear prefix restores vi insert mode before line-kills", () => {
  const posix = buildPendingInputClearPrefix("posix");
  assert.equal(posix.startsWith("i"), true, "vi command mode needs `i` before the wrapper is typed");
  assert.equal(posix, "i\x15");
  assert.equal(posix.indexOf("i"), 0, "`i` must come before Ctrl+U so a literal i is discarded");

  const fish = buildPendingInputClearPrefix("fish");
  assert.equal(fish.startsWith("i"), true);
  assert.equal(fish.endsWith("\x15\x0b"), true);
});

test("posix clear prefix omits Ctrl+K regardless of launch/probe shellPath", () => {
  assert.equal(isCanonicalPosixLineEditor("/bin/dash"), true);
  assert.equal(isCanonicalPosixLineEditor("/usr/bin/ash"), true);
  assert.equal(isCanonicalPosixLineEditor("/bin/bash"), false);
  assert.equal(isCanonicalPosixLineEditor("/bin/zsh"), false);
  assert.equal(isCanonicalPosixLineEditor(""), false);

  // Launch path may still be bash after the user nested into dash (or the
  // reverse). Prefer omitting Ctrl+K over trusting shellPath.
  assert.equal(buildPendingInputClearPrefix("posix", { shellPath: "/bin/dash" }), "i\x15");
  assert.equal(buildPendingInputClearPrefix("posix", { shellPath: "/bin/dash", allowInterrupt: true }), "\x03i\x15");
  assert.equal(buildPendingInputClearPrefix("posix", { shellPath: "/bin/bash" }), "i\x15");
  assert.equal(buildPendingInputClearPrefix("posix", { shellPath: "/bin/bash" }).includes("\x0b"), false);
  // Fish keeps Ctrl+K (no-op) even if the path looks like dash.
  assert.equal(buildPendingInputClearPrefix("fish", { shellPath: "/bin/dash" }), "i\x15\x0b");
});

test("remote /bin/sh classification ignores client realpathSync", () => {
  // Ambiguous remote `sh` must ignore the client symlink target (dash vs bash).
  assert.equal(
    isCanonicalPosixLineEditor("/bin/sh", { resolveLocalSymlinks: false }),
    true,
  );
  assert.equal(
    buildPendingInputClearPrefix("posix", {
      shellPath: "/bin/sh",
      resolveLocalSymlinks: false,
    }),
    "i\x15",
  );
  // Even a resolved remote bash path must not reintroduce Ctrl+K: the active
  // interactive editor may still be a nested canonical shell.
  assert.equal(
    buildPendingInputClearPrefix("posix", {
      shellPath: "/bin/bash",
      resolveLocalSymlinks: false,
    }),
    "i\x15",
  );
});

test("execViaPty omits Ctrl+K for dash-backed local shells", async () => {
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

  const result = await execViaPty(new CapturePty(), "echo GOOD", {
    shellKind: "posix",
    shellPath: "/bin/dash",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(writes[0], "i\x15");
  assert.equal(writes[0].includes("\x0b"), false);
  assert.match(writes[1], /echo GOOD/);
});

test("execViaPty omits Ctrl+K even when launch shellPath is bash", async () => {
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

  const result = await execViaPty(new CapturePty(), "echo GOOD", {
    shellKind: "posix",
    shellPath: "/bin/bash",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(writes[0], "i\x15");
  assert.equal(writes[0].includes("\x0b"), false);
});

test("execViaPty clears unfinished prompt input without Ctrl+C when idle prompt is unconfirmed (#2962)", async () => {
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
  assert.equal(writes.length, 2);
  assert.equal(writes[0], "i\x15", "expected vi-insert restore then Ctrl+U without Ctrl+C");
  assert.match(writes[1], /uname -a/);
  assert.equal(writes[0].includes("\x03"), false);
  assert.equal(writes[1].includes("\x03"), false);
});

test("execViaPty never queues Ctrl+C before the wrapper, even on a confirmed idle prompt", async () => {
  async function captureWrites(shellKind, command, expectedPrompt) {
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
    const result = await execViaPty(new CapturePty(), command, {
      shellKind,
      timeoutMs: 1000,
      expectedPrompt,
    });
    assert.equal(result.ok, true);
    return writes;
  }

  const posixWrites = await captureWrites("posix", "uname -a", "user@host:~$");
  assert.equal(posixWrites[0], "i\x15");
  assert.equal(posixWrites.join("").includes("\x03"), false);

  // Unix pwsh + VINTR: a flushed `$` would drop the marker assignment.
  const psWrites = await captureWrites("powershell", "Get-Host", "PS /home/alice>");
  assert.equal(psWrites[0], "i\x15\x0b\x1b\x1bi\x08");
  assert.equal(psWrites.join("").includes("\x03"), false);
  assert.match(psWrites[1], /^\$/);
});

test("execViaPty clears unfinished PowerShell input without a leading Escape (#2962)", async () => {
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

  const result = await execViaPty(new CapturePty(), "Get-Host", {
    shellKind: "powershell",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0], "i\x15\x0b\x1b\x1bi\x08");
  assert.equal(writes[0].startsWith("\x1b"), false);
  assert.match(writes[1], /Get-Host/);
  assert.equal(writes[0].includes("\x03"), false);
});

test("execViaPty clears unfinished cmd.exe input with Escape and without Ctrl+C when idle prompt is unconfirmed (#2962)", async () => {
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

  const result = await execViaPty(new CapturePty(), "ver", {
    shellKind: "cmd",
    timeoutMs: 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0], "\x1b", "expected Escape clear without Ctrl+C when prompt is unconfirmed");
  assert.match(writes[1], /\bver\b/);
});

test("execViaPty clears shell state before synthetic echo and wrapper write", async () => {
  const writes = [];
  const echoes = [];
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
    typedInput: true,
    echoCommand: (cmd) => {
      echoes.push({ cmd, writesSoFar: writes.slice() });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(echoes.length, 1);
  assert.equal(echoes[0].cmd, "uname -a");
  assert.deepEqual(echoes[0].writesSoFar, ["i\x15"]);
  assert.equal(writes.length, 2);
  assert.equal(writes[0], "i\x15");
  assert.match(writes[1], /uname -a/);
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

test("loginShellHint selects fish/posix without pinning confirmed shellKind", () => {
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "fish" }),
    "fish",
  );
  assert.equal(
    resolveEffectiveShellKind(undefined, "user@host:~$", { loginShellHint: "posix" }),
    "posix",
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
