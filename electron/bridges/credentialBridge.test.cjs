const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ENC_PREFIX,
  MIN_V10_V11_CIPHERTEXT_BYTES,
  MIN_DPAPI_CIPHERTEXT_BYTES,
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
      // Pad to a complete CBC-sized blob (header + one AES block).
      const body = Buffer.alloc(MIN_V10_V11_CIPHERTEXT_BYTES, 0);
      Buffer.from("v10", "utf8").copy(body, 0);
      Buffer.from(id, "utf8").copy(body, 3);
      blobs.set(body.toString("base64"), plaintext);
      return body;
    },
    decryptString(buffer) {
      if (decryptThrows) throw new Error("decrypt failed");
      const key = Buffer.from(buffer).toString("base64");
      if (!blobs.has(key)) throw new Error("unknown cipher");
      return blobs.get(key);
    },
  };
}

function completeCiphertextPlaceholder(seed = "stale-key-material") {
  const body = Buffer.alloc(MIN_V10_V11_CIPHERTEXT_BYTES, 0);
  Buffer.from("v10", "utf8").copy(body, 0);
  Buffer.from(seed, "utf8").copy(body, 3);
  return `${ENC_PREFIX}${body.toString("base64")}`;
}

test("looksLikeEncryptedCredential accepts complete CBC-sized v10 payloads", () => {
  assert.equal(looksLikeEncryptedCredential(completeCiphertextPlaceholder()), true);
});

test("looksLikeEncryptedCredential accepts real Windows DPAPI base64 prefixes", () => {
  // 01 00 00 00 d0 8c ... encodes as AQAAANCM..., not AQAAAA...
  const body = Buffer.alloc(MIN_DPAPI_CIPHERTEXT_BYTES, 0);
  body[0] = 0x01;
  body[4] = 0xd0;
  body[5] = 0x8c;
  const encoded = body.toString("base64");
  assert.equal(encoded.startsWith("AQAAANCM"), true);
  assert.equal(encoded.startsWith("AQAAAA"), false);
  assert.equal(looksLikeEncryptedCredential(`${ENC_PREFIX}${encoded}`), true);
});

test("looksLikeEncryptedCredential rejects header-only enc:v1 payloads", () => {
  assert.equal(looksLikeEncryptedCredential(`${ENC_PREFIX}djEw`), false);
  assert.equal(looksLikeEncryptedCredential(`${ENC_PREFIX}not-real-ciphertext`), false);
  assert.equal(looksLikeEncryptedCredential("password"), false);
});

test("encrypt leaves undecryptable DPAPI enc:v1 ciphertext unchanged", () => {
  const storage = fakeSafeStorage({ decryptThrows: true });
  const body = Buffer.alloc(MIN_DPAPI_CIPHERTEXT_BYTES, 0);
  body[0] = 0x01;
  body[4] = 0xd0;
  body[5] = 0x8c;
  const stale = `${ENC_PREFIX}${body.toString("base64")}`;
  assert.equal(encryptCredentialValue(stale, storage), stale);
});

test("encrypt leaves undecryptable complete enc:v1 ciphertext unchanged instead of wrapping again", () => {
  const storage = fakeSafeStorage({ decryptThrows: true });
  const stale = completeCiphertextPlaceholder("stale-key-material");
  const result = encryptCredentialValue(stale, storage);
  assert.equal(result, stale);
});

test("encrypt encrypts header-only enc:v1 coincidence instead of leaving it plaintext", () => {
  const storage = fakeSafeStorage();
  const coincidence = `${ENC_PREFIX}djEw`;
  const result = encryptCredentialValue(coincidence, storage);
  assert.notEqual(result, coincidence);
  assert.ok(result.startsWith(ENC_PREFIX));
  assert.equal(decryptCredentialValue(result, storage), coincidence);
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
  const stale = completeCiphertextPlaceholder("stale");
  assert.equal(decryptCredentialValue(stale, storage), stale);
});
