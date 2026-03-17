// ---------------------------------------------------------------------------
// systems/saves.js — Save / load / slot management + save code system
//
// All save slots (auto, 1, 2, 3) now store SA1 save codes in localStorage.
// SA1 is a compact format: base64-encoded JSON with delta-compressed
// playerState and a CRC-16 checksum for corruption detection.
//
// Format:  SA1|<base64_payload>|<4_char_hex_crc>
//
// SAVE_VERSION history:
//   v7: Essence replaces XP/skill_points. game_title added.
//   v8: Store system (items.txt, item purchases).
//   v9: Simplification refactor — removed sessionState, pauseState, leveling.
//       Flat pronoun keys. All slots use SA1 save code format.
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
// CRC-16 checksum — catches copy-paste corruption and bit-rot.
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

// ---------------------------------------------------------------------------
// buildSaveCodePayload — builds the compact payload for SA1 encoding.
//
// Delta-compresses playerState against startup defaults so only changed
// keys are stored. Includes statRegistry, label, and timestamp for full
// round-trip fidelity.
// ---------------------------------------------------------------------------
function buildSaveCodePayload(label, narrativeLog) {
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
    ts: Date.now(),
  };

  if (label) {
    payload.lb = label;
  }

  if (awaitingChoice) {
    payload.ac = JSON.parse(JSON.stringify(awaitingChoice));
  }

  // Always include statRegistry so runtime *create_stat entries survive.
  if (statRegistry.length > 0) {
    payload.sr = JSON.parse(JSON.stringify(statRegistry));
  }

  return payload;
}

// ---------------------------------------------------------------------------
// encodeSaveCode — encodes the current game state into an SA1 string.
// ---------------------------------------------------------------------------
export function encodeSaveCode(narrativeLog, label = null) {
  const json = JSON.stringify(buildSaveCodePayload(label, narrativeLog));
  // btoa only handles Latin-1; use encodeURIComponent + unescape for full Unicode
  const compressed = btoa(unescape(encodeURIComponent(json)));
  const checksum = crc16(compressed);
  return `SA1|${compressed}|${checksum}`;
}

// ---------------------------------------------------------------------------
// decodeSaveCode — decodes an SA1 string into a full save object.
//
// Returns { ok, save?, reason? }.
// The returned save object has the shape that restoreFromSave expects:
//   { version, scene, ip, chapterTitle, playerState, statRegistry,
//     narrativeLog, awaitingChoice, characterName, timestamp, label }
// ---------------------------------------------------------------------------
export function decodeSaveCode(code) {
  const trimmed = code.trim();

  const parts = trimmed.split('|');
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
      statRegistry:   json.sr || JSON.parse(JSON.stringify(statRegistry)),
      label:          json.lb || null,
      characterName:  `${fullPlayerState.first_name || ''} ${fullPlayerState.last_name || ''}`.trim() || 'Unknown',
      timestamp:      json.ts || Date.now(),
    },
  };
}

// ---------------------------------------------------------------------------
// saveGameToSlot — encodes to SA1 and writes to localStorage.
// ---------------------------------------------------------------------------
export function saveGameToSlot(slot, label = null, narrativeLog = []) {
  const key = saveKeyForSlot(slot);
  if (!key) { console.warn(`[saves] Unknown save slot: "${slot}"`); return; }
  try {
    const code = encodeSaveCode(narrativeLog, label);
    localStorage.setItem(key, code);
  } catch (err) {
    console.warn(`[saves] Save to slot "${slot}" failed:`, err);
  }
}

// ---------------------------------------------------------------------------
// loadSaveFromSlot — reads from localStorage and decodes SA1.
//
// Backward compatibility: if the stored value is not an SA1 string (i.e. it's
// a legacy raw JSON blob from a previous engine version), it's treated as a
// stale save and discarded with a notice.
// ---------------------------------------------------------------------------
export function loadSaveFromSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    // SA1 save codes always start with 'SA1|'
    if (raw.startsWith('SA1|')) {
      const result = decodeSaveCode(raw);
      if (result.ok) return result.save;
      // Decode failed — corrupted or version mismatch
      console.warn(`[saves] Slot "${slot}" decode failed: ${result.reason}`);
      if (result.reason.includes('different game version')) {
        setStaleSaveFound();
      }
      try { localStorage.removeItem(key); } catch (_) {}
      return null;
    }

    // Legacy raw JSON — treat as stale save
    console.warn(`[saves] Slot "${slot}" contains legacy format — discarding.`);
    setStaleSaveFound();
    try { localStorage.removeItem(key); } catch (_) {}
    return null;

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
//
// Exports the decoded save object as a JSON file. The file contains the
// full expanded save (not the compact SA1 string) for human readability
// and cross-engine compatibility.
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
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

// ---------------------------------------------------------------------------
// importSaveFromJSON (ENH-10)
//
// Validates an imported JSON save object, then re-encodes it as SA1 and
// stores it in the target slot.
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

  // Build delta-compressed playerState for the SA1 payload
  const defaults = getStartupDefaults();
  const deltaPs = {};
  for (const [k, v] of Object.entries(json.playerState)) {
    if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
      deltaPs[k] = v;
    }
  }

  const payload = {
    v:  SAVE_VERSION,
    s:  json.scene,
    ip: json.ip ?? 0,
    ct: json.chapterTitle || '',
    ps: deltaPs,
    nl: json.narrativeLog || [],
    ts: json.timestamp || Date.now(),
  };

  if (json.label) payload.lb = json.label;
  if (json.awaitingChoice) payload.ac = json.awaitingChoice;
  if (json.statRegistry) payload.sr = json.statRegistry;

  try {
    const jsonStr = JSON.stringify(payload);
    const compressed = btoa(unescape(encodeURIComponent(jsonStr)));
    const checksum = crc16(compressed);
    const code = `SA1|${compressed}|${checksum}`;
    localStorage.setItem(key, code);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `localStorage write failed: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// restoreFromSave — applies a save object to live engine state.
//
// The save object is the expanded form returned by decodeSaveCode or
// loadSaveFromSlot — it contains full playerState, statRegistry, etc.
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