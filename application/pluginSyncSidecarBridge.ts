/**
 * Renderer bridge for plugin encrypted-sync sidecars.
 * Collects/applies sidecars through the main-process non-cascade store when
 * the plugin host is available; no-ops safely when the development gate is off.
 */

import type { PluginSyncSidecarBundle } from '../domain/pluginSyncSidecar';

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

export async function collectPluginSyncSidecarsFromHost(): Promise<
  PluginSyncSidecarBundle | null | undefined
> {
  const api = getSidecarApi();
  if (typeof api?.collectPluginSyncSidecars !== 'function') return undefined;
  try {
    return await api.collectPluginSyncSidecars();
  } catch {
    // Plugin host disabled / unavailable — cloud sync continues without sidecars.
    return undefined;
  }
}

export async function applyPluginSyncSidecarsFromHost(
  bundle: PluginSyncSidecarBundle | null | undefined,
): Promise<void> {
  if (!bundle || !Array.isArray(bundle.entries) || bundle.entries.length === 0) return;
  const api = getSidecarApi();
  if (typeof api?.applyPluginSyncSidecars !== 'function') return;
  try {
    await api.applyPluginSyncSidecars(bundle);
  } catch {
    // Missing plugin host must not block vault apply; sidecars remain in the
    // encrypted payload for a later device that has the host enabled.
  }
}
