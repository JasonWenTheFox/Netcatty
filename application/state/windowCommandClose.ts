import { matchesKeyBinding } from '../../domain/models/keyBindings';

export interface WindowCommandCloseRequest {
  source?: 'keyboard';
  input?: {
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  };
}

export type WindowCommandCloseIntent =
  | { kind: 'hotkey'; input: NonNullable<WindowCommandCloseRequest['input']> }
  | { kind: 'closeTab' }
  | { kind: 'closeLogView'; tabId: string }
  | { kind: 'closeWindow' };

interface ResolveWindowCommandCloseIntentInput {
  activeTabId: string | null;
  editorTabIds: string[];
  sessionIds: string[];
  workspaceIds: string[];
  logViewIds: string[];
  pluginViewTabIds?: string[];
}

export function shouldHandleWindowCommandCloseRequest({
  request,
  closeTabKeyStr,
  isMac,
}: {
  request?: WindowCommandCloseRequest;
  closeTabKeyStr: string | null;
  isMac: boolean;
}): boolean {
  if (request?.source !== 'keyboard') return true;
  if (!request.input || !closeTabKeyStr) return false;
  return matchesKeyBinding(request.input as KeyboardEvent, closeTabKeyStr, isMac);
}

export function resolveWindowCommandCloseIntent({
  activeTabId,
  editorTabIds,
  sessionIds,
  workspaceIds,
  logViewIds,
  pluginViewTabIds = [],
}: ResolveWindowCommandCloseIntentInput): WindowCommandCloseIntent {
  if (!activeTabId) {
    return { kind: 'closeWindow' };
  }

  if (editorTabIds.includes(activeTabId) || pluginViewTabIds.includes(activeTabId)) {
    return { kind: 'closeTab' };
  }

  if (sessionIds.includes(activeTabId) || workspaceIds.includes(activeTabId)) {
    return { kind: 'closeTab' };
  }

  if (logViewIds.includes(activeTabId)) {
    return { kind: 'closeLogView', tabId: activeTabId };
  }

  if (activeTabId === 'vault' || activeTabId === 'sftp') {
    return { kind: 'closeWindow' };
  }

  return { kind: 'closeWindow' };
}

export function resolveWindowCommandCloseRequestIntent({
  request,
  closeTabKeyStr,
  isMac,
  ...intentInput
}: ResolveWindowCommandCloseIntentInput & {
  request?: WindowCommandCloseRequest;
  closeTabKeyStr: string | null;
  isMac: boolean;
}): WindowCommandCloseIntent | null {
  if (!shouldHandleWindowCommandCloseRequest({ request, closeTabKeyStr, isMac })) {
    if (request?.source === 'keyboard' && request.input) {
      return { kind: 'hotkey', input: request.input };
    }
    return null;
  }
  return resolveWindowCommandCloseIntent(intentInput);
}
