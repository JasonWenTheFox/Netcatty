"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldLoadIdentityFileIntoAgent,
  publicKeyBlob,
} = require("./systemSshAgent.cjs");
const { parseKey } = require("ssh2/lib/protocol/keyParser.js");

const SK_SSH_ED25519 = "sk-ssh-ed25519@openssh.com";

function makeSkPrivatePem() {
  const body = Buffer.from(`openssh-key-v1\0\0\0\0\0none\0\0\0\0\0\0\0\0\0\x01${SK_SSH_ED25519}`).toString("base64");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(pem.includes("@openssh.com"), false);
  return pem;
}

test("shouldLoadIdentityFileIntoAgent loads sk public keys", async () => {
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 3);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;

  const files = {
    "/tmp/id_ed25519_sk.pub": pubLine,
  };
  const deps = {
    readFile: async (p) => {
      if (files[p] !== undefined) return files[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };

  assert.equal(
    await shouldLoadIdentityFileIntoAgent("/tmp/id_ed25519_sk", {}, deps),
    true,
  );
  assert.equal(
    await shouldLoadIdentityFileIntoAgent("/tmp/id_ed25519_sk", { addKeysToAgent: "yes" }, deps),
    true,
  );
  assert.equal(
    await shouldLoadIdentityFileIntoAgent(
      "/tmp/soft",
      {},
      {
        readFile: async () => "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJust soft",
      },
    ),
    false,
  );

  const parsed = parseKey(pubLine);
  assert.equal(parsed instanceof Error, false);
  assert.ok(publicKeyBlob(parsed));
});

test("shouldLoadIdentityFileIntoAgent detects base64-only sk private PEMs", async () => {
  const pem = makeSkPrivatePem();
  const deps = {
    readFile: async (p) => {
      if (p === "/tmp/id_ed25519_sk" || p.endsWith("/id_ed25519_sk")) return pem;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  };
  assert.equal(
    await shouldLoadIdentityFileIntoAgent("/tmp/id_ed25519_sk", {}, deps),
    true,
  );
});

test("prepareSystemSshAgent tracks newly loaded identities for shared-agent cleanup", async () => {
  const { prepareSystemSshAgent } = require("./systemSshAgent.cjs");
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 3);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;
  const identityPath = "/tmp/id_ed25519_sk_new";
  const sshAddCalls = [];

  const fakeAgent = {
    getIdentities: (cb) => cb(null, []),
    sign: (_key, _data, _opts, cb) => cb(new Error("unused")),
  };

  const prepared = await prepareSystemSshAgent({
    socketPath: "/tmp/fake-agent.sock",
    identityFilePaths: [identityPath],
    loadIdentityFilesIntoAgent: true,
  }, {
    createAgent: () => fakeAgent,
    readFile: async (p) => {
      if (p === `${identityPath}.pub`) return pubLine;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    runSshAdd: async (args) => { sshAddCalls.push(args); },
    platform: "win32",
  });

  assert.deepEqual(sshAddCalls, [[identityPath]]);
  assert.deepEqual(prepared._netcattyNewlyLoadedIdentityPaths, [identityPath]);
  assert.deepEqual(prepared._netcattySharedAgentIdentities, [
    { key: publicKeyBlob(pubLine), identityPath },
  ]);
});

test("prepareSystemSshAgent does not mark already-loaded identities as newly loaded", async () => {
  const { prepareSystemSshAgent, publicKeyBlob } = require("./systemSshAgent.cjs");
  const type = Buffer.from("sk-ssh-ed25519@openssh.com");
  const pub = Buffer.alloc(32, 7);
  const app = Buffer.from("ssh:");
  const parts = [type, pub, app];
  let len = 0;
  for (const part of parts) len += 4 + part.length;
  const buf = Buffer.alloc(len);
  let offset = 0;
  for (const part of parts) {
    buf.writeUInt32BE(part.length, offset);
    offset += 4;
    part.copy(buf, offset);
    offset += part.length;
  }
  const pubLine = `sk-ssh-ed25519@openssh.com ${buf.toString("base64")} test`;
  const identityPath = "/tmp/id_ed25519_sk_existing";
  const blob = publicKeyBlob(pubLine);
  const sshAddCalls = [];

  const fakeKey = {
    getPublicSSH: () => Buffer.from(blob, "base64"),
  };
  const fakeAgent = {
    getIdentities: (cb) => cb(null, [fakeKey]),
    sign: (_key, _data, _opts, cb) => cb(new Error("unused")),
  };

  const prepared = await prepareSystemSshAgent({
    socketPath: "/tmp/fake-agent.sock",
    identityFilePaths: [identityPath],
    loadIdentityFilesIntoAgent: true,
  }, {
    createAgent: () => fakeAgent,
    readFile: async (p) => {
      if (p === `${identityPath}.pub`) return pubLine;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    runSshAdd: async (args) => { sshAddCalls.push(args); },
    platform: "win32",
  });

  assert.deepEqual(sshAddCalls, []);
  assert.equal(prepared._netcattyNewlyLoadedIdentityPaths, undefined);
  assert.deepEqual(prepared._netcattySharedAgentIdentities, [
    { key: blob, identityPath },
  ]);
});

test("retainSharedAgentIdentity reference-counts identical public identities", () => {
  const {
    retainSharedAgentIdentity,
    releaseSharedAgentIdentity,
    resetSharedAgentIdentityRefsForTests,
  } = require("./systemSshAgent.cjs");
  resetSharedAgentIdentityRefsForTests();
  try {
    retainSharedAgentIdentity("blob-1", "/tmp/a");
    retainSharedAgentIdentity("blob-1", "/tmp/b");
    assert.deepEqual(releaseSharedAgentIdentity("blob-1"), {
      shouldRemove: false,
      identityPath: "/tmp/a",
      cleanupDir: null,
    });
    assert.deepEqual(releaseSharedAgentIdentity("blob-1"), {
      shouldRemove: true,
      identityPath: "/tmp/a",
      cleanupDir: null,
    });
  } finally {
    resetSharedAgentIdentityRefsForTests();
  }
});
