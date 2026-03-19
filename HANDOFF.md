# Year Zero — TypeScript Migration Handoff

## What Was Done (this session)

Completed Phase 3 of the TypeScript migration plan.

**Branch:** `claude/review-commit-handoff-yqAJ5`

### Changes

| What | Detail |
|------|--------|
| TypeScript installed | `typescript@5.9.3` added to `devDependencies` |
| `tsconfig.json` created | `allowJs: true`, `checkJs: false`, `strict: false`, `noEmit: true` |
| `engine/` → `src/` | All source files moved; imports updated in `engine.js` and `tests/test_runner.mjs` |
| Build verified | `dist/engine.js` still 98.5 kb, 20 ms build time |
| Tests verified | 183/183 pass |

### Current Folder Structure

```
src/
  core/       state.js, expression.js, parser.js, interpreter.js
  systems/    saves.js, inventory.js, skills.js, items.js, journal.js, leveling.js
  ui/         narrative.js, panels.js, overlays.js
  tests/      e2e.spec.mjs
engine.js     (root entry point — imports from ./src/…)
tsconfig.json
```

---

## History (completed phases)

| Phase | What | Status |
|-------|------|--------|
| 1 | Patch-diary comment cleanup (all source files) | Done — `f62ddce` |
| 1/2 | JSDoc `@typedef`/`@param`/`@returns` on `state.js`, `parser.js`, `interpreter.js` | Done — `4136097` |
| 3 | TypeScript installed + `tsconfig.json` + `engine/` → `src/` rename | Done — this session |

---

## What's Next

### Phase 4 — Convert `.js` → `.ts` (in dependency order)

Rename files one by one; fix any type errors that surface after each rename.
esbuild handles `.ts` natively — no separate `tsc` compile step.

Dependency order:
```
state → expression → parser → inventory → journal → leveling →
skills → items → saves → narrative → panels → overlays →
interpreter → engine
```

For each file:
1. `git mv src/…/foo.js src/…/foo.ts`
2. Update any files that import it to use the new `.ts` extension (or drop the extension — esbuild resolves both)
3. `npm run build` — confirm still 98.5 kb
4. `npm test` — confirm 183 pass

### Phase 5 — Enable `strict: true`

After all files are `.ts`, flip `"strict": false` → `"strict": true` in `tsconfig.json`
and fix the type errors that surface (likely: implicit `any` on callbacks, missing return
types, undefined checks).

---

## Notes

- esbuild strips all JSDoc/type annotations — bundle size is unaffected by annotation density.
- `tsconfig.json` is for editor intelligence and `tsc --noEmit` checks only; esbuild is still the actual bundler.
- `checkJs: false` keeps existing `.js` files silent during Phase 4 while files are being converted incrementally.
