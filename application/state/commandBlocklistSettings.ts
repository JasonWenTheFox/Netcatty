import commandBlocklistTable from '../../lib/commandBlocklist.json';
import { DEFAULT_COMMAND_BLOCKLIST } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_COMMAND_BLOCKLIST, STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

const COMMAND_BLOCKLIST_SCHEMA_VERSION = 1;
const LEGACY_DEFAULT_PATTERNS = [
  ...commandBlocklistTable.common,
  ...commandBlocklistTable.posix,
];

/**
 * Add the new PowerShell defaults only when the saved list still contains the
 * complete pre-shell-aware default table. Customized/deleted lists remain
 * authoritative.
 */
export function migrateLegacyCommandBlocklist(blocklist: string[]): string[] {
  const configured = new Set(blocklist);
  if (!LEGACY_DEFAULT_PATTERNS.every((pattern) => configured.has(pattern))) {
    return [...blocklist];
  }
  const missingPowershellPatterns = commandBlocklistTable.powershell.filter(
    (pattern) => !configured.has(pattern),
  );
  return missingPowershellPatterns.length > 0
    ? [...blocklist, ...missingPowershellPatterns]
    : [...blocklist];
}

export function readCommandBlocklistSetting(): string[] {
  const stored = localStorageAdapter.read<string[]>(STORAGE_KEY_AI_COMMAND_BLOCKLIST);
  if (stored != null && !Array.isArray(stored)) {
    return [...DEFAULT_COMMAND_BLOCKLIST];
  }

  const current = stored ?? [...DEFAULT_COMMAND_BLOCKLIST];
  const schemaVersion = localStorageAdapter.readNumber(STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA) ?? 0;
  if (schemaVersion >= COMMAND_BLOCKLIST_SCHEMA_VERSION) return current;

  const migrated = stored == null ? current : migrateLegacyCommandBlocklist(current);
  let migrationPersisted = true;
  if (stored != null && migrated.length !== current.length) {
    migrationPersisted = localStorageAdapter.write(STORAGE_KEY_AI_COMMAND_BLOCKLIST, migrated);
  }
  if (migrationPersisted) {
    localStorageAdapter.writeNumber(
      STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA,
      COMMAND_BLOCKLIST_SCHEMA_VERSION,
    );
  }
  return migrated;
}
