import type { Host, Snippet } from './models';
import { deleteSnippetFromVault } from './snippetAgentOps.ts';

/** Normalize `netcatty:snippets:delete` detail into a set of snippet ids. */
export function collectSnippetDeleteIds(
  detail?: { id?: string; ids?: readonly string[] } | null,
): Set<string> {
  const ids = new Set<string>();
  for (const id of detail?.ids ?? []) {
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  if (typeof detail?.id === 'string' && detail.id.length > 0) {
    ids.add(detail.id);
  }
  return ids;
}

export function deleteSelectedSnippetsFromVault(
  snippets: Snippet[],
  hosts: Host[],
  selectedSnippetIds: ReadonlySet<string>,
): { snippets: Snippet[]; hosts: Host[]; deletedCount: number } {
  let nextSnippets = [...snippets];
  let nextHosts = [...hosts];
  let deletedCount = 0;

  for (const snippet of snippets) {
    if (!snippet.id || !selectedSnippetIds.has(snippet.id)) continue;
    const result = deleteSnippetFromVault(nextSnippets, nextHosts, snippet.id);
    if ('error' in result) continue;
    nextSnippets = result.snippets;
    nextHosts = result.hosts;
    deletedCount += 1;
  }

  return { snippets: nextSnippets, hosts: nextHosts, deletedCount };
}

/**
 * Three-way rebase for a queued full-array snippet save against the latest
 * persisted vault snapshot.
 *
 * Unlike sync merge, a concurrent disk delete always wins over a local edit of
 * the same id so bulk-delete cannot be resurrected by a stale window write.
 */
export function rebaseSnippetVaultWrite({
  base,
  ours,
  theirs,
}: {
  base: readonly Snippet[];
  ours: readonly Snippet[];
  theirs: readonly Snippet[];
}): Snippet[] {
  const baseMap = new Map(base.map((snippet) => [snippet.id, snippet]));
  const oursMap = new Map(ours.map((snippet) => [snippet.id, snippet]));
  const theirsMap = new Map(theirs.map((snippet) => [snippet.id, snippet]));
  const keep = new Map<string, Snippet>();

  const allIds = new Set<string>([
    ...baseMap.keys(),
    ...oursMap.keys(),
    ...theirsMap.keys(),
  ]);

  for (const id of allIds) {
    if (!id) continue;
    const baseItem = baseMap.get(id);
    const ourItem = oursMap.get(id);
    const theirItem = theirsMap.get(id);
    const inBase = baseItem !== undefined;
    const inOurs = ourItem !== undefined;
    const inTheirs = theirItem !== undefined;

    if (!inBase && inOurs && !inTheirs) {
      keep.set(id, ourItem);
      continue;
    }
    if (!inBase && !inOurs && inTheirs) {
      keep.set(id, theirItem);
      continue;
    }
    if (!inBase && inOurs && inTheirs) {
      keep.set(id, ourItem);
      continue;
    }
    if (inBase && inOurs && inTheirs) {
      keep.set(id, ourItem);
      continue;
    }
    // Local delete (even if disk still has / edited the row).
    if (inBase && !inOurs && inTheirs) continue;
    // Concurrent disk delete — do not resurrect from a stale local edit.
    if (inBase && inOurs && !inTheirs) continue;
  }

  const ordered: Snippet[] = [];
  const seen = new Set<string>();
  for (const snippet of ours) {
    const kept = keep.get(snippet.id);
    if (!kept || seen.has(snippet.id)) continue;
    ordered.push(kept);
    seen.add(snippet.id);
  }
  for (const snippet of theirs) {
    const kept = keep.get(snippet.id);
    if (!kept || seen.has(snippet.id)) continue;
    ordered.push(kept);
    seen.add(snippet.id);
  }
  return ordered;
}
