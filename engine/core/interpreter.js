// core/interpreter.js — Scene interpreter, flow helpers, and directive registry
//
// Owns the core execution loop and all directive handlers. Uses a command
// registry (Map) rather than a monolithic if-chain — each directive is a
// small named function registered at module load.
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
//     → saves.js        (saveGameToSlot)
//     → skills.js       (grantSkill, revokeSkill, playerHasSkill)
//     ← engine.js       (injects UI callbacks at boot via registerCallbacks)

import {
  playerState, tempState, currentLines, ip, currentScene,
  awaitingChoice, startup,
  statRegistry, setStatRegistry,
  setCurrentScene, setCurrentLines, setIp, advanceIp,
  setAwaitingChoice, clearTempState,
  normalizeKey, resolveStore, setVar, setStatClamped, declareTemp, patchPlayerState,
  chapterTitle, setChapterTitleState,
} from './state.js';

import { evalValue }            from './expression.js';
import { parseLines, indexLabels, parseChoice, parseSystemBlock } from './parser.js';
import { addInventoryItem, removeInventoryItem, itemBaseName }     from '../systems/inventory.js';
import { saveGameToSlot }                                          from '../systems/saves.js';
import { grantSkill, revokeSkill, playerHasSkill }                 from '../systems/skills.js';
import { addJournalEntry }                                         from '../systems/journal.js';

// ---------------------------------------------------------------------------
// Callback registry — UI functions injected by engine.js at boot.
// ---------------------------------------------------------------------------
const cb = {};

export function registerCallbacks(callbacks) {
  Object.assign(cb, callbacks);
}

// Scene and label caches — passed in from engine.js so the same Map instance
// is used everywhere.
let _sceneCache  = null;
let _labelsCache = null;

export function registerCaches(sceneCache, labelsCache) {
  _sceneCache  = sceneCache;
  _labelsCache = labelsCache;
}

// Gosub call stack — stores return addresses for *gosub/*return
const _gosubStack = [];

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
// Returns a reason string: 'choice', 'goto', or 'normal'.
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
      return 'choice';
    }
    if (ip < start || ip >= end) {
      return 'goto';
    }
  }
  setIp(resumeAfter);
  return 'normal';
}

// ---------------------------------------------------------------------------
// gotoScene — cross-scene navigation.
//
// Auto-save is written by runInterpreter when it halts, not by gotoScene,
// so recursive *goto_scene calls don't produce duplicate saves.
//
// The *title directive in the scene file sets the chapter title. After
// runInterpreter finishes, if no *title ran, a fallback sets the uppercased
// scene name.
// ---------------------------------------------------------------------------
export async function gotoScene(name, label = null) {
  let text;
  try {
    text = await cb.fetchTextFile(name);
  } catch (err) {
    cb.showEngineError(`Could not load scene "${name}".\n${err.message}`);
    return;
  }

  const prevChapterTitle = chapterTitle;

  clearTempState();
  _gosubStack.length = 0;
  setCurrentScene(name);
  setCurrentLines(parseLines(text));
  indexLabels(name, currentLines, _labelsCache);
  setIp(0);
  cb.clearNarrative();
  cb.applyTransition();

  if (label) {
    const labels = _labelsCache.get(name) || {};
    setIp(labels[label] ?? 0);
  }

  setAwaitingChoice(null);

  await runInterpreter();

  if (chapterTitle === prevChapterTitle) {
    const fallback = name.replace(/\.txt$/i, '').toUpperCase();
    cb.setChapterTitle(fallback);
  }
}

export async function runInterpreter({ suppressAutoSave = false } = {}) {
  while (ip < currentLines.length) {
    await executeCurrentLine();
    if (awaitingChoice) break;
  }
  cb.runStatsScene();

  if (!suppressAutoSave && cb.getNarrativeLog) {
    saveGameToSlot('auto', null, cb.getNarrativeLog());
  }
}

// ---------------------------------------------------------------------------
// Command registry — directive → handler
//
// Handlers receive (t, line) where t = line.trimmed, line = full line object.
// Registration order matters for prefix overlaps — Map iterates in insertion
// order and the first match wins.
// ---------------------------------------------------------------------------
const commands = new Map();

function registerCommand(directive, handler) {
  commands.set(directive, handler);
}

// ---------------------------------------------------------------------------
// executeCurrentLine — dispatcher.
// Skips empty / comment lines. Plain text lines become paragraphs.
// Directive lines are dispatched through the command registry.
// ---------------------------------------------------------------------------
export async function executeCurrentLine() {
  const line = currentLines[ip];
  if (!line) return;
  if (!line.trimmed || line.trimmed.startsWith('//')) { advanceIp(); return; }

  const t = line.trimmed;

  if (!t.startsWith('*')) { cb.addParagraph(t); advanceIp(); return; }

  for (const [directive, handler] of commands) {
    if (isDirective(t, directive)) {
      await handler(t, line);
      return;
    }
  }

  console.warn(`[interpreter] Unknown directive "${t.split(/\s/)[0]}" in "${currentScene}" at line ${ip} — skipping.`);
  advanceIp();
}

