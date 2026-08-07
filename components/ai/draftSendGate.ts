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
