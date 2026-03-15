// ---------------------------------------------------------------------------
// core/state.js — Engine state and variable management
//
// All mutable engine state lives here as named exports. Modules that need to
// READ state import the variable directly. Modules that need to WRITE state
// call the setter functions below — this keeps mutation paths explicit and
// auditable rather than scattered across the codebase.
//
// Variable scoping rules:
//   playerState  — persistent across scenes, saved to localStorage
//   tempState    — scene-scoped, cleared by clearTempState() on *goto_scene
//   statRegistry — ordered list of allocatable stats declared via *create_stat
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Core game state
// ---------------------------------------------------------------------------
export let playerState   = {};
export let tempState     = {};
export let statRegistry  = [];   // [{ key, label, defaultVal }, ...]

// ---------------------------------------------------------------------------
// Interpreter position / flow
// ---------------------------------------------------------------------------
export let currentScene  = null;
export let currentLines  = [];
export let ip            = 0;

// _gotoJumped: set true by the *goto handler so executeBlock knows ip was
// deliberately relocated and must not be overwritten with resumeAfter.
export let _gotoJumped   = false;

// ---------------------------------------------------------------------------
// Choice state
// ---------------------------------------------------------------------------
export let awaitingChoice = null;

// ---------------------------------------------------------------------------
// Level-up / stat allocation
// ---------------------------------------------------------------------------
export let pendingStatPoints     = 0;
export let pendingLevelUpDisplay = false;
export let _pendingLevelUpCount  = 0;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// delayIndex drives the staggered animation-delay on paragraphs / system blocks.
export let delayIndex = 0;

// ---------------------------------------------------------------------------
// Startup metadata
// ---------------------------------------------------------------------------
export let startup = { sceneList: [] };

// ---------------------------------------------------------------------------
// _isRestoring — true while restoreFromSave is replaying a scene.
// addSystem checks this flag and skips applySystemRewards during replay to
// prevent double-counting XP / rewards (KB1).
// ---------------------------------------------------------------------------
export let _isRestoring = false;
export function setIsRestoring(v) { _isRestoring = v; }

// ---------------------------------------------------------------------------
// _pausedAtIp — set by *page_break / *delay / *input before they jump ip to
// currentLines.length. buildSavePayload reads this so saves record the real
// directive line rather than the synthetic "past-end" ip (KB3).
// ---------------------------------------------------------------------------
export let _pausedAtIp = null;
export function setPausedAtIp(n) { _pausedAtIp = n; }
export function clearPausedAtIp() { _pausedAtIp = null; }

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------
export function setPlayerState(s)           { playerState = s; }
export function patchPlayerState(patch)     { Object.assign(playerState, patch); }
export function setTempState(s)             { tempState = s; }
export function setStatRegistry(r)          { statRegistry = r; }
export function setStartup(s)               { startup = s; }

export function setCurrentScene(s)          { currentScene = s; }
export function setCurrentLines(l)          { currentLines = l; }
export function setIp(n)                    { ip = n; }
export function advanceIp()                 { ip += 1; }
export function setGotoJumped(v)            { _gotoJumped = v; }

export function setAwaitingChoice(c)        { awaitingChoice = c; }

export function setPendingStatPoints(n)     { pendingStatPoints = n; }
export function addPendingStatPoints(n)     { pendingStatPoints += n; }
export function setPendingLevelUpDisplay(v) { pendingLevelUpDisplay = v; }
export function setPendingLevelUpCount(n)   { _pendingLevelUpCount = n; }
export function addPendingLevelUpCount(n)   { _pendingLevelUpCount += n; }

export function setDelayIndex(n)            { delayIndex = n; }
export function advanceDelayIndex()         { delayIndex += 1; }

// ---------------------------------------------------------------------------
// clearTempState — called by gotoScene on cross-scene navigation
// ---------------------------------------------------------------------------
export function clearTempState() {
  tempState = {};
}

