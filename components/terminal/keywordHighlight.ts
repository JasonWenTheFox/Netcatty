import { SerializeAddon } from "@xterm/addon-serialize";
import type { IBufferLine, IDisposable, Terminal as XTerm } from "@xterm/xterm";

import { isSafePluginDecorationPattern } from "../../domain/pluginTerminalProviders";
import { checkRegexSafetyPattern } from "../../lib/regexSafety";
import type { KeywordHighlightRule } from "../../types";
import { XTERM_PERFORMANCE_CONFIG } from "../../infrastructure/config/xtermPerformance";
import { readPluginTerminalBufferText } from "./pluginTerminalBufferText";
import { compileRe2RangeMatcher, forEachNonEmptyRegexMatch } from "./keywordHighlightRegex";
import { shouldDegradeTerminalKeywordHighlight } from "./runtime/terminalOutputPressure";

type RuntimeKeywordHighlightRule = KeywordHighlightRule & { readonly providerId?: string };

type CompiledPattern = {
  priority: number;
  rgb: number;
  plugin: boolean;
  visit(text: string, onMatch: (start: number, length: number) => boolean | void): void;
};

type HighlightMatch = {
  start: number;
  end: number;
  priority: number;
  rgb: number;
};

type InternalBufferLine = {
  length: number;
  isWrapped: boolean;
  _data: Uint32Array;
};

type InternalRenderService = {
  _isPaused?: boolean;
};

type LineOriginals = {
  fg: Uint32Array;
  content: Uint32Array;
  mask: Uint8Array;
};

type LogicalLine = {
  startY: number;
  endY: number;
  text: string;
  cellAtStringOffset: Array<{ y: number; x: number }>;
};

export type KeywordHighlighterOptions = {
  shouldBypassHighlight?: () => boolean;
  serializeAddon?: SerializeAddon;
  canRebuild?: () => boolean;
  shouldPreserveScrollback?: () => boolean;
  onRestoringSelectionChange?: (restoring: boolean) => void;
  onDidRebuild?: () => void;
};

const CELL_INDICES = 3;
const CELL_CONTENT = 0;
const CELL_FG = 1;
const STYLE_MASK = 0xfc000000;
const CM_RGB = 0x3000000;
const MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS = 4_096;
const MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE = 256;
const RECOLOR_SLICE_LINES = 256;
const RECOLOR_SLICE_BUDGET_MS = 4;

const withRgbFg = (originalFg: number, rgb: number): number => (
  (originalFg & STYLE_MASK) | CM_RGB | (rgb & 0xffffff)
);

const parseRgb = (color: string): number | null => {
  const normalized = color.trim();
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(normalized);
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(normalized);
  const components = full
    ? full.slice(1)
    : short
      ? short.slice(1).map((component) => component.repeat(2))
      : null;
  if (!components) return null;
  return components.reduce((value, component) => (
    (value << 8) | Number.parseInt(component, 16)
  ), 0);
};

const compilePatterns = (
  rules: readonly RuntimeKeywordHighlightRule[],
  enabled: boolean,
): CompiledPattern[] => {
  if (!enabled) return [];
  const compiled: CompiledPattern[] = [];
  for (const [priority, rule] of rules.entries()) {
    if (!rule.enabled) continue;
    const rgb = parseRgb(rule.color);
    if (rgb === null) continue;
    for (const pattern of rule.patterns) {
      if (!pattern || checkRegexSafetyPattern(pattern).safe === false) continue;
      if (rule.providerId) {
        if (!isSafePluginDecorationPattern(pattern)) continue;
        try {
          const matcher = compileRe2RangeMatcher(pattern);
          compiled.push({
            priority,
            rgb,
            plugin: true,
            visit(text, onMatch) {
              matcher(text, onMatch);
            },
          });
        } catch {
          // Invalid plugin rules are ignored at the display boundary.
        }
        continue;
      }
      try {
        const regex = new RegExp(pattern, "gi");
        compiled.push({
          priority,
          rgb,
          plugin: false,
          visit(text, onMatch) {
            forEachNonEmptyRegexMatch(regex, text, (match) => onMatch(match.index, match[0].length));
          },
        });
      } catch {
        // Invalid user rules are ignored. The settings UI also rejects them.
      }
    }
  }
  return compiled;
};

const getInternalLine = (line: IBufferLine | undefined): InternalBufferLine | null => {
  if (!line) return null;
  const view = line as IBufferLine & { _line?: InternalBufferLine; _data?: Uint32Array };
  if (view._line?._data) return view._line;
  if (view._data) return view as InternalBufferLine;
  return null;
};

