# Changelog

## Phase 1 — TypeScript Strict Mode
**Date:** 2026-03-20
**What was done:** Confirmed that `strict: true` was already set in `tsconfig.json` and that all source files were already strict-compliant. Running `npx tsc --noEmit` produced zero errors. All existing unit tests (205) passed. Build succeeded producing `dist/engine.js`. The codebase already had proper type annotations on all function parameters, `catch (err: unknown)` narrowing patterns, and typed DOM interfaces.
**Known bugs:** None
**Deferred:** Nothing — the codebase was already strict-compliant before this phase began.
**Lessons learned:** The previous development work had already incrementally adopted strict TypeScript. A minor ergonomic note: `engine.ts` casts DOM elements with `as HTMLElement | null` in some places and `as HTMLElement` in others; the boot-time null check loop covers both patterns safely.

## Phase 2 — Extract engine.ts God-Object
**Date:** 2026-03-20
**What was done:** Extracted `engine.ts` from 599 lines into focused modules. Created `src/core/dom.ts` (Dom interface, `buildDom()`, and DOM title helpers `setChapterTitle`/`showChapterCard`/`setGameTitle`). Created `src/systems/undo.ts` (UndoSnapshot interface, `pushUndoSnapshot`, `popUndo`, `clearUndoStack`, `updateUndoBtn` — dependencies injected via `initUndo()`). Created `src/systems/save-manager.ts` (`wireSaveUI` — all save/load/undo/new-game button wiring extracted from `wireUI()`). `engine.ts` is now 127 meaningful lines — just imports, helpers, `boot()`, and `DOMContentLoaded`.
**New files created:** `src/core/dom.ts`, `src/systems/undo.ts`, `src/systems/save-manager.ts`
**Known bugs:** None
**Deferred:** The `dom` object in `engine.ts` still has a mutable `choiceArea` field (needed by the overlay `setChoiceArea` callback). This is a minor wart but doesn't cause issues in practice.
**Lessons learned:** The undo system has many dependencies (state, parser, narrative, panels) — injecting them via `initUndo()` is cleaner than direct imports in the new module. The `save-manager.ts` ended up importing from many modules but remains one-directional, which is what matters for preventing circular deps.

## Phase 3 — Optimize Status Panel Rebuilds
**Date:** 2026-03-20
**What was done:** Refactored `runStatsScene()` in `panels.ts` to use a dirty-flags system (`_dirtyTabs`) so only the active tab's HTML is built on each stats update; other tabs rebuild lazily on first switch. Split the monolithic render into `buildStatsTabHtml`, `buildSkillsTabHtml`, `buildInventoryTabHtml`, and `buildLogTabHtml`. Moved stat diff tracking to the data layer using a `_statChanges: Map<string, 'up'|'down'>` instead of querying DOM rows directly, so flash animations survive switching away from the Stats tab and switching back. Applied the stable tab bar + content pane swap pattern throughout — the tab bar HTML is no longer rebuilt on every tab click. Also added ARIA `role="tablist"`, `role="tab"`, and `role="tabpanel"` markup to the status panel tab structure (Phase 6 prep).
**Known bugs:** None
**Deferred:** The `_lastEntries` array is module-level but is always refreshed before use; no staleness concern.
**Lessons learned:** Separating "what changed in the data" (stat diff tracking) from "apply changes to DOM" (flash classes) makes the feature work correctly regardless of which tab is visible at the time of the change.

