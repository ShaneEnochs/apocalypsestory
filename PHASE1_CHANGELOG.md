# Phase 1 Complete — XP → Essence Rename + Achievements Fix + Game Title System

## Files Modified (13 files)

### Data / Content Files
1. **startup.txt** — Renamed: `xp`→`essence`, `xp_to_next`→`essence_to_next`, `xp_up_mult`→`essence_up_mult`. Removed `skill_points` and `lvl_up_skill_gain`. Added `game_title "System Awakening"`.
2. **stats.txt** — Updated labels: "XP"→"Essence", "XP To Next"→"To Next Level". Removed `skill_points` row.
3. **skills.txt** — Updated comments to reference Essence instead of SP. Format is unchanged (the cost number in the file is now interpreted as Essence cost).
4. **prologue.txt** — Changed all `*system XP gained:` → `*system Essence gained:`. Added explicit `*achievement` directive for "The Last Door" (was only in system block text before).

### Core Layer
5. **state.js** — Updated `_LVL_CONFIG_KEYS` array: `xp_up_mult`→`essence_up_mult`, `xp_to_next`→`essence_to_next`. Removed `lvl_up_skill_gain` from the check.
6. **leveling.js** — Full rewrite. `checkAndApplyLevelUp` no longer auto-levels; it sets `pendingLevelUpDisplay` flag only. Added `canLevelUp()` and `performLevelUp()` functions for the manual system (Phase 2). `applySystemRewards` now matches both "XP" and "Essence" patterns. Removed skill point awarding.
7. **interpreter.js** — Added `*award_essence` and `*add_essence` commands. Kept `*award_xp` and `*add_xp` as backward-compatible aliases. Added `*set_game_title` command. All handlers now write to `playerState.essence`.

### Systems Layer
8. **skills.js** — `spCost`→`essenceCost` in registry. `purchaseSkill` deducts from `playerState.essence` instead of `playerState.skill_points`.
9. **saves.js** — Bumped `SAVE_VERSION` from 6 to 7. Updated comments.

### UI Layer
10. **panels.js** — Updated skill browser: `spCost`→`essenceCost`, badges show "Essence" instead of "SP", affordability checks `playerState.essence`.
11. **narrative.js** — Updated `addSystem` and `renderFromLog` regex to match both "XP" and "Essence" for the amber highlight CSS class.
12. **engine.js** — Added `gameTitle` and `splashTitle` to DOM references. Added `setGameTitle` callback to `registerCallbacks` and `initOverlays`. On boot, applies `game_title` from playerState to header, splash, and document.title.
13. **overlays.js** — Added `setGameTitle` callback to `init()`. `loadAndResume` now restores game title from save payload after restore.

## Achievements Fix
- The prologue had `*system [ ACHIEVEMENT UNLOCKED ] The Last Door — ...` but this was only displayed as text in the system block. The `applySystemRewards` function doesn't parse achievement text.
- Added an explicit `*achievement The Last Door — You carried the weight backward through time.` directive after the system block. This properly adds the entry to `playerState.journal` with `type: 'achievement'`, which the status panel's `*achievements` section renders.

## Backward Compatibility
- `*award_xp` and `*add_xp` still work (aliased to Essence handlers)
- `applySystemRewards` matches both "XP gained:" and "Essence gained:" patterns
- Old saves (v6 and below) will be rejected with the stale-save notice

## Pre-existing Bug Noted (Not Fixed)
- `*check_item` directive used in prologue.txt is not registered in interpreter.js. It's silently skipped. This predates our changes.

## Verification Checklist
- [ ] Game boots without console errors
- [ ] Stats panel shows "Essence" instead of "XP"  
- [ ] Stats panel shows "To Next Level" instead of "XP To Next"
- [ ] `skill_points` row is gone from status panel
- [ ] System blocks showing "Essence gained: +1270" etc. have amber highlighting
- [ ] Essence accumulates correctly through the prologue
- [ ] Old saves are rejected with stale-save notice
- [ ] `*set_game_title "New Name"` changes header, splash, and document.title
- [ ] Game title persists across save/load
- [ ] Achievement "The Last Door" appears in the Achievements section of the status panel after portal crossing
- [ ] Skill browser shows Essence costs (not SP)
- [ ] Level-up still triggers (via pendingLevelUpDisplay flag) — inline widget still works for now (Phase 2 replaces it)

## Lessons Learned for Phase 2
1. The inline level-up widget (`showInlineLevelUp`) is still active and functional. Phase 2 will remove it and replace with the manual modal.
2. `checkAndApplyLevelUp` no longer auto-levels, but the inline widget is still triggered by `pendingLevelUpDisplay`. Phase 2 needs to: (a) remove the inline widget entirely, (b) add the "Level Up" button to the status panel, (c) add the blocking modal.
3. The `pendingStatPoints` / `pendingLevelUpDisplay` / `_pendingLevelUpCount` state variables are still used. Phase 2 will need to rethink this — manual level-ups mean stat points are awarded one level at a time inside the modal, not accumulated.
4. The skill browser inside the inline level-up widget still references `purchaseSkill` — this works correctly with Essence now but the browser will move to the Store in Phase 3.
