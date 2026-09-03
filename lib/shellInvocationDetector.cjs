"use strict";

const POSIX_SHELLS = new Set([
  "sh",
  "sh.exe",
  "bash",
  "bash.exe",
  "dash",
  "dash.exe",
  "zsh",
  "zsh.exe",
  "ksh",
  "ksh.exe",
  "ash",
  "ash.exe",
  "fish",
  "fish.exe",
  "wsl",
  "wsl.exe",
]);
const POWERSHELL_SHELLS = new Set([
  "pwsh",
  "pwsh.exe",
  "powershell",
  "powershell.exe",
]);
const CMD_SHELLS = new Set(["cmd", "cmd.exe"]);

const POSIX_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-C", "-D", "--chdir",
  "-g", "--group",
  "-h", "--host",
  "-p", "--prompt",
  "-R", "--chroot",
  "-r", "--role",
  "-T", "--command-timeout",
  "-t", "--type",
  "-U", "--other-user",
  "-u", "--user",
]);
const ENV_OPTIONS_WITH_VALUE = new Set([
  "-C", "--chdir",
  "-S", "--split-string",
  "-u", "--unset",
]);
const WSL_OPTIONS_WITH_VALUE = new Set([
  "-d", "--distribution",
  "-u", "--user",
  "--cd",
]);
const CMD_START_OPTIONS_WITH_VALUE = new Set(["/d", "/node", "/affinity", "/machine"]);

function normalizeShellKind(shellKind) {
  const kind = String(shellKind || "").toLowerCase();
  return kind === "fish" ? "posix" : kind;
}

function executableKind(value) {
  const basename = String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (POSIX_SHELLS.has(basename)) return "posix";
  if (POWERSHELL_SHELLS.has(basename)) return "powershell";
  if (CMD_SHELLS.has(basename)) return "cmd";
  return null;
}

function executableBasename(value) {
  return String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
}

