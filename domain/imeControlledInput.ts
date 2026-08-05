/**
 * Pure helpers for controlled text inputs that must not fight CJK IME composition.
 *
 * Deferred parent updates (e.g. startTransition) against `value={external}` reset
 * the DOM mid-composition and break Windows IMEs (candidate dismiss / pinyin echo).
 */

export function shouldCommitImeControlledChange(input: {
  isComposingSession: boolean;
  nativeEventIsComposing?: boolean;
}): boolean {
  return !input.isComposingSession && input.nativeEventIsComposing !== true;
}

export function shouldAdoptExternalImeControlledValue(input: {
  isComposingSession: boolean;
  draftValue: string;
  externalValue: string;
}): boolean {
  return !input.isComposingSession && input.draftValue !== input.externalValue;
}
