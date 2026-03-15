# Phase 4 Complete — Polish Pass

## Summary

Codebase-wide cleanup pass: renamed the last XP-era CSS class, removed dead CSS from the old inline level-up widget, fixed stale comments across multiple files, and rewrote PROJECT_REFERENCE.md to reflect all Phase 1–3 changes.

No functional changes. No save version bump. No new features.

## Files Modified (5 files)

### UI Layer
1. **narrative.js** — Renamed CSS class `xp-block` → `essence-block` in both `addSystem()` (line 190) and `renderFromLog()` case `'system'` (line 425). This was the last user-facing remnant of the pre-Phase-1 "XP" naming. The class applies amber highlighting to Essence reward system blocks.

2. **style.css** — Three categories of changes:
   - **Renamed**: `.system-block.xp-block` → `.system-block.essence-block` (2 rules + comment). Section comment updated from "XP variant" to "Essence variant".
   - **Removed dead CSS** from the old inline level-up widget (removed in Phase 2's `showInlineLevelUp()` deletion):
     - `.levelup-inline-header` / `.levelup-inline-header strong` — old inline widget header
     - `.levelup-inline-footer` — old inline widget footer
     - `.levelup-choice-overlay` / `.levelup-choice-overlay span::before` — overlay that blocked choices during inline allocation
     - `.levelup-inline-block .stat-alloc-item.selected` — inline-specific override (the modal uses `.stat-alloc-item.selected` without the parent selector)
     - Mobile responsive rules for `.levelup-inline-header` and `.levelup-inline-footer` at the 768px breakpoint
   - **Kept** (still used): `.levelup-inline-block` base class (used by `renderFromLog` for `levelup_confirmed` entries), `.levelup-inline-block--confirmed`, `.levelup-confirmed-text`, `.levelup-confirm-btn` / `--locked`, `.levelup-points-remaining`.
   - Updated section comment from "Inline level-up block" to "Level-up confirmed block (rendered in narrative log after stat allocation)".

### Systems Layer
3. **interpreter.js** — Fixed stale dependency graph comment in the file header. Line 19 referenced `→ leveling.js (checkAndApplyLevelUp)` which was removed in Phase 2. Updated to `→ leveling.js (canLevelUp, performLevelUp, applySystemRewards)`.

4. **saves.js** — Updated stale version comments in the file header:
   - Rewrote header to show version history (v7: Essence, v8: Store) instead of a single outdated "SAVE_VERSION 7" block.
   - Fixed `FIX #S4` comment which still said "bumped to 5".
   - Updated `buildSavePayload` and `restoreFromSave` doc comments from "v7" to "v8".

### Documentation
5. **PROJECT_REFERENCE.md** — Full rewrite to reflect the current state after Phases 1–3. Key updates:
   - Added `items.js` and `items.txt` to Systems Layer section.
   - Updated `skills.js` to show `essenceCost` (was `spCost`) and `purchaseSkill` deducting Essence (was `skill_points`).
   - Updated `leveling.js` to show `canLevelUp()` and `performLevelUp()` (removed `checkAndApplyLevelUp()`).
   - Updated `saves.js` to show `SAVE_VERSION = 8` (was 6) and note saving blocked during level-up.
   - Updated `panels.js` to document `showLevelUpModal()`, `showStore()` / `hideStore()`, and the "Level Up" / "◈ Store" buttons (removed `showInlineLevelUp()`).
   - Updated `narrative.js` to document `.essence-block` CSS class (was `.xp-block`).
   - Updated `engine.js` boot sequence to include `parseItems`.
   - Updated `index.html` description to include store overlay and level-up modal DOM.
   - Updated `state.js` table to include `levelUpInProgress` (removed `pendingLevelUpDisplay`, `_pendingLevelUpCount`).
   - Updated directive list in `interpreter.js` to include `*set_game_title`, `*award_essence`, `*add_essence`, `*add_item`, `*grant_item`, `*remove_item`, `*session_set`, `*save_point`, `*patch_state` (removed `*award_xp`, `*add_xp`).
   - Updated Key Design Patterns to document manual level-up and store system.

## Verification Checklist
- [ ] `grep -rn 'xp-block' *.js *.css` returns zero matches
- [ ] `grep -rn 'xp_block' *.js *.css` returns zero matches
- [ ] `grep -rn 'checkAndApplyLevelUp' *.js` returns zero matches
- [ ] `grep -rn 'showInlineLevelUp' *.js` returns zero matches
- [ ] `grep -rn 'skill_points' *.js *.txt` returns zero matches (excluding comments)
- [ ] `grep -rn 'spCost' *.js` returns zero matches
- [ ] System blocks with Essence rewards still have amber highlighting
- [ ] Level-up confirmed blocks in narrative log still render correctly (green, dimmed)
- [ ] Level-up modal still works (confirm button, stat allocation, "level again" prompt)
- [ ] Store overlay still works (both tabs, purchase flow)
- [ ] No console errors on boot
- [ ] Save/load round-trip works
- [ ] Undo works
