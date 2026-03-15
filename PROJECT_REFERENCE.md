# System Awakening — Project Reference

**Project:** `system-awakening` — a LitRPG interactive fiction engine/game running in the browser.  
**Entry point:** `index.html` loads `style.css` and `engine.js` (ES module).

---

## Architecture Overview

The codebase is split into three layers:

```
engine.js  (top-level coordinator / boot)
├── engine/core/         — state, parsing, evaluation, interpretation
├── engine/systems/      — game systems (saves, inventory, leveling, skills, items, journal)
└── engine/ui/           — DOM rendering (narrative, panels, overlays)
```

Scene content lives in `.txt` files and is parsed at runtime. There is no build step required for development; `build.js` is an optional production bundler.

---

## File-by-File Reference

### 🔧 Top-Level Coordinator

#### `engine.js`
The root module and boot coordinator. Responsibilities:
- Queries and holds all DOM element references (`dom` object).
- Owns the **undo stack** (`_undoStack`, max 10 snapshots) — `pushUndoSnapshot` / `popUndo`.
- Owns the **debug overlay** (toggle with `` ` `` key) with live state inspection and event log.
- `boot()` — initializes all subsystems (`initNarrative`, `initPanels`, `initOverlays`, `registerCallbacks`, `parseStartup`, `parseSkills`, `parseItems`) then shows the splash screen.
- `wireUI()` — attaches all button/event listeners (save, load, delete, export, import, undo, restart, splash, char creation).
- `fetchTextFile(name)` — fetches and caches `.txt` scene files.
- `scheduleStatsRender()` — debounced (rAF) stats panel refresh.

---

### 🧠 Core Layer (`engine/core/` — mapped from project root)

#### `state.js`
Single source of truth for all mutable engine state. All writes go through explicit setter functions; all reads use named exports directly. Key state buckets:

| Variable | Scope | Purpose |
|---|---|---|
| `playerState` | Persistent (saved) | All player vars, inventory, skills, journal |
| `tempState` | Scene-scoped | Cleared on `*goto_scene` |
| `sessionState` | Session (not saved) | Survives scene transitions, cleared on new game/reload |
| `statRegistry` | Persistent | Ordered list of allocatable stats declared via `*create_stat` |
| `currentScene` / `currentLines` / `ip` | Runtime | Interpreter position |
| `awaitingChoice` | Runtime | Holds current choice block while player decides |
| `pendingStatPoints` | Runtime | Unspent stat points from level-ups |
| `levelUpInProgress` | Runtime | True while the level-up modal is open (blocks saving) |
| `pauseState` | Runtime | Active `*pause` / `*delay` / `*input` block state |

#### `expression.js`
Safe, sandboxed expression evaluator — no `eval()`. Converts string expressions from scene directives into values. Features:
- Full tokenizer + recursive-descent parser.
- Supports: arithmetic (`+ - * /`), comparisons (`< > <= >= = !=`), boolean (`and or not`), string literals, variable lookup (searches `tempState → sessionState → playerState`), built-in functions (`random`, `floor`, `ceil`, `round`, `min`, `max`, `len`, `contains`), array indexing.
- On parse error returns `0` (falsy) to prevent "fail open" conditions.

#### `parser.js`
Pure text-in / data-out scene file parser. No DOM, no side effects. Exports:
- `parseLines(text)` → array of `{ raw, trimmed, indent }` line objects.
- `indexLabels(sceneName, lines, labelsCache)` → populates a label→ip map for `*goto` and `*label`.
- `parseChoice(startIndex, indent, ctx)` → structured choice block with options, conditions, and end ip.
- `parseSystemBlock(startIndex, ctx)` → extracts a `*system` block's text.

#### `interpreter.js`
The core execution loop. Dispatches directives from a command registry (Map) rather than a monolithic if-chain. Key exports:
- `runInterpreter()` — advances `ip` line by line, executing directives until a halt condition (choice, end-of-scene, pause).
- `executeBlock(block, resumeAfter)` — runs a specific choice branch then resumes.
- `gotoScene(name)` — loads a new scene, resets `tempState`, runs auto-save.
- `registerCallbacks(cbs)` / `registerCaches(...)` — injected by `engine.js` at boot to avoid circular imports.

**Supported directives** include: `*comment`, `*title`, `*set_game_title`, `*label`, `*goto`, `*goto_scene`, `*create`, `*create_stat`, `*temp`, `*session_set`, `*set`, `*set_stat`, `*if`/`*elseif`/`*else`/`*end_if`, `*choice`, `*system`, `*page_break`, `*ending`, `*loop`/`*end_loop`, `*award_essence`, `*add_essence`, `*add_item`, `*grant_item`, `*remove_item`, `*update_inventory`, `*grant_skill`, `*revoke_skill`, `*if_skill`, `*journal`, `*achievement`, `*pause`, `*delay`, `*input`, `*transition`, `*save_point`, `*patch_state`.

---

### ⚙️ Systems Layer

#### `saves.js`
Save/load/slot management using `localStorage`. Exports:
- `saveGameToSlot(slot)` — serializes full game state to a slot (`auto`, `1`, `2`, `3`). Blocked during level-up.
- `loadSaveFromSlot(slot)` → raw save payload or `null`.
- `restoreFromSave(save, callbacks)` — restores all state and re-renders narrative from the log, including re-rendering choice buttons if saved at a choice point.
- `deleteSaveSlot`, `exportSaveSlot` (downloads JSON file), `importSaveFromJSON`.
- Current save version: **8** (stale saves from earlier versions are rejected cleanly).

#### `inventory.js`
Manages `playerState.inventory` (array of strings). Supports stacked items tracked as `"Item (2)"`, `"Item (3)"`, etc. Exports:
- `addInventoryItem(name)` — adds one unit; increments stack count if item exists.
- `removeInventoryItem(name)` — decrements stack; removes when count reaches zero.
- `parseInventoryUpdateText(text)` — parses `*update_inventory` directive lines like `"+1 Iron Sword"` or `"-2 Health Potion"`.
- `itemBaseName(item)` — strips the `(N)` stack suffix.

#### `leveling.js`
Essence, level-up, and reward parsing. Exports:
- `canLevelUp()` → boolean — true when `essence >= essence_to_next`.
- `performLevelUp(onChanged)` — promotes level, deducts essence, awards stat points, scales `essence_to_next` by `essence_up_mult`. Returns new level or null.
- `applySystemRewards(rewardText, onChanged)` — parses reward strings like `"+1270 Essence"`, `"+5 health"`, `"+1 Iron Sword"` and applies them.
- `getAllocatableStatKeys()` — returns keys from `statRegistry` for the stat allocation UI.

#### `skills.js`
Skill registry and player skill management. Exports:
- `parseSkills(fetchTextFile)` — loads and parses `skills.txt` into `skillRegistry`.
- `grantSkill(key)` / `revokeSkill(key)` — add/remove skills from `playerState.skills`.
- `playerHasSkill(key)` → boolean.
- `purchaseSkill(key)` — deducts Essence cost from `playerState.essence` and grants skill.
- `skillRegistry` — the full ordered array of `{ key, label, essenceCost, description }`.

#### `items.js`
Item registry and purchase logic. Mirrors the skill system pattern. Exports:
- `parseItems(fetchTextFile)` — loads and parses `items.txt` into `itemRegistry`. Gracefully handles missing file (item store disabled).
- `itemRegistry` — array of `{ key, label, essenceCost, description }`.
- `purchaseItem(key)` — deducts Essence, adds item to inventory via `addInventoryItem()`. Items can be purchased multiple times (they stack). Returns true/false.

#### `journal.js`
Lightweight journal and achievements system. Entries live in `playerState.journal` as `{ text, type, timestamp }`. Exports:
- `addJournalEntry(text, type, unique)` — appends entry; `unique=true` deduplicates.
- `getJournalEntries()` → all entries.
- `getAchievements()` → entries where `type === 'achievement'`.

---

### 🖥️ UI Layer

#### `narrative.js`
Narrative panel rendering and choice UI. Exports:
- `addParagraph(text)` — renders a text paragraph with variable interpolation and markdown (`**bold**`, `*italic*`) into `#narrative-content`. HTML-escapes all player-controlled values (XSS protection).
- `addSystem(text)` — renders a styled `[ SYSTEM ]` notification block. Applies Essence highlight (`.essence-block`) and level-up highlight (`.levelup-block`) CSS classes based on content.
- `renderChoices(choices)` — renders choice buttons into `#choice-area`; handles `*selectable_if` conditions, focus management, and a double-click guard.
- `showInputPrompt(variable, promptText)` — renders an inline text input for `*input` directives.
- `showPageBreak()` — renders a `*page_break` divider.
- `clearNarrative()` — wipes the narrative panel.
- `applyTransition(type)` — no-op (CSS transition effects removed for stability).
- `getNarrativeLog()` / `renderFromLog(log)` — serialized log for save/load and undo reconstruction.
- `escapeHtml(str)` — exported shared sanitizer used by `panels.js`.

#### `panels.js`
Status panel (stats, inventory, skills, journal, achievements), level-up modal, store overlay, and ending screen. Exports:
- `runStatsScene()` — re-renders the entire `#status-panel` from current state using `stats.txt` layout directives. Includes "Level Up" button (when eligible) and "◈ Store" button (when skills/items are defined).
- `showLevelUpModal()` — opens a full-screen blocking modal for stat allocation. Calls `performLevelUp()`, presents allocation grid, traps focus, blocks saving. Offers "level again" prompt if still eligible after confirming.
- `showStore()` / `hideStore()` — full-screen store overlay with Skills/Items tabs for spending Essence.
- `showEndingScreen(title, body)` — shows the ending overlay with final stats.

#### `overlays.js`
All overlay and modal flows: splash screen, save/load menu, character creation, and toast notifications. Exports:
- `showSplash()` / `hideSplash()` — title screen overlay.
- `showSaveMenu()` / `hideSaveMenu()` — in-game save/load overlay.
- `showCharacterCreation()` → Promise resolving with `{ firstName, lastName, pronouns }`.
- `wireCharCreation()` — attaches validation listeners to character creation inputs.
- `refreshAllSlotCards()` — syncs all save slot card DOM to localStorage state.
- `loadAndResume(save)` — shared helper for loading a save from either the splash or in-game menu.
- `trapFocus(element)` — keyboard focus containment for accessibility.
- `showToast(message)` — transient notification banner.

---

### 📄 Content / Data Files

#### `startup.txt`
Game initialization script. Declares all starting `playerState` variables via `*create` and `*create_stat` directives, and defines the `*scene_list` (currently just `prologue`). This is the authoritative place to add new global variables and adjust starting values (level scaling multipliers, default stats, etc.). Includes `game_title "System Awakening"`.

#### `stats.txt`
Layout definition for the status panel. Uses directives (`*stat_group`, `*stat`, `*stat_color`, `*stat_registered`, `*inventory`, `*skills_registered`, `*achievements`, `*journal_section`) to specify what appears in the panel and in what order.

#### `skills.txt`
Skill registry definition file. Each `*skill key "Label" cost` block followed by indented description lines defines one purchasable skill. Cost is in Essence. Parsed at boot by `skills.js`.

#### `items.txt`
Item registry definition file. Each `*item key "Label" cost` block followed by indented description lines defines one purchasable item. Cost is in Essence. Items can be purchased multiple times (they stack in inventory). Parsed at boot by `items.js`. File is optional — if missing, the item store tab shows "No items available".

#### `prologue.txt`
The first (and currently only) scene. A full LitRPG interactive fiction scene using all engine directives. Sets the narrative, presents branching choices, awards Essence, updates inventory, and ends with a `*system` reward block and `*ending`. Contains a detailed flow map comment at the top.

---

### 🛠️ Build & Test

#### `index.html`
The single-page application shell. Defines all static DOM: game header, narrative panel, status panel aside, and all overlay markup (splash, save menu, character creation, store overlay, level-up modal, ending screen, toast). Loads `style.css` and `engine.js`.

#### `style.css`
All visual styling — ~2,100 lines. CSS custom properties (variables) for theming (colors, fonts, spacing). Covers: layout, narrative typography, system blocks, choice buttons, status panel, all overlays, level-up modal, store system, toast, scrollbars, responsive/mobile breakpoints, and animations.

#### `build.js`
Optional esbuild bundler. Bundles `engine.js` and all its imports into `dist/engine.js` for production deployment (fewer HTTP requests). Run with `npm run build`. Not required for development.

#### `package.json`
npm project manifest. Scripts: `build` (esbuild bundle), `test` (unit test runner), `test:e2e` (Playwright), `test:all`, `dev` (local static server on port 3000). Dev dependencies: `@playwright/test`, `esbuild`, `serve`.

#### `playwright_config.mjs`
Playwright configuration for end-to-end tests. Configures browser, base URL, and auto-starts the local dev server.

#### `e2e_spec.mjs`
Playwright end-to-end test suite. Boots the game in a real browser and tests: full prologue playthrough, all choice branches, save/load round-trip, undo, and the ending screen. Helper functions: `pickChoice`, `waitForText`, `waitForSystem`.

#### `_gitignore`
Git ignore rules (note: filename lacks the leading `.` — rename to `.gitignore` if not already tracked correctly).

---

## Key Design Patterns

- **No circular imports** — UI callbacks are injected into the core layer at boot via `registerCallbacks()` and `init()` functions.
- **Undo system** — snapshots of full game state + narrative log + awaitingChoice are pushed before each choice; `popUndo` restores directly and re-renders choices from the snapshot without re-running the interpreter (avoiding duplicate auto-saves or duplicate paragraphs).
- **Narrative log** — all rendered content is recorded in a serializable log so narrative can be reconstructed from a save or undo without replaying interpreter logic.
- **XSS protection** — all player-controlled strings are passed through `escapeHtml()` before `innerHTML` insertion.
- **Save versioning** — `SAVE_VERSION = 8`; stale saves are rejected with a clear reason.
- **Manual level-up** — Essence accumulates, status panel shows "Level Up" button when eligible, player opens a full-screen modal for stat allocation. Saving is blocked during level-up.
- **Store system** — Full-screen overlay with Skills/Items tabs. Players spend Essence to unlock skills (one-time) or buy items (stackable). Items use the same inventory stacking as scene-granted items.
