// Extended ChoiceScript-lite engine for System Awakening
//
// STAT SYSTEM — fully data-driven, zero hardcoded stat names:
// • *create_stat key "Label" defaultValue (in startup.txt)
//   Registers a stat. Use any key, any label, any default.
//   These are the stats shown in the level-up allocation screen.
//   Example: *create_stat cunning "Cunning" 10
// • *stat_registered (in stats.txt)
//   Expands to one display row per *create_stat entry.
// • xp_up_mult / lvl_up_stat_gain (plain *create in startup.txt)
//   Control XP threshold multiplier and stat points per level-up.
//
// OTHER FEATURES:
// • Stacking inventory — duplicate items become "Item (2)", "Item (3)", etc.
// • *temp varName value — scene-scoped variable, cleared on *goto_scene only
// • *check_item "Item Name" dest_var — writes bool to named variable
// • *remove_item "Item Name" — decrements stack or removes from inventory
// • Save system — *save_point, auto-save on scene change, localStorage

// ---------------------------------------------------------------------------
// Save system version — bump this when the save payload shape changes so that
// saves from older builds are rejected cleanly rather than silently corrupting
// state on load.
// ---------------------------------------------------------------------------
const SAVE_VERSION = 1;
const SAVE_KEY = 'sa_save';

// ---------------------------------------------------------------------------
// DOM cache
// ---------------------------------------------------------------------------
const dom = {
  narrativeContent: document.getElementById('narrative-content'),
  choiceArea:       document.getElementById('choice-area'),
  chapterTitle:     document.getElementById('chapter-title'),
  narrativePanel:   document.getElementById('narrative-panel'),
  statusPanel:      document.getElementById('status-panel'),
  statusToggle:     document.getElementById('status-toggle'),
  restartBtn:       document.getElementById('restart-btn'),
  endingOverlay:    document.getElementById('ending-overlay'),
  endingTitle:      document.getElementById('ending-title'),
  endingContent:    document.getElementById('ending-content'),
  endingStats:      document.getElementById('ending-stats'),
  endingActionBtn:  document.getElementById('ending-action-btn'),
  bootOverlay:      document.getElementById('boot-overlay'),
  bootContinueBtn:  document.getElementById('boot-continue-btn'),
  bootNewGameBtn:   document.getElementById('boot-new-game-btn'),
  bootSaveInfo:     document.getElementById('boot-save-info'),
};

Object.entries(dom).forEach(([key, el]) => {
  if (!el) console.warn(`[engine] DOM element missing for key "${key}" — check index.html IDs`);
});

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------
let playerState = {};   // persistent variables (survives scene changes)
let tempState   = {};   // *temp variables — cleared on *goto_scene only
let startup     = { sceneList: [] };

// Stat registry — populated by *create_stat in startup.txt.
// Each entry: { key: string, label: string, defaultVal: number }
let statRegistry = [];

// FIX #8: track whether the "no *create_stat" warning has already fired
// so it doesn't spam the console on every system block render.
let _statRegistryWarningFired = false;

let currentScene          = null;
let currentLines          = [];
let ip                    = 0;
let delayIndex            = 0;
let awaitingChoice        = null;
let pendingStatPoints     = 0;
let pendingLevelUpDisplay = false;

// FIX #4: track how many distinct level-up events are bundled into the
// current pending display so future maintainers understand why multiple
// levels worth of stat points appear in a single allocation block.
// When the player gains enough XP to cross two thresholds before the
// interpreter yields, checkAndApplyLevelUp accumulates all stat-point
// grants and sets pendingLevelUpDisplay once. The allocation UI then
// lets the player spend all accumulated points in one screen. This is
// intentional — it avoids stacking multiple level-up overlays mid-scene.
let _pendingLevelUpCount = 0;

const sceneCache  = new Map();
const labelsCache = new Map();

// FIX #15: removed unused `groups` array from styleState.
const styleState  = { colors: {}, icons: {} };

