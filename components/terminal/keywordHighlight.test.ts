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
import {
  clearTerminalViewport,
  installEraseInDisplayHandlers,
  registerTerminalViewportScrollMirror,
} from "./clearTerminalViewport.ts";

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

test("string terminators split across writes resume highlighting", () => {
  for (const start of ["\x1b]0;title\x1b", "\x1bPpayload\x1b"]) {
    const transformer = new KeywordHighlightTransformer();
    transformer.setRules(rule(), true);

    assert.equal(transformer.transform(start), start);
    assert.equal(transformer.transform("\\"), "\\");
    assert.equal(transformer.transform("ERROR"), `${RED}ERROR\x1b[39m`);
  }
});

test("repeated ESC at a split string boundary stays inside the control payload", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(transformer.transform("\x1b]0;title\x1b"), "\x1b]0;title\x1b");
  assert.equal(transformer.transform("\x1b\\"), "\x1b\\");
  assert.equal(transformer.transform("ERROR"), `${RED}ERROR\x1b[39m`);
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

test("charset ESC sequences stay out of searchable text", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "prompt",
    label: "Prompt",
    patterns: ["^OK"],
    color: "#F87171",
    enabled: true,
  }], true);

  assert.equal(
    transformer.transform("\x1b(BOK"),
    `\x1b(B${RED}OK\x1b[39m`,
  );
});

test("broad user rules do not insert SGR between surrogate halves", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "dot",
    label: "Dot",
    patterns: ["."],
    color: "#F87171",
    enabled: true,
  }], true);

  const emoji = "😀";
  assert.equal(
    transformer.transform(`${emoji}\n`),
    `${RED}${emoji}\x1b[39m\n`,
  );
});

test("broad user rules color combining and ZWJ graphemes atomically", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "dot",
    label: "Dot",
    patterns: ["."],
    color: "#F87171",
    enabled: true,
  }], true);

  for (const grapheme of ["e\u0301", "👨‍👩‍👧‍👦"]) {
    assert.equal(
      transformer.transform(`${grapheme}\n`),
      `${RED}${grapheme}\x1b[39m\n`,
    );
  }
});

test("a grapheme joined across writes is deferred for atomic catch-up", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "dot",
    label: "Dot",
    patterns: ["."],
    color: "#F87171",
    enabled: true,
  }], true);

  assert.equal(transformer.transform("e"), `${RED}e\x1b[39m`);
  assert.equal(transformer.transform("\u0301"), "\u0301");
  assert.equal(transformer.takeMissedBoundaryMatch(), true);
});

test("broad user rules do not insert SGR into a surrogate pair split across writes", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "dot",
    label: "Dot",
    patterns: ["."],
    color: "#F87171",
    enabled: true,
  }], true);

  const emoji = "😀";
  assert.equal(transformer.transform(emoji[0]), emoji[0]);
  assert.equal(transformer.transform(emoji[1]), emoji[1]);
  assert.equal(transformer.takeMissedBoundaryMatch(), true);
});

test("a surrogate pair split across terminal writes remains one glyph after catch-up", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules([{
    id: "dot",
    label: "Dot",
    patterns: ["."],
    color: "#F87171",
    enabled: true,
  }], true);
  const emoji = "😀";

  await write(term, emoji[0]);
  await write(term, emoji[1]);
  await highlighter.whenSettled();

  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), emoji);
  const serialized = visibleSerializer.serialize();
  assert.equal(serialized.includes(emoji), true);
  assert.equal(serialized.includes(emoji[0] + RED + emoji[1]), false);
  highlighter.dispose();
  term.dispose();
});

test("leaving the alternate screen restores the normal-screen foreground", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(
    transformer.transform("\x1b[31mnormal\x1b[?1049h\x1b[34malt\x1b[?1049lERROR"),
    `\x1b[31mnormal\x1b[?1049h\x1b[34malt\x1b[?1049l${RED}ERROR\x1b[31m`,
  );
});

