/**
 * Windows frameless window chrome helpers.
 *
 * Background (#2505):
 * - Solid `backgroundColor` on frameless Win11 windows shows up as a dark rim
 *   inside DWM's rounded clip ("黑边"), and Win10 never gets OS rounding at all.
 * - Transparent tray popups that keep the default opaque white backdrop + CSS
 *   `border-radius` produce the "直角底上叠圆角 / 冒尖" look.
 *
 * Approach:
 * - App content windows: transparent host + clear backdrop + native
 *   `roundedCorners` so DWM clips the opaque page without a dark under-layer.
 * - Tray / CSS-shaped popovers: transparent host + clear backdrop +
 *   `roundedCorners: false` so only the CSS radius defines the silhouette
 *   (Electron #46468: Win11 otherwise forces OS rounding on transparent windows).
 */

const CLEAR_BACKGROUND = "#00000000";

function isWindowsPlatform(platform = process.platform) {
  return platform === "win32";
}

/**
 * Options for full-bleed app windows (main / settings / terminal popup).
 * Safe to spread on non-Windows — returns an empty object.
 */
function windowsFramelessContentChromeOptions(platform = process.platform) {
  if (!isWindowsPlatform(platform)) return {};
  return {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
    roundedCorners: true,
  };
}

/**
 * Options for CSS-rounded overlay windows (tray panel).
 * Always apply when creating those windows; callers already opt into transparency.
 */
function windowsCssRoundedOverlayChromeOptions(platform = process.platform) {
  return {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
    // Overlay shape comes from CSS; keep OS rounding off on Win11.
    ...(isWindowsPlatform(platform) ? { roundedCorners: false } : {}),
  };
}

/**
 * Host backdrop color for setBackgroundColor / theme sync.
 * On Windows content windows the host stays fully clear so theme paints live
 * in the page; a solid host color reintroduces the dark rim under DWM rounding.
 */
function resolveFramelessHostBackgroundColor(requestedColor, platform = process.platform) {
  if (isWindowsPlatform(platform)) return CLEAR_BACKGROUND;
  return requestedColor;
}

module.exports = {
  CLEAR_BACKGROUND,
  isWindowsPlatform,
  windowsFramelessContentChromeOptions,
  windowsCssRoundedOverlayChromeOptions,
  resolveFramelessHostBackgroundColor,
};
