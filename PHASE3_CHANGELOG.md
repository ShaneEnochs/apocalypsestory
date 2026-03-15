# Phase 3 Complete — Store System (Skills + Items)

## Summary

Added a Store button to the Status panel that opens a full-screen overlay where players can spend Essence on Skills or Items. Created the item registry system (`items.txt` + `items.js`) mirroring the existing skill system. Added `*grant_item` convenience directive. Bumped save version to 8.

## Files Created (2 files)

### Content
1. **items.txt** — Item registry file. Format mirrors skills.txt: `*item key "Label" cost` with indented description lines. Ships with 5 starter items: Health Potion, Mana Crystal, Shadow Cloak, Iron Charm, Waystone.

### Systems Layer
2. **items.js** — Item registry parser and purchase logic. Exports:
   - `parseItems(fetchTextFileFn)` — Reads items.txt, populates `itemRegistry`. Gracefully handles missing file (item store disabled).
   - `itemRegistry` — Array of `{ key, label, essenceCost, description }`.
   - `purchaseItem(key)` — Deducts Essence from `playerState.essence`, adds item to inventory via `addInventoryItem()`. Items can be purchased multiple times (they stack). Returns true/false.

## Files Modified (6 files)

### Core Layer
3. **interpreter.js** — Added `*grant_item` directive as a convenience alias for `*add_item`. Both add an item to `playerState.inventory` by name.

### Systems Layer
4. **saves.js** — Bumped `SAVE_VERSION` from 7 to 8.

### UI Layer
5. **panels.js** — Major additions:
   - **Import**: Added `itemRegistry` and `purchaseItem` from `items.js`.
   - **init()**: Added `storeOverlay` DOM reference parameter.
   - **runStatsScene()**: Added "◈ Store" button after journal/achievements section. Appears when `skillRegistry` or `itemRegistry` has entries. Wired to `showStore()`.
   - **showStore() / hideStore()**: Full-screen modal overlay with focus trapping and opacity transition.
   - **renderStore()**: Renders the store header (with live Essence count), tab bar (Skills / Items), and active tab content. Close button wired.
   - **renderSkillsTab()**: Shows available skills (with Unlock button + Essence cost badge) and owned skills. Purchase wired through `purchaseSkill()`.
   - **renderItemsTab()**: Shows all items with Buy button + Essence cost badge. Purchase wired through `purchaseItem()`.
   - Tab state (`_storeActiveTab`) preserved across open/close cycles.
   - Store re-renders after each purchase to reflect updated Essence balance and ownership.

### Top-Level Coordinator
6. **engine.js** — 
   - Added `parseItems` import.
   - Added `storeOverlay` to DOM refs object.
   - Added `storeOverlay` to `initPanels()` call.
   - Added `await parseItems(fetchTextFile)` to `boot()` after `parseSkills`.

### HTML / CSS
7. **index.html** — Added `#store-overlay` modal DOM with `.store-modal-box` container, placed before the level-up modal.

8. **style.css** — Added section 17b "Store System" with styles for:
   - `.status-store-btn` — Amber-bordered button in the status panel
   - `.store-modal-box` — Modal container with amber border and glow
   - `.store-header` — Header with system label, Essence pool display, close button
   - `.store-tabs` / `.store-tab` — Tab bar with active state underline
   - `.store-content` — Scrollable content area
   - `.store-card` — Individual skill/item cards with hover, unaffordable, and owned states
   - `.store-cost-badge` / `.store-owned-badge` — Cost and ownership indicators
   - `.store-purchase-btn` — Purchase buttons matching existing amber button pattern
   - Mobile responsive rules at 768px breakpoint

## How the Store System Works

1. **Store button** appears in the status panel when there are skills or items defined (either `skillRegistry` or `itemRegistry` has entries).
2. **Player clicks "◈ Store"** → `showStore()` opens a full-screen modal overlay.
3. **Two tabs**: Skills and Items. Active tab is preserved across open/close cycles.
4. **Skills tab**: Shows available skills (sorted by registry order) with Essence cost badges and "Unlock" buttons. Already-owned skills shown in a separate "Owned" section at reduced opacity. Clicking "Unlock" calls `purchaseSkill()`, deducts Essence, grants the skill, shows a toast, and re-renders.
5. **Items tab**: Shows all items with Essence cost badges and "Buy" buttons. Items can be purchased multiple times (they stack in inventory). Clicking "Buy" calls `purchaseItem()`, deducts Essence, adds to inventory, shows toast, and re-renders.
6. **Affordability**: Cards and buttons for items/skills the player can't afford are dimmed. Purchase buttons are disabled.
7. **Close**: Close button (✕) or focus trap keeps interaction within the modal. Closing refreshes the status panel.

## Verification Checklist
- [ ] Store button visible in status panel
- [ ] Store opens and shows Skills tab and Items tab
- [ ] Skills show correct Essence costs
- [ ] Purchasing a skill deducts Essence, grants skill, updates panel
- [ ] Cannot purchase skill you already own (shown as "Owned")
- [ ] Cannot purchase if insufficient Essence (dimmed + disabled)
- [ ] Items tab shows items from items.txt
- [ ] Purchasing an item deducts Essence, adds to inventory
- [ ] Items can be purchased multiple times (stack)
- [ ] Store can be closed and returns to normal game view
- [ ] Tab state preserved across open/close
- [ ] Save/load preserves purchased items and skills
- [ ] Old saves (v7 and below) rejected with stale-save notice
- [ ] `*grant_item` directive works in scene files
- [ ] No console errors on boot
- [ ] Focus trapped inside store modal
- [ ] Mobile responsive layout works

## Backward Compatibility
- `*add_item` still works as before; `*grant_item` is a new alias
- Old saves (v7) rejected cleanly due to SAVE_VERSION bump to 8
- items.txt is optional — if missing, the item store tab shows "No items available"

## New Directives
- `*grant_item itemName` — Adds an item to inventory by name (alias for `*add_item`)

## Lessons Learned for Phase 4
1. The store overlay follows the same pattern as the level-up modal (full-screen overlay, focus trap, opacity transition). This pattern could be extracted into a shared `showModal()` utility.
2. The store re-renders fully on each purchase. For large registries, incremental DOM updates would be more efficient, but for the current scale this is fine.
3. Items purchased through the store use `addInventoryItem()` which stacks by label name. The item registry key is separate from the inventory label — this is intentional so items from different sources (store vs scene rewards) with the same label stack together.
