# Phase 2 Complete — Manual Level-Up System + Backward Compat Removal

## Summary

Replaced the automatic inline level-up widget with a manual "Level Up" button in the Status panel that opens a full-screen blocking modal for stat allocation. Removed all XP backward compatibility (aliases, regex patterns) per user request. All 184 unit tests pass.

## Files Modified (11 files)

### Core Layer
1. **state.js** — Added `levelUpInProgress` flag and `setLevelUpInProgress()` setter. Removed `pendingLevelUpDisplay`, `_pendingLevelUpCount`, `setPendingLevelUpDisplay()`, `setPendingLevelUpCount()`, and `addPendingLevelUpCount()`.
2. **interpreter.js** — Removed `*award_xp` and `*add_xp` command aliases (backward compat removed). Removed `checkAndApplyLevelUp` import. Removed `pendingLevelUpDisplay` import. Removed `showInlineLevelUp` call from `runInterpreter()`. Updated `_handleAddEssence` to no longer call `checkAndApplyLevelUp`.
3. **leveling.js** — Removed `checkAndApplyLevelUp()` entirely (the status panel now checks `canLevelUp()` on every render instead). Removed backward-compat XP regex patterns from `applySystemRewards` — only "Essence" patterns are matched now. Removed `addPendingLevelUpCount` and `setPendingLevelUpDisplay` imports.

### Systems Layer
4. **saves.js** — `saveGameToSlot()` now blocks saves when `levelUpInProgress` is true (logs warning, returns early). Removed `showInlineLevelUp` from `restoreFromSave()` parameter list and choice-restore logic. Removed `setPendingLevelUpDisplay` import/usage.
5. **skills.js** — No changes needed (already correct from Phase 1).

### UI Layer
6. **panels.js** — **Removed** `showInlineLevelUp()` entirely (200+ lines). **Added** `showLevelUpModal()` — a full-screen blocking modal that: calls `performLevelUp()` to execute the level-up, presents the stat allocation grid, traps focus, sets `levelUpInProgress` to block saving, and only closes on Confirm when all points are spent. **Added** "Level Up" button to `runStatsScene()` output — appears when `canLevelUp()` returns true and `levelUpInProgress` is false. Updated `init()` — removed `narrativeContent`/`choiceArea` (no longer needed), added `levelUpOverlay` DOM ref and `showToast` callback.
7. **narrative.js** — Removed `pendingLevelUpDisplay` and `pendingStatPoints` imports. Removed `_onShowLevelUp` callback from init and module state. Removed level-up choice-disabling logic from `renderChoices()` (the `levelUpActive` check, the temporary disable branch, and the associated comments). Removed level-up trigger from `addSystem()`. Updated Essence highlight regex to remove XP patterns.
8. **overlays.js** — Removed `_showInlineLevelUp` callback from module state, `init()` parameters, and `loadAndResume()` restoreFromSave call.
9. **engine.js** — Updated imports: replaced `showInlineLevelUp` with `showLevelUpModal`, added `levelUpInProgress`, removed `setPendingLevelUpDisplay`. Added `levelUpOverlay` to DOM refs. Removed `showInlineLevelUp` from `initNarrative()`, `initPanels()`, `initOverlays()`, and `registerCallbacks()`. Added `showToast` and `levelUpOverlay` to `initPanels()`. Save button handler now blocks during level-up with a toast. `popUndo()` no longer calls `setPendingLevelUpDisplay`.

### HTML / CSS
10. **index.html** — Added `#levelup-overlay` modal DOM with `.levelup-modal-box` container, placed before the ending screen overlay.
11. **style.css** — Added styles for: `.status-levelup-btn` (green full-width button in status panel), `.levelup-modal-box` (modal container with green border and glow), `.levelup-modal-header/title/subtitle/footer` (modal layout). Added mobile responsive rules for the modal at the 768px breakpoint.

### Tests
12. **test_runner.mjs** — Removed `checkAndApplyLevelUp` import (function deleted). Removed `setPendingLevelUpDisplay` and `setPendingLevelUpCount` imports (state vars deleted). Removed legacy XP pattern test (backward compat removed). Updated leveling test to use `canLevelUp()` only (no `checkAndApplyLevelUp`).

## Backward Compatibility Removed

Per user request, all XP backward compatibility was removed:
- `*award_xp` and `*add_xp` directives no longer registered — scene files must use `*award_essence` / `*add_essence`
- `applySystemRewards` no longer matches "XP gained:" or "+N XP" patterns — only "Essence gained:" and "+N Essence"
- Narrative highlight regex in `addSystem` and `renderFromLog` only matches "Essence" (not "XP")

## How the Manual Level-Up System Works

1. **Essence accumulates** as the player progresses through scenes (via `*award_essence`, system block rewards, etc.)
2. **Status panel checks** `canLevelUp()` on every `runStatsScene()` render. When `essence >= essence_to_next`, a green "⬡ Level Up" button appears.
3. **Player clicks "Level Up"** → `showLevelUpModal()` is called:
   - Calls `performLevelUp()` which deducts essence, increments level, scales threshold, awards stat points
   - Sets `levelUpInProgress = true` (blocks saving)
   - Opens a full-screen modal with focus trapping
   - Shows "Level N → Level N+1" header with stat allocation grid
   - Confirm button only enabled when all points are spent
4. **Player confirms** → stats are applied, modal closes, `levelUpInProgress = false`, stats panel refreshes, toast shown
5. **If still eligible** after one level-up (enough essence for another), the button reappears on the next panel render
6. **Saving is blocked** during level-up: `saveGameToSlot()` returns early, save button shows a toast

## Verification Checklist
- [ ] No auto-level-ups occur when essence exceeds threshold
- [ ] "Level Up" button appears in status panel when eligible
- [ ] Clicking "Level Up" opens a modal with stat allocation
- [ ] Cannot interact with anything behind the modal (focus trapped)
- [ ] Cannot save during level-up (save button shows toast)
- [ ] Confirm applies stats, closes modal, refreshes panel
- [ ] Button disappears after leveling if no longer eligible
- [ ] Button reappears if still eligible after one level-up
- [ ] Undo still works (undo snapshots capture essence correctly)
- [ ] Save/load round-trip works
- [ ] 184/184 unit tests pass
- [ ] No console errors on boot

## State Variables Changed

| Removed | Added |
|---|---|
| `pendingLevelUpDisplay` | `levelUpInProgress` |
| `_pendingLevelUpCount` | |
| `setPendingLevelUpDisplay()` | `setLevelUpInProgress()` |
| `setPendingLevelUpCount()` | |
| `addPendingLevelUpCount()` | |

## Functions Changed

| Removed | Added/Changed |
|---|---|
| `showInlineLevelUp()` (panels.js) | `showLevelUpModal()` (panels.js) |
| `checkAndApplyLevelUp()` (leveling.js) | Status panel checks `canLevelUp()` directly |
| `*award_xp` handler (interpreter.js) | — |
| `*add_xp` handler (interpreter.js) | — |
