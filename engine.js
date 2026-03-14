// Extended ChoiceScript-lite engine for System Awakening
//
// As of this refactor, the engine is split into ES modules.
// This file is the coordinator: it owns the DOM, the interpreter loop,
// the narrative renderer, the stats panel, the overlays, and the wiring.
//
// Modules imported here (Phases 1 + 2):
//   engine/core/state.js      — all mutable state + variable management
//   engine/core/expression.js — safe expression evaluator (replaces Function())
//   engine/systems/inventory.js — inventory add/remove/check
//   engine/systems/leveling.js  — XP, level-up, system reward parsing
//   engine/systems/saves.js     — localStorage save/load/slot management
//
// Phases 3 + 4 will extract: parser, interpreter, narrative, panels, overlays.

import {
  playerState, tempState, statRegistry, startup,
  currentScene, currentLines, ip, _gotoJumped,
  awaitingChoice, pendingStatPoints, pendingLevelUpDisplay,
  _pendingLevelUpCount, delayIndex,
  setPlayerState, patchPlayerState, setTempState, setStatRegistry, setStartup,
  setCurrentScene, setCurrentLines, setIp, advanceIp, setGotoJumped,
  setAwaitingChoice,
  setPendingStatPoints, addPendingStatPoints,
  setPendingLevelUpDisplay, setPendingLevelUpCount, addPendingLevelUpCount,
  setDelayIndex, advanceDelayIndex,
  clearTempState, normalizeKey, setVar, declareTemp, parseStartup,
} from './engine/core/state.js';

import { evalValue }           from './engine/core/expression.js';

import {
  itemBaseName, addInventoryItem, removeInventoryItem,
} from './engine/systems/inventory.js';

import {
  getAllocatableStatKeys, checkAndApplyLevelUp, applySystemRewards,
} from './engine/systems/leveling.js';

import {
  SAVE_VERSION, SAVE_KEY_AUTO, SAVE_KEY_SLOTS, saveKeyForSlot,
  _staleSaveFound, clearStaleSaveFound,
  buildSavePayload, saveGameToSlot, loadSaveFromSlot,
  deleteSaveSlot, restoreFromSave,
} from './engine/systems/saves.js';

// ---------------------------------------------------------------------------
// Pronoun resolution
// ---------------------------------------------------------------------------
const PRONOUN_SETS = {
  'he/him':    { they: 'he',   them: 'him',  their: 'his',   themself: 'himself'  },
  'she/her':   { they: 'she',  them: 'her',  their: 'her',   themself: 'herself'  },
  'they/them': { they: 'they', them: 'them', their: 'their', themself: 'themself' },
};

