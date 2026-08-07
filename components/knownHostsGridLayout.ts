/** Match Tailwind `grid-cols-2 sm:grid-cols-3 xl:grid-cols-4` for known hosts. */
const KNOWN_HOSTS_SM_MIN_WIDTH = 640;
const KNOWN_HOSTS_XL_MIN_WIDTH = 1280;

export function getKnownHostsGridColumnCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 2;
  if (width >= KNOWN_HOSTS_XL_MIN_WIDTH) return 4;
  if (width >= KNOWN_HOSTS_SM_MIN_WIDTH) return 3;
  return 2;
}
