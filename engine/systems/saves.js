// ---------------------------------------------------------------------------
// systems/saves.js — Save / load / slot management
//
// SAVE_VERSION history:
//   v7: Essence replaces XP/skill_points. game_title added.
//   v8: Store system (items.txt, item purchases).
//
// FIX #S6 (sweep 5): buildSavePayload now persists awaitingChoice in the
//   payload. Previously, loading a save taken at a choice point would show
//   the narrative text but no choice buttons — restoreFromSave step 8
//   checked save.awaitingChoice which was always undefined because it was
//   never written into the payload.
//
// (All earlier fix comments preserved below.)
//
// FIX #S4 (sweep 3): buildSavePayload now persists sessionState and
//   statRegistry in the save payload.
// FIX #S5 (sweep 3): All three runInterpreter() calls in the pauseState
//   resume branches of restoreFromSave now use .catch().
// FIX #12 (sweep 2): exportSaveSlot no longer appends <a> to document.body.
// BUG-05 fix: restoreFromSave accepts and calls setChoiceArea after renderFromLog.
// ---------------------------------------------------------------------------

import {
  playerState, tempState, pendingStatPoints, currentScene, ip,
  chapterTitle, statRegistry,
  awaitingChoice, levelUpInProgress,
  setPlayerState, setPendingStatPoints,
  setStatRegistry,
  setCurrentScene, setCurrentLines, setIp,
  setAwaitingChoice,
  clearTempState, parseStartup,
  pauseState, setPauseState, clearPauseState,
  setChapterTitleState,
  sessionState, setSessionState,
} from '../core/state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// FIX #S6: bumped to 8 — Phase 3: Store system (items.txt, item purchases).
export const SAVE_VERSION  = 8;

export const SAVE_KEY_AUTO  = 'sa_save_auto';
export const SAVE_KEY_SLOTS = { 1: 'sa_save_slot_1', 2: 'sa_save_slot_2', 3: 'sa_save_slot_3' };

export function saveKeyForSlot(slot) {
  return slot === 'auto' ? SAVE_KEY_AUTO : (SAVE_KEY_SLOTS[slot] ?? null);
}

// ---------------------------------------------------------------------------
// _staleSaveFound
// ---------------------------------------------------------------------------
export let _staleSaveFound = false;
export function clearStaleSaveFound() { _staleSaveFound = false; }
export function setStaleSaveFound()   { _staleSaveFound = true;  }

// ---------------------------------------------------------------------------
// buildSavePayload — constructs the v8 object written to localStorage.
//
// FIX #S6: now includes awaitingChoice so that loading a save taken at a
//   choice point can re-render the buttons via restoreFromSave step 8.
// ---------------------------------------------------------------------------
export function buildSavePayload(slot, label, narrativeLog) {
  return {
    version:        SAVE_VERSION,
    slot:           String(slot),
    scene:          currentScene,
    label:          label ?? null,
    ip,
    chapterTitle,
    pauseState:     pauseState ?? null,
    awaitingChoice: awaitingChoice
      ? JSON.parse(JSON.stringify(awaitingChoice))
      : null,                                            // FIX #S6
    characterName:  `${playerState.first_name || ''} ${playerState.last_name || ''}`.trim() || 'Unknown',
    playerState:    JSON.parse(JSON.stringify(playerState)),
    sessionState:   JSON.parse(JSON.stringify(sessionState)),
    statRegistry:   JSON.parse(JSON.stringify(statRegistry)),
    pendingStatPoints,
    narrativeLog:   JSON.parse(JSON.stringify(narrativeLog ?? [])),
    timestamp:      Date.now(),
  };
}