function resolvePronoun(tokenLower, capitalise) {
  const set  = PRONOUN_SETS[playerState.pronouns] ?? PRONOUN_SETS['they/them'];
  const word = set[tokenLower] ?? tokenLower;
  return capitalise ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

// ---------------------------------------------------------------------------
// DOM cache
// ---------------------------------------------------------------------------
const dom = {
  narrativeContent:   document.getElementById('narrative-content'),
  choiceArea:         document.getElementById('choice-area'),
  chapterTitle:       document.getElementById('chapter-title'),
  narrativePanel:     document.getElementById('narrative-panel'),
  statusPanel:        document.getElementById('status-panel'),
  statusToggle:       document.getElementById('status-toggle'),
  restartBtn:         document.getElementById('restart-btn'),
  saveBtn:            document.getElementById('save-btn'),
  // Splash
  splashOverlay:      document.getElementById('splash-overlay'),
  splashNewBtn:       document.getElementById('splash-new-btn'),
  splashLoadBtn:      document.getElementById('splash-load-btn'),
  splashSlots:        document.getElementById('splash-slots'),
  splashSlotsBack:    document.getElementById('splash-slots-back'),
  // In-game save menu
  saveOverlay:        document.getElementById('save-overlay'),
  saveMenuClose:      document.getElementById('save-menu-close'),
  // Character creation
  charOverlay:        document.getElementById('char-creation-overlay'),
  inputFirstName:     document.getElementById('input-first-name'),
  inputLastName:      document.getElementById('input-last-name'),
  counterFirst:       document.getElementById('counter-first'),
  counterLast:        document.getElementById('counter-last'),
  errorFirstName:     document.getElementById('error-first-name'),
  errorLastName:      document.getElementById('error-last-name'),
  charBeginBtn:       document.getElementById('char-begin-btn'),
  // Ending
  endingOverlay:      document.getElementById('ending-overlay'),
  endingTitle:        document.getElementById('ending-title'),
  endingContent:      document.getElementById('ending-content'),
  endingStats:        document.getElementById('ending-stats'),
  endingActionBtn:    document.getElementById('ending-action-btn'),
  // Toast
  toast:              document.getElementById('toast'),
};

Object.entries(dom).forEach(([key, el]) => {
  if (!el) console.warn(`[engine] DOM element missing for key "${key}" — check index.html IDs`);
});

// ---------------------------------------------------------------------------
// Engine-local state (not exported — belongs to interpreter / UI layer)
// ---------------------------------------------------------------------------
let _gameInProgress = false;

const sceneCache  = new Map();
const labelsCache = new Map();
const styleState  = { colors: {}, icons: {} };

// ---------------------------------------------------------------------------
// scheduleStatsRender — deferred stats panel refresh.
// Passed as the onChanged callback to checkAndApplyLevelUp / applySystemRewards.
// ---------------------------------------------------------------------------
let _statsRenderPending = false;
function scheduleStatsRender() {
  if (_statsRenderPending) return;
  _statsRenderPending = true;
  Promise.resolve().then(() => { _statsRenderPending = false; runStatsScene(); });
}

// ---------------------------------------------------------------------------
// Wrappers — inject dependencies that modules need but can't import directly
// (avoids circular deps during this transitional phase).
// ---------------------------------------------------------------------------
function _evalValue(expr)        { return evalValue(expr); }
function _setVar(command)        { setVar(command, _evalValue); }
function _declareTemp(command)   { declareTemp(command, _evalValue); }
function _checkAndApplyLevelUp() { checkAndApplyLevelUp(scheduleStatsRender); }
function _applySystemRewards(t)  { applySystemRewards(t, scheduleStatsRender); }

async function _parseStartup() {
  await parseStartup(fetchTextFile, _evalValue);
}

// ---------------------------------------------------------------------------
// File loading
// ---------------------------------------------------------------------------
async function fetchTextFile(name) {
  const key = name.endsWith('.txt') ? name : `${name}.txt`;
  if (sceneCache.has(key)) return sceneCache.get(key);
  const res = await fetch(key);
  if (!res.ok) throw new Error(`Failed to load ${key}`);
  const text = await res.text();
  sceneCache.set(key, text);
  return text;
}

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------
function parseLines(text) {
  return text.split(/\r?\n/).map(raw => {
    const indentMatch = raw.match(/^\s*/)?.[0] || '';
    return { raw, trimmed: raw.trim(), indent: indentMatch.length };
  });
}

// ---------------------------------------------------------------------------
// Text formatting
// Handles: ${varName} interpolation, {pronoun} tokens, **bold**, *italic*
// ---------------------------------------------------------------------------
function formatText(text) {
  // 1. Variable interpolation
  let result = text.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k = normalizeKey(v);
    return tempState[k] !== undefined ? tempState[k] : (playerState[k] ?? '');
  });

  // 2. Pronoun tokens
  result = result.replace(
    /\{(They|Them|Their|Themself|they|them|their|themself)\}/g,
    (_, token) => {
      const lower     = token.toLowerCase();
      const isCapital = token.charCodeAt(0) >= 65 && token.charCodeAt(0) <= 90;
      return resolvePronoun(lower, isCapital);
    }
  );

  // 3. Markdown
  result = result
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return result;
}

// ---------------------------------------------------------------------------
// Label indexer
// ---------------------------------------------------------------------------
function indexLabels(sceneName, lines) {
  const map = {};
  lines.forEach((line, idx) => {
    const m = line.trimmed.match(/^\*label\s+([\w_\-]+)/);
    if (m) map[m[1]] = idx;
  });
  labelsCache.set(sceneName, map);
}

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------
function showEngineError(message) {
  clearNarrative();
  const div = document.createElement('div');
  div.className = 'system-block';
  div.style.borderLeftColor = 'var(--red)';
  div.style.color = 'var(--red)';
  div.innerHTML = `<span class="system-block-label">[ ENGINE ERROR ]</span><span class="system-block-text">${message}\n\nUse the Restart button to reload.</span>`;
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
  dom.chapterTitle.textContent = 'ERROR';
}

// ---------------------------------------------------------------------------
// Scene navigation
// ---------------------------------------------------------------------------
async function gotoScene(name, label = null) {
  let text;
  try {
    text = await fetchTextFile(name);
  } catch (err) {
    showEngineError(`Could not load scene "${name}".\n${err.message}`);
    return;
  }
  clearTempState();
  setCurrentScene(name);
  setCurrentLines(parseLines(text));
  indexLabels(name, currentLines);
  setIp(0);
  clearNarrative();
  applyTransition();
  dom.chapterTitle.textContent = name.toUpperCase();
  if (label) {
    const labels = labelsCache.get(name) || {};
    setIp(labels[label] ?? 0);
  }
  saveGameToSlot('auto', label || null);
  await runInterpreter();
}

// ---------------------------------------------------------------------------
// Block / flow helpers
// ---------------------------------------------------------------------------
function findBlockEnd(fromIndex, parentIndent) {
  let i = fromIndex;
  while (i < currentLines.length) {
    const l = currentLines[i];
    if (l.trimmed && l.indent <= parentIndent) break;
    i += 1;
  }
  return i;
}

function findIfChainEnd(fromIndex, indent) {
  let i = fromIndex + 1;
  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    if (line.indent < indent) break;
    if (line.indent === indent) {
      if (line.trimmed.startsWith('*elseif')) { i = findBlockEnd(i + 1, indent); continue; }
      if (line.trimmed.startsWith('*else'))   { i = findBlockEnd(i + 1, indent); break; }
      break;
    }
    i += 1;
  }
  return i;
}

function evaluateCondition(raw) {
  const condition = raw
    .replace(/^\*if\s*/,     '')
    .replace(/^\*elseif\s*/, '')
    .replace(/^\*loop\s*/,   '')
    .trim();
  return !!_evalValue(condition.replace(/^\(|\)$/g, ''));
}

