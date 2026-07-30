"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldLoadIdentityFileIntoAgent,
  publicKeyBlob,
} = require("./systemSshAgent.cjs");
const { parseKey } = require("ssh2/lib/protocol/keyParser.js");

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
