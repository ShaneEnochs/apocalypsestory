// core/parser.js — Scene text parsing
//
// Converts raw .txt scene file content into the structured line objects and
// data structures the interpreter operates on. Zero DOM, zero side-effects —
// pure text-in / data-out.
//
// The ctx (context) parameter passed to parseChoice and parseSystemBlock is an
// object with the shape:
//   { currentLines, evalValue, showEngineError? }
// This keeps parser.js free of direct state imports — the interpreter injects
// the live currentLines array and evaluator at call time.

import type { ParsedLine, ChoiceOption, StatTag } from './state.js';

interface ParseChoiceContext {
  currentLines:    ParsedLine[];
  evalValue:       (expr: string) => any;
  showEngineError?: (msg: string) => void;
}

interface ParseChoiceResult {
  choices: ChoiceOption[];
  end:     number;
}

interface ParseSystemBlockContext {
  currentLines: ParsedLine[];
}

interface ParseSystemBlockResult {
  text:  string;
  endIp: number;
  ok:    boolean;
}

// ---------------------------------------------------------------------------
// parseLines — splits raw scene text into line objects.
// ---------------------------------------------------------------------------
export function parseLines(text: string): ParsedLine[] {
  return text.split(/\r?\n/).map(raw => {
    const indentMatch = raw.match(/^\s*/)?.[0] || '';
    return { raw, trimmed: raw.trim(), indent: indentMatch.length };
  });
}

// ---------------------------------------------------------------------------
// indexLabels — builds a label→lineIndex map for a scene and stores it in
// the provided labelsCache Map keyed by sceneName.
// ---------------------------------------------------------------------------
export function indexLabels(
  sceneName: string,
  lines: ParsedLine[],
  labelsCache: Map<string, Record<string, number>>,
): void {
  const map = {};
  lines.forEach((line, idx) => {
    const m = line.trimmed.match(/^\*label\s+([\w_\-]+)/);
    if (m) map[m[1]] = idx;
  });
  labelsCache.set(sceneName, map);
}

// ---------------------------------------------------------------------------
// parseChoice — scans forward from a *choice line and collects all options.
//
// Each option is either a plain `#text` line or a `*selectable_if (cond) #text`
// line. For each option, finds the block end so the interpreter knows the
// exact line range to execute when the option is selected.
// ---------------------------------------------------------------------------
export function parseChoice(startIndex: number, indent: number, ctx: ParseChoiceContext): ParseChoiceResult {
  const { currentLines, evalValue, showEngineError } = ctx;
  const choices = [];
  let i = startIndex + 1;

  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    if (line.indent <= indent) break;

    let selectable   = true;
    let optionText   = '';
    const optionIndent = line.indent;

    if (line.trimmed.startsWith('*selectable_if')) {
      const m = line.trimmed.match(/^\*selectable_if\s*\((.+)\)\s*#(.*)$/);
      if (m) {
        selectable = !!evalValue(m[1]);
        optionText = m[2].trim();
      } else {
        const msg = `[parser] Malformed *selectable_if at line ${i}: "${line.trimmed}"\nExpected: *selectable_if (condition) #Option text`;
        console.warn(msg);
        if (typeof showEngineError === 'function') showEngineError(msg);
      }
    } else if (line.trimmed.startsWith('#')) {
      optionText = line.trimmed.slice(1).trim();
    }

    if (optionText) {
      // Extract optional inline stat requirement tag: "Option text [StatLabel N]"
      let statTag: StatTag|null = null;
      const tagMatch = optionText.match(/^(.*?)\s*\[([A-Za-z][^[\]]*?)\s+(\d+)\]\s*$/);
      if (tagMatch) {
        optionText = tagMatch[1].trim();
        statTag = { label: tagMatch[2].trim(), requirement: Number(tagMatch[3]) };
      }

      const start = i + 1;
      const end   = findBlockEnd(start, optionIndent, currentLines);
      choices.push({ text: optionText, selectable, start, end, statTag });
      i = end;
      continue;
    }
    i += 1;
  }

  return { choices, end: i };
}

// ---------------------------------------------------------------------------
// parseSystemBlock — collects lines between *system and *end_system into a
// single string, preserving relative indentation of the inner content.
// ---------------------------------------------------------------------------
export function parseSystemBlock(startIndex: number, ctx: ParseSystemBlockContext): ParseSystemBlockResult {
  const { currentLines } = ctx;
  const parts = [];
  let baseIndent = null;
  let i = startIndex + 1;

  while (i < currentLines.length) {
    const t = currentLines[i].trimmed;
    if (t === '*end_system') return { text: parts.join('\n'), endIp: i + 1, ok: true };
    if (baseIndent === null && t) baseIndent = currentLines[i].indent;
    const raw = currentLines[i].raw;
    parts.push(
      baseIndent !== null
        ? raw.slice(Math.min(baseIndent, raw.search(/\S|$/)))
        : raw.trimStart()
    );
    i += 1;
  }

  return { text: '', endIp: currentLines.length, ok: false };
}

// ---------------------------------------------------------------------------
// findBlockEnd — returns the index of the first non-empty line whose indent
// is <= parentIndent, starting from fromIndex. Local helper for parseChoice;
// the interpreter has its own copy for the live execution pass.
// ---------------------------------------------------------------------------
function findBlockEnd(fromIndex: number, parentIndent: number, currentLines: ParsedLine[]): number {
  let i = fromIndex;
  while (i < currentLines.length) {
    const l = currentLines[i];
    if (l.trimmed && l.indent <= parentIndent) break;
    i += 1;
  }
  return i;
}
