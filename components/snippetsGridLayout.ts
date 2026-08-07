const SNIPPETS_GRID_GAP = 12;
const SNIPPETS_GRID_MIN_CARD_WIDTH = 220;
/** Match Tailwind `md:` / `xl:` used by the non-virtualized snippet grid. */
const SNIPPETS_GRID_MD_MIN_WIDTH = 768;
const SNIPPETS_GRID_XL_MIN_WIDTH = 1280;
const SNIPPETS_GRID_MAX_COLUMNS = 3;

/** Column policy for virtualized snippets — mirrors the CSS grid below the threshold. */
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