const collectMatches = (
  text: string,
  patterns: readonly CompiledPattern[],
): HighlightMatch[] => {
  const matches: HighlightMatch[] = [];
  let pluginMatchCount = 0;
  for (const pattern of patterns) {
    if (pattern.plugin && pluginMatchCount >= MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE) continue;
    const scanText = pattern.plugin ? text.slice(0, MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS) : text;
    pattern.visit(scanText, (start, length) => {
      if (length <= 0) return;
      matches.push({
        start,
        end: start + length,
        priority: pattern.priority,
        rgb: pattern.rgb,
      });
      if (!pattern.plugin) return;
      pluginMatchCount += 1;
      return pluginMatchCount < MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE;
    });
  }
  if (matches.length === 0) return matches;
  matches.sort((left, right) => (
    left.start - right.start
    || left.priority - right.priority
    || right.end - left.end
  ));
  const accepted: HighlightMatch[] = [];
  for (const match of matches) {
    if (accepted.length === 0 || match.start >= accepted[accepted.length - 1].end) {
      accepted.push(match);
    }
  }
  return accepted;
};

const yieldToRenderer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Keyword highlighting mutates already-parsed cell foregrounds. Writes stay
 * pristine, so ordinary Enter/output never rebuilds history, and serialize can
 * restore the original colors without a second terminal.
 */
export class KeywordHighlighter implements IDisposable {
  readonly serializeAddon: SerializeAddon;
  rebuildCount = 0;
  lastRebuildTimings: Record<string, number> = {};

  private readonly originals = new WeakMap<InternalBufferLine, LineOriginals>();
  private readonly originalWrite: XTerm["write"];
  private readonly originalReset: XTerm["reset"];
  private readonly originalClear: XTerm["clear"];
  private readonly originalResize: XTerm["resize"];
  private readonly originalSerialize: SerializeAddon["serialize"];
  private readonly disposables: IDisposable[] = [];
  private rules: readonly RuntimeKeywordHighlightRule[] = [];
  private enabled = false;
  private compiledPatterns: CompiledPattern[] = [];
  private disposed = false;
  private catchUpFrom: number | null = null;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUpPromise: Promise<void> = Promise.resolve();
  private resolveCatchUp: (() => void) | null = null;
  private catchUpCounted = false;
  private catchUpRunning = false;
  private catchUpGeneration = 0;
  private pauseDepth = 0;
  private hasOutput = false;

  get pendingPristineBytes(): number {
    return 0;
  }

  get isPristineBackpressured(): boolean {
    return false;
  }

  constructor(
    private readonly term: XTerm,
    private readonly options: KeywordHighlighterOptions = {},
  ) {
    if (options.serializeAddon) {
      this.serializeAddon = options.serializeAddon;
    } else {
      this.serializeAddon = new SerializeAddon();
      term.loadAddon(this.serializeAddon);
    }
    this.originalSerialize = this.serializeAddon.serialize.bind(this.serializeAddon);
    this.serializeAddon.serialize = (serializeOptions) => {
      this.restoreBuffer();
      try {
        return this.originalSerialize(serializeOptions);
      } finally {
        if (!this.disposed && this.compiledPatterns.length > 0) {
          const buffer = this.term.buffer.active;
          if (buffer.type === "normal" && buffer.length > 0) {
            this.recolorRange(0, buffer.length - 1, true);
          }
        }
      }
    };
    this.originalWrite = term.write.bind(term);
    this.originalReset = term.reset.bind(term);
    this.originalClear = term.clear.bind(term);
    this.originalResize = term.resize.bind(term);
    (term as XTerm & { __netcattyKeywordHighlighter?: KeywordHighlighter })
      .__netcattyKeywordHighlighter = this;
    term.write = this.write;
    term.reset = this.reset;
    term.clear = this.clear;
    term.resize = this.resize;
    this.disposables.push(
      term.buffer.onBufferChange(() => {
        if (this.term.buffer.active.type !== "normal") return;
        if (this.catchUpFrom !== null) this.scheduleCatchUp();
      }),
    );
  }

