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

const POSIX_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-C", "--chdir",
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

function normalizeShellKind(shellKind) {
  const kind = String(shellKind || "").toLowerCase();
  return kind === "fish" ? "posix" : kind;
}

function executableGroup(value) {
  const basename = String(value || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (POSIX_SHELLS.has(basename)) return "posix";
  if (POWERSHELL_SHELLS.has(basename)) return "powershell";
  return null;
}

function tokenizeCommand(command, shellKind) {
  const kind = normalizeShellKind(shellKind);
  const tokens = [];
  let value = "";
  let quoted = false;

  const pushWord = () => {
    if (value.length > 0 || quoted) {
      tokens.push({ type: "word", value, quoted });
      value = "";
      quoted = false;
    }
  };
  const pushOperator = (operator) => {
    pushWord();
    tokens.push({ type: "operator", value: operator, quoted: false });
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

    if (char === "#" && value.length === 0 && !quoted) {
      pushWord();
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      quoted = true;
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

    if (";&|()".includes(char)) {
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
    return { index, group: executableGroup(tokens[index].value) };
  }
  return null;
}

function resolveCmdExecutable(tokens, startIndex) {
  let index = startIndex;
  const first = tokens[index]?.value.toLowerCase();
  if (first === "call") index += 1;
  if (first === "start") {
    index += 1;
    while (tokens[index]?.type === "word" && tokens[index].value.startsWith("/")) index += 1;
    if (tokens[index]?.type === "word" && tokens[index].quoted) index += 1;
    while (tokens[index]?.type === "word" && tokens[index].value.startsWith("/")) index += 1;
  }
  if (["cmd", "cmd.exe"].includes(tokens[index]?.value.toLowerCase())) {
    index += 1;
    while (tokens[index]?.type === "word" && tokens[index].value.startsWith("/")) index += 1;
  }
  if (tokens[index]?.type !== "word") return null;
  return { index, group: executableGroup(tokens[index].value) };
}

function resolvePowerShellExecutable(tokens, startIndex) {
  const command = tokens[startIndex]?.value.toLowerCase();
  if (!["start", "start-process", "saps"].includes(command)) {
    return { index: startIndex, group: executableGroup(tokens[startIndex]?.value) };
  }

  let firstPositional = null;
  for (let index = startIndex + 1; index < tokens.length && !isBoundary(tokens[index]); index += 1) {
    if (tokens[index].type !== "word") continue;
    const value = tokens[index].value;
    if (value.toLowerCase() === "-filepath" && tokens[index + 1]?.type === "word") {
      return { index: index + 1, group: executableGroup(tokens[index + 1].value) };
    }
    if (!value.startsWith("-") && firstPositional == null) firstPositional = index;
  }
  return firstPositional == null
    ? null
    : { index: firstPositional, group: executableGroup(tokens[firstPositional].value) };
}

function nestedCommandArgument(tokens, executableIndex, group) {
  const commandFlags = group === "powershell"
    ? new Set(["-c", "-command", "-encodedcommand"])
    : new Set(["-c", "--command"]);
  for (let index = executableIndex + 1; index < tokens.length && !isBoundary(tokens[index]); index += 1) {
    if (
      tokens[index].type === "word"
      && commandFlags.has(tokens[index].value.toLowerCase())
      && tokens[index + 1]?.type === "word"
    ) {
      return tokens[index + 1].value;
    }
  }
  return null;
}

function detectInvokedShellGroups(command, shellKind, depth = 0) {
  const kind = normalizeShellKind(shellKind);
  if (!command || !["posix", "powershell", "cmd"].includes(kind) || depth > 3) return [];

  const tokens = tokenizeCommand(String(command), kind);
  const groups = new Set();
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
    if (resolved?.group) {
      groups.add(resolved.group);
      const nestedCommand = nestedCommandArgument(tokens, resolved.index, resolved.group);
      if (nestedCommand) {
        for (const nestedGroup of detectInvokedShellGroups(nestedCommand, resolved.group, depth + 1)) {
          groups.add(nestedGroup);
        }
      }
    }
    atCommandStart = false;
  }

  return [...groups];
}

module.exports = { detectInvokedShellGroups };
