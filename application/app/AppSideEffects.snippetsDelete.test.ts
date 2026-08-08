import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./AppSideEffects.tsx", import.meta.url), "utf8");

test("snippets delete handler cleans host bindings via deleteSelectedSnippetsFromVault", () => {
  assert.match(source, /collectSnippetDeleteIds/);
  assert.match(source, /deleteSelectedSnippetsFromVault/);
  assert.match(
    source,
    /netcatty:snippets:delete[\s\S]*deleteSelectedSnippetsFromVault\([\s\S]*updateHosts/,
  );
  assert.doesNotMatch(
    source,
    /updateSnippets\(snippets\.filter\(\(s\) => !ids\.has\(s\.id\)\)\)/,
  );
});

test("snippets delete handler reads vault state from refs to avoid stale closures", () => {
  // Rapid/double confirms must see the latest snippets/hosts, not the
  // values closed over when the listener was last registered.
  assert.match(source, /snippetsRef\.current\s*=\s*snippets/);
  assert.match(
    source,
    /deleteSelectedSnippetsFromVault\(\s*snippetsRef\.current\s*,\s*hostsRef\.current\s*,\s*ids,?\s*\)/,
  );
});
