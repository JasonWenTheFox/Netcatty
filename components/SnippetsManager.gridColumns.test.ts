import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getSnippetsGridColumnCount } from "./snippetsGridLayout.ts";

test("full-width snippet grids cap at three columns like the CSS breakpoints", () => {
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

test("virtualized snippet collections pass the snippet column policy", () => {
  const source = readFileSync(new URL("./SnippetsManager.tsx", import.meta.url), "utf8");
  assert.match(source, /getColumnCount=\{\(width, mode\) =>/);
  assert.match(source, /getSnippetsGridColumnCount\(width, \{ hasSidePanel: hasSnippetsSidePanel \}\)/);
});
