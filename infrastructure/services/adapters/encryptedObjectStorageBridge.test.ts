import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SyncedFile } from '../../../domain/sync';
import type { CloudAdapter } from './index';
import {
  cloudAdapterAsEncryptedObjectStorage,
  encryptedObjectStorageAsCloudAdapter,
  webdavEncryptedObjectCapabilities,
} from './encryptedObjectStorageBridge';
import { DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY } from '../../../domain/encryptedObjectStorage';
import { createPluginSyncObjectStorage } from './pluginSyncObjectStorage';

function makeSyncedFile(version: number, payload = 'cipher'): SyncedFile {
  return {
    meta: {
      version,
      updatedAt: 1,
      deviceId: 'device',
      appVersion: '0.0.0',
      iv: 'iv',
      salt: 'salt',
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2',
    },
    payload,
  };
}

function memoryCloudAdapter(initial: SyncedFile | null = null): CloudAdapter & { store: SyncedFile | null } {
  const adapter = {
    store: initial,
    isAuthenticated: true,
    accountInfo: { id: 'webdav-host', name: 'user@host' },
    resourceId: null as string | null,
    signOut() {
      adapter.isAuthenticated = false;
      adapter.accountInfo = null;
      adapter.store = null;
    },
    async initializeSync() {
      adapter.resourceId = DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY;
      return adapter.resourceId;
    },
    async upload(file: SyncedFile) {
      adapter.store = file;
      adapter.resourceId = DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY;
      return adapter.resourceId;
    },
    async download() {
      return adapter.store;
    },
    async deleteSync() {
      adapter.store = null;
    },
    getTokens() {
      return null;
    },
  };
  return adapter;
}

