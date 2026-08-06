import test from "node:test";
import assert from "node:assert/strict";
import {
  findSyncPayloadEncryptedCredentialPaths,
  isEncryptedCredentialPlaceholder,
  stripSyncPayloadEncryptedCredentials,
} from "./credentials.ts";
import type { SyncPayload } from "./sync.ts";

const completeBlob = Buffer.alloc(31, 0);
Buffer.from("v10", "utf8").copy(completeBlob, 0);
const ENC = `enc:v1:${completeBlob.toString("base64")}`;

function samplePayload(overrides: Partial<SyncPayload> = {}): SyncPayload {
  return {
    hosts: [
      {
        id: "h1",
        label: "prod",
        hostname: "prod.example",
        username: "root",
        password: ENC,
        port: 22,
        os: "linux",
        group: "",
        tags: [],
        protocol: "ssh",
      },
    ],
    keys: [
      {
        id: "k1",
        label: "key",
        type: "ED25519",
        privateKey: ENC,
        source: "imported",
        category: "key",
        created: 1,
      },
    ],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: 1,
    ...overrides,
  };
}

test("isEncryptedCredentialPlaceholder detects complete v10 device-bound ciphertext", () => {
  assert.equal(isEncryptedCredentialPlaceholder(ENC), true);
});

test("isEncryptedCredentialPlaceholder rejects header-only enc:v1 payloads", () => {
  assert.equal(isEncryptedCredentialPlaceholder("enc:v1:djEw"), false);
});

test("findSyncPayloadEncryptedCredentialPaths reports host and key secrets", () => {
  const paths = findSyncPayloadEncryptedCredentialPaths(samplePayload());
  assert.deepEqual(paths, ["hosts[0].password", "keys[0].privateKey"]);
});

test("stripSyncPayloadEncryptedCredentials clears device-bound placeholders for recovery", () => {
  const stripped = stripSyncPayloadEncryptedCredentials(samplePayload());
  assert.equal(stripped.hosts[0]?.password, undefined);
  assert.equal(stripped.keys[0]?.privateKey, "");
  assert.equal(findSyncPayloadEncryptedCredentialPaths(stripped).length, 0);
});
