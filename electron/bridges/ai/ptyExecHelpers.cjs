"use strict";

const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");
const iconv = require("iconv-lite");
const { stripAnsi, isDefaultPowerShellPromptLine } = require("./shellUtils.cjs");
const { classifyLocalShellType } = require("../../../lib/localShell.cjs");

// dash / ash / busybox use canonical (ICANON) line editing: VKILL (Ctrl+U)
// clears the whole pending line, but Ctrl+K is not bound and arrives as a
// literal 0x0b that prefixes the wrapper (`\x0becho: not found`) and prevents
// the start marker from ever arriving. bash/zsh readline needs Ctrl+K to
// clear text to the right of the cursor.
const CANONICAL_POSIX_LINE_EDITORS = new Set(["dash", "ash", "busybox"]);

function shellExecutableBaseName(shellPath) {
  const normalized = String(shellPath || "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const base = normalized.split("/").pop() || "";
  return base.toLowerCase();
}

/**
 * True when the interactive shell clears lines with canonical VKILL rather
 * than readline (Ctrl+U left + Ctrl+K right).
 *
 * Local `sh` symlinks are resolved when the path exists on this host. Remote
 * probe paths that are merely named `sh` are treated as canonical: sending
 * Ctrl+K breaks dash-backed /bin/sh (Debian/Ubuntu), while omitting it on
 * rarer bash-as-sh remotes only matters when the cursor is mid-line.
 *
 * @param {string} [shellPath]
 */
function isCanonicalPosixLineEditor(shellPath) {
  let base = shellExecutableBaseName(shellPath);
  if (!base) return false;
  if (CANONICAL_POSIX_LINE_EDITORS.has(base)) return true;
  if (base !== "sh") return false;

  const trimmed = String(shellPath || "").trim();
  try {
    if (trimmed && fs.existsSync(trimmed)) {
      base = shellExecutableBaseName(fs.realpathSync(trimmed));
      return CANONICAL_POSIX_LINE_EDITORS.has(base);
    }
  } catch {
    // Fall through to the ambiguous-`sh` default below.
  }
  return true;
}

// Build a stateful decoder for a full exec call. Serial data events can
// split multi-byte characters across chunks (very common on GBK/GB18030
// consoles), and a stateless iconv.decode per chunk would emit
// replacement bytes for the leading half. StringDecoder and
// iconv.getDecoder both preserve partial-byte state across write() calls
// and flush any trailing bytes on end(), which is what we need.
function createStatefulDecoder(encoding) {
  const enc = encoding || "utf8";
  if (Buffer.isEncoding(enc)) {
    return new StringDecoder(enc);
  }
  try {
    return iconv.getDecoder(enc);
  } catch {
    return new StringDecoder("utf8");
  }
}

function detectShellKind(shellPath, platform = process.platform) {
  return classifyLocalShellType(shellPath, platform);
}

function subscribeToPtyData(ptyStream, onData) {
  if (typeof ptyStream?.onData === "function") {
    const disposable = ptyStream.onData((data) => onData(data));
    return () => {
      try {
        disposable?.dispose?.();
      } catch {
        // Ignore cleanup failures
      }
    };
  }

  if (typeof ptyStream?.on === "function" && typeof ptyStream?.removeListener === "function") {
    ptyStream.on("data", onData);
    return () => {
      try {
        ptyStream.removeListener("data", onData);
      } catch {
        // Ignore cleanup failures
      }
    };
  }

  throw new Error("PTY stream does not support data subscriptions");
}

function hasExpectedPromptSuffix(text, expectedPrompt) {
  if (!expectedPrompt) return false;
  const normalizedText = stripAnsi(String(text || "")).replace(/\r/g, "");
  const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
  return !!normalizedPrompt && normalizedText.endsWith(normalizedPrompt);
}

function escapePosixSingleQuoted(text) {
  return String(text || "").replace(/'/g, "'\\''");
}

function escapePowerShellSingleQuoted(text) {
  return String(text || "").replace(/'/g, "''");
}

function escapeFishSingleQuoted(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeCmdForNestedShell(text) {
  return String(text || "").replace(/"/g, '""').replace(/%/g, "%%");
}

// Matches PowerShell's default prompt only (e.g. `PS C:\Users\alice>`,
// `PS>`). Custom prompt functions (oh-my-posh, starship, PSReadLine themes
// that emit `❯`/`λ`/etc.) intentionally fall through — we'd rather miss
// the override than wrap a fish/zsh prompt as PowerShell. Pattern lives
// in shellUtils.cjs so prompt extraction and wrapper selection share one
// source of truth.
function isPowerShellPrompt(prompt) {
  // Treat `\r` as a line break too so a PSReadLine/ConPTY redraw like
  // `PS C:\old>\rPS C:\new>` is matched against the redrawn last line,
  // not the doubled string.
  const lastLine = stripAnsi(String(prompt || ""))
    .replace(/\r/g, "\n")
    .split("\n")
    .pop()
    .replace(/\s+$/, "");
  return isDefaultPowerShellPromptLine(lastLine);
}

// Prompt-driven override is intentionally narrow: only flip to PowerShell
// when the session has no confirmed shell type. This keeps the issue #841
// fix working for remote Windows shells that never set shellKind at connect
// time, while preventing a malicious remote process from spoofing a
// `PS ...>` line on a real bash/zsh/fish/cmd session to coerce a single
// mis-wrapped command.
//
// Remote login-shell probing stores a *soft* hint (`loginShellHint` /
// session._loginShellKind) without pinning session.shellKind for fish/posix:
//   - hint "fish"  → fish wrapper (issue #1854) without permanent pin
//   - hint "posix" → native posix wrapper evaluated by interactive bash/zsh
//                    (NOT sh -c / dash — Codex P2 on #2061)
//   - live PS ...> still overrides when base kind is open
//
// Universe of shellKind values (see lib/localShell.cjs:23-33 and
// terminalBridge.cjs:368, :932, :1074):
//   "posix" | "powershell" | "cmd" | "fish" | "unknown" | "raw" | "" | undefined
// Excluded on purpose from prompt override:
//   - "posix" / "fish" / "cmd": confirmed — never override.
//   - "powershell": already correct; no override needed (would be a no-op).
//   - "raw": serial / network device — execViaRawPty bypasses buildWrappedCommand.
const SHELL_KINDS_OPEN_TO_PROMPT_OVERRIDE = new Set([
  "",
  "unknown",
]);

const LOGIN_SHELL_HINTS = new Set(["posix", "fish", "powershell", "cmd"]);

function resolveEffectiveShellKind(shellKind, expectedPrompt, options = {}) {
  const baseKind = shellKind || "";
  if (
    SHELL_KINDS_OPEN_TO_PROMPT_OVERRIDE.has(baseKind) &&
    isPowerShellPrompt(expectedPrompt)
  ) {
    return "powershell";
  }
  if (baseKind) return baseKind;

  // Soft login-shell hint from remote probe (not a permanent pin).
  const hint = options.loginShellHint || "";
  if (LOGIN_SHELL_HINTS.has(hint)) return hint;

  return "posix";
}

function buildPosixWrapperBody(command, marker) {
  const noPager = "PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS= ";
  const commandLines = String(command || "").replace(/\r\n?/g, "\n").split("\n");
  const cmdAssign = commandLines.length > 1
    ? `${marker}_cmd=$(printf '%s\\n' ${commandLines.map((line) => `'${escapePosixSingleQuoted(line)}'`).join(" ")})`
    : `${marker}_cmd='${escapePosixSingleQuoted(command)}'`;
  return (
    `${marker}=0; ${cmdAssign}; { printf '%s\\n' '${marker}_S'; trap ':' INT; ( ${noPager}eval "$${marker}_cmd" ); __NCMCP_rc=$?; trap - INT; printf '%s\\n' '${marker}_E:'\"$__NCMCP_rc\"; (exit $__NCMCP_rc); }`
  );
}

/**
 * Bytes to discard unfinished prompt-line input before an AI/MCP PTY write.
 * Without this, a half-typed user command (e.g. `ls` or `rm -rf * `) is
 * concatenated with the wrapped agent command (#2962).
 *
 * - readline / fish: send `i` first so bash/zsh/fish vi-mode command state
 *   returns to insert. Emacs and vi-insert treat `i` as a literal, which the
 *   following line-kills immediately discard. Then Ctrl+U + Ctrl+K clear
 *   residual text on both sides of the cursor. Fish treats Ctrl+U as
 *   kill-whole-line; the trailing Ctrl+K is a no-op.
 * - canonical posix (dash / ash / busybox / unresolved `sh`): Ctrl+U alone
 *   (VKILL) clears the whole pending line. Ctrl+K must be omitted — it is a
 *   literal 0x0b and the wrapper is parsed as `\x0b…` (no start marker).
 * - PowerShell: one sequence has to survive Windows, Emacs, and Vi PSReadLine.
 *   Leading Escape is Windows-only RevertLine; on Unix pwsh it starts an
 *   Emacs chord or drops Vi into command mode, so it cannot come first.
 *   `i` + Ctrl+U/Ctrl+K clears Emacs/Vi-insert (and `i` restores Vi-command
 *   insert). ESC ESC is RevertLine in Windows and Emacs. A final `i` +
 *   Backspace returns Vi to insert and discards the literal `i` that
 *   Windows/Emacs just typed.
 * - cmd.exe: Escape clears the current input line
 * - raw (serial / vendor CLI): no clear — Ctrl+U/Ctrl+C are not universal and
 *   would prepend control bytes on devices that lack line-erase
 *
 * Ctrl+C (ETX) is optional via `allowInterrupt`. Callers must only set it when
 * the shell is known to be accepting editable prompt input (e.g. a fresh idle
 * prompt). Unconditional ETX would SIGINT user-started foreground processes
 * that `activeSessionExecutions` does not track.
 *
 * @param {string} shellKind
 * @param {{ allowInterrupt?: boolean, shellPath?: string }} [options]
 */
function buildPendingInputClearPrefix(shellKind, options = {}) {
  if (shellKind === "raw") return "";
  const allowInterrupt = options.allowInterrupt === true;
  if (shellKind === "cmd") return allowInterrupt ? "\x03\x1b" : "\x1b";
  // Do not start with Escape: Unix Emacs pwsh treats it as a chord prefix and
  // Vi-insert treats it as command-mode. See the doc comment above.
  if (shellKind === "powershell") {
    const lineClear = "i\x15\x0b\x1b\x1bi\x08";
    return allowInterrupt ? `\x03${lineClear}` : lineClear;
  }
  // `i` before the line-kills restores readline/fish vi insert mode. Do not
  // put `i` after the kills — that would prefix the wrapper with a literal i.
  // Fish keeps trailing Ctrl+K (no-op). Canonical posix omits it.
  const omitCtrlK = shellKind !== "fish" && isCanonicalPosixLineEditor(options.shellPath);
  const lineClear = omitCtrlK ? "i\x15" : "i\x15\x0b";
  return allowInterrupt ? `\x03${lineClear}` : lineClear;
}

function buildWrappedCommand(command, shellKind, marker) {
  switch (shellKind) {
    case "powershell": {
      const psPager = "$env:PAGER='cat'; $env:SYSTEMD_PAGER=''; $env:GIT_PAGER='cat'; $env:LESS=''; ";
      const psEscaped = escapePowerShellSingleQuoted(command);
      return (
        `$${marker}=0; $${marker}_cmd='${psEscaped}'; & { Write-Output '${marker}_S'; ${psPager}$LASTEXITCODE=$null; try { Invoke-Expression $${marker}_cmd; $${marker}_rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } } catch { $${marker}_rc = 1 }; Write-Output "${marker}_E:$${marker}_rc" }\r\n`
      );
    }

    case "cmd": {
      const cmdEscaped = escapeCmdForNestedShell(command);
      return (
        `set "${marker}=0" & set "${marker}_CMD=${cmdEscaped}" & (echo ${marker}_S & set "PAGER=cat" & set "SYSTEMD_PAGER=" & set "GIT_PAGER=cat" & set "LESS=" & call cmd /d /s /c "%${marker}_CMD%" & call echo ${marker}_E:^%errorlevel^%)\r\n`
      );
    }

    case "fish":
      // Leading space: see the comment in the POSIX branch below. Fish
      // does not skip leading-space commands by default, but users can
      // define a `fish_should_add_to_history` function that filters them
      // — this prefix is what lets that opt-in actually take effect.
      return (
        ` set ${marker} 0; function __ncmcp_int --on-signal INT; printf '%s\\n' '${marker}_E:130'; functions -e __ncmcp_int; end; ` +
        `set -l ${marker}_cmd '${escapeFishSingleQuoted(command)}'; ` +
        `begin; set -gx PAGER cat; set -gx SYSTEMD_PAGER ''; set -gx GIT_PAGER cat; set -gx LESS ''; ` +
        `printf '%s\\n' '${marker}_S'; eval \$${marker}_cmd; set __NCMCP_rc $status; ` +
        `functions -e __ncmcp_int; printf '%s\\n' '${marker}_E:'\$__NCMCP_rc; end\n`
      );

    case "posix":
    default: {
      // Single-line compound command with early marker.
      //
      // Layout: __NCMCP_xxx=0; { ... MARKER_S; eval command; MARKER_E; }
      //
      // Key design decisions:
      //
      // 1) __NCMCP_xxx=0 at the VERY START ensures the PTY echo line
      //    contains __NCMCP_ in its first few bytes. This is critical:
      //    preload.cjs filters chunks by buffering incomplete lines that
      //    contain __NCMCP_. Without this prefix, the first chunk of a
      //    long echo line might not contain the marker and would leak
      //    through to the terminal as garbage.
      //
      // 2) The user command is executed via eval on a quoted string. This
      //    keeps shell syntax errors inside the eval call so the wrapper
      //    can still emit the end marker and return a non-zero exit code.
      //
      // 3) Single-line { ... } is parsed fully before execution, so SIGINT
      //    cannot cause bash to flush the end marker from the input buffer.
      //    trap ':' INT lets child processes receive SIGINT normally while
      //    preventing the shell from aborting the compound command.
      //
      // 4) The eval runs inside a subshell ( ... ) so shell-terminating
      //    constructs in the generated command — set -e / set -o errexit
      //    followed by a failure, exit, shell option changes, traps,
      //    function/alias definitions — end or mutate only the subshell,
      //    never the user's active login shell (issue #1850). set -e still
      //    behaves normally *inside* the command, and the subshell shares
      //    the PTY so the user sees all output live. The intentional
      //    trade-off is that cd/export no longer persist into the user's
      //    shell or across agent commands; the terminal.execute tool
      //    description tells the model to combine cd with its command.
      //    Earlier attempts (PRs #1852/#1882) that instead tried to detect
      //    dangerous commands grew into shell parsing and were abandoned —
      //    do not reintroduce detection here.
      //
      // Leading single space: lets bash/zsh skip recording this command
      // in history when the user already has HISTCONTROL=ignorespace
      // (bash) or HIST_IGNORE_SPACE (zsh) configured — Debian/Ubuntu and
      // most Oh-My-Zsh setups have this on by default; CentOS/RHEL users
      // can opt in by adding `HISTCONTROL=ignoreboth` to ~/.bashrc.
      // Without that config the prefix is harmless; it just doesn't
      // suppress history recording.
      return ` ${buildPosixWrapperBody(command, marker)}\n`;
    }
  }
}

function findEndMarker(outputText, marker, { allowInline = false } = {}) {
  const endPattern = marker + "_E:";
  let searchFrom = 0;
  while (searchFrom < outputText.length) {
    const endIdx = outputText.indexOf(endPattern, searchFrom);
    if (endIdx === -1) return null;

    // Before the start marker is confirmed, require a line boundary so the
    // echoed wrapper command cannot be mistaken for real completion. Once the
    // command has started, the random marker can safely follow output that did
    // not end with a newline.
    if (allowInline || endIdx === 0 || outputText[endIdx - 1] === "\n" || outputText[endIdx - 1] === "\r") {
      const afterEnd = outputText.slice(endIdx + endPattern.length);
      const codeMatch = afterEnd.match(/^(\d+)/);
      const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : null;
      if (exitCode !== null) {
        return { endIdx, exitCode };
      }
    }
    searchFrom = endIdx + 1;
  }
  return null;
}

function normalizePtyOutput(stdout, {
  stripMarkers = false,
  expectedPrompt = "",
  trimOutput = true,
  stripPrompt = true,
  markerToStrip = null,
} = {}) {
  let cleaned = stripAnsi(stdout || "").replace(/\r/g, "");
  if (stripMarkers) {
    // Prefer the job-specific marker so user output that contains "__NCMCP_"
    // (e.g. printf '__NCMCP_demo\n') is preserved.
    const pattern = markerToStrip
      ? new RegExp(`^[^\r\n]*${markerToStrip}[^\r\n]*[\r\n]*`, "gm")
      : /^[^\r\n]*__NCMCP_[^\r\n]*[\r\n]*/gm;
    cleaned = cleaned.replace(pattern, "");
  }
  const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
  if (stripPrompt && normalizedPrompt && cleaned.endsWith(normalizedPrompt)) {
    cleaned = cleaned.slice(0, cleaned.length - normalizedPrompt.length);
  }
  return trimOutput ? cleaned.trim() : cleaned;
}

function appendBoundedOutput(current, chunk, maxBufferedChars) {
  const limit = Number.isFinite(maxBufferedChars) ? Math.max(0, Math.floor(maxBufferedChars)) : 0;
  const currentText = String(current || "");
  const chunkText = String(chunk || "");
  if (limit > 0 && chunkText.length >= limit) {
    return {
      text: chunkText.slice(-limit),
      dropped: currentText.length + chunkText.length - limit,
    };
  }
  const combined = `${currentText}${chunkText}`;
  if (limit <= 0 || combined.length <= limit) {
    return { text: combined, dropped: 0 };
  }
  const dropped = combined.length - limit;
  return {
    text: combined.slice(dropped),
    dropped,
  };
}

function consumeVisibleText(carry, chunk) {
  const input = `${carry || ""}${chunk || ""}`;
  if (!input) {
    return { visibleText: "", carry: "" };
  }

  let visibleText = "";
  let index = 0;

  while (index < input.length) {
    const ch = input[index];

    if (ch === "\r") {
      // Preserve \r so consumers / serializers can collapse progress-bar
      // redraws to the latest frame. \r\n becomes a single \n.
      if (input[index + 1] === "\n") {
        visibleText += "\n";
        index += 2;
        continue;
      }
      visibleText += "\r";
      index += 1;
      continue;
    }

    if (ch !== "\u001b") {
      visibleText += ch;
      index += 1;
      continue;
    }

    if (index + 1 >= input.length) {
      break;
    }

    const next = input[index + 1];

    if (next === "[") {
      let cursor = index + 2;
      let complete = false;
      while (cursor < input.length) {
        const code = input.charCodeAt(cursor);
        if (code >= 0x40 && code <= 0x7e) {
          index = cursor + 1;
          complete = true;
          break;
        }
        cursor += 1;
      }
      if (!complete) break;
      continue;
    }

    if (next === "]") {
      let cursor = index + 2;
      let complete = false;
      while (cursor < input.length) {
        const oscChar = input[cursor];
        if (oscChar === "\u0007") {
          index = cursor + 1;
          complete = true;
          break;
        }
        if (oscChar === "\u001b") {
          if (cursor + 1 >= input.length) break;
          if (input[cursor + 1] === "\\") {
            index = cursor + 2;
            complete = true;
            break;
          }
        }
        cursor += 1;
      }
      if (!complete) break;
      continue;
    }

    visibleText += ch;
    index += 1;
  }

  return {
    visibleText,
    carry: input.slice(index),
  };
}

module.exports = {
  createStatefulDecoder,
  detectShellKind,
  subscribeToPtyData,
  hasExpectedPromptSuffix,
  resolveEffectiveShellKind,
  isCanonicalPosixLineEditor,
  buildPendingInputClearPrefix,
  buildWrappedCommand,
  findEndMarker,
  normalizePtyOutput,
  appendBoundedOutput,
  consumeVisibleText,
  stripAnsi,
};
