import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getKnownHostsGridColumnCount } from "./knownHostsGridLayout.ts";

test("known-host grids follow grid-cols-2 sm:grid-cols-3 xl:grid-cols-4", () => {
  assert.equal(getKnownHostsGridColumnCount(400), 2);
  assert.equal(getKnownHostsGridColumnCount(640), 3);
  assert.equal(getKnownHostsGridColumnCount(1000), 3);
  assert.equal(getKnownHostsGridColumnCount(1280), 4);
  assert.equal(getKnownHostsGridColumnCount(1800), 4);
});

test("virtualized known hosts pass the known-hosts column policy", () => {
  const source = readFileSync(new URL("./KnownHostsManager.tsx", import.meta.url), "utf8");
  assert.match(source, /getColumnCount=\{\(width, mode\) =>/);
  assert.match(source, /getKnownHostsGridColumnCount\(width\)/);
});
