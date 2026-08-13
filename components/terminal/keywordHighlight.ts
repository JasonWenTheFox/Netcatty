import { SerializeAddon } from "@xterm/addon-serialize";
import HeadlessXTerm from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import type {
  IDisposable,
  ILink,
  Terminal as XTerm,
} from "@xterm/xterm";

import { isSafePluginDecorationPattern } from "../../domain/pluginTerminalProviders";
import { checkRegexSafetyPattern } from "../../lib/regexSafety";
import type { KeywordHighlightRule } from "../../types";
import { compileRe2RangeMatcher, forEachNonEmptyRegexMatch } from "./keywordHighlightRegex";
import { restoreTerminalLineTimestampAnchors } from "./runtime/terminalLineTimestamps";
import { shouldDegradeTerminalKeywordHighlight } from "./runtime/terminalOutputPressure";

type OscLinkData = { readonly id?: string; readonly uri: string };

type OscLinkServiceLike = {
  getLinkData(linkId: number): OscLinkData | undefined;
};

type CellWithUrlId = {
  getChars(): string;
  getWidth(): number;
  extended?: { urlId?: number };
};

type RuntimeKeywordHighlightRule = KeywordHighlightRule & { readonly providerId?: string };

type ForegroundState =
  | { kind: "default" }
  | { kind: "ansi"; code: number }
  | { kind: "palette"; index: number }
  | { kind: "rgb"; red: number; green: number; blue: number };

type CompiledPattern = {
  priority: number;
  colorSequence: string;
  plugin: boolean;
  /** True when `$`, `\b`, or lookaround can depend on end-of-chunk. */
  endSensitive: boolean;
  visit(text: string, onMatch: (start: number, length: number) => boolean | void): void;
};

type HighlightMatch = {
  start: number;
  end: number;
  priority: number;
  colorSequence: string;
};

type ParserState = {
  alternateScreen: boolean;
  foreground: ForegroundState;
  linePrefix: string;
  linePrefixTruncated: boolean;
  pending: string;
  pendingKind: "escape" | "csi" | "osc" | "string" | null;
  pendingStringEscape: boolean;
};

export type KeywordHighlighterOptions = {
  shouldBypassHighlight?: () => boolean;
  canRebuild?: () => boolean;
};

type InternalScrollTerminal = {
  _core?: {
    scroll?: (eraseAttr: unknown, isWrapped: boolean) => void;
    _inputHandler?: { _eraseAttrData?: () => unknown };
  };
};

type InternalBrowserTerminal = {
  _core?: {
    _renderService?: {
      _isPaused?: boolean;
      refreshRows(start: number, end: number): void;
    };
  };
};

type PristineFlushState = {
  chunks: Array<string | Uint8Array>;
  generation: number;
  nextIndex: number;
};

const ESC = "\x1b";
const BEL = "\x07";
const C1_CSI = "\x9b";
const C1_OSC = "\x9d";
const C1_DCS = "\x90";
const C1_SOS = "\x98";
const C1_PM = "\x9e";
const C1_APC = "\x9f";
const C1_ST = "\x9c";
const MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS = 4_096;
const MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE = 256;
const BULK_HIGHLIGHT_CATCH_UP_MS = 600;
const MAX_DEFERRED_PRISTINE_BYTES = 8 * 1024 * 1024;
const RESUME_DEFERRED_PRISTINE_BYTES = 4 * 1024 * 1024;
const PRISTINE_WRITE_SLICE_BYTES = 32 * 1024;
const REBUILD_TRANSFORM_SLICE_LINES = 512;
const BACKPRESSURE_FLUSH_SLICE_BYTES = 256 * 1024;
const MAX_LINE_PREFIX_CHARS = 4_096;

const DEFAULT_FOREGROUND: ForegroundState = Object.freeze({ kind: "default" });

const createParserState = (): ParserState => ({
  alternateScreen: false,
  foreground: DEFAULT_FOREGROUND,
  linePrefix: "",
  linePrefixTruncated: false,
  pending: "",
  pendingKind: null,
  pendingStringEscape: false,
});

const yieldToTerminalRenderer = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const splitStringByLineCount = (value: string, maxLines: number): string[] => {
  if (!value || maxLines <= 0) return value ? [value] : [];
  const chunks: string[] = [];
  let start = 0;
  let lines = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\r" && char !== "\n") continue;
    if (char === "\r" && value[index + 1] === "\n") index += 1;
    lines += 1;
    if (lines < maxLines) continue;
    chunks.push(value.slice(start, index + 1));
    start = index + 1;
    lines = 0;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
};

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

/** ESC intermediates are 0x20-0x2F; the final byte is 0x30-0x7E (ECMA-48). */
const isEscIntermediate = (code: number): boolean => code >= 0x20 && code <= 0x2f;

const snapRangeToCodePoints = (
  text: string,
  start: number,
  end: number,
): { start: number; end: number } | null => {
  let from = start;
  let to = end;
  if (from < 0 || to > text.length || from >= to) return null;
  if (from > 0) {
    const code = text.charCodeAt(from);
    if (code >= 0xdc00 && code <= 0xdfff) from -= 1;
  }
  if (to > 0 && to <= text.length) {
    const prev = text.charCodeAt(to - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) {
      if (to >= text.length) return null;
      to += 1;
    }
  }
  if (from >= to) return null;
  return { start: from, end: to };
};

const getOscLinkService = (term: HeadlessTerminalType | XTerm): OscLinkServiceLike | null => {
  const core = (term as unknown as { _core?: { _oscLinkService?: OscLinkServiceLike } })._core;
  const service = core?._oscLinkService;
  return service && typeof service.getLinkData === "function" ? service : null;
};

