"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginDatabase } = require("./database.cjs");
const { PluginSyncSidecarService } = require("./pluginSyncSidecarService.cjs");

function tempDb(context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-sidecar-"));
  context.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return new PluginDatabase(path.join(dir, "plugins.sqlite"));
}

test("sidecar table has no package cascade and survives removePlugin", (context) => {
  const database = tempDb(context);
  database.installVersion({
    pluginId: "com.example.sync",
    version: "1.0.0",
    manifest: { id: "com.example.sync", version: "1.0.0" },
    archiveSha256: "a".repeat(64),
    packageRelativePath: "packages/com.example.sync/1.0.0",
  }, { enable: true });
  database.setSyncSidecar("com.example.sync", "account_baseline", "account", { id: "acct" }, 10);
  database.setSetting("com.example.sync", "com.example.sync.theme", "application", "application", "dark");

  assert.deepEqual(database.db.prepare("PRAGMA foreign_key_list(plugin_sync_sidecars)").all(), []);
  database.removePlugin("com.example.sync");

  assert.deepEqual(database.getSyncSidecar("com.example.sync", "account_baseline", "account"), {
    pluginId: "com.example.sync",
    kind: "account_baseline",
    key: "account",
    value: { id: "acct" },
    updatedAt: 10,
  });
  assert.equal(
    database.getSetting("com.example.sync", "com.example.sync.theme", "application", "application"),
    "dark",
  );
});

test("collectForSync excludes secrets and preserves missing-plugin baselines", (context) => {
  const database = tempDb(context);
  database.setSyncSidecar("com.missing.plugin", "crdt_baseline", "replica", { clock: 2 }, 5);
  database.setSetting("com.example.sync", "com.example.sync.theme", "application", "application", "dark");
  database.setSetting("com.example.sync", "com.example.sync.token", "application", "application", "secret");

  const contributionService = {
    snapshot() {
      return {
        plugins: [{
          id: "com.example.sync",
          settings: [
            { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            { id: "com.example.sync.token", secret: true, sync: true, scope: "application" },
          ],
        }],
      };
    },
  };

  const service = new PluginSyncSidecarService({ database, contributionService });
  const bundle = service.collectForSync();
  assert.equal(bundle.version, 1);
  assert.ok(bundle.entries.some((entry) => entry.kind === "crdt_baseline" && entry.pluginId === "com.missing.plugin"));
  assert.ok(bundle.entries.some((entry) => entry.kind === "settings" && entry.value === "dark"));
  assert.equal(bundle.entries.some((entry) => entry.value === "secret"), false);
});

test("collectForSync omits deleted settings for installed plugins but keeps missing-plugin rows", (context) => {
  const database = tempDb(context);
  // Previously synced setting row still in sidecars, but plugin_settings was reset.
  database.setSyncSidecar(
    "com.example.sync",
    "settings",
    "com.example.sync.theme\0application\0application",
    "stale",
    5,
  );
  database.setSyncSidecar("com.missing.plugin", "settings", "com.missing.plugin.x\0application\0application", "keep", 5);
  // Only store a different setting for the installed plugin.
  database.setSetting("com.example.sync", "com.example.sync.other", "application", "application", "ok");

  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
              { id: "com.example.sync.other", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
    },
  });
  const bundle = service.collectForSync();
  assert.equal(bundle.entries.some((e) => e.value === "stale"), false);
  assert.ok(bundle.entries.some((e) => e.value === "ok"));
  assert.ok(bundle.entries.some((e) => e.pluginId === "com.missing.plugin" && e.value === "keep"));
});

test("applyFromSync preserves remote updatedAt when writing settings", (context) => {
  const database = tempDb(context);
  const service = new PluginSyncSidecarService({
    database,
    contributionService: {
      snapshot() {
        return {
          plugins: [{
            id: "com.example.sync",
            settings: [
              { id: "com.example.sync.theme", secret: false, sync: true, scope: "application" },
            ],
          }],
        };
      },
    },
  });
  service.applyFromSync({
    version: 1,
    entries: [{
      pluginId: "com.example.sync",
      kind: "settings",
      key: "com.example.sync.theme\0application\0application",
      value: "dark",
      updatedAt: 42,
    }],
  });
  const rows = database.listAllSettings();
  const theme = rows.find((r) => r.settingId === "com.example.sync.theme");
  assert.equal(theme?.value, "dark");
  assert.equal(theme?.updatedAt, 42);
});

test("applyFromSync does not drop local baselines for plugins absent remotely", (context) => {
  const database = tempDb(context);
  database.setSyncSidecar("com.local.only", "account_baseline", "account", { id: "local" }, 1);

  const service = new PluginSyncSidecarService({
    database,
    contributionService: { snapshot: () => ({ plugins: [] }) },
  });
  service.applyFromSync({
    version: 1,
    entries: [{
      pluginId: "com.remote.plugin",
      kind: "settings",
      key: "com.remote.plugin.theme\0application\0application",
      value: "light",
      updatedAt: 2,
    }],
  });

  const all = database.listAllSyncSidecars();
  assert.ok(all.some((entry) => entry.pluginId === "com.local.only"));
  assert.ok(all.some((entry) => entry.pluginId === "com.remote.plugin" && entry.value === "light"));
});
