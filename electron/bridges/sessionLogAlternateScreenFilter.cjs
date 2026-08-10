/**
 * Session-log alternate-screen filter.
 *
 * Fullscreen TUIs (vim/vi, less, htop, ...) switch to the terminal alternate
 * buffer via DEC private modes 47 / 1047 / 1049. That buffer is UI chrome for
 * the interactive session -- including vim's "~" empty-line markers -- and
 * should not land in rendered (txt/html) session logs. Raw logs keep the
 * original byte stream and must not use this filter. Mirror the trigger-filter
 * approach: drop enter/leave sequences and everything between them, keeping
 * main-screen shell output intact.
 */

const ESC = "\x1b";
/** 8-bit C1 CSI (0x9b); xterm accepts this as equivalent to ESC [. */
const C1_CSI = "\x9b";
/** 8-bit C1 ST (0x9c); valid OSC/DCS string terminator alongside BEL and ESC \\. */
const C1_ST = "\x9c";
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
/**
 * Incomplete CSI/OSC tails are normally tiny. Cap retention so an unterminated
 * control cannot grow pendingEscape without bound or rescan ever-larger prefixes.
 * Matches components/terminal/runtime/terminalControlSequenceLimits.ts.
 */
const MAX_PENDING_ESCAPE_CHARS = 64 * 1024;

function readCsiSequence(input, startIndex) {
  let bodyStart = -1;
  if (input[startIndex] === ESC && input[startIndex + 1] === "[") {
    bodyStart = startIndex + 2;
  } else if (input[startIndex] === C1_CSI) {
    bodyStart = startIndex + 1;
  } else {
    return null;
  }

  for (let index = bodyStart; index < input.length; index += 1) {
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
    if (input[index] === "\x07" || input[index] === C1_ST) {
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
  if (input[startIndex] === C1_CSI) {
    return readCsiSequence(input, startIndex);
  }
  if (input[startIndex] !== ESC) return null;
  if (startIndex + 1 >= input.length) return null;

  const next = input[startIndex + 1];
  if (next === "[") return readCsiSequence(input, startIndex);
  if (next === "]") return readOscSequence(input, startIndex);

  // ECMA-48 escape sequences: ESC Intermediate* Final
  // Intermediate 0x20-0x2F (e.g. "(" in ESC ( B); Final 0x30-0x7E
  // (covers DECSC ESC 7, charset ESC ( B, RIS ESC c, ...).
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
  // RIS (ESC c) restores the normal screen without a DECSET leave.
  if (sequence === `${ESC}c`) return "leave";

  let params = null;
  if (sequence.startsWith(`${ESC}[`) && sequence.length >= 3) {
    params = sequence.slice(2, -1);
  } else if (sequence.startsWith(C1_CSI) && sequence.length >= 2) {
    params = sequence.slice(1, -1);
  } else {
    return null;
  }

  const final = sequence.at(-1);
  if (final !== "h" && final !== "l") return null;
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
        const ch = input[index];
        if (ch !== ESC && ch !== C1_CSI) {
          if (!alternateScreenActive) {
            output += ch;
          }
          continue;
        }

        const sequence = readEscapeSequence(input, index);
        if (!sequence) {
          const remainder = input.slice(index);
          if (remainder.length <= MAX_PENDING_ESCAPE_CHARS) {
            pendingEscape = remainder;
            break;
          }
          // Incomplete control exceeded the retention cap: drop the introducer
          // and resume so later bytes are not withheld forever.
          continue;
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
  MAX_PENDING_ESCAPE_CHARS,
};
