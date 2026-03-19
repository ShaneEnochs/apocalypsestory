# Year Zero — TypeScript Migration Handoff

## What Was Done (this session)

Completed Phase 4 of the TypeScript migration plan — all source files converted from `.js` to `.ts`.

**Branch:** `claude/review-commit-handoff-yqAJ5`

### Changes

| What | Detail |
|------|--------|
| All 14 source files renamed | `git mv *.js → *.ts` for all files in `src/` and root `engine.ts` |
| `state.ts` | 6 JSDoc `@typedef` blocks → real exported TypeScript interfaces |
| `state.ts` | `@type` JSDoc → inline TS type annotations on all `export let` vars and function params |
| `parser.ts` | JSDoc `@typedef {import()} X` → `import type { X } from './state.js'` |
| `parser.ts` | 4 local JSDoc typedefs → inline `interface` declarations |
| `interpreter.ts` | JSDoc `@typedef {import()} X` → `import type { X } from './state.js'` |
| `interpreter.ts` | `InterpreterCallbacks` JSDoc typedef → exported `interface InterpreterCallbacks` |
| `interpreter.ts` | `DirectiveHandler` typedef → `type DirectiveHandler = ...` |
| `saves.ts` | Two `payload` objects typed as `Record<string, any>` to fix optional-property errors |
| `build.js` | `entryPoints: ['engine.ts']` |
| `tsconfig.json` | `include` updated to `engine.ts` |
| `package.json` | Test scripts changed from `node` → `npx tsx` (tsx added as devDependency) |
| `tests/test_runner.mjs` | Import paths updated to `.ts` extensions |
| Build | 98.5 kb, 33 ms (unchanged) |
| Tests | 183/183 pass |

### `tsc --noEmit` Status

25 type errors remain — all are DOM narrowing issues in `engine.ts` and `src/ui/narrative.ts`:

- `HTMLElement` used where `HTMLInputElement`, `HTMLButtonElement` etc. are expected (`.value`, `.disabled`, `.files`)
- `EventTarget` used where `Node` is expected (`.contains()`)
- `unknown` typed return from `showCharacterCreation()` being destructured

These are the **Phase 5 workload** — they don't affect the build or tests, but will need to be fixed before `strict: true` is clean.

---

## History (completed phases)

| Phase | What | Status |
|-------|------|--------|
| 1 | Patch-diary comment cleanup (all source files) | Done — `f62ddce` |
| 1/2 | JSDoc `@typedef`/`@param`/`@returns` on `state.js`, `parser.js`, `interpreter.js` | Done — `4136097` |
| 3 | TypeScript installed + `tsconfig.json` + `engine/` → `src/` rename | Done — `f740cbf` |
| 4 | All `.js` → `.ts`; real interfaces in `state`, `parser`, `interpreter` | Done — this session |

---

## What's Next

### Phase 5 — Fix `tsc --noEmit` errors + Enable `strict: true`

Two related tasks:

**5a. Fix the 25 remaining DOM type errors** (before enabling strict):

All in `engine.ts` and `src/ui/narrative.ts`. The pattern is always the same:

```typescript
// Before (broken — HTMLElement lacks .value):
const field = document.getElementById('save-code-field');
if (field) field.value = code;

// After (fixed):
const field = document.getElementById('save-code-field') as HTMLInputElement | null;
if (field) field.value = code;
```

Common casts needed:
- `getElementById('...')` → cast to `HTMLInputElement`, `HTMLButtonElement`, `HTMLTextAreaElement` etc.
- `e.target` → cast to `Node` inside `.contains()` calls
- Return type of `showCharacterCreation()` in `overlays.ts` needs to be typed

**5b. Enable strict mode** in `tsconfig.json`:

```json
"strict": true
```

Then fix any new errors that surface (likely implicit `any` parameters).

---

## Current Folder Structure

```
engine.ts           (root entry point — imports from ./src/…)
src/
  core/       state.ts, expression.ts, parser.ts, interpreter.ts
  systems/    saves.ts, inventory.ts, skills.ts, items.ts, journal.ts, leveling.ts
  ui/         narrative.ts, panels.ts, overlays.ts
  tests/      e2e.spec.mjs
tsconfig.json
```

---

## Notes

- esbuild strips all type annotations — bundle size is unaffected.
- `tsx` (added as devDependency) powers `npm test` so Node.js can run the `.ts` test suite directly.
- Internal imports still use `.js` extensions (e.g. `from './state.js'`) — this is intentional and correct: esbuild and tsx both resolve these to the `.ts` files.
- `checkJs: false` can be removed now that all files are `.ts`.
