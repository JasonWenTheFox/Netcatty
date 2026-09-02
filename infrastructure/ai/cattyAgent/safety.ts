import commandBlocklistTable from '../../../lib/commandBlocklist.json';
import { DEFAULT_COMMAND_BLOCKLIST } from '../types';

/**
 * Check if a regex pattern is safe from ReDoS attacks.
 *
 * Rejects patterns with nested quantifiers like `(a+)+`, `(a*)*`, `(a+)*`
 * which can cause catastrophic backtracking / CPU exhaustion.
 */
function isSafeRegex(pattern: string): boolean {
  // Detect nested quantifiers: a group containing a quantifier, followed by another quantifier.
  // Matches patterns like (x+)+, (x*)+, (x+)*, (x{2,})+ etc.
  const nestedQuantifier = /\([^)]*[+*}]\)[+*?{]/;
  if (nestedQuantifier.test(pattern)) {
    return false;
  }
  // Also catch overlapping alternations with quantifiers inside quantified groups
  // e.g. (a|a)+  — not always dangerous but a common ReDoS vector
  const overlappingAlt = /\([^)]*\|[^)]*\)[+*]{/;
  if (overlappingAlt.test(pattern)) {
    return false;
  }
  return true;
}

/**
 * Pre-compiled RegExp cache for default blocklist patterns, grouped by the
 * shell family the pattern targets.
 *
 * The blocklist is a best-effort defense-in-depth measure. It is NOT a
 * security boundary — determined users or sophisticated prompt injection
 * can bypass regex-based filtering. The primary security boundary is the
 * permission / confirmation system and OS-level sandboxing.
 */
interface CompiledPattern { pattern: string; regex: RegExp }

const compileGroup = (patterns: string[]): CompiledPattern[] =>
  patterns.flatMap((pattern) => {
    try {
      if (!isSafeRegex(pattern)) {
        console.warn(`[Safety] Skipping default blocklist pattern with nested quantifiers (ReDoS risk): ${pattern}`);
        return [];
      }
      return [{ pattern, regex: new RegExp(pattern, 'i') }];
    } catch {
      return [];
    }
  });

const compiledCommonGroup = compileGroup(commandBlocklistTable.common);
const compiledPosixGroup = compileGroup(commandBlocklistTable.posix);
const compiledPowershellGroup = compileGroup(commandBlocklistTable.powershell);
const compiledAllGroups = [compiledCommonGroup, compiledPosixGroup, compiledPowershellGroup];

const DEFAULT_PATTERN_SET = new Set(DEFAULT_COMMAND_BLOCKLIST);

/**
 * Default-blocklist groups that apply for a shell kind, from common
 * (shell-independent) patterns to per-family ones. Unknown / empty kinds
 * intentionally fall back to every group so callers that cannot classify a
 * session keep the strict behavior.
 */
function selectDefaultGroups(shellKind?: string): CompiledPattern[][] {
  switch (String(shellKind ?? '').toLowerCase()) {
    case 'powershell':
      return [compiledCommonGroup, compiledPowershellGroup];
    case 'cmd':
      return [compiledCommonGroup];
    case 'posix':
    case 'fish':
      return [compiledCommonGroup, compiledPosixGroup];
    default:
      return compiledAllGroups;
  }
}

/** Cache for user-provided (non-default) blocklist patterns. */
const userPatternCache = new Map<string, RegExp | null>();

function getCompiledPattern(pattern: string): RegExp | null {
  if (userPatternCache.has(pattern)) {
    return userPatternCache.get(pattern)!;
  }
  if (!isSafeRegex(pattern)) {
    console.warn(`[Safety] Skipping user blocklist pattern with nested quantifiers (ReDoS risk): ${pattern}`);
    userPatternCache.set(pattern, null);
    return null;
  }
  try {
    const regex = new RegExp(pattern, 'i');
    userPatternCache.set(pattern, regex);
    return regex;
  } catch {
    userPatternCache.set(pattern, null);
    return null;
  }
}

/**
 * Check if a command matches any pattern in the blocklist.
 * Returns the matching pattern if blocked, null if safe.
 *
 * The caller's list is split: patterns that are not part of the default table
 * are treated as user additions and always apply, while default patterns are
 * selected by shell kind — POSIX-only patterns (`$(`, backticks) do not block
 * PowerShell-native commands, and PowerShell gets its own dangerous-command
 * set. Unknown shell kinds fall back to the full default table.
 *
 * Default blocklist patterns are pre-compiled at module load time.
 * User-provided patterns are compiled once and cached.
 */
export function checkCommandSafety(
  command: string,
  blocklist: string[] = DEFAULT_COMMAND_BLOCKLIST,
  shellKind?: string,
): { blocked: boolean; matchedPattern?: string } {
  // User additions beyond the default table always apply, on every shell.
  for (const pattern of blocklist) {
    if (DEFAULT_PATTERN_SET.has(pattern)) continue;
    const regex = getCompiledPattern(pattern);
    if (regex && regex.test(command)) {
      return { blocked: true, matchedPattern: pattern };
    }
  }

  // Fast path: pre-compiled default groups selected by shell kind.
  for (const group of selectDefaultGroups(shellKind)) {
    for (const { pattern, regex } of group) {
      if (regex.test(command)) {
        return { blocked: true, matchedPattern: pattern };
      }
    }
  }
  return { blocked: false };
}
