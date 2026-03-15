// ---------------------------------------------------------------------------
// core/interpreter.js — Scene interpreter, flow helpers, and directive registry
//
// Owns the core execution loop and all directive handlers. Uses a command
// registry (Map) rather than a monolithic if-chain — each directive is a
// small named function registered at module load. This makes the interpreter
// a dispatcher and keeps each directive's logic self-contained.
//
// Callback pattern — to avoid circular imports with the UI layer, functions
// that need to call narrative / UI code do so via a registered callback set
// populated by engine.js at boot (see registerCallbacks below).
//
// Dependency graph (one-directional, no cycles):
//   interpreter.js
//     → state.js        (read/write engine state)
//     → expression.js   (evaluate conditions / rhs values)
//     → parser.js       (parseChoice, parseSystemBlock, parseLines, indexLabels)
//     → inventory.js    (addInventoryItem, removeInventoryItem, itemBaseName)
//     → leveling.js     (checkAndApplyLevelUp)
//     → saves.js        (saveGameToSlot)
//     → skills.js       (grantSkill, revokeSkill, playerHasSkill)
//     ← engine.js       (injects UI callbacks at boot via registerCallbacks)
//
// Bug fixes in this file:
//   BUG-01 (original): gotoScene auto-save only fires when the interpreter
//     halts at a *choice or end-of-scene, not on chained *goto_scene.
//   BUG-02 (original): *loop guard calls cb.showEngineError.
//   BUG-04 (original): malformed *selectable_if calls cb.showEngineError.
//   BUG-08 (original): pause directives warn if pauseState already set.
//
//   FIX #1 (sweep 2): *choice handler now forwards cb.showEngineError to
//     parseChoice via the ctx object. Previously the BUG-06 fix in parser.js
//     was dead code at runtime because the caller never passed the callback.
//
//   FIX #2 (sweep 2): *delay and *input setTimeout callbacks now call
//     runInterpreter().catch(cb.showEngineError) instead of fire-and-forget.
//     Previously, any error thrown inside runInterpreter after a delay became
//     a silent unhandled promise rejection.
//
//   FIX #10 (sweep 2): *loop guard raised from 100 → 10,000 iterations so
//     legitimate high-count loops (e.g. procedural generation) don't hit the
//     guard. The error message is still surfaced in-game at the limit.
// ---------------------------------------------------------------------------

import {
  playerState, tempState, currentLines, ip, currentScene,
  _gotoJumped, awaitingChoice, pendingLevelUpDisplay,
  setCurrentScene, setCurrentLines, setIp, advanceIp,
  setGotoJumped, setAwaitingChoice, setDelayIndex, clearTempState,
  normalizeKey, setVar, setStatClamped, declareTemp, patchPlayerState,
  setPauseState, clearPauseState, pauseState,
  sessionState, patchSessionState,
} from './state.js';

import { evalValue }            from './expression.js';
import { parseLines, indexLabels, parseChoice, parseSystemBlock } from './parser.js';
import { addInventoryItem, removeInventoryItem, itemBaseName }     from '../systems/inventory.js';
import { checkAndApplyLevelUp }                                    from '../systems/leveling.js';
import { saveGameToSlot }                                          from '../systems/saves.js';
import { grantSkill, revokeSkill, playerHasSkill }                 from '../systems/skills.js';
import { addJournalEntry }                                         from '../systems/journal.js';

// ---------------------------------------------------------------------------
// Callback registry — UI functions injected by engine.js at boot.
//
// The interpreter needs to call addParagraph, addSystem, clearNarrative,
// applyTransition, formatText, renderChoices, showInlineLevelUp,
// showEndingScreen, showEngineError, scheduleStatsRender, and access
// dom.chapterTitle. None of those live here. At boot, engine.js calls
// registerCallbacks({ ... }) to wire them up.
// ---------------------------------------------------------------------------
const cb = {};

export function registerCallbacks(callbacks) {
  Object.assign(cb, callbacks);
}

// Passed in from engine.js so the same Map instance is used everywhere.
// ---------------------------------------------------------------------------
let _sceneCache  = null;
let _labelsCache = null;

export function registerCaches(sceneCache, labelsCache) {
  _sceneCache  = sceneCache;
  _labelsCache = labelsCache;
}

// ---------------------------------------------------------------------------
// isDirective — exact prefix match that prevents *goto matching *goto_scene.
// A directive boundary is end-of-string OR a whitespace character.
// ---------------------------------------------------------------------------
export function isDirective(trimmed, directive) {
  if (!trimmed.startsWith(directive)) return false;
  const rest = trimmed.slice(directive.length);
  return rest === '' || /\s/.test(rest[0]);
}

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

