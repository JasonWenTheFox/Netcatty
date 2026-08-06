import type { MutableRefObject } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal as XTerm } from "@xterm/xterm";

import { logger } from "../../lib/logger";
import type { TerminalHibernateWakePayload } from "../../domain/terminalHibernate";
import {
  createXTermRuntime,
  type CreateXTermRuntimeContext,
  type XTermRuntime,
} from "./runtime/createXTermRuntime";
import {
  appendTerminalReplayData,
  applyHibernateWakeToTerminal,
  nudgeAlternateScreenRedraw,
} from "./terminalHibernateRuntime";
import {
  applyTerminalKeywordHighlightRules,
  type AdditionalTerminalKeywordHighlightRule,
} from "./terminalKeywordHighlightRules";

export { applyTerminalKeywordHighlightRules } from "./terminalKeywordHighlightRules";

export type TerminalRuntimeRefs = {
  xtermRuntimeRef: MutableRefObject<XTermRuntime | null>;
  termRef: MutableRefObject<XTerm | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  serializeAddonRef: MutableRefObject<SerializeAddon | null>;
  searchAddonRef: MutableRefObject<SearchAddon | null>;
  hasRuntimeRef: MutableRefObject<boolean>;
};

export function assignTerminalRuntimeRefs(
  refs: TerminalRuntimeRefs,
  runtime: XTermRuntime,
): void {
  refs.xtermRuntimeRef.current = runtime;
  refs.termRef.current = runtime.term;
  refs.fitAddonRef.current = runtime.fitAddon;
  refs.serializeAddonRef.current = runtime.serializeAddon;
  refs.searchAddonRef.current = runtime.searchAddon;
  refs.hasRuntimeRef.current = true;
}

export type WakeTerminalFromHibernateOptions = {
  refs: TerminalRuntimeRefs;
  runtimeContext: Omit<CreateXTermRuntimeContext, "container" | "initiallyVisible" | "deferWebglUntilReplayComplete">;
  container: HTMLDivElement;
  getPayload: () => TerminalHibernateWakePayload;
  /**
   * Atomically read and clear hibernate pending output. Required so chunked
   * full-history replay cannot race the capped pending buffer: length-based
   * slicing misses bytes when capHibernateBuffer trims the front during wake.
   */
  takePendingBuffer: () => string;
  /** Stop hibernate IPC listeners before reading the final replay payload. */
  stopHibernateListeners: () => void;
  reattachSession: (term: XTerm) => void;
  safeFit: (options?: { force?: boolean; requireVisible?: boolean }) => void;
  resizeSession: () => void;
  forceSyncRenderAfterResize: (term: XTerm) => void;
  lastFittedSizeRef: MutableRefObject<{ width: number; height: number } | null>;
  isBootActiveRef: MutableRefObject<boolean>;
  sessionId: string;
  updateStatus: (status: "connected") => void;
  /** When false, recreate xterm and replay output without reattaching or forcing connected status. */
  sessionConnected?: boolean;
  getSessionConnected?: () => boolean;
  replayChunkBytes?: number;
  additionalKeywordHighlightRules?: readonly AdditionalTerminalKeywordHighlightRule[];
};

export async function wakeTerminalFromHibernate(
  options: WakeTerminalFromHibernateOptions,
): Promise<boolean> {
  const {
    refs,
    runtimeContext,
    container,
    getPayload,
    takePendingBuffer,
    stopHibernateListeners,
    reattachSession,
    safeFit,
    resizeSession,
    forceSyncRenderAfterResize,
    lastFittedSizeRef,
    isBootActiveRef,
    sessionId,
    updateStatus,
    sessionConnected = true,
    getSessionConnected,
    replayChunkBytes = 16 * 1024,
    additionalKeywordHighlightRules = Object.freeze([]),
  } = options;

  if (refs.hasRuntimeRef.current) {
    return true;
  }

  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      return;
    }
    window.setTimeout(resolve, 0);
  });

  isBootActiveRef.current = true;
  lastFittedSizeRef.current = null;

  const runtime = createXTermRuntime({
    ...runtimeContext,
    container,
    initiallyVisible: true,
    deferWebglUntilReplayComplete: true,
  });

  assignTerminalRuntimeRefs(refs, runtime);
  applyTerminalKeywordHighlightRules(
    runtime,
    runtimeContext.terminalSettingsRef,
    runtimeContext.host,
    additionalKeywordHighlightRules,
  );

  const term = runtime.term;
  const initialPayload = getPayload();
  // Capture pending for this replay pass and clear the live buffer so arrivals
  // during chunked history replay accumulate as a pure delta (survives the
  // 512 KiB pending cap without length-slice gaps).
  const pendingAtApplyStart = takePendingBuffer();
  const replayOptions = { chunkBytes: replayChunkBytes };

  await applyHibernateWakeToTerminal(term, runtime, {
    ...initialPayload,
    pendingBuffer: pendingAtApplyStart,
  }, {
    replayOptions,
    deferWebgl: true,
  });
  runtime.cursorLineHighlighter.refresh({ force: true });

  let replayedPendingChars = pendingAtApplyStart.length;
  for (let drainPass = 0; drainPass < 16; drainPass += 1) {
    const pendingDelta = takePendingBuffer();
    if (!pendingDelta) break;
    await appendTerminalReplayData(term, pendingDelta, replayOptions);
    replayedPendingChars += pendingDelta.length;
  }

  // Stop hibernate IPC first so no further bytes land in the pending ref, then
  // take any remainder once. Awaiting a final write while listeners are still
  // live can lose already-acked chunks that arrive during that write.
  stopHibernateListeners();
  const finalPendingDelta = takePendingBuffer();
  if (finalPendingDelta) {
    await appendTerminalReplayData(term, finalPendingDelta, replayOptions);
    replayedPendingChars += finalPendingDelta.length;
  }

  const shouldReattach = sessionConnected && (getSessionConnected?.() ?? true);
  if (shouldReattach) {
    reattachSession(term);
    updateStatus("connected");
  }

  runtime.ensureWebglRenderer();
  runtime.clearTextureAtlas();

  safeFit({ force: true });
  resizeSession();
  forceSyncRenderAfterResize(term);
  if (initialPayload.alternateScreen) {
    nudgeAlternateScreenRedraw(term);
  } else {
    term.scrollToBottom();
  }

  window.setTimeout(() => safeFit({ force: true }), 0);
  window.setTimeout(() => {
    safeFit({ force: true });
    forceSyncRenderAfterResize(term);
    if (initialPayload.alternateScreen) {
      nudgeAlternateScreenRedraw(term);
    }
  }, 100);
  window.setTimeout(() => {
    safeFit({ force: true });
    forceSyncRenderAfterResize(term);
    if (initialPayload.alternateScreen) {
      nudgeAlternateScreenRedraw(term);
    }
  }, 350);

  logger.info("[Terminal] Resumed from hibernate", {
    sessionId,
    snapshotChars: initialPayload.snapshot.length,
    viewportChars: initialPayload.viewportSnapshot?.length ?? initialPayload.snapshot.length,
    scrollbackChars: initialPayload.scrollbackSnapshot?.length ?? 0,
    pendingChars: replayedPendingChars,
    alternateScreen: initialPayload.alternateScreen,
  });
  return true;
}
