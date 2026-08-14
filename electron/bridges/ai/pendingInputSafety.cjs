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

function parseLocalProcessTable(stdout, rootPid) {
  const rows = [];
  const parents = new Map();
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
    parents.set(row.pid, row.ppid);
  }

  const descendsFromRoot = (pid) => {
    let current = pid;
    for (let depth = 0; depth < 64 && current > 0; depth += 1) {
      if (current === rootPid) return true;
      current = parents.get(current) || 0;
    }
    return false;
  };

  return rows.some((row) => (
    row.tpgid > 0
    && row.pgid === row.tpgid
    && isShellName(row.command)
    && descendsFromRoot(row.pid)
  ));
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
    'ps -e -o pid=,pgid=,tpgid=,tty=,comm= 2>/dev/null | while read _pid _pgid _tpgid _tty _comm; do',
    '  [ "$_tty" = "$_target_tty" ] || continue',
    '  [ "$_pgid" = "$_tpgid" ] && [ "$_tpgid" -gt 0 ] 2>/dev/null || continue',
    '  case "$_comm" in sh|bash|zsh|fish|ksh|dash|ash|csh|tcsh|-sh|-bash|-zsh|-fish|-ksh|-dash|-ash|-csh|-tcsh) ;; *) continue ;; esac',
    `  echo ${SAFE_MARKER}; break`,
    'done',
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
  buildRemoteForegroundShellProbeCommand,
  capturePendingInputState,
  isPendingInputStateCurrent,
  parseLocalProcessTable,
  verifySessionForegroundShell,
};