export function findBlockEnd(fromIndex, parentIndent) {
  let i = fromIndex;
  while (i < currentLines.length) {
    const l = currentLines[i];
    if (l.trimmed && l.indent <= parentIndent) break;
    i += 1;
  }
  return i;
}

export function findIfChainEnd(fromIndex, indent) {
  let i = fromIndex + 1;
  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    if (line.indent < indent) break;
    if (line.indent === indent) {
      if (isDirective(line.trimmed, '*elseif')) { i = findBlockEnd(i + 1, indent); continue; }
      if (isDirective(line.trimmed, '*else'))   { i = findBlockEnd(i + 1, indent); break; }
      break;
    }
    i += 1;
  }
  return i;
}

export function evaluateCondition(raw) {
  const condition = raw
    .replace(/^\*if\s*/,     '')
    .replace(/^\*elseif\s*/, '')
    .replace(/^\*loop\s*/,   '')
    .trim();
  return !!evalValue(condition);
}

// ---------------------------------------------------------------------------
// executeBlock — runs lines [start, end) then sets ip to resumeAfter.
// If a *choice is encountered mid-block, stashes _blockEnd and _savedIp on
// the awaitingChoice object so runInterpreter can resume correctly after the
// choice is resolved.
// ---------------------------------------------------------------------------
export async function executeBlock(start, end, resumeAfter = end) {
  setIp(start);
  while (ip < end) {
    await executeCurrentLine();
    if (awaitingChoice) {
      const ac = awaitingChoice;
      ac._blockEnd = end;
      ac._savedIp  = resumeAfter;
      setAwaitingChoice(ac);
      return;
    }
    if (_gotoJumped) {
      setGotoJumped(false);
      return;
    }
  }
  setIp(resumeAfter);
}

// ---------------------------------------------------------------------------
// gotoScene — cross-scene navigation.
//
// BUG-02 fix: the auto-save is now ONLY written when runInterpreter actually
// halts (at a *choice or end-of-scene). If gotoScene is called recursively
// via *goto_scene inside a running scene, the inner call's runInterpreter
// will handle the save when it stops. The outer gotoScene call must NOT
// also write an auto-save, because:
//   1. The outer save fires after the inner one (wrong scene content).
//   2. It causes two consecutive localStorage writes for a single navigation.
//
// Implementation: runInterpreter now writes the auto-save after it stops.
// gotoScene no longer calls saveGameToSlot directly.
// ---------------------------------------------------------------------------
export async function gotoScene(name, label = null) {
  let text;
  try {
    text = await cb.fetchTextFile(name);
  } catch (err) {
    cb.showEngineError(`Could not load scene "${name}".\n${err.message}`);
    return;
  }
  clearTempState();
  setCurrentScene(name);
  setCurrentLines(parseLines(text));
  indexLabels(name, currentLines, _labelsCache);
  setIp(0);
  setDelayIndex(0);
  cb.clearNarrative();
  cb.applyTransition();
  cb.setChapterTitle(name.toUpperCase());

  if (label) {
    const labels = _labelsCache.get(name) || {};
    setIp(labels[label] ?? 0);
  }

  // Clear any stale choice/pause state from a previous scene or session.
  setAwaitingChoice(null);
  setGotoJumped(false);
  clearPauseState();

  await runInterpreter();
  // NOTE: auto-save is now written inside runInterpreter when it stops,
  // not here. See BUG-02 fix comment above.
}

// ---------------------------------------------------------------------------
// runInterpreter — main execution loop.
// Runs until ip reaches end of scene or a *choice pauses execution.
//
// BUG-02 fix: auto-save is written here, after the loop stops, so the saved
// narrative log is always fully populated. This is the single canonical
// auto-save point for normal scene execution. *save_point writes its own
// save independently.
// ---------------------------------------------------------------------------
export async function runInterpreter() {
  while (ip < currentLines.length) {
    await executeCurrentLine();
    if (awaitingChoice) break;
  }
  if (pendingLevelUpDisplay) cb.showInlineLevelUp();
  cb.runStatsScene();

  // Auto-save: fires when the interpreter halts at a *choice or end-of-scene.
  // Paused states (*page_break, *delay, *input) set pauseState before stopping
  // the loop via setIp(currentLines.length); the auto-save captures that too.
  if (cb.getNarrativeLog) {
    saveGameToSlot('auto', null, cb.getNarrativeLog());
  }
}

