/**
 * Split opaque sync secrets out of plugin configuration so only non-secret
 * JSON reaches cloud persistence / SyncConnectPayload.configuration.
 */

export const PLUGIN_SYNC_SECRET_CONFIG_KEYS = [
  'password',
  'token',
  'secret',
  'apiKey',
  'accessToken',
] as const;

export type PluginSyncSecretConfigKey = (typeof PLUGIN_SYNC_SECRET_CONFIG_KEYS)[number];

export interface PluginSyncExtractedSecret {
  key: PluginSyncSecretConfigKey;
  value: string;
  /** SecretStore key used for the opaque ref (stable per config field). */
  secretKey: string;
}

export interface PluginSyncCredentialPlan {
  /** Configuration with secret fields removed (safe to persist as plugin config). */
  configuration: unknown;
  /** All extracted top-level secrets (may be empty). */
  secrets: PluginSyncExtractedSecret[];
  /**
   * Primary secret for SyncConnectPayload.credential (first extracted).
   * Additional secrets remain in OS storage under their secretKey for plugins
   * that call secrets.get / createLease by key.
   */
  plaintextSecret?: string;
  secretKey: string;
  extractedFrom?: PluginSyncSecretConfigKey;
}

function isSecretConfigKey(key: string): key is PluginSyncSecretConfigKey {
  return (PLUGIN_SYNC_SECRET_CONFIG_KEYS as readonly string[]).includes(key);
}

/**
 * Extract top-level secret strings from plugin configuration JSON.
 * Every matching key is removed from configuration and returned in `secrets`.
 * Non-object configs pass through unchanged.
 */
export function planPluginSyncCredential(configuration: unknown): PluginSyncCredentialPlan {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    return { configuration, secrets: [], secretKey: 'sync-credential' };
  }
  const source = configuration as Record<string, unknown>;
  const secrets: PluginSyncExtractedSecret[] = [];
  for (const key of PLUGIN_SYNC_SECRET_CONFIG_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      secrets.push({
        key,
        value,
        secretKey: key === 'password' ? 'sync-credential' : `sync-credential:${key}`,
      });
    }
  }
  if (secrets.length === 0) {
    return { configuration, secrets: [], secretKey: 'sync-credential' };
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (isSecretConfigKey(key)) continue;
    next[key] = value;
  }
  const primary = secrets[0]!;
  return {
    configuration: next,
    secrets,
    plaintextSecret: primary.value,
    secretKey: primary.secretKey,
    extractedFrom: primary.key,
  };
}

/**
 * Sync connect strips secret fields from configuration before invoke. Host
 * schema validation must therefore treat those keys as optional even when the
 * contribution marks them required (secrets arrive via SyncConnectPayload.credential).
 */
export function syncConfigurationSchemaWithoutSecretRequirements(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const source = schema as Record<string, unknown>;
  if (!Array.isArray(source.required)) return schema;
  const required = source.required.filter(
    (name) => typeof name === 'string' && !isSecretConfigKey(name),
  );
  if (required.length === source.required.length) return schema;
  return { ...source, required };
}

/** Stable SecretStore keys used for plugin sync credentials (for delete-on-disconnect). */
export function pluginSyncSecretStoreKeys(): readonly string[] {
  return [
    'sync-credential',
    ...PLUGIN_SYNC_SECRET_CONFIG_KEYS
      .filter((key) => key !== 'password')
      .map((key) => `sync-credential:${key}`),
  ];
}
