const test = require("node:test");
const assert = require("node:assert/strict");

const {
  claimSessionSlot,
  sessionMatchesBootEpoch,
} = require("./sessionBootEpoch.cjs");

test("claimSessionSlot rejects a superseded lower boot epoch", () => {
  const sessions = new Map();
  const newer = { bootEpoch: 3 };
  sessions.set("s1", newer);
  const stale = {};
  const result = claimSessionSlot(sessions, "s1", stale, 1);
  assert.equal(result.ok, false);
  assert.equal(sessions.get("s1"), newer);
  assert.equal(stale.bootEpoch, undefined);
});

test("claimSessionSlot replaces an older boot epoch and marks it superseded", () => {
  const sessions = new Map();
  const older = {
    bootEpoch: 1,
    proc: { killed: false, kill() { this.killed = true; } },
  };
  sessions.set("s1", older);
  const newer = {};
  const result = claimSessionSlot(sessions, "s1", newer, 4);
  assert.equal(result.ok, true);
  assert.equal(sessions.get("s1"), newer);
  assert.equal(newer.bootEpoch, 4);
  assert.equal(older.closed, true);
  assert.equal(older.supersededByBootEpoch, 4);
  assert.equal(older.proc.killed, true);
  assert.equal(older._displacedDisposed, true);
  assert.equal(result.displaced, older);
});

test("sessionMatchesBootEpoch ignores closes for a different generation", () => {
  assert.equal(sessionMatchesBootEpoch({ bootEpoch: 3 }, 1), false);
  assert.equal(sessionMatchesBootEpoch({ bootEpoch: 3 }, 3), true);
  assert.equal(sessionMatchesBootEpoch({ bootEpoch: 3 }, undefined), true);
});