// ---------------------------------------------------------------------------
// Command registry — directive → handler
//
// Handlers receive (t, line) where t = line.trimmed, line = full line object.
// Registration order matters for prefix overlaps — Map iterates in insertion
// order and the first match wins. isDirective() does exact-word matching so
// *goto won't match *goto_scene, but register longer variants first anyway
// for clarity (see *goto_scene before *goto below).
// ---------------------------------------------------------------------------
const commands = new Map();

function registerCommand(directive, handler) {
  commands.set(directive, handler);
}

// ---------------------------------------------------------------------------
// executeCurrentLine — dispatcher.
// Skips empty / comment lines. Plain text lines become paragraphs.
// Directive lines are dispatched through the command registry.
// Unknown directives are skipped with a warning.
// ---------------------------------------------------------------------------
export async function executeCurrentLine() {
  const line = currentLines[ip];
  if (!line) return;
  if (!line.trimmed || line.trimmed.startsWith('//')) { advanceIp(); return; }

  const t = line.trimmed;

  // Plain narrative text
  if (!t.startsWith('*')) { cb.addParagraph(t); advanceIp(); return; }

  // Directive dispatch
  for (const [directive, handler] of commands) {
    if (isDirective(t, directive)) {
      await handler(t, line);
      return;
    }
  }

  // Unknown directive — skip and warn
  console.warn(`[interpreter] Unknown directive "${t.split(/\s/)[0]}" in "${currentScene}" at line ${ip} — skipping.`);
  advanceIp();
}

// ---------------------------------------------------------------------------
// Directive handlers — registered below
// ---------------------------------------------------------------------------

// *title text
registerCommand('*title', (t) => {
  cb.setChapterTitle(t.replace(/^\*title\s*/, '').trim());
  advanceIp();
});

// *label name  — jump targets; no runtime action needed
registerCommand('*label',   () => { advanceIp(); });

// *comment text — ignored
registerCommand('*comment', () => { advanceIp(); });

// *goto_scene sceneName  — MUST be registered before *goto
registerCommand('*goto_scene', async (t) => {
  await gotoScene(t.replace(/^\*goto_scene\s*/, '').trim());
});

// *goto label
registerCommand('*goto', (t) => {
  const label  = t.replace(/^\*goto\s*/, '').trim();
  const labels = _labelsCache.get(currentScene) || {};
  if (labels[label] === undefined) {
    cb.showEngineError(`Unknown label "${label}" in scene "${currentScene}".`);
    setIp(currentLines.length);
    return;
  }
  setIp(labels[label]);
  setGotoJumped(true);
});

// *system [text] / *system … *end_system
registerCommand('*system', (t) => {
  if (t.trimEnd() === '*system') {
    const parsed = parseSystemBlock(ip, { currentLines });
    if (!parsed.ok) {
      cb.showEngineError(`Unclosed *system block in "${currentScene}". Add *end_system.`);
      setIp(currentLines.length);
      return;
    }
    cb.addSystem(parsed.text);
    setIp(parsed.endIp);
  } else {
    cb.addSystem(t.replace(/^\*system\s*/, '').trim());
    advanceIp();
  }
});

// *set varName value
registerCommand('*set', (t) => {
  setVar(t, evalValue);
  advanceIp();
});

// *set_stat varName value [min:N] [max:N]
registerCommand('*set_stat', (t) => {
  setStatClamped(t, evalValue);
  advanceIp();
});

// *create varName value
registerCommand('*create', (t) => {
  const m = t.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) { advanceIp(); return; }
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);
  playerState[key] = evalValue(rhs);
  advanceIp();
});

// *create_stat key "Label" defaultValue
registerCommand('*create_stat', (t) => {
  const m = t.match(/^\*create_stat\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(.+)$/);
  if (!m) { advanceIp(); return; }
  const [, rawKey, label, rhs] = m;
  const key = normalizeKey(rawKey);
  const defaultVal = evalValue(rhs);
  playerState[key] = defaultVal;
  // Register so the stats panel knows this is an allocatable stat
  import('../core/state.js').then(({ statRegistry, setStatRegistry }) => {
    if (!statRegistry.find(e => e.key === key)) {
      setStatRegistry([...statRegistry, { key, label, defaultVal }]);
    }
  });
  advanceIp();
});

// *temp varName [value]
registerCommand('*temp', (t) => {
  declareTemp(t, evalValue);
  advanceIp();
});

