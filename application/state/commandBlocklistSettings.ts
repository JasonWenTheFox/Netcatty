import {
  COMMAND_BLOCKLIST_SCHEMA_VERSION,
  createCommandBlocklistSyncSchema,
  getMatchingCommandBlocklistSchemaVersion,
  hasCommandBlocklistSyncMarker,
  migrateLegacyCommandBlocklist,
} from '../../domain/commandBlocklist';
import { DEFAULT_COMMAND_BLOCKLIST } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_COMMAND_BLOCKLIST, STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export function readStoredCommandBlocklistSchemaVersion(blocklist: string[]): number | null {
  const storedSchema = localStorageAdapter.read<unknown>(STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA);
  if (typeof storedSchema === 'number' && Number.isInteger(storedSchema) && storedSchema > 0) {
    return storedSchema;
  }
  return getMatchingCommandBlocklistSchemaVersion(blocklist, storedSchema);
}

function readStoredCommandBlocklistSchemaVersionUnchecked(): number | null {
  const storedSchema = localStorageAdapter.read<unknown>(STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA);
  if (typeof storedSchema === 'number' && Number.isInteger(storedSchema) && storedSchema > 0) {
    return storedSchema;
  }
  if (
    storedSchema
    && typeof storedSchema === 'object'
    && !Array.isArray(storedSchema)
    && typeof (storedSchema as { version?: unknown }).version === 'number'
  ) {
    const version = (storedSchema as { version: number }).version;
    return Number.isInteger(version) && version > 0 ? version : null;
  }
  return null;
}

export function persistCommandBlocklistSetting(
  blocklist: string[],
  version = Math.max(
    readStoredCommandBlocklistSchemaVersionUnchecked() ?? 0,
    COMMAND_BLOCKLIST_SCHEMA_VERSION,
  ),
): boolean {
  if (!localStorageAdapter.write(STORAGE_KEY_AI_COMMAND_BLOCKLIST, blocklist)) return false;
  return localStorageAdapter.write(
    STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA,
    createCommandBlocklistSyncSchema(blocklist, version),
  );
}

export function readCommandBlocklistSetting(): string[] {
  const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
  if (stored != null && !Array.isArray(stored)) {
    return [...DEFAULT_COMMAND_BLOCKLIST];
  }

  const current = stored ?? [...DEFAULT_COMMAND_BLOCKLIST];
  const schemaVersion = readStoredCommandBlocklistSchemaVersion(current) ?? 0;
  const hasSyncMarker = hasCommandBlocklistSyncMarker(current);
  const migrated = stored == null
    ? current
    : schemaVersion >= COMMAND_BLOCKLIST_SCHEMA_VERSION && !hasSyncMarker
      ? current
      : migrateLegacyCommandBlocklist(current);
  let migrationPersisted = true;
  if (
    stored == null
    || (
      migrated.length !== current.length
      || migrated.some((pattern, index) => pattern !== current[index])
    )
  ) {
    migrationPersisted = persistCommandBlocklistSetting(
      migrated,
      Math.max(schemaVersion, COMMAND_BLOCKLIST_SCHEMA_VERSION),
    );
  }
  if (migrationPersisted && stored != null) {
    localStorageAdapter.write(
      STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA,
      createCommandBlocklistSyncSchema(
        migrated,
        Math.max(schemaVersion, COMMAND_BLOCKLIST_SCHEMA_VERSION),
      ),
    );
  }
  return migrated;
}