function extractPowerShellSubexpressions(value) {
  const expressions = [];
  for (let start = 0; start < value.length - 1; start += 1) {
    if (value[start] !== "$" || value[start + 1] !== "(") continue;
    let depth = 1;
    let quote = null;
    for (let index = start + 2; index < value.length; index += 1) {
      const char = value[index];
      if (char === "`" && index + 1 < value.length) {
        index += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (depth === 0) {
        expressions.push(value.slice(start + 2, index));
        start = index;
        break;
      }
    }
  }
  return expressions;
}

function tokenizeCommand(command, shellKind) {
  const kind = normalizeShellKind(shellKind);
  const tokens = [];
  let value = "";
  let quoted = false;
  let embeddedCommands = [];

  const pushWord = () => {
    if (value.length > 0 || quoted) {
      tokens.push({ type: "word", value, quoted, embeddedCommands });
      value = "";
      quoted = false;
      embeddedCommands = [];
    }
  };
  const pushOperator = (operator) => {
    pushWord();
    tokens.push({ type: "operator", value: operator, quoted: false, embeddedCommands: [] });
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (char === "\r") continue;
    if (char === "\n") {
      pushOperator("\n");
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      continue;
    }

    if (kind !== "cmd" && char === "#" && value.length === 0 && !quoted) {
      pushWord();
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }

    if (char === '"' || (kind !== "cmd" && char === "'")) {
      const quote = char;
      quoted = true;
      const quoteValueStart = value.length;
      for (index += 1; index < command.length; index += 1) {
        const inner = command[index];
        if (inner === quote) {
          if (kind === "powershell" && command[index + 1] === quote) {
            value += quote;
            index += 1;
            continue;
          }
          break;
        }
        if (quote === '"' && kind === "posix" && inner === "\\") {
          if (index + 1 < command.length && '$`"\\\n'.includes(command[index + 1])) {
            value += command[index + 1];
            index += 1;
          } else {
            value += inner;
          }
          continue;
        }
        if (
          (kind === "powershell" && inner === "`")
          || (kind === "cmd" && inner === "^")
        ) {
          if (index + 1 < command.length) {
            value += command[index + 1];
            index += 1;
            continue;
          }
        }
        value += inner;
      }
      if (kind === "powershell" && quote === '"') {
        embeddedCommands.push(...extractPowerShellSubexpressions(value.slice(quoteValueStart)));
      }
      continue;
    }

    if (kind === "posix" && char === "\\" && index + 1 < command.length) {
      value += command[index + 1];
      index += 1;
      continue;
    }
    if (kind === "powershell" && char === "`" && index + 1 < command.length) {
      value += command[index + 1];
      index += 1;
      continue;
    }
    if (kind === "cmd" && char === "^" && index + 1 < command.length) {
      value += command[index + 1];
      index += 1;
      continue;
    }

    if ((kind === "cmd" ? "&|()" : ";&|()").includes(char)) {
      const doubled = (char === "&" || char === "|") && command[index + 1] === char;
      pushOperator(doubled ? `${char}${char}` : char);
      if (doubled) index += 1;
      continue;
    }

    value += char;
  }
  pushWord();
  return tokens;
}

function getShellCommandScanText(command, shellKind) {
  const kind = normalizeShellKind(shellKind);
  if (!["posix", "powershell"].includes(kind)) return String(command || "");

  let result = "";
  let quote = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (kind === "powershell" && char === "'" && command[index + 1] === "'") {
        result += "  ";
        index += 1;
      } else {
        if (char === "'") quote = null;
        result += " ";
      }
      continue;
    }
    if (quote === '"') {
      result += char;
      if ((kind === "posix" && char === "\\") || (kind === "powershell" && char === "`")) {
        if (index + 1 < command.length) {
          result += command[index + 1];
          index += 1;
        }
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (char === "'") {
      quote = "'";
      result += " ";
    } else {
      if (char === '"') quote = '"';
      result += char;
    }
  }
  return result;
}

function isBoundary(token) {
  return token?.type === "operator";
}

function skipOptionArguments(tokens, index, optionsWithValue) {
  while (tokens[index]?.type === "word" && tokens[index].value.startsWith("-")) {
    const option = tokens[index].value;
    index += 1;
    if (option === "--") break;
    if (optionsWithValue.has(option) && tokens[index]?.type === "word") index += 1;
  }
  return index;
}

function resolvePosixExecutable(tokens, startIndex) {
  let index = startIndex;
  while (tokens[index]?.type === "word" && POSIX_ASSIGNMENT.test(tokens[index].value)) index += 1;

  for (let wrappers = 0; wrappers < 8 && tokens[index]?.type === "word"; wrappers += 1) {
    const command = tokens[index].value.toLowerCase();
    if (command === "env") {
      for (let optionIndex = index + 1; tokens[optionIndex]?.type === "word"; optionIndex += 1) {
        const option = tokens[optionIndex].value;
        if ((option === "-S" || option === "--split-string") && tokens[optionIndex + 1]?.type === "word") {
          return { index, kind: null, nestedCommand: tokens[optionIndex + 1].value };
        }
        if (option.startsWith("--split-string=")) {
          return { index, kind: null, nestedCommand: option.slice("--split-string=".length) };
        }
        if (!option.startsWith("-")) break;
        if (ENV_OPTIONS_WITH_VALUE.has(option)) optionIndex += 1;
      }
      index = skipOptionArguments(tokens, index + 1, ENV_OPTIONS_WITH_VALUE);
      while (tokens[index]?.type === "word" && POSIX_ASSIGNMENT.test(tokens[index].value)) index += 1;
      continue;
    }
    if (command === "sudo") {
      index = skipOptionArguments(tokens, index + 1, SUDO_OPTIONS_WITH_VALUE);
      continue;
    }
    if (["command", "exec", "nohup"].includes(command)) {
      index = skipOptionArguments(tokens, index + 1, new Set());
      continue;
    }
    return { index, kind: executableKind(tokens[index].value) };
  }
  return null;
}

function resolveCmdExecutable(tokens, startIndex) {
  let index = startIndex;
  const first = tokens[index]?.value.toLowerCase();
  if (first === "call") index += 1;
  if (first === "start") {
    index += 1;
    while (tokens[index]?.type === "word" && tokens[index].value.startsWith("/")) {
      const option = tokens[index].value.toLowerCase();
      index += 1;
      if (CMD_START_OPTIONS_WITH_VALUE.has(option) && tokens[index]?.type === "word") index += 1;
    }
    if (tokens[index]?.type === "word" && tokens[index].quoted) index += 1;
    while (tokens[index]?.type === "word" && tokens[index].value.startsWith("/")) {
      const option = tokens[index].value.toLowerCase();
      index += 1;
      if (CMD_START_OPTIONS_WITH_VALUE.has(option) && tokens[index]?.type === "word") index += 1;
    }
  }
  if (tokens[index]?.type !== "word") return null;
  return { index, kind: executableKind(tokens[index].value) };
}

function resolvePowerShellExecutable(tokens, startIndex) {
  const command = tokens[startIndex]?.value.toLowerCase();
  if (!["start", "start-process", "saps"].includes(command)) {
    return { index: startIndex, kind: executableKind(tokens[startIndex]?.value) };
  }

  let firstPositional = null;
  for (let index = startIndex + 1; index < tokens.length && !isBoundary(tokens[index]); index += 1) {
    if (tokens[index].type !== "word") continue;
    const value = tokens[index].value;
    if (value.toLowerCase() === "-filepath" && tokens[index + 1]?.type === "word") {
      return { index: index + 1, kind: executableKind(tokens[index + 1].value) };
    }
    if (!value.startsWith("-") && firstPositional == null) firstPositional = index;
  }
  return firstPositional == null
    ? null
    : { index: firstPositional, kind: executableKind(tokens[firstPositional].value) };
}

function commandEndIndex(tokens, startIndex) {
  let index = startIndex;
  while (index < tokens.length && !isBoundary(tokens[index])) index += 1;
  return index;
}

function reconstructWords(tokens, startIndex, endIndex = commandEndIndex(tokens, startIndex)) {
  return tokens
    .slice(startIndex, endIndex)
    .filter((token) => token.type === "word")
    .map((token) => token.value)
    .join(" ");
}

function reconstructPosixArguments(tokens, startIndex, endIndex) {
  return tokens
    .slice(startIndex, endIndex)
    .filter((token) => token.type === "word")
    .map((token) => token.quoted ? `'${token.value.replace(/'/g, `'\\''`)}'` : token.value)
    .join(" ");
}

function nestedCommandArgument(tokens, executableIndex, shellKind) {
  if (shellKind === "posix" && ["wsl", "wsl.exe"].includes(executableBasename(tokens[executableIndex].value))) {
    return null;
  }
  for (let index = executableIndex + 1; index < tokens.length && !isBoundary(tokens[index]); index += 1) {
    if (tokens[index].type !== "word" || tokens[index + 1]?.type !== "word") continue;
    const option = tokens[index].value.toLowerCase();
    const isCommandOption = shellKind === "powershell"
      ? ["-c", "-command", "-encodedcommand"].includes(option)
      : option === "--command" || (/^-[^-]+$/.test(option) && option.slice(1).includes("c"));
    if (isCommandOption) {
      if (shellKind === "powershell" && option !== "-encodedcommand" && !tokens[index + 1].quoted) {
        return reconstructWords(tokens, index + 1);
      }
      return tokens[index + 1].value;
    }
  }
  return null;
}

function cmdNestedCommand(tokens, executableIndex) {
  const endIndex = commandEndIndex(tokens, executableIndex);
  for (let index = executableIndex + 1; index < endIndex; index += 1) {
    if (tokens[index].type !== "word") continue;
    const option = tokens[index].value;
    const lower = option.toLowerCase();
    if (lower === "/c" || lower === "/k") {
      return reconstructWords(tokens, index + 1, endIndex);
    }
    if (lower.startsWith("/c") || lower.startsWith("/k")) {
      return `${option.slice(2)} ${reconstructWords(tokens, index + 1, endIndex)}`.trim();
    }
  }
  return null;
}

function wslNestedCommand(tokens, executableIndex) {
  const endIndex = commandEndIndex(tokens, executableIndex);
  let index = executableIndex + 1;
  while (index < endIndex && tokens[index].type === "word") {
    const option = tokens[index].value;
    if (option === "--" || option === "-e" || option === "--exec") {
      index += 1;
      break;
    }
    if (WSL_OPTIONS_WITH_VALUE.has(option)) {
      index += 2;
      continue;
    }
    if (option.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  return index < endIndex
    ? {
      command: reconstructWords(tokens, index, endIndex),
      parsedCommand: reconstructPosixArguments(tokens, index, endIndex),
    }
    : null;
}

function detectShellInvocations(command, shellKind, depth = 0) {
  const kind = normalizeShellKind(shellKind);
  if (!command || !["posix", "powershell", "cmd"].includes(kind) || depth > 3) return [];

  const tokens = tokenizeCommand(String(command), kind);
  const invocations = [];

  for (const token of tokens) {
    if (kind !== "powershell" || token.type !== "word") continue;
    for (const embeddedCommand of token.embeddedCommands) {
      invocations.push(...detectShellInvocations(embeddedCommand, "powershell", depth + 1));
    }
  }

  let atCommandStart = true;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "operator") {
      atCommandStart = true;
      continue;
    }
    if (!atCommandStart) continue;

    const resolved = kind === "posix"
      ? resolvePosixExecutable(tokens, index)
      : kind === "cmd"
        ? resolveCmdExecutable(tokens, index)
        : resolvePowerShellExecutable(tokens, index);
    if (resolved?.nestedCommand) {
      invocations.push({ group: "native", command: resolved.nestedCommand });
      invocations.push(...detectShellInvocations(resolved.nestedCommand, "posix", depth + 1));
    } else if (resolved?.kind === "cmd") {
      const nestedCommand = cmdNestedCommand(tokens, resolved.index);
      if (nestedCommand) {
        invocations.push(...detectShellInvocations(nestedCommand, "cmd", depth + 1));
      }
    } else if (resolved?.kind) {
      const isWsl = ["wsl", "wsl.exe"].includes(executableBasename(tokens[resolved.index].value));
      const nestedCommand = nestedCommandArgument(tokens, resolved.index, resolved.kind);
      const scope = nestedCommand || reconstructWords(tokens, resolved.index);
      // WSL is a launcher, not necessarily a POSIX shell. Inspect its direct
      // command below instead of applying POSIX syntax rules to PowerShell
      // arguments that merely pass through WSL.
      if (!isWsl) invocations.push({ group: resolved.kind, command: scope });
      if (nestedCommand) {
        invocations.push(...detectShellInvocations(nestedCommand, resolved.kind, depth + 1));
      }
      if (isWsl) {
        const wslCommand = wslNestedCommand(tokens, resolved.index);
        if (wslCommand) {
          invocations.push({ group: "native", command: wslCommand.command });
          invocations.push(...detectShellInvocations(wslCommand.parsedCommand, "posix", depth + 1));
        }
      }
    }
    atCommandStart = false;
  }

  return invocations;
}

function detectInvokedShellGroups(command, shellKind) {
  return [...new Set(
    detectShellInvocations(command, shellKind)
      .map(({ group }) => group)
      .filter((group) => group !== "native"),
  )];
}

module.exports = { detectShellInvocations, detectInvokedShellGroups, getShellCommandScanText };
