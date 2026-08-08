/**
 * Minimal East-Asian-Width-style classifier: returns 2 for wide glyphs
 * (CJK ideographs, fullwidth forms, most emoji, hangul syllables) and
 * 1 otherwise. Not full wcwidth — just enough to keep predicted cursor
 * columns from drifting by one cell per CJK char typed.
 */
function codePointCellWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||   // Hiragana, Katakana, CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK Extension B-F, G
  ) {
    return 2;
  }
  return 1;
}

/** Terminal cell columns occupied by `s` (wide glyphs count as 2). */
export function stringCellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += codePointCellWidth(cp);
  }
  return w;
}
