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

/**
 * @typedef {Object} StatRegistryEntry
 * @property {string} key        — normalised lowercase key
 * @property {string} label      — human-readable label from *create_stat
 * @property {number} defaultVal — initial value declared in startup.txt
 */

/**
 * @typedef {Object} ParsedLine
 * @property {string} raw     — original line text including whitespace
 * @property {string} trimmed — leading/trailing whitespace removed
 * @property {number} indent  — number of leading whitespace characters
 */

/**
 * @typedef {Object} AwaitingChoiceState
 * @property {number}         end       — line index past the entire *choice block
 * @property {ChoiceOption[]} choices   — parsed choice options
 * @property {number}         [_blockEnd] — set by executeBlock when a choice is hit inside a block
 * @property {number}         [_savedIp]  — ip to resume at after choice is made
 */

/**
 * @typedef {Object} ChoiceOption
 * @property {string}  text       — display text for the option
 * @property {boolean} selectable — false if *selectable_if condition failed
 * @property {number}  start      — first line index of the option's body
 * @property {number}  end        — line index past the option's body
 * @property {StatTag|null} statTag — inline stat requirement badge, if any
 */

/**
 * @typedef {Object} StatTag
 * @property {string} label       — stat label text (e.g. "Strength")
 * @property {number} requirement — minimum value required
 */

/**
 * @typedef {Object} StartupMeta
 * @property {string[]} sceneList — ordered scene names from *scene_list
 */

// ---------------------------------------------------------------------------
// Core game state
// ---------------------------------------------------------------------------

/** @type {Record<string, any>} */
export let playerState   = {};

/** @type {Record<string, any>} */
export let tempState     = {};

/** @type {StatRegistryEntry[]} */
export let statRegistry  = [];

// ---------------------------------------------------------------------------
// Interpreter position / flow
// ---------------------------------------------------------------------------

/** @type {string|null} */
export let currentScene  = null;

/** @type {ParsedLine[]} */
export let currentLines  = [];

/** @type {number} */
export let ip            = 0;

// ---------------------------------------------------------------------------
// Choice state
// ---------------------------------------------------------------------------

/** @type {AwaitingChoiceState|null} */
export let awaitingChoice = null;

// ---------------------------------------------------------------------------
// Startup metadata
// ---------------------------------------------------------------------------

/** @type {StartupMeta} */
export let startup = { sceneList: [] };

// ---------------------------------------------------------------------------
// chapterTitle — state-side mirror of the DOM #chapter-title text.
// Persisted in the save payload so restore can set it without a DOM query.
// ---------------------------------------------------------------------------

/** @type {string} */
export let chapterTitle = '—';

/** @param {string} t */
export function setChapterTitleState(t) { chapterTitle = t; }

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------

/** @param {Record<string, any>} s */
export function setPlayerState(s)           { playerState = s; }

/** @param {Record<string, any>} patch */
export function patchPlayerState(patch)     { Object.assign(playerState, patch); }

/** @param {Record<string, any>} s */
export function setTempState(s)             { tempState = s; }

/** @param {StatRegistryEntry[]} r */
export function setStatRegistry(r)          { statRegistry = r; }

/** @param {StartupMeta} s */
export function setStartup(s)               { startup = s; }

/** @param {string} s */
export function setCurrentScene(s)          { currentScene = s; }

/** @param {ParsedLine[]} l */
export function setCurrentLines(l)          { currentLines = l; }

/** @param {number} n */
export function setIp(n)                    { ip = n; }

export function advanceIp()                 { ip += 1; }

/** @param {AwaitingChoiceState|null} c */
export function setAwaitingChoice(c)        { awaitingChoice = c; }

// ---------------------------------------------------------------------------
// clearTempState — called by gotoScene on cross-scene navigation
// ---------------------------------------------------------------------------
export function clearTempState() {
  tempState = {};
}

// ---------------------------------------------------------------------------
// normalizeKey — canonical lowercase key used everywhere a variable is looked up
// ---------------------------------------------------------------------------
/**
 * @param {string} k — raw variable name
 * @returns {string} trimmed, lowercased key
 */
