import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./useVaultState.ts", import.meta.url), "utf8");

test("deleteSelectedSnippets reads live vault refs before writing", () => {
  assert.match(source, /snippetsRef\.current\s*=\s*snippets/);
  assert.match(source, /snippetsRef\.current\s*=\s*cleaned/);
  assert.match(
    source,
    /deleteSelectedSnippetsFromVault\(\s*snippetsRef\.current\s*,\s*hostsRef\.current\s*,\s*selectedSnippetIds,?\s*\)/,
  );
  assert.match(
    source,
    /deleteSelectedSnippets[\s\S]*updateSnippets\(result\.snippets\)[\s\S]*updateHosts\(result\.hosts\)/,
  );
});
