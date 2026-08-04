/**
 * Bridges between the legacy single-file CloudAdapter interface and the
 * shared EncryptedObjectStorage surface used by plugin sync Providers.
 */

import type {
  EncryptedObjectAccount,
  EncryptedObjectDeleteResult,
  EncryptedObjectReadResult,
  EncryptedObjectStorage,
  EncryptedObjectStorageCapabilities,
  EncryptedObjectWriteResult,
} from '../../../domain/encryptedObjectStorage';
import {
  DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY,
} from '../../../domain/encryptedObjectStorage';
import type {
  CloudProvider,
  OAuthTokens,
  ProviderAccount,
  SyncedFile,
} from '../../../domain/sync';
import type { CloudAdapter } from './index';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function syncedFileToBytes(syncedFile: SyncedFile): Uint8Array {
  return textEncoder.encode(JSON.stringify(syncedFile));
}

function bytesToSyncedFile(bytes: Uint8Array): SyncedFile {
  const raw = textDecoder.decode(bytes);
  try {
    return JSON.parse(raw) as SyncedFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /Unexpected non-whitespace character after JSON at position (\d+)/i.exec(message);
    if (match) {
      const pos = Number(match[1]);
      if (Number.isFinite(pos) && pos > 0 && pos <= raw.length) {
        return JSON.parse(raw.slice(0, pos)) as SyncedFile;
      }
    }
    throw error;
  }
}

/**
 * Adapt a legacy CloudAdapter into EncryptedObjectStorage.
 * Uses a single default object key matching the historical vault file name.
 */
export function cloudAdapterAsEncryptedObjectStorage(
  adapter: CloudAdapter,
  providerId: string,
  options: {
    objectKey?: string;
    capabilities?: EncryptedObjectStorageCapabilities;
  } = {},
): EncryptedObjectStorage {
  const objectKey = options.objectKey ?? DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY;
  const capabilities: EncryptedObjectStorageCapabilities = options.capabilities ?? {
    revisions: false,
    conditionalWrites: false,
    atomicReplacement: true,
  };

  return {
    providerId,
    async connect(): Promise<{ account: EncryptedObjectAccount }> {
      if (!adapter.isAuthenticated) {
        throw new Error(`Cloud provider ${providerId} is not authenticated`);
      }
      await adapter.initializeSync();
      const account = adapter.accountInfo;
      if (!account) {
        return { account: { id: providerId } };
      }
      return { account: { ...account } };
    },
    async disconnect(): Promise<void> {
      adapter.signOut();
    },
    async getAccount(): Promise<EncryptedObjectAccount | null> {
      return adapter.accountInfo ? { ...adapter.accountInfo } : null;
    },
    async getCapabilities(): Promise<EncryptedObjectStorageCapabilities> {
      return { ...capabilities };
    },
    async readObject(key: string): Promise<EncryptedObjectReadResult> {
      if (key !== objectKey) {
        return { found: false, key, bytes: null };
      }
      const file = await adapter.download();
      if (!file) return { found: false, key, bytes: null };
      const bytes = syncedFileToBytes(file);
      return {
        found: true,
        key,
        bytes,
        revision: file.meta?.version != null ? String(file.meta.version) : undefined,
        contentType: 'application/json',
      };
    },
    async writeObject(key: string, bytes: Uint8Array): Promise<EncryptedObjectWriteResult> {
      if (key !== objectKey) {
        throw new Error(`Cloud adapter ${providerId} only supports object key ${objectKey}`);
      }
      const syncedFile = bytesToSyncedFile(bytes);
      const created = !(await adapter.download());
      await adapter.upload(syncedFile);
      return {
        created,
        revision: syncedFile.meta?.version != null ? String(syncedFile.meta.version) : undefined,
      };
    },
    async deleteObject(key: string): Promise<EncryptedObjectDeleteResult> {
      if (key !== objectKey) {
        return { deleted: false };
      }
      const existing = await adapter.download();
      if (!existing) return { deleted: false };
      await adapter.deleteSync();
      return { deleted: true };
    },
  };
}

/**
 * Adapt EncryptedObjectStorage into the legacy CloudAdapter surface so the
 * existing encrypt→upload / download→decrypt manager path can drive WebDAV and
 * plugin providers through one code path.
 *
 * Authentication and resourceId must match pre-bridge CloudAdapter semantics:
 * config-backed providers (WebDAV) report authenticated as soon as credentials
 * exist so getConnectedAdapter can reuse the cached instance; resourceId must
 * preserve the persisted path (or the backing adapter's authoritative id) rather
 * than always forcing the default object key.
 */