export function normalizeKey(k) {
  return String(k).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// resolveStore — returns the store object (tempState or playerState) that
// owns the given key, or null if the key is undeclared in both.
// This is the single source of truth for variable lookup order: temp → player.
// ---------------------------------------------------------------------------
/**
 * @param {string} key — normalised variable key
 * @returns {Record<string, any>|null}
 */
export function resolveStore(key) {
  if (Object.prototype.hasOwnProperty.call(tempState,   key)) return tempState;
  if (Object.prototype.hasOwnProperty.call(playerState, key)) return playerState;
  return null;
}

// ---------------------------------------------------------------------------
// Startup defaults — snapshot of playerState after parseStartup finishes.
// Used by save code delta encoding to avoid storing unchanged default values.
// ---------------------------------------------------------------------------

/** @type {Record<string, any>} */
let _startupDefaults = {};

export function captureStartupDefaults() {
  _startupDefaults = JSON.parse(JSON.stringify(playerState));
}

/** @returns {Record<string, any>} */
export function getStartupDefaults() {
  return _startupDefaults;
}

// ---------------------------------------------------------------------------
// setVar — handles the *set directive
//
// Supports arithmetic shorthand: *set xp +100  →  xp = xp + 100
// Accepts evalValueFn as a parameter to avoid a circular import with
// expression.js (which also needs to read state).
// ---------------------------------------------------------------------------
/**
 * @param {string} command — the full *set directive line (e.g. "*set xp +100")
 * @param {(expr: string) => any} evalValueFn — expression evaluator
 */
export function setVar(command, evalValueFn) {
  const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);
  const store = resolveStore(key);

  if (!store) {
    console.warn(`[state] *set on undeclared variable "${key}" — did you mean *create or *temp?`);
    return;
  }

  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === 'number') {
    const result = evalValueFn(`${store[key]} ${rhs}`);
    const coerced = Number.isFinite(result) ? result : evalValueFn(rhs);
    store[key] = coerced === 0 ? 0 : coerced;
  } else {
    store[key] = evalValueFn(rhs);
  }
}

// ---------------------------------------------------------------------------
// setStatClamped — handles the *set_stat directive
//
// Syntax: *set_stat key rhs [min:N] [max:N]
// Applies rhs using the same arithmetic-shorthand logic as setVar, then clamps
// the result to [min, max]. Bounds are optional; omitting one means unbounded.
// ---------------------------------------------------------------------------
/**
 * @param {string} command — the full *set_stat directive line
 * @param {(expr: string) => any} evalValueFn — expression evaluator
 */
export function setStatClamped(command, evalValueFn) {
  const m = command.match(/^\*set_stat\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rest] = m;
  const key = normalizeKey(rawKey);
  const store = resolveStore(key);

  if (!store) {
    console.warn(`[state] *set_stat on undeclared variable "${key}" — did you mean *create or *temp?`);
    return;
  }

  const minMatch = rest.match(/\bmin:\s*(-?[\d.]+)/i);
  const maxMatch = rest.match(/\bmax:\s*(-?[\d.]+)/i);
  const rhs = rest
    .replace(/\bmin:\s*-?[\d.]+/gi, '')
    .replace(/\bmax:\s*-?[\d.]+/gi, '')
    .trim();

  const minVal = minMatch ? Number(minMatch[1]) : -Infinity;
  const maxVal = maxMatch ? Number(maxMatch[1]) :  Infinity;

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
/**
 * @param {string} command — the full *temp directive line
 * @param {(expr: string) => any} evalValueFn — expression evaluator
 */
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
let _statRegistryWarningFired = false;

/**
 * @param {(name: string) => Promise<string>} fetchTextFileFn — loads a .txt file by name
 * @param {(expr: string) => any} evalValueFn — expression evaluator
 * @returns {Promise<void>}
 */
export async function parseStartup(fetchTextFileFn, evalValueFn) {
  const text  = await fetchTextFileFn('startup');
  const lines = text.split(/\r?\n/).map(raw => ({
    raw,
    trimmed: raw.trim(),
    indent:  (raw.match(/^\s*/)?.[0] || '').length,
  }));

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
    console.warn('[state] No *create_stat entries found in startup.txt.');
    _statRegistryWarningFired = true;
  }
}
