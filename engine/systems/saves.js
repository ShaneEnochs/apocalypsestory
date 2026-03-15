// ---------------------------------------------------------------------------
// systems/saves.js — Save / load / slot management
//
// Handles localStorage serialisation and deserialisation of game state.
// DOM slot-card rendering lives in ui/overlays.js (moved in Phase 4).
//
// Save version: bump SAVE_VERSION whenever the payload shape changes so stale
// saves are rejected cleanly rather than silently corrupting state.
//
// Phase 3 changes:
//   • SAVE_VERSION bumped to 4. v3 saves are rejected by loadSaveFromSlot and
//     show the stale-save banner — no migration code needed.
//   • buildSavePayload now accepts a narrativeLog parameter and stores it in
//     the payload. pauseState and chapterTitle are also persisted.
//   • saveGameToSlot accepts an optional narrativeLog argument.
//   • restoreFromSave is rewritten to use the no-replay approach: it paints
//     the DOM from the saved narrative log via renderFromLog, sets ip to the
//     saved position, and re-presents any pause UI (page_break / input / delay)
//     directly — no gotoScene call, no interpreter replay.
//
// BUG-05 fix: restoreFromSave now accepts and calls a setChoiceArea callback
// after renderFromLog, mirroring what popUndo already does in engine.js.
// Without this, narrative.js's internal _choiceArea pointer is stale after a
// mid-session load, causing renderChoices to insert buttons into a detached node.
// ---------------------------------------------------------------------------

import {
  playerState, tempState, pendingStatPoints, currentScene, ip,
  chapterTitle,
  setPlayerState, setPendingStatPoints, setPendingLevelUpDisplay,
  setCurrentScene, setCurrentLines, setIp, setDelayIndex,
  setAwaitingChoice,
  clearTempState, parseStartup,
  pauseState, setPauseState, clearPauseState,
  setChapterTitleState,
} from '../core/state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SAVE_VERSION  = 4;

export const SAVE_KEY_AUTO  = 'sa_save_auto';
export const SAVE_KEY_SLOTS = { 1: 'sa_save_slot_1', 2: 'sa_save_slot_2', 3: 'sa_save_slot_3' };

export function saveKeyForSlot(slot) {
  return slot === 'auto' ? SAVE_KEY_AUTO : (SAVE_KEY_SLOTS[slot] ?? null);
}

// ---------------------------------------------------------------------------
// _staleSaveFound — set to true by loadSaveFromSlot when a version-mismatched
// save is encountered. Read by showSplash() to display the stale-save banner.
// Only shown once per boot; cleared after the banner fires.
// ---------------------------------------------------------------------------
export let _staleSaveFound = false;
export function clearStaleSaveFound() { _staleSaveFound = false; }
export function setStaleSaveFound()   { _staleSaveFound = true;  }

// ---------------------------------------------------------------------------
// buildSavePayload — constructs the v4 object written to localStorage.
//
// narrativeLog: the current narrative log array from getNarrativeLog().
//   Passed explicitly so saves.js has no direct import of narrative.js
//   (which would create a circular dependency).
// ---------------------------------------------------------------------------
export function buildSavePayload(slot, label, narrativeLog) {
  return {
    version:       SAVE_VERSION,
    slot:          String(slot),
    scene:         currentScene,
    label:         label ?? null,
    ip,                                       // exact ip at time of save
    chapterTitle,                             // state-side mirror of DOM title
    pauseState:    pauseState ?? null,        // page_break / delay / input context
    characterName: `${playerState.first_name || ''} ${playerState.last_name || ''}`.trim() || 'Unknown',
    playerState:   JSON.parse(JSON.stringify(playerState)),
    pendingStatPoints,
    narrativeLog:  JSON.parse(JSON.stringify(narrativeLog ?? [])),
    timestamp:     Date.now(),
  };
}