describe('encryptedObjectStorageBridge', () => {
  it('adapts WebDAV-style CloudAdapter through the encrypted-object interface', async () => {
    const adapter = memoryCloudAdapter(makeSyncedFile(3, 'remote-cipher'));
    const storage = cloudAdapterAsEncryptedObjectStorage(adapter, 'webdav', {
      capabilities: webdavEncryptedObjectCapabilities(),
    });

    const caps = await storage.getCapabilities();
    assert.equal(caps.atomicReplacement, true);
    assert.equal(caps.revisions, false);

    const connected = await storage.connect();
    assert.equal(connected.account.id, 'webdav-host');

    const read = await storage.readObject(DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY);
    assert.equal(read.found, true);
    assert.ok(read.bytes);
    assert.equal(read.revision, '3');

    const next = makeSyncedFile(4, 'next-cipher');
    const encoded = new TextEncoder().encode(JSON.stringify(next));
    const written = await storage.writeObject(DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY, encoded);
    assert.equal(written.created, false);
    assert.equal(written.revision, '4');

    const reloaded = await adapter.download();
    assert.equal(reloaded?.payload, 'next-cipher');

    const deleted = await storage.deleteObject(DEFAULT_ENCRYPTED_SYNC_OBJECT_KEY);
    assert.equal(deleted.deleted, true);
    assert.equal(await adapter.download(), null);
  });

  it('adapts EncryptedObjectStorage back to CloudAdapter for manager upload/download', async () => {
    const memory = new Map<string, Uint8Array>();
    let backingResourceId: string | null = '/persisted/path.json';
    const storage = {
      providerId: 'com.example.sync',
      async connect() {
        backingResourceId = '/after-connect/path.json';
        return { account: { id: 'plugin-acct' } };
      },
      async disconnect() {},
      async getAccount() {
        return { id: 'plugin-acct' };
      },
      async getCapabilities() {
        return {
          revisions: true,
          conditionalWrites: true,
          atomicReplacement: true,
          maxObjectBytes: 1024,
        };
      },
      async readObject(key: string) {
        const bytes = memory.get(key) ?? null;
        return bytes
          ? { found: true as const, key, bytes, revision: 'r1' }
          : { found: false as const, key, bytes: null };
      },
      async writeObject(key: string, bytes: Uint8Array) {
        const created = !memory.has(key);
        memory.set(key, bytes);
        return { created, revision: 'r2' };
      },
      async deleteObject(key: string) {
        const deleted = memory.delete(key);
        return { deleted };
      },
    };

    const adapter = encryptedObjectStorageAsCloudAdapter(storage, {
      initiallyAuthenticated: true,
      resourceId: '/persisted/path.json',
      resolveResourceId: () => backingResourceId,
    });
    assert.equal(adapter.isAuthenticated, true);
    assert.equal(adapter.resourceId, '/persisted/path.json');

    await adapter.initializeSync();
    assert.equal(adapter.accountInfo?.id, 'plugin-acct');
    assert.equal(adapter.resourceId, '/after-connect/path.json');

    const file = makeSyncedFile(9, 'plugin-cipher');
    await adapter.upload(file);
    const downloaded = await adapter.download();
    assert.equal(downloaded?.payload, 'plugin-cipher');
    assert.equal(downloaded?.meta.version, 9);
  });

  it('lazy-connects before first I/O and passes revisions for conditional writes', async () => {
    const ops: string[] = [];
    let revision: string | undefined = 'rev-1';
    const storage = {
      providerId: 'com.example.sync',
      async connect() {
        ops.push('connect');
        return { account: { id: 'a1' } };
      },
      async disconnect() {
        ops.push('disconnect');
      },
      async getAccount() {
        return { id: 'a1' };
      },
      async getCapabilities() {
        return { revisions: true, conditionalWrites: true, atomicReplacement: true };
      },
      async readObject(key: string) {
        ops.push(`read:${key}:${revision ?? ''}`);
        return {
          found: true as const,
          key,
          bytes: new TextEncoder().encode(JSON.stringify(makeSyncedFile(1, 'c'))),
          revision,
        };
      },
      async writeObject(key: string, _bytes: Uint8Array, options?: { expectedRevision?: string | null }) {
        ops.push(`write:${key}:${options?.expectedRevision ?? ''}`);
        revision = 'rev-2';
        return { created: false, revision };
      },
      async deleteObject() {
        return { deleted: true };
      },
    };

    const adapter = encryptedObjectStorageAsCloudAdapter(storage, {
      initiallyAuthenticated: true,
    });
    // Restored session: authenticated for cache reuse, but not yet connected.
    assert.equal(adapter.isAuthenticated, true);
    const downloaded = await adapter.download();
    assert.equal(downloaded?.payload, 'c');
    assert.deepEqual(ops[0], 'connect');
    assert.ok(ops.some((op) => op.startsWith('read:')));

    await adapter.upload(makeSyncedFile(2, 'next'));
    assert.ok(
      ops.some((op) => op === 'write:netcatty-vault.json:rev-1'),
      `expected conditional write with rev-1, got ${JSON.stringify(ops)}`,
    );

    // Confirmed absence → must-not-exist (expectedRevision null)
    revision = undefined;
    const storageAbsent = {
      ...storage,
      async readObject(key: string) {
        ops.push(`read-absent:${key}`);
        return { found: false as const, key, bytes: null };
      },
      async writeObject(key: string, _bytes: Uint8Array, options?: { expectedRevision?: string | null }) {
        ops.push(`write-absent:${key}:${options?.expectedRevision === null ? 'null' : String(options?.expectedRevision)}`);
        return { created: true, revision: 'rev-new' };
      },
    };
    const adapter2 = encryptedObjectStorageAsCloudAdapter(storageAbsent, {
      initiallyAuthenticated: true,
    });
    assert.equal(await adapter2.download(), null);
    await adapter2.upload(makeSyncedFile(3, 'fresh'));
    assert.ok(
      ops.some((op) => op === 'write-absent:netcatty-vault.json:null'),
      `expected must-not-exist write, got ${JSON.stringify(ops)}`,
    );
  });

  it('plugin sync object storage only forwards encrypted bytes to the host', async () => {
    const calls: string[] = [];
    const host = {
      async connectSync(params: { providerId: string; configuration?: unknown }) {
        calls.push(`connect:${params.providerId}`);
        assert.deepEqual(params.configuration, { endpoint: 'https://example.test' });
        return { account: { id: 'a1', name: 'Plugin' } };
      },
      async disconnectSync() {
        calls.push('disconnect');
        return null;
      },
      async getSyncAccount() {
        return { account: { id: 'a1' } };
      },
      async getSyncCapabilities() {
        return {
          revisions: true,
          conditionalWrites: true,
          atomicReplacement: false,
          maxObjectBytes: 64,
        };
      },
      async readSyncObject(params: { key: string }) {
        calls.push(`read:${params.key}`);
        return {
          found: true,
          key: params.key,
          bytes: new Uint8Array([1, 2, 3]),
          revision: 'rev-1',
        };
      },
      async writeSyncObject(params: { key: string; bytes: Uint8Array; expectedRevision?: string | null }) {
        calls.push(`write:${params.key}:${params.bytes.byteLength}:${params.expectedRevision ?? ''}`);
        // Ensure bytes look like opaque ciphertext, not a vault JSON root.
        assert.equal(params.bytes[0], 0x9b);
        return { created: true, revision: 'rev-2' };
      },
      async deleteSyncObject(params: { key: string }) {
        calls.push(`delete:${params.key}`);
        return { deleted: true };
      },
    };

    const storage = createPluginSyncObjectStorage({
      providerId: 'com.example.sync',
      host,
      configuration: { endpoint: 'https://example.test' },
    });

    await storage.connect();
    const caps = await storage.getCapabilities();
    assert.equal(caps.conditionalWrites, true);
    const read = await storage.readObject('vault');
    assert.deepEqual([...read.bytes!], [1, 2, 3]);
    await storage.writeObject('vault', new Uint8Array([0x9b, 0x01]), { expectedRevision: null });
    await storage.deleteObject('vault');
    await storage.disconnect();

    assert.deepEqual(calls, [
      'connect:com.example.sync',
      'read:vault',
      'write:vault:2:',
      'delete:vault',
      'disconnect',
    ]);
  });
});
