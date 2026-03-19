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

/** normalised lowercase key, human-readable label, initial value */
export interface StatRegistryEntry {
  key:        string;
  label:      string;
  defaultVal: number;
}

/** one parsed line from a scene file */
export interface ParsedLine {
  raw:     string;  // original line text including whitespace
  trimmed: string;  // leading/trailing whitespace removed
  indent:  number;  // number of leading whitespace characters
}

/** inline stat requirement badge on a choice option */
export interface StatTag {
  label:       string;  // stat label text (e.g. "Strength")
  requirement: number;  // minimum value required
}

/** a single parsed choice option */
export interface ChoiceOption {
  text:       string;       // display text for the option
  selectable: boolean;      // false if *selectable_if condition failed
  start:      number;       // first line index of the option's body
  end:        number;       // line index past the option's body
  statTag:    StatTag|null; // inline stat requirement badge, if any
}

/** persisted state while waiting for the player to pick a choice */
export interface AwaitingChoiceState {
  end:        number;        // line index past the entire *choice block
  choices:    ChoiceOption[];
  _blockEnd?: number;        // set by executeBlock when a choice is hit inside a block
  _savedIp?:  number;        // ip to resume at after choice is made
}

/** metadata loaded from startup.txt */
export interface StartupMeta {
  sceneList: string[]; // ordered scene names from *scene_list
}

// ---------------------------------------------------------------------------
// Core game state
// ---------------------------------------------------------------------------

export let playerState:   Record<string, any>    = {};
export let tempState:     Record<string, any>    = {};
export let statRegistry:  StatRegistryEntry[]    = [];

// ---------------------------------------------------------------------------
// Interpreter position / flow
// ---------------------------------------------------------------------------

export let currentScene:  string|null   = null;
export let currentLines:  ParsedLine[]  = [];
export let ip:            number        = 0;

// ---------------------------------------------------------------------------
// Choice state
// ---------------------------------------------------------------------------

export let awaitingChoice: AwaitingChoiceState|null = null;

// ---------------------------------------------------------------------------
// Page break state — stores the ip of the *page_break line while the
// interpreter is halted waiting for the user to click Continue.
// Used by saves.ts to capture the correct ip in save payloads (instead of
// the end-of-scene ip the interpreter jumps to for halting purposes).
// null when not at a page break.
// ---------------------------------------------------------------------------

export let pageBreakIp: number|null = null;

export function setPageBreakIp(n: number|null): void { pageBreakIp = n; }

// ---------------------------------------------------------------------------
// Startup metadata
// ---------------------------------------------------------------------------

export let startup: StartupMeta = { sceneList: [] };

// ---------------------------------------------------------------------------
// chapterTitle — state-side mirror of the DOM #chapter-title text.
// Persisted in the save payload so restore can set it without a DOM query.
// ---------------------------------------------------------------------------

export let chapterTitle: string = '—';

export function setChapterTitleState(t: string)    { chapterTitle = t; }

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------

export function setPlayerState(s: Record<string, any>)   { playerState = s; }
export function patchPlayerState(patch: Record<string, any>) { Object.assign(playerState, patch); }
export function setTempState(s: Record<string, any>)     { tempState = s; }
export function setStatRegistry(r: StatRegistryEntry[])  { statRegistry = r; }
export function setStartup(s: StartupMeta)               { startup = s; }
export function setCurrentScene(s: string)               { currentScene = s; }
export function setCurrentLines(l: ParsedLine[])         { currentLines = l; }
export function setIp(n: number)                         { ip = n; }
export function advanceIp()                              { ip += 1; }
export function setAwaitingChoice(c: AwaitingChoiceState|null) { awaitingChoice = c; }

// ---------------------------------------------------------------------------
// clearTempState — called by gotoScene on cross-scene navigation
// ---------------------------------------------------------------------------
export function clearTempState() {
  tempState = {};
}

// ---------------------------------------------------------------------------
// normalizeKey — canonical lowercase key used everywhere a variable is looked up
// ---------------------------------------------------------------------------
export function normalizeKey(k: string): string {
  return String(k).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// resolveStore — returns the store object (tempState or playerState) that
// owns the given key, or null if the key is undeclared in both.
// This is the single source of truth for variable lookup order: temp → player.
// ---------------------------------------------------------------------------
export function resolveStore(key: string): Record<string, any>|null {
  if (Object.prototype.hasOwnProperty.call(tempState,   key)) return tempState;
  if (Object.prototype.hasOwnProperty.call(playerState, key)) return playerState;
  return null;
}

// ---------------------------------------------------------------------------
// Startup defaults — snapshot of playerState after parseStartup finishes.
// Used by save code delta encoding to avoid storing unchanged default values.
// ---------------------------------------------------------------------------

let _startupDefaults: Record<string, any> = {};

export function captureStartupDefaults(): void {
  _startupDefaults = JSON.parse(JSON.stringify(playerState));
}

export function getStartupDefaults(): Record<string, any> {
  return _startupDefaults;
}

// ---------------------------------------------------------------------------
// setVar — handles the *set directive
//
// Supports arithmetic shorthand: *set xp +100  →  xp = xp + 100
// Accepts evalValueFn as a parameter to avoid a circular import with
// expression.js (which also needs to read state).
// ---------------------------------------------------------------------------
export function setVar(command: string, evalValueFn: (expr: string) => any): void {
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
export function setStatClamped(command: string, evalValueFn: (expr: string) => any): void {
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
export function declareTemp(command: string, evalValueFn: (expr: string) => any): void {
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

export async function parseStartup(
  fetchTextFileFn: (name: string) => Promise<string>,
  evalValueFn: (expr: string) => any,
): Promise<void> {
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
