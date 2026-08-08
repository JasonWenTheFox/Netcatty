"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isFidoSkAuthOptions,
  buildFidoAwareAgentPrepOptions,
  enhanceAuthOptionsForFido,
  shouldUseSoftwareCertificateAgent,
  resolvePreparedAgentSocket,
  looksLikeSkOpenSshMaterial,
  identityFilesLookLikeSk,
  materializeSkPrivateKeyFile,
} = require("./sshAuthHelper.cjs");

const SK_SSH_ED25519 = "sk-ssh-ed25519@openssh.com";
const SK_ECDSA_NISTP256 = "sk-ecdsa-sha2-nistp256@openssh.com";

const skPub =
  "sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAABHNzaDo= test";

/** Real OpenSSH shape: algorithm only exists after base64 decode. */
function makeSkPrivatePem(algo) {
  const body = Buffer.from(`openssh-key-v1\0\0\0\0\0none\0\0\0\0\0\0\0\0\0\x01${algo}`).toString("base64");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(pem.includes("@openssh.com"), false, "PEM must not contain plain sk type");
  return pem;
}

test("isFidoSkAuthOptions detects public and private sk material", () => {
  assert.equal(isFidoSkAuthOptions({ agentPublicKeys: [skPub] }), true);
  assert.equal(isFidoSkAuthOptions({
    privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsk-ssh-ed25519@openssh.com\n-----END OPENSSH PRIVATE KEY-----",
  }), true);
  assert.equal(isFidoSkAuthOptions({ privateKey: "soft-key", useSshAgent: true }), false);
  assert.equal(looksLikeSkOpenSshMaterial(skPub), true);
});

test("looksLikeSkOpenSshMaterial detects base64-only sk private PEMs", () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  assert.equal(looksLikeSkOpenSshMaterial(pem), true);
  assert.equal(isFidoSkAuthOptions({ privateKey: pem }), true);
  const soft = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(looksLikeSkOpenSshMaterial(soft), false);
  assert.equal(isFidoSkAuthOptions({ privateKey: soft }), false);
});

test("materializeSkPrivateKeyFile writes base64-only sk PEM handles", async () => {
  const pem = makeSkPrivatePem(SK_ECDSA_NISTP256);
  const result = await materializeSkPrivateKeyFile(pem, {
    fs,
    os,
    path,
    tempDirBridge: { getTempDir: () => os.tmpdir() },
  });
  assert.ok(result?.keyPath, "expected materialized path for real SK PEM");
  const written = fs.readFileSync(result.keyPath, "utf8");
  assert.equal(written, pem);
  fs.rmSync(result.cleanupDir, { recursive: true, force: true });
});

test("buildFidoAwareAgentPrepOptions forces agent + askpass for base64-only SK PEMs", () => {
  const sender = { id: 1, isDestroyed: () => false };
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  const prep = buildFidoAwareAgentPrepOptions({
    useSshAgent: false,
    privateKey: pem,
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

test("identityFilesLookLikeSk peeks .pub and private handle for path-only SK keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sk-path-"));
  const keyPath = path.join(dir, "id_ed25519_sk");
  const pubPath = `${keyPath}.pub`;
  fs.writeFileSync(pubPath, skPub);
  fs.writeFileSync(keyPath, makeSkPrivatePem(SK_SSH_ED25519));
  try {
    assert.equal(await identityFilesLookLikeSk([keyPath]), true);
    assert.equal(await identityFilesLookLikeSk([pubPath]), true);
    assert.equal(await identityFilesLookLikeSk([path.join(dir, "missing")]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeSkOpenSshMaterial recognizes sk certificate public keys", () => {
  assert.equal(
    looksLikeSkOpenSshMaterial(
      "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA user",
    ),
    true,
  );
});

test("enhanceAuthOptionsForFido forces agent for path-only IdentityFile SK keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sk-enhance-"));
  const keyPath = path.join(dir, "id_ed25519_sk");
  fs.writeFileSync(`${keyPath}.pub`, skPub);
  try {
    const prep = await enhanceAuthOptionsForFido({
      useSshAgent: false,
      identityFilePaths: [keyPath],
    });
    assert.equal(prep.useSshAgent, true);
    assert.equal(prep.useFidoAgent, true);
    assert.equal(prep.loadIdentityFilesIntoAgent, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldUseSoftwareCertificateAgent is false for FIDO SK certificates", () => {
  assert.equal(
    shouldUseSoftwareCertificateAgent({ certificate: "sk-ssh-ed25519-cert-v01@openssh.com AAAA" }, true),
    false,
  );
  assert.equal(
    shouldUseSoftwareCertificateAgent({ certificate: "ssh-ed25519-cert-v01@openssh.com AAAA" }, false),
    true,
  );
});

test("materializeSkPrivateKeyFile stages companion certificate for ssh-add", async () => {
  const pem = makeSkPrivatePem(SK_SSH_ED25519);
  const cert = "sk-ssh-ed25519-cert-v01@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAA user";
  const result = await materializeSkPrivateKeyFile(pem, {
    fs,
    path,
    tempDirBridge: { getTempDir: () => os.tmpdir() },
    certificate: cert,
  });
  assert.ok(result?.keyPath);
  assert.equal(fs.readFileSync(`${result.keyPath}-cert.pub`, "utf8").trim(), cert);
  fs.rmSync(result.cleanupDir, { recursive: true, force: true });
});
