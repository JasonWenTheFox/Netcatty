/**
 * Tracks the active terminal boot epoch per UI session id so async auth
 * prompts (keyboard-interactive / MFA) can reject superseded reconnect
 * attempts that still share the same sessionId.
 */
const terminalBootEpochs = new Map<string, number>();

export function setTerminalBootEpoch(sessionId: string, epoch: number): void {
  if (!sessionId) return;
  terminalBootEpochs.set(sessionId, epoch);
}

export function clearTerminalBootEpoch(sessionId: string): void {
  if (!sessionId) return;
  terminalBootEpochs.delete(sessionId);
}

export function getTerminalBootEpoch(sessionId: string): number | undefined {
  return terminalBootEpochs.get(sessionId);
}

/** Legacy prompts without bootEpoch stay eligible; mismatched epochs are stale. */
export function isTerminalBootEpochCurrent(
  sessionId: string,
  requestEpoch: number | undefined,
): boolean {
  if (!Number.isFinite(requestEpoch)) return true;
  const current = terminalBootEpochs.get(sessionId);
  if (current === undefined) return true;
  return current === requestEpoch;
}
