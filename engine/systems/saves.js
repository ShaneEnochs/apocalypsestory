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
//   after renderFromLog, mirroring what popUndo already does in engine.js.
//
// FIX #12 (sweep 2): exportSaveSlot no longer appends the <a> element to
//   document.body before clicking. In all modern browsers (Chrome 60+,
//   Firefox 58+, Safari 10.1+), a detached anchor's .click() triggers the
//   download without needing to be in the DOM. The append/removeChild pair
//   caused a brief DOM flash on slow machines and is unnecessary.
//
// FIX #S4 (sweep 3): SAVE_VERSION bumped to 5. buildSavePayload now persists
//   sessionState and statRegistry in the save payload.
//   • sessionState: variables promoted via *persist survive *goto_scene but
//     were silently lost on any page reload because they weren't saved.
//     Cross-scene decisions (cutscene flags, chapter-level choices) now
//     survive save/load cycles correctly.
//   • statRegistry: if a scene file declares *create_stat at runtime (not in
//     startup.txt), those entries are wiped by the parseStartup() call in
//     restoreFromSave. Persisting and restoring statRegistry prevents the
//     level-up allocation screen from showing fewer stats than expected after
//     a load.
//   restoreFromSave now restores both fields from the payload, with graceful
//   fallbacks for older saves that lack them.
//
// FIX #S5 (sweep 3): All three runInterpreter() calls in the pauseState
//   resume branches of restoreFromSave now use .catch() so errors are not
//   silently swallowed as unhandled promise rejections. This mirrors FIX #2
//   already applied to the live *input / *delay / *page_break handlers in
//   interpreter.js, which was missed in the save-restore path.
// ---------------------------------------------------------------------------