// ---------------------------------------------------------------------------
// Directive handlers
// ---------------------------------------------------------------------------

// *title text
registerCommand('*title', (t) => {
  cb.setChapterTitle(t.replace(/^\*title\s*/, '').trim());
  advanceIp();
});

// *set_game_title "New Title"
registerCommand('*set_game_title', (t) => {
  const m = t.match(/^\*set_game_title\s+"([^"]+)"$/);
  const title = m ? m[1] : t.replace(/^\*set_game_title\s*/, '').trim();
  if (title) {
    playerState.game_title = title;
    if (cb.setGameTitle) cb.setGameTitle(title);
  }
  advanceIp();
});

// *set_game_byline "New Byline"
registerCommand('*set_game_byline', (t) => {
  const m = t.match(/^\*set_game_byline\s+"([^"]+)"$/);
  const byline = m ? m[1] : t.replace(/^\*set_game_byline\s*/, '').trim();
  if (byline) {
    playerState.game_byline = byline;
    if (cb.setGameByline) cb.setGameByline(byline);
  }
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
// Uses static imports from state.js for synchronous registration.
registerCommand('*create_stat', (t) => {
  const m = t.match(/^\*create_stat\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(.+)$/);
  if (!m) { advanceIp(); return; }
  const [, rawKey, label, rhs] = m;
  const key      = normalizeKey(rawKey);
  const defaultVal = evalValue(rhs);
  playerState[key] = defaultVal;
  if (!statRegistry.find(e => e.key === key)) {
    setStatRegistry([...statRegistry, { key, label, defaultVal }]);
  }
  advanceIp();
});

// *temp varName [value]
registerCommand('*temp', (t) => {
  declareTemp(t, evalValue);
  advanceIp();
});

// *award_essence N  /  *add_essence N
function _handleAddEssence(n) {
  if (n > 0) {
    playerState.essence = Number(playerState.essence || 0) + n;
    cb.scheduleStatsRender();
  }
  advanceIp();
}
registerCommand('*award_essence', (t) => {
  _handleAddEssence(Number(t.replace(/^\*award_essence\s*/, '').trim()) || 0);
});
registerCommand('*add_essence', (t) => {
  _handleAddEssence(Number(t.replace(/^\*add_essence\s*/, '').trim()) || 0);
});

// stripItemName — strips surrounding quotes from item name arguments.
function stripItemName(raw) {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// *add_item "itemName"
registerCommand('*add_item', (t) => {
  addInventoryItem(stripItemName(t.replace(/^\*add_item\s*/, '')));
  cb.scheduleStatsRender();
  advanceIp();
});

// *grant_item "itemName" — alias for *add_item
registerCommand('*grant_item', (t) => {
  addInventoryItem(stripItemName(t.replace(/^\*grant_item\s*/, '')));
  cb.scheduleStatsRender();
  advanceIp();
});

// *remove_item "itemName"
registerCommand('*remove_item', (t) => {
  removeInventoryItem(stripItemName(t.replace(/^\*remove_item\s*/, '')));
  cb.scheduleStatsRender();
  advanceIp();
});

// *check_item "itemName" variableName
registerCommand('*check_item', (t) => {
  const m = t.match(/^\*check_item\s+"([^"]+)"\s+([\w_]+)/);
  if (!m) {
    console.warn(`[interpreter] *check_item: malformed — expected: *check_item "Item Name" varName\nGot: ${t}`);
    advanceIp(); return;
  }
  const itemName = m[1];
  const varName  = normalizeKey(m[2]);
  const inv      = Array.isArray(playerState.inventory) ? playerState.inventory : [];
  const has      = inv.some(i => itemBaseName(i) === itemName);

  const store = resolveStore(varName);
  if (store) store[varName] = has;
  else       tempState[varName] = has;
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
    const reason = await executeBlock(bs, be, be);
    if (reason === 'choice' || reason === 'goto') return;
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

// *notify "Message" [duration]
// Shows a toast notification. Supports ${variable} interpolation via formatText.
registerCommand('*notify', (t) => {
  const m = t.match(/^\*notify\s+"([^"]+)"(?:\s+(\d+))?/);
  if (m) {
    const raw      = m[1];
    const duration = m[2] ? Number(m[2]) : 2000;
    const message  = cb.formatText ? cb.formatText(raw).replace(/<[^>]+>/g, '') : raw;
    if (cb.showToast) cb.showToast(message, duration);
  }
  advanceIp();
});

// *achievement text
registerCommand('*achievement', (t) => {
  const text = t.replace(/^\*achievement\s*/, '').trim();
  if (text) { addJournalEntry(text, 'achievement', true); cb.scheduleStatsRender(); }
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
  const btnText  = t.replace(/^\*page_break\s*/, '').trim() || 'Continue';
  const resumeIp = ip + 1;

  setIp(currentLines.length);

  cb.showPageBreak(btnText, () => {
    cb.clearNarrative();
    setIp(resumeIp);
    runInterpreter().catch(err => cb.showEngineError(err.message));
  });
});

// *input varName "Prompt text" — inline text input that pauses the interpreter.
registerCommand('*input', (t) => {
  const m = t.match(/^\*input\s+([a-zA-Z_][\w]*)\s+"([^"]+)"$/);
  if (!m) {
    cb.showEngineError(`*input requires: *input varName "Prompt text"\nGot: ${t}`);
    setIp(currentLines.length);
    return;
  }

  const varName  = normalizeKey(m[1]);
  const prompt   = m[2];
  const resumeIp = ip + 1;

  setIp(currentLines.length);

  cb.showInputPrompt(varName, prompt, (value) => {
    const store = resolveStore(varName);
    if (!store) {
      cb.showEngineError(`*input: variable "${varName}" is not declared. Add *create ${varName} or *temp ${varName} before using *input.`);
      setIp(resumeIp);
      runInterpreter().catch(err => cb.showEngineError(err.message));
      return;
    }
    store[varName] = value;
    setIp(resumeIp);
    runInterpreter().catch(err => cb.showEngineError(err.message));
  });
});

// *choice
// parseChoice receives cb.showEngineError via the ctx object so malformed
// *selectable_if lines surface in-game, not just in the console.
registerCommand('*choice', (t, line) => {
  const parsed = parseChoice(ip, line.indent, {
    currentLines,
    evalValue,
    showEngineError: cb.showEngineError,
  });
  if (parsed.choices.length === 0) {
    cb.showEngineError(`*choice at line ${ip} in "${currentScene}" produced no options. Check for missing or malformed # lines.`);
    setIp(currentLines.length);
    return;
  }
  setAwaitingChoice({ end: parsed.end, choices: parsed.choices });
  cb.renderChoices(parsed.choices);
});

// *ending ["Title"] ["Body text"]
// Parses up to two quoted string arguments for custom title/body.
registerCommand('*ending', (t) => {
  const args    = [...t.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const title   = args[0] ?? 'The End';
  const content = args[1] ?? 'Your path is complete.';
  cb.showEndingScreen(title, content);
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
        const reason = await executeBlock(bs, be, chainEnd);
        executed = true;
        if (reason === 'choice' || reason === 'goto') return;
      }
      cursor = be; continue;
    }
    if (isDirective(c.trimmed, '*else')) {
      const bs = cursor + 1, be = findBlockEnd(bs, c.indent);
      if (!executed) {
        const reason = await executeBlock(bs, be, chainEnd);
        if (reason === 'choice' || reason === 'goto') return;
      }
      cursor = be; continue;
    }
    cursor += 1;
  }
  setIp(chainEnd);
});

