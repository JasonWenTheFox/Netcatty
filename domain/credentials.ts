import type { SyncPayload } from "./sync";

const CREDENTIAL_ENCRYPTION_PREFIX = "enc:v1:";

/**
 * Base64 pattern: only allows A-Z, a-z, 0-9, +, / and trailing = padding.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

/**
 * Chromium/Electron safeStorage ciphertext carries known platform headers:
 * - macOS/Linux: plaintext bytes start with "v10" or "v11"
 * - Windows (legacy DPAPI blob): leading bytes are 0x01 0x00 0x00 0x00
 *
 * We require a known header AND a complete-enough decoded blob. v10/v11 CBC
 * blobs are at least header(3) + one AES block(16) = 19 bytes. Header-only
 * base64 such as `enc:v1:djEw` must not be treated as ciphertext.
 *
 * Keep in sync with electron/bridges/credentialBridge.cjs.
 *
 * References:
 * - components/os_crypt/sync/os_crypt_mac.mm (kObfuscationPrefixV10 = "v10")
 * - components/os_crypt/sync/os_crypt_linux.cc (kObfuscationPrefixV10/V11)
 * - components/os_crypt/sync/os_crypt_win.cc (DPAPI legacy path)
 */
const SAFE_STORAGE_BASE64_HEADER_PREFIXES = [
  "djEw", // "v10"
  "djEx", // "v11"
  "AQAAAA", // 0x01 0x00 0x00 0x00 (DPAPI blob header)
] as const;

/** Minimum decoded sizes for complete Chromium OSCrypt blobs. */
const MIN_V10_V11_CIPHERTEXT_BYTES = 19; // CBC: header(3) + one AES block(16)
const MIN_DPAPI_CIPHERTEXT_BYTES = 20; // header(4) + protected payload

/**
 * Renderer-safe base64 decode length. Avoids Node `Buffer` which is unavailable
 * in Electron windows with `nodeIntegration: false`.
 */
const decodedBase64ByteLength = (payload: string): number => {
  try {
    if (typeof atob === "function") {
      return atob(payload).length;
    }
  } catch {
    // fall through
  }
  // Node / test environments without atob.
  if (typeof Buffer !== "undefined") {
    try {
      return Buffer.from(payload, "base64").byteLength;
    } catch {
      return 0;
    }
  }
  return 0;
};

const minimumCiphertextBytesForPayload = (payload: string): number => {
  if (payload.startsWith("AQAAAA")) return MIN_DPAPI_CIPHERTEXT_BYTES;
  return MIN_V10_V11_CIPHERTEXT_BYTES;
};

export const isEncryptedCredentialPlaceholder = (
  value: string | undefined | null,
): value is string => {
  if (typeof value !== "string" || !value.startsWith(CREDENTIAL_ENCRYPTION_PREFIX)) {
    return false;
  }
  const payload = value.slice(CREDENTIAL_ENCRYPTION_PREFIX.length);
  if (!payload || !BASE64_RE.test(payload)) return false;
  if (!SAFE_STORAGE_BASE64_HEADER_PREFIXES.some((prefix) => payload.startsWith(prefix))) {
    return false;
  }
  return decodedBase64ByteLength(payload) >= minimumCiphertextBytesForPayload(payload);
};

/**
 * Strip enc:v1: placeholders from a single credential value.
 * Used at the terminal connection boundary to avoid sending encrypted
 * placeholders as actual passwords to SSH/Telnet servers.
 */
export const sanitizeCredentialValue = (
  value: string | undefined,
): string | undefined => {
  if (isEncryptedCredentialPlaceholder(value)) return undefined;
  return value;
};

/**
 * Scan a sync payload for any fields that still carry device-bound
 * enc:v1: ciphertext.  Returns the dotted paths of offending fields.
 * Used as a pre-upload guard to prevent pushing un-decryptable data.
 */
