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
 */
export function encryptedObjectStorageAsCloudAdapter(
  storage: EncryptedObjectStorage,
  options: {
    objectKey?: string;
    account?: ProviderAccount | null;
  } = {},
): CloudAdapter {
  const objectKey = options.objectKey ?? DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY;
  let account: ProviderAccount | null = options.account ?? null;
  let resourceId: string | null = null;
  let authenticated = false;

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
      account = null;
      resourceId = null;
      void storage.disconnect();
    },
    async initializeSync(): Promise<string | null> {
      const result = await storage.connect();
      account = result.account;
      authenticated = true;
      resourceId = objectKey;
      return resourceId;
    },
    async upload(syncedFile: SyncedFile): Promise<string> {
      const bytes = syncedFileToBytes(syncedFile);
      await storage.writeObject(objectKey, bytes);
      resourceId = objectKey;
      authenticated = true;
      return objectKey;
    },
    async download(): Promise<SyncedFile | null> {
      const result = await storage.readObject(objectKey);
      if (!result.found || !result.bytes) return null;
      return bytesToSyncedFile(result.bytes);
    },
    async deleteSync(): Promise<void> {
      await storage.deleteObject(objectKey);
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
