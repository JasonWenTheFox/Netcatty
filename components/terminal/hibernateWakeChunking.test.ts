import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import xterm from "@xterm/xterm";
import type { Terminal as XTerm } from "@xterm/xterm";

import { applyHibernateWakeToTerminal } from "./terminalHibernateRuntime.ts";
import { writeTerminalPayloadChunked } from "./terminalReplay.ts";

const { Terminal } = xterm;

const readActiveBufferText = (term: XTerm): string => {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
};

const writeAndWait = (term: XTerm, data: string): Promise<void> =>
  new Promise((resolve) => {
    term.write(data, () => resolve());
  });

test("writeTerminalPayloadChunked splits large buffers (shipped wake helper)", async () => {
  const writes: string[] = [];
  const term = {
    write: (data: string, cb: () => void) => {
      writes.push(data);
      cb();
    },
  } as unknown as XTerm;

  const payload = "y".repeat(50_000);
  await writeTerminalPayloadChunked(term, payload, { chunkBytes: 8_192 });
  assert.ok(writes.length >= 2, `expected multiple chunks, got ${writes.length}`);
  assert.equal(writes.join(""), payload);
});

test("applyHibernateWakeToTerminal replays scrollback before viewport without idle append", async () => {
  const writes: string[] = [];
  const term = {
    rows: 24,
    write: (data: string, cb?: () => void) => {
      writes.push(data);
      cb?.();
    },
    refresh: () => {},
  } as unknown as XTerm;

  const runtime = {
    ensureWebglRenderer: () => {},
    clearTextureAtlas: () => {},
  };

  let idleScheduled = false;
  const originalRic = globalThis.requestIdleCallback;
  // @ts-expect-error test override
  globalThis.requestIdleCallback = (cb: () => void) => {
    idleScheduled = true;
    setTimeout(cb, 0);
    return 1;
  };

  try {
    const viewport = "VIEWPORT_END\r\n";
    const scrollback = "SCROLLBACK_START\r\n";
    const pending = "PENDING_TAIL\r\n";
    await applyHibernateWakeToTerminal(
      term,
      runtime as never,
      {
        snapshot: `${scrollback}${viewport}`,
        viewportSnapshot: viewport,
        scrollbackSnapshot: scrollback,
        pendingBuffer: pending,
        alternateScreen: false,
      },
      { replayOptions: { chunkBytes: 8_192 } },
    );

    const joined = writes.join("");
    assert.equal(joined, `${scrollback}${viewport}${pending}`);
    assert.equal(
      idleScheduled,
      false,
      "scrollback must not be deferred to idle after viewport (append would evict the end)",
    );
  } finally {
    if (originalRic) {
      globalThis.requestIdleCallback = originalRic;
    } else {
      // @ts-expect-error cleanup
      delete globalThis.requestIdleCallback;
    }
  }
});

test("hibernate wake keeps the newest viewport rows under a finite scrollback cap", async () => {
  // #2762: appending older scrollback after viewport under scrollback=N evicts the
  // newest rows (the just-restored viewport). Replay must be scrollback → viewport.
  const rows = 5;
  const scrollbackCap = 10;
  const term = new Terminal({
    cols: 40,
    rows,
    scrollback: scrollbackCap,
    allowProposedApi: true,
  });

  const runtime = {
    ensureWebglRenderer: () => {},
    clearTextureAtlas: () => {},
  };

  try {
    const olderLines = Array.from({ length: scrollbackCap }, (_, index) => `old-${index}`);
    const newestLines = Array.from({ length: rows }, (_, index) => `new-${index}`);
    const scrollback = `${olderLines.join("\r\n")}\r\n`;
    const viewport = `${newestLines.join("\r\n")}\r\n`;

    await applyHibernateWakeToTerminal(
      term,
      runtime as never,
      {
        snapshot: `${scrollback}${viewport}`,
        viewportSnapshot: viewport,
        scrollbackSnapshot: scrollback,
        pendingBuffer: "",
        alternateScreen: false,
      },
      { replayOptions: { chunkBytes: 1024 } },
    );

    // Drain any stray idle work the old buggy path might have scheduled.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const text = readActiveBufferText(term);
    for (const line of newestLines) {
      assert.match(text, new RegExp(line), `newest viewport line missing after wake: ${line}`);
    }
    assert.match(text, /old-/, "some older scrollback should still be present");
  } finally {
    term.dispose();
  }
});

test("wrong wake order (viewport then scrollback append) drops newest rows under scrollback cap", async () => {
  // Guardrail: documents why idle-append-after-viewport is unsafe.
  const rows = 5;
  const scrollbackCap = 10;
  const term = new Terminal({
    cols: 40,
    rows,
    scrollback: scrollbackCap,
    allowProposedApi: true,
  });

  try {
    // Overflow by a full viewport so every newest row is trimmed as oldest.
    const olderLines = Array.from({ length: scrollbackCap + rows }, (_, index) => `old-${index}`);
    const newestLines = Array.from({ length: rows }, (_, index) => `new-${index}`);
    await writeAndWait(term, `${newestLines.join("\r\n")}\r\n`);
    await writeAndWait(term, `${olderLines.join("\r\n")}\r\n`);

    const text = readActiveBufferText(term);
    for (const line of newestLines) {
      assert.equal(
        text.includes(line),
        false,
        `viewport-first append must evict newest line under the cap: ${line}`,
      );
    }
    assert.match(text, /old-14/);
  } finally {
    term.dispose();
  }
});
test("hibernate runtime source replays scrollback before viewport on the wake path", () => {
  const source = readFileSync(new URL("./terminalHibernateRuntime.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /writeTerminalReplaySequence\(\s*term,\s*\[\s*scrollback,\s*viewport,\s*payload\.pendingBuffer\s*\]/,
  );
  assert.doesNotMatch(
    source,
    /scheduleIdle\(\(\)\s*=>\s*\{\s*void writeTerminalPayloadChunked\(term, scrollback/,
  );
});
