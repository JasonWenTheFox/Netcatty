import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("gpu tab keeps loading while accelerator query is pending", () => {
  const source = readFileSync(new URL("./GpuManagerTab.tsx", import.meta.url), "utf8");
  assert.match(source, /setGpuListPending\(true\)/);
  assert.match(source, /if \(result\.pending\)/);
  assert.match(source, /isRefreshActive = loading \|\| gpuListPending/);
  assert.match(source, /if \(!data\)/);
  assert.doesNotMatch(
    source,
    /if \(result\.pending\) return null;\s*\n\s*if \(!result\.success\)/,
  );
});

test("gpu tab still renders compute processes when device list is empty", () => {
  const source = readFileSync(new URL("./GpuManagerTab.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!devices\.length && !processes\.length\)/);
  assert.match(source, /processes\.map\(\(process\) =>/);
});
