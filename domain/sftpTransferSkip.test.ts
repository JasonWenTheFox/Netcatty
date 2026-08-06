import assert from "node:assert/strict";
import test from "node:test";

import {
  isUnchangedTransferCandidate,
  normalizeTransferMtimeSeconds,
} from "./sftpTransferSkip";

test("normalizeTransferMtimeSeconds accepts seconds and milliseconds", () => {
  assert.equal(normalizeTransferMtimeSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(normalizeTransferMtimeSeconds(1_700_000_000_500), 1_700_000_000);
  // Year 2000 in milliseconds must not be treated as epoch seconds.
  assert.equal(normalizeTransferMtimeSeconds(946_684_800_000), 946_684_800);
  assert.equal(normalizeTransferMtimeSeconds(946_684_800), 946_684_800);
});

test("isUnchangedTransferCandidate requires matching size and second mtime", () => {
  assert.equal(
    isUnchangedTransferCandidate(
      { size: 10, lastModified: 1_700_000_000_200 },
      { size: 10, lastModified: 1_700_000_000 },
    ),
    true,
  );
  assert.equal(
    isUnchangedTransferCandidate(
      { size: 10, lastModified: 946_684_800_123 },
      { size: 10, lastModified: 946_684_800 },
    ),
    true,
  );
  assert.equal(
    isUnchangedTransferCandidate(
      { size: 10, lastModified: 1_700_000_000 },
      { size: 11, lastModified: 1_700_000_000 },
    ),
    false,
  );
  assert.equal(
    isUnchangedTransferCandidate(
      { size: 10, lastModified: 1_700_000_000 },
      { size: 10, lastModified: 1_700_000_001 },
    ),
    false,
  );
  assert.equal(
    isUnchangedTransferCandidate(
      { size: 0, lastModified: 1_700_000_000 },
      { size: 0, lastModified: 1_700_000_000 },
    ),
    true,
  );
  assert.equal(
    isUnchangedTransferCandidate(
      { size: 10, lastModified: 0 },
      { size: 10, lastModified: 0 },
    ),
    false,
  );
});
