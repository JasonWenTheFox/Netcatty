import {
  COMMAND_BLOCKLIST_SCHEMA_VERSION,
  hasCommandBlocklistSyncMarker,
  migrateLegacyCommandBlocklist,
} from '../../domain/commandBlocklist';
import { DEFAULT_COMMAND_BLOCKLIST } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_COMMAND_BLOCKLIST, STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export function readCommandBlocklistSetting(): string[] {
  const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
  if (stored != null && !Array.isArray(stored)) {
    return [...DEFAULT_COMMAND_BLOCKLIST];
  }

  const current = stored ?? [...DEFAULT_COMMAND_BLOCKLIST];
  const schemaVersion = localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA) ?? 0;
  const hasSyncMarker = hasCommandBlocklistSyncMarker(current);
  const migrated = stored == null
    ? current
    : schemaVersion >= COMMAND_BLOCKLIST_SCHEMA_VERSION && !hasSyncMarker
      ? current
      : migrateLegacyCommandBlocklist(current);
  let migrationPersisted = true;
  if (
    stored != null
    && (
      migrated.length !== current.length
      || migrated.some((pattern, index) => pattern !== current[index])
    )
  ) {
    migrationPersisted = localStorageAdapter.write(STORAGE_KEY_AI_COMMAND_BLOCKLIST, migrated);
  }
  if (migrationPersisted) {
    localStorageAdapter.writeNumber(
      STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA,
      Math.max(schemaVersion, COMMAND_BLOCKLIST_SCHEMA_VERSION),
    );
  }
  return migrated;
}
