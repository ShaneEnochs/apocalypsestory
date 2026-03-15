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

// ENH-08: sessionState — survives *goto_scene (clearTempState) but is NOT
// saved to localStorage. Cleared on new game and on page reload.
// Lookup order in evalValue: tempState → sessionState → playerState.
export let sessionState  = {};

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
export let levelUpInProgress     = false;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
// (delayIndex removed — staggered animation-delay system eliminated)

// ---------------------------------------------------------------------------
// Startup metadata
// ---------------------------------------------------------------------------
export let startup = { sceneList: [] };

// ---------------------------------------------------------------------------
// pauseState — tracks which directive has halted the interpreter and carries
// all context needed to re-present its UI on save/load restore.
//
// Shapes (one of):
//   { type: 'page_break', btnText: string, resumeIp: number }
//   { type: 'delay',      ms: number,      resumeIp: number }
//   { type: 'input',      varName: string, prompt: string, resumeIp: number }
//
// null when the interpreter is not paused at a directive.
// ---------------------------------------------------------------------------
export let pauseState = null;
export function setPauseState(s)  { pauseState = s; }
export function clearPauseState() { pauseState = null; }

// ---------------------------------------------------------------------------
// chapterTitle — state-side mirror of the DOM #chapter-title text.
// Persisted in the save payload so restore can set it without a DOM query.
// ---------------------------------------------------------------------------
export let chapterTitle = '—';
export function setChapterTitleState(t) { chapterTitle = t; }

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------
export function setPlayerState(s)           { playerState = s; }
export function patchPlayerState(patch)     { Object.assign(playerState, patch); }
export function setTempState(s)             { tempState = s; }
export function setStatRegistry(r)          { statRegistry = r; }
export function setStartup(s)               { startup = s; }

// ENH-08: sessionState setters
export function setSessionState(s)          { sessionState = s; }
export function clearSessionState()         { sessionState = {}; }
export function patchSessionState(p)        { Object.assign(sessionState, p); }

export function setCurrentScene(s)          { currentScene = s; }
export function setCurrentLines(l)          { currentLines = l; }
export function setIp(n)                    { ip = n; }
export function advanceIp()                 { ip += 1; }
export function setGotoJumped(v)            { _gotoJumped = v; }

export function setAwaitingChoice(c)        { awaitingChoice = c; }

export function setPendingStatPoints(n)     { pendingStatPoints = n; }
export function addPendingStatPoints(n)     { pendingStatPoints += n; }
export function setLevelUpInProgress(v)     { levelUpInProgress = v; }

// setDelayIndex / advanceDelayIndex removed — animation stagger system eliminated

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

  const inTemp    = Object.prototype.hasOwnProperty.call(tempState,    key);
  const inSession = Object.prototype.hasOwnProperty.call(sessionState, key);
  const inPlayer  = Object.prototype.hasOwnProperty.call(playerState,  key);

  // BUG-C fix: mirror the evalValue lookup order (temp → session → player)
  // so *set can write to sessionState variables declared via *session_set.
  // Previously only tempState and playerState were checked, causing *set on
  // a session variable to silently do nothing.
  const store = inTemp ? tempState : (inSession ? sessionState : playerState);

  if (!inTemp && !inSession && !inPlayer) {
    console.warn(`[state] *set on undeclared variable "${key}" — did you mean *create or *temp?`);
    return; // Don't silently create garbage keys in persistent state
  }

  // Arithmetic shorthand — validate result is finite before committing.
  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === 'number') {
    const result = evalValueFn(`${store[key]} ${rhs}`);
    // BUG-03 fix: normalise -0 → 0 so JSON serialisation and comparisons
    // behave consistently. Object.is(-0, 0) is false, which could silently
    // break equality checks after a round-trip through JSON.stringify.
    const coerced = Number.isFinite(result) ? result : evalValueFn(rhs);
    store[key] = coerced === 0 ? 0 : coerced;
  } else {
    store[key] = evalValueFn(rhs);
  }
}

// ---------------------------------------------------------------------------
// setStatClamped — handles the *set_stat directive (ENH-03)
//
// Syntax: *set_stat key rhs [min:N] [max:N]
// Applies rhs using the same arithmetic-shorthand logic as setVar, then clamps
// the result to [min, max]. Bounds are optional; omitting one means unbounded.
// ---------------------------------------------------------------------------
export function setStatClamped(command, evalValueFn) {
  const m = command.match(/^\*set_stat\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rest] = m;
  const key = normalizeKey(rawKey);

  const inTemp    = Object.prototype.hasOwnProperty.call(tempState,    key);
  const inSession = Object.prototype.hasOwnProperty.call(sessionState, key);
  const inPlayer  = Object.prototype.hasOwnProperty.call(playerState,  key);

  // BUG-D fix: mirror setVar's corrected lookup order (temp → session → player).
  const store = inTemp ? tempState : (inSession ? sessionState : playerState);

  if (!inTemp && !inSession && !inPlayer) {
    console.warn(`[state] *set_stat on undeclared variable "${key}" — did you mean *create or *temp?`);
    return;
  }

  // Extract optional min:/max: bounds, then strip them from the RHS expression
  const minMatch = rest.match(/\bmin:\s*(-?[\d.]+)/i);
  const maxMatch = rest.match(/\bmax:\s*(-?[\d.]+)/i);
  const rhs = rest
    .replace(/\bmin:\s*-?[\d.]+/gi, '')
    .replace(/\bmax:\s*-?[\d.]+/gi, '')
    .trim();

  const minVal = minMatch ? Number(minMatch[1]) : -Infinity;
  const maxVal = maxMatch ? Number(maxMatch[1]) :  Infinity;

  // Apply arithmetic shorthand if applicable, same as setVar
  let newVal;
  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === 'number') {
    const result = evalValueFn(`${store[key]} ${rhs}`);
    newVal = Number.isFinite(result) ? result : evalValueFn(rhs);
  } else {
    newVal = evalValueFn(rhs);
  }

  if (typeof newVal === 'number') {
    newVal = Math.min(maxVal, Math.max(minVal, newVal));
    newVal = newVal === 0 ? 0 : newVal;  // normalise -0
  }
  store[key] = newVal;
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

  let inSceneList = false;

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

  // ENH-04: warn if any level-up config variables are missing from startup.txt.
  // Without them the engine silently falls back to hardcoded defaults in
  // checkAndApplyLevelUp, which may not match the game's intended design.
  const _LVL_CONFIG_KEYS = ['essence_up_mult', 'lvl_up_stat_gain', 'essence_to_next'];
  const _missingConfig   = _LVL_CONFIG_KEYS.filter(k => !Object.prototype.hasOwnProperty.call(playerState, k));
  if (_missingConfig.length > 0) {
    console.warn(
      `[state] startup.txt is missing level-up config variable(s): ${_missingConfig.join(', ')}. ` +
      `The engine will use hardcoded fallback values. Add the missing *create declarations to startup.txt.`
    );
  }
}