import {
  playerState, tempState, pendingStatPoints, currentScene, ip,
  chapterTitle, statRegistry,
  setPlayerState, setPendingStatPoints, setPendingLevelUpDisplay,
  setStatRegistry,
  setCurrentScene, setCurrentLines, setIp, setDelayIndex,
  setAwaitingChoice,
  clearTempState, parseStartup,
  pauseState, setPauseState, clearPauseState,
  setChapterTitleState,
  sessionState, setSessionState,
} from '../core/state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// FIX #S4: bumped to 5 — payload now includes sessionState and statRegistry.
export const SAVE_VERSION  = 5;

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
// buildSavePayload — constructs the v5 object written to localStorage.
//
// narrativeLog: the current narrative log array from getNarrativeLog().
//   Passed explicitly so saves.js has no direct import of narrative.js
//   (which would create a circular dependency).
//
// FIX #S4: now includes sessionState and statRegistry in the payload so they
//   survive save/load cycles.
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
    sessionState:  JSON.parse(JSON.stringify(sessionState)),  // FIX #S4
    statRegistry:  JSON.parse(JSON.stringify(statRegistry)),  // FIX #S4
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
// exportSaveSlot — triggers a browser download of the slot's save as JSON.
// Returns true on success, false if the slot is empty. (ENH-10)
//
// FIX #12: The <a> element no longer needs to be appended to document.body
//   before calling .click(). Modern browsers trigger the download from a
//   detached anchor. The old append+removeChild caused a brief DOM flash
//   on slow machines and is entirely unnecessary.
// ---------------------------------------------------------------------------
export function exportSaveSlot(slot) {
  const save = loadSaveFromSlot(slot);
  if (!save) return false;

  const safeName = (save.characterName || 'Unknown').replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');
  const filename = `sa-save-slot${slot}-${safeName}.json`;
  const blob     = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = filename;
  // FIX #12: call .click() directly — no DOM append/removeChild needed
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// ---------------------------------------------------------------------------
// importSaveFromJSON — validates a parsed save object and writes it to a slot.
//
// Returns { ok: true } on success, { ok: false, reason: string } on failure.
// Does NOT restore/load — the caller is responsible for that. (ENH-10)
// ---------------------------------------------------------------------------
export function importSaveFromJSON(json, targetSlot) {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    return { ok: false, reason: 'File is not a valid JSON object.' };
  if (json.version !== SAVE_VERSION)
    return { ok: false, reason: `Save version mismatch (file is v${json.version}, engine expects v${SAVE_VERSION}).` };
  if (!json.playerState || typeof json.playerState !== 'object')
    return { ok: false, reason: 'Save file is missing playerState.' };
  if (!json.scene || typeof json.scene !== 'string')
    return { ok: false, reason: 'Save file is missing scene name.' };

  const key = saveKeyForSlot(targetSlot);
  if (!key) return { ok: false, reason: `Invalid target slot: "${targetSlot}".` };

  // Stamp slot field to match the chosen target
  const patched = { ...json, slot: String(targetSlot) };
  try {
    localStorage.setItem(key, JSON.stringify(patched));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `localStorage write failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// restoreFromSave — applies a v5 save payload to live engine state.
//
// The no-replay approach:
//   1. Re-parse startup to establish fresh variable defaults.
//   2. Merge saved playerState over fresh defaults.
//   3. Restore statRegistry from the save (FIX #S4) so runtime-registered
//      stats from scene files survive the load cycle.
//   4. Restore sessionState from the save (FIX #S4) so *persist vars survive.
//   5. Parse and cache the saved scene's lines so ip is meaningful and
//      any future gotoScene / undo operations have a live currentLines array.
//   6. Render narrative from saved log via renderFromLog — instant, no
//      interpreter execution, no applySystemRewards calls.
//   6b. Re-point narrative.js's _choiceArea at the live DOM element. (BUG-05)
//   7. Run the stats panel.
//   8. Re-present pause UI or choices.
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

  // FIX #S4: Restore statRegistry from save so runtime-registered stats (from
  // scene-level *create_stat directives) are not lost. parseStartup() only
  // registers stats from startup.txt; any additional stats added at runtime
  // must come from the save. Merge: startup-derived entries are the base,
  // saved entries that are NOT already in the fresh registry are appended.
  if (Array.isArray(save.statRegistry) && save.statRegistry.length > 0) {
    const freshKeys = new Set(statRegistry.map(e => e.key));
    const extra = save.statRegistry.filter(e => !freshKeys.has(e.key));
    if (extra.length > 0) {
      setStatRegistry([...statRegistry, ...extra]);
    }
  }

  // FIX #S4: Restore sessionState from save so *persist variables survive
  // page reloads. Graceful fallback: if the field is absent (old save format),
  // sessionState stays as the empty object set by parseStartup.
  if (save.sessionState && typeof save.sessionState === 'object' && !Array.isArray(save.sessionState)) {
    setSessionState(JSON.parse(JSON.stringify(save.sessionState)));
  }

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
    setChapterTitle(save.chapterTitle);
  }

  // 6. Render narrative from the saved log — pure DOM paint, no side effects.
  clearNarrative();
  applyTransition();
  renderFromLog(save.narrativeLog ?? [], { skipAnimations: true });

  // BUG-05 fix: renderFromLog clears and rebuilds the DOM, so the internal
  // _choiceArea pointer inside narrative.js is now pointing at a stale element.
  // Re-acquire the live #choice-area from the DOM and pass it to setChoiceArea
  // so that subsequent renderChoices() calls insert buttons in the right place.
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
          // FIX #S5: .catch() so errors are not swallowed as silent rejections.
          runInterpreter().catch(err => console.error('[saves] runInterpreter error after page_break restore:', err));
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
          setIp(ps.resumeIp);
          // FIX #S5: .catch() so errors are not swallowed as silent rejections.
          runInterpreter().catch(err => console.error('[saves] runInterpreter error after input restore:', err));
        });
        break;

      case 'delay':
        // Delay already elapsed — resume immediately.
        clearPauseState();
        setIp(ps.resumeIp);
        // FIX #S5: .catch() so errors are not swallowed as silent rejections.
        runInterpreter().catch(err => console.error('[saves] runInterpreter error after delay restore:', err));
        break;
    }
    return;
  }

  // If no pause state, re-render awaitingChoice if it was saved.
  if (save.awaitingChoice) {
    setAwaitingChoice(save.awaitingChoice);
    renderChoices(save.awaitingChoice.choices);
    if (savedPoints > 0) showInlineLevelUp();
  }
}