// ---------------------------------------------------------------------------
// normalizeKey — canonical lowercase key used everywhere a variable is looked up
// ---------------------------------------------------------------------------
export function normalizeKey(k) {
  return String(k).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// setVar — handles the *set directive
//
// Supports arithmetic shorthand: *set xp +100  →  xp = xp + 100
// Accepts evalValueFn as a parameter to avoid a circular import with
// expression.js (which also needs to read state).
// ---------------------------------------------------------------------------
export function setVar(command, evalValueFn) {
  const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);

  const inTemp   = Object.prototype.hasOwnProperty.call(tempState,   key);
  const inPlayer = Object.prototype.hasOwnProperty.call(playerState, key);
  const store    = inTemp ? tempState : playerState;

  if (!inTemp && !inPlayer) {
    console.warn(`[state] *set on undeclared variable "${key}" — did you mean *create or *temp?`);
    return; // Don't silently create garbage keys in persistent state
  }

  // Arithmetic shorthand — validate result is finite before committing (sweep 2 fix #11).
  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === 'number') {
    const result = evalValueFn(`${store[key]} ${rhs}`);
    store[key] = Number.isFinite(result) ? result : evalValueFn(rhs);
  } else {
    store[key] = evalValueFn(rhs);
  }
}

// ---------------------------------------------------------------------------
// declareTemp — handles the *temp directive
// ---------------------------------------------------------------------------
export function declareTemp(command, evalValueFn) {
  const m = command.match(/^\*temp\s+([a-zA-Z_][\w]*)(?:\s+(.+))?$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  tempState[normalizeKey(rawKey)] = rhs !== undefined ? evalValueFn(rhs) : 0;
}

// ---------------------------------------------------------------------------
// parseStartup — reads startup.txt, populates playerState and statRegistry.
//
// Accepts fetchTextFileFn and evalValueFn as injected dependencies so this
// module remains pure (no direct fetch calls, no Function() evaluator import).
// ---------------------------------------------------------------------------
// _statRegistryWarningFired: module-level so it only fires once per page load,
// not on every parseStartup call (boot + each restoreFromSave).
let _statRegistryWarningFired = false;

export async function parseStartup(fetchTextFileFn, evalValueFn) {
  const text  = await fetchTextFileFn('startup');
  const lines = text.split(/\r?\n/).map(raw => ({
    raw,
    trimmed: raw.trim(),
    indent:  (raw.match(/^\s*/)?.[0] || '').length,
  }));

  // Reset all state before repopulating — ensures a clean slate on New Game
  // as well as when called from boot().
  playerState  = {};
  tempState    = {};
  statRegistry = [];
  startup      = { sceneList: [] };

  let inSceneList               = false;

  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith('//')) continue;

    if (line.trimmed.startsWith('*create_stat')) {
      inSceneList = false;
      const m = line.trimmed.match(/^\*create_stat\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(.+)$/);
      if (!m) { console.warn(`[state] Malformed *create_stat: ${line.trimmed}`); continue; }
      const [, rawKey, label, valStr] = m;
      const key = normalizeKey(rawKey);
      const dv  = evalValueFn(valStr);
      playerState[key] = dv;
      statRegistry.push({ key, label, defaultVal: dv });
      continue;
    }

    if (line.trimmed.startsWith('*create')) {
      inSceneList = false;
      const m = line.trimmed.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);
      if (!m) continue;
      const [, rawKey, value] = m;
      playerState[normalizeKey(rawKey)] = evalValueFn(value);
      continue;
    }

    if (line.trimmed.startsWith('*scene_list')) { inSceneList = true; continue; }
    if (inSceneList && !line.trimmed.startsWith('*') && line.indent > 0) {
      startup.sceneList.push(line.trimmed);
    }
  }

  if (statRegistry.length === 0 && !_statRegistryWarningFired) {
    console.warn('[state] No *create_stat entries found — level-up allocation will be empty.');
    _statRegistryWarningFired = true;
  }
}
