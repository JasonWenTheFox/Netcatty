import test from "node:test";
import assert from "node:assert/strict";

import { connectionLogTerminalDataMapsEqual } from "./connectionLogTerminalData.ts";

test("connectionLogTerminalDataMapsEqual is true for identical references", () => {
  const map = { a: "1" };
  assert.equal(connectionLogTerminalDataMapsEqual(map, map), true);
});

test("connectionLogTerminalDataMapsEqual is true for same keys and string values", () => {
  assert.equal(
    connectionLogTerminalDataMapsEqual({ a: "1", b: "2" }, { a: "1", b: "2" }),
    true,
  );
});

test("connectionLogTerminalDataMapsEqual is false when key counts differ", () => {
  assert.equal(
    connectionLogTerminalDataMapsEqual({ a: "1" }, { a: "1", b: "2" }),
    false,
  );
});

test("connectionLogTerminalDataMapsEqual is false when a value differs", () => {
  assert.equal(
    connectionLogTerminalDataMapsEqual({ a: "1", b: "2" }, { a: "1", b: "3" }),
    false,
  );
});

test("connectionLogTerminalDataMapsEqual is false when keys differ", () => {
  assert.equal(
    connectionLogTerminalDataMapsEqual({ a: "1" }, { b: "1" }),
    false,
  );
});
