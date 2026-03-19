// systems/saves.js — Save / load / slot management + save code system
//
// All save slots (auto, 1, 2, 3) store SA1 save codes in localStorage.
// SA1 is a compact format: base64-encoded JSON with delta-compressed
// playerState and a CRC-16 checksum for corruption detection.
//
// Format:  SA1|<base64_payload>|<4_char_hex_crc>
// Current save version: 9

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

export function saveKeyForSlot(slot: string | number): string | null {
  return slot === 'auto' ? SAVE_KEY_AUTO : (SAVE_KEY_SLOTS[slot as 1|2|3] ?? null);
}

// ---------------------------------------------------------------------------
// Stale save detection — set when a version-mismatched save is discarded
// ---------------------------------------------------------------------------
export let _staleSaveFound = false;
export function clearStaleSaveFound() { _staleSaveFound = false; }
export function setStaleSaveFound()   { _staleSaveFound = true;  }

// ---------------------------------------------------------------------------
// CRC-16 checksum — catches copy-paste corruption and bit-rot.
// ---------------------------------------------------------------------------
function crc16(str: string): string {
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
// Delta-compresses playerState against startup defaults.
// ---------------------------------------------------------------------------
function buildSaveCodePayload(label: string | null, narrativeLog: unknown[]): Record<string, any> {
  const defaults = getStartupDefaults();
  const ps: Record<string, any> = {};
  for (const [k, v] of Object.entries(playerState)) {
    if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
      ps[k] = v;
    }
  }

  const payload: Record<string, any> = {
    v:  SAVE_VERSION,
    s:  currentScene,
    ip,
    ct: chapterTitle,
    ps,
    nl: narrativeLog || [],
    ts: Date.now(),
  };

  if (label)            payload.lb = label;
  if (awaitingChoice)   payload.ac = JSON.parse(JSON.stringify(awaitingChoice));
  if (statRegistry.length > 0) payload.sr = JSON.parse(JSON.stringify(statRegistry));

  return payload;
}

// ---------------------------------------------------------------------------
// encodeSaveCode — encodes the current game state into an SA1 string.
// ---------------------------------------------------------------------------
export function encodeSaveCode(narrativeLog: unknown[], label: string | null = null): string {
  const json = JSON.stringify(buildSaveCodePayload(label, narrativeLog));
  const compressed = btoa(unescape(encodeURIComponent(json)));
  const checksum = crc16(compressed);
  return `SA1|${compressed}|${checksum}`;
}

