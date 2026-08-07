import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getKnownHostsGridColumnCount } from "./knownHostsGridLayout.ts";

test("known-host grids use container-width column steps", () => {
  assert.equal(getKnownHostsGridColumnCount(400), 2);
  assert.equal(getKnownHostsGridColumnCount(640), 3);
  assert.equal(getKnownHostsGridColumnCount(1000), 3);
  assert.equal(getKnownHostsGridColumnCount(1280), 4);
  assert.equal(getKnownHostsGridColumnCount(1800), 4);
});

test("virtualized known-host cards expose a focus target for keyboard nav", () => {
  const source = readFileSync(new URL("./KnownHostsManager.tsx", import.meta.url), "utf8");
  assert.match(source, /data-vault-focus-target/);
  assert.match(source, /tabIndex=\{0\}/);
});
