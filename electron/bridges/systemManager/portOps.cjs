/* eslint-disable no-undef */

"use strict";

/**
 * Listening-port collectors.
 * Parsing approach inspired by Portwatch (ss -tlnp + process field), adapted for
 * remote SSH exec and UDP + IPv6.
 */

const LISTEN_PORTS_INNER = [
  'printf "%s\\n" "__NC_PORTS_BEGIN__"; ',
  'if command -v ss >/dev/null 2>&1; then ',
  'printf "%s\\n" "__NC_SS__"; ',
  // Prefer no-header when available; ignore failure and keep the headered form.
  "ss -H -tulnp 2>/dev/null || ss -tulnp 2>/dev/null || true; ",
  "elif command -v netstat >/dev/null 2>&1; then ",
  'printf "%s\\n" "__NC_NETSTAT__"; ',
  "netstat -lntp 2>/dev/null || netstat -anp 2>/dev/null || netstat -an 2>/dev/null || true; ",
  "elif command -v lsof >/dev/null 2>&1; then ",
  'printf "%s\\n" "__NC_LSOF__"; ',
  "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true; ",
  "lsof -nP -iUDP -sUDP:Idle 2>/dev/null || true; ",
  "fi; ",
  'printf "%s\\n" "__NC_PORTS_END__"',
].join("");

const LISTEN_PORTS_SCRIPT = `exec sh -c ${JSON.stringify(LISTEN_PORTS_INNER)}`;

const LISTEN_PORTS_WINDOWS = [
  'Write-Output "__NC_PORTS_BEGIN__"; ',
  'Write-Output "__NC_WIN__"; ',
  "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ",
  "Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress; ",
  'Write-Output "__NC_PORTS_END__"',
].join("");

function normalizeProtocol(raw) {
  const text = String(raw || "").trim().toLowerCase();
  if (text === "tcp" || text === "tcp4") return "tcp";
  if (text === "tcp6") return "tcp6";
  if (text === "udp" || text === "udp4") return "udp";
  if (text === "udp6") return "udp6";
  return "unknown";
}

function parseSsAddress(addr) {
  const text = String(addr || "").trim();
  if (!text) return null;
  const lastColon = text.lastIndexOf(":");
  if (lastColon <= 0) return null;
  const portText = text.slice(lastColon + 1);
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isFinite(port) || port < 0 || port > 65535) return null;
  let address = text.slice(0, lastColon);
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  if (address === "*" || address === "0.0.0.0" || address === "::") {
    address = "*";
  }
  return { address, port };
}

function parseSsProcess(info) {
  const text = String(info || "");
  // users:(("nginx",pid=1234,fd=6))
  const nameMatch = text.match(/"([^"]+)"/);
  const pidMatch = text.match(/pid=(\d+)/);
  return {
    processName: nameMatch?.[1] || "",
    pid: pidMatch ? Number(pidMatch[1]) : null,
  };
}

function makePortId(protocol, address, port, pid) {
  return `${protocol}|${address}|${port}|${pid == null ? "-" : pid}`;
}

function pushPort(entries, seen, row) {
  if (!row || !Number.isFinite(row.port)) return;
  const protocol = normalizeProtocol(row.protocol);
  const address = row.address || "*";
  const port = Number(row.port);
  const pid = Number.isFinite(row.pid) && row.pid > 0 ? Number(row.pid) : null;
  const processName = String(row.processName || "");
  const id = makePortId(protocol, address, port, pid);
  if (seen.has(id)) return;
  seen.add(id);
  entries.push({ id, protocol, address, port, pid, processName });
}

function parseSsOutput(stdout) {
  const entries = [];
  const seen = new Set();
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Netid\b/i.test(trimmed) || /^State\b/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    // Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
    if (parts.length < 5) continue;
    let protocol;
    let localAddr;
    let processField = "";
    if (/^(tcp|udp)/i.test(parts[0])) {
      protocol = parts[0];
      // With state column: parts[4] is local; without: parts[3]
      if (parts.length >= 6 && parts[4].includes(":")) {
        localAddr = parts[4];
        processField = parts.slice(6).join(" ");
      } else {
        localAddr = parts[3];
        processField = parts.slice(5).join(" ");
      }
    } else {
      // Headerless oddities — skip
      continue;
    }
    const parsed = parseSsAddress(localAddr);
    if (!parsed) continue;
    const proc = parseSsProcess(processField);
    pushPort(entries, seen, {
      protocol,
      address: parsed.address,
      port: parsed.port,
      pid: proc.pid,
      processName: proc.processName,
    });
  }
  return entries;
}