export const findSyncPayloadEncryptedCredentialPaths = (
  payload: SyncPayload,
): string[] => {
  const issues: string[] = [];

  payload.hosts.forEach((host, index) => {
    if (isEncryptedCredentialPlaceholder(host.password)) {
      issues.push(`hosts[${index}].password`);
    }
    if (isEncryptedCredentialPlaceholder(host.telnetPassword)) {
      issues.push(`hosts[${index}].telnetPassword`);
    }
    if (isEncryptedCredentialPlaceholder(host.proxyConfig?.password)) {
      issues.push(`hosts[${index}].proxyConfig.password`);
    }
  });

  payload.keys.forEach((key, index) => {
    if (isEncryptedCredentialPlaceholder(key.privateKey)) {
      issues.push(`keys[${index}].privateKey`);
    }
    if (isEncryptedCredentialPlaceholder(key.passphrase)) {
      issues.push(`keys[${index}].passphrase`);
    }
  });

  payload.identities?.forEach((identity, index) => {
    if (isEncryptedCredentialPlaceholder(identity.password)) {
      issues.push(`identities[${index}].password`);
    }
  });

  payload.proxyProfiles?.forEach((profile, index) => {
    if (isEncryptedCredentialPlaceholder(profile.config.password)) {
      issues.push(`proxyProfiles[${index}].config.password`);
    }
  });

  payload.groupConfigs?.forEach((config, index) => {
    if (isEncryptedCredentialPlaceholder(config.password)) {
      issues.push(`groupConfigs[${index}].password`);
    }
    if (isEncryptedCredentialPlaceholder(config.telnetPassword)) {
      issues.push(`groupConfigs[${index}].telnetPassword`);
    }
    if (isEncryptedCredentialPlaceholder(config.proxyConfig?.password)) {
      issues.push(`groupConfigs[${index}].proxyConfig.password`);
    }
  });

  return issues;
};

/**
 * Clear device-bound enc:v1 placeholders from a portable sync payload.
 *
 * Cloud / backup payloads must carry plaintext secrets (protected by the
 * master key envelope). If a previous bug uploaded undecryptable local
 * ciphertext, stripping placeholders lets download restore a usable vault
 * shell so the user can re-enter credentials instead of looping forever.
 */
export const stripSyncPayloadEncryptedCredentials = (
  payload: SyncPayload,
): SyncPayload => {
  const hosts = payload.hosts.map((host) => {
    const next = { ...host };
    if (isEncryptedCredentialPlaceholder(next.password)) delete next.password;
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) delete next.telnetPassword;
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const { password: _removed, ...proxyRest } = next.proxyConfig;
      next.proxyConfig = proxyRest;
    }
    return next;
  });

  const keys = payload.keys.map((key) => {
    const next = { ...key };
    if (isEncryptedCredentialPlaceholder(next.privateKey)) next.privateKey = "";
    if (isEncryptedCredentialPlaceholder(next.passphrase)) delete next.passphrase;
    return next;
  });

  const identities = payload.identities?.map((identity) => {
    if (!isEncryptedCredentialPlaceholder(identity.password)) return identity;
    const next = { ...identity };
    delete next.password;
    return next;
  });

  const proxyProfiles = payload.proxyProfiles?.map((profile) => {
    if (!isEncryptedCredentialPlaceholder(profile.config.password)) return profile;
    const { password: _removed, ...configRest } = profile.config;
    return { ...profile, config: configRest };
  });

  const groupConfigs = payload.groupConfigs?.map((config) => {
    const next = { ...config };
    if (isEncryptedCredentialPlaceholder(next.password)) delete next.password;
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) delete next.telnetPassword;
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const { password: _removed, ...proxyRest } = next.proxyConfig;
      next.proxyConfig = proxyRest;
    }
    return next;
  });

  return {
    ...payload,
    hosts,
    keys,
    identities: identities ?? payload.identities,
    proxyProfiles: proxyProfiles ?? payload.proxyProfiles,
    groupConfigs: groupConfigs ?? payload.groupConfigs,
  };
};

const usableCredential = (value: string | undefined): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (isEncryptedCredentialPlaceholder(value)) return undefined;
  return value;
};

const pickUsableCredential = (
  ...candidates: Array<string | undefined>
): string | undefined => {
  for (const candidate of candidates) {
    const usable = usableCredential(candidate);
    if (usable !== undefined) return usable;
  }
  return undefined;
};

/**
 * Before three-way merge, replace device-bound enc:v1 secrets on the remote
 * snapshot with usable local/base values when available. Stripping those
 * fields to undefined would make merge treat them as remote-only deletions of
 * good secrets. Final upload still runs stripSyncPayloadEncryptedCredentials.
 */