export function encryptedObjectStorageAsCloudAdapter(
  storage: EncryptedObjectStorage,
  options: {
    objectKey?: string;
    account?: ProviderAccount | null;
    /** When true, getConnectedAdapter reuses this instance without recreating. */
    initiallyAuthenticated?: boolean;
    /** Seeded resource id (e.g. path restored from provider connection storage). */
    resourceId?: string | null;
    /**
     * Prefer the backing adapter's resource id after connect/upload (WebDAV sets
     * `/netcatty-vault.json` via initializeSync; plugins may use object keys).
     */
    resolveResourceId?: () => string | null | undefined;
  } = {},
): CloudAdapter {
  const objectKey = options.objectKey ?? DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY;
  let account: ProviderAccount | null = options.account ?? null;
  let resourceId: string | null = options.resourceId ?? null;
  let authenticated = options.initiallyAuthenticated === true;
  /** Distinct from credential presence: plugin providers need an explicit connect. */
  let sessionConnected = false;
  /**
   * Last observed remote revision for conditional writes.
   * - string: known revision
   * - null: confirmed absent (must-not-exist write)
   * - undefined: unknown / unconditional
   */
  let lastRevision: string | null | undefined;

  const refreshResourceId = (fallback?: string | null): string | null => {
    const resolved = options.resolveResourceId?.();
    if (typeof resolved === 'string' && resolved.length > 0) {
      resourceId = resolved;
      return resourceId;
    }
    if (typeof fallback === 'string' && fallback.length > 0) {
      resourceId = fallback;
      return resourceId;
    }
    return resourceId;
  };

  const ensureConnected = async (): Promise<void> => {
    if (sessionConnected) return;
    const result = await storage.connect();
    account = result.account;
    authenticated = true;
    sessionConnected = true;
    refreshResourceId(objectKey);
  };

  return {
    get isAuthenticated() {
      return authenticated;
    },
    get accountInfo() {
      return account;
    },
    get resourceId() {
      return resourceId;
    },
    signOut() {
      authenticated = false;
      sessionConnected = false;
      lastRevision = undefined;
      account = null;
      resourceId = null;
      void storage.disconnect();
    },
    async initializeSync(): Promise<string | null> {
      await ensureConnected();
      return refreshResourceId(objectKey);
    },
    async upload(syncedFile: SyncedFile): Promise<string> {
      await ensureConnected();
      const bytes = syncedFileToBytes(syncedFile);
      const writeResult = await storage.writeObject(objectKey, bytes, {
        ...(lastRevision !== undefined ? { expectedRevision: lastRevision } : {}),
      });
      if (typeof writeResult.revision === 'string' && writeResult.revision.length > 0) {
        lastRevision = writeResult.revision;
      } else {
        lastRevision = undefined;
      }
      authenticated = true;
      return refreshResourceId(objectKey) ?? objectKey;
    },
    async download(): Promise<SyncedFile | null> {
      await ensureConnected();
      const result = await storage.readObject(objectKey);
      if (!result.found || !result.bytes) {
        // Confirmed absence: next conditional write must use expectedRevision null.
        lastRevision = null;
        return null;
      }
      if (typeof result.revision === 'string' && result.revision.length > 0) {
        lastRevision = result.revision;
      } else {
        lastRevision = undefined;
      }
      return bytesToSyncedFile(result.bytes);
    },
    async deleteSync(): Promise<void> {
      await ensureConnected();
      await storage.deleteObject(objectKey, {
        ...(typeof lastRevision === 'string' ? { expectedRevision: lastRevision } : {}),
      });
      lastRevision = null;
    },
    getTokens(): OAuthTokens | null {
      return null;
    },
  };
}

/**
 * WebDAV-specific capabilities: atomic replacement via temp+MOVE, no native revisions.
 */
export function webdavEncryptedObjectCapabilities(): EncryptedObjectStorageCapabilities {
  return {
    revisions: false,
    conditionalWrites: false,
    atomicReplacement: true,
  };
}

export function isWebdavProvider(provider: CloudProvider): boolean {
  return provider === 'webdav';
}
