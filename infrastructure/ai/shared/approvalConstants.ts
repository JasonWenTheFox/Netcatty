/** Renderer-side Catty tool approval idle timeout (5 minutes). */
export const CATTY_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hard-deadline grace beyond the idle timeout after the user starts reviewing.
 * Matches the confirm-mode headroom already reserved in Catty stream `toolMs`
 * so active review is not clipped at the idle boundary while still bounded.
 */
export const CATTY_APPROVAL_ABSOLUTE_GRACE_MS = 90 * 1000;

/**
 * MCP / external SDK approval timeout aligned with Codex MCP limits (~110s).
 * Kept separate from Catty because external agents block on main-process IPC.
 */
export const MCP_APPROVAL_TIMEOUT_MS = 110 * 1000;
