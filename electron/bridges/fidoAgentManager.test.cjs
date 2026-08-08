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
} = require("./fidoAgentManager.cjs");

test("parseAgentStdout extracts sock and pid", () => {
  const parsed = parseAgentStdout(
    "SSH_AUTH_SOCK=/tmp/agent.123; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=9999; export SSH_AGENT_PID;\n",
  );
  assert.equal(parsed.socketPath, "/tmp/agent.123");
  assert.equal(parsed.agentPid, 9999);
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
