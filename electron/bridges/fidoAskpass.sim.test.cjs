"use strict";

/**
 * Simulated FIDO askpass verification (no hardware).
 *
 * Exercises the OpenSSH SSH_ASKPASS helper → Netcatty IPC socket → prompt
 * handler → PIN response path that real ssh-sk-helper would trigger.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const {
  buildFidoAskpassEnv,
  ensureFidoAskpass,
  shutdownFidoAskpass,
  setResolveWebContentsForTests,
} = require("./fidoAskpass.cjs");
const fidoPromptHandler = require("./fidoPromptHandler.cjs");

function runAskpassHelper({ wrapperPath, socketPath, prompt, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(wrapperPath, [prompt], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NETCATTY_FIDO_ASKPASS_SOCK: socketPath,
        SSH_ASKPASS_REQUIRE: "force",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("askpass helper timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("simulated FIDO askpass returns PIN through helper subprocess", async () => {
  const pending = new Map();
  const sender = {
    id: 4242,
    isDestroyed: () => false,
    send(_channel, payload) {
      pending.set(payload.requestId, payload);
      // Auto-respond like the renderer FidoPromptModal would.
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 4242 } },
          { requestId: payload.requestId, response: "sim-pin-1234", cancelled: false },
        );
      });
    },
  };

  setResolveWebContentsForTests(() => sender);
  try {
    const env = buildFidoAskpassEnv({ resolveWebContents: () => sender });
    const artifacts = ensureFidoAskpass({ resolveWebContents: () => sender });
    assert.equal(artifacts.socketPath, env.NETCATTY_FIDO_ASKPASS_SOCK);

    // Give the listen() a tick — Node can accept before the event loop settles.
    await new Promise((r) => setTimeout(r, 50));

    const result = await runAskpassHelper({
      wrapperPath: artifacts.wrapperPath,
      socketPath: artifacts.socketPath,
      prompt: "Enter PIN for authenticator:",
    });

    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "sim-pin-1234");
    assert.ok(pending.size >= 1, "expected a prompt request to be delivered");
    const delivered = [...pending.values()][0];
    assert.equal(delivered.kind, "pin");
  } finally {
    setResolveWebContentsForTests(null);
    shutdownFidoAskpass();
  }
});

test("simulated FIDO askpass touch prompt returns empty confirmation", async () => {
  const sender = {
    id: 4243,
    isDestroyed: () => false,
    send(_channel, payload) {
      queueMicrotask(() => {
        fidoPromptHandler.handleResponse(
          { sender: { id: 4243 } },
          { requestId: payload.requestId, response: "", cancelled: false },
        );
      });
    },
  };

  setResolveWebContentsForTests(() => sender);
  try {
    const artifacts = ensureFidoAskpass({ resolveWebContents: () => sender });
    await new Promise((r) => setTimeout(r, 50));

    const result = await runAskpassHelper({
      wrapperPath: artifacts.wrapperPath,
      socketPath: artifacts.socketPath,
      prompt: "Confirm user presence for key ED25519-SK",
    });

    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "");
  } finally {
    setResolveWebContentsForTests(null);
    shutdownFidoAskpass();
  }
});
