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
 * Content fingerprint for three-way rebase. Omits `order` so a local reorder
 * (which renumbers every row) does not look like an edit of unrelated snippets.
 */
function snippetContentFingerprint(snippet: Snippet): string {
  const { order: _order, ...content } = snippet;
  return JSON.stringify(content, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (value as Record<string, unknown>)[key];
        return acc;
      }, {});
    }
    return value;
  });
}

/** Relative id sequence for ids present on both sides (order-change detector). */
function sharedIdSequence(
  snippets: readonly Snippet[],
  sharedIds: ReadonlySet<string>,
): string[] {
  const sequence: string[] = [];
  for (const snippet of snippets) {
    if (!snippet.id || !sharedIds.has(snippet.id)) continue;
    sequence.push(snippet.id);
  }
  return sequence;
}

function sameIdSequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/** True when `side` contains an id that was not present on the base ancestor. */
function hasIdsOutsideBase(
  side: readonly Snippet[],
  baseIds: ReadonlySet<string>,
): boolean {
  for (const snippet of side) {
    if (!snippet.id || baseIds.has(snippet.id)) continue;
    return true;
  }
  return false;
}

function applyPreferredOrder(
  content: Snippet,
  ourItem: Snippet,
  theirItem: Snippet,
  preferTheirOrder: boolean,
): Snippet {
  const order = preferTheirOrder ? theirItem.order : ourItem.order;
  return content.order === order ? content : { ...content, order };
}

/**
 * Three-way rebase for a queued full-array snippet save against the latest
 * persisted vault snapshot.
 *
 * Unlike sync merge, a concurrent disk delete always wins over a local edit of
 * the same id so bulk-delete cannot be resurrected by a stale window write.
 * When an id exists on all sides, preserve a disk-only content edit; both-sides
 * content conflicts prefer the local write (same as sync merge).
 * List order is merged independently: a disk-only reorder or insertion survives
 * an unrelated local content edit or local addition; a local reorder of shared
 * ids still wins over disk (including when both sides reordered shared ids).
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

  const baseIds = new Set<string>();
  const baseOursIds = new Set<string>();
  const baseTheirsIds = new Set<string>();
  for (const id of baseMap.keys()) {
    if (!id) continue;
    baseIds.add(id);
    if (oursMap.has(id)) baseOursIds.add(id);
    if (theirsMap.has(id)) baseTheirsIds.add(id);
  }
  // Shared-id sequences ignore insertions. Detect reorder of existing ids
  // separately from new-id placement so a local add does not look like a
  // reorder that discards an unrelated disk reorder.
  const oursSharedReordered = !sameIdSequence(
    sharedIdSequence(base, baseOursIds),
    sharedIdSequence(ours, baseOursIds),
  );
  const theirsSharedReordered = !sameIdSequence(
    sharedIdSequence(base, baseTheirsIds),
    sharedIdSequence(theirs, baseTheirsIds),
  );
  const oursHasInsertions = hasIdsOutsideBase(ours, baseIds);
  const theirsHasInsertions = hasIdsOutsideBase(theirs, baseIds);
  // Prefer disk order when local did not reorder shared ids and disk either
  // reordered those ids or inserted while local only edited/kept the list.
  // Local insertions alone must not block a disk-only shared reorder; concurrent
  // additions on both sides still prefer ours (then append theirs).
  const preferTheirOrder =
    !oursSharedReordered
    && (
      theirsSharedReordered
      || (theirsHasInsertions && !oursHasInsertions)
    );

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
      const oursChanged =
        snippetContentFingerprint(ourItem) !== snippetContentFingerprint(baseItem);
      const theirsChanged =
        snippetContentFingerprint(theirItem) !== snippetContentFingerprint(baseItem);
      if (!oursChanged && theirsChanged) {
        // Disk-only content edit: keep their body; order follows the side that
        // actually reordered (disk-only reorder, else local).
        keep.set(id, applyPreferredOrder(theirItem, ourItem, theirItem, preferTheirOrder));
      } else {
        // Unchanged, ours-only, or both-changed conflict → local content wins.
        keep.set(id, applyPreferredOrder(ourItem, ourItem, theirItem, preferTheirOrder));
      }
      continue;
    }
    // Local delete (even if disk still has / edited the row).
    if (inBase && !inOurs && inTheirs) continue;
    // Concurrent disk delete — do not resurrect from a stale local edit.
    if (inBase && inOurs && !inTheirs) continue;
  }

  const primary = preferTheirOrder ? theirs : ours;
  const secondary = preferTheirOrder ? ours : theirs;
  const ordered: Snippet[] = [];
  const seen = new Set<string>();
  for (const snippet of primary) {
    const kept = keep.get(snippet.id);
    if (!kept || seen.has(snippet.id)) continue;
    ordered.push(kept);
    seen.add(snippet.id);
  }
  for (const snippet of secondary) {
    const kept = keep.get(snippet.id);
    if (!kept || seen.has(snippet.id)) continue;
    ordered.push(kept);
    seen.add(snippet.id);
  }
  return ordered;
}
