"use strict";

/**
 * Netcatty-owned ssh-agent for FIDO2 sk-* keys.
 *
 * System agents started at login often lack SSH_ASKPASS, so PIN/touch prompts
 * never reach our GUI. Spawning a short-lived agent as our child with askpass
 * env makes sk-helper prompts work inside Netcatty.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { buildFidoAskpassEnv, shutdownFidoAskpass } = require("./fidoAskpass.cjs");

const execFileAsync = promisify(execFile);

/** @type {{ killed: boolean, pid: number, kill: (sig?: string) => void }|null} */
let agentChild = null;
/** @type {string|null} */
let agentSocket = null;
/** @type {string|null} */
let agentDir = null;
let refCount = 0;
/** @type {Promise<{ socketPath: string, askpassEnv: Record<string, string>, owned: boolean }>|null} */
let startingPromise = null;

function getTempBase() {
  try {
    const tempDirBridge = require("./tempDirBridge.cjs");
    if (typeof tempDirBridge.getTempDir === "function") return tempDirBridge.getTempDir();
  } catch {
    // fall through
  }
  return require("node:os").tmpdir();
}

function resolveSshAgentBinary(env = process.env) {
  if (typeof env.NETCATTY_SSH_AGENT_PATH === "string" && env.NETCATTY_SSH_AGENT_PATH.trim()) {
    return env.NETCATTY_SSH_AGENT_PATH.trim();
  }
  if (process.platform === "darwin") {
    for (const candidate of [
      "/opt/homebrew/bin/ssh-agent",
      "/usr/local/bin/ssh-agent",
      "/usr/bin/ssh-agent",
    ]) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // continue
      }
    }
  }
  return "ssh-agent";
}

function parseAgentStdout(stdout) {
  const sockMatch = /SSH_AUTH_SOCK=([^;\s]+)/.exec(stdout || "");
  const pidMatch = /SSH_AGENT_PID=(\d+)/.exec(stdout || "");
  return {
    socketPath: sockMatch?.[1] || null,
    agentPid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

function isProcessAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isAgentLive() {
  if (!agentSocket) return false;
  try {
    if (!fs.existsSync(agentSocket)) return false;
  } catch {
    return false;
  }
  if (agentChild?.pid) return isProcessAlive(agentChild.pid);
  // Socket exists but no PID tracking — treat as live until connect fails.
  return !agentChild?.killed;
}

function clearAgentState({ kill = true } = {}) {
  if (kill && agentChild) {
    try {
      if (agentChild.pid && isProcessAlive(agentChild.pid)) {
        process.kill(agentChild.pid, "TERM");
      } else {
        agentChild.kill?.("TERM");
      }
    } catch {
      // ignore
    }
    // Prefer ssh-agent -k when socket known
    if (agentSocket) {
      try {
        const sshAgent = resolveSshAgentBinary();
        execFile(sshAgent, ["-k"], {
          env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
          windowsHide: true,
          timeout: 3000,
        }, () => {});
      } catch {
        // ignore
      }
    }
  }
  agentChild = null;
  agentSocket = null;
  if (agentDir) {
    fs.promises.rm(agentDir, { recursive: true, force: true }).catch(() => {});
    agentDir = null;
  }
  refCount = 0;
}

/**
 * Acquire a Netcatty FIDO agent socket. Multiple callers share one agent.
 * Concurrent acquires are serialized via startingPromise.
 */
async function acquireFidoAgent(options = {}) {
  if (startingPromise) {
    const shared = await startingPromise;
    if (isAgentLive()) {
      refCount += 1;
      return shared;
    }
  }

  if (isAgentLive() && agentSocket) {
    refCount += 1;
    return {
      socketPath: agentSocket,
      askpassEnv: buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents }),
      owned: true,
    };
  }

  // Dead leftover state
  if (agentSocket || agentChild) clearAgentState({ kill: true });

  startingPromise = (async () => {
    const run = options.execFile || execFileAsync;
    const env = options.env || process.env;
    const askpassEnv = buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents });
    const sshAgent = resolveSshAgentBinary(env);

    agentDir = path.join(getTempBase(), `netcatty-fido-agent-${randomUUID().slice(0, 8)}`);
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const sockPath = path.join(agentDir, "agent.sock");

    let stdout = "";
    try {
      const result = await run(sshAgent, ["-a", sockPath, "-s"], {
        timeout: 10000,
        windowsHide: true,
        env: { ...env, ...askpassEnv },
      });
      stdout = result.stdout?.toString?.() || result.stdout || "";
    } catch (error) {
      try {
        const result = await run(sshAgent, ["-s"], {
          timeout: 10000,
          windowsHide: true,
          env: { ...env, ...askpassEnv },
        });
        stdout = result.stdout?.toString?.() || result.stdout || "";
      } catch (fallbackError) {
        clearAgentState({ kill: false });
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        const err = new Error(
          `Could not start a FIDO-capable ssh-agent (${message}). Install OpenSSH with libfido2 (macOS: brew install openssh libfido2).`,
        );
        err.code = "ERR_FIDO_AGENT_START";
        throw err;
      }
    }

    const parsed = parseAgentStdout(stdout);
    agentSocket = parsed.socketPath || (fs.existsSync(sockPath) ? sockPath : null);
    if (!agentSocket) {
      clearAgentState({ kill: true });
      const err = new Error("ssh-agent started but SSH_AUTH_SOCK was not reported.");
      err.code = "ERR_FIDO_AGENT_SOCK";
      throw err;
    }

    if (parsed.agentPid && Number.isFinite(parsed.agentPid) && parsed.agentPid > 0) {
      const pid = parsed.agentPid;
      agentChild = {
        killed: false,
        pid,
        kill(sig = "TERM") {
          try { process.kill(pid, sig); } catch { /* ignore */ }
          this.killed = true;
        },
      };
    } else {
      // No PID — still usable via socket; kill via ssh-agent -k on release.
      agentChild = {
        killed: false,
        pid: 0,
        kill() { this.killed = true; },
      };
    }

    refCount = 1;
    return {
      socketPath: agentSocket,
      askpassEnv,
      owned: true,
    };
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

function releaseFidoAgent() {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  clearAgentState({ kill: true });
}

function getActiveFidoAgentSocket() {
  return isAgentLive() ? agentSocket : null;
}

function shutdownFidoAgentSubsystem() {
  clearAgentState({ kill: true });
  try {
    shutdownFidoAskpass();
  } catch {
    // ignore
  }
}

let quitHookInstalled = false;
function installFidoAgentQuitHook() {
  if (quitHookInstalled) return;
  quitHookInstalled = true;
  try {
    const { app } = require("electron");
    const shutdown = () => {
      try { shutdownFidoAgentSubsystem(); } catch { /* ignore */ }
    };
    app.once("before-quit", shutdown);
    app.once("will-quit", shutdown);
  } catch {
    // non-electron
  }
}

// Best-effort install when module loads in Electron main.
try { installFidoAgentQuitHook(); } catch { /* ignore */ }

module.exports = {
  acquireFidoAgent,
  releaseFidoAgent,
  getActiveFidoAgentSocket,
  resolveSshAgentBinary,
  parseAgentStdout,
  shutdownFidoAgentSubsystem,
  installFidoAgentQuitHook,
  isAgentLive,
};
