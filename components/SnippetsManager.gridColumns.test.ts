import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getSnippetsGridColumnCount } from "./snippetsGridLayout.ts";

test("full-width snippet grids use container-width column steps", () => {
  assert.equal(getSnippetsGridColumnCount(500, { hasSidePanel: false }), 1);
  assert.equal(getSnippetsGridColumnCount(768, { hasSidePanel: false }), 2);
  assert.equal(getSnippetsGridColumnCount(1279, { hasSidePanel: false }), 2);
  assert.equal(getSnippetsGridColumnCount(1280, { hasSidePanel: false }), 3);
  assert.equal(getSnippetsGridColumnCount(2000, { hasSidePanel: false }), 3);
});

test("split-view snippet grids keep the card-width column count", () => {
  assert.equal(getSnippetsGridColumnCount(219, { hasSidePanel: true }), 1);
  assert.equal(getSnippetsGridColumnCount(452, { hasSidePanel: true }), 2);
  assert.equal(getSnippetsGridColumnCount(916, { hasSidePanel: true }), 4);
});

test("virtualized and CSS snippet grids share container column policy", () => {
  const source = readFileSync(new URL("./SnippetsManager.tsx", import.meta.url), "utf8");
  assert.match(source, /getColumnCount=\{\(width, mode\) =>/);
  assert.match(source, /getSnippetsGridColumnCount\(width, \{ hasSidePanel: hasSnippetsSidePanel \}\)/);
  assert.match(source, /getSnippetsGridColumnCount\(el\.clientWidth/);
  assert.match(source, /snippetGridStyle/);
  assert.doesNotMatch(source, /md:grid-cols-2|xl:grid-cols-3/);
});

test("virtualized snippet drops reset drag state without waiting for dragend", () => {
  const source = readFileSync(new URL("./SnippetsManager.tsx", import.meta.url), "utf8");
  assert.match(source, /handleReorderDrop = useCallback/);
  assert.match(source, /finally \{\s*\/\/ Virtualized cards[\s\S]*resetSnippetDragState\(\);/);
  assert.match(source, /resetSnippetDragState,/);
});