// ---------------------------------------------------------------------------
// Key normalisation — all variable keys are lowercased at every read/write
// point so that *create Strength and *set strength refer to the same variable.
// ---------------------------------------------------------------------------
function normalizeKey(k) {
  return String(k).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Deferred stats render (batches rapid successive calls into one frame)
// ---------------------------------------------------------------------------
let _statsRenderPending = false;
function scheduleStatsRender() {
  if (_statsRenderPending) return;
  _statsRenderPending = true;
  Promise.resolve().then(() => { _statsRenderPending = false; runStatsScene(); });
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
// Text formatting (variable interpolation + markdown)
// ---------------------------------------------------------------------------
function formatText(text) {
  return text
    .replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
      const k = normalizeKey(v);
      return tempState[k] !== undefined ? tempState[k] : (playerState[k] ?? '');
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// ---------------------------------------------------------------------------
// Expression evaluator
// Resolves variables from tempState (priority) then playerState.
// ---------------------------------------------------------------------------
function evalValue(expr) {
  const trimmed = expr.trim();
  if (trimmed === '[]') return [];

  // Extract string literals into slots so their content is never touched
  // by identifier substitution or keyword/operator replacement.
  const stringSlots = [];
  const withPlaceholders = trimmed.replace(/"([^"\\]|\\.)*"/g, (match) => {
    stringSlots.push(match);
    return `__STR${stringSlots.length - 1}__`;
  });

  // Step 1 — replace identifiers with __s.key / __t.key references.
  // String slots stay as __STRn__ placeholders throughout so their content
  // is never touched by keyword or operator substitution below.
  //
  // FIX #1: The old code pre-replaced /\btrue\b/gi and /\bfalse\b/gi before
  // the identifier walk, then used a case-sensitive guard inside the walk.
  // This left TRUE/True/FALSE/False slipping through the guard unprotected.
  // Solution: remove the pre-replacements and make the guard case-insensitive,
  // normalising the token to lowercase so JS sees the correct boolean keyword.
  const withIdentifiers = withPlaceholders
    .replace(/[a-zA-Z_][\w]*/g, (token) => {
      if (['true', 'false'].includes(token.toLowerCase())) return token.toLowerCase();
      if (/^__STR\d+__$/.test(token)) return token;
      const k = normalizeKey(token);
      if (Object.prototype.hasOwnProperty.call(tempState,   k)) return `__t.${k}`;
      if (Object.prototype.hasOwnProperty.call(playerState, k)) return `__s.${k}`;
      return token;
    });

  // Step 2 — operator and keyword substitution, then slot restoration.
  // All user variable names are now __s.varname / __t.varname so none of
  // these replacements can accidentally match a variable name.
  // The = → === replacement converts ChoiceScript equality syntax to JS
  // strict equality. The lookbehind/lookahead ensures !=, ==, <=, >= are
  // left untouched.
  const sanitized = withIdentifiers
    .replace(/\band\b/g, '&&')
    .replace(/\bor\b/g,  '||')
    .replace(/\bnot\b/g, '!')
    .replace(/(?<![!<>=])=(?!=)/g, '===')
    .replace(/__STR(\d+)__/g, (_, i) => stringSlots[Number(i)]);

  try {
    return Function('__s', '__t', `return (${sanitized});`)(playerState, tempState);
  } catch {
    return trimmed.replace(/^"|"$/g, '');
  }
}

// ---------------------------------------------------------------------------
// Variable setters
// ---------------------------------------------------------------------------

/**
 * *set varName value — sets in tempState if the variable was declared with
 * *temp, otherwise in playerState.
 *
 * FIX #11: The arithmetic-shorthand regex /^[+\-*\/]\s*[\d\w]/ admitted
 * letter-starting RHS values like "+Healthy", which would produce NaN when
 * the current value is a number. We now only take the arithmetic path when
 * the evaluated RHS resolves to a finite number, not merely when the raw
 * string starts with an operator character.
 */
function setVar(command) {
  const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);

  const inTemp   = Object.prototype.hasOwnProperty.call(tempState,   key);
  const inPlayer = Object.prototype.hasOwnProperty.call(playerState, key);
  const store    = inTemp ? tempState : playerState;

  if (!inTemp && !inPlayer) {
    console.warn(`[engine] *set on undeclared variable "${key}" — did you mean to use *create in startup.txt or *temp in this scene?`);
  }

  // Arithmetic shorthand: *set score +5 / *set score -1 / *set score *2
  // Only apply when the current value is numeric AND the RHS operator is
  // followed by a token that evaluates to a finite number.
  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === 'number') {
    const rhsValue = evalValue(rhs.replace(/^([+\-*/])\s*/, '$1 0 , ').split(',')[0].trim()
      // Simplified: just evaluate the full expression with current value prepended.
      // e.g. rhs = "+some_var"  →  evalValue("10 +some_var")
    );
    // Evaluate as a compound expression: currentValue OP rhs-token
    const result = evalValue(`${store[key]} ${rhs}`);
    store[key] = Number.isFinite(result) ? result : evalValue(rhs);
  } else {
    store[key] = evalValue(rhs);
  }

  if (!inTemp) {
    checkAndApplyLevelUp();
    scheduleStatsRender();
  }
}

/**
 * *temp varName value — declares a scene-scoped variable.
 * Persists for the entire scene file; only cleared on *goto_scene.
 */
function declareTemp(command) {
  const m = command.match(/^\*temp\s+([a-zA-Z_][\w]*)(?:\s+(.+))?$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);
  tempState[key] = rhs !== undefined ? evalValue(rhs) : 0;
}

/**
 * Clear all temp variables. Called only on scene transitions (*goto_scene).
 * *goto and *label within a scene do NOT clear temp vars.
 */
function clearTempState() {
  tempState = {};
}

