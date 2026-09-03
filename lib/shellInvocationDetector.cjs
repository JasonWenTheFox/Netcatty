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
const POWERSHELL_START_PROCESS_OPTIONS_WITH_VALUE = new Set([
  "-argumentlist",
  "-credential",
  "-environment",
  "-erroraction",
  "-errorvariable",
  "-filepath",
  "-informationaction",
  "-informationvariable",
  "-outbuffer",
  "-outvariable",
  "-pipelinevariable",
  "-progressaction",
  "-redirectstandarderror",
  "-redirectstandardinput",
  "-redirectstandardoutput",
  "-verb",
  "-windowstyle",
  "-workingdirectory",
  "-warningaction",
  "-warningvariable",
]);
const POWERSHELL_START_PROCESS_SWITCH_OPTIONS = new Set([
  "-confirm",
  "-debug",
  "-loaduserprofile",
  "-nonewwindow",
  "-passthru",
  "-usenewenvironment",
  "-verbose",
  "-wait",
  "-whatif",
]);
const POWERSHELL_COMMON_PARAMETER_ALIASES = new Map([
  ["-ea", "-erroraction"],
  ["-ev", "-errorvariable"],
  ["-infa", "-informationaction"],
  ["-iv", "-informationvariable"],
  ["-ob", "-outbuffer"],
  ["-ov", "-outvariable"],
  ["-pv", "-pipelinevariable"],
  ["-proga", "-progressaction"],
  ["-wa", "-warningaction"],
  ["-wv", "-warningvariable"],
  ["-cf", "-confirm"],
  ["-db", "-debug"],
  ["-vb", "-verbose"],
  ["-wi", "-whatif"],
]);

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
    let escapeCount = 0;
    for (let index = start - 1; index >= 0 && value[index] === "`"; index -= 1) {
      escapeCount += 1;
    }
    if (escapeCount % 2 === 1) continue;
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
  let raw = "";
  let quoted = false;
  let embeddedCommands = [];

  const pushWord = () => {
    if (value.length > 0 || quoted) {
      tokens.push({ type: "word", value, raw, quoted, embeddedCommands });
      value = "";
      raw = "";
      quoted = false;
      embeddedCommands = [];
    }
  };
  const pushOperator = (operator) => {
    pushWord();
    tokens.push({ type: "operator", value: operator, raw: operator, quoted: false, embeddedCommands: [] });
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
      let quoteSource = "";
      raw += quote;
      for (index += 1; index < command.length; index += 1) {
        const inner = command[index];
        raw += inner;
        if (inner === quote) {
          if (kind === "powershell" && command[index + 1] === quote) {
            value += quote;
            quoteSource += quote + quote;
            raw += quote;
            index += 1;
            continue;
          }
          break;
        }
        if (quote === '"' && kind === "posix" && inner === "\\") {
          if (index + 1 < command.length && '$`"\\\n'.includes(command[index + 1])) {
            value += command[index + 1];
            raw += command[index + 1];
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
            quoteSource += inner + command[index + 1];
            raw += command[index + 1];
            index += 1;
            continue;
          }
        }
        value += inner;
        quoteSource += inner;
      }
      if (kind === "powershell" && quote === '"') {
        embeddedCommands.push(...extractPowerShellSubexpressions(quoteSource));
      }
      continue;
    }

    if (kind === "posix" && char === "\\" && index + 1 < command.length) {
      raw += char + command[index + 1];
      value += command[index + 1];
      index += 1;
      continue;
    }
    if (kind === "powershell" && char === "`" && index + 1 < command.length) {
      raw += char + command[index + 1];
      value += command[index + 1];
      index += 1;
      continue;
    }
    if (kind === "cmd" && char === "^" && index + 1 < command.length) {
      raw += char + command[index + 1];
      value += command[index + 1];
      index += 1;
      continue;
    }

    if ((kind === "cmd" ? "&|()" : kind === "powershell" ? ";&|(){}" : ";&|()").includes(char)) {
      const doubled = (char === "&" || char === "|") && command[index + 1] === char;
      pushOperator(doubled ? `${char}${char}` : char);
      if (doubled) index += 1;
      continue;
    }

    raw += char;
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
      result += kind === "powershell" ? " " : char;
      if ((kind === "posix" && char === "\\") || (kind === "powershell" && char === "`")) {
        if (index + 1 < command.length) {
          result += kind === "powershell" ? " " : command[index + 1];
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
      result += kind === "powershell" && char === '"' ? " " : char;
    }
  }
  if (kind === "powershell") {
    const embeddedCommands = tokenizeCommand(String(command || ""), kind)
      .flatMap((token) => token.type === "word" ? token.embeddedCommands : []);
    if (embeddedCommands.length > 0) result += `\n${embeddedCommands.join("\n")}`;
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
  index = skipPosixCommandPrefixes(tokens, index);

  for (let wrappers = 0; wrappers < 8 && tokens[index]?.type === "word"; wrappers += 1) {
    const command = tokens[index].value.toLowerCase();
    if (command === "env") {
      for (let optionIndex = index + 1; tokens[optionIndex]?.type === "word"; optionIndex += 1) {
        const option = tokens[optionIndex].value;
        if ((option === "-S" || option === "--split-string") && tokens[optionIndex + 1]?.type === "word") {
          return { index, kind: null, nestedCommand: tokens[optionIndex + 1].value };
        }
        if (option.startsWith("-S") && option.length > 2) {
          return { index, kind: null, nestedCommand: option.slice(2) };
        }
        if (option.startsWith("--split-string=")) {
          return { index, kind: null, nestedCommand: option.slice("--split-string=".length) };
        }
        if (!option.startsWith("-")) break;
        if (ENV_OPTIONS_WITH_VALUE.has(option)) optionIndex += 1;
      }
      index = skipOptionArguments(tokens, index + 1, ENV_OPTIONS_WITH_VALUE);
      index = skipPosixCommandPrefixes(tokens, index);
      continue;
    }
    if (command === "sudo") {
      index = skipOptionArguments(tokens, index + 1, SUDO_OPTIONS_WITH_VALUE);
      index = skipPosixCommandPrefixes(tokens, index);
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

function skipPosixCommandPrefixes(tokens, startIndex) {
  let index = startIndex;
  while (tokens[index]?.type === "word") {
    const value = tokens[index].value;
    if (POSIX_ASSIGNMENT.test(value)) {
      index += 1;
      continue;
    }
    const redirect = value.match(/^\d*(?:<>|>>?|<<?|>&|<&)(.*)$/);
    if (!redirect) break;
    index += redirect[1] ? 1 : 2;
  }
  return index;
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
  let inlineExecutable = null;
  let argumentList = [];
  const endIndex = powerShellCommandEndIndex(tokens, startIndex);
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    if (tokens[index].type !== "word") continue;
    const value = tokens[index].value;
    const colonIndex = value.startsWith("-") ? value.indexOf(":") : -1;
    const option = (colonIndex >= 0 ? value.slice(0, colonIndex) : value).toLowerCase();
    const inlineValue = colonIndex >= 0 ? value.slice(colonIndex + 1) : null;
    const startProcessOptions = [
      ...POWERSHELL_START_PROCESS_OPTIONS_WITH_VALUE,
      ...POWERSHELL_START_PROCESS_SWITCH_OPTIONS,
    ].filter((candidate) => candidate === option || candidate.startsWith(option));
    const resolvedOption = POWERSHELL_COMMON_PARAMETER_ALIASES.get(option)
      || (startProcessOptions.length === 1 ? startProcessOptions[0] : option);
    if (resolvedOption === "-filepath" && inlineValue) {
      inlineExecutable = inlineValue;
      continue;
    }
    if (resolvedOption === "-filepath" && tokens[index + 1]?.type === "word") {
      firstPositional = index + 1;
      index += 1;
      continue;
    }
    if (resolvedOption === "-argumentlist" && inlineValue) {
      argumentList = splitPowerShellList(inlineValue).map(powerShellLiteralValue).filter(Boolean);
      continue;
    }
    if (resolvedOption === "-argumentlist" && tokens[index + 1]?.type === "word") {
      const parsed = parsePowerShellArgumentList(tokens, index + 1, endIndex);
      argumentList = parsed.values;
      index = parsed.nextIndex - 1;
      continue;
    }
    if (POWERSHELL_START_PROCESS_OPTIONS_WITH_VALUE.has(resolvedOption)) {
      if (inlineValue == null && tokens[index + 1]?.type === "word") {
        const parsed = skipPowerShellExpression(tokens, index + 1, endIndex);
        index = parsed - 1;
      }
      continue;
    }
    if (!value.startsWith("-")) {
      if (firstPositional == null) firstPositional = index;
      else if (argumentList.length === 0) argumentList.push(value);
    }
  }
  if (firstPositional == null && inlineExecutable == null) return null;
  const executable = inlineExecutable || tokens[firstPositional].value;
  const kind = executableKind(executable);
  return {
    index: firstPositional ?? startIndex,
    kind,
    childCommand: kind
      ? [serializeChildArgument(executable), ...argumentList.map(serializeChildArgument)].join(" ")
      : null,
  };
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

function reconstructRawWords(tokens, startIndex, endIndex = commandEndIndex(tokens, startIndex)) {
  return tokens
    .slice(startIndex, endIndex)
    .map((token) => token.raw || token.value)
    .join(" ");
}

function powerShellCommandEndIndex(tokens, startIndex) {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "operator") continue;
    if (token.value === "(") {
      depth += 1;
      continue;
    }
    if (token.value === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0 && [";", "&", "&&", "|", "||", "\n", "}"].includes(token.value)) {
      return index;
    }
  }
  return tokens.length;
}

function skipPowerShellExpression(tokens, startIndex, endIndex) {
  if (tokens[startIndex]?.value !== "@" || tokens[startIndex + 1]?.value !== "(") {
    return Math.min(startIndex + 1, endIndex);
  }
  let depth = 0;
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    if (tokens[index].value === "(") depth += 1;
    if (tokens[index].value === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return endIndex;
}

function splitPowerShellList(source) {
  const values = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "`" && index + 1 < source.length) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (source[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === "," && depth === 0) {
      values.push(source.slice(start, index));
      start = index + 1;
    }
  }
  values.push(source.slice(start));
  return values;
}

function powerShellLiteralValue(source) {
  const tokens = tokenizeCommand(source.trim(), "powershell");
  if (tokens.length !== 1 || tokens[0].type !== "word") return source.trim();
  return tokens[0].value;
}

function parsePowerShellArgumentList(tokens, startIndex, endIndex) {
  let nextIndex = startIndex + 1;
  let source;
  if (tokens[startIndex]?.value === "@" && tokens[startIndex + 1]?.value === "(") {
    nextIndex = skipPowerShellExpression(tokens, startIndex, endIndex);
    source = reconstructRawWords(tokens, startIndex + 2, Math.max(startIndex + 2, nextIndex - 1));
  } else {
    const parts = [tokens[startIndex].raw || tokens[startIndex].value];
    while (parts.at(-1).trimEnd().endsWith(",") && tokens[nextIndex]?.type === "word") {
      parts.push(tokens[nextIndex].raw || tokens[nextIndex].value);
      nextIndex += 1;
    }
    source = parts.join(" ");
  }
  return {
    values: splitPowerShellList(source).map(powerShellLiteralValue).filter(Boolean),
    nextIndex,
  };
}

function serializeChildArgument(value) {
  const text = String(value || "");
  if (/^[^\s;&|(){}]+$/.test(text)) return text;
  if (text.startsWith('"') && text.endsWith('"')) return text;
  return `'${text.replace(/'/g, "''")}'`;
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
      ? ["-c", "-command", "-encodedcommand", "-enc"].includes(option)
      : option === "--command" || (/^-[^-]+$/.test(option) && option.slice(1).includes("c"));
    if (isCommandOption) {
      if (shellKind === "powershell" && ["-encodedcommand", "-enc"].includes(option)) {
        return decodePowerShellEncodedCommand(tokens[index + 1].value);
      }
      if (shellKind === "powershell" && option !== "-encodedcommand" && !tokens[index + 1].quoted) {
        return reconstructWords(tokens, index + 1);
      }
      return tokens[index + 1].value;
    }
  }
  return null;
}

