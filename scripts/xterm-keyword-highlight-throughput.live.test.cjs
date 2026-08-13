"use strict";

/* global process, __dirname, console */

if (!process.versions.electron) {
  const test = require("node:test");
  test("keyword highlighting keeps sustained output responsive", {
    skip: "run with Electron so the real WebGL renderer is available",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const childProcess = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const electron = require("electron");
  const esbuild = require("esbuild");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");

  const appRoot = path.resolve(__dirname, "..");
  const chunkCount = Number.parseInt(process.env.NETCATTY_TERMINAL_PERF_CHUNKS ?? "800", 10);
  const roundCount = Number.parseInt(process.env.NETCATTY_TERMINAL_PERF_ROUNDS ?? "3", 10);
  const userData = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("xterm-highlight-throughput")}-`);
  electron.app.setPath("userData", userData);
  electron.app.commandLine.appendSwitch("js-flags", "--expose-gc");
  electron.app.on("window-all-closed", () => {});
  let window = null;

  const cleanup = (exitCode) => {
    if (window && !window.isDestroyed()) window.destroy();
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch (error) {
      console.warn("Unable to remove xterm throughput test data:", error);
    } finally {
      electron.app.exit(exitCode);
    }
  };

  const buildModule = (source, resolveDir) => esbuild.buildSync({
    stdin: { contents: source, loader: "ts", resolveDir },
    alias: {
      "@xterm/headless": path.join(
        appRoot,
        "node_modules/@xterm/headless/lib-headless/xterm-headless.js",
      ),
    },
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "chrome142",
    write: false,
  }).outputFiles[0].text;

  void electron.app.whenReady().then(async () => {
    const oldSource = childProcess.execFileSync(
      "git",
      ["show", "origin/main:components/terminal/keywordHighlight.ts"],
      { cwd: appRoot, encoding: "utf8" },
    );
    const oldBundle = buildModule(oldSource, path.join(appRoot, "components/terminal"));
    const currentBundle = buildModule([
      `export * from ${JSON.stringify(path.join(appRoot, "components/terminal/keywordHighlight.ts"))};`,
      `export { noteTerminalOutputPressureData } from ${JSON.stringify(path.join(appRoot, "components/terminal/runtime/terminalOutputPressure.ts"))};`,
    ].join("\n"), appRoot);

    window = new electron.BrowserWindow({
      show: process.env.NETCATTY_TERMINAL_PERF_SHOW_WINDOW === "1",
      width: 1000,
      height: 640,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<!doctype html><style>html,body,#terminal{width:920px;height:560px;margin:0}</style><div id=terminal></div>",
      ),
    );

    const xtermPath = require.resolve("@xterm/xterm", { paths: [appRoot] });
    const webglPath = require.resolve("@xterm/addon-webgl", { paths: [appRoot] });
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { Terminal } = require(${JSON.stringify(xtermPath)});
      const { WebglAddon } = require(${JSON.stringify(webglPath)});
      const loadBundle = source => {
        const loaded = { exports: {} };
        ((module, exports) => { eval(source); })(loaded, loaded.exports);
        return loaded.exports;
      };
      const oldModule = loadBundle(${JSON.stringify(oldBundle)});
      const currentModule = loadBundle(${JSON.stringify(currentBundle)});
      const { noteTerminalOutputPressureData } = currentModule;
      const rules = [
        { id: "info", label: "Info", patterns: ["INFO"], color: "#60A5FA", enabled: true },
        { id: "warn", label: "Warn", patterns: ["WARN"], color: "#FBBF24", enabled: true },
        { id: "error", label: "Error", patterns: ["ERROR", "failed"], color: "#F87171", enabled: true },
        { id: "ip", label: "IP", patterns: ["10\\\\.2\\\\.\\\\d+\\\\.\\\\d+"], color: "#4ADE80", enabled: true },
      ];
      const makeChunk = index => {
        let chunk = "";
        for (let line = 0; line < 64; line += 1) {
          chunk += "2026-08-13 INFO worker=" + (line % 32) + " WARN ERROR failed from 10.2."
            + ((index + line) % 255) + "." + ((index * 7 + line) % 255) + " payload="
            + "x".repeat(24) + "\\r\\n";
        }
        return chunk;
      };
      const chunks = Array.from({ length: ${chunkCount} }, (_, index) => makeChunk(index));
      const totalChars = chunks.reduce((total, chunk) => total + chunk.length, 0);
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

      const run = async kind => {
        document.getElementById("terminal").replaceChildren();
        globalThis.gc?.();
        await wait(20);
        const v8 = require("node:v8");
        const heapBefore = v8.getHeapStatistics().used_heap_size;
        const term = new Terminal({
          allowProposedApi: true,
          cols: 120,
          cursorBlink: false,
          rows: 40,
          scrollback: 10000,
        });
        term.open(document.getElementById("terminal"));
        let renderer = "dom";
        try {
          term.loadAddon(new WebglAddon());
          renderer = "webgl";
        } catch {}
        const Highlighter = kind === "old"
          ? oldModule.KeywordHighlighter
          : currentModule.KeywordHighlighter;
        const highlighter = kind === "raw" ? null : new Highlighter(term);
        highlighter?.setRules(rules, true);
        const write = data => new Promise(resolve => term.write(data, resolve));
        const callbackLatencies = [];
        let renders = 0;
        const renderDisposable = term.onRender(() => { renders += 1; });
        const streamStarted = performance.now();
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          noteTerminalOutputPressureData(term, chunk);
          const callbackStarted = performance.now();
          await write(chunk);
          callbackLatencies.push(performance.now() - callbackStarted);
          if (index % 16 === 15) await wait(0);
        }
        const streamMs = performance.now() - streamStarted;
        const rendersAtStreamEnd = renders;
        const quietStarted = performance.now();
        await wait(700);
        await highlighter?.whenSettled?.();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const quietCatchUpMs = performance.now() - quietStarted - 700;
        globalThis.gc?.();
        await wait(20);
        const heapAfter = v8.getHeapStatistics().used_heap_size;
        callbackLatencies.sort((left, right) => left - right);
        const percentile = value => callbackLatencies[Math.min(
          callbackLatencies.length - 1,
          Math.floor(callbackLatencies.length * value),
        )];
        const state = {
          kind,
          renderer,
          streamMs,
          mibPerSecond: totalChars / 1024 / 1024 / (streamMs / 1000),
          callbackP50Ms: percentile(0.5),
          callbackP95Ms: percentile(0.95),
          callbackP99Ms: percentile(0.99),
          quietCatchUpMs,
          rendersDuringStream: rendersAtStreamEnd,
          heapDeltaMiB: (heapAfter - heapBefore) / 1024 / 1024,
          rebuildCount: highlighter?.rebuildCount ?? 0,
        };
        renderDisposable.dispose();
        highlighter?.dispose();
        term.dispose();
        return state;
      };

      const rounds = [];
      for (let round = 0; round < ${roundCount}; round += 1) {
        for (const kind of ["raw", "old", "new"]) rounds.push(await run(kind));
      }
      return { totalChars, chunks: chunks.length, rounds };
    })()`, true);

    for (const round of result.rounds) assert.equal(round.renderer, "webgl", JSON.stringify(round));
    const median = values => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
    const byKind = kind => result.rounds.filter(round => round.kind === kind);
    const oldStreamMs = median(byKind("old").map(round => round.streamMs));
    const newStreamMs = median(byKind("new").map(round => round.streamMs));
    const oldP99Ms = median(byKind("old").map(round => round.callbackP99Ms));
    const newP99Ms = median(byKind("new").map(round => round.callbackP99Ms));
    assert.ok(
      newStreamMs <= oldStreamMs * 1.1,
      `new sustained throughput regressed more than 10%: ${JSON.stringify(result)}`,
    );
    assert.ok(
      newP99Ms <= oldP99Ms * 1.15,
      `new p99 write latency regressed more than 15%: ${JSON.stringify(result)}`,
    );
    assert.equal(
      byKind("new").every(round => round.rebuildCount === 1),
      true,
      `bulk output must catch up exactly once after becoming quiet: ${JSON.stringify(result)}`,
    );
    process.stdout.write(`XTERM_KEYWORD_HIGHLIGHT_THROUGHPUT ${JSON.stringify(result)}\n`);
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
