const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CLEAR_BACKGROUND,
  isWindowsPlatform,
  windowsFramelessContentChromeOptions,
  windowsCssRoundedOverlayChromeOptions,
  resolveFramelessHostBackgroundColor,
} = require("./windowsWindowChrome.cjs");

test("CLEAR_BACKGROUND is fully transparent ARGB", () => {
  assert.equal(CLEAR_BACKGROUND, "#00000000");
});

test("isWindowsPlatform detects win32 only", () => {
  assert.equal(isWindowsPlatform("win32"), true);
  assert.equal(isWindowsPlatform("darwin"), false);
  assert.equal(isWindowsPlatform("linux"), false);
});

test("content chrome is a no-op outside Windows", () => {
  assert.deepEqual(windowsFramelessContentChromeOptions("darwin"), {});
  assert.deepEqual(windowsFramelessContentChromeOptions("linux"), {});
});

test("content chrome uses transparent host + native rounding on Windows", () => {
  assert.deepEqual(windowsFramelessContentChromeOptions("win32"), {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
    roundedCorners: true,
  });
});

test("CSS overlay chrome clears the opaque backdrop on every platform", () => {
  assert.deepEqual(windowsCssRoundedOverlayChromeOptions("darwin"), {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
  });
  assert.deepEqual(windowsCssRoundedOverlayChromeOptions("linux"), {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
  });
});

test("CSS overlay chrome disables OS rounding on Windows", () => {
  assert.deepEqual(windowsCssRoundedOverlayChromeOptions("win32"), {
    transparent: true,
    backgroundColor: CLEAR_BACKGROUND,
    roundedCorners: false,
  });
});

test("host backdrop stays clear on Windows after theme sync", () => {
  assert.equal(resolveFramelessHostBackgroundColor("#1a1a1a", "win32"), CLEAR_BACKGROUND);
  assert.equal(resolveFramelessHostBackgroundColor("#ffffff", "darwin"), "#ffffff");
  assert.equal(resolveFramelessHostBackgroundColor("#0b1220", "linux"), "#0b1220");
});

test("main/settings/tray call sites wire Windows chrome helpers", () => {
  const { readFileSync } = require("node:fs");
  const path = require("node:path");
  const here = __dirname;
  const main = readFileSync(path.join(here, "mainWindow.cjs"), "utf8");
  const settings = readFileSync(path.join(here, "settingsWindow.cjs"), "utf8");
  const popup = readFileSync(path.join(here, "terminalPopupWindow.cjs"), "utf8");
  const tray = readFileSync(path.join(here, "../globalShortcutBridge.cjs"), "utf8");
  const css = readFileSync(path.join(here, "../../../index.css"), "utf8");
  const html = readFileSync(path.join(here, "../../../index.html"), "utf8");

  for (const source of [main, settings, popup]) {
    assert.match(source, /windowsFramelessContentChromeOptions/);
    assert.match(source, /resolveFramelessHostBackgroundColor/);
  }
  assert.match(tray, /windowsCssRoundedOverlayChromeOptions/);
  assert.match(tray, /#2505/);
  assert.match(css, /html\.tray-window/);
  assert.match(html, /tray-window/);
});
