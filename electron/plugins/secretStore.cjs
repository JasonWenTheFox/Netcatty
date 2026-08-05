"use strict";

const { randomBytes } = require("node:crypto");

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const MAX_SECRET_BYTES = 64 * 1024;

function assertSecretKey(key) {
  if (typeof key !== "string" || key.length < 1 || key.length > 256 || key.includes("\0")) {
    throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret key is invalid");
  }
  return key;
}

function assertSecretRef(secret) {
  if (
    !secret
    || typeof secret !== "object"
    || Array.isArray(secret)
    || secret.kind !== "secret"
    || typeof secret.id !== "string"
    || secret.id.length < 16
    || secret.id.length > 256
    || typeof secret.key !== "string"
    || secret.key.length < 1
    || secret.key.length > 256
    || secret.key.includes("\0")
  ) throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret reference is invalid");
  return { id: secret.id, key: secret.key };
}

class PluginSecretStore {
  /** @type {Map<string, { value: string, secretRef: string }>} */
  #overwriteStash = new Map();

  constructor(options) {
    this.database = options.database;
    this.safeStorage = options.safeStorage ?? null;
    this.randomBytes = options.randomBytes ?? randomBytes;
  }

  #stashKey(pluginId, key) {
    return `${pluginId}\0${key}`;
  }

  #assertAvailable() {
    const backend = this.safeStorage?.getSelectedStorageBackend?.();
    if (
      !this.safeStorage?.isEncryptionAvailable?.()
      || backend === "basic_text"
      || typeof this.safeStorage.encryptString !== "function"
      || typeof this.safeStorage.decryptString !== "function"
    ) {
      throw new PluginRpcError(
        RPC_ERRORS.unavailable,
        "Secure OS-backed encryption is unavailable for plugin secrets",
      );
    }
  }

  getReference(pluginId, key) {
    assertSecretKey(key);
    const record = this.database.getSecretByKey(pluginId, key);
    return record ? Object.freeze({ kind: "secret", id: record.secretRef, key: record.key }) : undefined;
  }

  getRecordByReference(pluginId, secret) {
    const reference = assertSecretRef(secret);
    const record = this.database.getSecretByRef(pluginId, reference.id);
    if (!record || record.key !== reference.key) {
      throw new PluginRpcError(RPC_ERRORS.notFound, "Plugin secret reference was not found");
    }
    return record;
  }

  set(pluginId, key, value, options = {}) {
    this.#assertAvailable();
    assertSecretKey(key);
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Plugin secret value is invalid or too large");
    }
    const stashPrevious = options.stashPrevious === true;
    if (stashPrevious) {
      const existing = this.getReference(pluginId, key);
      if (existing) {
        try {
          this.#overwriteStash.set(this.#stashKey(pluginId, key), {
            value: this.resolve(pluginId, existing),
            // Keep the prior SecretRef id so saved provider connections still resolve.
            secretRef: existing.id,
          });
        } catch {
          /* keep going; restore may be unavailable for this key */
        }
      }
    }
    const secretRef = this.randomBytes(24).toString("base64url");
    const ciphertext = this.safeStorage.encryptString(value);
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "OS-backed plugin secret encryption failed");
    }
    this.database.upsertSecret({ pluginId, key, secretRef, ciphertext });
    return Object.freeze({ kind: "secret", id: secretRef, key });
  }

  /**
   * Restore the plaintext (and SecretRef id) stashed by the last overwrite.
   * Returns true when a stashed value was written back.
   */
  restoreOverwrite(pluginId, key) {
    this.#assertAvailable();
    assertSecretKey(key);
    const stashKey = this.#stashKey(pluginId, key);
    const previous = this.#overwriteStash.get(stashKey);
    if (!previous || typeof previous.value !== "string" || typeof previous.secretRef !== "string") {
      return false;
    }
    this.#overwriteStash.delete(stashKey);
    const ciphertext = this.safeStorage.encryptString(previous.value);
    if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength < 1) {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "OS-backed plugin secret encryption failed");
    }
    this.database.upsertSecret({
      pluginId,
      key,
      secretRef: previous.secretRef,
      ciphertext,
    });
    return true;
  }

  clearOverwriteStash(pluginId, key) {
    assertSecretKey(key);
    this.#overwriteStash.delete(this.#stashKey(pluginId, key));
  }

  delete(pluginId, key) {
    assertSecretKey(key);
    this.#overwriteStash.delete(this.#stashKey(pluginId, key));
    this.database.deleteSecret(pluginId, key);
  }

  deleteByKeyPrefix(pluginId, prefix) {
    assertSecretKey(prefix);
    if (typeof this.database.deleteSecretsByKeyPrefix !== "function") {
      this.delete(pluginId, prefix);
      return 1;
    }
    return this.database.deleteSecretsByKeyPrefix(pluginId, prefix);
  }

  /**
   * Durable providerId → pluginId binding so disconnect can wipe sync secrets
   * after the contribution disappears (disabled/uninstalled plugin).
   */
  syncProviderBindingKey(providerId) {
    return `sync-provider-map:${assertSecretKey(providerId)}`;
  }

  bindSyncProviderPlugin(pluginId, providerId) {
    const key = this.syncProviderBindingKey(providerId);
    if (this.getReference(pluginId, key)) return;
    this.set(pluginId, key, pluginId);
  }

  resolveSyncProviderPlugin(providerId) {
    const key = this.syncProviderBindingKey(providerId);
    if (typeof this.database.findSecretsByKey === "function") {
      const rows = this.database.findSecretsByKey(key);
      const pluginId = rows?.[0]?.pluginId;
      return typeof pluginId === "string" && pluginId.length > 0 ? pluginId : undefined;
    }
    return undefined;
  }

  unbindSyncProviderPlugin(pluginId, providerId) {
    try {
      this.delete(pluginId, this.syncProviderBindingKey(providerId));
    } catch {
      /* ignore missing binding */
    }
  }

  resolve(pluginId, secret) {
    this.#assertAvailable();
    const record = this.getRecordByReference(pluginId, secret);
    try {
      return this.safeStorage.decryptString(record.ciphertext);
    } catch {
      throw new PluginRpcError(RPC_ERRORS.dataLoss, "Plugin secret could not be decrypted");
    }
  }
}

module.exports = {
  MAX_SECRET_BYTES,
  PluginSecretStore,
  assertSecretKey,
  assertSecretRef,
};
