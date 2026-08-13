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
import {
  restoreTerminalLineTimestampLedger,
  snapshotTerminalLineTimestampLedger,
} from "./runtime/terminalLineTimestamps";
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
  normalScreenForeground: ForegroundState | null;
  previousWriteEndedWithHighSurrogate: boolean;
  normalSavedForeground: ForegroundState;
  alternateSavedForeground: ForegroundState;
  linePrefix: string;
  linePrefixTruncated: boolean;
  pending: string;
  pendingKind: "escape" | "csi" | "osc" | "string" | null;
  pendingStringEscape: boolean;
};

export type KeywordHighlighterOptions = {
  shouldBypassHighlight?: () => boolean;
  canRebuild?: () => boolean;
  shouldPreserveScrollback?: () => boolean;
  onRestoringSelectionChange?: (restoring: boolean) => void;
  onDidRebuild?: () => void;
};

type InternalScrollTerminal = {
  _core?: {
    scroll?: (eraseAttr: unknown, isWrapped: boolean) => void;
    _inputHandler?: { _eraseAttrData?: () => unknown };
    buffer?: { scrollTop?: number; scrollBottom?: number };
  };
};

type InternalBrowserTerminal = {
  _core?: {
    _bufferService?: { buffer?: InternalBrowserBuffer };
    _inputHandler?: {
      _parser?: { currentState?: number; precedingJoinState?: number };
    };
    _charsetService?: {
      glevel: number;
      _charsets: unknown[];
      setgCharset(index: number, charset: unknown): void;
      setgLevel(level: number): void;
    };
    _renderService?: {
      _isPaused?: boolean;
      refreshRows(start: number, end: number): void;
    };
    coreService?: {
      modes?: Record<string, unknown>;
      decPrivateModes?: Record<string, unknown>;
      kittyKeyboard?: Record<string, unknown>;
    };
    mouseStateService?: {
      activeProtocol: string;
      activeEncoding: string;
    };
    _selectionService?: InternalSelectionService;
  };
};

type InternalSelectionService = {
  _activeSelectionMode?: number;
  _model?: {
    selectionStart?: [number, number];
    selectionEnd?: [number, number];
    selectionStartLength?: number;
  };
  reset?(): void;
  refresh?(isLinuxMouseSelection?: boolean): void;
  _onSelectionChange?: { fire(): void };
};

type InternalBrowserBuffer = {
  x?: number;
  y?: number;
  tabs?: Record<string, boolean>;
  savedX?: number;
  savedY?: number;
  savedCurAttrData?: { clone?(): unknown };
  savedCharset?: unknown;
  savedCharsets?: unknown[];
  savedGlevel?: number;
  savedOriginMode?: boolean;
  savedWraparoundMode?: boolean;
};

type InternalAttributeData = {
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  getFgColor(): number;
};

const foregroundFromAttribute = (attribute: unknown): ForegroundState => {
  const value = attribute as Partial<InternalAttributeData> | undefined;
  if (value?.isFgDefault?.()) return DEFAULT_FOREGROUND;
  if (value?.isFgRGB?.()) {
    const color = value.getFgColor?.() ?? 0;
    return {
      kind: "rgb",
      red: color >>> 16 & 0xff,
      green: color >>> 8 & 0xff,
      blue: color & 0xff,
    };
  }
  if (value?.isFgPalette?.()) {
    const index = value.getFgColor?.() ?? 0;
    return index <= 15
      ? { kind: "ansi", code: index < 8 ? 30 + index : 90 + index - 8 }
      : { kind: "palette", index };
  }
  return DEFAULT_FOREGROUND;
};

const snapshotSavedCursorState = (buffer: InternalBrowserBuffer | undefined) => buffer ? {
  x: buffer.x,
  y: buffer.y,
  tabs: buffer.tabs ? { ...buffer.tabs } : undefined,
  savedX: buffer.savedX,
  savedY: buffer.savedY,
  savedCurAttrData: buffer.savedCurAttrData?.clone?.() ?? buffer.savedCurAttrData,
  savedCharset: buffer.savedCharset,
  savedCharsets: buffer.savedCharsets ? [...buffer.savedCharsets] : undefined,
  savedGlevel: buffer.savedGlevel,
  savedOriginMode: buffer.savedOriginMode,
  savedWraparoundMode: buffer.savedWraparoundMode,
} : null;

