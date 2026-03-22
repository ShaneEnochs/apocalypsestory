# Claude Code — Project Notes for System Awakening

## CRITICAL: Always rebuild the bundle

The site loads `dist/engine.js`, a pre-built esbuild bundle.
**TypeScript source changes have zero effect on the live site until the bundle is rebuilt and committed.**

After every source file change, before committing:

```bash
npm install        # ensures esbuild and other devDeps are present
node build.js      # compiles engine.ts → dist/engine.js
```

Then stage and commit **both** the source files and the dist output:

```bash
git add src/...  dist/engine.js dist/engine.js.map
```

Forgetting this is why placeholder name fixes appeared correct in TypeScript but did nothing in the browser for multiple sessions.

---

## Project structure

| Path | Purpose |
|------|---------|
| `engine.ts` | Boot sequence — wires all modules, starts the game |
| `src/core/` | Interpreter, parser, expression evaluator, state, DOM helpers |
| `src/systems/` | Saves, undo, inventory, skills, items, journal, glossary, procedures |
| `src/ui/` | Narrative rendering, status panel, overlays (splash/save/char creation/toast) |
| `dist/engine.js` | **Deployed bundle** — must be rebuilt after any source change |
| `index.html` | Shell; loads `dist/engine.js` as an ES module |
| `style.css` | All styling (CSS custom properties, no preprocessor) |
| `startup.txt` | Game init: `*create` variables, `*create_stat` stats, `*scene_list` |
| `skills.txt` | Skill registry (`*skill key [Rarity] "Label" cost`) |
| `items.txt` | Item registry (`*item key "Label" cost [rarity] [stock]`) |
| `procedures.txt` | Reusable named procedures (`*procedure name … *return`) |
| `glossary.txt` | Lore terms shown as in-narrative tooltips |

---

## Build & test commands

```bash
npm install          # install devDependencies (esbuild, typescript, playwright, tsx)
node build.js        # bundle TypeScript → dist/engine.js
npx tsc --noEmit     # type-check without emitting (fast sanity check)
npm test             # unit tests (tests/test_runner.mjs)
npm run test:e2e     # Playwright end-to-end tests
npm run dev          # local dev server on :3000 (serve .)
```

---

## Deployment

- Hosted on **GitHub Pages** from the `main` branch root.
- No CI/CD build step — `dist/engine.js` must be committed pre-built.
- GitHub Pages can take a few minutes to reflect a merge; hard-refresh (Ctrl+Shift+R) if the live site looks stale.

---

## Key architectural rules

- **No circular imports.** UI → core is fine. Core must not import UI.
  Callbacks are injected at boot (`registerCallbacks`, `init()`) to break the cycle.
- **XSS prevention.** All author/player strings go through `escapeHtml()` before `innerHTML`.
  Expression evaluator uses a recursive-descent parser — no `eval()` / `Function()`.
- **Save integrity.** SA1 format: `SA1|base64_payload|crc16`. Version 9.
  Delta-encoded against startup defaults. Changing `SAVE_VERSION` in `saves.ts` invalidates old saves.
- **Fail-closed expressions.** Parse errors in `evalValue()` return `0` (falsy) so broken `*if` conditions don't accidentally execute.

---

## Character creation overlay — notes

- `wireCharCreation()` sets up all event listeners once at boot.
- `showCharacterCreation()` resets state and shows the overlay each time New Game is clicked.
- Default names ("Charlie" / "McKinley") are set in a `requestAnimationFrame` callback.
- `char-input--default` CSS class marks a field as showing the default. The `focus` event on a name input calls `clearIfDefault`, which clears the value so the user starts fresh.
- **Do NOT call `focus()` on a name input inside the rAF that sets defaults.**
  Chrome dispatches the focus event asynchronously — after the rAF returns — so `clearIfDefault` fires after the class is set and wipes the values. Instead, focus the pre-selected pronoun card, which has no clearIfDefault handler.
- `trapFocus` is called with `autoFocus = false` for the char overlay for the same reason.
