export const VAULT_HOST_GRID_GAP = 12;
export const VAULT_HOST_GRID_MIN_CARD_WIDTH = 220;
export const VAULT_HOST_GRID_MAX_COLUMNS = 4;

export function getVaultHostGridColumnCount(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.min(
    VAULT_HOST_GRID_MAX_COLUMNS,
    Math.max(
      1,
      Math.floor(
        (width + VAULT_HOST_GRID_GAP)
        / (VAULT_HOST_GRID_MIN_CARD_WIDTH + VAULT_HOST_GRID_GAP),
      ),
    ),
  );
}

/**
 * Content-box width for a padded scroll container.
 * Matches VirtualizedHostCollection's child-root measure (excludes padding).
 */
export function getElementContentWidth(el: HTMLElement): number {
  const style = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const padLeft = style ? Number.parseFloat(style.paddingLeft) || 0 : 0;
  const padRight = style ? Number.parseFloat(style.paddingRight) || 0 : 0;
  return Math.max(0, el.clientWidth - padLeft - padRight);
}