export const healPoisonedRemoteSecretsForMerge = (
  remote: SyncPayload,
  local: SyncPayload,
  base: SyncPayload | null | undefined,
): SyncPayload => {
  const localHosts = new Map(local.hosts.map((host) => [host.id, host]));
  const baseHosts = new Map((base?.hosts ?? []).map((host) => [host.id, host]));
  const hosts = remote.hosts.map((host) => {
    const localHost = localHosts.get(host.id);
    const baseHost = baseHosts.get(host.id);
    const next = { ...host };
    if (isEncryptedCredentialPlaceholder(next.password)) {
      const healed = pickUsableCredential(localHost?.password, baseHost?.password);
      if (healed !== undefined) next.password = healed;
      else delete next.password;
    }
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) {
      const healed = pickUsableCredential(localHost?.telnetPassword, baseHost?.telnetPassword);
      if (healed !== undefined) next.telnetPassword = healed;
      else delete next.telnetPassword;
    }
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const healed = pickUsableCredential(
        localHost?.proxyConfig?.password,
        baseHost?.proxyConfig?.password,
      );
      if (healed !== undefined) {
        next.proxyConfig = { ...next.proxyConfig, password: healed };
      } else {
        const { password: _removed, ...proxyRest } = next.proxyConfig;
        next.proxyConfig = proxyRest;
      }
    }
    return next;
  });

  const localKeys = new Map(local.keys.map((key) => [key.id, key]));
  const baseKeys = new Map((base?.keys ?? []).map((key) => [key.id, key]));
  const keys = remote.keys.map((key) => {
    const localKey = localKeys.get(key.id);
    const baseKey = baseKeys.get(key.id);
    const next = { ...key };
    if (isEncryptedCredentialPlaceholder(next.privateKey)) {
      next.privateKey = pickUsableCredential(localKey?.privateKey, baseKey?.privateKey) ?? "";
    }
    if (isEncryptedCredentialPlaceholder(next.passphrase)) {
      const healed = pickUsableCredential(localKey?.passphrase, baseKey?.passphrase);
      if (healed !== undefined) next.passphrase = healed;
      else delete next.passphrase;
    }
    return next;
  });

  const localIdentities = new Map((local.identities ?? []).map((identity) => [identity.id, identity]));
  const baseIdentities = new Map((base?.identities ?? []).map((identity) => [identity.id, identity]));
  const identities = remote.identities?.map((identity) => {
    if (!isEncryptedCredentialPlaceholder(identity.password)) return identity;
    const healed = pickUsableCredential(
      localIdentities.get(identity.id)?.password,
      baseIdentities.get(identity.id)?.password,
    );
    if (healed !== undefined) return { ...identity, password: healed };
    const next = { ...identity };
    delete next.password;
    return next;
  });

  const localProfiles = new Map((local.proxyProfiles ?? []).map((profile) => [profile.id, profile]));
  const baseProfiles = new Map((base?.proxyProfiles ?? []).map((profile) => [profile.id, profile]));
  const proxyProfiles = remote.proxyProfiles?.map((profile) => {
    if (!isEncryptedCredentialPlaceholder(profile.config.password)) return profile;
    const healed = pickUsableCredential(
      localProfiles.get(profile.id)?.config.password,
      baseProfiles.get(profile.id)?.config.password,
    );
    if (healed !== undefined) {
      return { ...profile, config: { ...profile.config, password: healed } };
    }
    const { password: _removed, ...configRest } = profile.config;
    return { ...profile, config: configRest };
  });

  const localGroupConfigs = new Map((local.groupConfigs ?? []).map((config) => [config.path, config]));
  const baseGroupConfigs = new Map((base?.groupConfigs ?? []).map((config) => [config.path, config]));
  const groupConfigs = remote.groupConfigs?.map((config) => {
    const localConfig = localGroupConfigs.get(config.path);
    const baseConfig = baseGroupConfigs.get(config.path);
    const next = { ...config };
    let changed = false;
    if (isEncryptedCredentialPlaceholder(next.password)) {
      const healed = pickUsableCredential(localConfig?.password, baseConfig?.password);
      if (healed !== undefined) next.password = healed;
      else delete next.password;
      changed = true;
    }
    if (isEncryptedCredentialPlaceholder(next.telnetPassword)) {
      const healed = pickUsableCredential(localConfig?.telnetPassword, baseConfig?.telnetPassword);
      if (healed !== undefined) next.telnetPassword = healed;
      else delete next.telnetPassword;
      changed = true;
    }
    if (next.proxyConfig && isEncryptedCredentialPlaceholder(next.proxyConfig.password)) {
      const healed = pickUsableCredential(
        localConfig?.proxyConfig?.password,
        baseConfig?.proxyConfig?.password,
      );
      if (healed !== undefined) {
        next.proxyConfig = { ...next.proxyConfig, password: healed };
      } else {
        const { password: _removed, ...proxyRest } = next.proxyConfig;
        next.proxyConfig = proxyRest;
      }
      changed = true;
    }
    return changed ? next : config;
  });

  return {
    ...remote,
    hosts,
    keys,
    identities: identities ?? remote.identities,
    proxyProfiles: proxyProfiles ?? remote.proxyProfiles,
    groupConfigs: groupConfigs ?? remote.groupConfigs,
  };
};