test("cursor save and restore controls also restore the foreground", () => {
  for (const [save, restore] of [
    ["\x1b7", "\x1b8"],
    ["\x1b[s", "\x1b[u"],
    ["\x1b[?1048h", "\x1b[?1048l"],
    ["\x1b[?1049h", "\x1b[?1049l"],
  ]) {
    const transformer = new KeywordHighlightTransformer();
    transformer.setRules(rule(), true);
    assert.equal(
      transformer.transform(`\x1b[31m${save}\x1b[34m${restore}ERROR`),
      `\x1b[31m${save}\x1b[34m${restore}${RED}ERROR\x1b[31m`,
    );
  }
});

test("normal and alternate screens keep independent saved foregrounds", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(
    transformer.transform(
      "\x1b[31m\x1b7\x1b[?1049h\x1b[34m\x1b7\x1b[32m\x1b8alt\x1b[?1049lERROR",
    ),
    "\x1b[31m\x1b7\x1b[?1049h\x1b[34m\x1b7\x1b[32m\x1b8alt\x1b[?1049l"
      + `${RED}ERROR\x1b[31m`,
  );
});

test("soft terminal reset restores the default foreground", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules(rule(), true);

  assert.equal(
    transformer.transform("\x1b[34mblue\x1b[!pERROR"),
    `\x1b[34mblue\x1b[!p${RED}ERROR\x1b[39m`,
  );
});

test("end-sensitive rules wait for a complete line before coloring", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "error",
    label: "Error",
    patterns: ["\\berror\\b"],
    color: "#F87171",
    enabled: true,
  }], true);

  assert.equal(transformer.transform("error"), "error");
  assert.equal(transformer.takeMissedBoundaryMatch(), true);
  assert.equal(transformer.transform("Code"), "Code");
  assert.equal(
    transformer.transform("\r\nerror done\n"),
    `\r\n${RED}error\x1b[39m done\n`,
  );
});

test("settings-accepted escapes without Unicode mode still compile", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "hash",
    label: "Hash",
    patterns: ["\\#"],
    color: "#F87171",
    enabled: true,
  }], true);

  assert.equal(transformer.transform("#tag\n"), `${RED}#\x1b[39mtag\n`);
});

test("keywords split across ordinary writes are recolored after catch-up", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await write(term, "ER");
  await write(term, "ROR");
  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;248;113;113m/);

  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();

  assert.match(visibleSerializer.serialize(), /38;2;248;113;113mERROR/);
  assert.equal(highlighter.rebuildCount, 1);
  highlighter.dispose();
  term.dispose();
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

test("a rule change does not rebuild while an already queued control is incomplete", async () => {
  for (const [start, finish] of [
    ["seed ERROR\x1b[", "31mX"],
    ["seed ERROR\x1b]0;title", "\x07X"],
    ["seed ERROR\x1bPpayload", "\x1b\\X"],
  ]) {
    const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
    const highlighter = new KeywordHighlighter(term);
    highlighter.setRules(rule(), true);
    term.write(start);
    highlighter.setRules(rule("#60A5FA"), true);
    await highlighter.whenSettled();
    assert.equal(highlighter.rebuildCount, 0);

    await write(term, finish);
    await highlighter.whenSettled();
    assert.equal(highlighter.rebuildCount, 1);
    assert.doesNotMatch(
      term.buffer.active.getLine(0)?.translateToString(true) ?? "",
      /(?:31m|title|payload)/,
    );
    highlighter.dispose();
    term.dispose();
  }
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

test("rule changes wait for a control sequence split across writes", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "seed ERROR\x1b[");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(highlighter.rebuildCount, 0);
  await write(term, "31mX");
  await highlighter.whenSettled();

  assert.equal(highlighter.rebuildCount, 1);
  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "seed ERRORX");
  assert.equal(term.buffer.active.getLine(0)?.getCell(10)?.getFgColor(), 1);
  highlighter.dispose();
  term.dispose();
});

