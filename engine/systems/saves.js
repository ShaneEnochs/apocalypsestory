// ---------------------------------------------------------------------------
// systems/saves.js — Save / load / slot management
//
// Handles localStorage serialisation and deserialisation of game state.
// DOM slot-card rendering lives in ui/overlays.js (moved in Phase 4).
//
// Save version: bump SAVE_VERSION whenever the payload shape changes so stale
// saves are rejected cleanly rather than silently corrupting state.
// ---------------------------------------------------------------------------

import { playerState, pendingStatPoints, currentScene,
         setPlayerState, setPendingStatPoints,
         clearTempState, parseStartup }                from '../core/state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SAVE_VERSION  = 2;

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
export function clearStaleSaveFound()  { _staleSaveFound = false; }
export function setStaleSaveFound()    { _staleSaveFound = true;  }

// ---------------------------------------------------------------------------
// buildSavePayload — constructs the object written to localStorage
// ---------------------------------------------------------------------------
export function buildSavePayload(slot, label) {
  return {
    version:          SAVE_VERSION,
    slot:             String(slot),
    scene:            currentScene,
    label:            label ?? null,
    characterName:    `${playerState.first_name || ''} ${playerState.last_name || ''}`.trim() || 'Unknown',
    playerState:      JSON.parse(JSON.stringify(playerState)),
    pendingStatPoints,
    timestamp:        Date.now(),
  };
}

// ---------------------------------------------------------------------------
// saveGameToSlot — serialises and persists the current state to a slot.
// Slot can be 'auto', 1, 2, or 3.
// ---------------------------------------------------------------------------
export function saveGameToSlot(slot, label = null) {
  const key = saveKeyForSlot(slot);
  if (!key) { console.warn(`[saves] Unknown save slot: "${slot}"`); return; }
  try {
    localStorage.setItem(key, JSON.stringify(buildSavePayload(slot, label)));
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
      console.warn(`[saves] Slot "${slot}" version mismatch — discarding.`);
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
// restoreFromSave — applies a save payload to live engine state.
//
// Merges saved playerState over fresh startup defaults (fix #5: new keys get
// defaults, removed keys are dropped). Then delegates to gotoScene() to
// resume at the saved position.
//
// Accepts gotoScene and runStatsScene as injected callbacks to avoid circular
// imports (those functions live in the interpreter / UI layers).
// ---------------------------------------------------------------------------
export async function restoreFromSave(save, { gotoScene, runStatsScene, fetchTextFileFn, evalValueFn }) {
  // Re-parse startup to establish fresh defaults before merging saved state.
  // This ensures that variables added in a newer version of startup.txt get
  // their defaults even when loading a save that predates them.
  await parseStartup(fetchTextFileFn, evalValueFn);

  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) });
  setPendingStatPoints(save.pendingStatPoints ?? 0);
  clearTempState();

  await runStatsScene();
  await gotoScene(save.scene, save.label, true);
}
