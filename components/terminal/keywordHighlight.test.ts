import assert from "node:assert/strict";
import test from "node:test";

import { createRequire } from "node:module";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Terminal as XTermType } from "@xterm/xterm";
import {
  getVisibleTerminalLineTimestampRows,
  writeTerminalDataWithLineTimestamps,
} from "./runtime/terminalLineTimestamps.ts";
import { noteTerminalOutputPressureData } from "./runtime/terminalOutputPressure.ts";

import {
  KeywordHighlighter,
  KeywordHighlightTransformer,
} from "./keywordHighlight.ts";

const require = createRequire(import.meta.url);
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: typeof SerializeAddonType;
};
const { Terminal: XTerm } = require("@xterm/xterm") as {
  Terminal: typeof XTermType;
};

const RED = "\x1b[38;2;248;113;113m";
const rule = (color = "#F87171") => [{
  id: "error",
  label: "Error",
  patterns: ["ERROR"],
  color,
  enabled: true,
}];

const write = (term: XTermType, data: string): Promise<void> => new Promise((resolve) => {
  term.write(data, resolve);
});

test("new output is colored inline without decorations", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(
    transformer.transform("plain ERROR text"),
    `plain ${RED}ERROR\x1b[39m text`,
  );
});

test("terminal control payloads are never searched and split controls stay intact", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(transformer.transform("\x1b]0;ERROR"), "\x1b]0;ERROR");
  assert.equal(
    transformer.transform(" title\x07ERROR"),
    ` title\x07${RED}ERROR\x1b[39m`,
  );
  assert.equal(transformer.transform("\x1b[3"), "\x1b[3");
  assert.equal(
    transformer.transform("1mERROR"),
    `1m${RED}ERROR\x1b[31m`,
    "the original foreground must be restored after a match",
  );
});

test("alternate-screen programs pass through without keyword coloring", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(
    transformer.transform("before ERROR\x1b[?1049hTUI ERROR\x1b[?1049lafter ERROR"),
    `before ${RED}ERROR\x1b[39m\x1b[?1049hTUI ERROR\x1b[?1049lafter ${RED}ERROR\x1b[39m`,
  );
});

test("overlapping expressions color each character at most once", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "overlap",
    label: "Overlap",
    patterns: ["\\[ERROR\\]", "ERROR"],
    color: "#F87171",
    enabled: true,
  }], true);

  assert.equal(transformer.transform("[ERROR]"), `${RED}[ERROR]\x1b[39m`);
});

test("line anchors are evaluated per output line", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "prompt",
    label: "Prompt",
    patterns: ["^#"],
    color: "#F87171",
    enabled: true,
  }], true);

  assert.equal(
    transformer.transform("# one\r\n# two"),
    `${RED}#\x1b[39m one\r\n${RED}#\x1b[39m two`,
  );
});

test("a start anchor does not match the middle of a line split across writes", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "prompt",
    label: "Prompt",
    patterns: ["^#"],
    color: "#F87171",
    enabled: true,
  }], true);

  assert.equal(transformer.transform("continued"), "continued");
  assert.equal(transformer.transform("# not-a-prompt"), "# not-a-prompt");
  assert.equal(
    transformer.transform("\r\n# prompt"),
    `\r\n${RED}#\x1b[39m prompt`,
  );
});

test("highlighting restores colon-form truecolor output", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(
    transformer.transform("\x1b[38:2::12:34:56mERROR text"),
    `\x1b[38:2::12:34:56m${RED}ERROR\x1b[38;2;12;34;56m text`,
  );
});

test("ordinary user rules are not capped at the plugin safety limit", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  const transformed = transformer.transform("ERROR ".repeat(300));
  assert.equal((transformed.match(/38;2;248;113;113m/g) ?? []).length, 300);
});

test("BEL inside DCS payload does not resume highlighting", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(
    transformer.transform("\x1bPbinary\x07ERROR\x1b\\ERROR"),
    `\x1bPbinary\x07ERROR\x1b\\${RED}ERROR\x1b[39m`,
  );
});

test("changing or disabling rules rebuilds existing history from pristine output", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);

  highlighter.setRules(rule(), true);
  await write(term, "first ERROR\r\nsecond ERROR");
  assert.match(visibleSerializer.serialize(), /38;2;248;113;113m/);
  assert.equal(
    highlighter.serializeAddon.serialize(),
    "first ERROR\r\nsecond ERROR",
    "saved history must never contain Netcatty's injected colors",
  );

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  const recolored = visibleSerializer.serialize();
  assert.match(recolored, /38;2;96;165;250m/);
  assert.doesNotMatch(recolored, /38;2;248;113;113m/);

  highlighter.setRules(rule("#60A5FA"), false);
  await highlighter.whenSettled();
  assert.equal(visibleSerializer.serialize(), "first ERROR\r\nsecond ERROR");

  highlighter.dispose();
  term.dispose();
});

test("ordinary Enter output does not revisit existing history", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "existing ERROR");
  const rebuildsBefore = highlighter.rebuildCount;

  await write(term, "\r\nplain prompt # ");

  assert.equal(highlighter.rebuildCount, rebuildsBefore);
  highlighter.dispose();
  term.dispose();
});