test("rule changes wait for a string control split across writes", async () => {
  for (const [start, end] of [
    ["\x1b]0;title", "\x07"],
    ["\x1bPpayload", "\x1b\\"],
  ]) {
    const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
    const highlighter = new KeywordHighlighter(term);
    highlighter.setRules(rule(), true);
    await write(term, `seed ERROR${start}`);

    highlighter.setRules(rule("#60A5FA"), true);
    await highlighter.whenSettled();
    assert.equal(highlighter.rebuildCount, 0);
    await write(term, `${end}X`);
    await highlighter.whenSettled();

    assert.equal(highlighter.rebuildCount, 1);
    assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "seed ERRORX");
    highlighter.dispose();
    term.dispose();
  }
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
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  let blocked = true;
  const highlighter = new KeywordHighlighter(term, { canRebuild: () => !blocked });
  highlighter.setRules(rule(), true);
  await write(term, "old ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(highlighter.rebuildCount, 0);

  await write(term, "\r\nfresh ERROR");
  assert.match(visibleSerializer.serialize(), /38;2;96;165;250m/);

  blocked = false;
  await write(term, "");
  await highlighter.whenSettled();
  assert.equal(highlighter.rebuildCount, 1);
  highlighter.dispose();
  term.dispose();
});

test("blocked image rebuild keeps the current foreground and screen state", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  let blocked = true;
  const highlighter = new KeywordHighlighter(term, { canRebuild: () => !blocked });
  highlighter.setRules(rule(), true);
  await write(term, "\x1b[32mgreen\x1b[?1049hTUI");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  await write(term, " ERROR\x1b[?1049lERROR");

  assert.equal(term.buffer.active.type, "normal");
  assert.equal(highlighter.rebuildCount, 0);
  assert.equal(
    visibleSerializer.serialize().includes(`38;2;96;165;250mERROR${String.fromCharCode(27)}[32m`),
    true,
  );
  blocked = false;
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

test("deferred pristine history applies high and low water backpressure", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term, { shouldBypassHighlight: () => true });
  highlighter.setRules(rule(), true);
  const payload = "x".repeat(1024 * 1024);
  let callbacks = 0;
  for (let index = 0; index < 10; index += 1) {
    term.write(payload, () => { callbacks += 1; });
  }

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(highlighter.pendingPristineBytes <= 12 * 1024 * 1024, true);
  await highlighter.waitForPristineBackpressure();
  assert.equal(highlighter.pendingPristineBytes <= 4 * 1024 * 1024, true);
  assert.equal(callbacks, 10, "visible writes must not wait for pristine catch-up");

  highlighter.dispose();
  term.dispose();
});

test("a single large pristine flush counts toward backpressure", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term, { shouldBypassHighlight: () => true });
  highlighter.setRules(rule(), true);
  const payload = "x".repeat(9 * 1024 * 1024);

  term.write(payload);
  assert.equal(highlighter.isPristineBackpressured, true);
  assert.equal(highlighter.pendingPristineBytes >= payload.length, true);
  await highlighter.waitForPristineBackpressure();
  assert.equal(highlighter.pendingPristineBytes <= 4 * 1024 * 1024, true);

  highlighter.dispose();
  term.dispose();
});

test("rule changes during bulk output wait for one quiet catch-up", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  let bypass = true;
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => bypass,
  });
  highlighter.setRules(rule(), true);
  await write(term, "bulk ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  assert.equal(highlighter.rebuildCount, 0);
  bypass = false;
  await highlighter.whenSettled();

  assert.equal(highlighter.rebuildCount, 1);
  assert.match(visibleSerializer.serialize(), /38;2;96;165;250m/);
  highlighter.dispose();
  term.dispose();
});

test("disabling rules during bulk output removes existing colors after quiet", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  let bypass = false;
  const highlighter = new KeywordHighlighter(term, {
    shouldBypassHighlight: () => bypass,
  });
  highlighter.setRules(rule(), true);
  await write(term, "old ERROR");
  assert.match(visibleSerializer.serialize(), /38;2;248;113;113m/);

  bypass = true;
  await write(term, "\r\nbulk plain");
  highlighter.setRules(rule(), false);
  bypass = false;
  await highlighter.whenSettled();

  assert.equal(highlighter.rebuildCount, 1);
  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;248;113;113m/);
  highlighter.dispose();
  term.dispose();
});

