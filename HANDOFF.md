# Year Zero — TypeScript Migration Handoff

## What Was Done (this session)

Completed Phase 5a of the TypeScript migration plan — all DOM narrowing errors fixed, `tsc --noEmit` is now clean at 0 errors with `strict: false`.

**Branch:** `claude/review-commit-handoff-yqAJ5`

### Changes

| File | What |
|------|------|
| `src/ui/narrative.ts` | `querySelector` results cast to `HTMLInputElement` / `HTMLButtonElement`; `keydown` listener typed as `KeyboardEvent` |
| `src/ui/overlays.ts` | Added exported `CharacterData` interface; `showCharacterCreation()` return typed as `Promise<CharacterData>` |
| `engine.ts` | `getElementById('undo-btn')` cast to `HTMLButtonElement \| null`; `e.target` cast to `Node` in `.contains()` calls; `importInput` cast to `HTMLInputElement`; slot select cast to `HTMLSelectElement`; save-code `field` cast to `HTMLInputElement` |
| `tsconfig.json` | Remains at `strict: false` (see note below) |
| Build | 98.5 kb, 18 ms (unchanged) |
| Tests | 183/183 pass |
| `tsc --noEmit` | **0 errors** |

### Why `strict: true` Was Deferred

Enabling `strict: true` produced **508 errors** across the codebase, dominated by two categories:

1. **Implicit `any` parameters** — every function without explicit parameter types in `engine.ts`, `expression.ts`, and all UI files triggers `TS7006: Parameter 'x' implicitly has an 'any' type`.
2. **Possibly-null DOM elements** — the `dom.*` object in `engine.ts` is built via `getElementById` (returns `HTMLElement | null`), so every property access on it triggers `TS18047: ... is possibly 'null'`. Same pattern in all UI modules.

This requires a proper typing pass across the remaining untyped functions, not a few targeted fixes.

---

## History (completed phases)

| Phase | What | Status |
|-------|------|--------|
| 1 | Patch-diary comment cleanup (all source files) | Done — `f62ddce` |
| 1/2 | JSDoc `@typedef`/`@param`/`@returns` on `state.js`, `parser.js`, `interpreter.js` | Done — `4136097` |
| 3 | TypeScript installed + `tsconfig.json` + `engine/` → `src/` rename | Done — `f740cbf` |
| 4 | All `.js` → `.ts`; real interfaces in `state`, `parser`, `interpreter` | Done — `aa9951f` |
| 5a | DOM narrowing fixes; 0 errors at `strict: false` | Done — this session |

---

## What's Next

### Phase 5b — Enable `strict: true`

The 508 strict-mode errors fall into two clean categories — tackle them in order:

**Pass 1 — Annotate all remaining function parameters** (fixes most `TS7006` errors)

Every function without explicit parameter types. Pattern:
```typescript
// Before:
function wireUI() {
  dom.statusToggle.addEventListener('click', () => { ... });
}

// After (for callbacks):
dom.statusToggle.addEventListener('click', (_e: MouseEvent) => { ... });
```

The untyped files are mainly `engine.ts`, `expression.ts`, and the UI modules (`narrative.ts`, `panels.ts`, `overlays.ts`).

**Pass 2 — Null-guard the `dom` object in `engine.ts`** (fixes `TS18047` errors)

The `dom` object is built with `getElementById` calls, all of which return `HTMLElement | null`. Options:
- **Option A (assertive)**: Cast all assignments: `narrativeContent: document.getElementById('narrative-content') as HTMLElement`
- **Option B (defensive)**: Add runtime null checks and type `dom` with a proper interface

Option A is faster; Option B is safer. Given that the HTML template is stable, Option A is reasonable.

**Pass 3 — Remaining misc errors**

- `err` in `catch` blocks: type as `Error` or `unknown` with narrowing
- `_undoStack` implicit `any[]`: add `UndoSnapshot` interface and type it
- Expression parser tokens: add `Token` interface to `expression.ts`

### Suggested Order

1. Add a `Dom` interface to `engine.ts` and cast all `getElementById` calls at construction
2. Annotate all function parameters in `engine.ts`
3. Add `Token` interface + parameter types in `expression.ts`
4. Annotate remaining parameter types in `narrative.ts`, `panels.ts`, `overlays.ts`
5. Flip `strict: true` — should be near-zero errors at this point
6. Fix any remaining stragglers

---

## Current Folder Structure

```
engine.ts           (root entry point — imports from ./src/…)
src/
  core/       state.ts, expression.ts, parser.ts, interpreter.ts
  systems/    saves.ts, inventory.ts, skills.ts, items.ts, journal.ts, leveling.ts
  ui/         narrative.ts, panels.ts, overlays.ts
  tests/      e2e.spec.mjs
tsconfig.json       (strict: false, noEmit: true)
```

---

## Notes

- `tsc --noEmit` with `strict: false`: **0 errors** ✓
- esbuild strips all type annotations — bundle size is unaffected.
- `tsx` powers `npm test` so Node.js can execute `.ts` files directly.
- Internal imports still use `.js` extensions — esbuild and tsx both resolve these to `.ts`.
- `checkJs: false` can be removed now that all files are `.ts` (it currently has no effect).
