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
//   BUG-02: gotoScene auto-save now only fires when the interpreter halts at
//     a *choice or end-of-scene, not on chained *goto_scene. This prevents
//     double-saves and ensures the auto-save always reflects the scene that
//     is actually visible to the player.
//   BUG-04: *loop guard now calls cb.showEngineError (not just console.warn)
//     so authors see the infinite-loop error in-game, not just in DevTools.
//   BUG-06: malformed *selectable_if lines now call cb.showEngineError instead
//     of silently dropping the choice option.
//   BUG-08: pause directives (*page_break, *delay, *input) now warn if
//     pauseState is already set when they fire, preventing silent overwrites.
// ---------------------------------------------------------------------------

import {
  playerState, tempState, currentLines, ip, currentScene,
  _gotoJumped, awaitingChoice, pendingLevelUpDisplay,
  setCurrentScene, setCurrentLines, setIp, advanceIp,
  setGotoJumped, setAwaitingChoice, setDelayIndex, clearTempState,
  normalizeKey, setVar, declareTemp, patchPlayerState,
  setPauseState, clearPauseState, pauseState,
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
const cb = {
  addParagraph:       null,
  addSystem:          null,
  clearNarrative:     null,
  applyTransition:    null,
  renderChoices:      null,
  showInlineLevelUp:  null,
  showEndingScreen:   null,
  showEngineError:    null,
  scheduleStatsRender:null,
  setChapterTitle:    null,   // (title: string) → void
  showInputPrompt:    null,   // (varName, prompt, onSubmit) → void
  showPageBreak:      null,   // (btnText, onContinue) → void
  runStatsScene:      null,
  fetchTextFile:      null,
  getNarrativeLog:    null,   // () → log[] — passed to saveGameToSlot so auto-saves include the narrative log
};

export function registerCallbacks(fns) {
  Object.assign(cb, fns);
}

// ---------------------------------------------------------------------------
// scene cache — shared between gotoScene and fetchTextFile wrapper.
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
    return;
  }
  cb.addSystem(t.replace(/^\*system\s*/, '').trim().replace(/^"|"$/g, ''));
  advanceIp();
});

// *temp key [value]
registerCommand('*temp', (t) => {
  declareTemp(t, evalValue);
  advanceIp();
});

// *set key value
registerCommand('*set', (t) => {
  setVar(t, evalValue);
  checkAndApplyLevelUp(cb.scheduleStatsRender);
  cb.scheduleStatsRender();
  advanceIp();
});

// *flag key  — sets playerState[key] = true
registerCommand('*flag', (t) => {
  const key = normalizeKey(t.replace(/^\*flag\s*/, '').trim());
  if (key) { patchPlayerState({ [key]: true }); cb.scheduleStatsRender(); }
  advanceIp();
});

// *save_point [label]
registerCommand('*save_point', (t) => {
  const saveLabel = t.replace(/^\*save_point\s*/, '').trim() || null;
  saveGameToSlot('auto', saveLabel, cb.getNarrativeLog ? cb.getNarrativeLog() : []);
  cb.addSystem('[ PROGRESS SAVED ]');
  advanceIp();
});

// *uppercase key
registerCommand('*uppercase', (t) => {
  const key    = normalizeKey(t.replace(/^\*uppercase\s*/, '').trim());
  const inTemp = Object.prototype.hasOwnProperty.call(tempState, key);
  if (inTemp && typeof tempState[key] === 'string') {
    tempState[key] = tempState[key].toUpperCase();
  } else if (typeof playerState[key] === 'string') {
    patchPlayerState({ [key]: playerState[key].toUpperCase() });
  }
  advanceIp();
});

// *lowercase key
registerCommand('*lowercase', (t) => {
  const key    = normalizeKey(t.replace(/^\*lowercase\s*/, '').trim());
  const inTemp = Object.prototype.hasOwnProperty.call(tempState, key);
  if (inTemp && typeof tempState[key] === 'string') {
    tempState[key] = tempState[key].toLowerCase();
  } else if (typeof playerState[key] === 'string') {
    patchPlayerState({ [key]: playerState[key].toLowerCase() });
  }
  advanceIp();
});

// *add_item "Item Name"
registerCommand('*add_item', (t) => {
  const item = t.replace(/^\*add_item\s*/, '').trim().replace(/^"|"$/g, '');
  if (!Array.isArray(playerState.inventory)) playerState.inventory = [];
  addInventoryItem(item);
  cb.scheduleStatsRender();
  advanceIp();
});

// *remove_item "Item Name"
registerCommand('*remove_item', (t) => {
  removeInventoryItem(t.replace(/^\*remove_item\s*/, '').trim().replace(/^"|"$/g, ''));
  cb.scheduleStatsRender();
  advanceIp();
});

// *check_item "Item Name" dest_var
registerCommand('*check_item', (t) => {
  const checkArgs  = t.replace(/^\*check_item\s*/, '').trim();
  const checkMatch = checkArgs.match(/^"([^"]+)"\s+([a-zA-Z_][\w]*)$/) ||
                     checkArgs.match(/^(\S+)\s+([a-zA-Z_][\w]*)$/);
  if (!checkMatch) {
    cb.showEngineError(`*check_item requires two arguments: *check_item "Item Name" dest_var\nGot: ${t}`);
    setIp(currentLines.length);
    return;
  }
  const itemName    = checkMatch[1];
  const destKey     = normalizeKey(checkMatch[2]);
  const checkResult = Array.isArray(playerState.inventory) &&
    playerState.inventory.some(i => itemBaseName(i) === itemBaseName(itemName));
  if (Object.prototype.hasOwnProperty.call(tempState, destKey)) {
    tempState[destKey] = checkResult;
  } else {
    if (!Object.prototype.hasOwnProperty.call(playerState, destKey))
      console.warn(`[interpreter] *check_item dest_var "${destKey}" is undeclared.`);
    playerState[destKey] = checkResult;
  }
  advanceIp();
});

