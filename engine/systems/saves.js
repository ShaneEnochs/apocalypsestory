// ---------------------------------------------------------------------------
// systems/saves.js — Save / load / slot management + save code system
//
// SAVE_VERSION history:
//   v7: Essence replaces XP/skill_points. game_title added.
//   v8: Store system (items.txt, item purchases).
//   v9: Simplification refactor — removed sessionState, pauseState, leveling.
//       Flat pronoun keys. Save codes added.
// ---------------------------------------------------------------------------

import {
  playerState, tempState, currentScene, ip,
  chapterTitle, statRegistry,
  awaitingChoice,
  setPlayerState,
  setStatRegistry,
  setCurrentScene, setCurrentLines, setIp,
  setAwaitingChoice,
  clearTempState, parseStartup,
  setChapterTitleState,
  getStartupDefaults,
} from '../core/state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
// FIX #S6: bumped to 8 — Phase 3: Store system (items.txt, item purchases).
export const SAVE_VERSION  = 9;

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
// buildSavePayload — constructs the v9 object written to localStorage.
// ---------------------------------------------------------------------------
export function buildSavePayload(slot, label, narrativeLog) {
  return {
    version:        SAVE_VERSION,
    slot:           String(slot),
    scene:          currentScene,
    label:          label ?? null,
    ip,
    chapterTitle,
    awaitingChoice: awaitingChoice
      ? JSON.parse(JSON.stringify(awaitingChoice))
      : null,
    characterName:  `${playerState.first_name || ''} ${playerState.last_name || ''}`.trim() || 'Unknown',
    playerState:    JSON.parse(JSON.stringify(playerState)),
    statRegistry:   JSON.parse(JSON.stringify(statRegistry)),
    narrativeLog:   JSON.parse(JSON.stringify(narrativeLog ?? [])),
    timestamp:      Date.now(),
  };
}

// ---------------------------------------------------------------------------
// saveGameToSlot
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
// restoreFromSave — applies a v9 save payload to live engine state.
// ---------------------------------------------------------------------------
export async function restoreFromSave(save, {
  runStatsScene,
  renderFromLog,
  renderChoices,
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
  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) });

  // 3. Clear temp state.
  clearTempState();

  // Restore statRegistry from save.
  if (Array.isArray(save.statRegistry) && save.statRegistry.length > 0) {
    const freshStatKeys = new Set(statRegistry.map(e => e.key));
    const extra = save.statRegistry.filter(e => !freshStatKeys.has(e.key));
    if (extra.length > 0) {
      setStatRegistry([...statRegistry, ...extra]);
    }
  }

  // 4. Parse and cache the saved scene.
  await parseAndCacheScene(save.scene);
  setCurrentScene(save.scene);
  setIp(save.ip ?? 0);
  setAwaitingChoice(null);

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

  // 8. Re-render choices if save was taken at a choice point.
  if (save.awaitingChoice) {
    setAwaitingChoice(save.awaitingChoice);
    renderChoices(save.awaitingChoice.choices);
  }
}

// ---------------------------------------------------------------------------
// Save Code System — compact pasteable save codes
//
// Encodes game state into a short string players can copy/paste/share.
// Uses base64 encoding with delta compression against startup defaults
// and a CRC-16 checksum for corruption detection.
//
// Format:  SA1|<base64_payload>|<4_char_hex_crc>
// ---------------------------------------------------------------------------

function crc16(str) {
  let crc = 0xFFFF;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
  }
  return crc.toString(16).padStart(4, '0');
}

// Build a minimal payload: only playerState keys that differ from startup defaults.
function buildSaveCodePayload(narrativeLog) {
  const defaults = getStartupDefaults();
  const ps = {};
  for (const [k, v] of Object.entries(playerState)) {
    if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
      ps[k] = v;
    }
  }
  const payload = {
    v:  SAVE_VERSION,
    s:  currentScene,
    ip,
    ct: chapterTitle,
    ps,
    nl: narrativeLog || [],
  };
  if (awaitingChoice) {
    payload.ac = JSON.parse(JSON.stringify(awaitingChoice));
  }
  return payload;
}

export function encodeSaveCode(narrativeLog) {
  const json = JSON.stringify(buildSaveCodePayload(narrativeLog));
  // btoa only handles Latin-1; use encodeURIComponent + unescape for full Unicode
  const compressed = btoa(unescape(encodeURIComponent(json)));
  const checksum = crc16(compressed);
  return `SA1|${compressed}|${checksum}`;
}

export function decodeSaveCode(code) {
  const parts = code.trim().split('|');
  if (parts.length !== 3) {
    return { ok: false, reason: 'Invalid save code format.' };
  }

  const [prefix, compressed, checksum] = parts;

  if (prefix !== 'SA1') {
    return { ok: false, reason: `Unrecognized save code version: ${prefix}` };
  }

  if (crc16(compressed) !== checksum) {
    return { ok: false, reason: 'Save code is corrupted (checksum mismatch). Check for missing characters.' };
  }

  let json;
  try {
    const decoded = decodeURIComponent(escape(atob(compressed)));
    json = JSON.parse(decoded);
  } catch (err) {
    return { ok: false, reason: `Save code could not be decoded: ${err.message}` };
  }

  if (json.v !== SAVE_VERSION) {
    return { ok: false, reason: `Save code is from a different game version (v${json.v}, expected v${SAVE_VERSION}).` };
  }

  // Reconstruct full playerState by merging delta over startup defaults
  const defaults = getStartupDefaults();
  const fullPlayerState = { ...defaults, ...json.ps };

  return {
    ok: true,
    save: {
      version:        json.v,
      scene:          json.s,
      ip:             json.ip,
      chapterTitle:   json.ct,
      playerState:    fullPlayerState,
      narrativeLog:   json.nl || [],
      awaitingChoice: json.ac || null,
      statRegistry:   JSON.parse(JSON.stringify(statRegistry)),
      characterName:  `${fullPlayerState.first_name || ''} ${fullPlayerState.last_name || ''}`.trim() || 'Unknown',
      timestamp:      Date.now(),
    },
  };
}