// *add_xp N
registerCommand('*add_xp', (t) => {
  const n = Number(t.replace(/^\*add_xp\s*/, '').trim()) || 0;
  if (n > 0) {
    playerState.xp = Number(playerState.xp || 0) + n;
    checkAndApplyLevelUp(cb.scheduleStatsRender);
    cb.scheduleStatsRender();
  }
  advanceIp();
});

// *add_item itemName
registerCommand('*add_item', (t) => {
  addInventoryItem(t.replace(/^\*add_item\s*/, '').trim());
  cb.scheduleStatsRender();
  advanceIp();
});

// *remove_item itemName
registerCommand('*remove_item', (t) => {
  removeInventoryItem(t.replace(/^\*remove_item\s*/, '').trim());
  cb.scheduleStatsRender();
  advanceIp();
});

// *grant_skill key
registerCommand('*grant_skill', (t) => {
  grantSkill(t.replace(/^\*grant_skill\s*/, '').trim());
  cb.scheduleStatsRender();
  advanceIp();
});

// *revoke_skill key
registerCommand('*revoke_skill', (t) => {
  revokeSkill(t.replace(/^\*revoke_skill\s*/, '').trim());
  cb.scheduleStatsRender();
  advanceIp();
});

// *if_skill key
registerCommand('*if_skill', async (t, line) => {
  const key  = normalizeKey(t.replace(/^\*if_skill\s*/, '').trim());
  const cond = playerHasSkill(key);
  if (cond) {
    const bs = ip + 1, be = findBlockEnd(bs, line.indent);
    await executeBlock(bs, be);
  } else {
    setIp(findBlockEnd(ip + 1, line.indent));
  }
});

// *journal text
registerCommand('*journal', (t) => {
  const text = t.replace(/^\*journal\s*/, '').trim();
  if (text) { addJournalEntry(text, 'entry'); cb.scheduleStatsRender(); }
  advanceIp();
});

// *achievement text
registerCommand('*achievement', (t) => {
  const text = t.replace(/^\*achievement\s*/, '').trim();
  if (text) { addJournalEntry(text, 'achievement', true); cb.scheduleStatsRender(); }
  advanceIp();
});

// *session_set key value  (ENH-08)
registerCommand('*session_set', (t) => {
  const m = t.match(/^\*session_set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) { advanceIp(); return; }
  const key = normalizeKey(m[1]);
  patchSessionState({ [key]: evalValue(m[2]) });
  advanceIp();
});

// *save_point [label]
registerCommand('*save_point', (t) => {
  const label = t.replace(/^\*save_point\s*/, '').trim() || null;
  if (cb.getNarrativeLog) saveGameToSlot('auto', label, cb.getNarrativeLog());
  advanceIp();
});

