import assert from "node:assert/strict";
import test from "node:test";

import { collapseAndSplit } from "./terminalFrameGate.ts";

const ON = "\x1b[?2026h";
const OFF = "\x1b[?2026l";
const HOME = "\x1b[1;1H";
const frame = (paint: string) => `${ON}${HOME}${paint}${OFF}`;

test("no frames: everything is complete, nothing held", () => {
  assert.deepEqual(collapseAndSplit("plain text"), {
    complete: "plain text",
    partial: "",
    dropped: 0,
  });
});

test("one complete frame passes through whole", () => {
  const f = frame("A");
  assert.deepEqual(collapseAndSplit(f), { complete: f, partial: "", dropped: 0 });
});

test("a trailing unterminated frame is held as partial", () => {
  const a = frame("A");
  const partialFrame = `${ON}${HOME}half`; // no OFF
  assert.deepEqual(collapseAndSplit(a + partialFrame), {
    complete: a,
    partial: partialFrame,
    dropped: 0,
  });
});

test("collapses a run of full-repaint frames to the last", () => {
  const a = frame("A");
  const b = frame("B");
  const c = frame("C");
  const r = collapseAndSplit(a + b + c);
  assert.equal(r.complete, c);
  assert.equal(r.partial, "");
  assert.equal(r.dropped, a.length + b.length);
});

test("collapses complete frames but still holds a trailing partial", () => {
  const a = frame("A");
  const b = frame("B");
  const partialFrame = `${ON}${HOME}new`;
  const r = collapseAndSplit(a + b + partialFrame);
  assert.equal(r.complete, b);
  assert.equal(r.partial, partialFrame);
  assert.equal(r.dropped, a.length);
});

test("preserves leading and inter-frame non-frame bytes", () => {
  const a = frame("A");
  const b = frame("B");
  const r = collapseAndSplit("lead" + a + b);
  assert.equal(r.complete, "lead" + b);
  assert.equal(r.dropped, a.length);
});

test("does not drop across a non-empty gap between frames", () => {
  const a = frame("A");
  const b = frame("B");
  const input = a + "\r\n" + b;
  assert.deepEqual(collapseAndSplit(input), {
    complete: input,
    partial: "",
    dropped: 0,
  });
});

test("does not drop a frame carrying OSC or private-mode state", () => {
  const osc = `${ON}${HOME}\x1b]0;t\x07x${OFF}`;
  const b = frame("B");
  const input = osc + b;
  assert.deepEqual(collapseAndSplit(input), {
    complete: input,
    partial: "",
    dropped: 0,
  });
});

test("does not drop when the successor does not home the cursor", () => {
  const a = frame("A");
  const positioned = `${ON}\x1b[5;5Hxx${OFF}`;
  const input = a + positioned;
  assert.deepEqual(collapseAndSplit(input), {
    complete: input,
    partial: "",
    dropped: 0,
  });
});

test("keeps only the last of many frames", () => {
  const frames = Array.from({ length: 10 }, (_, i) => frame(`P${i}`));
  const r = collapseAndSplit(frames.join(""));
  assert.equal(r.complete, frames[frames.length - 1]);
  assert.equal(r.partial, "");
});