function parseChoice(startIndex, indent) {
  const choices = [];
  let i = startIndex + 1;
  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    if (line.indent <= indent) break;

    let selectable   = true;
    let optionText   = '';
    const optionIndent = line.indent;

    if (line.trimmed.startsWith('*selectable_if')) {
      const m = line.trimmed.match(/^\*selectable_if\s*\((.+)\)\s*#(.*)$/);
      if (m) { selectable = !!_evalValue(m[1]); optionText = m[2].trim(); }
      else   { console.warn(`[engine] Malformed *selectable_if at line ${i} in "${currentScene}": ${line.trimmed}`); }
    } else if (line.trimmed.startsWith('#')) {
      optionText = line.trimmed.slice(1).trim();
    }

    if (optionText) {
      const start = i + 1;
      const end   = findBlockEnd(start, optionIndent);
      choices.push({ text: optionText, selectable, start, end });
      i = end;
      continue;
    }
    i += 1;
  }
  return { choices, end: i };
}

async function executeBlock(start, end, resumeAfter = end) {
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

function parseSystemBlock(startIndex) {
  const parts = [];
  let baseIndent = null;
  let i = startIndex + 1;
  while (i < currentLines.length) {
    const t = currentLines[i].trimmed;
    if (t === '*end_system') return { text: parts.join('\n'), endIp: i + 1, ok: true };
    if (baseIndent === null && t) baseIndent = currentLines[i].indent;
    const raw = currentLines[i].raw;
    parts.push(baseIndent !== null ? raw.slice(Math.min(baseIndent, raw.search(/\S|$/))) : raw.trimStart());
    i += 1;
  }
  return { text: '', endIp: currentLines.length, ok: false };
}

// ---------------------------------------------------------------------------
// Narrative rendering helpers
// ---------------------------------------------------------------------------
function addParagraph(text, cls = 'narrative-paragraph') {
  const p = document.createElement('p');
  p.className = cls;
  p.style.animationDelay = `${delayIndex * 80}ms`;
  p.innerHTML = formatText(text);
  advanceDelayIndex();
  dom.narrativeContent.insertBefore(p, dom.choiceArea);
}

function addSystem(text) {
  _applySystemRewards(text);
  const div       = document.createElement('div');
  const isXP      = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isXP ? ' xp-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;
  div.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();
  const formatted = formatText(text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
  if (pendingLevelUpDisplay) showInlineLevelUp();
}

// ---------------------------------------------------------------------------
// Narrative clear
// ---------------------------------------------------------------------------
function clearNarrative() {
  for (const el of [...dom.narrativeContent.children]) {
    if (el !== dom.choiceArea) el.remove();
  }
  dom.choiceArea.innerHTML = '';
  setDelayIndex(0);
}

function applyTransition() {
  dom.narrativePanel.classList.add('transitioning');
  setTimeout(() => dom.narrativePanel.classList.remove('transitioning'), 220);
}

// ---------------------------------------------------------------------------
// Main interpreter
// NOTE: *goto_scene MUST be checked before *goto (prefix collision).
// ---------------------------------------------------------------------------
async function executeCurrentLine() {
  const line = currentLines[ip];
  if (!line) return;
  if (!line.trimmed || line.trimmed.startsWith('//')) { advanceIp(); return; }

  const t = line.trimmed;

  if (!t.startsWith('*')) { addParagraph(t); advanceIp(); return; }

  if (t.startsWith('*title'))   { dom.chapterTitle.textContent = t.replace('*title', '').trim(); advanceIp(); return; }
  if (t.startsWith('*label'))   { advanceIp(); return; }
  if (t.startsWith('*comment')) { advanceIp(); return; }

  if (t.startsWith('*goto_scene')) {
    await gotoScene(t.replace('*goto_scene', '').trim());
    return;
  }

  if (t.startsWith('*goto')) {
    const label  = t.replace('*goto', '').trim();
    const labels = labelsCache.get(currentScene) || {};
    if (labels[label] === undefined) {
      showEngineError(`Unknown label "${label}" in scene "${currentScene}".`);
      setIp(currentLines.length);
      return;
    }
    setIp(labels[label]);
    setGotoJumped(true);
    return;
  }

  if (t.startsWith('*system')) {
    if (t === '*system') {
      const parsed = parseSystemBlock(ip);
      if (!parsed.ok) {
        showEngineError(`Unclosed *system block in "${currentScene}". Add *end_system.`);
        setIp(currentLines.length);
        return;
      }
      addSystem(parsed.text);
      setIp(parsed.endIp);
      return;
    }
    addSystem(t.replace('*system', '').trim().replace(/^"|"$/g, ''));
    advanceIp(); return;
  }

  if (t.startsWith('*temp'))  { _declareTemp(t); advanceIp(); return; }
  if (t.startsWith('*set'))   { _setVar(t); _checkAndApplyLevelUp(); scheduleStatsRender(); advanceIp(); return; }

  if (t.startsWith('*flag')) {
    const key = normalizeKey(t.replace('*flag', '').trim());
    if (key) { playerState[key] = true; scheduleStatsRender(); }
    advanceIp(); return;
  }

  if (t.startsWith('*save_point')) {
    const saveLabel = t.replace('*save_point', '').trim() || null;
    saveGameToSlot('auto', saveLabel);
    addSystem('[ PROGRESS SAVED ]');
    advanceIp(); return;
  }

  if (t.startsWith('*uppercase')) {
    const key   = normalizeKey(t.replace('*uppercase', '').trim());
    const store = Object.prototype.hasOwnProperty.call(tempState, key) ? tempState : playerState;
    if (typeof store[key] === 'string') store[key] = store[key].toUpperCase();
    advanceIp(); return;
  }

  if (t.startsWith('*lowercase')) {
    const key   = normalizeKey(t.replace('*lowercase', '').trim());
    const store = Object.prototype.hasOwnProperty.call(tempState, key) ? tempState : playerState;
    if (typeof store[key] === 'string') store[key] = store[key].toLowerCase();
    advanceIp(); return;
  }

  if (t.startsWith('*add_item')) {
    const item = t.replace('*add_item', '').trim().replace(/^"|"$/g, '');
    if (!Array.isArray(playerState.inventory)) playerState.inventory = [];
    addInventoryItem(item);
    scheduleStatsRender();
    advanceIp(); return;
  }

  if (t.startsWith('*remove_item')) {
    removeInventoryItem(t.replace('*remove_item', '').trim().replace(/^"|"$/g, ''));
    scheduleStatsRender();
    advanceIp(); return;
  }

  if (t.startsWith('*check_item')) {
    const checkArgs  = t.replace('*check_item', '').trim();
    const checkMatch = checkArgs.match(/^"([^"]+)"\s+([a-zA-Z_][\w]*)$/) ||
                       checkArgs.match(/^(\S+)\s+([a-zA-Z_][\w]*)$/);
    if (!checkMatch) {
      showEngineError(`*check_item requires two arguments: *check_item "Item Name" dest_var\nGot: ${t}`);
      setIp(currentLines.length);
      return;
    }
    const itemName    = checkMatch[1];
    const destKey     = normalizeKey(checkMatch[2]);
    const checkResult = Array.isArray(playerState.inventory) &&
      playerState.inventory.some(i => itemBaseName(i) === itemBaseName(itemName));
    if (Object.prototype.hasOwnProperty.call(tempState, destKey)) tempState[destKey] = checkResult;
    else {
      if (!Object.prototype.hasOwnProperty.call(playerState, destKey))
        console.warn(`[engine] *check_item dest_var "${destKey}" is undeclared.`);
      playerState[destKey] = checkResult;
    }
    advanceIp(); return;
  }

  if (t.startsWith('*if')) {
    const chainEnd = findIfChainEnd(ip, line.indent);
    let cursor = ip, executed = false;
    while (cursor < chainEnd) {
      const c = currentLines[cursor];
      if (!c.trimmed) { cursor += 1; continue; }
      if (c.trimmed.startsWith('*if') || c.trimmed.startsWith('*elseif')) {
        const bs = cursor + 1, be = findBlockEnd(bs, c.indent);
        if (!executed && evaluateCondition(c.trimmed)) {
          await executeBlock(bs, be, chainEnd);
          executed = true;
          if (awaitingChoice) return;
        }
        cursor = be; continue;
      }
      if (c.trimmed.startsWith('*else')) {
        const bs = cursor + 1, be = findBlockEnd(bs, c.indent);
        if (!executed) { await executeBlock(bs, be, chainEnd); if (awaitingChoice) return; }
        cursor = be; continue;
      }
      cursor += 1;
    }
    setIp(chainEnd); return;
  }

  if (t.startsWith('*loop')) {
    const blockStart = ip + 1, blockEnd = findBlockEnd(blockStart, line.indent);
    let guard = 0;
    while (evaluateCondition(t) && guard < 100) {
      await executeBlock(blockStart, blockEnd);
      if (awaitingChoice) return;
      guard += 1;
    }
    if (guard >= 100) console.warn(`[engine] *loop guard tripped in "${currentScene}"`);
    setIp(blockEnd); return;
  }

  if (t.startsWith('*choice')) {
    const parsed = parseChoice(ip, line.indent);
    setAwaitingChoice({ end: parsed.end, choices: parsed.choices });
    renderChoices(parsed.choices);
    return;
  }

  if (t.startsWith('*ending')) { showEndingScreen('The End', 'Your path is complete.'); return; }

  advanceIp();
}

// ---------------------------------------------------------------------------
// Choice rendering
// ---------------------------------------------------------------------------
function renderChoices(choices) {
  if (pendingLevelUpDisplay) showInlineLevelUp();

  const levelUpActive = pendingStatPoints > 0;
  dom.choiceArea.innerHTML = '';

  choices.forEach((choice, idx) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.style.animationDelay = `${(delayIndex + idx) * 80}ms`;
    btn.innerHTML = `<span>${formatText(choice.text)}</span>`;

    if (!choice.selectable) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.dataset.unselectable = '1';
    } else if (levelUpActive) {
      btn.disabled = true;
    }

    btn.addEventListener('click', async () => {
      dom.choiceArea.querySelectorAll('button').forEach(b => b.disabled = true);
      const ctx = awaitingChoice;
      setAwaitingChoice(null);
      const resumeAt = ctx._savedIp !== undefined ? ctx._savedIp : ctx.end;
      clearNarrative();
      applyTransition();
      await executeBlock(choice.start, choice.end);
      if (!awaitingChoice) { setIp(resumeAt); await runInterpreter(); }
    });

    dom.choiceArea.appendChild(btn);
  });

  if (levelUpActive) {
    const ov = document.createElement('div');
    ov.className = 'levelup-choice-overlay';
    ov.innerHTML = `<span>All stat points must be allocated</span>`;
    dom.choiceArea.appendChild(ov);
  }
}

