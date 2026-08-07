export function tryBeginDraftSend(gate: { current: boolean }): boolean {
  if (gate.current) {
    return false;
  }

  gate.current = true;
  return true;
}

export function endDraftSend(gate: { current: boolean }): void {
  gate.current = false;
}

/** Alias kept for call sites that gate every send (draft + session), not just draft. */
export const tryBeginSend = tryBeginDraftSend;
export const endSend = endDraftSend;

/**
 * Remount-safe send latch. Component refs reset when StrictMode remounts
 * AIChatSidePanelActive mid-flight; a module Set keyed by session/draft scope
 * does not.
 */
const sendInFlightByKey = new Set<string>();

export function tryBeginSendForKey(key: string): boolean {
  if (!key || sendInFlightByKey.has(key)) return false;
  sendInFlightByKey.add(key);
  return true;
}

export function endSendForKey(key: string): void {
  if (!key) return;
  sendInFlightByKey.delete(key);
}