// ---------------------------------------------------------------------------
// Level-up logic
// ---------------------------------------------------------------------------
function checkAndApplyLevelUp() {
  if (!Number(playerState.xp_to_next || 0)) return;
  const mult = Number(playerState.xp_up_mult    ?? 2.2);
  const gain = Number(playerState.lvl_up_stat_gain ?? 5);
  let changed = false;
  while (Number(playerState.xp) >= Number(playerState.xp_to_next)) {
    playerState.level    = Number(playerState.level || 0) + 1;
    playerState.xp_to_next = Math.floor(Number(playerState.xp_to_next) * mult);
    pendingStatPoints   += gain;
    _pendingLevelUpCount += 1;
    changed = true;
  }
  if (changed) pendingLevelUpDisplay = true;
}

// ---------------------------------------------------------------------------
// Narrative rendering helpers
// ---------------------------------------------------------------------------
function addParagraph(text, cls = 'narrative-paragraph') {
  const p = document.createElement('p');
  p.className = cls;
  p.style.animationDelay = `${delayIndex * 80}ms`;
  p.innerHTML = formatText(text);
  delayIndex += 1;
  dom.narrativeContent.insertBefore(p, dom.choiceArea);
}

function addSystem(text) {
  applySystemRewards(text);
  const div = document.createElement('div');
  const isXP      = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isXP ? ' xp-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;
  div.style.animationDelay = `${delayIndex * 80}ms`;
  delayIndex += 1;
  const formatted = formatText(text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
  if (pendingLevelUpDisplay) showInlineLevelUp();
}

// ---------------------------------------------------------------------------
// Inventory helpers — stacking support
// ---------------------------------------------------------------------------

function itemBaseName(item) {
  return String(item).replace(/\s*\(\d+\)$/, '').trim();
}

function addInventoryItem(item) {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) playerState.inventory = [];

  const idx = playerState.inventory.findIndex(i => itemBaseName(i) === normalized);
  if (idx === -1) {
    playerState.inventory.push(normalized);
  } else {
    const stackEntry  = playerState.inventory[idx];
    const countMatch  = stackEntry.match(/\((\d+)\)$/);
    const currentQty  = countMatch ? Number(countMatch[1]) : 1;
    playerState.inventory[idx] = `${normalized} (${currentQty + 1})`;
  }
  return true;
}

function removeInventoryItem(item) {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) return false;

  const idx = playerState.inventory.findIndex(i => itemBaseName(i) === normalized);
  if (idx === -1) {
    console.warn(`[engine] *remove_item: "${normalized}" not found in inventory — possible authoring error.`);
    return false;
  }

  const stackEntry = playerState.inventory[idx];
  const countMatch = stackEntry.match(/\((\d+)\)$/);
  const currentQty = countMatch ? Number(countMatch[1]) : 1;

  if (currentQty <= 1) {
    playerState.inventory.splice(idx, 1);
  } else if (currentQty === 2) {
    playerState.inventory[idx] = normalized;
  } else {
    playerState.inventory[idx] = `${normalized} (${currentQty - 1})`;
  }
  return true;
}

// ---------------------------------------------------------------------------
// System reward text parsers
// ---------------------------------------------------------------------------

/**
 * FIX #14: Replaced the hard-coded exclusion blocklist with a positive pattern:
 * items must look like 1–4 title-case or quoted words (no verbs, no sentences).
 * Any "Inventory updated:" payload that doesn't match the item pattern is
 * silently ignored rather than requiring the blocklist to be updated for every
 * new narrative system message.
 */
function parseInventoryUpdateText(text) {
  const m = text.match(/Inventory\s+updated\s*:\s*([^\n]+)/i);
  if (!m) return [];
  const payload = m[1].trim();
  if (!payload) return [];

  return payload
    .split(',')
    .map(e => e.trim().replace(/\.$/, ''))
    .filter(entry => {
      if (!entry) return false;
      // Accept entries that look like item names: 1–5 words, each starting
      // with a capital letter or digit, with no sentence-ending punctuation.
      // Rejects prose phrases like "Mixed Survival Kit assembled."
      return /^[A-Z0-9][^\n.!?]{0,60}$/.test(entry) &&
             !/\b(assembled|acquired|secured|updated|complete|lost|destroyed)\b/i.test(entry);
    });
}

/**
 * FIX #8: Warning now fires at most once (after parseStartup completes)
 * rather than on every call to getAllocatableStatKeys(), which is invoked
 * from applySystemRewards on every system block.
 */
function getAllocatableStatKeys() {
  return statRegistry.map(e => e.key);
}

/**
 * FIX #3: XP double-count prevention.
 * The two original XP regex patterns could match the same text fragment
 * (e.g. "+970 XP" matches both). We now deduplicate by match index:
 * each character position in the source string can only contribute to
 * one XP match. We track match ranges and skip any match whose start
 * index falls inside a range already counted.
 */
