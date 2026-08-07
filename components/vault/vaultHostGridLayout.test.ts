import assert from "node:assert/strict";
import test from "node:test";

import { getElementContentWidth } from "./vaultHostGridLayout.ts";

test("getElementContentWidth subtracts horizontal padding from clientWidth", () => {
  const el = {
    clientWidth: 800,
  } as HTMLElement;
  const original = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (() => ({
    paddingLeft: "16px",
    paddingRight: "16px",
  })) as typeof getComputedStyle;
  try {
    assert.equal(getElementContentWidth(el), 768);
  } finally {
    globalThis.getComputedStyle = original;
  }
});