## Phase 4 — *random_choice Directive
**Date:** 2026-03-20
**What was done:** Added `parseRandomChoice` to `src/core/parser.ts` (exports `RandomChoiceOption` interface and the parser function). Registered the `*random_choice` command in `src/core/interpreter.ts` — uses weighted random selection (normalised weights, doesn't need to sum to 100) and executes the selected branch body, then continues after the block. Added 13 new unit tests covering: valid 3-option parse, empty block, weighted distribution (1000-trial probabilistic check), interpreter integration (branch executes, execution continues after block). All 222 tests pass.
**New authoring syntax:**
```
*random_choice
  40 #Path A
    You stumble into a hidden grove.
  40 #Path B
    A merchant blocks the road.
  20 #Path C
    Nothing happens.
```
Weights are integers; they don't need to sum to 100. The option labels after `#` are author-facing metadata, not shown to the player.
**Known bugs:** None
**Deferred:** A test scene file (`data/test_random.txt`) was not created since the game currently only has `prologue` in the scene list and the interpreter integration tests cover the feature adequately.
**Lessons learned:** The weighted selection loop pattern (subtract weight, break when ≤ 0) works correctly even with a single option (weight ≥ totalWeight always selects index 0). The `executeBlock` return value handling mirrors the `*choice` handler exactly.

## Phase 5 — *image Directive
**Date:** 2026-03-20
**What was done:** Created `media/` directory (with `.gitkeep`) as the image asset location. Extended `NarrativeLogEntry` in `narrative.ts` to include `alt?: string` and `width?: number | null`. Added `addImage()` to `narrative.ts` which creates `<div class="narrative-image-wrapper"><img class="narrative-image">` and pushes a log entry. Added `case 'image'` to `renderFromLog` for save/load/undo replay. Added `addImage?` to `InterpreterCallbacks`. Registered `*image` command in `interpreter.ts` — parses filename (required), `alt:"text"`, and `width:N` parameters. Wired `addImage` callback in `engine.ts`. Added `.narrative-image-wrapper` and `.narrative-image` CSS to `style.css`. All 222 tests pass.
**New authoring syntax:**
```
*image "cave_entrance.webp"
*image "portrait.png" alt:"A hooded figure" width:400
```
Images load from `media/<filename>` relative to the game root.
**New directory:** `media/` — place image assets here.
**Known bugs:** None. A missing image silently shows the browser's broken-image icon without crashing the engine (standard browser behavior).
**Deferred:** Variable interpolation in filename (`*image "${portrait_file}"`) was not implemented to keep the handler simple. Can be added later if needed.
**Lessons learned:** Extending `NarrativeLogEntry` with optional fields is clean — old saves without the fields deserialise fine since the renderer uses `?? ''` defaults.

## Phase 6 — Keyboard Navigation and ARIA Improvements
**Date:** 2026-03-20
**What was done:** Added `aria-live="polite" aria-atomic="false"` to `#narrative-content` in `index.html` so screen readers announce new story text. Added Ctrl+S / Cmd+S (toggle save menu) and Ctrl+Z / Cmd+Z (trigger undo) keyboard shortcuts in `save-manager.ts` (implemented during Phase 2). Added ARIA tabs markup (`role="tablist"`, `role="tab"`, `aria-selected`, `aria-controls`, `role="tabpanel"`, `aria-labelledby`) to the status panel tab structure in `panels.ts` (implemented during Phase 3). Added numbered `aria-label` attributes to choice buttons in `narrative.ts` (`Choice N of M: text`). Added arrow-key (↑↓) navigation within the choice group in `narrative.ts` — wraps at edges. The arrow-key handler is registered once on the choice area element.
**New keyboard shortcuts:** Ctrl+S / Cmd+S (toggle save menu), Ctrl+Z / Cmd+Z (undo), Arrow keys (choice navigation)
**Known bugs:** None
**Deferred:** Full screen reader testing deferred pending access to NVDA/VoiceOver. The `aria-live` on the entire narrative panel may be verbose if many paragraphs arrive at once; a dedicated hidden announcer div would be more surgical but was not needed for the current content.
**Lessons learned:** The ARIA tabs pattern was already set up in Phase 3, so Phase 6 was mostly about the `aria-live` attribute and choice accessibility labels.

## Phase 7 — *checkpoint Auto-Bookmark System
**Date:** 2026-03-20
**What was done:** Added `saveCheckpoint`, `getCheckpoints`, `CHECKPOINT_MAX`, and `CHECKPOINT_PREFIX` to `saves.ts`. Checkpoints use SA1 format and rotate FIFO (slot 0 = newest, slot 4 = oldest, max 5). Registered `*checkpoint` command in `interpreter.ts` — accepts optional quoted label, falls back to current chapter title. Added `refreshCheckpoints()` to `overlays.ts` called from `showSaveMenu()` — renders a collapsible "Checkpoints" section below the save-code area in the save overlay. Load buttons work the same as slot loads. Added `checkpoint-section`, `checkpoint-card`, `checkpoint-toggle`, etc. CSS to `style.css`. Added `*checkpoint "Prologue — The End of the World"` at the start of `prologue.txt`. All 222 tests pass.
**New authoring syntax:** `*checkpoint "Label"` — creates a named restore point. The label is optional; if omitted, the current chapter title is used.
**Known bugs:** None
**Deferred:** "Delete checkpoint" UI was deferred — checkpoints are author-controlled safety nets, not player-managed saves.
**Lessons learned:** Using `cloneNode` to replace the toggle button on each `showSaveMenu()` call prevents accumulating duplicate click listeners.

## Phase 8 — Glossary/Tooltip System and Scene Linter
**Date:** 2026-03-20
**What was done:**

*Part A — Glossary/Tooltip System:*
Created `src/systems/glossary.ts` with `GlossaryEntry` interface, `glossaryRegistry` (module-level array), `parseGlossary()` (reads `data/glossary.txt`), `addGlossaryTerm()`, and `getGlossaryEntry()`. Created `data/glossary.txt` with 7 entries (Essence, System, Mana, Class, Solace, Malphas, Awakening). Registered `*define_term "Term" description` directive in `interpreter.ts` — adds/replaces runtime glossary entries. Added `parseGlossary(fetchTextFile)` call to `engine.ts` boot sequence (after parseProcedures). Wired `formatText()` in `narrative.ts` with a step-0 placeholder token pass: glossary terms are tokenized before variable interpolation and markdown processing, then restored to `<span class="lore-term" tabindex="0" data-tooltip="...">` elements at the very end. This ensures terms inside `**bold**` markup work correctly. Added `.lore-term` and `.lore-term:hover::after` / `.lore-term:focus::after` CSS to `style.css` — tooltip appears above the term using `::after` with `content: attr(data-tooltip)`. Added a "Glossary" accordion sub-section to `buildLogTabHtml()` in `panels.ts`, rendered below Journal entries in the Log tab. Added `import { glossaryRegistry }` to `panels.ts`.

*Part B — Scene Linter CLI:*
Created `tools/lint.ts` — a standalone TypeScript CLI (runs via `npx tsx tools/lint.ts`). Parses `startup.txt` to collect all `*create`/`*create_stat` global variables and the `*scene_list`. Lints each listed scene for: duplicate `*label` declarations, `*goto`/`*gosub` references to undefined labels, `*goto_scene`/`*gosub_scene` references to scenes not in the scene list, `*call` references to undefined procedures (from `procedures.txt`), `*set`/`*set_stat` uses of undeclared variables, `*if`/`*elseif` condition variable references, `${var}` interpolation of undeclared variables, and unused label declarations (warned, not errored). `--strict` flag exits with code 1 on any issue (errors or warnings). Added `"lint": "npx tsx tools/lint.ts"` to `package.json` scripts. Running `npm run lint` on the current codebase reports 0 errors, 2 warnings (unused fall-through labels in prologue.txt — correct behavior).

**New files created:** `src/systems/glossary.ts`, `data/glossary.txt`, `tools/lint.ts`
**New authoring syntax:**
- `*define_term "Term Name" A one-sentence description.` — adds/replaces a glossary entry at runtime
- Glossary entries in `data/glossary.txt` use `*term "Name"` / description block format
**Known bugs:** None
**Deferred:** The glossary tooltip is CSS-only (hover/focus `::after`); a fully accessible JS-driven tooltip overlay was deferred. The linter does not currently follow `*goto_scene` chains to check cross-scene label references.
**Lessons learned:** The placeholder token technique (step 0 in `formatText()`) is the correct approach for injecting markup into text that will undergo further text processing — tokens are opaque to all intermediate steps and are only materialized into HTML at the very end.

## Phase 9 — Light Mode, Portrait Image, and Persistent Chapter Cards
**Date:** 2026-03-20

### Feature A: Persistent Chapter Cards
**What was done:** Chapter title cards now remain visible on the page instead of fading out after 2.2s. Changed `@keyframes chapterCardReveal` from a fade-in-hold-fade-out sequence to a simple 0.6s fade-in with `forwards` fill (stays at full opacity). Removed the `animationend` self-destruct listener from `showChapterCard()`. Moved card insertion from `#narrative-panel.firstChild` to `#narrative-content` before `#choice-area`, so the card is part of the scrollable narrative flow and is swept away naturally by `clearNarrative()` when a choice is made, a page break continues, or a scene transition occurs. Added a `registerChapterCardLog` dependency-injection hook in `dom.ts` (populated at boot from `engine.ts`) so `showChapterCard` can push a `{ type: 'chapter-card', text }` entry to the narrative log. Added `case 'chapter-card'` handler in `renderFromLog()` in `narrative.ts` — restores the card with `animation: none` so reloads are instant. Save/load and undo now correctly restore chapter cards.

### Feature B: Character Portrait Image
**What was done:** Replaced the inline SVG silhouette in the character creation overlay with `<img src="media/portrait.png" alt="" class="char-portrait-img" onerror="this.style.display='none'"/>`. Added `.char-portrait-img { object-fit: cover; object-position: center top; }` CSS. The existing `.char-portrait-frame` (160×192px, overflow: hidden, cyan border) constrains and frames the image. Added `background: #000c10` to the frame so it looks correct when no image is present and the `onerror` fallback hides the broken img element. Place an image at `media/portrait.png` (or .webp/.jpg — update the `src` accordingly) to display a portrait.

### Feature C: Light Mode Toggle
**What was done:** Added a `☀/☽` theme toggle button (`#theme-toggle-btn`) before the Undo button in `.header-actions`. Unlike Undo/Save, this button is always visible (not `.hidden` by default). Added a FOUC-prevention inline `<script>` in `<head>` (before the stylesheet) that reads `sa_theme` from localStorage and sets `data-theme="light"` on `<html>` synchronously before first paint. Added `initThemeToggle()` in `dom.ts` — called as the very first line of `boot()` — which applies the saved preference or falls back to `window.matchMedia('(prefers-color-scheme: light)')`, updates the button icon/title, and wires the click handler. Preference is persisted to `localStorage` as `sa_theme = 'light' | 'dark'`. Added a `[data-theme="light"]` CSS block that overrides all design token variables with a warm parchment palette (dark teal accents instead of bright cyan). Added targeted overrides for elements with hardcoded `rgba()` colors: `#game-header`, `#chapter-bar`, `.overlay`, `.chapter-card`, `.chapter-card-title`, `.char-portrait-frame`. Removed glow `text-shadow` values on epic/legendary rarity elements (they read as muddy blobs on light backgrounds). Fixed the inline `<style>` block in `index.html` for the save-code textarea — was using undefined CSS variable names (`--bg-deeper`, `--text`, `--border`) with hardcoded dark fallbacks; updated to use the correct variable names (`--bg-system`, `--text-primary`, `--border-dim`).

**Known bugs:** None
**Deferred:** The overlay backdrop blur (`backdrop-filter: blur(6px)`) can look slightly off on Firefox in light mode — cosmetic only, deferred. A dedicated light-mode font weight tweak (Cinzel at 400 can be thin on some screens) was considered but deferred.
**Lessons learned:** The FOUC prevention script MUST come before the `<link rel="stylesheet">` tag, not after — otherwise the browser may paint the default (dark) theme for a single frame before the script runs. Inline styles using undefined CSS variable names silently fall back to hardcoded values, making them invisible to theme-switching. Always use the correct variable name so the fallback chain works.