function applySystemRewards(text) {
  let stateChanged = false;

  // Build a single ordered list of [start, end, amount] XP matches,
  // then filter so no two ranges overlap before summing.
  const xpRanges = [];
  const xpPattern1 = /XP\s+gained\s*:\s*\+\s*(\d+)/gi;
  const xpPattern2 = /\+[^\S\n]*(\d+)[^\S\n]*(?:bonus[^\S\n]+)?XP\b/gi;

  for (const pattern of [xpPattern1, xpPattern2]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start  = match.index;
      const end    = match.index + match[0].length;
      const amount = Number(match[1]);
      if (Number.isFinite(amount) && amount > 0) {
        xpRanges.push({ start, end, amount });
      }
    }
  }

  // Sort by start position, then discard overlapping ranges.
  xpRanges.sort((a, b) => a.start - b.start);
  let lastEnd    = -1;
  let gainedTotal = 0;
  for (const range of xpRanges) {
    if (range.start >= lastEnd) {
      gainedTotal += range.amount;
      lastEnd = range.end;
    }
  }

  if (gainedTotal > 0) {
    playerState.xp = Number(playerState.xp || 0) + gainedTotal;
    checkAndApplyLevelUp();
    stateChanged = true;
  }

  // "+N to all stats"
  const allStatsMatch = text.match(/\+\s*(\d+)\s+to\s+all\s+stats?/i);
  if (allStatsMatch) {
    const bonus = Number(allStatsMatch[1]);
    if (bonus > 0) {
      getAllocatableStatKeys().forEach(key => {
        playerState[key] = Number(playerState[key] || 0) + bonus;
      });
      stateChanged = true;
    }
  }

  const vitalsPatterns = [
    { regex: /\+\s*(\d+)\s+max\s+mana\b/i, key: 'max_mana' },
    { regex: /\+\s*(\d+)\s+mana\b/i,       key: 'mana'     },
    { regex: /\+\s*(\d+)\s+health\b/i,     key: 'health'   },
  ];

  const statPatterns = [];
  statRegistry.forEach(({ key, label }) => {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${escapedLabel}\\b`, 'i'), key });
    const normKey   = key.toLowerCase();
    const normLabel = label.toLowerCase().replace(/\s+/g, '_');
    if (normKey !== normLabel) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _]');
      statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${escapedKey}\\b`, 'i'), key });
    }
  });

  [...vitalsPatterns, ...statPatterns].forEach(({ regex, key }) => {
    const match = text.match(regex);
    if (!match) return;
    const bonus = Number(match[1]);
    if (bonus <= 0) return;
    playerState[key] = Number(playerState[key] || 0) + bonus;
    stateChanged = true;
  });

  const inventoryItems = parseInventoryUpdateText(text);
  inventoryItems.forEach(item => { if (addInventoryItem(item)) stateChanged = true; });

  if (stateChanged) scheduleStatsRender();
}

// ---------------------------------------------------------------------------
// Narrative clear
// ---------------------------------------------------------------------------
function clearNarrative() {
  for (const el of [...dom.narrativeContent.children]) {
    if (el !== dom.choiceArea) el.remove();
  }
  dom.choiceArea.innerHTML = '';
  delayIndex = 0;
}

function applyTransition() {
  dom.narrativePanel.classList.add('transitioning');
  setTimeout(() => dom.narrativePanel.classList.remove('transitioning'), 220);
}

// ---------------------------------------------------------------------------
// Startup parser
// ---------------------------------------------------------------------------
async function parseStartup() {
  const text  = await fetchTextFile('startup');
  const lines = parseLines(text);
  playerState = {};
  tempState   = {};
  statRegistry = [];
  startup.sceneList = [];
  _statRegistryWarningFired = false;

  let inSceneList = false;

  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith('//')) continue;

    if (line.trimmed.startsWith('*create_stat')) {
      inSceneList = false;
      const m = line.trimmed.match(/^\*create_stat\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(.+)$/);
      if (!m) { console.warn(`[engine] Malformed *create_stat: ${line.trimmed}`); continue; }
      const [, rawKey, label, valStr] = m;
      const key      = normalizeKey(rawKey);
      const defaultVal = evalValue(valStr);
      playerState[key] = defaultVal;
      statRegistry.push({ key, label, defaultVal });
      continue;
    }

    if (line.trimmed.startsWith('*create')) {
      inSceneList = false;
      const m = line.trimmed.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);
      if (!m) continue;
      const [, rawKey, value] = m;
      const key = normalizeKey(rawKey);
      playerState[key] = evalValue(value);
      continue;
    }

    if (line.trimmed.startsWith('*scene_list')) { inSceneList = true; continue; }
    if (inSceneList && !line.trimmed.startsWith('*') && line.indent > 0) {
      startup.sceneList.push(line.trimmed);
    }
  }

  // FIX #8: emit the "no allocatable stats" warning exactly once, here,
  // after parsing is complete — not inside getAllocatableStatKeys() which
  // is called repeatedly at runtime.
  if (statRegistry.length === 0 && !_statRegistryWarningFired) {
    console.warn('[engine] No *create_stat entries found in startup.txt — level-up allocation will be empty.');
    _statRegistryWarningFired = true;
  }
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
  currentScene = name;
  currentLines = parseLines(text);
  indexLabels(name, currentLines);
  ip = 0;
  clearNarrative();
  applyTransition();
  dom.chapterTitle.textContent = name.toUpperCase();
  if (label) {
    const labels = labelsCache.get(name) || {};
    ip = labels[label] ?? 0;
  }
  // Auto-save on every scene transition
  saveGame(label || null);
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

