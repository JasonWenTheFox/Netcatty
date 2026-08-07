export type FormatBytesZeroDisplay = "--" | "0 B";

export type FormatBytesOptions = {
  /** Display string when bytes is zero / non-finite. Defaults to `"0 B"`. */
  zeroDisplay?: FormatBytesZeroDisplay;
  /** Include the TB unit. Defaults to `true`. */
  includeTB?: boolean;
  /**
   * Fraction digits for KB+ units. Defaults to `1`.
   * Byte-sized values always use 0 fraction digits.
   */
  fractionDigits?: number;
  /** Label for the base byte unit. Defaults to `"B"`. */
  byteUnit?: "B" | "Bytes";
};

/**
 * Format a byte count with binary units (1024-based).
 * Call sites preserve their historical zero / precision / TB behavior via options.
 */
export function formatBytes(
  bytes: number,
  options: FormatBytesOptions = {},
): string {
  const {
    zeroDisplay = "0 B",
    includeTB = true,
    fractionDigits = 1,
    byteUnit = "B",
  } = options;

  if (!Number.isFinite(bytes) || bytes === 0) return zeroDisplay;

  const units = includeTB
    ? [byteUnit, "KB", "MB", "GB", "TB"]
    : [byteUnit, "KB", "MB", "GB"];
  const rawIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const i = Math.max(0, Math.min(units.length - 1, rawIndex));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : fractionDigits)} ${units[i]}`;
}
