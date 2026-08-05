/**
 * Pure helpers for AI chat in-session jump navigation (user-turn TOC).
 */

export const CHAT_JUMP_MIN_ENTRIES = 3;
export const CHAT_JUMP_LABEL_MAX = 36;

export type ChatJumpMessage = {
  id: string;
  role: string;
  content?: string;
};

export type ChatJumpEntry = {
  messageId: string;
  label: string;
  /** 1-based index among user turns */
  index: number;
};

export function chatMessageDomId(messageId: string): string {
  return `ai-chat-msg-${messageId}`;
}

export function truncateChatJumpLabel(text: string, maxLen = CHAT_JUMP_LABEL_MAX): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

export function buildChatJumpEntries(
  messages: ReadonlyArray<ChatJumpMessage>,
  options?: {
    minEntries?: number;
    maxLabelLen?: number;
    emptyLabel?: string;
  },
): ChatJumpEntry[] {
  const minEntries = options?.minEntries ?? CHAT_JUMP_MIN_ENTRIES;
  const maxLabelLen = options?.maxLabelLen ?? CHAT_JUMP_LABEL_MAX;
  const emptyLabel = options?.emptyLabel ?? '…';
  const entries: ChatJumpEntry[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const label = truncateChatJumpLabel(message.content ?? '', maxLabelLen) || emptyLabel;
    entries.push({
      messageId: message.id,
      label,
      index: entries.length + 1,
    });
  }
  return entries.length >= minEntries ? entries : [];
}

/**
 * Expand the rendered tail window so a jump target is mounted in the DOM.
 */
export function resolveTailCountForJumpTarget(
  visibleMessages: ReadonlyArray<{ id: string }>,
  targetMessageId: string,
  currentTailCount: number,
): number {
  const targetIndex = visibleMessages.findIndex((message) => message.id === targetMessageId);
  if (targetIndex < 0) return currentTailCount;
  const requiredTail = visibleMessages.length - targetIndex;
  return Math.max(currentTailCount, requiredTail);
}
