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
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID } = require("node:crypto");
const { buildFidoAskpassEnv } = require("./fidoAskpass.cjs");

const execFileAsync = promisify(execFile);

/** @type {import("node:child_process").ChildProcess|null} */
let agentChild = null;
/** @type {string|null} */
let agentSocket = null;
/** @type {string|null} */
let agentDir = null;
let refCount = 0;

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

/**
 * Acquire a Netcatty FIDO agent socket. Multiple callers share one agent.
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   resolveWebContents?: () => import("electron").WebContents|null,
 *   execFile?: typeof execFileAsync,
 *   spawn?: typeof spawn,
 * }} [options]
 */
async function acquireFidoAgent(options = {}) {
  if (agentSocket && agentChild && !agentChild.killed) {
    refCount += 1;
    return {
      socketPath: agentSocket,
      askpassEnv: buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents }),
      owned: true,
    };
  }

  const run = options.execFile || execFileAsync;
  const env = options.env || process.env;
  const askpassEnv = buildFidoAskpassEnv({ resolveWebContents: options.resolveWebContents });
  const sshAgent = resolveSshAgentBinary(env);

  agentDir = path.join(getTempBase(), `netcatty-fido-agent-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const sockPath = path.join(agentDir, "agent.sock");

  // Prefer binding our own socket path so we control lifetime.
  // `ssh-agent -a path -s` prints shell exports and daemonizes.
  let stdout = "";
  try {
    const result = await run(sshAgent, ["-a", sockPath, "-s"], {
      timeout: 10000,
      windowsHide: true,
      env: {
        ...env,
        ...askpassEnv,
      },
    });
    stdout = result.stdout?.toString?.() || result.stdout || "";
  } catch (error) {
    // Fallback without -a (some builds)
    try {
      const result = await run(sshAgent, ["-s"], {
        timeout: 10000,
        windowsHide: true,
        env: { ...env, ...askpassEnv },
      });
      stdout = result.stdout?.toString?.() || result.stdout || "";
    } catch (fallbackError) {
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
    const err = new Error("ssh-agent started but SSH_AUTH_SOCK was not reported.");
    err.code = "ERR_FIDO_AGENT_SOCK";
    throw err;
  }

  // Track PID for cleanup when available.
  if (parsed.agentPid && Number.isFinite(parsed.agentPid)) {
    agentChild = { killed: false, pid: parsed.agentPid, kill() {
      try { process.kill(parsed.agentPid, "TERM"); } catch { /* ignore */ }
      this.killed = true;
    } };
  } else {
    agentChild = { killed: false, pid: 0, kill() { this.killed = true; } };
  }

  refCount = 1;
  return {
    socketPath: agentSocket,
    askpassEnv,
    owned: true,
  };
}

function releaseFidoAgent() {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;
  try {
    agentChild?.kill?.("TERM");
  } catch {
    // ignore
  }
  agentChild = null;
  agentSocket = null;
  if (agentDir) {
    fs.promises.rm(agentDir, { recursive: true, force: true }).catch(() => {});
    agentDir = null;
  }
}

function getActiveFidoAgentSocket() {
  return agentSocket;
}

module.exports = {
  acquireFidoAgent,
  releaseFidoAgent,
  getActiveFidoAgentSocket,
  resolveSshAgentBinary,
  parseAgentStdout,
};
