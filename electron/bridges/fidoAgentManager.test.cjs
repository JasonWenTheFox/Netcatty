"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAgentStdout,
  isAgentLive,
  releaseFidoAgent,
  getActiveFidoAgentSocket,
  shutdownFidoAgentSubsystem,
  acquireFidoAgent,
  getTempBase,
} = require("./fidoAgentManager.cjs");

test("parseAgentStdout extracts sock and pid", () => {
  const parsed = parseAgentStdout(
    "SSH_AUTH_SOCK=/tmp/agent.123; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=9999; export SSH_AGENT_PID;\n",
  );
  assert.equal(parsed.socketPath, "/tmp/agent.123");
  assert.equal(parsed.agentPid, 9999);
});

test("getTempBase uses Netcatty managed temp dir (no os.tmpdir fallback)", () => {
  const tempDirBridge = require("./tempDirBridge.cjs");
  const managed = tempDirBridge.getTempDir();
  assert.equal(getTempBase(), managed);
  assert.match(managed, /Netcatty/i);
});

test("release without acquire is safe", () => {
  releaseFidoAgent();
  releaseFidoAgent();
  assert.equal(getActiveFidoAgentSocket(), null);
  assert.equal(isAgentLive(), false);
  shutdownFidoAgentSubsystem();
});

test("acquireFidoAgent on win32 reuses the system OpenSSH named pipe", async () => {
  const agent = await acquireFidoAgent({
    platform: "win32",
    resolveWebContents: () => null,
    execFile: async () => {
      throw new Error("ssh-agent -a must not run on win32");
    },
  });
  assert.equal(agent.socketPath, "\\\\.\\pipe\\openssh-ssh-agent");
  assert.equal(agent.owned, false);
  assert.ok(agent.askpassEnv?.SSH_ASKPASS);
  shutdownFidoAgentSubsystem();
});

test("acquireFidoAgent releases askpass lease when agent start fails", async () => {
  shutdownFidoAgentSubsystem();
  const fs = require("node:fs");
  const path = require("node:path");
  const tempDirBridge = require("./tempDirBridge.cjs");
  const { getAskpassLeaseCountForTests } = require("./fidoAskpass.cjs");
  const managedTemp = fs.mkdtempSync(path.join(__dirname, "netcatty-fido-lease-"));
  const originalGetTempDir = tempDirBridge.getTempDir;
  tempDirBridge.getTempDir = () => managedTemp;
  const before = getAskpassLeaseCountForTests();
  try {
    await assert.rejects(
      () => acquireFidoAgent({
        platform: "linux",
        resolveWebContents: () => ({ id: "fail-start" }),
        env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
        execFile: async () => {
          throw new Error("ssh-agent missing");
        },
      }),
      (error) => error?.code === "ERR_FIDO_AGENT_START",
    );
    assert.equal(getAskpassLeaseCountForTests(), before);
  } finally {
    tempDirBridge.getTempDir = originalGetTempDir;
    shutdownFidoAgentSubsystem();
    fs.rmSync(managedTemp, { recursive: true, force: true });
  }
});

test("concurrent acquireFidoAgent returns a fresh askpass lease per caller", async () => {
  shutdownFidoAgentSubsystem();
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { releaseFidoAskpassLease } = require("./fidoAskpass.cjs");
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-fido-sock-"));
  const sockPath = path.join(sockDir, "agent.sock");
  fs.writeFileSync(sockPath, "");
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });

  try {
    const first = acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "first" }),
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => {
        releaseStart();
        await new Promise((r) => setTimeout(r, 80));
        return {
          stdout: `SSH_AUTH_SOCK=${sockPath}; export SSH_AUTH_SOCK;\n`,
        };
      },
    });

    await startGate;
    const second = acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "second" }),
      execFile: async () => {
        throw new Error("second caller must await startingPromise");
      },
    });

    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.socketPath, sockPath);
    assert.equal(b.socketPath, sockPath);
    assert.notEqual(
      a.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE,
      b.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE,
    );
    releaseFidoAskpassLease(a.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAskpassLease(b.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAgent(a.generation);
    releaseFidoAgent(b.generation);
  } finally {
    shutdownFidoAgentSubsystem();
    fs.rmSync(sockDir, { recursive: true, force: true });
  }
});

test("stale releaseFidoAgent ignores a newer agent generation", async () => {
  shutdownFidoAgentSubsystem();
  const fs = require("node:fs");
  const path = require("node:path");
  const tempDirBridge = require("./tempDirBridge.cjs");
  const { releaseFidoAskpassLease } = require("./fidoAskpass.cjs");
  const managedTemp = fs.mkdtempSync(path.join(__dirname, "netcatty-fido-gen-"));
  const originalGetTempDir = tempDirBridge.getTempDir;
  tempDirBridge.getTempDir = () => managedTemp;
  const firstSock = path.join(managedTemp, "agent1.sock");
  const secondSock = path.join(managedTemp, "agent2.sock");
  fs.writeFileSync(firstSock, "");
  fs.writeFileSync(secondSock, "");

  try {
    const first = await acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "gen-first" }),
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => ({
        stdout: `SSH_AUTH_SOCK=${firstSock}; export SSH_AUTH_SOCK;\n`,
      }),
    });
    assert.equal(getActiveFidoAgentSocket(), firstSock);

    // Simulate the managed agent dying while a connection still holds a release.
    fs.rmSync(firstSock, { force: true });
    assert.equal(isAgentLive(), false);

    const second = await acquireFidoAgent({
      platform: "linux",
      resolveWebContents: () => ({ id: "gen-second" }),
      env: { PATH: process.env.PATH || "/usr/bin:/bin", NETCATTY_SSH_AGENT_PATH: "/bin/true" },
      execFile: async () => ({
        stdout: `SSH_AUTH_SOCK=${secondSock}; export SSH_AUTH_SOCK;\n`,
      }),
    });
    assert.notEqual(first.generation, second.generation);
    assert.equal(getActiveFidoAgentSocket(), secondSock);

    // Late close of the old connection must not kill the replacement agent.
    releaseFidoAgent(first.generation);
    assert.equal(getActiveFidoAgentSocket(), secondSock);
    assert.equal(isAgentLive(), true);

    releaseFidoAskpassLease(first.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAskpassLease(second.askpassEnv.NETCATTY_FIDO_ASKPASS_LEASE);
    releaseFidoAgent(second.generation);
    assert.equal(getActiveFidoAgentSocket(), null);
  } finally {
    tempDirBridge.getTempDir = originalGetTempDir;
    shutdownFidoAgentSubsystem();
    fs.rmSync(managedTemp, { recursive: true, force: true });
  }
});
