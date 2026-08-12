/**
 * Home discovery helpers for remote SFTP connect.
 *
 * When SSH exec is unavailable, `realpath('.')` may return `/`. That path is a
 * valid virtual/chroot root when listable (#2934), but it is only provisional
 * when the session merely starts at filesystem root — candidate homes like
 * `/home/<user>` must still be probed (#2940).
 *
 * Authoritative sources (SSH `echo ~`, SCP `$HOME`) may also return `/` when
 * HOME is intentionally set to `/`. Callers must use bridge `provisional`
 * metadata rather than inferring solely from the path string.
 */

export type SftpHomeDiscoveryResult = {
  homeDir: string;
  /** When set by the bridge: true only for provisional realpath('.') === '/'. */
  provisional?: boolean;
};

/**
 * Whether discovery only knows a provisional filesystem root.
 * Prefers bridge metadata; falls back to path-only inference for legacy results.
 */
export function isProvisionalSftpHomeDiscovery(result: SftpHomeDiscoveryResult): boolean {
  if (typeof result.provisional === "boolean") {
    return result.provisional;
  }
  return result.homeDir === "/";
}

/** @deprecated Prefer isProvisionalSftpHomeDiscovery with bridge metadata. */
export function isProvisionalSftpHomeDir(homeDir: string): boolean {
  return isProvisionalSftpHomeDiscovery({ homeDir });
}

/**
 * Whether a successful getSftpHomeDir result should suppress hardcoded
 * `/home/<user>` / `/root` candidate probing.
 */
export function shouldSuppressSftpHomeCandidateProbe(result: SftpHomeDiscoveryResult): boolean {
  return !isProvisionalSftpHomeDiscovery(result);
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
  /** When known, overrides path-only provisional inference for homeDir. */
  provisionalHome?: boolean;
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

  const provisional = isProvisionalSftpHomeDiscovery({
    homeDir: params.homeDir,
    provisional: params.provisionalHome,
  });
  if (provisional) {
    for (const candidate of buildSftpHomeCandidates(params.username)) {
      push(candidate);
    }
  }

  return ordered;
}
