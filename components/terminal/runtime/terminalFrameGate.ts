/**
 * Frame-rate gate for full-screen animated TUIs.
 *
 * A TUI like TryIt.jl emits every frame as a DEC 2026 synchronized-output block
 * that homes the cursor and repaints every cell:
 *
 *   ESC[?2026h  ESC[1;1H  <every cell rewritten with SGR>  ESC[?2026l
 *
 * At ~60 fps each frame is ~140 KB. xterm.js can render that rate, but only if
 * it is never more than a frame or two behind — otherwise frames queue up and
 * the display (and the keyboard echo waiting behind it) runs up to a second
 * late. The flow-control watermark bounds that backlog by *pausing* the source,
 * which throttles the animation's frame rate. This gate instead bounds it by
 * *dropping* superseded frames: when several full-repaint frames are buffered,
 * only the last is visible (the next repaints every cell the previous drew), so
 * the earlier ones can be skipped. The source is never paused, so the animation
 * keeps its full rate while the backlog — and the latency — stays small.
 *
 * This module is the pure buffer transform. It has no state and no side
 * effects; the caller owns the per-terminal buffer and the accounting.
 */

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const CSI = "\x1b[";

/** A CUP/HVP param list resolves to the top-left cell (row/col 1, default, or 0). */
const isHomeParams = (params: string): boolean => {
  const parts = params.split(";");
  if (parts.length > 2) return false;
  return parts.every((p) => p === "" || p === "0" || p === "1");
};

/** True when `content` begins by homing the cursor to the top-left. */
const startsWithCursorHome = (content: string): boolean => {
  if (!content.startsWith(CSI)) return false;
  let i = CSI.length;
  while (i < content.length) {
    const c = content.charCodeAt(i);
    if ((c >= 0x30 && c <= 0x39) || c === 0x3b) i++; // digits and ';'
    else break;
  }
  const final = content[i];
  return (final === "H" || final === "f") && isHomeParams(content.slice(CSI.length, i));
};

/**
 * A frame's payload is a pure visual repaint: only cursor moves, SGR and cell
 * text. Rejects OSC (`ESC]`) and private-mode set/reset (`ESC[?…`, which
 * includes alternate-screen switches) — state a successor would not restore, so
 * such a frame must never be dropped.
 */
const isPureVisualPayload = (content: string): boolean =>
  !content.includes("\x1b]") && !content.includes("\x1b[?");

type Frame = { start: number; end: number; content: string };

/**
 * Result of {@link collapseAndSplit}:
 * - `complete`  — the leading, collapsed run of complete frames, ready to write.
 * - `partial`   — a trailing, not-yet-closed frame to keep buffering.
 * - `dropped`   — characters removed from `complete` by collapsing.
 */
export type FrameGateSplit = { complete: string; partial: string; dropped: number };

/** Exact three-way split of buffered ingress bytes; parts always sum to `total`. */
export type FrameGateIngressSplit = { forward: number; dropped: number; held: number };

/**
 * Apportion `total` flow-control ingress bytes across the forwarded, dropped and
 * still-held parts of a buffer, by character share. Each share is the exact
 * complement of the rounded parts before it, so the three always sum back to
 * `total` regardless of rounding — the backend is never over- or
 * under-acknowledged even when a chunk's ingress differs from its length.
 */
export const apportionFrameGateIngress = (
  total: number,
  totalChars: number,
  forwardChars: number,
  droppedChars: number,
  heldChars: number,
): FrameGateIngressSplit => {
  const held = totalChars > 0 ? Math.round((total * heldChars) / totalChars) : 0;
  const leaving = total - held;
  const leavingChars = forwardChars + droppedChars;
  const forward = leavingChars > 0 ? Math.round((leaving * forwardChars) / leavingChars) : 0;
  const dropped = leaving - forward;
  return { forward, dropped, held };
};

/**
 * Split `buffer` into its complete-frame prefix and a trailing incomplete
 * frame, collapsing runs of superseded full-repaint frames in the prefix down
 * to the last.
 *
 * A frame is dropped only when it is a pure visual repaint AND the frame
 * directly after it *demonstrably repaints the whole screen*: it homes the
 * cursor and carries at least `minSuccessorRepaintBytes` of payload. Homing
 * alone is not enough — DEC 2026 only makes an update atomic, it does not imply
 * a full repaint, and a valid incremental successor (`HOME` + one changed cell)
 * would otherwise discard the earlier frame's changes elsewhere. A real
 * full-screen repaint writes at least one byte per cell, so a viewport-sized
 * threshold (`cols * rows`) separates it from a small incremental update.
 * Everything the transform is unsure about is preserved verbatim.
 */
export const collapseAndSplit = (
  buffer: string,
  minSuccessorRepaintBytes: number,
): FrameGateSplit => {
  // Locate every complete frame; note where an unterminated trailing frame begins.
  const frames: Frame[] = [];
  let cursor = 0;
  let partialStart = buffer.length;
  while (true) {
    const on = buffer.indexOf(SYNC_ON, cursor);
    if (on < 0) break;
    const contentStart = on + SYNC_ON.length;
    const off = buffer.indexOf(SYNC_OFF, contentStart);
    if (off < 0) {
      partialStart = on; // trailing frame opened but not closed yet
      break;
    }
    const end = off + SYNC_OFF.length;
    frames.push({ start: on, end, content: buffer.slice(contentStart, off) });
    cursor = end;
  }

  const partial = buffer.slice(partialStart);
  const completeRegion = buffer.slice(0, partialStart);

  if (frames.length < 2) {
    return { complete: completeRegion, partial, dropped: 0 };
  }

  // Mark a frame droppable when it is a pure visual repaint, the next frame is
  // directly adjacent, and that next frame fully repaints the screen.
  const drop = new Array<boolean>(frames.length).fill(false);
  for (let i = 0; i < frames.length - 1; i++) {
    const cur = frames[i];
    const next = frames[i + 1];
    if (
      next.start === cur.end
      && isPureVisualPayload(cur.content)
      && startsWithCursorHome(next.content)
      && next.content.length >= minSuccessorRepaintBytes
    ) {
      drop[i] = true;
    }
  }
  if (!drop.some(Boolean)) {
    return { complete: completeRegion, partial, dropped: 0 };
  }

  let complete = "";
  let dropped = 0;
  let pos = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    complete += completeRegion.slice(pos, f.start); // bytes before the frame
    if (drop[i]) dropped += f.end - f.start;
    else complete += completeRegion.slice(f.start, f.end);
    pos = f.end;
  }
  complete += completeRegion.slice(pos);
  return { complete, partial, dropped };
};