  setRules(rules: readonly RuntimeKeywordHighlightRule[], enabled: boolean): void {
    if (this.disposed) return;
    const nextRules = rules.map((rule) => ({ ...rule, patterns: [...rule.patterns] }));
    const nextSignature = JSON.stringify([enabled, nextRules]);
    const currentSignature = JSON.stringify([this.enabled, this.rules]);
    if (nextSignature === currentSignature) return;
    this.rules = nextRules;
    this.enabled = enabled;
    this.compiledPatterns = compilePatterns(this.rules, this.enabled);
    if (!this.hasOutput) return;
    if (this.catchUpTimer !== null) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.catchUpGeneration += 1;
    this.catchUpCounted = true;
    this.rebuildCount += 1;
    const started = performance.now();
    this.recolorVisible();
    this.markCatchUp(0);
    if (!this.resolveCatchUp) {
      this.catchUpPromise = new Promise((resolve) => {
        this.resolveCatchUp = resolve;
      });
    }
    void this.runCatchUp();
    this.lastRebuildTimings = { total: performance.now() - started };
  }

  async whenSettled(): Promise<void> {
    while (!this.disposed) {
      const catchUp = this.catchUpPromise;
      await catchUp;
      if (this.catchUpTimer === null && !this.catchUpRunning) return;
      await yieldToRenderer();
    }
  }

  async prepareForSerialization(): Promise<void> {
    await this.whenSettled();
  }

  async waitForPristineBackpressure(): Promise<void> {}

  syncScrollback(): void {}

  mirrorViewportScroll(_lines: number): void {}

  mirrorScrollbackWipe(): void {}

  deferMutationDuringRebuild(_run: () => Promise<void> | void): boolean {
    return false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.write = this.originalWrite;
    this.term.reset = this.originalReset;
    this.term.clear = this.originalClear;
    this.term.resize = this.originalResize;
    this.serializeAddon.serialize = this.originalSerialize;
    const patchedTerm = this.term as XTerm & { __netcattyKeywordHighlighter?: KeywordHighlighter };
    if (patchedTerm.__netcattyKeywordHighlighter === this) {
      delete patchedTerm.__netcattyKeywordHighlighter;
    }
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.resolveCatchUp?.();
    this.resolveCatchUp = null;
    this.setRendererPaused(false, true);
    for (const disposable of this.disposables) disposable.dispose();
  }

  private readonly write: XTerm["write"] = (data, callback) => {
    if (this.disposed) return this.originalWrite(data, callback);
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") {
      return this.originalWrite(data, callback);
    }
    const startY = buffer.baseY + buffer.cursorY;
    this.hasOutput = true;
    const bypass = this.shouldBypass(data);
    // eslint-disable-next-line no-control-regex -- terminal rewrite / erase bytes are intentional.
    const rewritesCurrentLine = typeof data === "string" && /[\r\x08]|\x1b\[[\d;]*K/.test(data);
    if (!bypass && this.compiledPatterns.length > 0) {
      if (rewritesCurrentLine) this.restorePhysicalLine(startY);
      this.setRendererPaused(true);
    }
    return this.originalWrite(data, () => {
      const active = this.term.buffer.active;
      if (active.type === "normal") {
        const endY = active.baseY + active.cursorY;
        if (bypass || this.compiledPatterns.length === 0) {
          if (this.enabled || this.hasStoredOriginalsInRange(startY, endY)) {
            this.markCatchUp(startY);
            this.scheduleCatchUp();
          }
        } else {
          this.recolorRange(startY, endY, true);
        }
      }
      if (!bypass) this.setRendererPaused(false);
      callback?.();
    });
  };

  private readonly reset: XTerm["reset"] = () => {
    this.clearStoredOriginals();
    this.cancelCatchUp();
    this.hasOutput = false;
    return this.originalReset();
  };

  private readonly clear: XTerm["clear"] = () => {
    this.clearStoredOriginals();
    this.cancelCatchUp();
    return this.originalClear();
  };

  private readonly resize: XTerm["resize"] = (cols, rows) => {
    this.restoreBuffer();
    const result = this.originalResize(cols, rows);
    if (this.compiledPatterns.length > 0) {
      this.recolorVisible();
      this.markCatchUp(0);
      this.scheduleCatchUp();
    }
    return result;
  };

  private shouldBypass(data: string | Uint8Array): boolean {
    if (this.options.shouldBypassHighlight?.()) return true;
    if (typeof data !== "string") return true;
    return shouldDegradeTerminalKeywordHighlight(this.term, data);
  }

  private markCatchUp(fromY: number): void {
    this.catchUpFrom = this.catchUpFrom === null ? fromY : Math.min(this.catchUpFrom, fromY);
  }

