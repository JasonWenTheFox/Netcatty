import { useCallback, useLayoutEffect, useMemo, useState } from 'react';

import type { TerminalTheme } from '../../domain/models';
import {
  idleThemeUserIntent,
  pickingThemeUserIntent,
  resolveGlobalTerminalAppearance,
  resolveTerminalAppearance,
  type ResolvedAppearance,
  type TerminalAppearanceHostScope,
  type TerminalAppearanceSettings,
  type ThemeUserIntent,
} from '../../domain/terminalAppearanceRuntime';
import { getFollowAppTerminalThemeSelectionUpdate } from '../../domain/terminalAppearance';
import {
  injectTerminalAppearanceVars,
} from '../../infrastructure/theme/terminalAppearanceVars';

export type ThemeRuntimeSettings = TerminalAppearanceSettings & {
  customThemes: TerminalTheme[];
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setLightUiThemeId: (id: string) => void;
  setDarkUiThemeId: (id: string) => void;
};

export function useThemeRuntime(settings: ThemeRuntimeSettings) {
  const {
    terminalThemeId,
    terminalThemeDarkId,
    terminalThemeLightId,
    followAppTerminalTheme,
    resolvedTheme,
    lightUiThemeId,
    darkUiThemeId,
    customThemes,
    setTheme,
    setLightUiThemeId,
    setDarkUiThemeId,
  } = settings;

  const [userIntent, setUserIntent] = useState<ThemeUserIntent>(idleThemeUserIntent());

  const appearanceSettings = useMemo((): TerminalAppearanceSettings => ({
    terminalThemeId,
    terminalThemeDarkId,
    terminalThemeLightId,
    followAppTerminalTheme,
    resolvedTheme,
    lightUiThemeId,
    darkUiThemeId,
    // Accent is owned by appearanceChromeStore + Terminal leaf apply.
    // Keep layer themes unaccented so accent drag does not churn
    // resolveFocusedAppearance / TerminalLayer memo.
    accentMode: 'theme',
    customAccent: '',
  }), [
    terminalThemeId,
    terminalThemeDarkId,
    terminalThemeLightId,
    followAppTerminalTheme,
    resolvedTheme,
    lightUiThemeId,
    darkUiThemeId,
  ]);

  const globalAppearance = useMemo(() => resolveGlobalTerminalAppearance({
    userIntent,
    settings: appearanceSettings,
    customThemes,
  }), [userIntent, appearanceSettings, customThemes]);

  const resolveFocusedAppearance = useCallback((hostScope: TerminalAppearanceHostScope): ResolvedAppearance => (
    resolveTerminalAppearance({
      userIntent,
      settings: appearanceSettings,
      hostScope,
      customThemes,
    })
  ), [userIntent, appearanceSettings, customThemes]);

  const applyFollowAppSettingsForPick = useCallback((themeId: string) => {
    const update = getFollowAppTerminalThemeSelectionUpdate(themeId);
    if (!update) return false;
    if (update.appTheme === 'dark') {
      setDarkUiThemeId(update.uiThemeId);
    } else {
      setLightUiThemeId(update.uiThemeId);
    }
    setTheme(update.appTheme);
    return true;
  }, [setDarkUiThemeId, setLightUiThemeId, setTheme]);

  const pickTheme = useCallback((themeId: string, options?: { followApp?: boolean; scopeHostId?: string | null }) => {
    const followApp = options?.followApp ?? followAppTerminalTheme;
    setUserIntent(pickingThemeUserIntent(themeId, {
      scopeHostId: followApp ? undefined : options?.scopeHostId,
    }));
    if (followApp) {
      applyFollowAppSettingsForPick(themeId);
    }
  }, [applyFollowAppSettingsForPick, followAppTerminalTheme]);

  const clearIntent = useCallback(() => {
    setUserIntent(idleThemeUserIntent());
  }, []);

  const settleManualIntent = useCallback(() => {
    setUserIntent(idleThemeUserIntent());
  }, []);

  // Stable bag identity so App domain memos can depend on members (or the
  // bag) without thrashing on every parent render.
  return useMemo(() => ({
    userIntent,
    globalAppearance,
    resolveFocusedAppearance,
    pickTheme,
    clearIntent,
    settleManualIntent,
    currentTerminalTheme: globalAppearance.theme,
  }), [
    userIntent,
    globalAppearance,
    resolveFocusedAppearance,
    pickTheme,
    clearIntent,
    settleManualIntent,
  ]);
}

export function useTerminalAppearanceInjection(
  appearance: ResolvedAppearance,
  options?: { includeChromeSurfaces?: boolean },
): void {
  const includeChromeSurfaces = options?.includeChromeSurfaces ?? true;
  useLayoutEffect(() => {
    injectTerminalAppearanceVars(appearance.theme, { includeChromeSurfaces });
  }, [appearance.theme.id, appearance.theme, includeChromeSurfaces]);
}
