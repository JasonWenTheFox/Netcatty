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
    // Keep retained settings sidecars for installed plugins even when
    // plugin_settings has no row yet (downloaded while plugin was missing).
    // Do not write them into plugin_settings here — that would bypass the
    // contribution service's schema validation. applyFromSync / enable paths
    // rehydrate through updateSetting. User resets clear the sidecar row via
    // contributionService.resetSetting so deliberate deletions stay deleted.
    const filteredExisting = existingSidecars.filter((entry) => {
      if (entry.kind !== "settings") return true;
      if (!declared.has(entry.pluginId)) return true; // missing plugin — preserve
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) return false;
      const fields = declared.get(entry.pluginId) ?? [];
      const field = fields.find((item) => item.id === parsed.settingId);
      // Drop secret / non-sync declarations; unknown fields stay for schema lag.
      if (field && !isCloudSyncablePluginSetting(field)) return false;
      return true;
    });
    const bundle = collectPluginSyncSidecars({
      declaredSettingsByPlugin: declared,
      storedSettings,
      existingSidecars: filteredExisting,
    });
    bundle.entries = excludeSecretPluginSettingsFromSidecars(bundle.entries, declared);
    // Persist collected settings into the non-cascade table so a later uninstall
    // still has rows to re-emit (plugin_settings alone is not enough once the
    // declaration disappears and collection skips undeclared stored values).
    if (typeof this.database.replaceAllSyncSidecars === "function") {
      this.database.replaceAllSyncSidecars(bundle.entries);
    }
    return bundle;
  }

  /**
   * Merge a remote sidecar bundle into local non-cascade storage.
   * Does not delete local rows for plugins absent from the remote bundle.
   * Installed-plugin settings go through the contribution service when available
   * so values are validated and runtime change events fire.
   */
  async applyFromSync(remoteBundle) {
    const declared = this.#declaredSettingsByPlugin();
    const local = typeof this.database.listAllSyncSidecars === "function"
      ? this.database.listAllSyncSidecars()
      : [];
    const remoteEntries = Array.isArray(remoteBundle?.entries) ? remoteBundle.entries : [];
    // Explicit empty remote bundle is an authoritative wipe (including rows for
    // missing plugins). Legacy payloads without pluginSidecars never reach here
    // (apply path only runs when the field is present).
    const remoteIsAuthoritativeEmpty = Array.isArray(remoteBundle?.entries)
      && remoteBundle.entries.length === 0;
    // Remote is authoritative for installed plugins; missing-plugin local rows
    // (and their baselines) are preserved when absent from a non-empty remote.
    const remoteKeys = new Set(
      remoteEntries.map((entry) => `${entry.pluginId}\0${entry.kind}\0${entry.key}`),
    );
    const preservedLocal = remoteIsAuthoritativeEmpty
      ? []
      : local.filter((entry) => {
        if (declared.has(entry.pluginId)) return false; // installed: remote wins
        return !remoteKeys.has(`${entry.pluginId}\0${entry.kind}\0${entry.key}`);
      });
    const merged = mergePluginSyncSidecars({
      local: preservedLocal,
      remote: { version: 1, entries: remoteEntries },
      declaredSettingsByPlugin: declared,
    });
    const safe = excludeSecretPluginSettingsFromSidecars(merged, declared);
    if (typeof this.database.replaceAllSyncSidecars === "function") {
      this.database.replaceAllSyncSidecars(safe);
    }
    // Drop installed-plugin settings that remote no longer carries.
    // Prefer contributionService.resetSetting so plugins and the renderer
    // receive change events; fall back to direct DB delete when unavailable.
    for (const entry of local) {
      if (entry.kind !== "settings") continue;
      if (!declared.has(entry.pluginId)) continue;
      if (remoteKeys.has(`${entry.pluginId}\0${entry.kind}\0${entry.key}`)) continue;
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) continue;
      if (typeof this.contributionService?.resetSetting === "function") {
        try {
          await this.contributionService.resetSetting(
            entry.pluginId,
            parsed.settingId,
            parsed.scopeId,
          );
        } catch {
          // Validation rejected the reset (e.g. required setting) — keep the
          // local value rather than force-deleting through the database.
        }
        continue;
      }
      this.database.deleteSetting(entry.pluginId, parsed.settingId, parsed.scope, parsed.scopeId);
    }
    for (const entry of safe) {
      if (entry.kind !== "settings") continue;
      const fields = declared.get(entry.pluginId);
      if (!fields) continue;
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) continue;
      const field = fields.find((item) => item.id === parsed.settingId);
      if (!field || !isCloudSyncablePluginSetting(field)) continue;
      // Always write under the currently declared scope. Older sidecars may
      // encode an obsolete scope after a plugin update; recreating that scope
      // would leave duplicate rows that collection republishes.
      const targetScope = typeof field.scope === "string" && field.scope.length > 0
        ? field.scope
        : parsed.scope;
      if (typeof this.contributionService?.updateSetting === "function") {
        try {
          await this.contributionService.updateSetting(
            entry.pluginId,
            parsed.settingId,
            entry.value,
            parsed.scopeId,
            { source: "host" },
          );
          // Preserve remote LWW timestamp after validated write (updateSetting uses clock).
          this.database.setSetting(
            entry.pluginId,
            parsed.settingId,
            targetScope,
            parsed.scopeId,
            entry.value,
            entry.updatedAt,
          );
          if (targetScope !== parsed.scope) {
            try {
              this.database.deleteSetting(
                entry.pluginId,
                parsed.settingId,
                parsed.scope,
                parsed.scopeId,
              );
            } catch {
              // Best-effort cleanup of the obsolete scope row.
            }
          }
        } catch {
          // Invalid against current schema — keep sidecar row only.
        }
        continue;
      }
      this.database.setSetting(
        entry.pluginId,
        parsed.settingId,
        targetScope,
        parsed.scopeId,
        entry.value,
        entry.updatedAt,
      );
      if (targetScope !== parsed.scope) {
        try {
          this.database.deleteSetting(
            entry.pluginId,
            parsed.settingId,
            parsed.scope,
            parsed.scopeId,
          );
        } catch {
          // Best-effort cleanup of the obsolete scope row.
        }
      }
    }
    return safe;
  }

  /**
   * After a plugin is installed/enabled, validate and apply retained settings
   * sidecars into plugin_settings so the running plugin sees cloud values.
   */
  async hydrateInstalledPluginSettings(pluginId) {
    if (typeof pluginId !== "string" || pluginId.length < 1) return;
    const declared = this.#declaredSettingsByPlugin().get(pluginId);
    if (!declared) return;
    const rows = typeof this.database.listSyncSidecars === "function"
      ? this.database.listSyncSidecars(pluginId)
      : [];
    for (const entry of rows) {
      if (entry.kind !== "settings") continue;
      const parsed = parseSettingsSidecarKey(entry.key);
      if (!parsed) continue;
      const field = declared.find((item) => item.id === parsed.settingId);
      if (!field || !isCloudSyncablePluginSetting(field)) continue;
      const targetScope = typeof field.scope === "string" && field.scope.length > 0
        ? field.scope
        : parsed.scope;
      if (typeof this.contributionService?.updateSetting === "function") {
        try {
          await this.contributionService.updateSetting(
            pluginId,
            parsed.settingId,
            entry.value,
            parsed.scopeId,
            { source: "host" },
          );
          this.database.setSetting(
            pluginId,
            parsed.settingId,
            targetScope,
            parsed.scopeId,
            entry.value,
            entry.updatedAt,
          );
          if (targetScope !== parsed.scope) {
            try {
              this.database.deleteSetting(
                pluginId,
                parsed.settingId,
                parsed.scope,
                parsed.scopeId,
              );
            } catch {
              // Best-effort cleanup of the obsolete scope row.
            }
          }
        } catch {
          // Invalid against current schema — keep sidecar only.
        }
      }
    }
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
