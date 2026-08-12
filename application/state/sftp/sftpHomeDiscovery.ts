/**
 * Home discovery helpers for remote SFTP connect.
 *
 * When SSH exec is unavailable, `realpath('.')` may return `/`. That path is a
 * valid virtual/chroot root when listable (#2934), but it is only provisional
 * when the session merely starts at filesystem root — candidate homes like
 * `/home/<user>` must still be probed (#2940).
 */

/** True when discovery only knows the filesystem root (not a concrete home). */
export function isProvisionalSftpHomeDir(homeDir: string): boolean {
  return homeDir === "/";
}

/**
 * Whether a successful getSftpHomeDir result should suppress hardcoded
 * `/home/<user>` / `/root` candidate probing.
 */
export function shouldSuppressSftpHomeCandidateProbe(homeDir: string): boolean {
  return !isProvisionalSftpHomeDir(homeDir);
}

/** Hardcoded Unix home candidates used when protocol discovery is incomplete. */
export function buildSftpHomeCandidates(username?: string | null): string[] {
  if (username === "root") {
    return ["/root"];
  }
  if (username) {
    return [`/home/${username}`, "/root"];
  }
  return ["/root"];
}

/**
 * Paths to try after an initial remote list fails, in order.
 * Skips duplicates of paths already attempted.
 */
export function buildSftpListFallbackPaths(params: {
  startPath: string;
  homeDir: string;
  username?: string | null;
}): string[] {
  const tried = new Set<string>([params.startPath]);
  const ordered: string[] = [];

  const push = (path: string) => {
    if (!path || tried.has(path)) return;
    tried.add(path);
    ordered.push(path);
  };

  push(params.homeDir);
  push("/");

  if (isProvisionalSftpHomeDir(params.homeDir)) {
    for (const candidate of buildSftpHomeCandidates(params.username)) {
      push(candidate);
    }
  }

  return ordered;
}
