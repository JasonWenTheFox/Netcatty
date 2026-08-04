/**
 * Renderer bridge for plugin encrypted-sync sidecars.
 * Collects/applies sidecars through the main-process non-cascade store when
 * the plugin host is available. When the host is offline, last-known sidecars
 * are retained so cloud uploads cannot wipe previously synced plugin data.
 */

import type { PluginSyncSidecarBundle } from '../domain/pluginSyncSidecar';
import { localStorageAdapter } from '../infrastructure/persistence/localStorageAdapter';

const LAST_KNOWN_SIDECARS_KEY = 'netcatty_plugin_sidecars_last_known_v1';
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

function readLastKnownSidecars(): PluginSyncSidecarBundle | null {
  const raw = localStorageAdapter.read<PluginSyncSidecarBundle>(LAST_KNOWN_SIDECARS_KEY);
  if (!raw || !Array.isArray(raw.entries)) return null;
  return { version: 1, entries: raw.entries };
}

function writeLastKnownSidecars(bundle: PluginSyncSidecarBundle | null | undefined): void {
  if (!bundle || !Array.isArray(bundle.entries)) {
    localStorageAdapter.remove(LAST_KNOWN_SIDECARS_KEY);
    return;
  }
  localStorageAdapter.write(LAST_KNOWN_SIDECARS_KEY, {
    version: 1,
    entries: bundle.entries,
  });
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

/**
 * Returns:
 * - a real bundle (possibly empty entries) when the host collected successfully
 * - last-known bundle when the host is unavailable (protect remote from wipe)
 * Throws on operational host failure (DB/runtime error) so sync aborts.
 */
export async function collectPluginSyncSidecarsFromHost(): Promise<PluginSyncSidecarBundle | null> {
  const api = getSidecarApi();
  if (typeof api?.collectPluginSyncSidecars !== 'function') {
    return readLastKnownSidecars();
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
    // Host offline: cache for later upload protection, but surface failure so
    // callers know the DB was not updated.
    writeLastKnownSidecars(normalized);
    throw new PluginSidecarHostUnavailableError(
      'Plugin sidecar host is unavailable; cannot apply downloaded sidecars',
    );
  }
  const result = await api.applyPluginSyncSidecars(normalized);
  // Passive IPC returns null when the manager is unavailable, or
  // { applied: false } when the sidecar service was not wired.
  if (
    result == null
    || (typeof result === 'object'
      && result !== null
      && 'applied' in result
      && (result as { applied?: unknown }).applied === false)
  ) {
    writeLastKnownSidecars(normalized);
    throw new PluginSidecarHostUnavailableError(
      'Plugin sidecar host is unavailable; cannot apply downloaded sidecars',
    );
  }
  writeLastKnownSidecars(normalized.entries.length > 0 ? normalized : null);
}