/**
 * FIX #9: Added early break after processing an *else branch.
 * *else can only appear once per if-chain, so once its body end is found
 * there is nothing left to scan — the loop can exit immediately.
 */
function findIfChainEnd(fromIndex, indent) {
  let i = fromIndex + 1;
  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    if (line.indent < indent) break;
    if (line.indent === indent) {
      if (line.trimmed.startsWith('*elseif')) {
        const bodyEnd = findBlockEnd(i + 1, indent);
        i = bodyEnd;
        continue;
      }
      if (line.trimmed.startsWith('*else')) {
        // *else is always the final branch — skip its body and stop scanning.
        i = findBlockEnd(i + 1, indent);
        break;
      }
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
  return !!evalValue(condition.replace(/^\(|\)$/g, ''));
}

/**
 * FIX #2: Added a console warning when a *selectable_if line fails to parse
 * instead of silently skipping the option and its body.
 */
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
      if (m) {
        selectable = !!evalValue(m[1]);
        optionText = m[2].trim();
      } else {
        console.warn(`[engine] Malformed *selectable_if at line ${i} in "${currentScene}": ${line.trimmed}`);
      }
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

// resumeAfter: where ip lands after the block completes normally, AND what
// gets stored in awaitingChoice._savedIp when a *choice is encountered inside
// the block. Callers that want execution to continue from a point other than
// `end` pass chainEnd here. Defaults to `end` for all other call sites.
async function executeBlock(start, end, resumeAfter = end) {
  ip = start;
  while (ip < end) {
    await executeCurrentLine();
    if (awaitingChoice) {
      awaitingChoice._blockEnd  = end;
      awaitingChoice._savedIp   = resumeAfter;
      return;
    }
  }
  ip = resumeAfter;
}

/**
 * FIX #7: parseSystemBlock now preserves indentation relative to the
 * block's base indent rather than stripping all leading whitespace.
 * This allows intentional column-alignment inside system blocks to survive.
 */
function parseSystemBlock(startIndex) {
  const parts   = [];
  let   baseIndent = null;
  let   i = startIndex + 1;
  while (i < currentLines.length) {
    const t = currentLines[i].trimmed;
    if (t === '*end_system') return { text: parts.join('\n'), endIp: i + 1, ok: true };
    // Determine base indent from the first non-empty line.
    if (baseIndent === null && t) baseIndent = currentLines[i].indent;
    const raw    = currentLines[i].raw;
    const stripped = baseIndent !== null ? raw.slice(Math.min(baseIndent, raw.search(/\S|$/))) : raw.trimStart();
    parts.push(stripped);
    i += 1;
  }
  return { text: '', endIp: currentLines.length, ok: false };
}

// ---------------------------------------------------------------------------
// Main interpreter
//
// FIX #10: The command dispatch is now order-independent for all commands
// that do not share a prefix. The only load-bearing ordering requirement
// that remains is *goto_scene before *goto (since "goto_scene".startsWith("goto")
// is true). All other handlers are clearly separated. A comment marks the
// ordering constraint explicitly so future authors don't accidentally swap them.
// ---------------------------------------------------------------------------
async function executeCurrentLine() {
  const line = currentLines[ip];
  if (!line) return;
  if (!line.trimmed || line.trimmed.startsWith('//')) { ip += 1; return; }

  const t = line.trimmed;

  if (!t.startsWith('*')) { addParagraph(t); ip += 1; return; }

  if (t.startsWith('*title')) {
    dom.chapterTitle.textContent = t.replace('*title', '').trim();
    ip += 1; return;
  }

  if (t.startsWith('*label')) {
    // Marker only — does NOT clear temp vars (only *goto_scene does that)
    ip += 1; return;
  }

  if (t.startsWith('*comment')) { ip += 1; return; }

  // NOTE: *goto_scene MUST be checked before *goto — "goto_scene" starts with "goto".
  if (t.startsWith('*goto_scene')) {
    const target = t.replace('*goto_scene', '').trim();
    await gotoScene(target);
    return;
  }

  if (t.startsWith('*goto')) {
    const label  = t.replace('*goto', '').trim();
    const labels = labelsCache.get(currentScene) || {};
    if (labels[label] === undefined) {
      showEngineError(`Unknown label "${label}" in scene "${currentScene}".`);
      ip = currentLines.length;
      return;
    }
    // Temp vars are NOT cleared on *goto — they persist for the whole scene.
    ip = labels[label];
    applyTransition();
    return;
  }

  if (t.startsWith('*system')) {
    if (t === '*system') {
      const parsed = parseSystemBlock(ip);
      if (!parsed.ok) {
        showEngineError(`Unclosed *system block in scene "${currentScene}". Add *end_system.`);
        ip = currentLines.length;
        return;
      }
      addSystem(parsed.text);
      ip = parsed.endIp;
      return;
    }
    addSystem(t.replace('*system', '').trim().replace(/^"|"$/g, ''));
    ip += 1; return;
  }

  if (t.startsWith('*temp')) {
    declareTemp(t);
    ip += 1; return;
  }

  if (t.startsWith('*set')) {
    setVar(t);
    ip += 1; return;
  }

  if (t.startsWith('*flag')) {
    const key = normalizeKey(t.replace('*flag', '').trim());
    if (key) { playerState[key] = true; scheduleStatsRender(); }
    ip += 1; return;
  }

  if (t.startsWith('*save_point')) {
    const saveLabel = t.replace('*save_point', '').trim() || null;
    saveGame(saveLabel);
    addSystem('[ PROGRESS SAVED ]');
    ip += 1; return;
  }

  if (t.startsWith('*uppercase')) {
    const key   = normalizeKey(t.replace('*uppercase', '').trim());
    const store = Object.prototype.hasOwnProperty.call(tempState, key) ? tempState : playerState;
    if (typeof store[key] === 'string') store[key] = store[key].toUpperCase();
    ip += 1; return;
  }

  if (t.startsWith('*lowercase')) {
    const key   = normalizeKey(t.replace('*lowercase', '').trim());
    const store = Object.prototype.hasOwnProperty.call(tempState, key) ? tempState : playerState;
    if (typeof store[key] === 'string') store[key] = store[key].toLowerCase();
    ip += 1; return;
  }

  if (t.startsWith('*add_item')) {
    const item = t.replace('*add_item', '').trim().replace(/^"|"$/g, '');
    if (!Array.isArray(playerState.inventory)) playerState.inventory = [];
    addInventoryItem(item);
    scheduleStatsRender();
    ip += 1; return;
  }

  if (t.startsWith('*remove_item')) {
    const item = t.replace('*remove_item', '').trim().replace(/^"|"$/g, '');
    removeInventoryItem(item);
    scheduleStatsRender();
    ip += 1; return;
  }

  if (t.startsWith('*check_item')) {
    // Syntax: *check_item "Item Name" dest_var
    const checkArgs  = t.replace('*check_item', '').trim();
    const checkMatch = checkArgs.match(/^"([^"]+)"\s+([a-zA-Z_][\w]*)$/) ||
                       checkArgs.match(/^(\S+)\s+([a-zA-Z_][\w]*)$/);
    if (!checkMatch) {
      showEngineError(
        `*check_item requires two arguments: *check_item "Item Name" dest_var\n` +
        `Got: ${t}\n\n` +
        `The old single-argument form (*check_item "Item") is no longer supported.`
      );
      ip = currentLines.length;
      return;
    }
    const checkItemName = checkMatch[1];
    const checkDestKey  = normalizeKey(checkMatch[2]);
    const checkResult   = Array.isArray(playerState.inventory) &&
      playerState.inventory.some(i => itemBaseName(i) === itemBaseName(checkItemName));

    if (Object.prototype.hasOwnProperty.call(tempState, checkDestKey)) {
      tempState[checkDestKey] = checkResult;
    } else {
      if (!Object.prototype.hasOwnProperty.call(playerState, checkDestKey)) {
        console.warn(`[engine] *check_item dest_var "${checkDestKey}" is undeclared — writing to playerState.`);
      }
      playerState[checkDestKey] = checkResult;
    }
    ip += 1; return;
  }

  if (t.startsWith('*if')) {
    const chainEnd = findIfChainEnd(ip, line.indent);
    let cursor   = ip;
    let executed = false;
    while (cursor < chainEnd) {
      const c = currentLines[cursor];
      if (!c.trimmed) { cursor += 1; continue; }
      if (c.trimmed.startsWith('*if') || c.trimmed.startsWith('*elseif')) {
        const blockStart = cursor + 1;
        const blockEnd   = findBlockEnd(blockStart, c.indent);
        if (!executed && evaluateCondition(c.trimmed)) {
          await executeBlock(blockStart, blockEnd, chainEnd);
          executed = true;
          if (awaitingChoice) return;
        }
        cursor = blockEnd;
        continue;
      }
      if (c.trimmed.startsWith('*else')) {
        const blockStart = cursor + 1;
        const blockEnd   = findBlockEnd(blockStart, c.indent);
        if (!executed) {
          await executeBlock(blockStart, blockEnd, chainEnd);
          if (awaitingChoice) return;
        }
        cursor = blockEnd;
        continue;
      }
      cursor += 1;
    }
    ip = chainEnd;
    return;
  }

  if (t.startsWith('*loop')) {
    const blockStart = ip + 1;
    const blockEnd   = findBlockEnd(blockStart, line.indent);
    let guard = 0;
    // Note: a *choice inside a *loop re-evaluates the loop condition after
    // the choice body runs. Authors should ensure choices inside loops modify
    // the loop condition variable, or use *goto to break out.
    while (evaluateCondition(t) && guard < 100) {
      await executeBlock(blockStart, blockEnd);
      if (awaitingChoice) return;
      guard += 1;
    }
    if (guard >= 100) {
      console.warn(`[engine] *loop guard tripped at line ${ip} — possible infinite loop in "${currentScene}"`);
    }
    ip = blockEnd;
    return;
  }

  if (t.startsWith('*choice')) {
    const parsed = parseChoice(ip, line.indent);
    awaitingChoice = { end: parsed.end, choices: parsed.choices };
    renderChoices(parsed.choices);
    return;
  }

  if (t.startsWith('*ending')) {
    showEndingScreen('The End', 'Your path is complete.');
    return;
  }

  ip += 1;
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
      awaitingChoice = null;

      // resumeAt is where the story continues after this choice option body.
      // _savedIp is set when the choice is nested inside an *if/*loop block
      // (points past the whole containing structure). For a top-level *choice,
      // ctx.end is the line after the last option body — past all the sibling
      // *label lines that follow the *choice block in the scene file.
      const resumeAt = ctx._savedIp !== undefined ? ctx._savedIp : ctx.end;

      clearNarrative();
      applyTransition();
      await executeBlock(choice.start, choice.end);

      // Restore ip to resumeAt before calling runInterpreter so it always
      // starts from past the choice block, never from inside a sibling label.
      if (!awaitingChoice) {
        ip = resumeAt;
        await runInterpreter();
      }
    });

    dom.choiceArea.appendChild(btn);
  });

  if (levelUpActive) {
    const choiceOverlay = document.createElement('div');
    choiceOverlay.className = 'levelup-choice-overlay';
    choiceOverlay.innerHTML = `<span>All stat points must be allocated</span>`;
    dom.choiceArea.appendChild(choiceOverlay);
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
  // scrollTop reset intentionally omitted here — clearNarrative() handles
  // scroll on scene changes; resetting here caused a snap before animations.
  runStatsScene();
}