// ---------------------------------------------------------------------------
// decodeSaveCode — decodes an SA1 string into a full save object.
// Returns { ok, save?, reason? }.
// ---------------------------------------------------------------------------
export function decodeSaveCode(code: string): { ok: true; save: any } | { ok: false; reason: string } {
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
    return { ok: false, reason: `Save code could not be decoded: ${(err as Error).message}` };
  }

  if (json.v !== SAVE_VERSION) {
    return { ok: false, reason: `Save code is from a different game version (v${json.v}, expected v${SAVE_VERSION}).` };
  }

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
export function saveGameToSlot(slot: string | number, label: string | null = null, narrativeLog: unknown[] = []): void {
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
// Legacy raw JSON blobs from older engine versions are discarded.
// ---------------------------------------------------------------------------
export function loadSaveFromSlot(slot: string | number): any | null {
  const key = saveKeyForSlot(slot);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    if (raw.startsWith('SA1|')) {
      const result = decodeSaveCode(raw);
      if (result.ok) return result.save;
      const reason = (result as { ok: false; reason: string }).reason;
      console.warn(`[saves] Slot "${slot}" decode failed: ${reason}`);
      if (reason.includes('different game version')) {
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
export function deleteSaveSlot(slot: string | number): void {
  const key = saveKeyForSlot(slot);
  if (key) try { localStorage.removeItem(key); } catch (_) {}
}

// ---------------------------------------------------------------------------
// exportSaveSlot — exports the decoded save as a human-readable JSON file.
// The anchor element is attached to the document before .click() for
// cross-browser compatibility (Firefox requires it).
// ---------------------------------------------------------------------------
export function exportSaveSlot(slot: string | number): boolean {
  const save = loadSaveFromSlot(slot);
  if (!save) return false;

  const safeName = (save.characterName || 'Unknown').replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_');
  const filename = `sa-save-slot${slot}-${safeName}.json`;
  const blob     = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = filename;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

// ---------------------------------------------------------------------------
// importSaveFromJSON — validates an imported JSON save object, re-encodes
// as SA1, and stores it in the target slot.
// ---------------------------------------------------------------------------
export function importSaveFromJSON(json: any, targetSlot: string | number): { ok: true } | { ok: false; reason: string } {
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

  const defaults = getStartupDefaults();
  const deltaPs: Record<string, any> = {};
  for (const [k, v] of Object.entries(json.playerState)) {
    if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
      deltaPs[k] = v;
    }
  }

  const payload: Record<string, any> = {
    v:  SAVE_VERSION,
    s:  json.scene,
    ip: json.ip ?? 0,
    ct: json.chapterTitle || '',
    ps: deltaPs,
    nl: json.narrativeLog || [],
    ts: json.timestamp || Date.now(),
  };

  if (json.label)          payload.lb = json.label;
  if (json.awaitingChoice) payload.ac = json.awaitingChoice;
  if (json.statRegistry)   payload.sr = json.statRegistry;

  try {
    const jsonStr = JSON.stringify(payload);
    const compressed = btoa(unescape(encodeURIComponent(jsonStr)));
    const checksum = crc16(compressed);
    const code = `SA1|${compressed}|${checksum}`;
    localStorage.setItem(key, code);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `localStorage write failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// restoreFromSave — applies a save object to live engine state.
//
// If the save was at a *choice point, restores the buttons directly.
// If mid-scene (via *save_point), resumes execution from save.ip.
// ---------------------------------------------------------------------------
export async function restoreFromSave(save: any, {
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
}: {
  runStatsScene:      () => Promise<void>;
  renderFromLog:      (log: unknown[], options?: { skipAnimations?: boolean }) => void;
  renderChoices:      (choices: unknown[]) => void;
  runInterpreter:     (opts?: { suppressAutoSave?: boolean }) => Promise<void>;
  clearNarrative:     () => void;
  applyTransition:    () => void;
  setChapterTitle:    (t: string) => void;
  setChoiceArea:      ((el: HTMLElement | null) => void) | null;
  parseAndCacheScene: (name: string) => Promise<void>;
  fetchTextFileFn:    (name: string) => Promise<string>;
  evalValueFn:        (expr: string) => unknown;
}): Promise<void> {
  await parseStartup(fetchTextFileFn, evalValueFn);

  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) });

  clearTempState();

  if (Array.isArray(save.statRegistry) && save.statRegistry.length > 0) {
    const freshStatKeys = new Set(statRegistry.map(e => e.key));
    const extra = save.statRegistry.filter((e: any) => !freshStatKeys.has(e.key));
    if (extra.length > 0) {
      setStatRegistry([...statRegistry, ...extra]);
    }
  }

  await parseAndCacheScene(save.scene);
  setCurrentScene(save.scene);
  setIp(save.ip ?? 0);
  setAwaitingChoice(null);

  if (save.chapterTitle) {
    setChapterTitle(save.chapterTitle);
  }

  clearNarrative();
  applyTransition();
  renderFromLog(save.narrativeLog ?? [], { skipAnimations: true });

  if (typeof setChoiceArea === 'function') {
    setChoiceArea(document.getElementById('choice-area'));
  }

  await runStatsScene();

  if (save.awaitingChoice) {
    setAwaitingChoice(save.awaitingChoice);
    renderChoices(save.awaitingChoice.choices);
  } else {
    // Mid-scene save — resume execution without triggering a redundant auto-save.
    await runInterpreter({ suppressAutoSave: true });
  }
}
