import test from 'node:test';
import assert from 'node:assert/strict';

type LocalStorageMock = {
  clear(): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function installLocalStorage(): LocalStorageMock {
  const store = new Map<string, string>();
  const localStorage: LocalStorageMock = {
    clear() { store.clear(); },
    getItem(key) { return store.has(key) ? store.get(key)! : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorage,
    configurable: true,
  });
  return localStorage;
}

installLocalStorage();

const { SYNC_STORAGE_KEYS } = await import('../domain/sync.ts');
const { localStorageAdapter } = await import('../infrastructure/persistence/localStorageAdapter.ts');
const {
  collectPluginSyncSidecarsFromHost,
  commitPluginSidecarsLastKnown,
} = await import('./pluginSyncSidecarBridge.ts');
const { hasMeaningfulCloudSyncData } = await import('./syncPayload.ts');

test.beforeEach(() => {
  localStorage.clear();
  delete (globalThis as { window?: unknown }).window;
});

test('collect defers empty last-known so empty-vault guard still sees a reset', async () => {
  localStorageAdapter.write(SYNC_STORAGE_KEYS.PLUGIN_SIDECARS_LAST_KNOWN, {
    version: 1,
    entries: [{
      pluginId: 'com.example.p',
      kind: 'settings',
      key: 'k',
      value: 1,
      updatedAt: 1,
    }],
  });
  (globalThis as { window: unknown }).window = {
    netcatty: {
      async collectPluginSyncSidecars() {
        return { version: 1, entries: [] };
      },
    },
  };

  const collected = await collectPluginSyncSidecarsFromHost();
  assert.deepEqual(collected, { version: 1, entries: [] });

  // Last-known must still hold prior entries for the guard.
  const lastKnown = localStorageAdapter.read<{ entries: unknown[] }>(
    SYNC_STORAGE_KEYS.PLUGIN_SIDECARS_LAST_KNOWN,
  );
  assert.equal(lastKnown?.entries?.length, 1);

  assert.equal(
    hasMeaningfulCloudSyncData({
      hosts: [],
      keys: [],
      identities: [],
      snippets: [],
      customGroups: [],
      syncedAt: 1,
      pluginSidecars: { version: 1, entries: [] },
    }),
    true,
  );

  commitPluginSidecarsLastKnown({ version: 1, entries: [] });
  const committed = localStorageAdapter.read<{ entries: unknown[] }>(
    SYNC_STORAGE_KEYS.PLUGIN_SIDECARS_LAST_KNOWN,
  );
  assert.deepEqual(committed?.entries, []);
  assert.equal(
    hasMeaningfulCloudSyncData({
      hosts: [],
      keys: [],
      identities: [],
      snippets: [],
      customGroups: [],
      syncedAt: 1,
      pluginSidecars: { version: 1, entries: [] },
    }),
    false,
  );
});