const getCellUrlId = (cell: CellWithUrlId | undefined): number => cell?.extended?.urlId ?? 0;

/**
 * Detects patterns whose matches at end-of-string can change when more text arrives.
 * Approximate (string-level) so we never re-enter a sticky /g RegExp during visit.
 */
const isEndSensitivePattern = (pattern: string): boolean => (
  /(?:^|[^\\])(?:\\\\)*(?:\\[bB]|\$|\\[zZ])/.test(pattern)
  || /\(\?[=<!]/.test(pattern)
);

const bufferLineHasOscLinks = (line: { getCell(x: number): unknown }, cols: number): boolean => {
  for (let x = 0; x < cols; x += 1) {
    if (getCellUrlId(line.getCell(x) as CellWithUrlId | undefined)) return true;
  }
  return false;
};

/**
 * After history rebuild, SerializeAddon keeps link labels (as underline) but drops
 * OSC 8 metadata. Serve those links from the pristine buffer so they stay clickable
 * without duplicating xterm's built-in provider while urlIds are still present.
 */
const collectPristineOscLinksForLine = (
  pristine: HeadlessTerminalType,
  visible: XTerm,
  bufferLineNumber: number,
): ILink[] | undefined => {
  const lineIndex = bufferLineNumber - 1;
  if (lineIndex < 0) return undefined;
  const cols = visible.cols;
  const visibleLine = visible.buffer.normal.getLine(lineIndex);
  if (visibleLine && bufferLineHasOscLinks(visibleLine, cols)) return undefined;

  const service = getOscLinkService(pristine);
  const pristineLine = pristine.buffer.normal.getLine(lineIndex);
  if (!service || !pristineLine) return undefined;

  const links: ILink[] = [];
  let currentId = 0;
  let startX = 0;
  const finish = (endX: number): void => {
    if (!currentId || endX <= startX) return;
    const data = service.getLinkData(currentId);
    if (!data?.uri) return;
    const range = {
      start: { x: startX + 1, y: bufferLineNumber },
      end: { x: Math.max(startX + 1, endX), y: bufferLineNumber },
    };
    const handler = visible.options.linkHandler;
    links.push({
      text: data.uri,
      range,
      decorations: { pointerCursor: true, underline: true },
      activate: (event, text) => {
        if (handler) handler.activate(event, text, range);
      },
      hover: (event, text) => handler?.hover?.(event, text, range),
      leave: (event, text) => handler?.leave?.(event, text, range),
    });
  };

  for (let x = 0; x <= cols; x += 1) {
    const cell = x < cols ? pristineLine.getCell(x) as CellWithUrlId | undefined : undefined;
    const urlId = x < cols ? getCellUrlId(cell) : 0;
    if (urlId !== currentId) {
      finish(x);
      currentId = urlId;
      startX = x;
    }
  }
  return links.length > 0 ? links : undefined;
};

const updateForeground = (current: ForegroundState, sequence: string): ForegroundState => {
  if (!sequence.endsWith("m")) return current;
  const introducerLength = sequence.startsWith(C1_CSI) ? 1 : 2;
  const body = sequence.slice(introducerLength, -1);
  const rawParams = body ? body.split(";") : ["0"];
  const params = rawParams.map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  let next = current;
  for (let index = 0; index < params.length; index += 1) {
    const value = params[index];
    if (value === 0 || value === 39) {
      next = DEFAULT_FOREGROUND;
    } else if (value >= 30 && value <= 37) {
      next = { kind: "ansi", code: value };
    } else if (value >= 90 && value <= 97) {
      next = { kind: "ansi", code: value };
    } else if (value === 38) {
      const colonParts = rawParams[index].split(":");
      if (colonParts.length > 1) {
        const mode = Number.parseInt(colonParts[1], 10);
        const components = colonParts.slice(2)
          .filter((part) => part !== "")
          .map((part) => Number.parseInt(part, 10))
          .filter(Number.isFinite);
        if (mode === 5 && components.length >= 1) {
          next = { kind: "palette", index: Math.max(0, Math.min(255, components.at(-1)!)) };
        } else if (mode === 2 && components.length >= 3) {
          const [red, green, blue] = components.slice(-3);
          next = {
            kind: "rgb",
            red: Math.max(0, Math.min(255, red)),
            green: Math.max(0, Math.min(255, green)),
            blue: Math.max(0, Math.min(255, blue)),
          };
        }
        continue;
      }
      const mode = params[index + 1];
      if (mode === 5 && Number.isFinite(params[index + 2])) {
        next = { kind: "palette", index: Math.max(0, Math.min(255, params[index + 2])) };
        index += 2;
      } else if (
        mode === 2
        && Number.isFinite(params[index + 2])
        && Number.isFinite(params[index + 3])
        && Number.isFinite(params[index + 4])
      ) {
        next = {
          kind: "rgb",
          red: Math.max(0, Math.min(255, params[index + 2])),
          green: Math.max(0, Math.min(255, params[index + 3])),
          blue: Math.max(0, Math.min(255, params[index + 4])),
        };
        index += 4;
      }
    }
  }
  return next;
};

const foregroundSequence = (foreground: ForegroundState): string => {
  switch (foreground.kind) {
    case "ansi":
      return `${ESC}[${foreground.code}m`;
    case "palette":
      return `${ESC}[38;5;${foreground.index}m`;
    case "rgb":
      return `${ESC}[38;2;${foreground.red};${foreground.green};${foreground.blue}m`;
    case "default":
      return `${ESC}[39m`;
  }
};

const parseAlternateScreen = (sequence: string, current: boolean): boolean => {
  if (!sequence.endsWith("h") && !sequence.endsWith("l")) return current;
  const introducerLength = sequence.startsWith(C1_CSI) ? 1 : 2;
  const body = sequence.slice(introducerLength, -1);
  if (!body.startsWith("?")) return current;
  const modes = body.slice(1).split(";");
  if (!modes.some((mode) => mode === "47" || mode === "1047" || mode === "1049")) {
    return current;
  }
  return sequence.endsWith("h");
};

const toRgbSequence = (color: string): string | null => {
  const normalized = color.trim();
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(normalized);
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(normalized);
  const components = full
    ? full.slice(1)
    : short
      ? short.slice(1).map((component) => component.repeat(2))
      : null;
  if (!components) return null;
  return `${ESC}[38;2;${components.map((component) => Number.parseInt(component, 16)).join(";")}m`;
};

const compilePatterns = (rules: readonly RuntimeKeywordHighlightRule[], enabled: boolean): CompiledPattern[] => {
  if (!enabled) return [];
  const compiled: CompiledPattern[] = [];
  for (const [priority, rule] of rules.entries()) {
    if (!rule.enabled) continue;
    const colorSequence = toRgbSequence(rule.color);
    if (!colorSequence) continue;
    for (const pattern of rule.patterns) {
      if (!pattern || checkRegexSafetyPattern(pattern).safe === false) continue;
      if (rule.providerId) {
        if (!isSafePluginDecorationPattern(pattern)) continue;
        try {
          const matcher = compileRe2RangeMatcher(pattern);
          compiled.push({
            priority,
            colorSequence,
            plugin: true,
            endSensitive: isEndSensitivePattern(pattern),
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
        // Match settings editors (`gi`). Surrogate-safe ranges come from
        // snapRangeToCodePoints when matches are applied.
        const regex = new RegExp(pattern, "gi");
        compiled.push({
          priority,
          colorSequence,
          plugin: false,
          endSensitive: isEndSensitivePattern(pattern),
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

export class KeywordHighlightTransformer {
  private compiledPatterns: CompiledPattern[] = [];
  private state = createParserState();
  private missedBoundaryMatch = false;

  setRules(rules: readonly RuntimeKeywordHighlightRule[], enabled: boolean): void {
    this.compiledPatterns = compilePatterns(rules, enabled);
  }

  resetParserState(): void {
    this.state = createParserState();
    this.missedBoundaryMatch = false;
  }

  /** True when a match spanned a prior write and could not be colored inline. */
  takeMissedBoundaryMatch(): boolean {
    const missed = this.missedBoundaryMatch;
    this.missedBoundaryMatch = false;
    return missed;
  }

  transform(input: string, options: { bypass?: boolean; linesComplete?: boolean } = {}): string {
    if (!input) return input;
    this.missedBoundaryMatch = false;
    let output = "";
    let plain = "";
    let pluginMatchCount = 0;
    const flushPlain = (): void => {
      if (!plain) return;
      const text = plain;
      plain = "";
      const highlightLine = (line: string, prefix: string, lineComplete: boolean): string => {
        if (options.bypass || this.state.alternateScreen || this.compiledPatterns.length === 0) {
          return line;
        }
        const searchable = prefix + line;
        const offset = prefix.length;
        const matches: HighlightMatch[] = [];
        for (const pattern of this.compiledPatterns) {
          if (pattern.plugin && pluginMatchCount >= MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE) continue;
          // Plugin scans are bounded, but prior-line context must never consume
          // the budget intended for the newly arrived text.
          const currentScanLength = Math.min(line.length, MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS);
          const prefixScanLength = pattern.plugin
            ? Math.min(prefix.length, MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS - currentScanLength)
            : prefix.length;
          const scanStart = pattern.plugin ? prefix.length - prefixScanLength : 0;
          const scanText = pattern.plugin
            ? prefix.slice(-prefixScanLength) + line.slice(0, currentScanLength)
            : searchable;
          pattern.visit(scanText, (relativeStart, length) => {
            const start = relativeStart + scanStart;
            if (length <= 0) return;
            if (start < offset) {
              // Match begins in a prior write's already-emitted text; schedule catch-up.
              if (start + length > offset) this.missedBoundaryMatch = true;
              return;
            }
            // End anchors / word boundaries / lookarounds treat the write chunk as
            // end-of-string. Defer those matches until the logical line completes.
            if (
              !lineComplete
              && pattern.endSensitive
              && start + length >= searchable.length
            ) {
              this.missedBoundaryMatch = true;
              return;
            }
            const snapped = snapRangeToCodePoints(line, start - offset, start + length - offset);
            if (!snapped) return;
            matches.push({
              start: snapped.start,
              end: snapped.end,
              priority: pattern.priority,
              colorSequence: pattern.colorSequence,
            });
            if (!pattern.plugin) return;
            pluginMatchCount += 1;
            return pluginMatchCount < MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE;
          });
        }
        if (matches.length === 0) return line;
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
        let result = "";
        let position = 0;
        const restore = foregroundSequence(this.state.foreground);
        for (const match of accepted) {
          result += line.slice(position, match.start);
          result += match.colorSequence;
          result += line.slice(match.start, match.end);
          result += restore;
          position = match.end;
        }
        return result + line.slice(position);
      };
      if (this.state.alternateScreen) {
        output += text;
        return;
      }
      const parts = text.split(/(\r\n|\r|\n)/);
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (index % 2 === 1) {
          output += part;
          this.state.linePrefix = "";
          this.state.linePrefixTruncated = false;
          continue;
        }
        const lineComplete = options.linesComplete === true || index + 1 < parts.length;
        const prefix = `${this.state.linePrefixTruncated ? "\0" : ""}${this.state.linePrefix}`;
        output += highlightLine(part, prefix, lineComplete);
        const nextPrefix = this.state.linePrefix + part;
        this.state.linePrefixTruncated = (
          this.state.linePrefixTruncated || nextPrefix.length > MAX_LINE_PREFIX_CHARS
        );
        this.state.linePrefix = nextPrefix.slice(-MAX_LINE_PREFIX_CHARS);
      }
    };

    const completeSequence = (): void => {
      const sequence = this.state.pending;
      const kind = this.state.pendingKind;
      this.state.pending = "";
      this.state.pendingKind = null;
      this.state.pendingStringEscape = false;
      if (kind === "csi") {
        this.state.foreground = updateForeground(this.state.foreground, sequence);
        this.state.alternateScreen = parseAlternateScreen(sequence, this.state.alternateScreen);
      } else if (kind === "escape" && sequence === `${ESC}c`) {
        this.state.foreground = DEFAULT_FOREGROUND;
        this.state.alternateScreen = false;
        this.state.linePrefix = "";
        this.state.linePrefixTruncated = false;
      }
    };

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      const next = input[index + 1];
      if (this.state.pendingKind === "osc" || this.state.pendingKind === "string") {
        if (this.state.pendingStringEscape) {
          output += char;
          this.state.pendingStringEscape = false;
          if (char === "\\") {
            completeSequence();
          } else if (char === ESC && next === "\\") {
            output += next;
            index += 1;
            completeSequence();
          } else if (char === ESC && next === undefined) {
            this.state.pendingStringEscape = true;
          }
          continue;
        }
        output += char;
        if (
          (this.state.pendingKind === "osc" && char === BEL)
          || char === C1_ST
          || (char === ESC && next === "\\")
        ) {
          if (char === ESC && next === "\\") {
            output += next;
            index += 1;
          }
          completeSequence();
        } else if (char === ESC && next === undefined) {
          this.state.pendingStringEscape = true;
        }
        continue;
      }
      if (this.state.pendingKind === "escape") {
        this.state.pending += char;
        output += char;
        if (char === "[") {
          this.state.pendingKind = "csi";
        } else if (char === "]") {
          this.state.pendingKind = "osc";
        } else if (char === "P" || char === "X" || char === "^" || char === "_") {
          this.state.pendingKind = "string";
        } else if (!isEscIntermediate(char.charCodeAt(0))) {
          // Wait for intermediate bytes (e.g. ESC ( B); complete on the final byte.
          completeSequence();
        }
        continue;
      }
      if (this.state.pendingKind === "csi") {
        this.state.pending += char;
        output += char;
        if (isCsiFinal(char.charCodeAt(0))) completeSequence();
        continue;
      }
      if (char === ESC) {
        flushPlain();
        this.state.pending = char;
        this.state.pendingKind = "escape";
        output += char;
        continue;
      }
      if (char === C1_CSI) {
        flushPlain();
        this.state.pending = char;
        this.state.pendingKind = "csi";
        output += char;
        continue;
      }
      if (char === C1_OSC) {
        flushPlain();
        this.state.pending = char;
        this.state.pendingKind = "osc";
        output += char;
        continue;
      }
      if (char === C1_DCS || char === C1_SOS || char === C1_PM || char === C1_APC) {
        flushPlain();
        this.state.pending = char;
        this.state.pendingKind = "string";
        output += char;
        continue;
      }
      plain += char;
    }
    flushPlain();
    return output;
  }
}

/**
 * Keyword highlighting is injected into xterm writes, while a second terminal
 * keeps the pristine, unhighlighted buffer for rule changes and serialization.
 */
export class KeywordHighlighter implements IDisposable {
  readonly serializeAddon = new SerializeAddon();
  rebuildCount = 0;
  lastRebuildTimings: Record<string, number> = {};

  private readonly pristineTerm: HeadlessTerminalType;
  private readonly transformer = new KeywordHighlightTransformer();
  private readonly originalWrite: XTerm["write"];
  private readonly originalReset: XTerm["reset"];
  private readonly originalClear: XTerm["clear"];
  private readonly originalSerialize: SerializeAddon["serialize"];
  private readonly disposables: IDisposable[] = [];
  private rules: readonly RuntimeKeywordHighlightRule[] = [];
  private enabled = false;
  private disposed = false;
  private rebuilding = false;
  private pendingRulesChanged = false;
  private settlePromise: Promise<void> = Promise.resolve();
  private pristineSettled: Promise<void> = Promise.resolve();
  private pristineFlushPromise: Promise<void> | null = null;
  private activePristineFlush: PristineFlushState | null = null;
  private visibleSettled: Promise<void> = Promise.resolve();
  private queuedWrites: Array<{ data: string | Uint8Array; callback?: () => void }> = [];
  private hasPristineContent = false;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private catchUpSettled: Promise<void> = Promise.resolve();
  private resolveCatchUp: (() => void) | null = null;
  private settleVersion = 0;
  private resetGeneration = 0;
  private deferredPristineWrites: Array<string | Uint8Array> = [];
  private deferredPristineBytes = 0;
  private transformerNeedsRebuild = false;
  private visibleRendererWasPaused = false;
  private activePristineBytesRemaining = 0;
  private pristineBackpressureSettled: Promise<void> | null = null;
  private resolvePristineBackpressure: (() => void) | null = null;
  private nextBackpressureFlushBytes = MAX_DEFERRED_PRISTINE_BYTES;

  get pendingPristineBytes(): number {
    return this.deferredPristineBytes + this.activePristineBytesRemaining;
  }

  get isPristineBackpressured(): boolean {
    return this.pristineBackpressureSettled !== null;
  }

  constructor(
    private readonly term: XTerm,
    private readonly options: KeywordHighlighterOptions = {},
  ) {
    const HeadlessTerminal = (
      HeadlessXTerm as unknown as { Terminal?: typeof HeadlessTerminalType }
    ).Terminal;
    if (!HeadlessTerminal) throw new Error("Headless xterm is unavailable");
    this.pristineTerm = new HeadlessTerminal({
      cols: term.cols,
      rows: term.rows,
      scrollback: term.options.scrollback,
      allowProposedApi: true,
      convertEol: term.options.convertEol,
      windowsPty: term.options.windowsPty,
    });
    const pristineUnicodeGraphemes = new UnicodeGraphemesAddon();
    this.pristineTerm.loadAddon(pristineUnicodeGraphemes);
    this.pristineTerm.unicode.activeVersion = "15-graphemes";
    this.pristineTerm.loadAddon(this.serializeAddon);
    this.originalSerialize = this.serializeAddon.serialize.bind(this.serializeAddon);
    this.serializeAddon.serialize = (options) => {
      this.flushDeferredPristineSync();
      this.syncPristineOptions();
      return this.originalSerialize(options);
    };
    this.originalWrite = term.write.bind(term);
    this.originalReset = term.reset.bind(term);
    this.originalClear = term.clear.bind(term);
    (term as XTerm & { __netcattyKeywordHighlighter?: KeywordHighlighter })
      .__netcattyKeywordHighlighter = this;
    term.write = this.write;
    term.reset = this.reset;
    term.clear = this.clear;
    this.disposables.push(
      term.onResize(({ cols, rows }) => this.pristineTerm.resize(cols, rows)),
      term.buffer.onBufferChange(() => {
        if (term.buffer.active.type === "normal" && this.pendingRulesChanged) {
          this.scheduleRebuild();
        }
      }),
      term.registerLinkProvider({
        provideLinks: (bufferLineNumber, callback) => {
          callback(collectPristineOscLinksForLine(this.pristineTerm, this.term, bufferLineNumber));
        },
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
    this.transformer.setRules(this.rules, this.enabled);
    if (!this.hasPristineContent) {
      this.pendingRulesChanged = false;
      return;
    }
    this.pendingRulesChanged = true;
    if (this.catchUpTimer !== null || this.deferredPristineWrites.length > 0) {
      this.scheduleBulkCatchUp();
    } else {
      this.scheduleRebuild();
    }
  }

  async whenSettled(): Promise<void> {
    while (!this.disposed) {
      const version = this.settleVersion;
      const catchUp = this.catchUpSettled;
      const rebuild = this.settlePromise;
      await Promise.all([catchUp, rebuild]);
      if (
        version === this.settleVersion
        && this.catchUpTimer === null
        && !this.rebuilding
      ) return;
      await yieldToTerminalRenderer();
    }
  }

  async prepareForSerialization(): Promise<void> {
    await this.flushDeferredPristine();
    await this.pristineSettled;
  }

  async waitForPristineBackpressure(): Promise<void> {
    await (this.pristineBackpressureSettled ?? Promise.resolve());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.write = this.originalWrite;
    this.term.reset = this.originalReset;
    this.term.clear = this.originalClear;
    this.serializeAddon.serialize = this.originalSerialize;
    const patchedTerm = this.term as XTerm & { __netcattyKeywordHighlighter?: KeywordHighlighter };
    if (patchedTerm.__netcattyKeywordHighlighter === this) {
      delete patchedTerm.__netcattyKeywordHighlighter;
    }
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    this.resolveCatchUp?.();
    this.resolveCatchUp = null;
    this.resolvePristineBackpressure?.();
    this.resolvePristineBackpressure = null;
    this.pristineBackpressureSettled = null;
    for (const disposable of this.disposables) disposable.dispose();
    for (const write of this.queuedWrites.splice(0)) write.callback?.();
    this.pristineTerm.dispose();
  }

  private readonly write: XTerm["write"] = (data, callback) => {
    if (this.rebuilding) {
      this.queuedWrites.push({ data, ...(callback ? { callback } : {}) });
      return;
    }
    if (typeof data !== "string") {
      this.transformerNeedsRebuild = true;
      this.deferPristine(data);
      const visible = this.writeVisible(data);
      this.startPristineBackpressureIfNeeded();
      void visible.then(() => callback?.());
      this.scheduleBulkCatchUp();
      if (this.pendingRulesChanged) this.scheduleRebuild();
      if (this.options.canRebuild?.() === false) {
        this.transformer.resetParserState();
        this.transformerNeedsRebuild = false;
      }
      return;
    }
    const bypass = this.options.shouldBypassHighlight?.()
      ?? shouldDegradeTerminalKeywordHighlight(this.term, data);
    // eslint-disable-next-line no-control-regex -- terminal protocol bytes are intentional.
    const hasEraseInDisplay = /(?:\x1b\[|\x9b)[?\d;]*J/.test(data);
    const shouldDeferPristine = (
      bypass
      || this.deferredPristineWrites.length > 0
      || this.pristineFlushPromise !== null
    );
    const pristine = shouldDeferPristine || hasEraseInDisplay ? null : this.writePristine(data);
    if (shouldDeferPristine) this.deferPristine(data);
    this.startPristineBackpressureIfNeeded();
    const skipHotPathTransform = bypass || this.transformerNeedsRebuild;
    if (bypass) this.transformerNeedsRebuild = true;
    const transformed = skipHotPathTransform ? data : this.transformer.transform(data);
    const visible = this.writeVisible(transformed);
    const writeSettled = hasEraseInDisplay && !shouldDeferPristine
      ? visible.then(() => this.writePristine(data))
      : pristine
        ? Promise.all([pristine, visible]).then(() => undefined)
        : visible;
    void writeSettled.then(() => callback?.());
    const hasBareCarriageReturn = data.includes("\r") && /\r(?!\n)/.test(data);
    // eslint-disable-next-line no-control-regex -- terminal protocol bytes are intentional.
    const hasCursorRewriteControl = /\x08|\x1b[DEM78]|(?:\x1b\[|\x9b)[?\d:;<=>]*[ -/]*[ABCDEFGHJKSTXZ`abcdefsu]/.test(data);
    const mayRewriteExistingCells = hasBareCarriageReturn || hasCursorRewriteControl;
    if (skipHotPathTransform) {
      // Even with coloring disabled, drain the bounded pristine backlog after
      // bulk output becomes quiet so it cannot grow until serialization.
      this.scheduleBulkCatchUp();
    } else if (
      (mayRewriteExistingCells || this.transformer.takeMissedBoundaryMatch()) && this.enabled
    ) {
      this.transformerNeedsRebuild = true;
      this.scheduleBulkCatchUp();
    }
    if (this.pendingRulesChanged) this.scheduleRebuild();
    if (skipHotPathTransform && this.options.canRebuild?.() === false) {
      this.transformer.resetParserState();
      this.transformerNeedsRebuild = false;
    }
  };

  private readonly reset: XTerm["reset"] = () => {
    this.flushDeferredPristineSync();
    this.pendingRulesChanged = false;
    for (const write of this.queuedWrites.splice(0)) write.callback?.();
    this.hasPristineContent = false;
    if (this.catchUpTimer !== null) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.resolveCatchUp?.();
    this.resolveCatchUp = null;
    this.resolvePristineBackpressure?.();
    this.resolvePristineBackpressure = null;
    this.pristineBackpressureSettled = null;
    this.transformer.resetParserState();
    this.transformerNeedsRebuild = false;
    this.resetGeneration += 1;
    this.pristineTerm.reset();
    this.originalReset();
  };

  private readonly clear: XTerm["clear"] = () => {
    this.flushDeferredPristineSync();
    this.pristineTerm.clear();
    this.originalClear();
    this.transformer.resetParserState();
    this.transformerNeedsRebuild = false;
  };

  private syncPristineOptions(): void {
    this.pristineTerm.options.scrollback = this.term.options.scrollback;
  }

  syncScrollback(): void {
    this.flushDeferredPristineSync();
    this.syncPristineOptions();
  }

  /** Mirror Netcatty's local clear pre-scroll, which mutates xterm outside write(). */
  mirrorViewportScroll(lines: number): void {
    if (lines <= 0) return;
    this.flushDeferredPristineSync();
    const internal = this.pristineTerm as unknown as InternalScrollTerminal;
    const scroll = internal._core?.scroll;
    const eraseAttr = internal._core?._inputHandler?._eraseAttrData?.();
    if (typeof scroll !== "function" || eraseAttr === undefined) return;
    for (let index = 0; index < lines; index += 1) scroll.call(internal._core, eraseAttr, false);
  }

  mirrorScrollbackWipe(): void {
    this.flushDeferredPristineSync();
    const internal = this.pristineTerm as unknown as InternalScrollTerminal & {
      _core?: {
        buffer?: {
          lines?: { length: number; trimStart?(count: number): void };
          ybase?: number;
          ydisp?: number;
        };
      };
    };
    const buffer = internal._core?.buffer;
    const lines = buffer?.lines;
    const scrollbackSize = (lines?.length ?? 0) - this.pristineTerm.rows;
    if (!buffer || !lines?.trimStart || scrollbackSize <= 0) return;
    lines.trimStart(scrollbackSize);
    buffer.ybase = Math.max((buffer.ybase ?? 0) - scrollbackSize, 0);
    buffer.ydisp = Math.max((buffer.ydisp ?? 0) - scrollbackSize, 0);
  }

  private deferPristine(data: string | Uint8Array): void {
    if (data.length === 0) return;
    this.hasPristineContent = true;
    const stableData = typeof data === "string" ? data : data.slice();
    this.deferredPristineWrites.push(stableData);
    this.deferredPristineBytes += stableData.length;
    if (this.deferredPristineBytes >= this.nextBackpressureFlushBytes) {
      this.nextBackpressureFlushBytes = this.deferredPristineBytes + BACKPRESSURE_FLUSH_SLICE_BYTES;
      void this.flushDeferredPristine(true);
    }
  }

  private startPristineBackpressureIfNeeded(): void {
    if (
      this.pristineBackpressureSettled === null
      && this.pendingPristineBytes >= MAX_DEFERRED_PRISTINE_BYTES
    ) {
      this.pristineBackpressureSettled = new Promise<void>((resolve) => {
        this.resolvePristineBackpressure = resolve;
      });
      this.nextBackpressureFlushBytes = BACKPRESSURE_FLUSH_SLICE_BYTES;
      if (this.deferredPristineBytes > 0 && this.pristineFlushPromise === null) {
        void this.flushDeferredPristine(true);
      }
    }
  }

  private resolvePristineBackpressureIfReady(): void {
    if (
      this.pristineBackpressureSettled !== null
      && this.pendingPristineBytes <= RESUME_DEFERRED_PRISTINE_BYTES
    ) {
      this.resolvePristineBackpressure?.();
      this.resolvePristineBackpressure = null;
      this.pristineBackpressureSettled = null;
      this.nextBackpressureFlushBytes = MAX_DEFERRED_PRISTINE_BYTES;
    }
  }

  private flushDeferredPristine(sliced = false): Promise<void> {
    if (this.pristineFlushPromise) return this.pristineFlushPromise;
    const queued = this.deferredPristineWrites;
    this.deferredPristineWrites = [];
    this.deferredPristineBytes = 0;
    this.nextBackpressureFlushBytes = MAX_DEFERRED_PRISTINE_BYTES;
    if (queued.length === 0) {
      this.resolvePristineBackpressureIfReady();
      return this.pristineSettled;
    }
    this.syncPristineOptions();
    const shouldSlice = sliced && this.catchUpTimer !== null;
    this.pristineFlushPromise = (async () => {
      if (!shouldSlice) {
        const combined = queued.every((data) => typeof data === "string")
          ? (queued as string[]).join("")
          : null;
        if (combined !== null) {
          await new Promise<void>((resolve) => this.pristineTerm.write(combined, resolve));
        } else {
          await new Promise<void>((resolve) => {
            queued.forEach((data, index) => {
              this.pristineTerm.write(data, index === queued.length - 1 ? resolve : undefined);
            });
          });
        }
        return;
      }
      const chunks: Array<string | Uint8Array> = [];
      let stringBatch: string[] = [];
      let stringBatchLength = 0;
      const flushStringBatch = (): void => {
        if (stringBatchLength === 0) return;
        chunks.push(stringBatch.join(""));
        stringBatch = [];
        stringBatchLength = 0;
      };
      for (const data of queued) {
        if (typeof data !== "string") {
          flushStringBatch();
          for (let offset = 0; offset < data.length; offset += PRISTINE_WRITE_SLICE_BYTES) {
            const end = Math.min(data.length, offset + PRISTINE_WRITE_SLICE_BYTES);
            chunks.push(data.slice(offset, end));
          }
          continue;
        }
        let offset = 0;
        while (offset < data.length) {
          const remaining = PRISTINE_WRITE_SLICE_BYTES - stringBatchLength;
          const end = Math.min(data.length, offset + remaining);
          stringBatch.push(data.slice(offset, end));
          stringBatchLength += end - offset;
          offset = end;
          if (stringBatchLength === PRISTINE_WRITE_SLICE_BYTES) flushStringBatch();
        }
      }
      flushStringBatch();
      const state: PristineFlushState = { chunks, generation: 0, nextIndex: 0 };
      this.activePristineFlush = state;
      this.activePristineBytesRemaining = chunks.reduce((total, chunk) => total + chunk.length, 0);
      while (state.nextIndex < state.chunks.length) {
        const generation = state.generation;
        const chunk = state.chunks[state.nextIndex];
        state.nextIndex += 1;
        await new Promise<void>((resolve) => this.pristineTerm.write(chunk, resolve));
        this.activePristineBytesRemaining -= chunk.length;
        this.resolvePristineBackpressureIfReady();
        if (generation !== state.generation) return;
        await yieldToTerminalRenderer();
        if (generation !== state.generation) return;
      }
    })().finally(() => {
      this.activePristineFlush = null;
      this.activePristineBytesRemaining = 0;
      this.pristineFlushPromise = null;
      this.resolvePristineBackpressureIfReady();
      if (
        this.deferredPristineWrites.length > 0
        && (
          this.isPristineBackpressured
          || this.deferredPristineBytes >= this.nextBackpressureFlushBytes
        )
      ) {
        this.nextBackpressureFlushBytes = this.deferredPristineBytes + BACKPRESSURE_FLUSH_SLICE_BYTES;
        void this.flushDeferredPristine(true);
      }
    });
    this.pristineSettled = this.pristineFlushPromise;
    return this.pristineSettled;
  }

  private flushDeferredPristineSync(): void {
    const active = this.activePristineFlush;
    if (active) {
      active.generation += 1;
      while (active.nextIndex < active.chunks.length) {
        const chunk = active.chunks[active.nextIndex];
        this.pristineTerm.write(chunk);
        this.activePristineBytesRemaining -= chunk.length;
        active.nextIndex += 1;
      }
      this.activePristineFlush = null;
      this.activePristineBytesRemaining = 0;
    }
    const queued = this.deferredPristineWrites;
    this.deferredPristineWrites = [];
    this.deferredPristineBytes = 0;
    for (const data of queued) this.pristineTerm.write(data);
    const writeBuffer = (
      this.pristineTerm as unknown as {
        _core?: { _writeBuffer?: { flushSync(): void } };
      }
    )._core?._writeBuffer;
    writeBuffer?.flushSync();
    this.resolvePristineBackpressureIfReady();
  }

  private setVisibleRenderPaused(paused: boolean): void {
    const internal = this.term as unknown as InternalBrowserTerminal;
    const renderService = internal._core?._renderService;
    if (!renderService) return;
    if (paused) {
      this.visibleRendererWasPaused = renderService._isPaused === true;
      renderService._isPaused = true;
      return;
    }
    renderService._isPaused = this.visibleRendererWasPaused;
    if (!this.visibleRendererWasPaused) renderService.refreshRows(0, this.term.rows - 1);
  }

  private writePristine(data: string | Uint8Array): Promise<void> {
    this.hasPristineContent = this.hasPristineContent || data.length > 0;
    this.syncPristineOptions();
    this.pristineSettled = new Promise<void>((resolve) => {
      this.pristineTerm.write(data, resolve);
    });
    return this.pristineSettled;
  }

  private writeVisible(data: string | Uint8Array): Promise<void> {
    this.visibleSettled = new Promise<void>((resolve) => {
      this.originalWrite(data, resolve);
    });
    return this.visibleSettled;
  }

  private scheduleBulkCatchUp(): void {
    if (this.resolveCatchUp === null) {
      this.catchUpSettled = new Promise<void>((resolve) => {
        this.resolveCatchUp = resolve;
      });
    }
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = setTimeout(async () => {
      this.catchUpTimer = null;
      if (this.pristineFlushPromise !== null || this.isPristineBackpressured) {
        this.scheduleBulkCatchUp();
        return;
      }
      if (!this.disposed) {
        await this.flushDeferredPristine();
        if (this.enabled || this.pendingRulesChanged) {
          this.pendingRulesChanged = true;
          this.scheduleRebuild();
          await this.settlePromise;
        }
      }
      this.resolveCatchUp?.();
      this.resolveCatchUp = null;
    }, BULK_HIGHLIGHT_CATCH_UP_MS);
  }

  private scheduleRebuild(): void {
    if (this.options.canRebuild?.() === false) {
      // Inline images cannot survive a text replay. Leave the missed historical
      // colors pending, but resume inline coloring for subsequent ordinary text.
      this.transformer.resetParserState();
      this.transformerNeedsRebuild = false;
      return;
    }
    if (
      this.rebuilding
      || this.term.buffer.active.type === "alternate"
      || this.options.canRebuild?.() === false
    ) return;
    this.rebuilding = true;
    const priorSettle = this.settlePromise;
    this.settlePromise = priorSettle.then(async () => {
      while (!this.disposed && this.pendingRulesChanged) {
        if (
          this.term.buffer.active.type === "alternate"
          || this.options.canRebuild?.() === false
        ) break;
        this.pendingRulesChanged = false;
        await this.rebuild();
      }
      this.rebuilding = false;
      this.flushQueuedWrites();
    }, () => {
      this.rebuilding = false;
      this.flushQueuedWrites();
    });
    this.settleVersion += 1;
  }

  private async rebuild(): Promise<void> {
    const rebuildStarted = performance.now();
    await this.flushDeferredPristine();
    const pristineFlushedAt = performance.now();
    await Promise.all([this.pristineSettled, this.visibleSettled]);
    const generation = this.resetGeneration;
    this.syncPristineOptions();
    const snapshot = this.originalSerialize({
      scrollback: this.term.options.scrollback,
      excludeAltBuffer: true,
      excludeModes: false,
    });
    const serializedAt = performance.now();
    if (generation !== this.resetGeneration || this.disposed) return;
    const viewportOffset = Math.max(0, this.term.buffer.normal.baseY - this.term.buffer.normal.viewportY);
    const selection = this.term.getSelectionPosition();
    const selectionLength = selection
      ? (selection.end.y - selection.start.y) * this.term.cols
        + (selection.end.x - selection.start.x)
      : 0;
    this.rebuildCount += 1;
    this.transformer.resetParserState();
    this.transformerNeedsRebuild = false;
    // Snapshot lines are already committed buffer rows; treat trailing text as complete
    // so end-sensitive rules (`\b`, `$`, …) still color the final row.
    const snapshotChunks = splitStringByLineCount(snapshot, REBUILD_TRANSFORM_SLICE_LINES);
    const highlightedChunks: string[] = [];
    for (const chunk of snapshotChunks) {
      highlightedChunks.push(this.transformer.transform(chunk, { linesComplete: true }));
      await yieldToTerminalRenderer();
      if (generation !== this.resetGeneration || this.disposed) return;
    }
    const highlightedLength = highlightedChunks.reduce((total, chunk) => total + chunk.length, 0);
    const transformedAt = performance.now();
    if (generation !== this.resetGeneration || this.disposed) return;
    this.setVisibleRenderPaused(true);
    try {
      this.originalReset();
      for (let index = 0; index < highlightedChunks.length; index += 1) {
        await new Promise<void>((resolve) => this.originalWrite(highlightedChunks[index], resolve));
        if (generation !== this.resetGeneration || this.disposed) break;
        if (index < highlightedChunks.length - 1) await yieldToTerminalRenderer();
      }
      const writtenAt = performance.now();
      if (generation !== this.resetGeneration || this.disposed) {
        this.originalReset();
        this.pendingRulesChanged = this.hasPristineContent;
        return;
      }
      this.lastRebuildTimings = {
        pristine: pristineFlushedAt - rebuildStarted,
        serialize: serializedAt - pristineFlushedAt,
        transform: transformedAt - serializedAt,
        write: writtenAt - transformedAt,
        total: writtenAt - rebuildStarted,
        snapshotChars: snapshot.length,
        highlightedChars: highlightedLength,
      };
    } finally {
      this.setVisibleRenderPaused(false);
    }
    restoreTerminalLineTimestampAnchors(this.term);
    if (viewportOffset > 0) {
      this.term.scrollToLine(Math.max(0, this.term.buffer.normal.baseY - viewportOffset));
    }
    if (
      selection
      && selectionLength > 0
      && selection.start.y < this.term.buffer.normal.length
    ) {
      this.term.select(selection.start.x, selection.start.y, selectionLength);
    }
  }

  private flushQueuedWrites(): void {
    const queued = this.queuedWrites.splice(0);
    for (const { data, callback } of queued) {
      this.write(data, callback);
    }
    if (this.pendingRulesChanged) this.scheduleRebuild();
  }
}
