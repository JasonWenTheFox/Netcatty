/**
 * Credential Bridge - Field-level encryption for sensitive data at rest
 *
 * Uses Electron's safeStorage API to encrypt individual sensitive fields
 * (passwords, tokens, private keys) before they are persisted to localStorage.
 *
 * Sentinel prefix "enc:v1:" on encrypted values enables:
 * - Detection of already-encrypted vs plaintext (migration)
 * - No double-encryption
 * - Future re-keying with enc:v2: etc.
 *
 * When safeStorage is unavailable (e.g. Linux without libsecret), all values
 * pass through unmodified so the app still works.
 */

const ENC_PREFIX = "enc:v1:";

/**
 * Chromium/Electron safeStorage ciphertext carries known platform headers:
 * - macOS/Linux: plaintext bytes start with "v10" or "v11"
 * - Windows (legacy DPAPI blob): leading bytes are 0x01 0x00 0x00 0x00
 *
 * Keep in sync with domain/credentials.ts.
 */
const SAFE_STORAGE_BASE64_HEADER_PREFIXES = [
  "djEw", // "v10"
  "djEx", // "v11"
  "AQAAAA", // 0x01 0x00 0x00 0x00 (DPAPI blob header)
];

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

let safeStorage = null;

function looksLikeEncryptedCredential(value) {
  if (typeof value !== "string" || !value.startsWith(ENC_PREFIX)) {
    return false;
  }
  const payload = value.slice(ENC_PREFIX.length);
  if (!payload || !BASE64_RE.test(payload)) return false;
  return SAFE_STORAGE_BASE64_HEADER_PREFIXES.some((prefix) => payload.startsWith(prefix));
}

/**
 * Encrypt a credential field. Never wraps an existing device-bound enc:v1
 * blob again — even when trial decrypt fails (e.g. OSCrypt key rotated).
 * Re-encrypting undecryptable ciphertext permanently poisons local vault and
 * can leak into cloud sync.
 *
 * @param {string} plaintext
 * @param {{ isEncryptionAvailable?: () => boolean, encryptString?: (v: string) => Buffer, decryptString?: (b: Buffer) => string } | null} storage
 */
function encryptCredentialValue(plaintext, storage = safeStorage) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    return plaintext ?? "";
  }
  if (!storage?.isEncryptionAvailable?.()) {
    return plaintext;
  }

  // Real device-bound ciphertext: return as-is. Do not trial-decrypt then
  // fall through to encryptString — that double-wraps when decrypt fails.
  if (looksLikeEncryptedCredential(plaintext)) {
    return plaintext;
  }

  try {
    const encrypted = storage.encryptString(plaintext);
    return ENC_PREFIX + encrypted.toString("base64");
  } catch (err) {
    console.warn("[Credentials] encrypt failed, returning plaintext:", err?.message || err);
    return plaintext;
  }
}

/**
 * Decrypt a credential field. On failure returns the ciphertext unchanged so
 * callers can detect enc:v1 placeholders via looksLikeEncryptedCredential /
 * isEncryptedCredentialPlaceholder.
 *
 * @param {string} value
 * @param {{ isEncryptionAvailable?: () => boolean, decryptString?: (b: Buffer) => string } | null} storage
 */
function decryptCredentialValue(value, storage = safeStorage) {
  if (typeof value !== "string" || value.length === 0) {
    return value ?? "";
  }
  if (!value.startsWith(ENC_PREFIX)) {
    return value;
  }
  if (!storage?.isEncryptionAvailable?.()) {
    return value;
  }
  try {
    const base64 = value.slice(ENC_PREFIX.length);
    const buf = Buffer.from(base64, "base64");
    return storage.decryptString(buf);
  } catch (err) {
    console.warn("[Credentials] decrypt failed:", err?.message || err);
    return value;
  }
}

/**
 * Register IPC handlers for credential encryption/decryption
 * @param {Electron.IpcMain} ipcMain
 * @param {typeof Electron} electronModule
 */
function registerHandlers(ipcMain, electronModule) {
  safeStorage = electronModule?.safeStorage ?? null;

  ipcMain.handle("netcatty:credentials:available", () => {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  });

  ipcMain.handle("netcatty:credentials:encrypt", (_event, plaintext) => {
    return encryptCredentialValue(plaintext, safeStorage);
  });

  ipcMain.handle("netcatty:credentials:decrypt", (_event, value) => {
    return decryptCredentialValue(value, safeStorage);
  });
}

module.exports = {
  ENC_PREFIX,
  looksLikeEncryptedCredential,
  encryptCredentialValue,
  decryptCredentialValue,
  registerHandlers,
};
