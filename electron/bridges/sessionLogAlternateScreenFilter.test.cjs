const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSessionLogAlternateScreenFilter,
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
