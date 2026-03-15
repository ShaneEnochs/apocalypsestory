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
// ---------------------------------------------------------------------------

import {
  playerState, tempState, currentLines, ip, currentScene,
  _gotoJumped, awaitingChoice, pendingLevelUpDisplay,
  setCurrentScene, setCurrentLines, setIp, advanceIp,
  setGotoJumped, setAwaitingChoice, setDelayIndex, clearTempState,
  normalizeKey, setVar, declareTemp, patchPlayerState,
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
  runStatsScene:      null,
  fetchTextFile:      null,
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
  // evalValue's recursive descent parser handles all paren forms correctly —
  // (condition), (a) and (b), bare identifiers — so no stripping is needed.
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
// isRestore=true is passed by restoreFromSave, which has already called
// clearTempState() itself. Skipping the clear here avoids wiping any temp
// vars that restoreFromSave may have set before calling us, and makes the
// code match the comment that previously only described the intended behaviour.
// ---------------------------------------------------------------------------
export async function gotoScene(name, label = null, isRestore = false) {
  let text;
  try {
    text = await cb.fetchTextFile(name);
  } catch (err) {
    cb.showEngineError(`Could not load scene "${name}".\n${err.message}`);
    return;
  }
  if (!isRestore) clearTempState();
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
  saveGameToSlot('auto', label || null);
  await runInterpreter();
}

// ---------------------------------------------------------------------------
// runInterpreter — main execution loop.
// Runs until ip reaches end of scene or a *choice pauses execution.
// ---------------------------------------------------------------------------
export async function runInterpreter() {
  while (ip < currentLines.length) {
    await executeCurrentLine();
    if (awaitingChoice) break;
  }
  if (pendingLevelUpDisplay) cb.showInlineLevelUp();
  cb.runStatsScene();
}

// ---------------------------------------------------------------------------
// Command registry — directive → handler
//
// Handlers receive (t, line) where t = line.trimmed, line = full line object.
// Registration order does not matter; isDirective() prevents prefix clashes.
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

// *goto_scene sceneName  — MUST be registered before *goto (longer prefix first
// is fine because isDirective does exact-word matching, but explicit ordering
// is clearer and safer)
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
  // t.trimEnd() guards against trailing whitespace on the opening *system line
  // accidentally routing the block form to the inline path.
  if (t.trimEnd() === '*system') {
    // Multi-line block
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
  // Inline: *system "text" or *system text
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
  saveGameToSlot('auto', saveLabel);
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

// *input varName "Prompt text" — inline text input that pauses the interpreter.
// Creates a text field in the narrative; stores the value in the named variable
// when the player submits. Works like *choice: pauses execution until input is
// provided, then resumes from the next line.
registerCommand('*input', (t) => {
  const m = t.match(/^\*input\s+([a-zA-Z_][\w]*)\s+"([^"]+)"$/);
  if (!m) {
    cb.showEngineError(`*input requires: *input varName "Prompt text"\nGot: ${t}`);
    setIp(currentLines.length);
    return;
  }
  const varName = normalizeKey(m[1]);
  const prompt  = m[2];
  const resumeIp = ip + 1;

  // Jump ip past end of scene to stop runInterpreter's loop.
  // The onSubmit callback restores ip to resumeIp and re-enters the loop.
  setIp(currentLines.length);

  // Build the input UI via the callback system
  cb.showInputPrompt(varName, prompt, (value) => {
    // Store the value in tempState if it exists there, otherwise playerState
    if (Object.prototype.hasOwnProperty.call(tempState, varName)) {
      tempState[varName] = value;
    } else {
      playerState[varName] = value;
    }
    setIp(resumeIp);
    runInterpreter();
  });
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
registerCommand('*loop', async (t, line) => {
  const blockStart = ip + 1, blockEnd = findBlockEnd(blockStart, line.indent);
  let guard = 0;
  while (evaluateCondition(t) && guard < 100) {
    await executeBlock(blockStart, blockEnd);
    if (awaitingChoice) return;
    guard += 1;
  }
  if (guard >= 100) console.warn(`[interpreter] *loop guard tripped in "${currentScene}"`);
  setIp(blockEnd);
});

// *choice
registerCommand('*choice', (t, line) => {
  const parsed = parseChoice(ip, line.indent, { currentLines, evalValue });
  setAwaitingChoice({ end: parsed.end, choices: parsed.choices });
  cb.renderChoices(parsed.choices);
});

// *ending
registerCommand('*ending', () => {
  cb.showEndingScreen('The End', 'Your path is complete.');
  // Jump past end of scene to stop the interpreter loop — the game is over.
  setIp(currentLines.length);
});
