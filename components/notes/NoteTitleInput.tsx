import React, { useEffect, useRef, useState } from "react";
import {
  resolveSupersededImeInputEvent,
  shouldAdoptExternalImeControlledValue,
  shouldCommitImeControlledChange,
} from "../../domain/imeControlledInput";

type NoteTitleInputProps = {
  noteId: string;
  value: string;
  placeholder?: string;
  className?: string;
  onCommit: (title: string) => void;
  onBlur?: () => void;
};

/**
 * Controlled note-title field that does not push parent updates during CJK IME
 * composition. Immediate `value={external}` writes mid-composition break Windows
 * IMEs such as Sogou Wubi (candidate dismiss / no committed text).
 */
export const NoteTitleInput: React.FC<NoteTitleInputProps> = ({
  noteId,
  value,
  placeholder,
  className,
  onCommit,
  onBlur,
}) => {
  const [draft, setDraft] = useState(value);
  const composingRef = useRef(false);
  const valueAtComposeStartRef = useRef(value);
  const supersededRef = useRef(false);
  const noteIdRef = useRef(noteId);

  useEffect(() => {
    if (noteIdRef.current !== noteId) {
      noteIdRef.current = noteId;
      composingRef.current = false;
      supersededRef.current = false;
      setDraft(value);
      return;
    }

    setDraft((draftValue) => {
      const composing = composingRef.current;
      const shouldAdopt = shouldAdoptExternalImeControlledValue({
        isComposingSession: composing,
        draftValue,
        externalValue: value,
        valueAtComposeStart: composing ? valueAtComposeStartRef.current : undefined,
      });
      if (shouldAdopt && composing && value !== valueAtComposeStartRef.current) {
        supersededRef.current = true;
      }
      return shouldAdopt ? value : draftValue;
    });
  }, [noteId, value]);

  const commit = (next: string) => {
    composingRef.current = false;
    supersededRef.current = false;
    setDraft(next);
    onCommit(next);
  };

  return (
    <input
      data-note-title-input="true"
      className={className}
      value={draft}
      placeholder={placeholder}
      onBlur={(event) => {
        // Blur finalizes IME: commit the local draft before parent flushNoteDraft
        // so composition-only titles are not lost when draftTitleRef was never set.
        if (!supersededRef.current) {
          composingRef.current = false;
          const next = event.currentTarget.value;
          setDraft(next);
          onCommit(next);
        }
        onBlur?.();
      }}
      onChange={(event) => {
        const superseded = resolveSupersededImeInputEvent({
          compositionExternallySuperseded: supersededRef.current,
          isComposingSession: composingRef.current,
          nativeEventIsComposing: event.nativeEvent.isComposing,
        });
        if (superseded.ignoreEventValue) {
          if (superseded.clearSupersedeLatch) {
            supersededRef.current = false;
          }
          setDraft(value);
          return;
        }

        const next = event.target.value;
        setDraft(next);
        if (
          shouldCommitImeControlledChange({
            isComposingSession: composingRef.current,
            nativeEventIsComposing: event.nativeEvent.isComposing,
            compositionExternallySuperseded: supersededRef.current,
          })
        ) {
          onCommit(next);
        }
      }}
      onCompositionStart={() => {
        composingRef.current = true;
        supersededRef.current = false;
        valueAtComposeStartRef.current = value;
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        if (value !== valueAtComposeStartRef.current || supersededRef.current) {
          supersededRef.current = true;
          setDraft(value);
          window.setTimeout(() => {
            if (supersededRef.current && !composingRef.current) {
              supersededRef.current = false;
            }
          }, 0);
          return;
        }
        commit(event.currentTarget.value);
      }}
    />
  );
};
