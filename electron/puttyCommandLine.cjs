const SSH_PROTOCOL = "ssh";
const TELNET_PROTOCOL = "telnet";

const PROTOCOL_FLAGS = new Map([
  ["-ssh", SSH_PROTOCOL],
  ["-telnet", TELNET_PROTOCOL],
]);

const VALUE_FLAGS = new Set(["-P", "-p", "-l", "-pw", "-pwfile", "-load", "-i", "-newtab", "-title", "-loghost"]);
const PORT_FLAGS = new Set(["-P", "-p"]);

const SKIP_FLAGS = new Set([
  "-1", "-2", "-4", "-6",
  "-A", "-a",
  "-C",
  "-N",
  "-T", "-t",
  "-X", "-x",
  "-v",
  "-agent", "-pagent", "-pageant",
  "-noagent", "-nopagent", "-nopageant",
]);

function parsePort(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function looksLikeIpv4(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function looksLikeIpv6(value) {
  return (value.match(/:/g) || []).length >= 2;
}

function isElectronNoiseArg(arg, index) {
  if (typeof arg !== "string") return true;
  if (index === 0) return true;
  if (arg === "." || arg === "--") return true;
  if (arg.startsWith("--")) return true;
  if (/\.(?:exe|app|js|cjs|mjs|asar)$/i.test(arg)) return true;
  if ((arg.includes("/") || arg.includes("\\")) && !arg.includes("@")) return true;
  return false;
}

function parseHostSpec(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;

  let username;
  let hostPart = trimmed;
  const at = trimmed.lastIndexOf("@");
  if (at >= 0) {
    username = trimmed.slice(0, at).trim();
    hostPart = trimmed.slice(at + 1).trim();
    if (!username) username = undefined;
  }
  if (!hostPart) return null;

  let hostname;
  let port;
  if (hostPart.startsWith("[")) {
    const end = hostPart.indexOf("]");
    if (end < 0) return null;
    hostname = hostPart.slice(1, end).trim();
    const rest = hostPart.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      port = parsePort(rest.slice(1));
      if (port === null) return null;
    }
  } else if (!looksLikeIpv6(hostPart) && hostPart.includes(":")) {
    const colon = hostPart.lastIndexOf(":");
    hostname = hostPart.slice(0, colon).trim();
    port = parsePort(hostPart.slice(colon + 1));
    if (port === null) return null;
  } else {
    hostname = hostPart.replace(/^\[(.*)\]$/, "$1").trim();
  }

  if (!hostname) return null;
  return {
    ...(username ? { username } : {}),
    hostname,
    ...(port ? { port } : {}),
  };
}

function hostCandidateScore(spec) {
  if (!spec) return 0;
  let score = 1;
  if (spec.username) score += 4;
  if (spec.port) score += 2;
  if (looksLikeIpv4(spec.hostname) || looksLikeIpv6(spec.hostname)) score += 3;
  else if (spec.hostname.includes(".")) score += 2;
  return score;
}

function encodeUserInfo(username, password) {
  if (username) {
    const user = encodeURIComponent(username);
    return password !== undefined ? `${user}:${encodeURIComponent(password)}` : user;
  }
  if (password !== undefined) return `:${encodeURIComponent(password)}`;
  return "";
}

function formatHostnameForUrl(hostname) {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

function toDeepLinkUrl({ protocol, username, password, hostname, port }) {
  const auth = encodeUserInfo(username, password);
  const host = formatHostnameForUrl(hostname);
  const portPart = port ? `:${port}` : "";
  return `${protocol}://${auth ? `${auth}@` : ""}${host}${portPart}`;
}

function hasPuttyLaunchSignal(argv) {
  if (!Array.isArray(argv)) return false;
  return argv.some((arg) => {
    if (typeof arg !== "string") return false;
    return PROTOCOL_FLAGS.has(arg) || arg === "-pw" || arg === "-pwfile" || arg === "-l" || PORT_FLAGS.has(arg);
  });
}

function parsePuttyCommandLine(argv) {
  if (!Array.isArray(argv) || !hasPuttyLaunchSignal(argv)) return null;

  let protocol = SSH_PROTOCOL;
  let username;
  let password;
  let port;
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string" || !arg) continue;
    if (isElectronNoiseArg(arg, index)) continue;

    const protocolFromFlag = PROTOCOL_FLAGS.get(arg);
    if (protocolFromFlag) {
      protocol = protocolFromFlag;
      continue;
    }

    if (SKIP_FLAGS.has(arg)) continue;

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (typeof value !== "string") continue;
      index += 1;
      if (PORT_FLAGS.has(arg)) {
        const parsedPort = parsePort(value);
        if (parsedPort === null) return null;
        port = parsedPort;
        continue;
      }
      if (arg === "-l") {
        const nextUser = value.trim();
        if (nextUser) username = nextUser;
        continue;
      }
      if (arg === "-pw") {
        password = value;
        continue;
      }
      continue;
    }

    if (arg.startsWith("-")) continue;

    const positionalPort = parsePort(arg);
    if (positionalPort !== null && /^\d+$/.test(arg.trim())) {
      if (port === undefined) port = positionalPort;
      continue;
    }

    const spec = parseHostSpec(arg);
    if (spec) {
      positionals.push(spec);
    }
  }

  if (positionals.length === 0) return null;

  const hostSpec = positionals.reduce((best, candidate) => (
    hostCandidateScore(candidate) > hostCandidateScore(best) ? candidate : best
  ));

  const resolvedUsername = (username || hostSpec.username || "").trim() || undefined;
  const resolvedPort = port ?? hostSpec.port;
  const hostname = hostSpec.hostname;
  if (!hostname) return null;

  const url = toDeepLinkUrl({
    protocol,
    username: resolvedUsername,
    password,
    hostname,
    port: resolvedPort,
  });

  return {
    protocol,
    url,
    hostname,
    ...(resolvedUsername ? { username: resolvedUsername } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(resolvedPort ? { port: resolvedPort } : {}),
  };
}

function redactPuttyCommandLinePasswords(argv) {
  if (!Array.isArray(argv)) return argv;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "-pw") continue;
    const next = argv[index + 1];
    if (typeof next !== "string") continue;
    argv[index + 1] = "*".repeat(Math.min(next.length, 8)) || "********";
  }
  return argv;
}

module.exports = {
  parsePuttyCommandLine,
  redactPuttyCommandLinePasswords,
};
