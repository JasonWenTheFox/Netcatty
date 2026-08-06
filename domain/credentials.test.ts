import test from "node:test";
import assert from "node:assert/strict";
import {
  findSyncPayloadEncryptedCredentialPaths,
  healPoisonedSecretsForMerge,
  isEncryptedCredentialPlaceholder,
  stripSyncPayloadEncryptedCredentials,
} from "./credentials.ts";
import type { SyncPayload } from "./sync.ts";

const completeBlob = Buffer.alloc(19, 0);
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

test("healPoisonedSecretsForMerge keeps usable preferred passwords over poisoned enc:v1", () => {
  const poisoned = samplePayload();
  const preferred = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      password: "preferred-secret",
    }],
    keys: [{
      ...samplePayload().keys[0]!,
      privateKey: "PREFERRED_PRIVATE_KEY",
    }],
  });
  const fallback = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      password: "base-secret",
    }],
  });
  const healed = healPoisonedSecretsForMerge(poisoned, preferred, fallback);
  assert.equal(healed.hosts[0]?.password, "preferred-secret");
  assert.equal(healed.keys[0]?.privateKey, "PREFERRED_PRIVATE_KEY");
});

test("healPoisonedSecretsForMerge heals local poison from remote then base", () => {
  const local = samplePayload();
  const remote = samplePayload({
    hosts: [{
      ...samplePayload().hosts[0]!,
      password: "remote-secret",
    }],
    keys: [{
      ...samplePayload().keys[0]!,
      privateKey: ENC,
    }],
  });
  const base = samplePayload({
    keys: [{
      ...samplePayload().keys[0]!,
      privateKey: "BASE_PRIVATE_KEY",
    }],
  });
  const healed = healPoisonedSecretsForMerge(local, remote, base);
  assert.equal(healed.hosts[0]?.password, "remote-secret");
  assert.equal(healed.keys[0]?.privateKey, "BASE_PRIVATE_KEY");
});
