// ---------------------------------------------------------------------------
// systems/saves.js — Save / load / slot management
//
// Handles localStorage serialisation and deserialisation of game state.
// DOM slot-card rendering lives in ui/overlays.js (moved in Phase 4).
//
// Save version: bump SAVE_VERSION whenever the payload shape changes so stale
// saves are rejected cleanly rather than silently corrupting state.
// ---------------------------------------------------------------------------

import { playerState, pendingStatPoints, currentScene, ip,
         setPlayerState, setPendingStatPoints, setPendingLevelUpDisplay,
         clearTempState, parseStartup,
         _pausedAtIp, setIsRestoring }                from '../core/state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SAVE_VERSION  = 3;

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
    // Use _pausedAtIp when the interpreter is halted at a *page_break / *delay /
    // *input directive — those directives jump ip to currentLines.length to stop
    // the loop, so raw ip would give us a past-end value that breaks restore (KB3).
    ip:               _pausedAtIp !== null ? _pausedAtIp : ip,
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

  // Merge saved state over fresh defaults. Filter to keys that exist after the
  // fresh parseStartup so that variables removed from startup.txt in a newer
  // version are actually dropped rather than re-introduced by the old save.
  // New keys added to startup.txt retain their fresh defaults automatically.
  const freshKeys    = new Set(Object.keys(playerState));
  const savedFiltered = {};
  for (const [k, v] of Object.entries(save.playerState)) {
    if (freshKeys.has(k)) savedFiltered[k] = v;
  }
  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(savedFiltered)) });
  const savedPoints = save.pendingStatPoints ?? 0;
  setPendingStatPoints(savedPoints);
  // If points were unspent when the save was made, arm the display flag so
  // renderChoices (called during the gotoScene replay) triggers showInlineLevelUp.
  // Without this, the player would see disabled choices with no way to allocate.
  if (savedPoints > 0) setPendingLevelUpDisplay(true);
  clearTempState();

  await runStatsScene();
  // Set _isRestoring so addSystem skips applySystemRewards during the replay
  // from the nearest *label — playerState is already correct from the save
  // payload and re-applying rewards would double-count XP / trigger a
  // spurious level-up (KB1).
  setIsRestoring(true);
  try {
    // Pass savedIp so gotoScene can resume at the exact line position.
    // Falls back to label or ip=0 for older saves that don't have ip.
    await gotoScene(save.scene, save.label, true, save.ip ?? null);
  } finally {
    setIsRestoring(false);
  }
}