function decodePowerShellEncodedCommand(value) {
  const encoded = String(value || "").trim();
  if (encoded.length === 0 || encoded.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return null;
  }
  try {
    const bytes = globalThis.atob(encoded);
    if (bytes.length === 0 || bytes.length % 2 !== 0) return null;
    let decoded = "";
    for (let index = 0; index < bytes.length; index += 2) {
      decoded += String.fromCharCode(bytes.charCodeAt(index) | (bytes.charCodeAt(index + 1) << 8));
    }
    return decoded.replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

function cmdNestedCommand(tokens, executableIndex) {
  const endIndex = commandEndIndex(tokens, executableIndex);
  for (let index = executableIndex + 1; index < endIndex; index += 1) {
    if (tokens[index].type !== "word") continue;
    const option = tokens[index].value;
    const lower = option.toLowerCase();
    if (lower === "/c" || lower === "/k") {
      const nestedTokens = tokens.slice(index + 1, endIndex);
      if (nestedTokens.length === 1 && nestedTokens[0].type === "word" && nestedTokens[0].quoted) {
        return nestedTokens[0].value;
      }
      const rawCommand = reconstructRawWords(tokens, index + 1, endIndex);
      return rawCommand.startsWith('""') && rawCommand.endsWith('"')
        ? rawCommand.slice(1, -1)
        : rawCommand;
    }
    if (lower.startsWith("/c") || lower.startsWith("/k")) {
      return `${option.slice(2)} ${reconstructRawWords(tokens, index + 1, endIndex)}`.trim();
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

function cmdIfCommandIndex(tokens, startIndex) {
  let index = startIndex + 1;
  while (["/i", "not"].includes(tokens[index]?.value.toLowerCase())) index += 1;
  const condition = tokens[index]?.value.toLowerCase();
  if (!condition) return null;
  if (["errorlevel", "cmdextversion", "defined", "exist"].includes(condition)) {
    return tokens[index + 2]?.type === "word" ? index + 2 : null;
  }
  if (condition.includes("==")) {
    return tokens[index + 1]?.type === "word" ? index + 1 : null;
  }
  if (["equ", "neq", "lss", "leq", "gtr", "geq"].includes(tokens[index + 1]?.value.toLowerCase())) {
    return tokens[index + 3]?.type === "word" ? index + 3 : null;
  }
  return null;
}

function isControlPrefix(kind, value) {
  const lower = String(value || "").toLowerCase();
  if (kind === "posix") {
    return ["!", "if", "then", "elif", "else", "while", "until", "do", "time", "{"].includes(lower);
  }
  if (kind === "powershell") {
    return [
      "if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch",
      "try", "catch", "finally", "trap", "begin", "process", "end", "function", "filter",
    ].includes(lower);
  }
  return false;
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
  const forcedCommandStarts = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "operator") {
      atCommandStart = true;
      continue;
    }
    if (forcedCommandStarts.has(index)) atCommandStart = true;
    const lower = token.value.toLowerCase();
    if (kind === "cmd" && ["else", "do"].includes(lower)) {
      atCommandStart = true;
      continue;
    }
    if (!atCommandStart) continue;
    if (isControlPrefix(kind, token.value)) continue;
    if (kind === "cmd" && lower === "if") {
      const commandIndex = cmdIfCommandIndex(tokens, index);
      if (commandIndex != null) forcedCommandStarts.add(commandIndex);
      atCommandStart = false;
      continue;
    }
    if (
      kind === "powershell"
      && token.quoted
      && tokens[index - 1]?.value === "&"
      && executableKind(token.value) == null
    ) {
      invocations.push({
        group: "powershell",
        command: reconstructWords(tokens, index, powerShellCommandEndIndex(tokens, index)),
      });
    }

    const resolved = kind === "posix"
      ? resolvePosixExecutable(tokens, index)
      : kind === "cmd"
        ? resolveCmdExecutable(tokens, index)
        : resolvePowerShellExecutable(tokens, index);
    if (resolved?.nestedCommand) {
      invocations.push({ group: "native", command: resolved.nestedCommand });
      invocations.push(...detectShellInvocations(resolved.nestedCommand, "posix", depth + 1));
    } else if (resolved?.childCommand) {
      invocations.push(...detectShellInvocations(resolved.childCommand, "powershell", depth + 1));
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