// ---------------------------------------------------------------------------
// saveGameToSlot — serialises and persists the current state to a slot.
// Slot can be 'auto', 1, 2, or 3.
//
// narrativeLog must be passed by the caller (engine.js / interpreter.js) so
// saves.js stays free of a direct narrative.js import.
// ---------------------------------------------------------------------------
export function saveGameToSlot(slot, label = null, narrativeLog = []) {
  const key = saveKeyForSlot(slot);
  if (!key) { console.warn(`[saves] Unknown save slot: "${slot}"`); return; }
  try {
    localStorage.setItem(key, JSON.stringify(buildSavePayload(slot, label, narrativeLog)));
  } catch (err) {
    console.warn(`[saves] Save to slot "${slot}" failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// loadSaveFromSlot — deserialises a save from localStorage.
// Returns null if the slot is empty or the version doesn't match.
// Sets _staleSaveFound if a version mismatch is detected.
// ---------------------------------------------------------------------------
export function loadSaveFromSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const save = JSON.parse(raw);
    if (save.version !== SAVE_VERSION) {
      console.warn(`[saves] Slot "${slot}" version mismatch (v${save.version}) — discarding.`);
      setStaleSaveFound();
      return null;
    }
    return save;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// deleteSaveSlot — removes a save from localStorage
// ---------------------------------------------------------------------------
export function deleteSaveSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (key) try { localStorage.removeItem(key); } catch (_) {}
}

// ---------------------------------------------------------------------------
// restoreFromSave — applies a v4 save payload to live engine state.
//
// The no-replay approach:
//   1. Re-parse startup to establish fresh variable defaults.
//   2. Merge saved playerState over fresh defaults.
//   3. Parse and cache the saved scene's lines (needed if undo or gotoScene
//      ever needs to replay from this point).
//   4. Restore ip, scene, chapterTitle, delayIndex, awaitingChoice.
//   5. Render narrative from saved log via renderFromLog — instant, no
//      interpreter execution, no applySystemRewards calls.
//   5b. Re-point narrative.js's _choiceArea at the live DOM element. (BUG-05)
//   6. Re-present any pause UI (page_break / input / delay) from pauseState,
//      or re-render choices if awaitingChoice was saved.
//   7. Run the stats panel.
//
// All callbacks are injected to avoid circular imports.
// ---------------------------------------------------------------------------
export async function restoreFromSave(save, {
  runStatsScene,
  renderFromLog,
  renderChoices,
  showInlineLevelUp,
  showPageBreak,
  showInputPrompt,
  runInterpreter,
  clearNarrative,
  applyTransition,
  setChapterTitle,
  setChoiceArea,         // BUG-05: injected so we can re-point _choiceArea after renderFromLog
  parseAndCacheScene,
  fetchTextFileFn,
  evalValueFn,
}) {
  // 1. Re-parse startup to establish fresh defaults.
  await parseStartup(fetchTextFileFn, evalValueFn);

  // 2. Merge saved playerState over fresh defaults. Filter to keys that exist
  //    after the fresh parseStartup so variables removed from startup.txt in a
  //    newer version are actually dropped rather than re-introduced.
  const freshKeys     = new Set(Object.keys(playerState));
  const savedFiltered = {};
  for (const [k, v] of Object.entries(save.playerState)) {
    if (freshKeys.has(k)) savedFiltered[k] = v;
  }
  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(savedFiltered)) });

  // 3. Restore pending stat points and arm the level-up display flag if needed.
  const savedPoints = save.pendingStatPoints ?? 0;
  setPendingStatPoints(savedPoints);
  if (savedPoints > 0) setPendingLevelUpDisplay(true);
  clearTempState();

  // 4. Parse and cache the saved scene's lines so ip is meaningful and
  //    any future gotoScene / undo operations have a live currentLines array.
  await parseAndCacheScene(save.scene);
  setCurrentScene(save.scene);
  setIp(save.ip ?? 0);
  setDelayIndex(0);
  setAwaitingChoice(null);
  clearPauseState();

  // 5. Restore chapter title — both DOM and state field.
  if (save.chapterTitle) {
    setChapterTitle(save.chapterTitle);      // updates DOM + setChapterTitleState via engine.js callback
  }

  // 6. Render narrative from the saved log — pure DOM paint, no side effects.
  clearNarrative();
  applyTransition();
  renderFromLog(save.narrativeLog ?? [], { skipAnimations: true });

  // BUG-05 fix: renderFromLog clears and rebuilds the DOM, so the internal
  // _choiceArea pointer inside narrative.js is now pointing at a stale element.
  // Re-acquire the live #choice-area from the DOM and pass it to setChoiceArea
  // so that subsequent renderChoices() calls insert buttons in the right place.
  // (popUndo in engine.js already does this — this call makes restoreFromSave
  // consistent with that behaviour.)
  if (typeof setChoiceArea === 'function') {
    setChoiceArea(document.getElementById('choice-area'));
  }

  // 7. Run stats panel.
  await runStatsScene();

  // 8. Re-present pause UI or choices.
  //
  // pauseState takes priority — it means the interpreter was halted mid-scene
  // at a *page_break, *input, or *delay directive. We restore that UI and
  // wire up continuation so the player can resume from exactly that point.
  if (save.pauseState) {
    const ps = save.pauseState;
    setPauseState(ps);
    setIp(ps.resumeIp);

    switch (ps.type) {
      case 'page_break':
        showPageBreak(ps.btnText, () => {
          clearPauseState();
          clearNarrative();
          applyTransition();
          runInterpreter();
        });
        break;

      case 'input':
        showInputPrompt(ps.varName, ps.prompt, (value) => {
          clearPauseState();
          // Mirror the same tempState-first logic as the live *input handler
          // in interpreter.js — the variable may live in either store.
          if (Object.prototype.hasOwnProperty.call(tempState, ps.varName)) {
            tempState[ps.varName] = value;
          } else {
            playerState[ps.varName] = value;
          }
          runInterpreter();
        });
        break;

      case 'delay':
        // The delay has already elapsed during the player's absence; resume now.
        clearPauseState();
        runInterpreter();
        break;
    }
  } else {
    // No pause state — run the interpreter from the saved ip. It will
    // immediately hit the *choice (or *ending etc.) at that position
    // and render choices / end screen without replaying any narrative text
    // (that's already on screen from renderFromLog).
    //
    // If pendingStatPoints > 0, showInlineLevelUp will be called by
    // runInterpreter → renderChoices → pendingLevelUpDisplay check.
    await runInterpreter();
  }
}
