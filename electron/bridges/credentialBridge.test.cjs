const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ENC_PREFIX,
  encryptCredentialValue,
  decryptCredentialValue,
  looksLikeEncryptedCredential,
} = require("./credentialBridge.cjs");

function fakeSafeStorage({ decryptThrows = false } = {}) {
  const blobs = new Map();
  let nextId = 1;
  return {
    isEncryptionAvailable: () => true,
    encryptString(plaintext) {
      const id = `cipher-${nextId++}`;
      blobs.set(id, plaintext);
      // Mimic Chromium v10 header so base64 starts with "djEw"
      return Buffer.from(`v10:${id}:${plaintext}`, "utf8");
    },
    decryptString(buffer) {
      if (decryptThrows) throw new Error("decrypt failed");
      const decoded = Buffer.from(buffer).toString("utf8");
      if (!decoded.startsWith("v10:")) throw new Error("bad header");
      const parts = decoded.split(":");
      const id = parts[1];
      if (!blobs.has(id)) throw new Error("unknown cipher");
      return blobs.get(id);
    },
  };
}

test("looksLikeEncryptedCredential accepts v10 safeStorage payloads", () => {
  const ciphertext = Buffer.from("v10:payload", "utf8").toString("base64");
  assert.equal(looksLikeEncryptedCredential(`${ENC_PREFIX}${ciphertext}`), true);
});

test("looksLikeEncryptedCredential rejects coincidental enc:v1 prefix without safeStorage header", () => {
  assert.equal(looksLikeEncryptedCredential(`${ENC_PREFIX}not-real-ciphertext`), false);
  assert.equal(looksLikeEncryptedCredential("password"), false);
});

test("encrypt leaves undecryptable enc:v1 ciphertext unchanged instead of wrapping again", () => {
  const storage = fakeSafeStorage({ decryptThrows: true });
  const stale = `${ENC_PREFIX}${Buffer.from("v10:stale-key-material", "utf8").toString("base64")}`;
  const result = encryptCredentialValue(stale, storage);
  assert.equal(result, stale);
});

test("encrypt still encrypts coincidental plaintext that starts with enc:v1:", () => {
  const storage = fakeSafeStorage();
  const coincidence = `${ENC_PREFIX}totally-plain-password`;
  const result = encryptCredentialValue(coincidence, storage);
  assert.notEqual(result, coincidence);
  assert.ok(result.startsWith(ENC_PREFIX));
  assert.equal(decryptCredentialValue(result, storage), coincidence);
});

test("encrypt round-trips plaintext and does not double-encrypt", () => {
  const storage = fakeSafeStorage();
  const once = encryptCredentialValue("secret", storage);
  const twice = encryptCredentialValue(once, storage);
  assert.equal(twice, once);
  assert.equal(decryptCredentialValue(once, storage), "secret");
});

test("decrypt returns ciphertext unchanged when safeStorage cannot decrypt", () => {
  const storage = fakeSafeStorage({ decryptThrows: true });
  const stale = `${ENC_PREFIX}${Buffer.from("v10:stale", "utf8").toString("base64")}`;
  assert.equal(decryptCredentialValue(stale, storage), stale);
});
