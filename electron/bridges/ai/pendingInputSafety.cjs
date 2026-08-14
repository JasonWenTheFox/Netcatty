"use strict";

const { execFile } = require("node:child_process");
const { createSessionExecProbe, isWindowsOpenSshRemote } = require("./sessionShellKind.cjs");

const SAFE_MARKER = "__NETCATTY_FOREGROUND_SHELL__";
const SHELL_NAME = /^(?:ba|z|fi|k|da|a|c|tc)?sh$/;

function isShellName(value) {
  return SHELL_NAME.test(String(value || "").replace(/^.*\//, "").replace(/^-/, ""));
}

function capturePendingInputState(session) {
  return {
    pending: session?._hasPendingUserInput === true,
    revision: Number.isSafeInteger(session?._userInputRevision)
      ? session._userInputRevision
      : 0,
  };
}

function isPendingInputStateCurrent(session, captured) {
  const current = capturePendingInputState(session);
  return current.pending === captured?.pending && current.revision === captured?.revision;
}

function isUserInputRevisionCurrent(session, captured) {
  return capturePendingInputState(session).revision === captured?.revision;
}

function acquireSessionInputGate(session, captured) {
  if (!session || !isPendingInputStateCurrent(session, captured)) return null;
  if (session._aiInputClearToken) return null;
  const token = Symbol("ai-input-clear");
  session._aiInputClearToken = token;
  return () => {
    if (session._aiInputClearToken === token) {
      delete session._aiInputClearToken;
      const deferred = Array.isArray(session._aiInputClearDeferredWrites)
        ? session._aiInputClearDeferredWrites.splice(0)
        : [];
      delete session._aiInputClearDeferredWrites;
      for (const replay of deferred) {
        try { replay(); } catch {}
      }
    }
  };
}

function parseLocalProcessTable(stdout, rootPid) {
  const rows = [];
  for (const line of String(stdout || "").split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/);
    if (!match) continue;
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      command: match[5].trim(),
    };
    rows.push(row);
  }

  const root = rows.find((row) => row.pid === rootPid);
  if (!root || root.tpgid <= 0 || root.pgid !== root.tpgid || !isShellName(root.command)) {
    return false;
  }
  return !rows.some((row) => row.pid !== rootPid && row.pgid === root.pgid);
}

function verifyLocalForegroundShell(session) {
  const rootPid = Number(session?.proc?.pid || session?.pty?.pid || 0);
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || process.platform === "win32") {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,comm="],
      { timeout: 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(!error && parseLocalProcessTable(stdout, rootPid)),
    );
  });
}

function buildRemoteForegroundShellProbeCommand(targetShellPid) {
  const script = [
    'SELF=$$',
    `TARGET=${Number(targetShellPid)}`,
    '_conn=$(tr "\\0" "\\n" < /proc/$SELF/environ 2>/dev/null | sed -n "s/^SSH_CONNECTION=//p" | head -n1)',
    '[ -n "$_conn" ] || exit 0',
    '_target_conn=$(tr "\\0" "\\n" < /proc/$TARGET/environ 2>/dev/null | sed -n "s/^SSH_CONNECTION=//p" | head -n1)',
    '[ "$_target_conn" = "$_conn" ] || exit 0',
    '_target_tty=$(ps -p "$TARGET" -o tty= 2>/dev/null | tr -d "[:space:]")',
    '[ -n "$_target_tty" ] && [ "$_target_tty" != "?" ] || exit 0',
    'set -- $(ps -p "$TARGET" -o pgid=,tpgid=,comm= 2>/dev/null)',
    '_pgid=$1; _tpgid=$2; _comm=$3',
    '[ "$_pgid" = "$_tpgid" ] && [ "$_tpgid" -gt 0 ] 2>/dev/null || exit 0',
    'case "$_comm" in sh|bash|zsh|fish|ksh|dash|ash|csh|tcsh|-sh|-bash|-zsh|-fish|-ksh|-dash|-ash|-csh|-tcsh) ;; *) exit 0 ;; esac',
    "_other=$(ps -e -o pid=,pgid=,tty= 2>/dev/null | awk -v target=\"$TARGET\" -v pgid=\"$_pgid\" -v tty=\"$_target_tty\" '$1 != target && $2 == pgid && $3 == tty { print $1; exit }')",
    '[ -z "$_other" ] || exit 0',
    `echo ${SAFE_MARKER}`,
  ].join("\n");
  return `exec sh -c '${script.replace(/'/g, "'\\''")}'`;
}

async function verifySessionForegroundShell(session, options = {}) {
  if (!session || session._hasPendingUserInput !== true) return false;
  if (typeof session._pendingInputSafetyProbe === "function") {
    try {
      return await session._pendingInputSafetyProbe() === true;
    } catch {
      return false;
    }
  }

  if (session.protocol === "local" || session.type === "local") {
    return verifyLocalForegroundShell(session);
  }
  if (isWindowsOpenSshRemote(session.remoteSshVersion)) return false;

  const kind = session.shellKind || session._loginShellKind;
  if (kind !== "posix" && kind !== "fish") return false;
  const targetShellPid = Number(session.shellPid || 0);
  if (!Number.isSafeInteger(targetShellPid) || targetShellPid <= 0) return false;
  const execProbe = createSessionExecProbe(session);
  if (!execProbe) return false;
  const output = await execProbe(
    buildRemoteForegroundShellProbeCommand(targetShellPid),
    options.timeoutMs || 3000,
  );
  return String(output || "").split(/\r?\n/).some((line) => line.trim() === SAFE_MARKER);
}

module.exports = {
  SAFE_MARKER,
  acquireSessionInputGate,
  buildRemoteForegroundShellProbeCommand,
  capturePendingInputState,
  isPendingInputStateCurrent,
  isUserInputRevisionCurrent,
  parseLocalProcessTable,
  verifySessionForegroundShell,
};
