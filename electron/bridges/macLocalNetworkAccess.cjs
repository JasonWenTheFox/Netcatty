"use strict";

/**
 * macOS Local Network privacy gate (Apple TN3179 / issues #1040, #2663, #2673).
 *
 * Since macOS 15, outbound TCP/UDP to LAN addresses requires the user's
 * Local Network privilege. Netcatty already declares
 * NSLocalNetworkUsageDescription and rewrites the main executable LC_UUID
 * (#1040), but SSH sessions normally run inside Electron's utilityProcess
 * (terminal worker). Connections from that helper often fail with
 * EHOSTUNREACH without ever registering "Netcatty" under
 * System Settings → Privacy & Security → Local Network — so the user never
 * gets a prompt and has nothing to toggle.
 *
 * Before the worker opens a LAN socket, the main process performs Apple's
 * recommended trigger: connect a UDP socket to a local-network address on
 * the discard port (9). That attributes the attempt to the app bundle and
 * can present the system alert without sending traffic (TN3179).
 *
 * Hostnames are resolved first so vault entries like "dev-viet" that map to
 * 192.168.x still probe; `.local` mDNS names are probed directly.
 */

const net = require("node:net");
const dgram = require("node:dgram");
const dns = require("node:dns");

/** Keep the pre-SSH LAN probe short so dead hosts do not stall the dial. */
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
/** Hold the connected UDP socket briefly so TCC can present the alert (FB16131937). */
const DEFAULT_PROBE_HOLD_MS = 500;
/** IANA discard service - Apple's TN3179 sample uses this port for the trigger. */
const DISCARD_PORT = 9;
const LOCAL_NETWORK_HINT =
  "macOS may be blocking Local Network access. Open System Settings → Privacy & Security → Local Network, enable Netcatty, then reconnect.";

const defaultLookup = dns.promises.lookup.bind(dns.promises);

function stripIpBrackets(value) {
  return String(value || "").replace(/^\[|\]$/g, "").trim();
}

function isIpv4LocalNetworkAddress(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / Tailscale
  return false;
}

/**
 * First hextet of an IPv6 address (handles leading "::" compression).
 * Returns null when the address is not a usable IPv6 form for prefix checks.
 */
function ipv6FirstHextet(address) {
  const lower = String(address || "").toLowerCase();
  if (!lower) return null;
  if (lower.startsWith("::ffff:")) return null;
  if (lower.startsWith("::")) return 0;
  const first = lower.split(":")[0];
  if (!/^[0-9a-f]{1,4}$/.test(first)) return null;
  return Number.parseInt(first, 16);
}

function isIpv6LocalNetworkAddress(hostname) {
  if (net.isIP(hostname) !== 6) return false;
  const lower = hostname.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 — classify the embedded v4 address.
    return isLocalNetworkHostname(lower.slice("::ffff:".length));
  }
  const hextet = ipv6FirstHextet(lower);
  if (hextet == null || Number.isNaN(hextet)) return false;
  // fc00::/7 unique local
  if (hextet >= 0xfc00 && hextet <= 0xfdff) return true;
  // fe80::/10 link-local
  if (hextet >= 0xfe80 && hextet <= 0xfebf) return true;
  return false;
}

/**
 * True only for literal private IP forms. Hostnames (including ones that
 * merely start with "fc"/"fd") are never treated as LAN without resolution.
 */
function isLocalNetworkHostname(hostname) {
  if (hostname == null) return false;
  const cleaned = stripIpBrackets(hostname);
  if (!cleaned) return false;

  const ipVersion = net.isIP(cleaned);
  if (ipVersion === 4) return isIpv4LocalNetworkAddress(cleaned);
  if (ipVersion === 6) return isIpv6LocalNetworkAddress(cleaned);
  return false;
}

/**
 * RFC 6762 mDNS names (*.local). Resolving or connecting to them requires
 * Local Network access on macOS 15+ (TN3179 DNS / Bonjour sections).
 */
function isLocalMdnsName(hostname) {
  if (hostname == null) return false;
  const cleaned = stripIpBrackets(hostname).toLowerCase().replace(/\.$/, "");
  if (!cleaned || cleaned === "localhost") return false;
  if (net.isIP(cleaned)) return false;
  return cleaned.endsWith(".local");
}

