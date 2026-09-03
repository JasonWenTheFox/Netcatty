import commandBlocklistTable from '../../lib/commandBlocklist.json';
import {
  hasCommandBlocklistSyncMarker,
  markCommandBlocklistPatternForSync,
  stripCommandBlocklistSyncMarker,
  type CommandBlocklistSyncSchema,
} from '../../domain/sync';
import { DEFAULT_COMMAND_BLOCKLIST } from '../../infrastructure/ai/types';
import { STORAGE_KEY_AI_COMMAND_BLOCKLIST, STORAGE_KEY_AI_COMMAND_BLOCKLIST_SCHEMA } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export const COMMAND_BLOCKLIST_SCHEMA_VERSION = 1;
const LEGACY_DEFAULT_PATTERNS = [
  ...commandBlocklistTable.common,
  ...commandBlocklistTable.posixNative,
  ...commandBlocklistTable.posix,
];
const SYNC_MARKER_CARRIER_PATTERN = commandBlocklistTable.common[1];

export function addCommandBlocklistSyncMarker(blocklist: string[]): string[] {
  const unmarked = stripCommandBlocklistSyncMarker(blocklist);
  if (!LEGACY_DEFAULT_PATTERNS.every((pattern) => unmarked.includes(pattern))) {
    return unmarked;
  }

  let marked = false;
  return unmarked.map((pattern) => {
    if (!marked && pattern === SYNC_MARKER_CARRIER_PATTERN) {
      marked = true;
      return markCommandBlocklistPatternForSync(pattern);
    }
    return pattern;
  });
}

export function createCommandBlocklistSyncSchema(
  blocklist: string[],
  version = COMMAND_BLOCKLIST_SCHEMA_VERSION,
): CommandBlocklistSyncSchema {
  return { version, blocklist: [...blocklist] };
}

export function getMatchingCommandBlocklistSchemaVersion(
  blocklist: string[],
  schema: unknown,
): number | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const candidate = schema as Partial<CommandBlocklistSyncSchema>;
  if (
    typeof candidate.version !== 'number'
    || !Number.isInteger(candidate.version)
    || !Array.isArray(candidate.blocklist)
    || candidate.blocklist.length !== blocklist.length
    || candidate.blocklist.some((pattern, index) => pattern !== blocklist[index])
  ) {
    return null;
  }
  return candidate.version;
}

/**
 * Add the new PowerShell defaults only when the saved list still contains the
 * complete pre-shell-aware default table. Customized/deleted lists remain
 * authoritative.
 */
export function migrateLegacyCommandBlocklist(blocklist: string[]): string[] {
  const hasSyncMarker = hasCommandBlocklistSyncMarker(blocklist);
  const unmarked = stripCommandBlocklistSyncMarker(blocklist);
  if (hasSyncMarker) return unmarked;

  const configured = new Set(unmarked);
  if (!LEGACY_DEFAULT_PATTERNS.every((pattern) => configured.has(pattern))) {
    return unmarked;
  }
  const missingPowershellPatterns = commandBlocklistTable.powershell.filter(
    (pattern) => !configured.has(pattern),
  );
  return missingPowershellPatterns.length > 0
    ? [...unmarked, ...missingPowershellPatterns]
    : unmarked;
}

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
