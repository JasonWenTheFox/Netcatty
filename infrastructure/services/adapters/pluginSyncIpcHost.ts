/**
 * Renderer-side host that drives plugin sync Providers over the preload IPC
 * surface. Main process extensionProviderService owns activation, permission
 * checks, and stream handling; this client only shuttles already-encrypted
 * object bytes.
 */

import type {
  EncryptedObjectAccount,
  EncryptedObjectStorageCapabilities,
} from '../../../domain/encryptedObjectStorage';
import type { PluginSyncProviderHost } from './pluginSyncObjectStorage';

type ElectronPluginSyncApi = {
  pluginSyncConnect?: (params: {
    providerId: string;
    configuration?: unknown;
    credential?: unknown;
    deadlineMs?: number;
  }) => Promise<{ account: EncryptedObjectAccount }>;
  pluginSyncDisconnect?: (params: {
    providerId: string;
    deadlineMs?: number;
  }) => Promise<null>;
  pluginSyncGetAccount?: (params: {
    providerId: string;
    deadlineMs?: number;
  }) => Promise<{ account: EncryptedObjectAccount | null }>;
  pluginSyncGetCapabilities?: (params: {
    providerId: string;
    deadlineMs?: number;
  }) => Promise<EncryptedObjectStorageCapabilities>;
  pluginSyncReadObject?: (params: {
    providerId: string;
    key: string;
    preferStream?: boolean;
    deadlineMs?: number;
  }) => Promise<{
    found: boolean;
    key: string;
    dataBase64: string | null;
    revision?: string;
    contentType?: string;
  }>;
  pluginSyncWriteObject?: (params: {
    providerId: string;
    key: string;
    dataBase64: string;
    expectedRevision?: string | null;
    preferStream?: boolean;
    deadlineMs?: number;
  }) => Promise<{ created: boolean; revision?: string }>;
  pluginSyncDeleteObject?: (params: {
    providerId: string;
    key: string;
    expectedRevision?: string;
    deadlineMs?: number;
  }) => Promise<{ deleted: boolean }>;
};

function getPluginSyncApi(): ElectronPluginSyncApi | null {
  if (typeof window === 'undefined') return null;
  const electron = (window as Window & { electron?: ElectronPluginSyncApi }).electron;
  return electron ?? null;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(data, 'base64'));
  }
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function isPluginSyncIpcAvailable(): boolean {
  const api = getPluginSyncApi();
  if (
    typeof api?.pluginSyncConnect !== 'function'
    || typeof api?.pluginSyncReadObject !== 'function'
    || typeof api?.pluginSyncWriteObject !== 'function'
  ) {
    return false;
  }
  // Preload always exposes the IPC methods; the host is only ready when the
  // main process has a live plugin host (sync sidecar service wired).
  const ready = (api as { pluginHostReady?: () => boolean }).pluginHostReady;
  if (typeof ready === 'function') {
    try {
      return ready() === true;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Create a PluginSyncProviderHost bound to the renderer preload API.
 * Throws when the plugin development gate / host is unavailable.
 */
export function createPluginSyncIpcHost(): PluginSyncProviderHost {
  return {
    async connectSync(params, options) {
      void options;
      const api = getPluginSyncApi();
      if (typeof api?.pluginSyncConnect !== 'function') {
        throw new Error('Plugin sync host is unavailable');
      }
      return api.pluginSyncConnect(params);
    },
    async disconnectSync(params, options) {
      void options;
      const api = getPluginSyncApi();
      if (typeof api?.pluginSyncDisconnect !== 'function') {
        throw new Error('Plugin sync host is unavailable');
      }
      return api.pluginSyncDisconnect(params);
    },
    async getSyncAccount(params, options) {
      void options;
      const api = getPluginSyncApi();
      if (typeof api?.pluginSyncGetAccount !== 'function') {
        throw new Error('Plugin sync host is unavailable');
      }
      return api.pluginSyncGetAccount(params);
    },
    async getSyncCapabilities(params, options) {
      void options;
      const api = getPluginSyncApi();
      if (typeof api?.pluginSyncGetCapabilities !== 'function') {
        throw new Error('Plugin sync host is unavailable');
      }
      return api.pluginSyncGetCapabilities(params);
    },
    async readSyncObject(params, options) {
      void options;
      const api = getPluginSyncApi();
      if (typeof api?.pluginSyncReadObject !== 'function') {
        throw new Error('Plugin sync host is unavailable');
      }
      const result = await api.pluginSyncReadObject(params);
      if (!result.found || result.dataBase64 == null) {
        return { found: false, key: params.key, bytes: null };
      }
      return {
        found: true,
        key: result.key,
        bytes: base64ToBytes(result.dataBase64),
        revision: result.revision,
        contentType: result.contentType,
      };
    },
    async writeSyncObject(params, options) {
      void options;
      const api = getPluginSyncApi();
      if (typeof api?.pluginSyncWriteObject !== 'function') {
        throw new Error('Plugin sync host is unavailable');
      }
      return api.pluginSyncWriteObject({
        providerId: params.providerId,
        key: params.key,
        dataBase64: bytesToBase64(params.bytes),
        expectedRevision: params.expectedRevision,
        preferStream: params.preferStream,
        deadlineMs: params.deadlineMs,
      });
    },
    async deleteSyncObject(params, options) {
      void options;
      const api = getPluginSyncApi();
      if (typeof api?.pluginSyncDeleteObject !== 'function') {
        throw new Error('Plugin sync host is unavailable');
      }
      return api.pluginSyncDeleteObject(params);
    },
  };
}
