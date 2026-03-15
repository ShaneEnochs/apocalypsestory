// ---------------------------------------------------------------------------
// core/parser.js — Scene text parsing
//
// Converts raw .txt scene file content into the structured line objects and
// data structures the interpreter operates on. Zero DOM, zero side-effects —
// pure text-in / data-out.
//
// Exports:
//   parseLines(text)                          → line[]
//   indexLabels(sceneName, lines, labelsCache) → void  (populates provided map)
//   parseChoice(startIndex, indent, ctx)       → { choices, end }
//   parseSystemBlock(startIndex, ctx)          → { text, endIp, ok }
//
// The ctx (context) parameter passed to parseChoice and parseSystemBlock is an
// object with the shape:
//   { currentLines, evalValue, showEngineError? }
// This keeps parser.js free of direct state imports — the interpreter injects
// the live currentLines array and evaluator at call time.
//
// BUG-06 fix: parseChoice now accepts an optional ctx.showEngineError callback.
// When a *selectable_if line is malformed (regex fails), it calls showEngineError
// instead of only logging a console.warn, so authors see the error in-game.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// parseLines — splits raw scene text into line objects.
// Each line object: { raw, trimmed, indent }
// ---------------------------------------------------------------------------
export function parseLines(text) {
  return text.split(/\r?\n/).map(raw => {
    const indentMatch = raw.match(/^\s*/)?.[0] || '';
    return { raw, trimmed: raw.trim(), indent: indentMatch.length };
  });
}

// ---------------------------------------------------------------------------
// indexLabels — builds a label→lineIndex map for a scene and stores it in
// the provided labelsCache Map keyed by sceneName.
//
// Called once per scene load; results are used by *goto and gotoScene to
// jump directly to a label without re-scanning on every jump.
// ---------------------------------------------------------------------------
export function indexLabels(sceneName, lines, labelsCache) {
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
// line. For each option, finds the block end (the first line at or below the
// option's own indent) so the interpreter knows the exact line range to
// execute when the option is selected.
//
// ctx.currentLines  — the live line array (injected by interpreter)
// ctx.evalValue     — expression evaluator (injected by interpreter)
// ctx.showEngineError — optional; if provided, malformed lines call it
//                       in addition to console.warn so authors see the error.
//
// Returns { choices: [{ text, selectable, start, end }], end }
// where end is the line index just after the entire *choice block.
// ---------------------------------------------------------------------------
export function parseChoice(startIndex, indent, ctx) {
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
        // BUG-06 fix: surface malformed *selectable_if to the author in-game,
        // not just in the browser console, so the silently-dropped option
        // is immediately visible during development.
        const msg = `[parser] Malformed *selectable_if at line ${i}: "${line.trimmed}"\nExpected: *selectable_if (condition) #Option text`;
        console.warn(msg);
        if (typeof showEngineError === 'function') showEngineError(msg);
      }
    } else if (line.trimmed.startsWith('#')) {
      optionText = line.trimmed.slice(1).trim();
    }

    if (optionText) {
      // ENH-09: Extract optional inline stat requirement tag at end of text.
      // Format: "Option text [StatLabel N]"  e.g. "Force the door [Body 15]"
      let statTag = null;
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
//
// ctx.currentLines — the live line array (injected by interpreter)
//
// Returns { text, endIp, ok }
//   ok=true  → *end_system found; endIp points to the line after it
//   ok=false → *end_system never found; endIp = currentLines.length
// ---------------------------------------------------------------------------
export function parseSystemBlock(startIndex, ctx) {
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
// is <= parentIndent, starting from fromIndex.
//
// This is a local helper used only by parseChoice above. The identical copy
// in interpreter.js serves the live interpreter; this one serves the static
// parse pass that happens before any execution.
// ---------------------------------------------------------------------------
function findBlockEnd(fromIndex, parentIndent, currentLines) {
  let i = fromIndex;
  while (i < currentLines.length) {
    const l = currentLines[i];
    if (l.trimmed && l.indent <= parentIndent) break;
    i += 1;
  }
  return i;
}
