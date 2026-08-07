const SNIPPETS_GRID_GAP = 12;
const SNIPPETS_GRID_MIN_CARD_WIDTH = 220;
/** Container-width thresholds (mirrors former md / xl column steps). */
const SNIPPETS_GRID_MD_MIN_WIDTH = 768;
const SNIPPETS_GRID_XL_MIN_WIDTH = 1280;
const SNIPPETS_GRID_MAX_COLUMNS = 3;

/** Column policy for snippets — shared by virtualized and CSS-var grids. */
export function getSnippetsGridColumnCount(
  width: number,
  options: { hasSidePanel: boolean },
): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  if (options.hasSidePanel) {
    return Math.max(
      1,
      Math.floor(
        (width + SNIPPETS_GRID_GAP)
        / (SNIPPETS_GRID_MIN_CARD_WIDTH + SNIPPETS_GRID_GAP),
      ),
    );
  }
  if (width >= SNIPPETS_GRID_XL_MIN_WIDTH) return SNIPPETS_GRID_MAX_COLUMNS;
  if (width >= SNIPPETS_GRID_MD_MIN_WIDTH) return 2;
  return 1;
}