// ---------------------------------------------------------------------------
// Interpreter loop
// ---------------------------------------------------------------------------
async function runInterpreter() {
  while (ip < currentLines.length) {
    await executeCurrentLine();
    if (awaitingChoice) break;
  }
  if (pendingLevelUpDisplay) showInlineLevelUp();
  runStatsScene();
}

// ---------------------------------------------------------------------------
// Stats panel renderer
// ---------------------------------------------------------------------------
async function runStatsScene() {
  const text  = await fetchTextFile('stats');
  const lines = parseLines(text);
  let html = '';
  styleState.colors = {};
  styleState.icons  = {};

  const entries = [];
  lines.forEach(line => {
    const t = line.trimmed;
    if (!t || t.startsWith('//')) return;
    if (t.startsWith('*stat_group')) {
      entries.push({ type: 'group', name: t.replace('*stat_group', '').trim().replace(/^"|"$/g, '') });
    } else if (t.startsWith('*stat_color')) {
      const [, rawKey, color] = t.split(/\s+/);
      styleState.colors[normalizeKey(rawKey)] = color;
    } else if (t.startsWith('*stat_icon')) {
      const m = t.match(/^\*stat_icon\s+([\w_]+)\s+"(.+)"$/);
      if (m) styleState.icons[normalizeKey(m[1])] = m[2];
    } else if (t.startsWith('*inventory')) {
      entries.push({ type: 'inventory' });
    } else if (t === '*stat_registered') {
      statRegistry.forEach(({ key, label }) => entries.push({ type: 'stat', key, label }));
    } else if (t.startsWith('*stat')) {
      const m = t.match(/^\*stat\s+([\w_]+)\s+"(.+)"$/);
      if (m) entries.push({ type: 'stat', key: normalizeKey(m[1]), label: m[2] });
    }
  });

  let inGroup = false;
  entries.forEach(e => {
    if (e.type === 'group') {
      if (inGroup) html += `</div>`;
      html += `<div class="status-section"><div class="status-label status-section-header">${e.name}</div>`;
      inGroup = true;
    }
    if (e.type === 'stat') {
      const cc = styleState.colors[e.key] || '';
      const ic = styleState.icons[e.key]  ?? '';
      html += `<div class="status-row"><span class="status-label">${ic ? ic + ' ' : ''}${e.label}</span><span class="status-value ${cc}">${playerState[e.key] ?? '—'}</span></div>`;
    }
    if (e.type === 'inventory') {
      if (inGroup) { html += `</div>`; inGroup = false; }
      const items = Array.isArray(playerState.inventory) && playerState.inventory.length
        ? playerState.inventory.map(i => `<li>${i}</li>`).join('')
        : '<li class="tag-empty">Empty</li>';
      html += `<div class="status-section"><div class="status-label status-section-header">Inventory</div><ul class="tag-list">${items}</ul></div>`;
    }
  });
  if (inGroup) html += `</div>`;
  dom.statusPanel.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Inline level-up block
// ---------------------------------------------------------------------------
function showInlineLevelUp() {
  setPendingLevelUpDisplay(false);
  setPendingLevelUpCount(0);

  const keys     = getAllocatableStatKeys();
  const labelMap = Object.fromEntries(statRegistry.map(({ key, label }) => [key, label]));
  const alloc    = Object.fromEntries(keys.map(k => [k, 0]));

  const block = document.createElement('div');
  block.className = 'levelup-inline-block';
  block.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();
  dom.narrativeContent.insertBefore(block, dom.choiceArea);

  dom.choiceArea.querySelectorAll('button').forEach(b => {
    if (!b.dataset.unselectable) b.disabled = true;
  });
  if (dom.choiceArea.querySelector('button')) {
    const ov = document.createElement('div');
    ov.className = 'levelup-choice-overlay';
    ov.innerHTML = `<span>↑ Allocate your stat points before continuing</span>`;
    dom.choiceArea.appendChild(ov);
  }

  const render = () => {
    const spent    = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain   = pendingStatPoints - spent;
    const allSpent = remain === 0;

    block.innerHTML = `
      <span class="system-block-label">[ LEVEL UP ]</span>
      <div class="levelup-inline-header">
        Reached <strong>Level ${playerState.level}</strong>
        <span class="levelup-points-remaining">${remain} point${remain !== 1 ? 's' : ''} remaining</span>
      </div>
      <div class="stat-alloc-grid">
        ${keys.map(k => `
          <div class="stat-alloc-item ${alloc[k] ? 'selected' : ''}">
            <span class="stat-alloc-name">${labelMap[k] || k}</span>
            <div style="display:flex;justify-content:center;gap:8px;align-items:center;">
              <button class="alloc-btn" data-op="minus" data-k="${k}" ${alloc[k] <= 0 ? 'disabled' : ''}>−</button>
              <span class="stat-alloc-val ${alloc[k] ? 'buffed' : ''}">${Number(playerState[k] || 0) + alloc[k]}</span>
              <button class="alloc-btn" data-op="plus"  data-k="${k}" ${remain <= 0 ? 'disabled' : ''}>+</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="levelup-inline-footer">
        <button class="levelup-confirm-btn ${allSpent ? '' : 'levelup-confirm-btn--locked'}"
          data-confirm ${allSpent ? '' : 'aria-disabled="true"'}>
          ${allSpent ? 'Confirm' : `Spend all points to confirm (${remain} remaining)`}
        </button>
      </div>`;

    block.querySelectorAll('.alloc-btn').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.k;
        const s = Object.values(alloc).reduce((a, b) => a + b, 0);
        if (btn.dataset.op === 'plus'  && s < pendingStatPoints) alloc[k] += 1;
        if (btn.dataset.op === 'minus' && alloc[k] > 0)          alloc[k] -= 1;
        render();
      };
    });

    block.querySelector('[data-confirm]').onclick = () => {
      if (Object.values(alloc).reduce((a, b) => a + b, 0) < pendingStatPoints) return;
      Object.entries(alloc).forEach(([k, v]) => { playerState[k] = Number(playerState[k] || 0) + v; });
      setPendingStatPoints(0);
      block.innerHTML = `<span class="system-block-label">[ LEVEL UP ]</span><span class="system-block-text levelup-confirmed-text">Level ${playerState.level} reached — stats allocated.</span>`;
      block.classList.add('levelup-inline-block--confirmed');
      const ov = dom.choiceArea.querySelector('.levelup-choice-overlay');
      if (ov) ov.remove();
      dom.choiceArea.querySelectorAll('button').forEach(b => { if (!b.dataset.unselectable) b.disabled = false; });
      scheduleStatsRender();
    };
  };
  render();
}

// ---------------------------------------------------------------------------
// Ending screen
// ---------------------------------------------------------------------------
function showEndingScreen(title, subtitle) {
  dom.endingTitle.textContent     = title;
  dom.endingContent.textContent   = subtitle;
  dom.endingStats.innerHTML       = `Level: ${playerState.level || 0}<br>XP: ${playerState.xp || 0}<br>Class: ${playerState.class_name || 'Unclassed'}`;
  dom.endingActionBtn.textContent = 'Play Again';
  dom.endingActionBtn.onclick     = resetGame;
  dom.endingOverlay.classList.remove('hidden');
  dom.endingOverlay.style.opacity = '1';
  trapFocus(dom.endingOverlay, null);
}

function resetGame() { location.reload(); }

// ---------------------------------------------------------------------------
// Test accessor
// ---------------------------------------------------------------------------
function getEngineState() {
  return { playerState, tempState, statRegistry, startup, currentScene, pendingStatPoints };
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let _toastTimer = null;
function showToast(message, durationMs = 2200) {
  dom.toast.textContent = message;
  dom.toast.classList.remove('hidden', 'toast-hide');
  dom.toast.classList.add('toast-show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    dom.toast.classList.replace('toast-show', 'toast-hide');
    setTimeout(() => dom.toast.classList.add('hidden'), 300);
  }, durationMs);
}

// ---------------------------------------------------------------------------
// Slot card rendering (moves to ui/overlays.js in Phase 4)
// ---------------------------------------------------------------------------
function populateSlotCard({ nameEl, metaEl, loadBtn, deleteBtn, cardEl, save }) {
  if (save) {
    const d = new Date(save.timestamp);
    metaEl.textContent  = `${save.scene.toUpperCase()} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    nameEl.textContent  = save.characterName || 'Unknown';
    loadBtn.disabled    = false;
    cardEl.classList.remove('slot-card--empty');
    if (deleteBtn) deleteBtn.classList.remove('hidden');
  } else {
    nameEl.textContent  = '— Empty —';
    metaEl.textContent  = '';
    loadBtn.disabled    = true;
    cardEl.classList.add('slot-card--empty');
    if (deleteBtn) deleteBtn.classList.add('hidden');
  }
}

function refreshAllSlotCards() {
  ['auto', 1, 2, 3].forEach(slot => {
    const save    = loadSaveFromSlot(slot);
    const s       = String(slot);
    const sCard   = document.getElementById(`slot-card-${s}`);
    if (sCard) populateSlotCard({
      nameEl:    document.getElementById(`slot-name-${s}`),
      metaEl:    document.getElementById(`slot-meta-${s}`),
      loadBtn:   document.getElementById(`slot-load-${s}`),
      deleteBtn: document.getElementById(`slot-delete-${s}`),
      cardEl:    sCard,
      save,
    });
    if (slot !== 'auto') {
      const iCard = document.getElementById(`save-card-${s}`);
      if (iCard) populateSlotCard({
        nameEl:    document.getElementById(`save-slot-name-${s}`),
        metaEl:    document.getElementById(`save-slot-meta-${s}`),
        loadBtn:   document.getElementById(`save-to-${s}`),
        deleteBtn: document.getElementById(`save-delete-${s}`),
        cardEl:    iCard,
        save,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------
function showSplash() {
  ['auto', 1, 2, 3].forEach(loadSaveFromSlot);
  refreshAllSlotCards();

  const notice = document.getElementById('splash-stale-notice');
  if (notice) {
    if (_staleSaveFound) {
      notice.classList.remove('hidden');
      clearStaleSaveFound();
    } else {
      notice.classList.add('hidden');
    }
  }

  dom.splashOverlay.classList.remove('hidden');
  dom.splashOverlay.style.opacity = '1';
  dom.splashSlots.classList.add('hidden');
  dom.splashOverlay.querySelector('.splash-btn-col')?.classList.remove('hidden');
}

function hideSplash() {
  dom.splashOverlay.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// In-game save menu
// ---------------------------------------------------------------------------
let _saveTrapRelease = null;
function showSaveMenu() {
  refreshAllSlotCards();
  dom.saveOverlay.classList.remove('hidden');
  dom.saveOverlay.style.opacity = '1';
  _saveTrapRelease = trapFocus(dom.saveOverlay, dom.saveBtn);
}

function hideSaveMenu() {
  dom.saveOverlay.classList.add('hidden');
  if (_saveTrapRelease) { _saveTrapRelease(); _saveTrapRelease = null; }
}

// ---------------------------------------------------------------------------
// Character creation
// ---------------------------------------------------------------------------
const NAME_MAX   = 14;
const NAME_REGEX = /^[\p{L}\p{M}'\- ]*$/u;

function validateName(value, label) {
  const t = value.trim();
  if (!t)                    return `${label} cannot be empty.`;
  if (t.length > NAME_MAX)   return `${label} must be ${NAME_MAX} characters or fewer.`;
  if (!NAME_REGEX.test(t))   return `${label} may only contain letters, hyphens, and apostrophes.`;
  if (/\s{2,}/.test(t))      return `${label} cannot contain consecutive spaces.`;
  if (/\-{2,}/.test(t))      return `${label} cannot contain consecutive hyphens.`;
  return null;
}

function wireCharCreation() {
  function handleInput(inputEl, counterEl, errorEl, fieldLabel) {
    const cleaned = inputEl.value.replace(/[^\p{L}\p{M}'\- ]/gu, '');
    if (cleaned !== inputEl.value) {
      const pos = inputEl.selectionStart - (inputEl.value.length - cleaned.length);
      inputEl.value = cleaned;
      try { inputEl.setSelectionRange(pos, pos); } catch (_) {}
    }
    counterEl.textContent = NAME_MAX - inputEl.value.length;

    const err = validateName(inputEl.value, fieldLabel);
    inputEl.classList.toggle('char-input--error', !!err);
    errorEl.textContent = err || '';
    errorEl.classList.toggle('hidden', !err);
    updateBeginBtn();
  }

  dom.inputFirstName.addEventListener('input', () =>
    handleInput(dom.inputFirstName, dom.counterFirst, dom.errorFirstName, 'First name'));
  dom.inputLastName.addEventListener('input',  () =>
    handleInput(dom.inputLastName,  dom.counterLast,  dom.errorLastName,  'Last name'));
  dom.inputLastName.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !dom.charBeginBtn.disabled) dom.charBeginBtn.click();
  });

  const pronounCards = [...dom.charOverlay.querySelectorAll('.pronoun-card')];

  function selectCard(card) {
    pronounCards.forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('aria-checked', 'false');
      c.setAttribute('tabindex', '-1');
    });
    card.classList.add('selected');
    card.setAttribute('aria-checked', 'true');
    card.setAttribute('tabindex', '0');
    card.focus();
    updateBeginBtn();
  }

  pronounCards.forEach(card => {
    card.addEventListener('click', () => selectCard(card));
    card.addEventListener('keydown', e => {
      const idx = pronounCards.indexOf(card);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); selectCard(pronounCards[(idx + 1) % pronounCards.length]);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); selectCard(pronounCards[(idx - 1 + pronounCards.length) % pronounCards.length]);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault(); selectCard(card);
      }
    });
  });

  function updateBeginBtn() {
    const ok = !validateName(dom.inputFirstName.value, 'First name') &&
               !validateName(dom.inputLastName.value,  'Last name')  &&
               !!dom.charOverlay.querySelector('.pronoun-card.selected');
    dom.charBeginBtn.disabled = !ok;
  }

  dom.charBeginBtn.addEventListener('click', () => {
    if (validateName(dom.inputFirstName.value, 'First name') ||
        validateName(dom.inputLastName.value,  'Last name'))  return;
    const selected = dom.charOverlay.querySelector('.pronoun-card.selected');
    if (!selected) return;
    dom.charOverlay.classList.add('hidden');
    if (typeof dom.charOverlay._trapRelease === 'function') { dom.charOverlay._trapRelease(); dom.charOverlay._trapRelease = null; }
    if (typeof dom.charOverlay._resolve === 'function') {
      dom.charOverlay._resolve({
        firstName: dom.inputFirstName.value.trim(),
        lastName:  dom.inputLastName.value.trim(),
        pronouns:  selected.dataset.pronouns,
      });
    }
  });
}

function showCharacterCreation() {
  dom.inputFirstName.value = '';
  dom.inputLastName.value  = '';
  dom.counterFirst.textContent = String(NAME_MAX);
  dom.counterLast.textContent  = String(NAME_MAX);
  dom.errorFirstName.classList.add('hidden');
  dom.errorLastName.classList.add('hidden');
  dom.inputFirstName.classList.remove('char-input--error');
  dom.inputLastName.classList.remove('char-input--error');
  dom.charBeginBtn.disabled = true;

  dom.charOverlay.querySelectorAll('.pronoun-card').forEach(c => {
    const def = c.dataset.pronouns === 'they/them';
    c.classList.toggle('selected', def);
    c.setAttribute('aria-checked', def ? 'true' : 'false');
    c.setAttribute('tabindex', def ? '0' : '-1');
  });

  dom.charOverlay.classList.remove('hidden');
  dom.charOverlay.style.opacity = '1';
  requestAnimationFrame(() => {
    const _charTrapRelease = trapFocus(dom.charOverlay, null);
    dom.charOverlay._trapRelease = _charTrapRelease;
  });
  setTimeout(() => { try { dom.inputFirstName.focus(); } catch (_) {} }, 80);

  return new Promise(resolve => { dom.charOverlay._resolve = resolve; });
}

// ---------------------------------------------------------------------------
// Focus trapping
// ---------------------------------------------------------------------------
function trapFocus(overlayEl, triggerEl = null) {
  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function getFocusable() {
    try {
      return [...overlayEl.querySelectorAll(FOCUSABLE)].filter(
        el => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none'
      );
    } catch (_) { return []; }
  }

  function handleKeydown(e) {
    if (e.key !== 'Tab') return;
    const focusable = getFocusable();
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }

  overlayEl.addEventListener('keydown', handleKeydown);
  requestAnimationFrame(() => {
    try {
      const focusable = getFocusable();
      if (focusable.length) focusable[0].focus();
    } catch (_) {}
  });

  return function release() {
    try { overlayEl.removeEventListener('keydown', handleKeydown); } catch (_) {}
    try { if (triggerEl && typeof triggerEl.focus === 'function') triggerEl.focus(); } catch (_) {}
  };
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function wireUI() {
  dom.statusToggle.addEventListener('click', () => {
    const visible = dom.statusPanel.classList.toggle('status-visible');
    dom.statusPanel.classList.toggle('status-hidden', !visible);
    runStatsScene();
  });

  document.addEventListener('click', e => {
    if (window.innerWidth <= 768 &&
        !dom.statusPanel.contains(e.target) &&
        e.target !== dom.statusToggle) {
      dom.statusPanel.classList.remove('status-visible');
      dom.statusPanel.classList.add('status-hidden');
    }
  });

  dom.restartBtn.addEventListener('click', () => {
    if (confirm('Return to the title screen? Manual saves will be kept.')) {
      deleteSaveSlot('auto');
      resetGame();
    }
  });

  dom.saveBtn.addEventListener('click', showSaveMenu);

  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-to-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const existing = loadSaveFromSlot(slot);
      if (existing && !confirm(`Overwrite Slot ${slot}?`)) return;
      saveGameToSlot(slot);
      hideSaveMenu();
      showToast(`Saved to Slot ${slot}`);
      refreshAllSlotCards();
    });
  });

  dom.saveMenuClose.addEventListener('click', hideSaveMenu);
  dom.saveOverlay.addEventListener('click', e => { if (e.target === dom.saveOverlay) hideSaveMenu(); });
  dom.saveOverlay.addEventListener('keydown', e => { if (e.key === 'Escape') hideSaveMenu(); });

  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (confirm(`Delete Slot ${slot}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });

  // Splash — New Game
  dom.splashNewBtn.addEventListener('click', async () => {
    hideSplash();
    const charData = await showCharacterCreation();
    patchPlayerState({ first_name: charData.firstName, last_name: charData.lastName, pronouns: charData.pronouns });
    _gameInProgress = true;
    dom.saveBtn.classList.remove('hidden');
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || 'prologue');
  });

  // Splash — Load Game (show slots)
  dom.splashLoadBtn.addEventListener('click', () => {
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.add('hidden');
    dom.splashSlots.classList.remove('hidden');
    refreshAllSlotCards();
  });

  dom.splashSlotsBack.addEventListener('click', () => {
    dom.splashSlots.classList.add('hidden');
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.remove('hidden');
  });

  // Splash — Load slot buttons
  ['auto', 1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`slot-load-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSplash();
      _gameInProgress = true;
      dom.saveBtn.classList.remove('hidden');
      await restoreFromSave(save, {
        gotoScene,
        runStatsScene,
        fetchTextFileFn: fetchTextFile,
        evalValueFn:     _evalValue,
      });
    });
  });

  // Splash — Delete slot buttons
  ['auto', 1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`slot-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const label = slot === 'auto' ? 'the auto-save' : `Slot ${slot}`;
      if (confirm(`Delete ${label}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });

  wireCharCreation();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  wireUI();
  try {
    await _parseStartup();
    showSplash();
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', boot);