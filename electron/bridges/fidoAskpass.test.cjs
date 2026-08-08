"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyAskpassPrompt,
  buildFidoAskpassEnv,
  ensureFidoAskpass,
  shutdownFidoAskpass,
  getTempBase,
} = require("./fidoAskpass.cjs");
const fs = require("node:fs");

test("buildFidoAskpassEnv creates helper artifacts", () => {
  const env = buildFidoAskpassEnv();
  assert.ok(env.SSH_ASKPASS);
  assert.equal(env.SSH_ASKPASS_REQUIRE, "force");
  assert.ok(env.NETCATTY_FIDO_ASKPASS_SOCK);
  assert.ok(fs.existsSync(env.SSH_ASKPASS));
  const artifacts = ensureFidoAskpass();
  assert.equal(artifacts.wrapperPath, env.SSH_ASKPASS);
  shutdownFidoAskpass();
});

test("getTempBase uses Netcatty managed temp dir (no os.tmpdir fallback)", () => {
  const tempDirBridge = require("./tempDirBridge.cjs");
  const managed = tempDirBridge.getTempDir();
  assert.equal(getTempBase(), managed);
  assert.match(managed, /Netcatty/i);
});

test("classifyAskpassPrompt re-export works", () => {
  assert.equal(classifyAskpassPrompt("Enter PIN for authenticator"), "pin");
  assert.equal(classifyAskpassPrompt("Confirm user presence"), "touch");
});
