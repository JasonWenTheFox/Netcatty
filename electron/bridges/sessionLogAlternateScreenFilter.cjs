/**
 * Session-log alternate-screen filter.
 *
 * Fullscreen TUIs (vim/vi, less, htop, …) switch to the terminal alternate
 * buffer via DEC private modes 47 / 1047 / 1049. That buffer is UI chrome for
 * the interactive session — including vim's "~" empty-line markers — and
 * should not land in session logs. Mirror the trigger-filter approach: drop
 * enter/leave sequences and everything between them, keeping main-screen
 * shell output intact.
 */

const ESC = "\x1b";
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

function readCsiSequence(input, startIndex) {
  if (input[startIndex] !== ESC || input[startIndex + 1] !== "[") return null;
  for (let index = startIndex + 2; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return {
        sequence: input.slice(startIndex, index + 1),
        end: index + 1,
      };
    }
  }
  return null;
}

function readOscSequence(input, startIndex) {
  if (input[startIndex] !== ESC || input[startIndex + 1] !== "]") return null;
  for (let index = startIndex + 2; index < input.length; index += 1) {
    if (input[index] === "\x07") {
      return {
        sequence: input.slice(startIndex, index + 1),
        end: index + 1,
      };
    }
    if (input[index] === ESC && input[index + 1] === "\\") {
      return {
        sequence: input.slice(startIndex, index + 2),
        end: index + 2,
      };
    }
  }
  return null;
}

function readEscapeSequence(input, startIndex) {
  if (input[startIndex] !== ESC) return null;
  if (startIndex + 1 >= input.length) return null;

  const next = input[startIndex + 1];
  if (next === "[") return readCsiSequence(input, startIndex);
  if (next === "]") return readOscSequence(input, startIndex);

  // ECMA-48 escape sequences: ESC Intermediate* Final
  // Intermediate 0x20-0x2F (e.g. "(" in ESC ( B); Final 0x30-0x7E
  // (covers DECSC ESC 7, charset ESC ( B, RIS ESC c, …).
  for (let index = startIndex + 1; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x20 && code <= 0x2f) {
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) {
      return {
        sequence: input.slice(startIndex, index + 1),
        end: index + 1,
      };
    }
    // Malformed escape: consume ESC alone so pendingEscape never stalls.
    return {
      sequence: input.slice(startIndex, startIndex + 1),
      end: startIndex + 1,
    };
  }

  return null;
}

function getAlternateScreenAction(sequence) {
  if (!sequence.startsWith("\x1b[") || sequence.length < 3) return null;
  const final = sequence.at(-1);
  if (final !== "h" && final !== "l") return null;

  const params = sequence.slice(2, -1);
  if (!params.startsWith("?")) return null;

  const modes = params
    .slice(1)
    .split(";")
    .map((part) => Number.parseInt(part, 10))
    .filter(Number.isFinite);

  if (!modes.some((mode) => ALT_SCREEN_MODES.has(mode))) {
    return null;
  }

  return final === "h" ? "enter" : "leave";
}

function createSessionLogAlternateScreenFilter() {
  let alternateScreenActive = false;
  let pendingEscape = "";

  return {
    append(chunk) {
      if (!chunk) return "";

      let input = pendingEscape ? `${pendingEscape}${chunk}` : chunk;
      pendingEscape = "";
      let output = "";

      for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== ESC) {
          if (!alternateScreenActive) {
            output += input[index];
          }
          continue;
        }

        const sequence = readEscapeSequence(input, index);
        if (!sequence) {
          pendingEscape = input.slice(index);
          break;
        }

        const action = getAlternateScreenAction(sequence.sequence);
        if (action === "enter") {
          alternateScreenActive = true;
        } else if (action === "leave") {
          alternateScreenActive = false;
        } else if (!alternateScreenActive) {
          output += sequence.sequence;
        }

        index = sequence.end - 1;
      }

      return output;
    },
    finish() {
      // Incomplete escape tails are controls, never printable shell text.
      pendingEscape = "";
      return "";
    },
  };
}

module.exports = {
  createSessionLogAlternateScreenFilter,
  getAlternateScreenAction,
};
