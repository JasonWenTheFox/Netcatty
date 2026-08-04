import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectPluginSyncSidecars,
  excludeSecretPluginSettingsFromSidecars,
  isCloudSyncablePluginSetting,
  mergePluginSyncSidecars,
  parseSettingsSidecarKey,
  type PluginSettingFieldDescriptor,
  type PluginSyncSidecarEntry,
} from './pluginSyncSidecar';

const pluginId = 'com.example.sidecar';

const declared = new Map<string, PluginSettingFieldDescriptor[]>([
  [pluginId, [
    { id: `${pluginId}.theme`, sync: true, secret: false },
    { id: `${pluginId}.token`, sync: true, secret: true },
    { id: `${pluginId}.localOnly`, sync: false, secret: false },
  ]],
]);

describe('pluginSyncSidecar', () => {
  it('rejects secret fields from cloud sync even when sync is true', () => {
    assert.equal(isCloudSyncablePluginSetting({ sync: true, secret: true }), false);
    assert.equal(isCloudSyncablePluginSetting({ sync: true, secret: false }), true);
    assert.equal(isCloudSyncablePluginSetting({ sync: false, secret: false }), false);
  });

  it('collects only non-secret sync:true settings into the sidecar bundle', () => {
    const bundle = collectPluginSyncSidecars({
      declaredSettingsByPlugin: declared,
      storedSettings: [
        {
          pluginId,
          settingId: `${pluginId}.theme`,
          scope: 'application',
          scopeId: 'application',
          value: 'dark',
          updatedAt: 10,
        },
        {
          pluginId,
          settingId: `${pluginId}.token`,
          scope: 'application',
          scopeId: 'application',
          value: 'should-not-sync',
          updatedAt: 10,
        },
        {
          pluginId,
          settingId: `${pluginId}.localOnly`,
          scope: 'application',
          scopeId: 'application',
          value: true,
          updatedAt: 10,
        },
      ],
      now: 20,
    });

    assert.equal(bundle.version, 1);
    assert.equal(bundle.entries.length, 1);
    assert.equal(bundle.entries[0].kind, 'settings');
    assert.equal(bundle.entries[0].value, 'dark');
    assert.deepEqual(parseSettingsSidecarKey(bundle.entries[0].key), {
      settingId: `${pluginId}.theme`,
      scope: 'application',
      scopeId: 'application',
    });
  });

  it('preserves account and CRDT baselines when the plugin is missing', () => {
    const existing: PluginSyncSidecarEntry[] = [
      {
        pluginId: 'com.missing.plugin',
        kind: 'account_baseline',
        key: 'account',
        value: { accountId: 'acct-1' },
        updatedAt: 5,
      },
      {
        pluginId: 'com.missing.plugin',
        kind: 'crdt_baseline',
        key: 'replica',
        value: { clock: 3 },
        updatedAt: 5,
      },
      {
        pluginId: 'com.missing.plugin',
        kind: 'settings',
        key: 'com.missing.plugin.theme\0application\0application',
        value: 'light',
        updatedAt: 5,
      },
    ];

    const bundle = collectPluginSyncSidecars({
      declaredSettingsByPlugin: new Map(), // plugin not installed
      storedSettings: [],
      existingSidecars: existing,
      now: 100,
    });

    assert.equal(bundle.entries.length, 3);
    assert.ok(bundle.entries.some((entry) => entry.kind === 'account_baseline'));
    assert.ok(bundle.entries.some((entry) => entry.kind === 'crdt_baseline'));
    assert.ok(bundle.entries.some((entry) => entry.kind === 'settings' && entry.value === 'light'));
  });

  it('merges remote sidecars without dropping local baselines for missing remote plugins', () => {
    const local: PluginSyncSidecarEntry[] = [
      {
        pluginId: 'com.local.only',
        kind: 'account_baseline',
        key: 'account',
        value: { id: 'local' },
        updatedAt: 1,
      },
    ];
    const remote = {
      version: 1 as const,
      entries: [
        {
          pluginId,
          kind: 'settings' as const,
          key: `${pluginId}.theme\0application\0application`,
          value: 'dark',
          updatedAt: 2,
        },
      ],
    };

    const merged = mergePluginSyncSidecars({ local, remote, declaredSettingsByPlugin: declared });
    assert.equal(merged.length, 2);
    assert.ok(merged.some((entry) => entry.pluginId === 'com.local.only'));
    assert.ok(merged.some((entry) => entry.value === 'dark'));
  });

  it('excludes secret settings when stripping sidecars with known declarations', () => {
    const entries: PluginSyncSidecarEntry[] = [
      {
        pluginId,
        kind: 'settings',
        key: `${pluginId}.token\0application\0application`,
        value: 'secret',
        updatedAt: 1,
      },
      {
        pluginId,
        kind: 'settings',
        key: `${pluginId}.theme\0application\0application`,
        value: 'dark',
        updatedAt: 1,
      },
    ];
    const filtered = excludeSecretPluginSettingsFromSidecars(entries, declared);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].value, 'dark');
  });
});
