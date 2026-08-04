/**
 * Renderer bridge for plugin encrypted-sync sidecars.
 * Collects/applies sidecars through the main-process non-cascade store when
 * the plugin host is available. When the host is offline, last-known sidecars
 * are retained so cloud uploads cannot wipe previously synced plugin data.
 */

import type { PluginSyncSidecarBundle } from '../domain/pluginSyncSidecar';
import { localStorageAdapter } from '../infrastructure/persistence/localStorageAdapter';

/** Ordinary upload fallback when collect cannot reach the host. */
const LAST_KNOWN_SIDECARS_KEY = 'netcatty_plugin_sidecars_last_known_v1';
/**
 * Remote apply that could not reach the host DB. Distinct from last-known so
 * a later collect does not re-apply a stale post-collect snapshot over newer
 * local plugin settings.
 */
const PENDING_REMOTE_SIDECARS_KEY = 'netcatty_plugin_sidecars_pending_remote_v1';
const HOST_UNAVAILABLE_MARKER = 'PLUGIN_SIDECAR_HOST_UNAVAILABLE';

export class PluginSidecarHostUnavailableError extends Error {
  readonly code = HOST_UNAVAILABLE_MARKER;

  constructor(message = 'Plugin sidecar host is unavailable') {
    super(message);
    this.name = 'PluginSidecarHostUnavailableError';
  }
}

export function isPluginSidecarHostUnavailableError(error: unknown): boolean {
  if (error instanceof PluginSidecarHostUnavailableError) return true;
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { code?: unknown; message?: unknown };
  if (maybe.code === HOST_UNAVAILABLE_MARKER) return true;
  return typeof maybe.message === 'string'
    && maybe.message.includes('Plugin sidecar host is unavailable');
}

type ElectronSidecarApi = {
  collectPluginSyncSidecars?: () => Promise<PluginSyncSidecarBundle | null | undefined>;
  applyPluginSyncSidecars?: (
    bundle: PluginSyncSidecarBundle | null | undefined,
  ) => Promise<unknown>;
};

function getSidecarApi(): ElectronSidecarApi | null {
  if (typeof window === 'undefined') return null;
  const electron = (window as Window & { electron?: ElectronSidecarApi }).electron;
  return electron ?? null;
}

function readBundle(key: string): PluginSyncSidecarBundle | null {
  const raw = localStorageAdapter.read<PluginSyncSidecarBundle>(key);
  if (!raw || !Array.isArray(raw.entries)) return null;
  return { version: 1, entries: raw.entries };
}

function writeBundle(key: string, bundle: PluginSyncSidecarBundle | null | undefined): void {
  if (!bundle || !Array.isArray(bundle.entries)) {
    localStorageAdapter.remove(key);
    return;
  }
  localStorageAdapter.write(key, {
    version: 1,
    entries: bundle.entries,
  });
}

function readLastKnownSidecars(): PluginSyncSidecarBundle | null {
  return readBundle(LAST_KNOWN_SIDECARS_KEY);
}

function writeLastKnownSidecars(bundle: PluginSyncSidecarBundle | null | undefined): void {
  writeBundle(LAST_KNOWN_SIDECARS_KEY, bundle);
}

/** null means no pending remote apply. Empty entries is a valid pending reset. */
function readPendingRemoteSidecars(): PluginSyncSidecarBundle | null {
  const raw = localStorageAdapter.read<PluginSyncSidecarBundle | null>(PENDING_REMOTE_SIDECARS_KEY);
  if (raw == null) return null;
  if (!Array.isArray(raw.entries)) return null;
  return { version: 1, entries: raw.entries };
}

function writePendingRemoteSidecars(bundle: PluginSyncSidecarBundle): void {
  localStorageAdapter.write(PENDING_REMOTE_SIDECARS_KEY, {
    version: 1,
    entries: bundle.entries,
  });
}

function clearPendingRemoteSidecars(): void {
  localStorageAdapter.remove(PENDING_REMOTE_SIDECARS_KEY);
}

function isAuthoritativeBundle(
  value: unknown,
): value is PluginSyncSidecarBundle {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as PluginSyncSidecarBundle).entries),
  );
}

function isSuccessfulApplyResult(result: unknown): boolean {
  if (result == null) return false;
  if (
    typeof result === 'object'
    && result !== null
    && 'applied' in result
    && (result as { applied?: unknown }).applied === false
  ) {
    return false;
  }
  return true;
}

/**
 * Returns:
 * - a real bundle (possibly empty entries) when the host collected successfully
 * - last-known bundle when the host is unavailable (protect remote from wipe)
 * Throws on operational host failure (DB/runtime error) so sync aborts.
 *
 * Pending remote applies (host was offline during download) are replayed into
 * the DB before collection. Ordinary last-known collect snapshots are never
 * re-applied, so local settings edits made after the last collect are kept.
 */
export async function collectPluginSyncSidecarsFromHost(): Promise<PluginSyncSidecarBundle | null> {
  const api = getSidecarApi();
  if (typeof api?.collectPluginSyncSidecars !== 'function') {
    return readLastKnownSidecars();
  }

  const pendingRemote = readPendingRemoteSidecars();
  if (pendingRemote && typeof api.applyPluginSyncSidecars === 'function') {
    try {
      const replayResult = await api.applyPluginSyncSidecars(pendingRemote);
      if (isSuccessfulApplyResult(replayResult)) {
        clearPendingRemoteSidecars();
      }
    } catch {
      // Leave pending for a later collect; still attempt live collect below.
    }
  }

  const bundle = await api.collectPluginSyncSidecars();
  // Passive/null means the plugin host is gated off or manager resolution failed.
  // Do not treat that as an authoritative empty bundle (would wipe last-known).
  if (bundle == null || !isAuthoritativeBundle(bundle)) {
    return readLastKnownSidecars();
  }
  const normalized: PluginSyncSidecarBundle = {
    version: 1,
    entries: bundle.entries,
  };
  writeLastKnownSidecars(normalized);
  return normalized;
}

export async function applyPluginSyncSidecarsFromHost(
  bundle: PluginSyncSidecarBundle | null | undefined,
): Promise<void> {
  // Empty bundle is authoritative (cloud deleted all sidecars) — still apply.
  const normalized: PluginSyncSidecarBundle = {
    version: 1,
    entries: Array.isArray(bundle?.entries) ? bundle.entries : [],
  };
  const api = getSidecarApi();
  if (typeof api?.applyPluginSyncSidecars !== 'function') {
    // Host offline: queue remote apply for later DB replay, and keep last-known
    // for upload protection so cloud is not wiped with empty collect.
    writePendingRemoteSidecars(normalized);
    writeLastKnownSidecars(normalized);
    throw new PluginSidecarHostUnavailableError(
      'Plugin sidecar host is unavailable; cannot apply downloaded sidecars',
    );
  }
  const result = await api.applyPluginSyncSidecars(normalized);
  // Passive IPC returns null when the manager is unavailable, or
  // { applied: false } when the sidecar service was not wired.
  if (!isSuccessfulApplyResult(result)) {
    writePendingRemoteSidecars(normalized);
    writeLastKnownSidecars(normalized);
    throw new PluginSidecarHostUnavailableError(
      'Plugin sidecar host is unavailable; cannot apply downloaded sidecars',
    );
  }
  clearPendingRemoteSidecars();
  writeLastKnownSidecars(normalized.entries.length > 0 ? normalized : null);
}
