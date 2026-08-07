/** FNV-1a 32-bit hash of a string (unsigned). */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hex-prefixed FNV-1a digest used for prompt/context snapshots. */
export function fnv1aHex(value: string): string {
  return `fnv1a-${fnv1a32(value).toString(16).padStart(8, "0")}`;
}
