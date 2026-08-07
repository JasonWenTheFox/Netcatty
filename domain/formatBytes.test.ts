import test from "node:test";
import assert from "node:assert/strict";

import { formatBytes } from "./formatBytes.ts";

test("formatBytes defaults match SFTP pane size labels", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 ** 3), "1.0 GB");
  assert.equal(formatBytes(1024 ** 4), "1.0 TB");
});

test("formatBytes can omit TB for transfer displays", () => {
  assert.equal(
    formatBytes(1024 ** 3, { includeTB: false }),
    "1.0 GB",
  );
  // Values beyond GB clamp to GB when TB is disabled.
  assert.equal(
    formatBytes(1024 ** 4, { includeTB: false }),
    "1024.0 GB",
  );
});

test("formatBytes preserves formatFileSize zero and precision", () => {
  assert.equal(
    formatBytes(0, { zeroDisplay: "--", byteUnit: "Bytes", fractionDigits: 2 }),
    "--",
  );
  assert.equal(
    formatBytes(512, { zeroDisplay: "--", byteUnit: "Bytes", fractionDigits: 2 }),
    "512 Bytes",
  );
  assert.equal(
    formatBytes(1536, { zeroDisplay: "--", byteUnit: "Bytes", fractionDigits: 2 }),
    "1.50 KB",
  );
});
