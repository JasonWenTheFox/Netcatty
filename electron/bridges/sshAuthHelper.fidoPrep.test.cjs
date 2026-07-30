"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isFidoSkAuthOptions,
  buildFidoAwareAgentPrepOptions,
  resolvePreparedAgentSocket,
  looksLikeSkOpenSshMaterial,
} = require("./sshAuthHelper.cjs");

const skPub =
  "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= test";

test("isFidoSkAuthOptions detects public and private sk material", () => {
  assert.equal(isFidoSkAuthOptions({ agentPublicKeys: [skPub] }), true);
  assert.equal(isFidoSkAuthOptions({
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsk-ssh-ed25519@openssh.com\n-----END OPENSSH PRIVATE KEY-----",
  }), true);
  assert.equal(isFidoSkAuthOptions({ privateKey: "soft-key", useSshAgent: true }), false);
  assert.equal(looksLikeSkOpenSshMaterial(skPub), true);
});

test("buildFidoAwareAgentPrepOptions forces agent + askpass for SK keys", () => {
  const sender = { id: 1, isDestroyed: () => false };
  const prep = buildFidoAwareAgentPrepOptions({
    useSshAgent: false,
    agentPublicKeys: [skPub],
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsk-ssh-ed25519@openssh.com\n-----END OPENSSH PRIVATE KEY-----",
  }, sender);
  assert.equal(prep.useSshAgent, true);
  assert.equal(prep.useFidoAgent, true);
  assert.equal(prep.loadIdentityFilesIntoAgent, true);
  assert.equal(prep.addKeysToAgent, "yes");
  assert.equal(typeof prep.resolveWebContents, "function");
  assert.equal(prep.resolveWebContents(), sender);
});

test("buildFidoAwareAgentPrepOptions leaves soft keys alone", () => {
  const prep = buildFidoAwareAgentPrepOptions({
    useSshAgent: false,
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
  });
  assert.equal(prep.useSshAgent, false);
  assert.equal(prep.useFidoAgent, false);
});

test("resolvePreparedAgentSocket prefers agent annotation", () => {
  assert.equal(
    resolvePreparedAgentSocket({ _netcattyAgentSocket: "/tmp/fido.sock" }),
    "/tmp/fido.sock",
  );
  assert.equal(resolvePreparedAgentSocket(null), null);
});
