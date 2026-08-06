/**
 * rsync-style "generator" skip: when size and mtime already match the target,
 * the file does not need to be transferred again.
 *
 * SFTP mtimes are typically second-precision; compare on whole seconds so a
 * local millisecond timestamp does not defeat an otherwise identical remote.
 */

export interface TransferSkipIdentity {
  size: number;
  lastModified: number;
}

export function normalizeTransferMtimeSeconds(lastModified: number): number {
  if (!Number.isFinite(lastModified) || lastModified <= 0) return 0;
  // Second timestamps at/above 1e10 are year ~2286+ - not plausible for file
  // mtimes. Treat those magnitudes as milliseconds so early-1970s through
  // pre-2001 local Date values (ms) still compare to SFTP second mtimes.
  // Using 1e11 left 1970-early-1973 ms misclassified as huge second counts.
  return lastModified >= 1e10 ? Math.floor(lastModified / 1000) : Math.floor(lastModified);
}

export function isUnchangedTransferCandidate(
  source: TransferSkipIdentity,
  target: TransferSkipIdentity,
): boolean {
  const sourceSize = Number(source.size);
  const targetSize = Number(target.size);
  if (!Number.isFinite(sourceSize) || !Number.isFinite(targetSize)) return false;
  if (sourceSize !== targetSize) return false;
  if (sourceSize < 0 || targetSize < 0) return false;
  const sourceMtime = normalizeTransferMtimeSeconds(source.lastModified);
  const targetMtime = normalizeTransferMtimeSeconds(target.lastModified);
  if (sourceMtime <= 0 || targetMtime <= 0) return false;
  return sourceMtime === targetMtime;
}
