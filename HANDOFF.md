# Year Zero — JSDoc Annotations Handoff

## What Was Done

Added JSDoc `@typedef`, `@param`, `@returns`, and `@type` annotations to the three critical engine files, completing the annotation work described in Phase 1/2 of the TypeScript migration plan.

**Branch:** `claude/review-year-zero-engine-kvh70` (not yet merged to main)

**Commit:** `Add JSDoc type annotations to state.js, parser.js, interpreter.js`

### Files Changed (+260 lines, no logic changes)

| File | What was added |
|------|---------------|
| `engine/core/state.js` | 6 `@typedef` definitions (canonical type source), `@type` on all exports, `@param/@returns` on all functions |
| `engine/core/parser.js` | 4 `@typedef` definitions for context/result shapes, imports types from state.js, `@param/@returns` on all 5 functions |
| `engine/core/interpreter.js` | `@typedef InterpreterCallbacks` (17-property shape of the `cb` object), `@typedef DirectiveHandler`, `@type` on internal registries, `@param/@returns` on all exported functions |

### Type Definitions Created

```
ParsedLine           { raw, trimmed, indent }
StatRegistryEntry    { key, label, defaultVal }
AwaitingChoiceState  { end, choices, _blockEnd?, _savedIp? }
ChoiceOption         { text, selectable, start, end, statTag }
StatTag              { label, requirement }
StartupMeta          { sceneList }
InterpreterCallbacks { addParagraph, addSystem, clearNarrative, ... (17 props) }
DirectiveHandler     (t: string, line: ParsedLine) => void|Promise<void>
ParseChoiceContext   { currentLines, evalValue, showEngineError? }
ParseChoiceResult    { choices, end }
ParseSystemBlockContext  { currentLines }
ParseSystemBlockResult   { text, endIp, ok }
```

Bundle size unchanged at 98.5kb — esbuild strips all JSDoc comments.

---

## What's Next

### Remaining Phase 1 — JS Cleanup (patch-diary removal)

These files still need patch-diary comment cleanup (same treatment as engine.js, build.js, style.css, expression.js which are already done):

- `engine/ui/narrative.js`
- `engine/ui/panels.js`
- `engine/ui/overlays.js`
- `engine/systems/saves.js`
- `engine/systems/inventory.js`
- `engine/systems/skills.js`
- `engine/systems/items.js`
- `engine/systems/journal.js`
- `engine/systems/leveling.js`

### Phase 3 — Install TypeScript, Loose Config

- `npm install --save-dev typescript`
- Add `tsconfig.json` with `allowJs: true`, `checkJs: false`, `strict: false`
- esbuild handles TypeScript natively — no separate `tsc` build step needed

### Phase 4 — File-by-file .js → .ts Conversion

Rename in dependency order:
```
state → expression → parser → inventory → journal → leveling →
skills → items → saves → narrative → panels → overlays →
interpreter → engine
```

### Phase 5 — Strict Mode

Enable `strict: true` once all files are `.ts`, fix remaining type errors.

---

## Folder Structure (current)

```
engine/
  core/       state.js, expression.js, parser.js, interpreter.js
  systems/    saves.js, inventory.js, skills.js, items.js, journal.js, leveling.js
  ui/         narrative.js, panels.js, overlays.js
```

The handoff doc mentions a planned `src/` prefix — the files currently live under `engine/`. Decide whether to keep `engine/` or rename to `src/` before starting Phase 4.
