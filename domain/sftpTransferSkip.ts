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
  // Epoch seconds for ~1973..5138 sit below 1e11; millisecond timestamps for
  // post-1973 dates sit above it (year 2000 ms ~= 9.5e11). Using 1e12 would
  // mis-classify pre-2001 millisecond mtimes as seconds.
  return lastModified >= 1e11 ? Math.floor(lastModified / 1000) : Math.floor(lastModified);
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