/**
 * First TCP hop the local process will open for this SSH dial.
 * Prefer HTTP/SOCKS proxy host when configured, else first jump host, else target.
 */
function resolveFirstTcpEndpoint(options = {}) {
  const proxy = options.proxy && typeof options.proxy === "object" ? options.proxy : null;
  if (
    proxy
    && proxy.type !== "command"
    && String(proxy.host || proxy.hostname || "").trim()
  ) {
    const hostname = String(proxy.host || proxy.hostname || "").trim();
    const port = Number(proxy.port);
    return {
      hostname,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 1080,
    };
  }

  const jumpHosts = Array.isArray(options.jumpHosts) ? options.jumpHosts : [];
  if (jumpHosts.length > 0) {
    const first = jumpHosts[0] || {};
    const hostname = String(first.hostname || first.host || "").trim();
    const port = Number(first.port);
    return {
      hostname,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22,
    };
  }

  const hostname = String(options.hostname || options.host || "").trim();
  const port = Number(options.port);
  return {
    hostname,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22,
  };
}

/**
 * Decide which hostname/IP to UDP-probe for Local Network TCC attribution.
 * @returns {Promise<{ hostname: string, reason: "literal"|"mdns"|"resolved" }|null>}
 */
async function resolveLanProbeTarget(hostname, options = {}) {
  const cleaned = stripIpBrackets(hostname);
  if (!cleaned) return null;
  if (isLocalNetworkHostname(cleaned)) {
    return { hostname: cleaned, reason: "literal" };
  }
  if (isLocalMdnsName(cleaned)) {
    return { hostname: cleaned, reason: "mdns" };
  }
  if (net.isIP(cleaned)) return null;

  const lookup = options.lookup || defaultLookup;
  try {
    const results = await lookup(cleaned, { all: true, verbatim: true });
    const list = Array.isArray(results) ? results : results ? [results] : [];
    for (const entry of list) {
      const address = typeof entry === "string" ? entry : entry?.address;
      if (address && isLocalNetworkHostname(address)) {
        return { hostname: stripIpBrackets(address), reason: "resolved" };
      }
    }
  } catch {
    // DNS failure is not fatal; skip the probe and let SSH report its own error.
  }
  return null;
}

function looksLikeHostUnreachableMessage(message) {
  const text = String(message || "");
  return /EHOSTUNREACH|ENETUNREACH|host is unreachable|network is unreachable/i.test(text);
}

function extractIpv4Addresses(text) {
  const matches = String(text || "").match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
  return matches.filter((ip) => isLocalNetworkHostname(ip));
}

function annotateMacLocalNetworkErrorMessage(message, options = {}) {
  const platform = options.platform || process.platform;
  const text = String(message || "");
  if (platform !== "darwin") return text;
  if (!looksLikeHostUnreachableMessage(text)) return text;
  if (text.includes("Local Network")) return text;

  const candidates = [
    options.hostname,
    options.host,
    options.firstHopHostname,
    ...extractIpv4Addresses(text),
  ].filter((value) => value != null && String(value).trim() !== "");
  const touchesLan = candidates.some((value) => (
    isLocalNetworkHostname(value) || isLocalMdnsName(value)
  ));
  if (!touchesLan) return text;
  return `${text}\n\n${LOCAL_NETWORK_HINT}`;
}

function pickUdpType(hostname) {
  const cleaned = stripIpBrackets(hostname);
  if (net.isIP(cleaned) === 6) return "udp6";
  return "udp4";
}

