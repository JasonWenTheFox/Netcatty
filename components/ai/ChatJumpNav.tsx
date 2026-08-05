/**
 * Floating jump list for long AI chat sessions (user-turn TOC).
 */

import { ListTree, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStickToBottomContext } from 'use-stick-to-bottom';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { ChatJumpEntry } from '../../domain/chatJumpNav';
import { cn } from '../../lib/utils';

export interface ChatJumpNavProps {
  entries: ChatJumpEntry[];
  activeMessageId: string | null;
  onSelect: (messageId: string) => void;
}

const ChatJumpNav: React.FC<ChatJumpNavProps> = ({
  entries,
  activeMessageId,
  onSelect,
}) => {
  const { t } = useI18n();
  const { stopScroll } = useStickToBottomContext();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const handleSelect = useCallback((messageId: string) => {
    stopScroll();
    onSelect(messageId);
    setOpen(false);
  }, [onSelect, stopScroll]);

  if (entries.length === 0) return null;

  return (
    <div ref={rootRef} className="absolute top-3 right-3 z-20 flex flex-col items-end gap-1.5">
      <button
        type="button"
        className={cn(
          'h-7 w-7 rounded-full border border-border/40 bg-background/90 backdrop-blur-sm',
          'flex items-center justify-center shadow-sm',
          'text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer',
          open && 'text-foreground bg-muted',
        )}
        aria-label={t('ai.chat.jumpNav')}
        aria-expanded={open}
        title={t('ai.chat.jumpNav')}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X size={14} /> : <ListTree size={14} />}
      </button>

      {open && (
        <div
          className={cn(
            'w-[min(220px,calc(100vw-2rem))] max-h-[min(320px,50vh)] overflow-y-auto',
            'rounded-md border border-border/50 bg-background/95 backdrop-blur-sm shadow-md',
            'py-1',
          )}
          role="listbox"
          aria-label={t('ai.chat.jumpNav')}
        >
          {entries.map((entry) => {
            const selected = entry.messageId === activeMessageId;
            return (
              <button
                key={entry.messageId}
                type="button"
                role="option"
                aria-selected={selected}
                className={cn(
                  'flex w-full items-start gap-2 px-2.5 py-1.5 text-left text-[12px] leading-snug',
                  'hover:bg-muted/70 transition-colors cursor-pointer',
                  selected
                    ? 'bg-muted text-foreground'
                    : 'text-foreground/80',
                )}
                onClick={() => handleSelect(entry.messageId)}
              >
                <span className="shrink-0 tabular-nums text-muted-foreground/70 w-4 text-right">
                  {entry.index}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ChatJumpNav;