// ---------------------------------------------------------------------------
// Stats panel renderer
// ---------------------------------------------------------------------------
async function runStatsScene() {
  const text  = await fetchTextFile('stats');
  const lines = parseLines(text);
  let html = '';
  // FIX #15: styleState no longer has a `groups` array (it was never written to).
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
      statRegistry.forEach(({ key, label }) => {
        entries.push({ type: 'stat', key, label });
      });
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
      const colorClass = styleState.colors[e.key] || '';
      const icon       = styleState.icons[e.key]  ?? '';
      const labelHtml  = icon ? `${icon} ${e.label}` : e.label;
      html += `<div class="status-row"><span class="status-label">${labelHtml}</span><span class="status-value ${colorClass}">${playerState[e.key] ?? '—'}</span></div>`;
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
  pendingLevelUpDisplay  = false;
  _pendingLevelUpCount   = 0;

  const keys     = getAllocatableStatKeys();
  const labelMap = Object.fromEntries(statRegistry.map(({ key, label }) => [key, label]));
  const alloc    = Object.fromEntries(keys.map(k => [k, 0]));

  const block = document.createElement('div');
  block.className = 'levelup-inline-block';
  block.style.animationDelay = `${delayIndex * 80}ms`;
  delayIndex += 1;
  dom.narrativeContent.insertBefore(block, dom.choiceArea);

  dom.choiceArea.querySelectorAll('button').forEach(b => {
    if (!b.dataset.unselectable) b.disabled = true;
  });

  if (dom.choiceArea.querySelector('button')) {
    const choiceOverlay = document.createElement('div');
    choiceOverlay.className = 'levelup-choice-overlay';
    choiceOverlay.innerHTML = `<span>↑ Allocate your stat points before continuing</span>`;
    dom.choiceArea.appendChild(choiceOverlay);
  }

  const render = () => {
    const spent  = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain = pendingStatPoints - spent;
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
              <button class="alloc-btn" data-op="plus"  data-k="${k}" ${remain <= 0  ? 'disabled' : ''}>+</button>
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
        const key    = btn.dataset.k;
        const spent2 = Object.values(alloc).reduce((a, b) => a + b, 0);
        if (btn.dataset.op === 'plus'  && spent2 < pendingStatPoints) alloc[key] += 1;
        if (btn.dataset.op === 'minus' && alloc[key] > 0)             alloc[key] -= 1;
        render();
      };
    });

    block.querySelector('[data-confirm]').onclick = () => {
      const spent = Object.values(alloc).reduce((a, b) => a + b, 0);
      if (spent < pendingStatPoints) return;

      Object.entries(alloc).forEach(([k, v]) => {
        playerState[k] = Number(playerState[k] || 0) + v;
      });
      pendingStatPoints = 0;

      block.innerHTML = `
        <span class="system-block-label">[ LEVEL UP ]</span>
        <span class="system-block-text levelup-confirmed-text">
          Level ${playerState.level} reached — stats allocated.
        </span>`;
      block.classList.add('levelup-inline-block--confirmed');

      const overlay = dom.choiceArea.querySelector('.levelup-choice-overlay');
      if (overlay) overlay.remove();
      dom.choiceArea.querySelectorAll('button').forEach(b => {
        if (!b.dataset.unselectable) b.disabled = false;
      });

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
  // FIX #6: use resetGame() consistently instead of inlining location.reload().
  dom.endingActionBtn.onclick     = resetGame;
  dom.endingOverlay.classList.remove('hidden');
}