const restoreSavedCursorState = (
  buffer: InternalBrowserBuffer,
  state: NonNullable<ReturnType<typeof snapshotSavedCursorState>>,
): void => {
  for (const [key, value] of Object.entries(state)) {
    if (value !== undefined) (buffer as Record<string, unknown>)[key] = value;
  }
};

const snapshotParserJoinState = (term: XTerm): number | undefined => (
  (term as unknown as InternalBrowserTerminal)._core?._inputHandler?._parser?.precedingJoinState
);

const restoreParserJoinState = (term: XTerm, state: number | undefined): void => {
  if (state === undefined) return;
  const parser = (term as unknown as InternalBrowserTerminal)._core?._inputHandler?._parser;
  if (parser) parser.precedingJoinState = state;
};

const isTerminalParserGrounded = (term: XTerm): boolean => {
  const parser = (term as unknown as InternalBrowserTerminal)._core?._inputHandler?._parser;
  return parser?.currentState === undefined || parser.currentState === 0;
};

const cloneTerminalProtocolState = (term: XTerm) => {
  const core = (term as unknown as InternalBrowserTerminal)._core;
  const coreService = core?.coreService;
  const mouseStateService = core?.mouseStateService;
  return {
    modes: coreService?.modes ? { ...coreService.modes } : null,
    decPrivateModes: coreService?.decPrivateModes ? { ...coreService.decPrivateModes } : null,
    kittyKeyboard: coreService?.kittyKeyboard
      ? structuredClone(coreService.kittyKeyboard)
      : null,
    mouseProtocol: mouseStateService?.activeProtocol,
    mouseEncoding: mouseStateService?.activeEncoding,
  };
};

const restoreTerminalProtocolState = (
  term: XTerm,
  state: ReturnType<typeof cloneTerminalProtocolState>,
): void => {
  const core = (term as unknown as InternalBrowserTerminal)._core;
  const coreService = core?.coreService;
  if (state.modes && coreService?.modes) Object.assign(coreService.modes, state.modes);
  if (state.decPrivateModes && coreService?.decPrivateModes) {
    Object.assign(coreService.decPrivateModes, state.decPrivateModes);
  }
  if (state.kittyKeyboard && coreService?.kittyKeyboard) {
    Object.assign(coreService.kittyKeyboard, structuredClone(state.kittyKeyboard));
  }
  const mouseStateService = core?.mouseStateService;
  if (mouseStateService && state.mouseProtocol !== undefined) {
    mouseStateService.activeProtocol = state.mouseProtocol;
  }
  if (mouseStateService && state.mouseEncoding !== undefined) {
    mouseStateService.activeEncoding = state.mouseEncoding;
  }
};

const snapshotSelectionState = (term: XTerm) => {
  const service = (term as unknown as InternalBrowserTerminal)._core?._selectionService;
  const start = service?._model?.selectionStart;
  const end = service?._model?.selectionEnd;
  if (!service || !start) return null;
  return {
    mode: service._activeSelectionMode,
    start: [...start] as [number, number],
    end: end ? [...end] as [number, number] : undefined,
    startLength: service._model?.selectionStartLength ?? 0,
  };
};