// *grant_skill "key" — adds skill without SP cost
registerCommand('*grant_skill', (t) => {
  const key = t.replace(/^\*grant_skill\s*/, '').trim().replace(/^"|"$/g, '');
  grantSkill(key);
  cb.scheduleStatsRender();
  advanceIp();
});

// *revoke_skill "key" — removes a skill
registerCommand('*revoke_skill', (t) => {
  const key = t.replace(/^\*revoke_skill\s*/, '').trim().replace(/^"|"$/g, '');
  revokeSkill(key);
  cb.scheduleStatsRender();
  advanceIp();
});

// *check_skill "key" dest_var — writes bool to variable
registerCommand('*check_skill', (t) => {
  const checkArgs  = t.replace(/^\*check_skill\s*/, '').trim();
  const checkMatch = checkArgs.match(/^"([^"]+)"\s+([a-zA-Z_][\w]*)$/) ||
                     checkArgs.match(/^(\S+)\s+([a-zA-Z_][\w]*)$/);
  if (!checkMatch) {
    cb.showEngineError(`*check_skill requires two arguments: *check_skill "key" dest_var\nGot: ${t}`);
    setIp(currentLines.length);
    return;
  }
  const skillKey    = normalizeKey(checkMatch[1]);
  const destKey     = normalizeKey(checkMatch[2]);
  const checkResult = playerHasSkill(skillKey);
  if (Object.prototype.hasOwnProperty.call(tempState, destKey)) {
    tempState[destKey] = checkResult;
  } else {
    if (!Object.prototype.hasOwnProperty.call(playerState, destKey))
      console.warn(`[interpreter] *check_skill dest_var "${destKey}" is undeclared.`);
    playerState[destKey] = checkResult;
  }
  advanceIp();
});

// *journal "Entry text" — adds a journal entry
registerCommand('*journal', (t) => {
  const text = t.replace(/^\*journal\s*/, '').trim().replace(/^"|"$/g, '');
  if (text) {
    addJournalEntry(text, 'entry');
    cb.scheduleStatsRender();
  }
  advanceIp();
});

// *achievement "Achievement text" — adds an achievement
registerCommand('*achievement', (t) => {
  const text = t.replace(/^\*achievement\s*/, '').trim().replace(/^"|"$/g, '');
  if (text) {
    addJournalEntry(text, 'achievement');
    cb.addSystem(`◆ Achievement Unlocked: ${text}`);
    cb.scheduleStatsRender();
  }
  advanceIp();
});

// ---------------------------------------------------------------------------
// Pause directives — page_break, delay, input
//
// BUG-08 fix: all three now warn if pauseState is already set when they fire.
// This catches authoring mistakes like two consecutive pause directives with
// no *choice or scene transition between them.
// ---------------------------------------------------------------------------

// *page_break [text] — clears the screen and shows a "Continue" button.
registerCommand('*page_break', (t) => {
  // BUG-08 guard
  if (pauseState !== null) {
    console.warn(`[interpreter] *page_break fired while pauseState is already "${pauseState.type}" — overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }

  const btnText  = t.replace(/^\*page_break\s*/, '').trim().replace(/^"|"$/g, '') || 'Continue';
  const resumeIp = ip + 1;

  setPauseState({ type: 'page_break', btnText, resumeIp });
  setIp(currentLines.length);

  cb.showPageBreak(btnText, () => {
    clearPauseState();
    cb.clearNarrative();
    cb.applyTransition();
    setIp(resumeIp);
    runInterpreter();
  });
});

// *delay ms — pauses the interpreter for the given number of milliseconds.
registerCommand('*delay', (t) => {
  // BUG-08 guard
  if (pauseState !== null) {
    console.warn(`[interpreter] *delay fired while pauseState is already "${pauseState.type}" — overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }

  const ms       = Number(t.replace(/^\*delay\s*/, '').trim()) || 500;
  const resumeIp = ip + 1;

  setPauseState({ type: 'delay', ms, resumeIp });
  setIp(currentLines.length);

  setTimeout(() => {
    clearPauseState();
    setIp(resumeIp);
    runInterpreter();
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

  cb.showInputPrompt(varName, prompt, (value) => {
    clearPauseState();
    if (Object.prototype.hasOwnProperty.call(tempState, varName)) {
      tempState[varName] = value;
    } else {
      playerState[varName] = value;
    }
    setIp(resumeIp);
    runInterpreter();
  });
});

// *choice
// BUG-06 fix: parseChoice errors are surfaced via cb.showEngineError.
// The fix lives in parser.js (parseChoice now accepts a showError callback),
// but *choice also validates that at least one option was produced.
registerCommand('*choice', (t, line) => {
  const parsed = parseChoice(ip, line.indent, { currentLines, evalValue });
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
registerCommand('*loop', async (t, line) => {
  const blockStart = ip + 1, blockEnd = findBlockEnd(blockStart, line.indent);
  let guard = 0;
  while (evaluateCondition(t) && guard < 100) {
    await executeBlock(blockStart, blockEnd);
    if (awaitingChoice) return;
    // If a *goto inside the loop body relocated ip, honour it and exit the loop.
    if (_gotoJumped) { setGotoJumped(false); return; }
    guard += 1;
  }
  if (guard >= 100) {
    // BUG-04: show error in-game, not just console, so author can diagnose it.
    cb.showEngineError(`*loop guard tripped in scene "${currentScene}" — possible infinite loop. Check that the loop condition can become false.`);
  }
  setIp(blockEnd);
});