test("bare carriage-return rewrites are corrected after output becomes quiet", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  await write(term, "ERROR\rOK");
  await new Promise((resolve) => setTimeout(resolve, 650));
  await highlighter.whenSettled();

  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;248;113;113m/);
  highlighter.dispose();
  term.dispose();
});

test("backspace and cursor rewrites are corrected after output becomes quiet", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);

  for (const payload of [
    "ERROR\bOK",
    "\r\nERROR\x1b[5DOK",
    "\r\nERROR\x1b[2ZOK",
    "\r\nERROR\x9b2ZOK",
  ] as const) {
    await write(term, payload);
    await new Promise((resolve) => setTimeout(resolve, 650));
    await highlighter.whenSettled();
  }

  assert.doesNotMatch(visibleSerializer.serialize(), /38;2;248;113;113m/);
  highlighter.dispose();
  term.dispose();
});

test("plugin scans reserve their bounded budget for newly written text", () => {
  const transformer = new KeywordHighlightTransformer();
  transformer.setRules([{
    id: "plugin-error",
    label: "Plugin error",
    patterns: ["ERROR"],
    color: "#F87171",
    enabled: true,
    providerId: "test-plugin",
  }], true);

  transformer.transform("x".repeat(4096));
  assert.equal(transformer.transform("ERROR"), `${RED}ERROR\x1b[39m`);
});

test("clear keeps pristine history aligned with the visible terminal", async () => {
  const term = new XTerm({ cols: 80, rows: 3, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "old ERROR\r\nold two\r\nold three");

  term.clear();
  await write(term, "new plain");
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  const visible = visibleSerializer.serialize();
  assert.doesNotMatch(visible, /old ERROR|old two/);
  assert.match(visible, /new plain/);
  assert.equal(highlighter.serializeAddon.serialize(), "old threenew plain");
  highlighter.dispose();
  term.dispose();
});

test("clear does not treat the retained logical line as a fresh line start", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules([{ ...rule()[0], patterns: ["^new"] }], true);
  await write(term, "old");

  term.clear();
  await write(term, "new");
  await highlighter.whenSettled();

  assert.equal(visibleSerializer.serialize(), "oldnew");
  highlighter.dispose();
  term.dispose();
});

