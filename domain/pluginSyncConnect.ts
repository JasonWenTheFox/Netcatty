import { pluginConfigurationMatchesSchema } from './pluginConfigurationSchema';

export type PluginSyncConnectPlan =
  | { action: 'connect'; configuration: unknown }
  | { action: 'prompt' };

/**
 * Decide how to connect a plugin sync provider.
 * - Reuse retained config when present (including falsy scalars).
 * - Connect with `{}` when no schema or when empty config is schema-valid.
 * - Otherwise prompt for configuration before connect.
 */
export function planPluginSyncConnect(options: {
  configurationSchema?: unknown;
  storedConfig: unknown;
  hasStoredConfig: boolean;
}): PluginSyncConnectPlan {
  if (options.hasStoredConfig) {
    return { action: 'connect', configuration: options.storedConfig };
  }
  const schema = options.configurationSchema;
  if (schema === undefined) {
    return { action: 'connect', configuration: {} };
  }
  if (pluginConfigurationMatchesSchema(schema, {})) {
    return { action: 'connect', configuration: {} };
  }
  return { action: 'prompt' };
}