  private scheduleCatchUp(): void {
    if (this.disposed || this.catchUpFrom === null) return;
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    if (!this.resolveCatchUp) {
      this.catchUpPromise = new Promise((resolve) => {
        this.resolveCatchUp = resolve;
      });
    }
    const quietMs = XTERM_PERFORMANCE_CONFIG.highlighting.largeOutputQuietMs ?? 480;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      void this.runCatchUp();
    }, quietMs);
  }

  private cancelCatchUp(): void {
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
    this.catchUpFrom = null;
    this.catchUpCounted = false;
    this.catchUpGeneration += 1;
    this.resolveCatchUp?.();
    this.resolveCatchUp = null;
  }

  private async runCatchUp(): Promise<void> {
    if (this.disposed || this.catchUpFrom === null || this.catchUpRunning) return;
    const generation = this.catchUpGeneration;
    this.catchUpRunning = true;
    if (!this.catchUpCounted) {
      this.rebuildCount += 1;
      this.catchUpCounted = true;
    }
    const started = performance.now();
    try {
      let nextY = Math.max(0, this.catchUpFrom);
      while (!this.disposed && generation === this.catchUpGeneration) {
        const buffer = this.term.buffer.active;
        if (buffer.type !== "normal") break;
        if (nextY >= buffer.length) {
          this.catchUpFrom = null;
          break;
        }
        const sliceEnd = Math.min(buffer.length - 1, nextY + RECOLOR_SLICE_LINES - 1);
        const sliceStarted = performance.now();
        this.recolorRange(nextY, sliceEnd, false);
        nextY = sliceEnd + 1;
        this.catchUpFrom = nextY >= buffer.length ? null : nextY;
        if (this.catchUpFrom === null) break;
        if (performance.now() - sliceStarted >= RECOLOR_SLICE_BUDGET_MS) {
          await yieldToRenderer();
        }
      }
    } finally {
      this.catchUpRunning = false;
      this.lastRebuildTimings = { total: performance.now() - started };
      if (this.disposed) {
        this.resolveCatchUp?.();
        this.resolveCatchUp = null;
      } else if (this.catchUpFrom === null) {
        this.catchUpCounted = false;
        this.resolveCatchUp?.();
        this.resolveCatchUp = null;
      } else if (generation === this.catchUpGeneration) {
        this.scheduleCatchUp();
      } else {
        void this.runCatchUp();
      }
    }
  }

  private recolorVisible(): void {
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    const start = buffer.viewportY;
    const end = Math.min(buffer.length - 1, start + this.term.rows - 1);
    this.recolorRange(start, end, true);
  }

  private recolorRange(startY: number, endY: number, refresh: boolean): void {
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    const first = Math.max(0, Math.min(startY, endY));
    const last = Math.min(buffer.length - 1, Math.max(startY, endY));
    if (last < first) return;
    let y = first;
    while (y > 0 && buffer.getLine(y)?.isWrapped) y -= 1;
    let paintedStart = Number.POSITIVE_INFINITY;
    let paintedEnd = -1;
    while (y <= last) {
      const logical = this.readLogicalLine(y);
      if (!logical) {
        y += 1;
        continue;
      }
      this.recolorLogicalLine(logical);
      paintedStart = Math.min(paintedStart, logical.startY);
      paintedEnd = Math.max(paintedEnd, logical.endY);
      y = logical.endY + 1;
    }
    if (refresh && paintedEnd >= paintedStart) this.refreshAbsolute(paintedStart, paintedEnd);
  }

  private recolorLogicalLine(logical: LogicalLine): void {
    this.restoreLogicalLine(logical);
    if (this.compiledPatterns.length === 0) return;
    const matches = collectMatches(logical.text, this.compiledPatterns);
    for (const match of matches) {
      const startCell = logical.cellAtStringOffset[match.start];
      const endCell = logical.cellAtStringOffset[match.end];
      if (!startCell || !endCell) continue;
      if (startCell.y === endCell.y) {
        this.colorPhysicalRange(startCell.y, startCell.x, endCell.x, match.rgb);
        continue;
      }
      const startLine = this.term.buffer.active.getLine(startCell.y);
      this.colorPhysicalRange(startCell.y, startCell.x, startLine?.length ?? startCell.x, match.rgb);
      for (let y = startCell.y + 1; y < endCell.y; y += 1) {
        const line = this.term.buffer.active.getLine(y);
        if (line) this.colorPhysicalRange(y, 0, line.length, match.rgb);
      }
      this.colorPhysicalRange(endCell.y, 0, endCell.x, match.rgb);
    }
  }

  private colorPhysicalRange(y: number, startX: number, endX: number, rgb: number): void {
    const internal = getInternalLine(this.term.buffer.active.getLine(y));
    if (!internal || endX <= startX) return;
    const originals = this.ensureOriginals(internal);
    const last = Math.min(internal.length, endX);
    for (let x = Math.max(0, startX); x < last; x += 1) {
      const dataIndex = x * CELL_INDICES;
      const content = internal._data[dataIndex + CELL_CONTENT];
      const currentFg = internal._data[dataIndex + CELL_FG];
      if (!originals.mask[x] || originals.content[x] !== content) {
        originals.fg[x] = currentFg;
        originals.content[x] = content;
        originals.mask[x] = 1;
      }
      internal._data[dataIndex + CELL_FG] = withRgbFg(originals.fg[x], rgb);
    }
  }

  private restoreLogicalLine(logical: LogicalLine): void {
    for (let y = logical.startY; y <= logical.endY; y += 1) this.restorePhysicalLine(y);
  }

  private restorePhysicalLine(y: number): void {
    const internal = getInternalLine(this.term.buffer.active.getLine(y));
    if (!internal) return;
    const originals = this.originals.get(internal);
    if (!originals) return;
    for (let x = 0; x < internal.length; x += 1) {
      if (!originals.mask[x]) continue;
      const dataIndex = x * CELL_INDICES;
      const content = internal._data[dataIndex + CELL_CONTENT];
      if (originals.content[x] !== content) {
        originals.mask[x] = 0;
        continue;
      }
      internal._data[dataIndex + CELL_FG] = originals.fg[x];
      originals.mask[x] = 0;
    }
  }

  private restoreBuffer(): void {
    const buffer = this.term.buffer.active;
    if (buffer.type !== "normal") return;
    for (let y = 0; y < buffer.length; y += 1) this.restorePhysicalLine(y);
  }

  private ensureOriginals(line: InternalBufferLine): LineOriginals {
    let originals = this.originals.get(line);
    if (!originals || originals.fg.length < line.length) {
      originals = {
        fg: new Uint32Array(line.length),
        content: new Uint32Array(line.length),
        mask: new Uint8Array(line.length),
      };
      this.originals.set(line, originals);
    }
    return originals;
  }

  private hasStoredOriginalsInRange(startY: number, endY: number): boolean {
    const buffer = this.term.buffer.active;
    const last = Math.min(buffer.length - 1, Math.max(startY, endY));
    for (let y = Math.max(0, Math.min(startY, endY)); y <= last; y += 1) {
      const internal = getInternalLine(buffer.getLine(y));
      if (internal && this.originals.get(internal)) return true;
    }
    return false;
  }

  private clearStoredOriginals(): void {
    const buffer = this.term.buffer.normal;
    for (let y = 0; y < buffer.length; y += 1) {
      const internal = getInternalLine(buffer.getLine(y));
      if (internal) this.originals.delete(internal);
    }
  }

  private readLogicalLine(startY: number): LogicalLine | null {
    const buffer = this.term.buffer.active;
    if (!buffer.getLine(startY)) return null;
    let first = startY;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first -= 1;
    let last = first;
    while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last += 1;
    let text = "";
    const cellAtStringOffset: Array<{ y: number; x: number }> = [];
    for (let y = first; y <= last; y += 1) {
      const line = buffer.getLine(y);
      if (!line) continue;
      const mapped = readPluginTerminalBufferText(line, y === last);
      const base = text.length;
      text += mapped.text;
      for (let offset = 0; offset < mapped.text.length; offset += 1) {
        cellAtStringOffset[base + offset] = { y, x: mapped.cellAtStringOffset[offset] ?? offset };
      }
      cellAtStringOffset[text.length] = {
        y,
        x: mapped.cellAtStringOffset[mapped.text.length] ?? line.length,
      };
    }
    return { startY: first, endY: last, text, cellAtStringOffset };
  }

  private refreshAbsolute(startY: number, endY: number): void {
    const viewportY = this.term.buffer.active.viewportY;
    const startRow = Math.max(0, startY - viewportY);
    const endRow = Math.min(this.term.rows - 1, endY - viewportY);
    if (startRow <= endRow) this.term.refresh(startRow, endRow);
  }

  private setRendererPaused(paused: boolean, force = false): void {
    const renderService = (
      this.term as unknown as { _core?: { _renderService?: InternalRenderService } }
    )._core?._renderService;
    if (!renderService) return;
    if (force) {
      this.pauseDepth = 0;
      renderService._isPaused = false;
      return;
    }
    if (paused) {
      if (this.pauseDepth === 0) renderService._isPaused = true;
      this.pauseDepth += 1;
      return;
    }
    this.pauseDepth = Math.max(0, this.pauseDepth - 1);
    if (this.pauseDepth === 0) renderService._isPaused = false;
  }
}