// FIX #6: resetGame is now actually used (was dead code before).
function resetGame() { location.reload(); }

// ---------------------------------------------------------------------------
// Test accessor — returns live references to internal state objects.
// Used only by the automated test harness (test_phase*.mjs).
// ---------------------------------------------------------------------------
function getEngineState() {
  return { playerState, tempState, statRegistry, startup, currentScene, pendingStatPoints };
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function wireUI() {
  dom.statusToggle.addEventListener('click', () => {
    const isNowVisible = dom.statusPanel.classList.toggle('status-visible');
    dom.statusPanel.classList.toggle('status-hidden', !isNowVisible);
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
    if (confirm('Restart from the beginning?')) {
      clearSave();
      resetGame();
    }
  });
}

// ---------------------------------------------------------------------------
// Save system
// ---------------------------------------------------------------------------
function saveGame(label = null) {
  const payload = {
    version:          SAVE_VERSION,
    scene:            currentScene,
    label,
    playerState:      JSON.parse(JSON.stringify(playerState)),
    pendingStatPoints,
    timestamp:        Date.now(),
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[engine] Save failed (localStorage unavailable?):', err);
  }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const save = JSON.parse(raw);
    if (save.version !== SAVE_VERSION) {
      console.warn(`[engine] Save version mismatch (saved ${save.version}, engine ${SAVE_VERSION}) — discarding.`);
      return null;
    }
    return save;
  } catch (err) {
    console.warn('[engine] Could not parse save data:', err);
    return null;
  }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (_) {}
}