// ---------------------------------------------------------------------------
// saveGameToSlot
// ---------------------------------------------------------------------------
export function saveGameToSlot(slot, label = null, narrativeLog = []) {
  if (levelUpInProgress) {
    console.warn('[saves] Save blocked — level-up in progress.');
    return;
  }
  const key = saveKeyForSlot(slot);
  if (!key) { console.warn(`[saves] Unknown save slot: "${slot}"`); return; }
  try {
    localStorage.setItem(key, JSON.stringify(buildSavePayload(slot, label, narrativeLog)));
  } catch (err) {
    console.warn(`[saves] Save to slot "${slot}" failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// loadSaveFromSlot
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
      // Delete the stale save so the notice doesn't re-appear on every reload
      try { localStorage.removeItem(key); } catch (_) {}
      return null;
    }
    return save;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// deleteSaveSlot
// ---------------------------------------------------------------------------
export function deleteSaveSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (key) try { localStorage.removeItem(key); } catch (_) {}
}

// ---------------------------------------------------------------------------
// exportSaveSlot (ENH-10, FIX #12, BUG-G fix)
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

  // BUG-G fix: the anchor must be attached to the document before .click() is
  // called.  Chromium allows clicking a detached element but Firefox silently
  // ignores it, so the export button did nothing on Firefox.
  // Correct pattern: append → click → remove → revoke, all synchronously.
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

// ---------------------------------------------------------------------------
// importSaveFromJSON (ENH-10)
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

  const patched = { ...json, slot: String(targetSlot) };
  try {
    localStorage.setItem(key, JSON.stringify(patched));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `localStorage write failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// restoreFromSave — applies a v8 save payload to live engine state.
// ---------------------------------------------------------------------------
export async function restoreFromSave(save, {
  runStatsScene,
  renderFromLog,
  renderChoices,
  showPageBreak,
  showInputPrompt,
  runInterpreter,
  clearNarrative,
  applyTransition,
  setChapterTitle,
  setChoiceArea,
  parseAndCacheScene,
  fetchTextFileFn,
  evalValueFn,
}) {
  // 1. Re-parse startup to establish fresh defaults.
  await parseStartup(fetchTextFileFn, evalValueFn);

  // 2. Merge saved playerState over fresh defaults.
  //
  // BUG-E fix: the previous approach whitelisted only keys present in the
  // post-startup playerState, which silently dropped any variable *create'd
  // at runtime inside a scene file (those keys only appear in the save, not
  // in the startup-derived defaults).
  //
  // New approach: start with the fresh startup defaults (so variables added
  // to startup.txt since the save was made get their default values), then
  // overlay the full saved playerState on top.  Every saved value —
  // including runtime-created ones — is preserved.  Keys removed from
  // startup.txt since the save was written will survive in the restored
  // state, which is the safer trade-off compared to silently losing data.
  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) });

  // 3. Restore pending stat points.
  const savedPoints = save.pendingStatPoints ?? 0;
  setPendingStatPoints(savedPoints);
  clearTempState();

  // Restore statRegistry from save (FIX #S4).
  if (Array.isArray(save.statRegistry) && save.statRegistry.length > 0) {
    const freshStatKeys = new Set(statRegistry.map(e => e.key));
    const extra = save.statRegistry.filter(e => !freshStatKeys.has(e.key));
    if (extra.length > 0) {
      setStatRegistry([...statRegistry, ...extra]);
    }
  }

  // Restore sessionState from save (FIX #S4).
  if (save.sessionState && typeof save.sessionState === 'object' && !Array.isArray(save.sessionState)) {
    setSessionState(JSON.parse(JSON.stringify(save.sessionState)));
  }

  // 4. Parse and cache the saved scene.
  await parseAndCacheScene(save.scene);
  setCurrentScene(save.scene);
  setIp(save.ip ?? 0);
  setAwaitingChoice(null);
  clearPauseState();

  // 5. Restore chapter title.
  if (save.chapterTitle) {
    setChapterTitle(save.chapterTitle);
  }

  // 6. Render narrative from the saved log.
  clearNarrative();
  applyTransition();
  renderFromLog(save.narrativeLog ?? [], { skipAnimations: true });

  // 6b. Re-point _choiceArea (BUG-05).
  if (typeof setChoiceArea === 'function') {
    setChoiceArea(document.getElementById('choice-area'));
  }

  // 7. Run stats panel.
  await runStatsScene();

  // 8. Re-present pause UI or choices.
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
          // BUG-B fix: suppress auto-save — this is a restore-path resume,
          // not a fresh navigation that should overwrite the player's save.
          runInterpreter({ suppressAutoSave: true }).catch(err => console.error('[saves] runInterpreter error after page_break restore:', err));
        });
        break;

      case 'input':
        showInputPrompt(ps.varName, ps.prompt, (value) => {
          clearPauseState();
          if (Object.prototype.hasOwnProperty.call(tempState, ps.varName)) {
            tempState[ps.varName] = value;
          } else {
            playerState[ps.varName] = value;
          }
          setIp(ps.resumeIp);
          // BUG-B fix: suppress auto-save on restore-path resume.
          runInterpreter({ suppressAutoSave: true }).catch(err => console.error('[saves] runInterpreter error after input restore:', err));
        });
        break;

      case 'delay':
        clearPauseState();
        setIp(ps.resumeIp);
        // BUG-B fix: suppress auto-save on restore-path resume.
        runInterpreter({ suppressAutoSave: true }).catch(err => console.error('[saves] runInterpreter error after delay restore:', err));
        break;
    }
    return;
  }

  // FIX #S6: If the save had awaitingChoice, re-render the choice buttons
  // with live click handlers. This was previously dead code because
  // awaitingChoice was never included in the save payload.
  if (save.awaitingChoice) {
    setAwaitingChoice(save.awaitingChoice);
    renderChoices(save.awaitingChoice.choices);
  }
}