// *page_break [btnText]
registerCommand('*page_break', (t) => {
  // BUG-08 guard
  if (pauseState !== null) {
    console.warn(`[interpreter] *page_break fired while pauseState is already "${pauseState.type}" — overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }

  const btnText  = t.replace(/^\*page_break\s*/, '').trim() || 'Continue';
  const resumeIp = ip + 1;

  setPauseState({ type: 'page_break', resumeIp });
  setIp(currentLines.length);

  cb.showPageBreak(btnText, () => {
    clearPauseState();
    cb.clearNarrative();
    setIp(resumeIp);
    runInterpreter().catch(err => cb.showEngineError(err.message)); // FIX #2
  });
});

// *delay N  (milliseconds)
registerCommand('*delay', (t) => {
  // BUG-08 guard
  if (pauseState !== null) {
    console.warn(`[interpreter] *delay fired while pauseState is already "${pauseState.type}" — overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }

  const ms       = Number(t.replace(/^\*delay\s*/, '').trim()) || 500;
  const resumeIp = ip + 1;

  setPauseState({ type: 'delay', ms, resumeIp });
  setIp(currentLines.length);

  // FIX #2: runInterpreter is async — must .catch() so errors are not swallowed
  // as silent unhandled promise rejections.
  setTimeout(() => {
    clearPauseState();
    setIp(resumeIp);
    runInterpreter().catch(err => cb.showEngineError(err.message));
  }, ms);
});

// *input varName "Prompt text" — inline text input that pauses the interpreter.
registerCommand('*input', (t) => {
  const m = t.match(/^\*input\s+([a-zA-Z_][\w]*)\s+"([^"]+)"$/);
  if (!m) {
    cb.showEngineError(`*input requires: *input varName "Prompt text"\nGot: ${t}`);
    setIp(currentLines.length);
    return;
  }

  // BUG-08 guard
  if (pauseState !== null) {
    console.warn(`[interpreter] *input fired while pauseState is already "${pauseState.type}" — overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }

  const varName  = normalizeKey(m[1]);
  const prompt   = m[2];
  const resumeIp = ip + 1;

  setPauseState({ type: 'input', varName, prompt, resumeIp });
  setIp(currentLines.length);

  // FIX #2: runInterpreter is async — must .catch() so errors are not swallowed.
  cb.showInputPrompt(varName, prompt, (value) => {
    clearPauseState();
    if (Object.prototype.hasOwnProperty.call(tempState, varName)) {
      tempState[varName] = value;
    } else {
      playerState[varName] = value;
    }
    setIp(resumeIp);
    runInterpreter().catch(err => cb.showEngineError(err.message));
  });
});

// *choice
// FIX #1: parseChoice now receives cb.showEngineError via the ctx object so
//   malformed *selectable_if lines surface in-game, not just in the console.
//   Previously the BUG-06 fix in parser.js was dead code at runtime because
//   the *choice handler never passed the callback.
registerCommand('*choice', (t, line) => {
  const parsed = parseChoice(ip, line.indent, {
    currentLines,
    evalValue,
    showEngineError: cb.showEngineError,  // FIX #1: wire up the BUG-06 callback
  });
  if (parsed.choices.length === 0) {
    cb.showEngineError(`*choice at line ${ip} in "${currentScene}" produced no options. Check for missing or malformed # lines.`);
    setIp(currentLines.length);
    return;
  }
  setAwaitingChoice({ end: parsed.end, choices: parsed.choices });
  cb.renderChoices(parsed.choices);
});

// *ending
registerCommand('*ending', () => {
  cb.showEndingScreen('The End', 'Your path is complete.');
  // Jump past end of scene to stop the interpreter loop — the game is over.
  setIp(currentLines.length);
});

// *if / *elseif / *else  (full chain resolution)
registerCommand('*if', async (t, line) => {
  const chainEnd = findIfChainEnd(ip, line.indent);
  let cursor = ip, executed = false;
  while (cursor < chainEnd) {
    const c = currentLines[cursor];
    if (!c.trimmed) { cursor += 1; continue; }
    if (isDirective(c.trimmed, '*if') || isDirective(c.trimmed, '*elseif')) {
      const bs = cursor + 1, be = findBlockEnd(bs, c.indent);
      if (!executed && evaluateCondition(c.trimmed)) {
        await executeBlock(bs, be, chainEnd);
        executed = true;
        if (awaitingChoice) return;
      }
      cursor = be; continue;
    }
    if (isDirective(c.trimmed, '*else')) {
      const bs = cursor + 1, be = findBlockEnd(bs, c.indent);
      if (!executed) { await executeBlock(bs, be, chainEnd); if (awaitingChoice) return; }
      cursor = be; continue;
    }
    cursor += 1;
  }
  setIp(chainEnd);
});

// *loop condition
// BUG-04 fix: guard trip now calls cb.showEngineError so the author sees it
// in-game rather than only in the browser console.
// FIX #10: guard raised from 100 → 10,000 so legitimate high-count loops
//   (procedural generation, countdown timers) don't hit the limit.
registerCommand('*loop', async (t, line) => {
  const LOOP_GUARD = 10_000;
  const blockStart = ip + 1, blockEnd = findBlockEnd(blockStart, line.indent);
  let guard = 0;
  while (evaluateCondition(t) && guard < LOOP_GUARD) {
    await executeBlock(blockStart, blockEnd);
    if (awaitingChoice) return;
    // If a *goto inside the loop body relocated ip, honour it and exit the loop.
    if (_gotoJumped) { setGotoJumped(false); return; }
    guard += 1;
  }
  if (guard >= LOOP_GUARD) {
    cb.showEngineError(`*loop guard tripped in scene "${currentScene}" after ${LOOP_GUARD} iterations — possible infinite loop. Check that the loop condition can become false.`);
  }
  setIp(blockEnd);
});

// *patch_state key value  (runtime patchPlayerState)
registerCommand('*patch_state', (t) => {
  const m = t.match(/^\*patch_state\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) { advanceIp(); return; }
  patchPlayerState({ [normalizeKey(m[1])]: evalValue(m[2]) });
  advanceIp();
});