function parseNetstatOutput(stdout) {
  const entries = [];
  const seen = new Set();
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Proto\b/i.test(trimmed) || /^Active\b/i.test(trimmed)) continue;
    // tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 1234/sshd
    const m = trimmed.match(
      /^(tcp6?|udp6?)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(?:LISTEN\s+)?(\S+)?/i,
    );
    if (!m) continue;
    const protocol = m[1];
    const local = m[2];
    const stateOrPid = m[4] || "";
    const isUdp = /^udp/i.test(protocol);
    if (!isUdp && !/LISTEN/i.test(trimmed)) continue;
    const parsed = parseSsAddress(local);
    if (!parsed) continue;
    let pid = null;
    let processName = "";
    const pidMatch = stateOrPid.match(/^(\d+)\/(.+)$/);
    if (pidMatch) {
      pid = Number(pidMatch[1]);
      processName = pidMatch[2];
    }
    pushPort(entries, seen, {
      protocol,
      address: parsed.address,
      port: parsed.port,
      pid,
      processName,
    });
  }
  return entries;
}

function parseLsofOutput(stdout) {
  const entries = [];
  const seen = new Set();
  for (const line of String(stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^COMMAND\b/i.test(trimmed)) continue;
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const parts = trimmed.split(/\s+/);
    if (parts.length < 9) continue;
    const processName = parts[0];
    const pid = Number(parts[1]);
    const nameField = parts.slice(8).join(" ");
    const listenMatch = nameField.match(
      /^(?:(\d[\d.]*|\[?[0-9a-f:]+\]?|\*):)?(\d+)\s+\((LISTEN|UDP)\)/i,
    ) || nameField.match(/^([^\s]+):(\d+)(?:\s+\((LISTEN|UDP)\))?/i);
    if (!listenMatch) continue;
    const addressRaw = listenMatch[1] || "*";
    const port = Number(listenMatch[2]);
    const kind = (listenMatch[3] || "LISTEN").toUpperCase();
    const protocol = kind === "UDP" ? "udp" : "tcp";
    let address = addressRaw;
    if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
    if (address === "0.0.0.0" || address === "::" || address === "*") address = "*";
    pushPort(entries, seen, {
      protocol,
      address,
      port,
      pid: Number.isFinite(pid) ? pid : null,
      processName,
    });
  }
  return entries;
}

function parseWindowsPortsJson(stdout) {
  const entries = [];
  const seen = new Set();
  const text = String(stdout || "").trim();
  if (!text) return entries;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return entries;
  }
  const list = Array.isArray(raw) ? raw : [raw];
  for (const row of list) {
    if (!row) continue;
    const port = Number(row.LocalPort);
    const pid = Number(row.OwningProcess);
    let address = String(row.LocalAddress || "*");
    if (address === "0.0.0.0" || address === "::" || address === "*") address = "*";
    pushPort(entries, seen, {
      protocol: address.includes(":") ? "tcp6" : "tcp",
      address,
      port,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      processName: "",
    });
  }
  return entries;
}

function extractSection(stdout, beginMarker) {
  const text = String(stdout || "");
  const begin = text.indexOf(beginMarker);
  if (begin < 0) return "";
  const after = text.slice(begin + beginMarker.length);
  const end = after.search(/\n__NC_(SS|NETSTAT|LSOF|WIN|PORTS_END)__/);
  return end >= 0 ? after.slice(0, end) : after;
}

function parseListeningPorts(stdout) {
  const text = String(stdout || "");
  if (text.includes("__NC_SS__")) {
    return parseSsOutput(extractSection(text, "__NC_SS__")).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  }
  if (text.includes("__NC_NETSTAT__")) {
    return parseNetstatOutput(extractSection(text, "__NC_NETSTAT__")).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  }
  if (text.includes("__NC_LSOF__")) {
    return parseLsofOutput(extractSection(text, "__NC_LSOF__")).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  }
  if (text.includes("__NC_WIN__")) {
    return parseWindowsPortsJson(extractSection(text, "__NC_WIN__")).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  }
  // Bare ss / netstat without markers (fallback probes)
  const ss = parseSsOutput(text);
  if (ss.length) return ss.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  const ns = parseNetstatOutput(text);
  if (ns.length) return ns.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
  return parseLsofOutput(text).sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

function createPortOpsApi({
  execOnSession,
  execOnLocalMachine,
  isLocalSession,
  process,
}) {
  async function listListeningPorts(event, sessionId) {
    if (!sessionId) return { success: false, error: "Missing sessionId" };

    if (isLocalSession(sessionId) && process.platform === "win32") {
      const result = await execOnLocalMachine(LISTEN_PORTS_WINDOWS, 12000);
      if (!result.success) return { success: false, error: result.error || "Failed to list ports" };
      return { success: true, ports: parseListeningPorts(result.stdout) };
    }

    const result = await execOnSession(event, sessionId, LISTEN_PORTS_SCRIPT, 12000);
    if (result.pending) return { success: false, pending: true };
    if (!result.success) return { success: false, error: result.error || "Failed to list ports" };
    return { success: true, ports: parseListeningPorts(result.stdout) };
  }

  return {
    listListeningPorts,
    parseListeningPorts,
    parseSsOutput,
    parseNetstatOutput,
    parseLsofOutput,
  };
}

module.exports = {
  createPortOpsApi,
  parseListeningPorts,
  parseSsOutput,
  parseNetstatOutput,
  parseLsofOutput,
  LISTEN_PORTS_SCRIPT,
};