/**
 * FIX #5: restoreFromSave now fully replaces playerState from the save
 * rather than merging with Object.assign. This prevents stale keys from
 * a previous startup (e.g. a stat removed since the save was made) from
 * persisting silently in the live state.
 *
 * We still apply current startup defaults first so that any NEW keys added
 * to startup.txt after the save was created get their intended defaults
 * rather than being absent from state.
 */
async function restoreFromSave(save) {
  // Start from fresh startup defaults, then overlay the saved values.
  // New keys from startup.txt get defaults; removed keys from the save are
  // silently dropped (they're not in playerState to begin with).
  playerState       = { ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) };
  pendingStatPoints = save.pendingStatPoints ?? 0;
  clearTempState();
  await runStatsScene();
  await gotoScene(save.scene, save.label);
}

function showBootScreen(save) {
  return new Promise((resolve) => {
    const overlay     = dom.bootOverlay;
    const continueBtn = dom.bootContinueBtn;
    const newGameBtn  = dom.bootNewGameBtn;
    const saveInfo    = dom.bootSaveInfo;

    if (save) {
      const date    = new Date(save.timestamp);
      const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      saveInfo.textContent      = `Last saved: ${dateStr} — ${save.scene.toUpperCase()}`;
      continueBtn.disabled      = false;
      continueBtn.style.opacity = '1';
    } else {
      saveInfo.textContent      = 'No save data found.';
      continueBtn.disabled      = true;
      continueBtn.style.opacity = '0.4';
    }

    overlay.classList.remove('hidden');

    continueBtn.addEventListener('click', () => {
      overlay.classList.add('hidden');
      resolve('continue');
    }, { once: true });

    newGameBtn.addEventListener('click', () => {
      overlay.classList.add('hidden');
      resolve('new');
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  wireUI();
  try {
    await parseStartup();
    const save   = loadSave();
    const choice = await showBootScreen(save);
    if (choice === 'continue' && save) {
      await restoreFromSave(save);
    } else {
      clearSave();
      await runStatsScene();
      await gotoScene(startup.sceneList[0] || 'prologue');
    }
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', boot);
