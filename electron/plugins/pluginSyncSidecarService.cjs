"use strict";

/**
 * Host-side collection and apply path for plugin encrypted sync sidecars.
 * Uses non-cascade tables so uninstall/missing plugins do not destroy data.
 */

const {
  collectPluginSyncSidecars,
  excludeSecretPluginSettingsFromSidecars,
  mergePluginSyncSidecars,
  parseSettingsSidecarKey,
  isCloudSyncablePluginSetting,
} = require("./pluginSyncSidecarHelpers.cjs");

class PluginSyncSidecarService {
  constructor(options) {
    if (!options?.database) {
      throw new TypeError("Plugin sync sidecar service requires a database");
    }
    this.database = options.database;
    this.contributionService = options.contributionService ?? null;
  }

  #declaredSettingsByPlugin() {
    const map = new Map();
    const snapshot = this.contributionService?.snapshot?.();
    const plugins = snapshot?.plugins ?? [];
    for (const plugin of plugins) {
      const fields = (plugin.settings ?? []).map((setting) => ({
        id: setting.id,
        secret: setting.secret === true,
        sync: setting.sync === true,
        scope: setting.scope,
      }));
      map.set(plugin.id, fields);
    }
    return map;
  }

  /**
   * Build the sidecar bundle for inclusion in the encrypted cloud payload.
   */
  collectForSync() {
    const declared = this.#declaredSettingsByPlugin();
    const storedSettings = typeof this.database.listAllSettings === "function"
      ? this.database.listAllSettings()
      : [];
    const existingSidecars = typeof this.database.listAllSyncSidecars === "function"
      ? this.database.listAllSyncSidecars()
      : [];
    // For installed plugins, drop settings sidecar rows that no longer have a
    // stored value (user reset/deleted). Missing plugins keep their rows.
    const storedKeys = new Set(
      storedSettings.map((row) => `${row.pluginId}\0${row.settingId}\0${row.scope}\0${row.scopeId}`),
    );
    const filteredExisting = existingSidecars.filter((entry) => {
      if (entry.kind !== "settings") return true;
      if (!declared.has(entry.pluginId)) return true; // missing plugin — preserve
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) return false;
      return storedKeys.has(`${entry.pluginId}\0${parsed.settingId}\0${parsed.scope}\0${parsed.scopeId}`);
    });
    const bundle = collectPluginSyncSidecars({
      declaredSettingsByPlugin: declared,
      storedSettings,
      existingSidecars: filteredExisting,
    });
    bundle.entries = excludeSecretPluginSettingsFromSidecars(bundle.entries, declared);
    return bundle;
  }

  /**
   * Merge a remote sidecar bundle into local non-cascade storage.
   * Does not delete local rows for plugins absent from the remote bundle.
   */
  applyFromSync(remoteBundle) {
    const declared = this.#declaredSettingsByPlugin();
    const local = typeof this.database.listAllSyncSidecars === "function"
      ? this.database.listAllSyncSidecars()
      : [];
    const merged = mergePluginSyncSidecars({
      local,
      remote: remoteBundle,
      declaredSettingsByPlugin: declared,
    });
    const safe = excludeSecretPluginSettingsFromSidecars(merged, declared);
    if (typeof this.database.replaceAllSyncSidecars === "function") {
      this.database.replaceAllSyncSidecars(safe);
    }
    // Best-effort: write settings sidecar values into plugin_settings when the
    // field is declared and non-secret. Missing plugins keep sidecar-only rows.
    for (const entry of safe) {
      if (entry.kind !== "settings") continue;
      const fields = declared.get(entry.pluginId);
      if (!fields) continue;
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) continue;
      const field = fields.find((item) => item.id === parsed.settingId);
      if (!field || !isCloudSyncablePluginSetting(field)) continue;
      this.database.setSetting(
        entry.pluginId,
        parsed.settingId,
        parsed.scope,
        parsed.scopeId,
        entry.value,
        entry.updatedAt,
      );
    }
    return safe;
  }

  /**
   * Persist an account or CRDT baseline without cascading on uninstall.
   */
  setBaseline(pluginId, kind, key, value) {
    if (kind !== "account_baseline" && kind !== "crdt_baseline") {
      throw new TypeError("Baseline kind must be account_baseline or crdt_baseline");
    }
    this.database.setSyncSidecar(pluginId, kind, key, value);
  }

  getBaseline(pluginId, kind, key) {
    return this.database.getSyncSidecar(pluginId, kind, key);
  }
}

module.exports = {
  PluginSyncSidecarService,
};
