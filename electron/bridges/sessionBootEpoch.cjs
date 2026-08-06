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
 * @returns {{ ok: true } | { ok: false, reason: "superseded" }}
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
  // When a newer boot replaces an older registry entry, mark the old object so
  // its async close/exit handlers do not tear down the replacement slot.
  if (
    existing
    && existing !== session
    && Number.isFinite(existing.bootEpoch)
    && normalized !== undefined
    && normalized > existing.bootEpoch
  ) {
    existing.supersededByBootEpoch = normalized;
    existing.closed = true;
  }
  sessions.set(sessionId, session);
  return { ok: true };
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
  normalizeBootEpoch,
  sessionMatchesBootEpoch,
};