test("ordinary Enter does not rebuild a saturated scrollback", async () => {
  const term = new XTerm({ cols: 40, rows: 3, scrollback: 10 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const history = Array.from({ length: 20 }, (_, index) => `line-${index} ERROR`).join("\r\n");
  noteTerminalOutputPressureData(term, history);
  await write(term, history);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  const rebuildsBeforeEnter = highlighter.rebuildCount;

  const prompt = "\r\nplain prompt # ";
  noteTerminalOutputPressureData(term, prompt);
  await write(term, prompt);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();

  assert.equal(highlighter.rebuildCount, rebuildsBeforeEnter);
  highlighter.dispose();
  term.dispose();
});

test("byte output catches up once instead of staying permanently uncolored", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await new Promise<void>((resolve) => {
    term.write(new TextEncoder().encode("byte ERROR"), resolve);
  });
  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;248;113;113m/);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();

  assert.match(visibleSerializer.serialize(), /38;2;248;113;113m/);
  assert.equal(highlighter.rebuildCount, 1);
  highlighter.dispose();
  term.dispose();
});

test("large output can bypass per-write coloring and is still recolored on a rule change", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  let bypass = true;
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => bypass,
  });
  highlighter.setRules(rule(), true);
  await write(term, `${"ERROR ".repeat(100)}tail`);
  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;/);

  bypass = false;
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.match(visibleSerializer.serialize(), /38;2;96;165;250m/);

  highlighter.dispose();
  term.dispose();
});

test("output arriving during a history rebuild is appended after the rebuilt history", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  const concurrentWrite = write(term, "\r\nnew ERROR");
  await Promise.all([highlighter.whenSettled(), concurrentWrite]);

  const result = visibleSerializer.serialize();
  assert.match(result, /old/);
  assert.match(result, /new/);
  assert.equal((result.match(/38;2;96;165;250m/g) ?? []).length, 2);
  highlighter.dispose();
  term.dispose();
});

test("rule changes wait until the terminal leaves the alternate screen", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "shell ERROR\x1b[?1049hTUI ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(term.buffer.active.type, "alternate");
  assert.equal(highlighter.rebuildCount, 0);

  await write(term, "\x1b[?1049l");
  await highlighter.whenSettled();
  assert.equal(term.buffer.active.type, "normal");
  assert.equal(highlighter.rebuildCount, 1);
  assert.match(visibleSerializer.serialize(), /38;2;96;165;250m/);
  highlighter.dispose();
  term.dispose();
});

test("application reset clears pristine history together with the visible terminal", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old ERROR");

  term.reset();
  await write(term, "new plain");
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.equal(visibleSerializer.serialize(), "new plain");
  assert.equal(highlighter.serializeAddon.serialize(), "new plain");
  highlighter.dispose();
  term.dispose();
});

test("history rebuild waits while a non-text terminal resource blocks reset", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  let blocked = true;
  const highlighter = new KeywordHighlighter(term, { canRebuild: () => !blocked });
  highlighter.setRules(rule(), true);
  await write(term, "old ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(highlighter.rebuildCount, 0);

  blocked = false;
  await write(term, "");
  await highlighter.whenSettled();
  assert.equal(highlighter.rebuildCount, 1);
  highlighter.dispose();
  term.dispose();
});

test("bulk output skipped on the hot path is highlighted after output becomes quiet", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  let bypass = true;
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => bypass,
  });
  highlighter.setRules(rule(), true);
  await write(term, "bulk ERROR");
  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;/);

  bypass = false;
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();
  assert.match(visibleSerializer.serialize(), /38;2;248;113;113m/);

  highlighter.dispose();
  term.dispose();
});

test("rule changes keep scrollback position", async () => {
  const term = new XTerm({ cols: 20, rows: 3, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, Array.from({ length: 10 }, (_, index) => `line-${index} ERROR`).join("\r\n"));
  term.scrollToLine(3);

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.equal(term.buffer.normal.viewportY, 3);
  highlighter.dispose();
  term.dispose();
});

test("rule changes preserve existing line timestamps", async () => {
  const term = new XTerm({ cols: 20, rows: 3, scrollback: 100, allowProposedApi: true });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await new Promise<void>((resolve) => {
    writeTerminalDataWithLineTimestamps(term, "first ERROR\r\n", resolve, {
      timestampDate: new Date(2026, 7, 13, 12, 34, 56),
    });
  });
  assert.equal(getVisibleTerminalLineTimestampRows(term)[0]?.label, "12:34:56");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.equal(getVisibleTerminalLineTimestampRows(term)[0]?.label, "12:34:56");
  highlighter.dispose();
  term.dispose();
});

test("terminal reset wins over an in-flight rule rebuild", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "stale ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  term.reset();
  await write(term, "fresh plain");
  await highlighter.whenSettled();

  assert.equal(visibleSerializer.serialize(), "fresh plain");
  highlighter.dispose();
  term.dispose();
});
