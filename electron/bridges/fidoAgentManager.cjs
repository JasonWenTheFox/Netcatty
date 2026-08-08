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
const {
  buildFidoAskpassEnv,
  releaseFidoAskpassLease,
  shutdownFidoAskpass,
} = require("./fidoAskpass.cjs");

const execFileAsync = promisify(execFile);

/** @type {{ killed: boolean, pid: number, kill: (sig?: string) => void }|null} */
let agentChild = null;
/** @type {string|null} */
let agentSocket = null;
/** @type {string|null} */
let agentDir = null;
let refCount = 0;
/**
 * Monotonic id for the currently tracked agent. Cleared/restarted agents bump
 * this so stale release callbacks from earlier acquisitions cannot kill a newer
 * agent that reused the singleton slot.
 */
let agentGeneration = 0;
/** @type {Promise<{ socketPath: string, askpassEnv: Record<string, string>, owned: boolean, generation: number }>|null} */
let startingPromise = null;

function getTempBase() {
  const tempDirBridge = require("./tempDirBridge.cjs");
  if (typeof tempDirBridge.getTempDir !== "function") {
    throw new Error("FIDO agent requires Netcatty temp directory (tempDirBridge unavailable).");
  }
  return tempDirBridge.getTempDir();
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
    const ownedPid = agentChild.pid;
    // Only kill OUR tracked pid. Never run `ssh-agent -k` with the ambient
    // process.env SSH_AGENT_PID — that can kill the user's login agent.
    try {
      if (ownedPid && isProcessAlive(ownedPid)) {
        process.kill(ownedPid, "TERM");
      }
    } catch {
      // ignore
    }
    if (ownedPid && agentSocket) {
      try {
        const sshAgent = resolveSshAgentBinary();
        // Isolate env: only our sock + pid, no inheritance of login agent vars.
        execFile(sshAgent, ["-k"], {
          env: {
            PATH: process.env.PATH || "/usr/bin:/bin",
            SSH_AUTH_SOCK: agentSocket,
            SSH_AGENT_PID: String(ownedPid),
          },
          windowsHide: true,
          timeout: 3000,
        }, () => {});
      } catch {
        // ignore
      }
    }
    try {
      agentChild.kill?.("TERM");
    } catch {
      // ignore
    }
  }
  agentChild = null;
  agentSocket = null;
  if (agentDir) {
    fs.promises.rm(agentDir, { recursive: true, force: true }).catch(() => {});
    agentDir = null;
  }
  refCount = 0;
  agentGeneration += 1;
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
      // Caller-specific askpass lease — never reuse the starter's resolver.
      return {
        socketPath: shared.socketPath,
        askpassEnv: buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents }),
        owned: shared.owned,
        generation: shared.generation,
      };
    }
  }

  if (isAgentLive() && agentSocket) {
    refCount += 1;
    return {
      socketPath: agentSocket,
      askpassEnv: buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents }),
      owned: true,
      generation: agentGeneration,
    };
  }

  // Dead leftover state
  if (agentSocket || agentChild) clearAgentState({ kill: true });

  startingPromise = (async () => {
    const run = options.execFile || execFileAsync;
    const env = options.env || process.env;
    const askpassEnv = buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents });
    const platform = options.platform || process.platform;
    const releaseStarterAskpassLease = () => {
      try {
        releaseFidoAskpassLease(askpassEnv?.NETCATTY_FIDO_ASKPASS_LEASE);
      } catch {
        // ignore
      }
    };

    try {
      // Win32-OpenSSH's ssh-agent is a Windows service bound to a fixed named
      // pipe (`\\.\pipe\openssh-ssh-agent`) and does not support `ssh-agent -a`.
      // Reuse the system pipe and keep Netcatty askpass on ssh-add / ssh-sk-helper.
      if (platform === "win32") {
        const systemPipe = "\\\\.\\pipe\\openssh-ssh-agent";
        agentSocket = systemPipe;
        agentChild = null;
        agentDir = null;
        refCount = 1;
        return {
          socketPath: systemPipe,
          askpassEnv,
          owned: false,
          generation: agentGeneration,
        };
      }

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
        generation: agentGeneration,
      };
    } catch (error) {
      // Starter allocated a caller-specific askpass lease before launch; drop it
      // whenever startup fails so WebContents resolvers are not retained.
      releaseStarterAskpassLease();
      throw error;
    }
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

/**
 * Release one acquisition. Pass the `generation` returned by acquireFidoAgent so
 * a late close after the agent was replaced cannot decrement/kill the newer agent.
 */
function releaseFidoAgent(generation) {
  if (generation !== agentGeneration) return;
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
  const shutdown = () => {
    try { shutdownFidoAgentSubsystem(); } catch { /* ignore */ }
  };
  // Terminal/auth often runs in a utilityProcess where `app` is unavailable.
  // Use only the `exit` hook so we do not swallow SIGTERM/SIGINT default exit
  // behavior (installing those handlers without process.exit leaves workers hung).
  process.once("exit", shutdown);
  try {
    const { app } = require("electron");
    app.once("before-quit", shutdown);
    app.once("will-quit", shutdown);
  } catch {
    // non-electron / utility process
  }
}

// Best-effort install when module loads in Electron main or worker.
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
  // exposed for tests
  getTempBase,
};
