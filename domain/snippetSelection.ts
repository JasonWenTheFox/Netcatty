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
