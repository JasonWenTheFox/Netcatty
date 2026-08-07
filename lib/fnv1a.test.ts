import test from "node:test";
import assert from "node:assert/strict";

import { fnv1a32, fnv1aHex } from "./fnv1a.ts";

test("fnv1a32 is stable for a known string", () => {
  assert.equal(fnv1a32("netcatty"), 0x8c3fbad3);
  assert.equal(fnv1a32(""), 0x811c9dc5);
});

test("fnv1aHex prefixes the hex digest", () => {
  assert.equal(fnv1aHex(""), "fnv1a-811c9dc5");
  assert.match(fnv1aHex("hello"), /^fnv1a-[0-9a-f]{8}$/);
});
