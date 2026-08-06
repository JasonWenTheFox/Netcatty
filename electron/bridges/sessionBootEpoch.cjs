/**
 * Correlate overlapping terminal starts that share one UI sessionId.
 * A higher bootEpoch owns the registry slot; mismatched closes are no-ops.
 */

function normalizeBootEpoch(bootEpoch) {
  if (!Number.isFinite(bootEpoch)) return undefined;
  return Number(bootEpoch);
}

function attachBootEpoch(session, bootEpoch) {
  const normalized = normalizeBootEpoch(bootEpoch);
  if (normalized === undefined || !session || typeof session !== "object") return session;
  session.bootEpoch = normalized;
  return session;
}

/**
 * Best-effort teardown for a session object that lost its registry slot to a
 * newer bootEpoch. Must not look the session up by ID (the map already points
 * at the replacement).
 */
function disposeDisplacedSessionResources(session) {
  if (!session || session._displacedDisposed) return;
  session._displacedDisposed = true;
  try { session.zmodemSentry?.cancel?.(); } catch { /* ignore */ }
  try { session.discardPendingData?.(); } catch { /* ignore */ }
  try { session.releaseTelnetGeneration?.(); } catch { /* ignore */ }
  try {
    if (session.stream) {
      try { session.stream.close(); } catch { /* ignore */ }
      if (session.connRef) {
        try {
          const { releaseConnectionRef } = require("./sshConnectionPool.cjs");
          releaseConnectionRef(session);
        } catch {
          try { session.conn?.end?.(); } catch { /* ignore */ }
        }
      } else {
        try { session.conn?.end?.(); } catch { /* ignore */ }
        for (const hop of session.chainConnections || []) {
          try { hop.end?.(); } catch { /* ignore */ }
        }
      }
    } else if (session.proc) {
      try { session.proc.kill(); } catch { /* ignore */ }
      try { session.moshStatsConn?.end?.(); } catch { /* ignore */ }
      try { session.etStatsConn?.end?.(); } catch { /* ignore */ }
    } else if (session.socket) {
      try { session.socket.destroy(); } catch { /* ignore */ }
    } else if (session.serialPort) {
      try { session.serialPort.close(); } catch { /* ignore */ }
    } else if (session.chainConnections) {
      for (const hop of session.chainConnections) {
        try { hop.end?.(); } catch { /* ignore */ }
      }
    }
  } catch {
    // Best effort only.
  }
}

/**
 * @returns {{ ok: true, displaced?: object } | { ok: false, reason: "superseded" }}
 */
function claimSessionSlot(sessions, sessionId, session, bootEpoch) {
  if (!sessions || typeof sessions.get !== "function" || typeof sessions.set !== "function") {
    return { ok: true };
  }
  const normalized = normalizeBootEpoch(bootEpoch);
  const existing = sessions.get(sessionId);
  if (
    existing
    && existing !== session
    && Number.isFinite(existing.bootEpoch)
    && normalized !== undefined
    && normalized < existing.bootEpoch
  ) {
    return { ok: false, reason: "superseded" };
  }
  if (normalized !== undefined) {
    session.bootEpoch = normalized;
  }
  let displaced;
  // When a newer boot replaces an older registry entry, mark and return the
  // old object so the caller can tear down its transport without touching the
  // replacement slot.
  if (
    existing
    && existing !== session
    && Number.isFinite(existing.bootEpoch)
    && normalized !== undefined
    && normalized > existing.bootEpoch
  ) {
    existing.supersededByBootEpoch = normalized;
    existing.closed = true;
    displaced = existing;
  }
  sessions.set(sessionId, session);
  if (displaced) {
    disposeDisplacedSessionResources(displaced);
  }
  return displaced ? { ok: true, displaced } : { ok: true };
}

function sessionMatchesBootEpoch(session, bootEpoch) {
  const normalized = normalizeBootEpoch(bootEpoch);
  if (normalized === undefined) return true;
  if (!session || !Number.isFinite(session.bootEpoch)) return true;
  return session.bootEpoch === normalized;
}

module.exports = {
  attachBootEpoch,
  claimSessionSlot,
  disposeDisplacedSessionResources,
  normalizeBootEpoch,
  sessionMatchesBootEpoch,
};
