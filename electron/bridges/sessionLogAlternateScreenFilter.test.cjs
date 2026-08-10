const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSessionLogAlternateScreenFilter,
  MAX_PENDING_ESCAPE_CHARS,
} = require("./sessionLogAlternateScreenFilter.cjs");

test("drops vim alternate-screen content including empty-line markers", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const output =
    filter.append("before vim\r\n") +
    filter.append("\x1b[?1049h~\r\n~\r\nfile content\r\n\x1b[?1049l") +
    filter.append("after vim\r\n") +
    filter.finish();

  assert.equal(output, "before vim\r\nafter vim\r\n");
});

test("supports DECSET 47 / 1047 and split enter/leave sequences", () => {
  const filter = createSessionLogAlternateScreenFilter();
  let output = filter.append("shell\n\x1b[?47");
  assert.equal(output, "shell\n");

  output += filter.append("h~empty\n");
  assert.equal(output, "shell\n");

  output += filter.append("\x1b[?1;10");
  assert.equal(output, "shell\n");

  output += filter.append("47lback\n");
  output += filter.finish();
  assert.equal(output, "shell\nback\n");
});

test("keeps normal CSI sequences outside alternate screen", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const output =
    filter.append("red \x1b[31mtext\x1b[0m\n") + filter.finish();
  assert.equal(output, "red \x1b[31mtext\x1b[0m\n");
});

test("consumes non-CSI ESC forms such as DECSC and charset designation", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const output =
    filter.append("save\x1b7 then \x1b(Bcharset\n") + filter.finish();
  assert.equal(output, "save\x1b7 then \x1b(Bcharset\n");
});

test("buffers incomplete ESC intermediate sequences across chunks", () => {
  const filter = createSessionLogAlternateScreenFilter();
  let output = filter.append("pre\x1b(");
  assert.equal(output, "pre");
  output += filter.append("Bpost\n");
  output += filter.finish();
  assert.equal(output, "pre\x1b(Bpost\n");
});

test("recovers when an unterminated OSC exceeds the pending-control cap", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const oversized = `\x1b]${"x".repeat(MAX_PENDING_ESCAPE_CHARS)}recovered\n`;
  const output = filter.append(`pre${oversized}`) + filter.finish();
  assert.equal(output, `pre]${"x".repeat(MAX_PENDING_ESCAPE_CHARS)}recovered\n`);
});

test("unterminated OSC grown one byte at a time recovers at the pending-control cap", () => {
  const filter = createSessionLogAlternateScreenFilter();
  let output = filter.append("pre\x1b]");
  // Grow to the retention cap without rescanning the whole prefix each chunk.
  for (let i = 0; i < MAX_PENDING_ESCAPE_CHARS - 2; i += 1) {
    output += filter.append("x");
  }
  assert.equal(output, "pre");
  // One more byte pushes past the cap: drop the ESC introducer and emit the rest.
  output += filter.append("x");
  output += filter.append("recovered\n");
  output += filter.finish();
  assert.equal(
    output,
    `pre]${"x".repeat(MAX_PENDING_ESCAPE_CHARS - 1)}recovered\n`,
  );
});

test("OSC ST split across chunks after a trailing ESC completes without rescan stalls", () => {
  const filter = createSessionLogAlternateScreenFilter();
  let output = filter.append("pre\x1b]0;title\x1b");
  assert.equal(output, "pre");
  output += filter.append("\\after\n");
  output += filter.finish();
  assert.equal(output, "pre\x1b]0;title\x1b\\after\n");
});

test("RIS clears alternate screen so logging resumes", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const output =
    filter.append("before\n\x1b[?1049h~tui\n\x1bc") +
    filter.append("after reset\n") +
    filter.finish();
  assert.equal(output, "before\nafter reset\n");
});

test("recognizes 8-bit C1 CSI alternate-screen enter/leave", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const output =
    filter.append("before\n\x9b?1049h~tui\n\x9b?1049l") +
    filter.append("after\n") +
    filter.finish();
  assert.equal(output, "before\nafter\n");
});

test("recognizes C1 ST as an OSC string terminator", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const output =
    filter.append("pre\x1b]0;title\x9cafter\n") + filter.finish();
  assert.equal(output, "pre\x1b]0;title\x9cafter\n");
});

test("C1-ST-terminated OSC does not truncate later shell output", () => {
  const filter = createSessionLogAlternateScreenFilter();
  const output =
    filter.append("shell\n\x1b]0;vim\x9c\x1b[?1049h~\n\x1b[?1049lback\n") +
    filter.finish();
  assert.equal(output, "shell\n\x1b]0;vim\x9cback\n");
});