test("local viewport clear mirrors its pre-scroll into pristine history", async () => {
  const term = new XTerm({ cols: 80, rows: 3, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  const mirror = registerTerminalViewportScrollMirror(
    term,
    (lines) => highlighter.mirrorViewportScroll(lines),
  );
  highlighter.setRules(rule(), true);
  await write(term, "one ERROR\r\ntwo ERROR\r\nthree ERROR");

  assert.equal(clearTerminalViewport(term), true);
  await new Promise((resolve) => term.write("", resolve));
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  const pristine = highlighter.serializeAddon.serialize();
  const visible = visibleSerializer.serialize();
  assert.match(pristine, /one ERROR/);
  assert.match(pristine, /three ERROR/);
  const csiPattern = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*[A-Za-z]`, "g");
  assert.equal(pristine.replace(csiPattern, ""), visible.replace(csiPattern, ""));
  mirror.dispose();
  highlighter.dispose();
  term.dispose();
});

test("shell clear preservation is mirrored into pristine history", async () => {
  const term = new XTerm({ cols: 80, rows: 3, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  const mirror = registerTerminalViewportScrollMirror(
    term,
    (lines) => highlighter.mirrorViewportScroll(lines),
  );
  const eraseHandlers = installEraseInDisplayHandlers(term, {
    getClearWipesScrollback: () => false,
    isInDec2026SyncBlock: () => false,
    scheduleMicrotask: (callback) => callback(),
  });
  highlighter.setRules(rule(), true);
  await write(term, "one ERROR\r\ntwo ERROR\r\nthree ERROR");

  await write(term, "\x1b[2J\x1b[Hnew plain");
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  const pristine = highlighter.serializeAddon.serialize();
  const visible = visibleSerializer.serialize();
  for (const text of ["one ERROR", "two ERROR", "three ERROR", "new plain"]) {
    assert.match(pristine, new RegExp(text));
    assert.match(visible.replace(new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "g"), ""), new RegExp(text));
  }
  eraseHandlers.dispose();
  mirror.dispose();
  highlighter.dispose();
  term.dispose();
});

test("preserved CSI 3J leaves visible and pristine history intact", async () => {
  const term = new XTerm({ cols: 80, rows: 3, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term, { shouldPreserveScrollback: () => true });
  const eraseHandlers = installEraseInDisplayHandlers(term, {
    getClearWipesScrollback: () => false,
    isInDec2026SyncBlock: () => false,
  });
  highlighter.setRules(rule(), true);
  await write(term, "one ERROR\r\ntwo ERROR\r\nthree ERROR\r\nfour ERROR");

  await write(term, "\x1b[3Jnew plain");
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  const sgrPattern = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "g");
  const stripSgr = (snapshot: string) => snapshot.replace(sgrPattern, "");
  for (const snapshot of [visibleSerializer.serialize(), highlighter.serializeAddon.serialize()]) {
    assert.match(stripSgr(snapshot), /one ERROR/);
    assert.match(stripSgr(snapshot), /four ERRORnew plain/);
  }
  eraseHandlers.dispose();
  highlighter.dispose();
  term.dispose();
});

test("shell erase-below wipe is mirrored into pristine history", async () => {
  const term = new XTerm({ cols: 80, rows: 3, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  const mirror = registerTerminalViewportScrollMirror(
    term,
    (lines) => highlighter.mirrorViewportScroll(lines),
    () => highlighter.mirrorScrollbackWipe(),
  );
  const eraseHandlers = installEraseInDisplayHandlers(term, {
    getClearWipesScrollback: () => true,
    isInDec2026SyncBlock: () => false,
    scheduleMicrotask: (callback) => callback(),
  });
  highlighter.setRules(rule(), true);
  await write(term, "old1 ERROR\r\nold2 ERROR\r\nold3 ERROR\r\nold4 ERROR");

  await write(term, "\x1b[H\x1b[Jnew plain");
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  for (const snapshot of [visibleSerializer.serialize(), highlighter.serializeAddon.serialize()]) {
    assert.doesNotMatch(snapshot, /old[1-4]/);
    assert.match(snapshot, /new plain/);
  }
  eraseHandlers.dispose();
  mirror.dispose();
  highlighter.dispose();
  term.dispose();
});

test("lowering scrollback is reflected before immediate serialization", async () => {
  const term = new XTerm({ cols: 80, rows: 3, scrollback: 20 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\r\n"));

  term.options.scrollback = 2;
  highlighter.syncScrollback();
  const pristine = highlighter.serializeAddon.serialize();

  assert.doesNotMatch(pristine, /line-0/);
  assert.match(pristine, /line-19/);
  assert.equal(highlighter.serializeAddon.serialize().split("\n").length <= 5, true);
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

test("long sliced rule rebuild preserves line timestamps", async () => {
  const term = new XTerm({ cols: 40, rows: 5, scrollback: 1500, allowProposedApi: true });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await new Promise<void>((resolve) => {
    writeTerminalDataWithLineTimestamps(
      term,
      Array.from({ length: 700 }, (_, index) => `line-${index} ERROR`).join("\r\n"),
      resolve,
      { timestampDate: new Date(2026, 7, 13, 12, 34, 56) },
    );
  });
  assert.equal(getVisibleTerminalLineTimestampRows(term)[0]?.label, "12:34:56");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.equal(getVisibleTerminalLineTimestampRows(term)[0]?.label, "12:34:56");
  highlighter.dispose();
  term.dispose();
});

test("resize waits for deferred pristine output to keep parser order", async () => {
  const term = new XTerm({ cols: 10, rows: 5, scrollback: 100 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  let bypass = true;
  const highlighter = new KeywordHighlighter(term, { shouldBypassHighlight: () => bypass });
  highlighter.setRules(rule(), true);
  await write(term, "abc\x1b[20CZZ ERROR");

  term.resize(20, 5);
  bypass = false;
  await highlighter.whenSettled();

  // eslint-disable-next-line no-control-regex -- terminal protocol bytes are intentional.
  const stripControls = (value: string) => value.replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, "");
  assert.equal(
    stripControls(highlighter.serializeAddon.serialize()),
    stripControls(visibleSerializer.serialize()),
  );
  assert.equal(term.cols, 20);
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

test("terminal reset wins after a sliced rebuild starts writing", async () => {
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 1000 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, Array.from({ length: 800 }, () => "old ERROR").join("\r\n"));

  highlighter.setRules(rule("#60A5FA"), true);
  await new Promise((resolve) => setTimeout(resolve, 1));
  term.reset();
  await write(term, "fresh plain");
  await highlighter.whenSettled();

  assert.equal(visibleSerializer.serialize(), "fresh plain");
  assert.equal(highlighter.serializeAddon.serialize(), "fresh plain");
  highlighter.dispose();
  term.dispose();
});

test("history rebuild keeps OSC 8 links clickable via the pristine buffer", async () => {
  type LinkProvider = {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: Array<{ text: string }> | undefined) => void,
    ): void;
  };
  const providers: LinkProvider[] = [];
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100, allowProposedApi: true });
  const originalRegister = term.registerLinkProvider.bind(term);
  term.registerLinkProvider = ((provider: LinkProvider) => {
    providers.push(provider);
    return originalRegister(provider);
  }) as typeof term.registerLinkProvider;

  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b]8;;https://example.com\x07click\x1b]8;;\x07 ERROR");

  const before = await new Promise<Array<{ text: string }> | undefined>((resolve) => {
    providers.at(-1)?.provideLinks(1, resolve);
  });
  assert.equal(before, undefined, "built-in OSC 8 cells should suppress the fallback provider");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  const cell = term.buffer.normal.getLine(0)?.getCell(0) as { extended?: { urlId?: number } } | undefined;
  assert.equal(cell?.extended?.urlId ?? 0, 0, "serialize rebuild drops visible OSC 8 metadata");

  const after = await new Promise<Array<{ text: string }> | undefined>((resolve) => {
    providers.at(-1)?.provideLinks(1, resolve);
  });
  assert.deepEqual(
    after?.map((link) => link.text),
    ["https://example.com"],
  );
  assert.deepEqual(after?.[0]?.range, {
    start: { x: 1, y: 1 },
    end: { x: 5, y: 1 },
  });

  highlighter.dispose();
  term.dispose();
});

test("alternate screen never reuses normal-screen OSC 8 fallback links", async () => {
  type LinkProvider = {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: Array<{ text: string }> | undefined) => void,
    ): void;
  };
  const providers: LinkProvider[] = [];
  const term = new XTerm({ cols: 80, rows: 5, scrollback: 100, allowProposedApi: true });
  const originalRegister = term.registerLinkProvider.bind(term);
  term.registerLinkProvider = ((provider: LinkProvider) => {
    providers.push(provider);
    return originalRegister(provider);
  }) as typeof term.registerLinkProvider;
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b]8;;https://example.com\x07normal\x1b]8;;\x07 ERROR");
  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  await write(term, "\x1b[?1049halt");

  const links = await new Promise<Array<{ text: string }> | undefined>((resolve) => {
    providers.at(-1)?.provideLinks(1, resolve);
  });
  assert.equal(links, undefined);
  highlighter.dispose();
  term.dispose();
});

test("large wrapped history keeps every row across rebuild", async () => {
  const term = new XTerm({ cols: 40, rows: 5, scrollback: 3000 });
  const visibleSerializer = new SerializeAddon();
  term.loadAddon(visibleSerializer);
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  const lines = Array.from(
    { length: 1200 },
    (_, index) => `L${index.toString().padStart(4, "0")}-${"x".repeat((index % 70) + 1)} ERROR`,
  );
  await write(term, lines.join("\r\n"));
  const snapshotCells = () => Array.from({ length: term.buffer.normal.length }, (_, index) => {
    const line = term.buffer.normal.getLine(index);
    return {
      wrapped: line?.isWrapped ?? false,
      cells: Array.from({ length: term.cols }, (_, cellIndex) => {
        const cell = line?.getCell(cellIndex);
        return cell ? {
          chars: cell.getChars(),
          width: cell.getWidth(),
          fg: cell.getFgColor(),
          bg: cell.getBgColor(),
          bold: cell.isBold(),
          italic: cell.isItalic(),
          underline: cell.isUnderline(),
          inverse: cell.isInverse(),
        } : null;
      }),
    };
  });
  const beforeLines = snapshotCells();

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  const visible = visibleSerializer.serialize();
  const afterLines = snapshotCells();
  const stripHighlightColors = (rows: ReturnType<typeof snapshotCells>) => rows.map((row) => ({
    ...row,
    cells: row.cells.map((cell) => (
      cell?.fg === 0x60a5fa ? { ...cell, fg: 0xf87171 } : cell
    )),
  }));
  assert.deepEqual(stripHighlightColors(afterLines), beforeLines);
  const replay = new XTerm({ cols: 40, rows: 5, scrollback: 3000 });
  await write(replay, visible);
  const replayedText = Array.from({ length: replay.buffer.normal.length }, (_, index) =>
    replay.buffer.normal.getLine(index)?.translateToString(true) ?? "").join("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const marker = `L${index.toString().padStart(4, "0")}-`;
    assert.equal(replayedText.split(marker).length - 1, 1, `${marker} must survive once`);
  }

  replay.dispose();
  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves custom tab stops", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b[3g\x1b[6G\x1bHseed ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  await write(term, "\r\n\tY");

  assert.equal(term.buffer.active.cursorX, 6);
  assert.match(term.buffer.active.getLine(term.buffer.active.baseY + 1)?.translateToString(), /^ {5}Y/);
  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves saved cursor state", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b[31m\x1b[2;6H\x1b7\x1b[4;1Hseed ERROR");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  await write(term, "\x1b8Z");

  assert.equal(term.buffer.active.cursorX, 6);
  assert.equal(term.buffer.active.cursorY, 1);
  const restoredCell = term.buffer.active.getLine(term.buffer.active.baseY + 1)?.getCell(5);
  assert.equal(restoredCell?.getChars(), "Z");
  assert.equal(restoredCell?.getFgColor(), 1);
  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves the active cursor position", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b[3;7Habc ERROR\x1b[2;4H");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  assert.equal(term.buffer.active.cursorX, 3);
  assert.equal(term.buffer.active.cursorY, 1);
  await write(term, "Z");
  assert.equal(term.buffer.active.getLine(term.buffer.active.baseY + 1)?.getCell(3)?.getChars(), "Z");

  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves cursor position inside an origin-mode scroll region", async () => {
  const term = new XTerm({ cols: 20, rows: 6, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "seed ERROR\x1b[2;5r\x1b[?6h\x1b[3;13H");
  const before = [term.buffer.active.cursorX, term.buffer.active.cursorY];

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.deepEqual([term.buffer.active.cursorX, term.buffer.active.cursorY], before);
  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves rectangular selections", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 100 });
  const selectionEvents: boolean[] = [];
  const restoringEvents: boolean[] = [];
  const highlighter = new KeywordHighlighter(term, {
    onRestoringSelectionChange(restoring) { restoringEvents.push(restoring); },
  });
  highlighter.setRules(rule(), true);
  await write(term, "one ERROR\r\ntwo ERROR\r\nthree ERROR");
  const selectionService = {
    _activeSelectionMode: 3,
    _model: {
      selectionStart: [1, 0] as [number, number],
      selectionEnd: [4, 2] as [number, number],
      selectionStartLength: 0,
    } as {
      selectionStart?: [number, number];
      selectionEnd?: [number, number];
      selectionStartLength: number;
    },
    reset() {
      this._activeSelectionMode = 0;
      this._model.selectionStart = undefined;
      this._model.selectionEnd = undefined;
      this._onSelectionChange.fire();
    },
    refresh() {},
    _onSelectionChange: {
      fire() { selectionEvents.push(selectionService._model.selectionStart !== undefined); },
    },
  };
  Object.assign((term as unknown as { _core: Record<string, unknown> })._core, {
    _selectionService: selectionService,
  });

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.equal(selectionService._activeSelectionMode, 3);
  assert.deepEqual(selectionService._model.selectionStart, [1, 0]);
  assert.deepEqual(selectionService._model.selectionEnd, [4, 2]);
  assert.deepEqual(selectionEvents, [false, true]);
  assert.deepEqual(restoringEvents, [true, false]);
  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves the active character set", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b(0q\x1b(B seed ERROR\x1b(0");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();
  await write(term, "q");

  assert.match(term.buffer.active.getLine(term.buffer.active.baseY)?.translateToString(true) ?? "", /─$/);
  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves mouse tracking and extended coordinates", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 100 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b[?1000h\x1b[?1006hseed ERROR");
  const mouseState = () => (term as unknown as {
    _core: { mouseStateService: { activeProtocol: string; activeEncoding: string } };
  })._core.mouseStateService;
  assert.equal(mouseState().activeProtocol, "VT200");
  assert.equal(mouseState().activeEncoding, "SGR");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.equal(mouseState().activeProtocol, "VT200");
  assert.equal(mouseState().activeEncoding, "SGR");

  await write(term, "\x1b[?1016h");
  highlighter.setRules(rule("#34D399"), true);
  await highlighter.whenSettled();
  assert.equal(mouseState().activeEncoding, "SGR_PIXELS");
  highlighter.dispose();
  term.dispose();
});

test("history rebuild preserves private terminal modes", async () => {
  const term = new XTerm({
    cols: 20,
    rows: 5,
    scrollback: 100,
    vtExtensions: { win32InputMode: true },
  });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, "\x1b[5 q\x1b[?2031h\x1b[?9001hseed ERROR");
  const privateModes = () => (term as unknown as {
    _core: {
      coreService: {
        decPrivateModes: Record<string, unknown>;
      };
    };
  })._core.coreService.decPrivateModes;
  assert.equal(privateModes().cursorStyle, "bar");
  assert.equal(privateModes().cursorBlink, true);
  assert.equal(privateModes().colorSchemeUpdates, true);
  assert.equal(privateModes().win32InputMode, true);

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  assert.equal(privateModes().cursorStyle, "bar");
  assert.equal(privateModes().cursorBlink, true);
  assert.equal(privateModes().colorSchemeUpdates, true);
  assert.equal(privateModes().win32InputMode, true);
  highlighter.dispose();
  term.dispose();
});

test("sliced history rebuild does not leak cursor style across slice boundaries", async () => {
  const term = new XTerm({ cols: 20, rows: 5, scrollback: 1000 });
  const highlighter = new KeywordHighlighter(term);
  highlighter.setRules(rule(), true);
  await write(term, [
    ...Array.from({ length: 511 }, (_, index) => `plain-${index}`),
    "\x1b[41mboundary\x1b[0m",
    "tail",
  ].join("\r\n"));
  await write(term, "\x1b[44m");

  highlighter.setRules(rule("#60A5FA"), true);
  await highlighter.whenSettled();

  const tailLine = Array.from({ length: term.buffer.normal.length }, (_, index) =>
    term.buffer.normal.getLine(index)).find((line) => line?.translateToString(true) === "tail");
  assert.equal(tailLine?.getCell(0)?.isBgDefault(), true);
  highlighter.dispose();
  term.dispose();
});
