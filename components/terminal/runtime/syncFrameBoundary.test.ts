import assert from "node:assert/strict";
import test from "node:test";

import { frameSafeSliceEnd, isInsideSyncBlockAt } from "./syncFrameBoundary";

const H = "\x1b[?2026h";
const L = "\x1b[?2026l";

test("isInsideSyncBlockAt: open before close is inside", () => {
  const data = `${H}frame body`;
  assert.equal(isInsideSyncBlockAt(data, 0, data.length), true);
});

test("isInsideSyncBlockAt: closed block is not inside", () => {
  const data = `${H}frame${L}`;
  assert.equal(isInsideSyncBlockAt(data, 0, data.length), false);
});

test("isInsideSyncBlockAt: point between close and next open is not inside", () => {
  const data = `${H}a${L}XX${H}b${L}`;
  const between = `${H}a${L}X`.length;
  assert.equal(isInsideSyncBlockAt(data, 0, between), false);
});

test("isInsideSyncBlockAt: a DECRQM query is not a frame boundary", () => {
  const data = "\x1b[?2026$pplain text";
  assert.equal(isInsideSyncBlockAt(data, 0, data.length), false);
});

test("isInsideSyncBlockAt: a cut mid-close still counts as inside", () => {
  // startsWith matches whole SYNC_CLOSE in data even when `to` lands inside the
  // marker. The scan must not flip to closed until the full closer is before `to`.
  const frame = `${H}${"x".repeat(20)}${L}`;
  const closeStart = frame.length - L.length;
  for (let mid = 1; mid < L.length; mid++) {
    const to = closeStart + mid;
    assert.equal(
      isInsideSyncBlockAt(frame, 0, to),
      true,
      `mid-close at +${mid} must still be inside the open block`,
    );
  }
  assert.equal(isInsideSyncBlockAt(frame, 0, frame.length), false);
});

test("frameSafeSliceEnd: a cut inside a frame extends to past its close", () => {
  const frame = `${H}${"x".repeat(100)}${L}`;
  const data = `${frame}${frame}`;
  // Desired cut lands inside the first frame.
  const cut = H.length + 50;
  const end = frameSafeSliceEnd(data, 0, cut);
  assert.equal(end, frame.length, "must extend to the end of the open frame");
  assert.equal(isInsideSyncBlockAt(data, 0, end), false);
});

test("frameSafeSliceEnd: a cut between frames is left untouched", () => {
  const frame = `${H}${"x".repeat(100)}${L}`;
  const data = `${frame}${frame}`;
  const cut = frame.length; // exactly on the boundary
  assert.equal(frameSafeSliceEnd(data, 0, cut), cut);
});

test("frameSafeSliceEnd: an unterminated frame is held to the end", () => {
  const data = `${H}${"x".repeat(100)}`; // no close
  const cut = H.length + 50;
  assert.equal(frameSafeSliceEnd(data, 0, cut), data.length);
});

test("frameSafeSliceEnd: plain output is never adjusted", () => {
  const data = "just some normal terminal output with no sync blocks";
  assert.equal(frameSafeSliceEnd(data, 0, 20), 20);
});

test("frameSafeSliceEnd: end at data.length is returned as-is", () => {
  const data = `${H}x${L}`;
  assert.equal(frameSafeSliceEnd(data, 0, data.length), data.length);
});

test("frameSafeSliceEnd: never moves the end backwards", () => {
  const frame = `${H}${"x".repeat(100)}${L}`;
  const data = `${frame}tail`;
  const cut = H.length + 10;
  const end = frameSafeSliceEnd(data, 0, cut);
  assert.ok(end >= cut, "the adjusted end must not precede the desired end");
});

test("frameSafeSliceEnd: a cut inside the close marker includes the full marker", () => {
  const frame = `${H}${"x".repeat(20)}${L}`;
  const data = `${frame}tail`;
  // Land mid-close: after ESC[?2026 but before the final `l`.
  const closeStart = frame.length - L.length;
  for (let mid = 1; mid < L.length; mid++) {
    const cut = closeStart + mid;
    const end = frameSafeSliceEnd(data, 0, cut);
    assert.equal(
      end,
      frame.length,
      `mid-close cut at +${mid} must extend to full close marker`,
    );
    assert.equal(
      data.slice(0, end).endsWith(L),
      true,
      "slice must end on a complete close marker",
    );
  }
});

test("frameSafeSliceEnd: a cut exactly at the close start still completes the frame", () => {
  const frame = `${H}${"x".repeat(20)}${L}`;
  const data = `${frame}next`;
  const closeStart = frame.length - L.length;
  // At the start of the close the block is still open, so extend past it.
  assert.equal(frameSafeSliceEnd(data, 0, closeStart), frame.length);
});