function createMacLocalNetworkAccessGate(options = {}) {
  const platform = options.platform || process.platform;
  const versions = options.versions || process.versions;
  const dgramModule = options.dgram || dgram;
  const lookup = options.lookup || defaultLookup;
  const probedKeys = options.probedKeys || new Set();
  const inFlight = options.inFlight || new Map();
  const probeTimeoutMs = Number.isFinite(options.probeTimeoutMs)
    ? Math.max(500, Math.round(options.probeTimeoutMs))
    : DEFAULT_PROBE_TIMEOUT_MS;
  const probeHoldMs = Number.isFinite(options.probeHoldMs)
    ? Math.max(0, Math.round(options.probeHoldMs))
    : DEFAULT_PROBE_HOLD_MS;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  // Bare Node unit tests (and non-Electron CLIs) must never open LAN sockets.
  // Only the real Electron main process should trigger the TCC prompt.
  const electronRuntime = options.forceElectron === true
    || (options.forceElectron !== false && Boolean(versions?.electron));

  function probeKey(hostname) {
    return String(hostname).toLowerCase();
  }

  function runUdpProbe(hostname) {
    return new Promise((resolve) => {
      let settled = false;
      let socket = null;
      let safetyTimer = null;
      let holdTimer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (safetyTimer) clearTimer(safetyTimer);
        if (holdTimer) clearTimer(holdTimer);
        safetyTimer = null;
        holdTimer = null;
        try { socket?.close(); } catch { /* ignore */ }
        resolve();
      };

      try {
        socket = dgramModule.createSocket(pickUdpType(hostname));
        socket.once?.("error", finish);
        safetyTimer = setTimer(finish, probeTimeoutMs);
        socket.connect(DISCARD_PORT, hostname, () => {
          if (settled) return;
          // Clear the connect safety window once connected so a slow
          // .local/mDNS resolve cannot truncate the intentional hold
          // that gives TCC time to present the Local Network alert.
          if (safetyTimer) {
            clearTimer(safetyTimer);
            safetyTimer = null;
          }
          if (probeHoldMs <= 0) {
            finish();
            return;
          }
          holdTimer = setTimer(finish, probeHoldMs);
        });
      } catch {
        finish();
      }
    });
  }

  async function ensureAccess(connectOptions = {}) {
    if (platform !== "darwin") return { skipped: true, reason: "platform" };
    if (!electronRuntime) return { skipped: true, reason: "not-electron" };
    // Main process already probed before forwarding into the terminal
    // worker; skip the second hold in utilityProcess (#2673 Codex P2).
    if (connectOptions._macLocalNetworkMainProbed === true) {
      return { skipped: true, reason: "main-probed" };
    }

    const endpoint = resolveFirstTcpEndpoint(connectOptions);
    if (!endpoint.hostname) {
      return { skipped: true, reason: "not-local-network" };
    }

    const target = await resolveLanProbeTarget(endpoint.hostname, { lookup });
    if (!target) {
      return { skipped: true, reason: "not-local-network" };
    }

    const key = probeKey(target.hostname);
    if (probedKeys.has(key)) return { skipped: true, reason: "cached" };

    const pending = inFlight.get(key);
    if (pending) {
      await pending;
      return { skipped: true, reason: "in-flight" };
    }

    const probe = runUdpProbe(target.hostname).finally(() => {
      inFlight.delete(key);
      probedKeys.add(key);
    });
    inFlight.set(key, probe);
    await probe;
    return {
      probed: true,
      hostname: target.hostname,
      port: DISCARD_PORT,
      reason: target.reason,
    };
  }

  return {
    ensureAccess,
    isLocalNetworkHostname,
    isLocalMdnsName,
    resolveFirstTcpEndpoint,
    getProbeTimeoutMs: () => probeTimeoutMs,
    getProbeHoldMs: () => probeHoldMs,
    annotateErrorMessage(message, connectOptions = {}) {
      const endpoint = resolveFirstTcpEndpoint(connectOptions);
      return annotateMacLocalNetworkErrorMessage(message, {
        platform,
        hostname: connectOptions.hostname || connectOptions.host,
        firstHopHostname: endpoint.hostname,
      });
    },
  };
}

const defaultGate = createMacLocalNetworkAccessGate();

module.exports = {
  LOCAL_NETWORK_HINT,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_PROBE_HOLD_MS,
  DISCARD_PORT,
  isLocalNetworkHostname,
  isLocalMdnsName,
  resolveFirstTcpEndpoint,
  resolveLanProbeTarget,
  annotateMacLocalNetworkErrorMessage,
  createMacLocalNetworkAccessGate,
  ensureMacLocalNetworkAccess: (options) => defaultGate.ensureAccess(options),
  annotateMacLocalNetworkError: (message, options) => defaultGate.annotateErrorMessage(message, options),
};
