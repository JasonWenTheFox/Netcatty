import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./useVaultState.ts", import.meta.url), "utf8");

test("deleteSelectedSnippets merges into persisted vault under the shared lock", () => {
  assert.match(source, /const deleteSelectedSnippets = useCallback\(async/);
  assert.match(
    source,
    /deleteSelectedSnippets[\s\S]*withVaultImportLock\("vault"/,
  );
  assert.match(
    source,
    /deleteSelectedSnippetsFromVault\(\s*latestSnippets\s*,\s*latestHosts\s*,\s*selectedSnippetIds,?\s*\)/,
  );
  assert.match(
    source,
    /deleteSelectedSnippets[\s\S]*commitPluginImporterTransaction\(localStorageAdapter, \[[\s\S]*STORAGE_KEY_HOSTS[\s\S]*STORAGE_KEY_SNIPPETS/,
  );
  // Persistence rejection must be caught: callers void the promise after the
  // confirm dialog closes, so an uncaught throw would leave no retry feedback.
  assert.match(
    source,
    /deleteSelectedSnippets[\s\S]*try \{\s*commitPluginImporterTransaction[\s\S]*catch \{[\s\S]*notify\.error\([\s\S]*Snippets could not be deleted/,
  );
  // Must not rebuild hosts from a per-window in-memory snapshot (popup race).
  assert.doesNotMatch(
    source,
    /deleteSelectedSnippetsFromVault\(\s*snippetsRef\.current\s*,\s*hostsRef\.current/,
  );
  // Paired writes must not publish in-memory state if only one key lands.
  assert.doesNotMatch(
    source,
    /deleteSelectedSnippets[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_HOSTS, encryptedHosts\)[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS/,
  );
});
