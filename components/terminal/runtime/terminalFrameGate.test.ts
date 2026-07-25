import assert from "node:assert/strict";
import test from "node:test";

import { apportionFrameGateIngress, collapseAndSplit } from "./terminalFrameGate.ts";

const ON = "\x1b[?2026h";
const OFF = "\x1b[?2026l";
const HOME = "\x1b[1;1H";
const frame = (paint: string) => `${ON}${HOME}${paint}${OFF}`;
// Most tests do not exercise the full-repaint size gate; 0 lets any homing
// successor qualify so they cover the frame-boundary logic in isolation.
const ANY = 0;

test("no frames: everything is complete, nothing held", () => {
  assert.deepEqual(collapseAndSplit("plain text", ANY), {
    complete: "plain text",
    partial: "",
    dropped: 0,
  });
});

test("one complete frame passes through whole", () => {
  const f = frame("A");
  assert.deepEqual(collapseAndSplit(f, ANY), { complete: f, partial: "", dropped: 0 });
});

test("a trailing unterminated frame is held as partial", () => {
  const a = frame("A");
  const partialFrame = `${ON}${HOME}half`; // no OFF
  assert.deepEqual(collapseAndSplit(a + partialFrame, ANY), {
    complete: a,
    partial: partialFrame,
    dropped: 0,
  });
});

test("collapses a run of full-repaint frames to the last", () => {
  const a = frame("A");
  const b = frame("B");
  const c = frame("C");
  const r = collapseAndSplit(a + b + c, ANY);
  assert.equal(r.complete, c);
  assert.equal(r.partial, "");
  assert.equal(r.dropped, a.length + b.length);
});

test("collapses complete frames but still holds a trailing partial", () => {
  const a = frame("A");
  const b = frame("B");
  const partialFrame = `${ON}${HOME}new`;
  const r = collapseAndSplit(a + b + partialFrame, ANY);
  assert.equal(r.complete, b);
  assert.equal(r.partial, partialFrame);
  assert.equal(r.dropped, a.length);
});

test("preserves leading and inter-frame non-frame bytes", () => {
  const a = frame("A");
  const b = frame("B");
  const r = collapseAndSplit("lead" + a + b, ANY);
  assert.equal(r.complete, "lead" + b);
  assert.equal(r.dropped, a.length);
});

test("does not drop across a non-empty gap between frames", () => {
  const a = frame("A");
  const b = frame("B");
  const input = a + "\r\n" + b;
  assert.deepEqual(collapseAndSplit(input, ANY), {
    complete: input,
    partial: "",
    dropped: 0,
  });
});

test("does not drop a frame carrying OSC or private-mode state", () => {
  const osc = `${ON}${HOME}\x1b]0;t\x07x${OFF}`;
  const b = frame("B");
  const input = osc + b;
  assert.deepEqual(collapseAndSplit(input, ANY), {
    complete: input,
    partial: "",
    dropped: 0,
  });
});

test("does not drop when the successor does not home the cursor", () => {
  const a = frame("A");
  const positioned = `${ON}\x1b[5;5Hxx${OFF}`;
  const input = a + positioned;
  assert.deepEqual(collapseAndSplit(input, ANY), {
    complete: input,
    partial: "",
    dropped: 0,
  });
});

test("keeps only the last of many frames", () => {
  const frames = Array.from({ length: 10 }, (_, i) => frame(`P${i}`));
  const r = collapseAndSplit(frames.join(""), ANY);
  assert.equal(r.complete, frames[frames.length - 1]);
  assert.equal(r.partial, "");
});

test("does not drop when the successor is too small to be a full repaint", () => {
  // A homing but tiny successor (e.g. HOME + one changed cell) does not prove a
  // full-screen repaint, so the earlier frame's other changes must survive.
  const a = frame("AAAAAAAAAAAAAAAAAAAA");
  const smallSuccessor = frame("x"); // content well under the threshold
  const input = a + smallSuccessor;
  const threshold = 100;
  assert.deepEqual(collapseAndSplit(input, threshold), {
    complete: input,
    partial: "",
    dropped: 0,
  });
});

test("drops when the successor clears the full-repaint size threshold", () => {
  const a = frame("A");
  const bigPaint = "y".repeat(200);
  const bigSuccessor = frame(bigPaint); // content over the threshold
  const input = a + bigSuccessor;
  const r = collapseAndSplit(input, 100);
  assert.equal(r.complete, bigSuccessor);
  assert.equal(r.dropped, a.length);
});

test("ingress apportioning always sums back to the total", () => {
  const cases: Array<[number, number, number, number, number]> = [
    // total, totalChars, forwardChars, droppedChars, heldChars
    [1000, 1000, 400, 400, 200],
    [1500, 1000, 400, 400, 200], // ingress != chars (plugin expanded the chunk)
    [700, 1000, 400, 400, 200], // ingress != chars (plugin contracted the chunk)
    [999, 1000, 333, 333, 334], // rounding stress
    [0, 0, 0, 0, 0], // empty
    [500, 500, 0, 0, 500], // all held
    [500, 500, 500, 0, 0], // all forwarded
    [500, 500, 0, 500, 0], // all dropped
  ];
  for (const [total, totalChars, fwd, drop, held] of cases) {
    const s = apportionFrameGateIngress(total, totalChars, fwd, drop, held);
    assert.equal(
      s.forward + s.dropped + s.held,
      total,
      `parts must sum to total for ${JSON.stringify([total, totalChars, fwd, drop, held])}`,
    );
    assert.ok(s.forward >= 0 && s.dropped >= 0 && s.held >= 0, "no negative shares");
  }
});

test("ingress apportioning routes bytes to the right bucket in the exact case", () => {
  // ingress == chars: shares equal the character counts.
  assert.deepEqual(apportionFrameGateIngress(1000, 1000, 400, 400, 200), {
    forward: 400,
    dropped: 400,
    held: 200,
  });
});
