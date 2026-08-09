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
    /localStorageAdapter\.write\(STORAGE_KEY_HOSTS, encryptedHosts\)[\s\S]*localStorageAdapter\.write\(STORAGE_KEY_SNIPPETS, result\.snippets\)/,
  );
  // Must not rebuild hosts from a per-window in-memory snapshot (popup race).
  assert.doesNotMatch(
    source,
    /deleteSelectedSnippetsFromVault\(\s*snippetsRef\.current\s*,\s*hostsRef\.current/,
  );
});