const restoreSelectionState = (
  term: XTerm,
  state: NonNullable<ReturnType<typeof snapshotSelectionState>>,
): void => {
  const service = (term as unknown as InternalBrowserTerminal)._core?._selectionService;
  const model = service?._model;
  if (!service || !model) return;
  service._activeSelectionMode = state.mode;
  model.selectionStart = [...state.start];
  model.selectionEnd = state.end ? [...state.end] : undefined;
  model.selectionStartLength = state.startLength;
  service.refresh?.();
  service._onSelectionChange?.fire();
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
const CAN = "\x18";
const SUB = "\x1a";
const MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS = 4_096;
const MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE = 256;
const BULK_HIGHLIGHT_CATCH_UP_MS = 600;
const MAX_DEFERRED_PRISTINE_BYTES = 8 * 1024 * 1024;
const RESUME_DEFERRED_PRISTINE_BYTES = 4 * 1024 * 1024;
const PRISTINE_WRITE_SLICE_BYTES = 32 * 1024;
const REBUILD_SERIALIZE_SLICE_LINES = 2_048;
const REBUILD_TRANSFORM_SLICE_LINES = 2_048;
const BACKPRESSURE_FLUSH_SLICE_BYTES = 256 * 1024;
const MAX_LINE_PREFIX_CHARS = 4_096;

const DEFAULT_FOREGROUND: ForegroundState = Object.freeze({ kind: "default" });

const createParserState = (): ParserState => ({
  alternateScreen: false,
  foreground: DEFAULT_FOREGROUND,
  normalScreenForeground: null,
  previousWriteEndedWithHighSurrogate: false,
  normalSavedForeground: DEFAULT_FOREGROUND,
  alternateSavedForeground: DEFAULT_FOREGROUND,
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

const serializeTerminalModes = (term: HeadlessTerminalType): string => {
  const modes = term.modes;
  let result = "";
  if (modes.applicationCursorKeysMode) result += "\x1b[?1h";
  if (modes.applicationKeypadMode) result += "\x1b[?66h";
  if (modes.bracketedPasteMode) result += "\x1b[?2004h";
  if (modes.insertMode) result += "\x1b[4h";
  if (modes.originMode) result += "\x1b[?6h";
  if (modes.reverseWraparoundMode) result += "\x1b[?45h";
  if (modes.sendFocusMode) result += "\x1b[?1004h";
  if (!modes.wraparoundMode) result += "\x1b[?7l";
  if (!modes.showCursor) result += "\x1b[?25l";
  switch (modes.mouseTrackingMode) {
    case "x10": result += "\x1b[?9h"; break;
    case "vt200": result += "\x1b[?1000h"; break;
    case "drag": result += "\x1b[?1002h"; break;
    case "any": result += "\x1b[?1003h"; break;
    default: break;
  }
  const internal = term as unknown as InternalScrollTerminal;
  const scrollTop = internal._core?.buffer?.scrollTop ?? 0;
  const scrollBottom = internal._core?.buffer?.scrollBottom ?? term.rows - 1;
  if (scrollTop !== 0 || scrollBottom !== term.rows - 1) {
    result += `\x1b[${scrollTop + 1};${scrollBottom + 1}r`;
  }
  return result;
};

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

/** ESC intermediates are 0x20-0x2F; the final byte is 0x30-0x7E (ECMA-48). */
const isEscIntermediate = (code: number): boolean => code >= 0x20 && code <= 0x2f;

const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const createGraphemeRangeSnapper = (text: string) => {
  const trailingCodeUnit = text.charCodeAt(text.length - 1);
  const hasIncompleteTrailingSurrogate = trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff;
  // ASCII boundaries are always grapheme boundaries. Keep the common log path
  // allocation-free and segment a non-ASCII logical line only once.
  let asciiOnly = true;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x7f) continue;
    asciiOnly = false;
    break;
  }
  if (asciiOnly) {
    return (start: number, end: number) => (
      start >= 0 && end <= text.length && start < end ? { start, end } : null
    );
  }
  if (graphemeSegmenter) {
    const starts = new Uint32Array(text.length);
    const ends = new Uint32Array(text.length + 1);
    for (const segment of graphemeSegmenter.segment(text)) {
      const segmentStart = segment.index;
      const segmentEnd = segmentStart + segment.segment.length;
      starts.fill(segmentStart, segmentStart, segmentEnd);
      ends.fill(segmentEnd, segmentStart + 1, segmentEnd + 1);
    }
    return (start: number, end: number): { start: number; end: number } | null => {
      if (start < 0 || end > text.length || start >= end) return null;
      if (hasIncompleteTrailingSurrogate && end === text.length) return null;
      const from = starts[start];
      const to = ends[end];
      return from < to ? { start: from, end: to } : null;
    };
  }
  return (start: number, end: number): { start: number; end: number } | null => {
    let from = start;
    let to = end;
    if (from < 0 || to > text.length || from >= to) return null;
    if (hasIncompleteTrailingSurrogate && to === text.length) return null;
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
    return from < to ? { start: from, end: to } : null;
  };
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
  if (visible.buffer.active.type !== "normal") return undefined;
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

const isPrivateModeChange = (sequence: string, mode: string, set: boolean): boolean => {
  if (!sequence.endsWith(set ? "h" : "l")) return false;
  const introducerLength = sequence.startsWith(C1_CSI) ? 1 : 2;
  const body = sequence.slice(introducerLength, -1);
  return body.startsWith("?") && body.slice(1).split(";").includes(mode);
};

const isSoftReset = (sequence: string): boolean => {
  if (!sequence.endsWith("p")) return false;
  const introducerLength = sequence.startsWith(C1_CSI) ? 1 : 2;
  return sequence.slice(introducerLength, -1) === "!";
};

const isCursorSave = (sequence: string, kind: ParserState["pendingKind"]): boolean => (
  (kind === "escape" && sequence === `${ESC}7`)
  || (kind === "csi" && (
    sequence === `${ESC}[s`
    || sequence === `${C1_CSI}s`
    || isPrivateModeChange(sequence, "1048", true)
    || isPrivateModeChange(sequence, "1049", true)
  ))
);

const isCursorRestore = (sequence: string, kind: ParserState["pendingKind"]): boolean => (
  (kind === "escape" && sequence === `${ESC}8`)
  || (kind === "csi" && (
    sequence === `${ESC}[u`
    || sequence === `${C1_CSI}u`
    || isPrivateModeChange(sequence, "1048", false)
    || isPrivateModeChange(sequence, "1049", false)
  ))
);

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
        // Match settings editors (`gi`). Grapheme-safe ranges are applied below.
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

  restoreSavedForegrounds(normal: ForegroundState, alternate: ForegroundState): void {
    this.state.normalSavedForeground = normal;
    this.state.alternateSavedForeground = alternate;
  }

  /** True when a match spanned a prior write and could not be colored inline. */
  takeMissedBoundaryMatch(): boolean {
    const missed = this.missedBoundaryMatch;
    this.missedBoundaryMatch = false;
    return missed;
  }

  transform(input: string, options: { bypass?: boolean; linesComplete?: boolean } = {}): string {
    if (!input) return input;
    const startsWithSplitLowSurrogate = (
      this.state.previousWriteEndedWithHighSurrogate
      && input.charCodeAt(0) >= 0xdc00
      && input.charCodeAt(0) <= 0xdfff
    );
    const finalCodeUnit = input.charCodeAt(input.length - 1);
    this.state.previousWriteEndedWithHighSurrogate = (
      finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff
    );
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
        const snapRange = createGraphemeRangeSnapper(searchable);
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
            const snapped = snapRange(start, start + length);
            if (!snapped) return;
            if (snapped.start < offset) {
              // The full match or grapheme begins in already-emitted text. SGR
              // cannot be inserted there without splitting a displayed glyph.
              if (snapped.end > offset) this.missedBoundaryMatch = true;
              return;
            }
            // End anchors / word boundaries / lookarounds treat the write chunk as
            // end-of-string. Defer those matches until the logical line completes.
            if (
              !lineComplete
              && pattern.endSensitive
              && snapped.end >= searchable.length
            ) {
              this.missedBoundaryMatch = true;
              return;
            }
            const currentStart = snapped.start - offset;
            if (startsWithSplitLowSurrogate && currentStart === 0) {
              // xterm joins this low surrogate to a high surrogate buffered by
              // its decoder from the prior write. Inserting SGR here would
              // split the pair, so let the quiet catch-up color it atomically.
              this.missedBoundaryMatch = true;
              return;
            }
            matches.push({
              start: currentStart,
              end: snapped.end - offset,
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
      if (isCursorSave(sequence, kind)) {
        if (this.state.alternateScreen) {
          this.state.alternateSavedForeground = this.state.foreground;
        } else {
          this.state.normalSavedForeground = this.state.foreground;
        }
      }
      if (kind === "csi") {
        this.state.foreground = updateForeground(this.state.foreground, sequence);
        if (isSoftReset(sequence)) {
          this.state.foreground = DEFAULT_FOREGROUND;
          if (this.state.alternateScreen) {
            this.state.alternateSavedForeground = DEFAULT_FOREGROUND;
          } else {
            this.state.normalSavedForeground = DEFAULT_FOREGROUND;
          }
          if (!this.state.alternateScreen) this.state.normalScreenForeground = null;
        }
        const wasAlternate = this.state.alternateScreen;
        const nextAlternate = parseAlternateScreen(sequence, wasAlternate);
        if (!wasAlternate && nextAlternate && isPrivateModeChange(sequence, "1049", true)) {
          this.state.normalScreenForeground = this.state.foreground;
        } else if (wasAlternate && !nextAlternate) {
          if (
            isPrivateModeChange(sequence, "1049", false)
            && this.state.normalScreenForeground
          ) {
            this.state.foreground = this.state.normalScreenForeground;
          }
          this.state.normalScreenForeground = null;
        }
        this.state.alternateScreen = nextAlternate;
      } else if (kind === "escape" && sequence === `${ESC}c`) {
        this.state.foreground = DEFAULT_FOREGROUND;
        this.state.alternateScreen = false;
        this.state.normalScreenForeground = null;
        this.state.normalSavedForeground = DEFAULT_FOREGROUND;
        this.state.alternateSavedForeground = DEFAULT_FOREGROUND;
        this.state.linePrefix = "";
        this.state.linePrefixTruncated = false;
      }
      if (isCursorRestore(sequence, kind)) {
        this.state.foreground = this.state.alternateScreen
          ? this.state.alternateSavedForeground
          : this.state.normalSavedForeground;
      }
    };

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      const next = input[index + 1];
      if (this.state.pendingKind === "osc" || this.state.pendingKind === "string") {
        if (char === CAN || char === SUB) {
          output += char;
          completeSequence();
          continue;
        }
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
  private queuedOperations: Array<
    | { kind: "write"; data: string | Uint8Array; callback?: () => void }
    | { kind: "mutation"; run: () => Promise<void> | void }
  > = [];
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
  private deferredResize: { cols: number; rows: number } | null = null;
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
    this.pristineTerm.parser.registerCsiHandler({ final: "J" }, (params) => (
      this.options.shouldPreserveScrollback?.() === true
      && params.length > 0
      && params[0] === 3
    ));
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
      term.onResize(({ cols, rows }) => {
        if (
          this.deferredPristineWrites.length > 0
          || this.pristineFlushPromise !== null
        ) {
          this.deferredResize = { cols, rows };
          return;
        }
        this.pristineTerm.resize(cols, rows);
      }),
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
    for (const operation of this.queuedOperations.splice(0)) {
      if (operation.kind === "write") operation.callback?.();
    }
    this.pristineTerm.dispose();
  }

  private readonly write: XTerm["write"] = (data, callback) => {
    if (this.rebuilding) {
      this.queuedOperations.push({ kind: "write", data, ...(callback ? { callback } : {}) });
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
        // The visible terminal keeps its parser state while images prevent a
        // text replay, so the transformer must keep tracking that same stream.
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
    const transformed = skipHotPathTransform
      ? this.options.canRebuild?.() === false
        ? this.transformer.transform(data, { bypass: true })
        : data
      : this.transformer.transform(data);
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
    if (this.pendingRulesChanged) {
      void visible.then(() => this.scheduleRebuild());
    }
    if (skipHotPathTransform && this.options.canRebuild?.() === false) {
      this.transformerNeedsRebuild = false;
    }
  };

  private readonly reset: XTerm["reset"] = () => {
    this.flushDeferredPristineSync();
    this.pendingRulesChanged = false;
    for (const operation of this.queuedOperations.splice(0)) {
      if (operation.kind === "write") operation.callback?.();
    }
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
    this.transformerNeedsRebuild = this.hasPristineContent;
    if (this.transformerNeedsRebuild && this.enabled) this.scheduleBulkCatchUp();
  };

  private syncPristineOptions(): void {
    this.pristineTerm.options.scrollback = this.term.options.scrollback;
  }

  syncScrollback(): void {
    this.flushDeferredPristineSync();
    this.syncPristineOptions();
  }

  /** Queue direct xterm mutations so they cannot be split across a history replay. */
  deferMutationDuringRebuild(run: () => Promise<void> | void): boolean {
    if (!this.rebuilding) return false;
    this.queuedOperations.push({ kind: "mutation", run });
    return true;
  }

  /** Mirror Netcatty's local clear pre-scroll, which mutates xterm outside write(). */
  mirrorViewportScroll(lines: number): void {
    if (lines <= 0) return;
    this.flushDeferredPristineSync();
    const internal = this.pristineTerm as unknown as InternalScrollTerminal;
    const scroll = internal._core?.scroll;
    const eraseAttr = internal._core?._inputHandler?._eraseAttrData?.();
    if (typeof scroll !== "function" || eraseAttr === undefined) return;
    const buffer = internal._core?.buffer as {
      scrollTop?: number;
      scrollBottom?: number;
    } | undefined;
    const previousScrollTop = buffer?.scrollTop;
    const previousScrollBottom = buffer?.scrollBottom;
    try {
      if (buffer) {
        buffer.scrollTop = 0;
        buffer.scrollBottom = this.pristineTerm.rows - 1;
      }
      for (let index = 0; index < lines; index += 1) scroll.call(internal._core, eraseAttr, false);
    } finally {
      if (buffer && previousScrollTop !== undefined && previousScrollBottom !== undefined) {
        buffer.scrollTop = previousScrollTop;
        buffer.scrollBottom = previousScrollBottom;
      }
    }
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
    const queuedBytes = queued.reduce((total, data) => total + data.length, 0);
    this.activePristineBytesRemaining = queuedBytes;
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
        this.activePristineBytesRemaining = 0;
        this.resolvePristineBackpressureIfReady();
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
      if (this.deferredPristineWrites.length === 0 && this.deferredResize) {
        const { cols, rows } = this.deferredResize;
        this.deferredResize = null;
        this.pristineTerm.resize(cols, rows);
      }
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
      this.transformerNeedsRebuild = false;
      return;
    }
    if (
      this.rebuilding
      || this.term.buffer.active.type === "alternate"
      || !isTerminalParserGrounded(this.term)
      || this.options.canRebuild?.() === false
    ) return;
    this.rebuilding = true;
    const priorSettle = this.settlePromise;
    this.settlePromise = priorSettle.then(async () => {
      while (!this.disposed && this.pendingRulesChanged) {
        // write() returns before xterm's parser has necessarily consumed the
        // queued bytes. Re-check after that queue settles so a rule change can
        // never reset the terminal halfway through CSI/OSC/DCS parsing.
        await Promise.all([this.visibleSettled, this.pristineSettled]);
        if (
          this.term.buffer.active.type === "alternate"
          || !isTerminalParserGrounded(this.term)
          || this.options.canRebuild?.() === false
        ) break;
        this.pendingRulesChanged = false;
        await this.rebuild();
      }
      this.rebuilding = false;
      await this.flushQueuedWrites();
    }, () => {
      this.rebuilding = false;
      void this.flushQueuedWrites();
    });
    this.settleVersion += 1;
  }

  private async serializePristineSnapshotSliced(generation: number): Promise<string | null> {
    const bufferLength = this.pristineTerm.buffer.normal.length;
    const retainedLines = Math.max(
      this.pristineTerm.rows,
      this.term.options.scrollback + this.pristineTerm.rows,
    );
    const startLine = Math.max(0, bufferLength - retainedLines);
    const chunks: string[] = [];
    for (let start = startLine; start < bufferLength; start += REBUILD_SERIALIZE_SLICE_LINES) {
      if (generation !== this.resetGeneration || this.disposed) return null;
      const end = Math.min(bufferLength - 1, start + REBUILD_SERIALIZE_SLICE_LINES - 1);
      if (chunks.length > 0) chunks.push("\x1b[0m");
      chunks.push(this.originalSerialize({
        range: { start, end },
        excludeAltBuffer: true,
        excludeModes: true,
      }));
      if (end < bufferLength - 1) {
        const nextLine = this.pristineTerm.buffer.normal.getLine(end + 1);
        if (!nextLine?.isWrapped) chunks.push("\r\n");
      }
      await yieldToTerminalRenderer();
    }
    chunks.push(serializeTerminalModes(this.pristineTerm));
    return chunks.join("");
  }

  private async rebuild(): Promise<void> {
    const rebuildStarted = performance.now();
    await this.flushDeferredPristine();
    const pristineFlushedAt = performance.now();
    await Promise.all([this.pristineSettled, this.visibleSettled]);
    const generation = this.resetGeneration;
    this.syncPristineOptions();
    const snapshot = await this.serializePristineSnapshotSliced(generation);
    const serializedAt = performance.now();
    if (snapshot === null || generation !== this.resetGeneration || this.disposed) return;
    const viewportOffset = Math.max(0, this.term.buffer.normal.baseY - this.term.buffer.normal.viewportY);
    const selectionState = snapshotSelectionState(this.term);
    const timestampLedger = snapshotTerminalLineTimestampLedger(this.term);
    const internalBuffers = (this.term as unknown as {
      _core?: { _bufferService?: { buffers?: {
        normal?: InternalBrowserBuffer;
        alt?: InternalBrowserBuffer;
      } } };
    })._core?._bufferService?.buffers;
    const savedForegrounds = {
      normal: foregroundFromAttribute(internalBuffers?.normal?.savedCurAttrData),
      alternate: foregroundFromAttribute(internalBuffers?.alt?.savedCurAttrData),
    };
    const savedBufferStates = {
      normal: snapshotSavedCursorState(internalBuffers?.normal),
      alternate: snapshotSavedCursorState(internalBuffers?.alt),
    };
    const parserJoinState = snapshotParserJoinState(this.term);
    const charsetService = (this.term as unknown as InternalBrowserTerminal)._core?._charsetService;
    const charsetState = charsetService ? {
      glevel: charsetService.glevel,
      charsets: [...charsetService._charsets],
    } : null;
    const protocolState = cloneTerminalProtocolState(this.term);
    this.rebuildCount += 1;
    this.transformer.resetParserState();
    this.transformer.restoreSavedForegrounds(
      savedForegrounds.normal,
      savedForegrounds.alternate,
    );
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
      const rebuiltBuffers = (this.term as unknown as {
        _core?: { _bufferService?: { buffers?: {
          normal?: InternalBrowserBuffer;
          alt?: InternalBrowserBuffer;
        } } };
      })._core?._bufferService?.buffers;
      if (savedBufferStates.normal && rebuiltBuffers?.normal) {
        restoreSavedCursorState(rebuiltBuffers.normal, savedBufferStates.normal);
      }
      if (savedBufferStates.alternate && rebuiltBuffers?.alt) {
        restoreSavedCursorState(rebuiltBuffers.alt, savedBufferStates.alternate);
      }
      restoreParserJoinState(this.term, parserJoinState);
      const rebuiltCharsetService = (this.term as unknown as InternalBrowserTerminal)
        ._core?._charsetService;
      if (charsetState && rebuiltCharsetService) {
        charsetState.charsets.forEach((charset, index) => {
          rebuiltCharsetService.setgCharset(index, charset);
        });
        rebuiltCharsetService.setgLevel(charsetState.glevel);
      }
      restoreTerminalProtocolState(this.term, protocolState);
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
    restoreTerminalLineTimestampLedger(this.term, timestampLedger);
    if (viewportOffset > 0) {
      this.term.scrollToLine(Math.max(0, this.term.buffer.normal.baseY - viewportOffset));
    }
    if (selectionState && selectionState.start[1] < this.term.buffer.normal.length) {
      this.options.onRestoringSelectionChange?.(true);
      try {
        restoreSelectionState(this.term, selectionState);
      } finally {
        this.options.onRestoringSelectionChange?.(false);
      }
    }
    this.options.onDidRebuild?.();
  }

  private async flushQueuedWrites(): Promise<void> {
    const queued = this.queuedOperations.splice(0);
    for (const operation of queued) {
      if (operation.kind === "mutation") {
        await operation.run();
      } else {
        await new Promise<void>((resolve) => {
          this.write(operation.data, () => {
            operation.callback?.();
            resolve();
          });
        });
      }
    }
    if (this.pendingRulesChanged) this.scheduleRebuild();
  }
}
