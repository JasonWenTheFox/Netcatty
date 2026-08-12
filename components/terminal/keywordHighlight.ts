import { SerializeAddon } from "@xterm/addon-serialize";
import HeadlessXTerm from "@xterm/headless";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { Terminal as HeadlessTerminalType } from "@xterm/headless";
import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";

import { isSafePluginDecorationPattern } from "../../domain/pluginTerminalProviders";
import { checkRegexSafetyPattern } from "../../lib/regexSafety";
import type { KeywordHighlightRule } from "../../types";
import { compileRe2RangeMatcher, forEachNonEmptyRegexMatch } from "./keywordHighlightRegex";
import { restoreTerminalLineTimestampAnchors } from "./runtime/terminalLineTimestamps";
import { shouldDegradeTerminalKeywordHighlight } from "./runtime/terminalOutputPressure";

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
};

export type KeywordHighlighterOptions = {
  shouldBypassHighlight?: () => boolean;
  canRebuild?: () => boolean;
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
const MAX_LINE_PREFIX_CHARS = 4_096;

const DEFAULT_FOREGROUND: ForegroundState = Object.freeze({ kind: "default" });

const createParserState = (): ParserState => ({
  alternateScreen: false,
  foreground: DEFAULT_FOREGROUND,
  linePrefix: "",
  linePrefixTruncated: false,
  pending: "",
  pendingKind: null,
});

const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;

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
            visit(text, onMatch) {
              matcher(text.slice(0, MAX_PLUGIN_HIGHLIGHT_SCAN_CHARS), onMatch);
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
          colorSequence,
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

export class KeywordHighlightTransformer {
  private compiledPatterns: CompiledPattern[] = [];
  private state = createParserState();

  setRules(rules: readonly RuntimeKeywordHighlightRule[], enabled: boolean): void {
    this.compiledPatterns = compilePatterns(rules, enabled);
  }

  resetParserState(): void {
    this.state = createParserState();
  }

  transform(input: string, options: { bypass?: boolean } = {}): string {
    if (!input) return input;
    let output = "";
    let plain = "";
    let pluginMatchCount = 0;
    const flushPlain = (): void => {
      if (!plain) return;
      const text = plain;
      plain = "";
      const highlightLine = (line: string, prefix: string): string => {
        if (options.bypass || this.state.alternateScreen || this.compiledPatterns.length === 0) {
          return line;
        }
        const searchable = prefix + line;
        const offset = prefix.length;
        const matches: HighlightMatch[] = [];
        for (const pattern of this.compiledPatterns) {
          if (pattern.plugin && pluginMatchCount >= MAX_PLUGIN_HIGHLIGHT_MATCHES_PER_WRITE) continue;
          pattern.visit(searchable, (start, length) => {
            if (length <= 0 || start < offset) return;
            matches.push({
              start: start - offset,
              end: start + length - offset,
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
        const prefix = `${this.state.linePrefixTruncated ? "\0" : ""}${this.state.linePrefix}`;
        output += highlightLine(part, prefix);
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
        } else {
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

  private readonly pristineTerm: HeadlessTerminalType;
  private readonly transformer = new KeywordHighlightTransformer();
  private readonly originalWrite: XTerm["write"];
  private readonly originalReset: XTerm["reset"];
  private readonly disposables: IDisposable[] = [];
  private rules: readonly RuntimeKeywordHighlightRule[] = [];
  private enabled = false;
  private disposed = false;
  private rebuilding = false;
  private pendingRulesChanged = false;
  private settlePromise: Promise<void> = Promise.resolve();
  private pristineSettled: Promise<void> = Promise.resolve();
  private visibleSettled: Promise<void> = Promise.resolve();
  private queuedWrites: Array<{ data: string | Uint8Array; callback?: () => void }> = [];
  private hasPristineContent = false;
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private resetGeneration = 0;

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
    this.originalWrite = term.write.bind(term);
    this.originalReset = term.reset.bind(term);
    term.write = this.write;
    term.reset = this.reset;
    this.disposables.push(
      term.onResize(({ cols, rows }) => this.pristineTerm.resize(cols, rows)),
      term.buffer.onBufferChange(() => {
        if (term.buffer.active.type === "normal" && this.pendingRulesChanged) {
          this.scheduleRebuild();
        }
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
    this.scheduleRebuild();
  }

  whenSettled(): Promise<void> {
    return this.settlePromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.write = this.originalWrite;
    this.term.reset = this.originalReset;
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
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
      const pristine = this.writePristine(data);
      const visible = this.writeVisible(data);
      void Promise.all([pristine, visible]).then(() => callback?.());
      if (this.enabled) this.scheduleBulkCatchUp();
      if (this.pendingRulesChanged) this.scheduleRebuild();
      return;
    }
    const pristine = this.writePristine(data);
    const bypass = this.options.shouldBypassHighlight?.()
      ?? shouldDegradeTerminalKeywordHighlight(this.term, data);
    const transformed = this.transformer.transform(data, {
      bypass,
    });
    const visible = this.writeVisible(transformed);
    void Promise.all([pristine, visible]).then(() => callback?.());
    if (bypass && this.enabled) this.scheduleBulkCatchUp();
    if (this.pendingRulesChanged) this.scheduleRebuild();
  };

  private readonly reset: XTerm["reset"] = () => {
    this.pendingRulesChanged = false;
    for (const write of this.queuedWrites.splice(0)) write.callback?.();
    this.hasPristineContent = false;
    if (this.catchUpTimer !== null) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.transformer.resetParserState();
    this.resetGeneration += 1;
    this.pristineTerm.reset();
    this.originalReset();
  };

  private writePristine(data: string | Uint8Array): Promise<void> {
    this.hasPristineContent = this.hasPristineContent || data.length > 0;
    this.pristineTerm.options.scrollback = this.term.options.scrollback;
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
    if (this.catchUpTimer !== null) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      if (this.disposed || !this.enabled) return;
      this.pendingRulesChanged = true;
      this.scheduleRebuild();
    }, BULK_HIGHLIGHT_CATCH_UP_MS);
  }

  private scheduleRebuild(): void {
    if (
      this.rebuilding
      || this.term.buffer.active.type === "alternate"
      || this.options.canRebuild?.() === false
    ) return;
    this.rebuilding = true;
    this.settlePromise = this.settlePromise.then(async () => {
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
  }

  private async rebuild(): Promise<void> {
    await Promise.all([this.pristineSettled, this.visibleSettled]);
    const generation = this.resetGeneration;
    this.pristineTerm.options.scrollback = this.term.options.scrollback;
    const snapshot = this.serializeAddon.serialize({
      scrollback: this.term.options.scrollback,
      excludeAltBuffer: true,
      excludeModes: false,
    });
    const viewportOffset = Math.max(0, this.term.buffer.normal.baseY - this.term.buffer.normal.viewportY);
    const selection = this.term.getSelectionPosition();
    const selectionLength = selection
      ? (selection.end.y - selection.start.y) * this.term.cols
        + (selection.end.x - selection.start.x)
      : 0;
    this.rebuildCount += 1;
    this.transformer.resetParserState();
    const highlighted = this.transformer.transform(snapshot);
    if (generation !== this.resetGeneration || this.disposed) return;
    this.originalReset();
    await new Promise<void>((resolve) => this.originalWrite(highlighted, resolve));
    if (generation !== this.resetGeneration || this.disposed) return;
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
