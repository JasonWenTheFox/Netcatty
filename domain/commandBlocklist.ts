import commandBlocklistTable from '../lib/commandBlocklist.json';
import type { CommandBlocklistSyncSchema } from './sync';

export const COMMAND_BLOCKLIST_SCHEMA_VERSION = 1;
export const COMMAND_BLOCKLIST_SYNC_MARKER = '(?!)netcatty-shell-aware-v1';

const COMMAND_BLOCKLIST_SYNC_MARKER_PREFIX = '(?:';
const COMMAND_BLOCKLIST_SYNC_MARKER_SUFFIX = `)|${COMMAND_BLOCKLIST_SYNC_MARKER}`;
const LEGACY_DEFAULT_PATTERNS = [
  ...commandBlocklistTable.common,
  ...commandBlocklistTable.posixNative,
  ...commandBlocklistTable.posix,
];
const SYNC_MARKER_CARRIER_PATTERN = commandBlocklistTable.common[1];

export function markCommandBlocklistPatternForSync(pattern: string): string {
  return `${COMMAND_BLOCKLIST_SYNC_MARKER_PREFIX}${pattern}${COMMAND_BLOCKLIST_SYNC_MARKER_SUFFIX}`;
}

export function hasCommandBlocklistSyncMarker(blocklist: string[]): boolean {
  return blocklist.some((pattern) => (
    pattern === COMMAND_BLOCKLIST_SYNC_MARKER
    || (
      pattern.startsWith(COMMAND_BLOCKLIST_SYNC_MARKER_PREFIX)
      && pattern.endsWith(COMMAND_BLOCKLIST_SYNC_MARKER_SUFFIX)
    )
  ));
}

export function stripCommandBlocklistSyncMarker(blocklist: string[]): string[] {
  return blocklist.flatMap((pattern) => {
    if (pattern === COMMAND_BLOCKLIST_SYNC_MARKER) return [];
    if (
      pattern.startsWith(COMMAND_BLOCKLIST_SYNC_MARKER_PREFIX)
      && pattern.endsWith(COMMAND_BLOCKLIST_SYNC_MARKER_SUFFIX)
    ) {
      return [pattern.slice(
        COMMAND_BLOCKLIST_SYNC_MARKER_PREFIX.length,
        -COMMAND_BLOCKLIST_SYNC_MARKER_SUFFIX.length,
      )];
    }
    return [pattern];
  });
}

/**
 * Older clients preserve only the string list. Attach the revision marker to
 * an existing shell-independent rule so their settings UI gains no extra row.
 * Lists missing a legacy default need no marker because migration already
 * recognizes them as customized.
 */
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

export function getCurrentCommandBlocklistRevisionVersion(
  blocklist: string[],
  schema: unknown,
): number | null {
  const schemaVersion = getMatchingCommandBlocklistSchemaVersion(blocklist, schema);
  if (schemaVersion != null && schemaVersion >= COMMAND_BLOCKLIST_SCHEMA_VERSION) {
    return schemaVersion;
  }
  return hasCommandBlocklistSyncMarker(blocklist)
    ? COMMAND_BLOCKLIST_SCHEMA_VERSION
    : null;
}

export function hasCurrentCommandBlocklistRevision(
  blocklist: string[],
  schema: unknown,
): boolean {
  return getCurrentCommandBlocklistRevisionVersion(blocklist, schema) != null;
}

/** Add new defaults only to a complete pre-shell-aware default list. */
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