// *loop condition
// Guard trips at 10,000 iterations and displays an in-game error.
// If a *choice is found inside the loop body, awaitingChoice._savedIp is
// set to blockEnd via the setter so the post-choice resume skips past the loop.
registerCommand('*loop', async (t, line) => {
  const LOOP_GUARD = 10_000;
  const blockStart = ip + 1, blockEnd = findBlockEnd(blockStart, line.indent);
  let guard = 0;
  while (evaluateCondition(t) && guard < LOOP_GUARD) {
    const reason = await executeBlock(blockStart, blockEnd);
    if (reason === 'choice') {
      const ac = awaitingChoice;
      if (ac) setAwaitingChoice({ ...ac, _savedIp: blockEnd });
      return;
    }
    if (reason === 'goto') return;
    guard += 1;
  }
  if (guard >= LOOP_GUARD) {
    cb.showEngineError(`*loop guard tripped in scene "${currentScene}" after ${LOOP_GUARD} iterations — possible infinite loop. Check that the loop condition can become false.`);
  }
  setIp(blockEnd);
});

// *patch_state key value
registerCommand('*patch_state', (t) => {
  const m = t.match(/^\*patch_state\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) { advanceIp(); return; }
  patchPlayerState({ [normalizeKey(m[1])]: evalValue(m[2]) });
  advanceIp();
});

// *gosub label — call a subroutine, push return address
registerCommand('*gosub', (t) => {
  const label  = t.replace(/^\*gosub\s*/, '').trim();
  const labels = _labelsCache.get(currentScene) || {};
  if (labels[label] === undefined) {
    cb.showEngineError(`*gosub: Unknown label "${label}" in scene "${currentScene}".`);
    setIp(currentLines.length);
    return;
  }
  _gosubStack.push(ip + 1);
  setIp(labels[label]);
});

// *return — return from a *gosub subroutine
registerCommand('*return', () => {
  if (_gosubStack.length === 0) {
    cb.showEngineError(`*return without matching *gosub in scene "${currentScene}".`);
    setIp(currentLines.length);
    return;
  }
  setIp(_gosubStack.pop());
});

// *finish — advance to the next scene in scene_list
registerCommand('*finish', async () => {
  const list = startup.sceneList;
  const currentIdx = list.indexOf(currentScene.replace(/\.txt$/i, ''));
  const nextIdx = currentIdx + 1;
  if (nextIdx >= list.length) {
    cb.showEngineError(`*finish: no next scene after "${currentScene}" in scene_list.`);
    setIp(currentLines.length);
    return;
  }
  await gotoScene(list[nextIdx]);
});
