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
// SKILL SYSTEM:
// • Define skills in skills.txt using *skill blocks:
//     *skill key "Label" cost
//       Description text (can span multiple lines).
//       Blank line or next *skill terminates the description.
// • Skills are purchased from the level-up block using Skill Points (SP).
// • *check_skill "key" dest_var  — writes bool to named variable (mirrors *check_item)
// • *grant_skill "key"           — gives a skill without XP cost (mirrors *add_item)
// • *revoke_skill "key"          — removes a skill
// • *skills_registered (in stats.txt) — renders owned skills with descriptions
//
// PRONOUN INTERPOLATION:
// • Use {they}, {them}, {their}, {themself} in scene text.
//   The engine replaces these with the player's chosen pronouns at render time.
//   Capitalised forms {They}, {Them}, {Their}, {Themself} are also supported.
//
// OTHER FEATURES:
// • Stacking inventory — duplicate items become "Item (2)", "Item (3)", etc.
// • *temp varName value — scene-scoped variable, cleared on *goto_scene only
// • *check_item "Item Name" dest_var — writes bool to named variable
// • *remove_item "Item Name" — decrements stack or removes from inventory
// • Save system — auto-save slot + 3 manual slots, all in localStorage

// ---------------------------------------------------------------------------
// Save system version — bump this when the save payload shape changes so that
// saves from older builds are rejected cleanly rather than silently corrupting
// state on load.
// ---------------------------------------------------------------------------
const SAVE_VERSION = 2;

const SAVE_KEY_AUTO  = 'sa_save_auto';
const SAVE_KEY_SLOTS = { 1: 'sa_save_slot_1', 2: 'sa_save_slot_2', 3: 'sa_save_slot_3' };

function saveKeyForSlot(slot) {
  return slot === 'auto' ? SAVE_KEY_AUTO : (SAVE_KEY_SLOTS[slot] ?? null);
}

// ---------------------------------------------------------------------------
// Pronoun resolution
// ---------------------------------------------------------------------------
const PRONOUN_SETS = {
  'he/him':    { they: 'he',   them: 'him',  their: 'his',   themself: 'himself'  },
  'she/her':   { they: 'she',  them: 'her',  their: 'her',   themself: 'herself'  },
  'they/them': { they: 'they', them: 'them', their: 'their', themself: 'themself' },
  'xe/xem':    { they: 'xe',   them: 'xem',  their: 'xyr',   themself: 'xemself'  },
  'ze/zir':    { they: 'ze',   them: 'zir',  their: 'zir',   themself: 'zirself'  },
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
  restartBtn:         document.getElementById('ingame-restart-btn'),
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
// Engine state
// ---------------------------------------------------------------------------
let playerState  = {};
let tempState    = {};
let startup      = { sceneList: [] };
let statRegistry  = [];
let skillRegistry = [];   // [{ key, label, cost, description }]

let _statRegistryWarningFired = false;
let _gameInProgress           = false;

let currentScene          = null;
let currentLines          = [];
let ip                    = 0;
let delayIndex            = 0;
let awaitingChoice        = null;
let pendingStatPoints     = 0;
let pendingLevelUpDisplay = false;
let _pendingLevelUpCount  = 0;

let _gotoJumped = false;

const sceneCache  = new Map();
const labelsCache = new Map();
const styleState  = { colors: {}, icons: {} };

// ---------------------------------------------------------------------------
// Key normalisation
// ---------------------------------------------------------------------------
function normalizeKey(k) {
  return String(k).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Deferred stats render
// ---------------------------------------------------------------------------
let _statsRenderPending = false;
let _statsRenderRunning = false;
function scheduleStatsRender() {
  if (_statsRenderPending || _statsRenderRunning) return;
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
// Text formatting
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
// Expression evaluator
// ---------------------------------------------------------------------------
function evalValue(expr) {
  const trimmed = expr.trim();
  if (trimmed === '[]') return [];

  const stringSlots = [];
  const withPlaceholders = trimmed.replace(/"([^"\\]|\\.)*"/g, (match) => {
    stringSlots.push(match);
    return `__STR${stringSlots.length - 1}__`;
  });

  const withIdentifiers = withPlaceholders.replace(/[a-zA-Z_][\w]*/g, (token) => {
    if (['true', 'false'].includes(token.toLowerCase())) return token.toLowerCase();
    if (/^__STR\d+__$/.test(token)) return token;
    const k = normalizeKey(token);
    if (Object.prototype.hasOwnProperty.call(tempState,   k)) return `__t.${k}`;
    if (Object.prototype.hasOwnProperty.call(playerState, k)) return `__s.${k}`;
    return token;
  });

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
function setVar(command) {
  const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);

  const inTemp   = Object.prototype.hasOwnProperty.call(tempState,   key);
  const inPlayer = Object.prototype.hasOwnProperty.call(playerState, key);
  const store    = inTemp ? tempState : playerState;

  if (!inTemp && !inPlayer) {
    console.warn(`[engine] *set on undeclared variable "${key}" — did you mean *create or *temp?`);
  }

  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === 'number') {
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

function declareTemp(command) {
  const m = command.match(/^\*temp\s+([a-zA-Z_][\w]*)(?:\s+(.+))?$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  tempState[normalizeKey(rawKey)] = rhs !== undefined ? evalValue(rhs) : 0;
}

function clearTempState() { tempState = {}; }

// ---------------------------------------------------------------------------
// Level-up logic
// ---------------------------------------------------------------------------
function checkAndApplyLevelUp() {
  if (!Number(playerState.xp_to_next || 0)) return;
  const mult      = Number(playerState.xp_up_mult       ?? 2.2);
  const gain      = Number(playerState.lvl_up_stat_gain ?? 5);
  const spGain    = Number(playerState.lvl_up_skill_gain ?? 1);
  let changed = false;
  while (Number(playerState.xp) >= Number(playerState.xp_to_next)) {
    const threshold          = Number(playerState.xp_to_next);
    playerState.xp           = Number(playerState.xp) - threshold;
    playerState.level        = Number(playerState.level || 0) + 1;
    playerState.xp_to_next  = Math.floor(threshold * mult);
    playerState.skill_points = Number(playerState.skill_points || 0) + spGain;
    pendingStatPoints        += gain;
    _pendingLevelUpCount     += 1;
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
  const div       = document.createElement('div');
  const isXP      = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isXP ? ' xp-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;
  div.style.animationDelay = `${delayIndex * 80}ms`;
  delayIndex += 1;
  const formatted = formatText(text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
}

// ---------------------------------------------------------------------------
// Inventory helpers
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
    const c = (playerState.inventory[idx].match(/\((\d+)\)$/) || [, 1])[1];
    playerState.inventory[idx] = `${normalized} (${Number(c) + 1})`;
  }
  return true;
}

function removeInventoryItem(item) {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) return false;
  const idx = playerState.inventory.findIndex(i => itemBaseName(i) === normalized);
  if (idx === -1) {
    console.warn(`[engine] *remove_item: "${normalized}" not found.`);
    return false;
  }
  const c = (playerState.inventory[idx].match(/\((\d+)\)$/) || [, 1])[1];
  const qty = Number(c);
  if (qty <= 1)       playerState.inventory.splice(idx, 1);
  else if (qty === 2) playerState.inventory[idx] = normalized;
  else                playerState.inventory[idx] = `${normalized} (${qty - 1})`;
  return true;
}

// ---------------------------------------------------------------------------
// Skill helpers
// ---------------------------------------------------------------------------

// Returns the skill registry entry for a given key, or null.
function getSkillEntry(key) {
  return skillRegistry.find(s => s.key === normalizeKey(key)) ?? null;
}

// Returns true if the player owns the skill.
function playerHasSkill(key) {
  if (!Array.isArray(playerState.skills)) return false;
  return playerState.skills.includes(normalizeKey(key));
}

// Grants a skill unconditionally (no XP cost). Returns true if newly added.
function grantSkill(key) {
  const nk = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) playerState.skills = [];
  if (playerState.skills.includes(nk)) return false;  // already owned
  playerState.skills.push(nk);
  return true;
}

// Removes a skill. Returns true if it was present.
function revokeSkill(key) {
  const nk = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) return false;
  const idx = playerState.skills.indexOf(nk);
  if (idx === -1) return false;
  playerState.skills.splice(idx, 1);
  return true;
}

// Purchases a skill from the level-up browser (deducts Skill Points).
// Returns { ok: true } or { ok: false, reason: string }.
function purchaseSkill(key) {
  const nk    = normalizeKey(key);
  const entry = getSkillEntry(nk);
  if (!entry)                               return { ok: false, reason: 'Skill not found in registry.' };
  if (playerHasSkill(nk))                   return { ok: false, reason: 'Already owned.' };
  const spCost = entry.spCost ?? entry.cost ?? 1;
  if ((playerState.skill_points || 0) < spCost) return { ok: false, reason: 'Insufficient Skill Points.' };
  playerState.skill_points = Number(playerState.skill_points || 0) - spCost;
  grantSkill(nk);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// System reward text parsers
// ---------------------------------------------------------------------------
function parseInventoryUpdateText(text) {
  const m = text.match(/Inventory\s+updated\s*:\s*([^\n]+)/i);
  if (!m) return [];
  return m[1].trim().split(',')
    .map(e => e.trim().replace(/\.$/, ''))
    .filter(e => e &&
      /^[A-Z0-9][^\n.!?]{0,60}$/.test(e) &&
      !/\b(assembled|acquired|secured|updated|complete|lost|destroyed)\b/i.test(e));
}

function getAllocatableStatKeys() {
  return statRegistry.map(e => e.key);
}

function applySystemRewards(text) {
  let stateChanged = false;

  const xpRanges = [];
  for (const pattern of [
    /XP\s+gained\s*:\s*\+\s*(\d+)/gi,
    /\+[^\S\n]*(\d+)[^\S\n]*(?:bonus[^\S\n]+)?XP\b/gi,
  ]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount) && amount > 0) {
        xpRanges.push({ start: match.index, end: match.index + match[0].length, amount });
      }
    }
  }
  xpRanges.sort((a, b) => a.start - b.start);
  let lastEnd = -1, gainedTotal = 0;
  for (const r of xpRanges) {
    if (r.start >= lastEnd) { gainedTotal += r.amount; lastEnd = r.end; }
  }
  if (gainedTotal > 0) {
    playerState.xp = Number(playerState.xp || 0) + gainedTotal;
    checkAndApplyLevelUp();
    stateChanged = true;
  }

  const allStatsM = text.match(/\+\s*(\d+)\s+to\s+all\s+stats?/i);
  if (allStatsM) {
    const b = Number(allStatsM[1]);
    if (b > 0) { getAllocatableStatKeys().forEach(k => { playerState[k] = Number(playerState[k] || 0) + b; }); stateChanged = true; }
  }

  const vitals = [
    { regex: /\+\s*(\d+)\s+max\s+mana\b/i, key: 'max_mana' },
    { regex: /\+\s*(\d+)\s+mana\b/i,       key: 'mana'     },
    { regex: /\+\s*(\d+)\s+health\b/i,     key: 'health', numericOnly: true },
  ];
  const statP = [];
  statRegistry.forEach(({ key, label }) => {
    const el = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    statP.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${el}\\b`, 'i'), key });
    const nk = key.toLowerCase(), nl = label.toLowerCase().replace(/\s+/g, '_');
    if (nk !== nl) {
      const ek = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _]');
      statP.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${ek}\\b`, 'i'), key });
    }
  });
  [...vitals, ...statP].forEach(({ regex, key, numericOnly }) => {
    const m2 = text.match(regex);
    if (!m2) return;
    const b = Number(m2[1]);
    // Skip if the current value is a non-numeric string (e.g. health = "Healthy")
    if (numericOnly && typeof playerState[key] === 'string' && isNaN(Number(playerState[key]))) return;
    if (b > 0) { playerState[key] = Number(playerState[key] || 0) + b; stateChanged = true; }
  });

  parseInventoryUpdateText(text).forEach(item => { if (addInventoryItem(item)) stateChanged = true; });
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
  dom.narrativeContent.scrollTop = 0;
}

let _transitionTimer = null;
function applyTransition() {
  dom.narrativePanel.classList.add('transitioning');
  if (_transitionTimer) clearTimeout(_transitionTimer);
  _transitionTimer = setTimeout(() => {
    _transitionTimer = null;
    dom.narrativePanel.classList.remove('transitioning');
  }, 220);
}

// ---------------------------------------------------------------------------
// Startup parser
// ---------------------------------------------------------------------------
async function parseStartup() {
  const text  = await fetchTextFile('startup');
  const lines = parseLines(text);
  playerState   = {};
  tempState     = {};
  statRegistry  = [];
  skillRegistry = [];
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
      const key = normalizeKey(rawKey);
      const dv  = evalValue(valStr);
      playerState[key] = dv;
      statRegistry.push({ key, label, defaultVal: dv });
      continue;
    }

    if (line.trimmed.startsWith('*create')) {
      inSceneList = false;
      const m = line.trimmed.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);
      if (!m) continue;
      const [, rawKey, value] = m;
      playerState[normalizeKey(rawKey)] = evalValue(value);
      continue;
    }

    if (line.trimmed.startsWith('*scene_list')) { inSceneList = true; continue; }
    if (inSceneList && !line.trimmed.startsWith('*') && line.indent > 0) {
      startup.sceneList.push(line.trimmed);
    }
  }

  if (statRegistry.length === 0 && !_statRegistryWarningFired) {
    console.warn('[engine] No *create_stat entries found — level-up allocation will be empty.');
    _statRegistryWarningFired = true;
  }
}

// ---------------------------------------------------------------------------
// Skills file parser
// Parses skills.txt and populates skillRegistry.
// Also ensures playerState.skills is initialised as an array.
//
// skills.txt format:
//   *skill key "Label" cost
//     Description line one.
//     Description line two (same indent or deeper).
//   (blank line or next *skill terminates description)
// ---------------------------------------------------------------------------
async function parseSkills() {
  skillRegistry = [];

  let text;
  try {
    text = await fetchTextFile('skills');
  } catch {
    console.warn('[engine] skills.txt not found — skill system disabled.');
    if (!Array.isArray(playerState.skills)) playerState.skills = [];
    return;
  }

  const lines = parseLines(text);
  let current = null;   // the skill entry being built
  let descLines = [];

  function commitCurrent() {
    if (!current) return;
    current.description = descLines.join(' ').replace(/\s+/g, ' ').trim();
    skillRegistry.push(current);
    current   = null;
    descLines = [];
  }

  for (const line of lines) {
    if (line.trimmed.startsWith('//')) continue;   // comment

    if (line.trimmed.startsWith('*skill')) {
      commitCurrent();
      // *skill key "Label" cost
      const m = line.trimmed.match(/^\*skill\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(\d+)$/);
      if (!m) {
        console.warn(`[engine] Malformed *skill line: "${line.trimmed}" — expected: *skill key "Label" cost`);
        continue;
      }
      const [, rawKey, label, costStr] = m;
      current = { key: normalizeKey(rawKey), label, cost: Number(costStr), description: '' };
      descLines = [];
      continue;
    }

    // Non-command lines after a *skill header are description text.
    if (current && line.trimmed) {
      descLines.push(line.trimmed);
      continue;
    }

    // Blank lines while building description are ignored (treated as paragraph breaks
    // if you want them, but for stats panel we collapse to a single string).
    // When there's no current skill, blank lines are also harmless.
  }

  commitCurrent();   // flush the last skill

  if (!Array.isArray(playerState.skills)) playerState.skills = [];

  console.log(`[engine] Loaded ${skillRegistry.length} skill(s) from skills.txt`);
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
async function gotoScene(name, label = null, savedIp = null) {
  let text;
  try {
    text = await fetchTextFile(name);
  } catch (err) {
    showEngineError(`Could not load scene "${name}".\n${err.message}`);
    return;
  }
  clearTempState();
  // Reset all mid-scene state so a freshly loaded scene always runs cleanly.
  awaitingChoice       = null;
  pendingLevelUpDisplay = false;
  currentScene = name;
  currentLines = parseLines(text);
  indexLabels(name, currentLines);
  ip = 0;
  clearNarrative();
  applyTransition();
  dom.chapterTitle.textContent = name.toUpperCase();
  if (savedIp !== null) {
    ip = savedIp;
  } else if (label) {
    const labels = labelsCache.get(name) || {};
    ip = labels[label] ?? 0;
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
  return !!evalValue(condition.replace(/^\(|\)$/g, ''));
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
      if (m) { selectable = !!evalValue(m[1]); optionText = m[2].trim(); }
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
  ip = start;
  while (ip < end) {
    await executeCurrentLine();
    if (awaitingChoice) {
      awaitingChoice._blockEnd = end;
      awaitingChoice._savedIp  = resumeAfter;
      return;
    }
    if (_gotoJumped) {
      _gotoJumped = false;
      return;
    }
  }
  ip = resumeAfter;
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
// Main interpreter
// ---------------------------------------------------------------------------
async function executeCurrentLine() {
  const line = currentLines[ip];
  if (!line) return;
  if (!line.trimmed || line.trimmed.startsWith('//')) { ip += 1; return; }

  const t = line.trimmed;

  if (!t.startsWith('*')) { addParagraph(t); ip += 1; return; }

  if (t.startsWith('*title'))   { dom.chapterTitle.textContent = t.replace('*title', '').trim(); ip += 1; return; }
  if (t.startsWith('*label'))   { ip += 1; return; }
  if (t.startsWith('*comment')) { ip += 1; return; }

  // NOTE: *goto_scene MUST precede *goto.
  if (t.startsWith('*goto_scene')) {
    await gotoScene(t.replace('*goto_scene', '').trim());
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
    ip = labels[label];
    _gotoJumped = true;
    return;
  }

  if (t.startsWith('*system')) {
    if (t === '*system') {
      const parsed = parseSystemBlock(ip);
      if (!parsed.ok) {
        showEngineError(`Unclosed *system block in "${currentScene}". Add *end_system.`);
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

  if (t.startsWith('*temp'))  { declareTemp(t); ip += 1; return; }
  if (t.startsWith('*set'))   { setVar(t);      ip += 1; return; }

  if (t.startsWith('*flag')) {
    const key = normalizeKey(t.replace('*flag', '').trim());
    if (key) { playerState[key] = true; scheduleStatsRender(); }
    ip += 1; return;
  }

  if (t.startsWith('*save_point')) {
    const saveLabel = t.replace('*save_point', '').trim() || null;
    saveGameToSlot('auto', saveLabel);
    addSystem('[ PROGRESS SAVED ]');
    ip += 1; return;
  }

  if (t.startsWith('*uppercase')) {
    const key = normalizeKey(t.replace('*uppercase', '').trim());
    const store = Object.prototype.hasOwnProperty.call(tempState, key) ? tempState : playerState;
    if (typeof store[key] === 'string') store[key] = store[key].toUpperCase();
    ip += 1; return;
  }

  if (t.startsWith('*lowercase')) {
    const key = normalizeKey(t.replace('*lowercase', '').trim());
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
    removeInventoryItem(t.replace('*remove_item', '').trim().replace(/^"|"$/g, ''));
    scheduleStatsRender();
    ip += 1; return;
  }

  if (t.startsWith('*check_item')) {
    const checkArgs  = t.replace('*check_item', '').trim();
    const checkMatch = checkArgs.match(/^"([^"]+)"\s+([a-zA-Z_][\w]*)$/) ||
                       checkArgs.match(/^(\S+)\s+([a-zA-Z_][\w]*)$/);
    if (!checkMatch) {
      showEngineError(`*check_item requires two arguments: *check_item "Item Name" dest_var\nGot: ${t}`);
      ip = currentLines.length;
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
    ip += 1; return;
  }

  // ── Skill commands ──────────────────────────────────────────────────────

  // *check_skill "key" dest_var
  // Writes true/false to dest_var depending on whether the player owns the skill.
  if (t.startsWith('*check_skill')) {
    const args  = t.replace('*check_skill', '').trim();
    const match = args.match(/^"([^"]+)"\s+([a-zA-Z_][\w]*)$/) ||
                  args.match(/^(\S+)\s+([a-zA-Z_][\w]*)$/);
    if (!match) {
      showEngineError(`*check_skill requires two arguments: *check_skill "key" dest_var\nGot: ${t}`);
      ip = currentLines.length;
      return;
    }
    const skillKey  = normalizeKey(match[1]);
    const destKey   = normalizeKey(match[2]);
    const result    = playerHasSkill(skillKey);

    // Warn if the key isn't in the registry — it might be a typo.
    if (!getSkillEntry(skillKey)) {
      console.warn(`[engine] *check_skill: "${skillKey}" is not in the skill registry. Check skills.txt.`);
    }

    if (Object.prototype.hasOwnProperty.call(tempState, destKey)) tempState[destKey] = result;
    else {
      if (!Object.prototype.hasOwnProperty.call(playerState, destKey))
        console.warn(`[engine] *check_skill dest_var "${destKey}" is undeclared.`);
      playerState[destKey] = result;
    }
    ip += 1; return;
  }

  // *grant_skill "key"
  // Gives the player a skill without any XP cost. Useful for story rewards.
  if (t.startsWith('*grant_skill')) {
    const key = normalizeKey(t.replace('*grant_skill', '').trim().replace(/^"|"$/g, ''));
    if (!getSkillEntry(key)) {
      console.warn(`[engine] *grant_skill: "${key}" is not in the skill registry. Check skills.txt.`);
    }
    if (grantSkill(key)) scheduleStatsRender();
    ip += 1; return;
  }

  // *revoke_skill "key"
  // Removes a skill from the player. Useful for story consequences.
  if (t.startsWith('*revoke_skill')) {
    const key = normalizeKey(t.replace('*revoke_skill', '').trim().replace(/^"|"$/g, ''));
    if (revokeSkill(key)) scheduleStatsRender();
    ip += 1; return;
  }

  // ────────────────────────────────────────────────────────────────────────

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
    ip = chainEnd; return;
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
    ip = blockEnd; return;
  }

  if (t.startsWith('*choice')) {
    const parsed = parseChoice(ip, line.indent);
    awaitingChoice = { end: parsed.end, choices: parsed.choices };
    renderChoices(parsed.choices);
    return;
  }

  if (t === '*ending') { ip = currentLines.length; showEndingScreen('The End', 'Your path is complete.'); return; }

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
      // Guard: if another click already cleared awaitingChoice, ignore this one.
      if (!awaitingChoice) return;
      dom.choiceArea.querySelectorAll('button').forEach(b => b.disabled = true);
      const ctx = awaitingChoice;
      awaitingChoice = null;
      const resumeAt = ctx._savedIp !== undefined ? ctx._savedIp : ctx.end;
      clearNarrative();
      applyTransition();
      await executeBlock(choice.start, choice.end);
      if (!awaitingChoice) {
        // If ip is still inside (or at the end of) this option's block, the block
        // ran to its natural end — use resumeAt to continue after the *choice.
        // If ip is outside the block, a *goto redirected it; honour that instead.
        if (ip >= choice.start && ip <= choice.end) ip = resumeAt;
        await runInterpreter();
      }
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
  await runStatsScene();
}

// ---------------------------------------------------------------------------
// Stats panel renderer
// ---------------------------------------------------------------------------
async function runStatsScene() {
  if (_statsRenderRunning) return;
  _statsRenderRunning = true;
  try {
    await _runStatsSceneImpl();
  } finally {
    _statsRenderRunning = false;
  }
}

async function _runStatsSceneImpl() {
  let text;
  try {
    text = await fetchTextFile('stats');
  } catch (err) {
    console.warn('[engine] Could not load stats.txt:', err.message);
    return;
  }
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
    } else if (t.startsWith('*skills_registered')) {
      entries.push({ type: 'skills' });
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
    if (e.type === 'skills') {
      if (inGroup) { html += `</div>`; inGroup = false; }
      const owned = Array.isArray(playerState.skills) ? playerState.skills : [];
      if (owned.length === 0) {
        html += `<div class="status-section"><div class="status-label status-section-header">Skills</div><ul class="tag-list"><li class="tag-empty">None learned</li></ul></div>`;
      } else {
        const skillItems = owned.map(key => {
          const entry = getSkillEntry(key);
          if (!entry) return `<li class="skill-accordion"><button class="skill-accordion-btn" aria-expanded="false"><span class="skill-accordion-name">${key}</span><span class="skill-accordion-chevron">▾</span></button></li>`;
          return `<li class="skill-accordion">
            <button class="skill-accordion-btn" aria-expanded="false">
              <span class="skill-accordion-name">${entry.label}</span>
              <span class="skill-accordion-chevron">▾</span>
            </button>
            ${entry.description ? `<div class="skill-accordion-desc" hidden>${entry.description}</div>` : ''}
          </li>`;
        }).join('');
        html += `<div class="status-section"><div class="status-label status-section-header">Skills</div><ul class="skill-accordion-list">${skillItems}</ul></div>`;
      }
    }
  });
  if (inGroup) html += `</div>`;
  dom.statusPanel.innerHTML = html;

  // Wire skill accordion toggles
  dom.statusPanel.querySelectorAll('.skill-accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const desc = btn.nextElementSibling;
      btn.setAttribute('aria-expanded', String(!expanded));
      btn.classList.toggle('skill-accordion-btn--open', !expanded);
      if (desc && desc.classList.contains('skill-accordion-desc')) {
        if (!expanded) desc.removeAttribute('hidden');
        else           desc.setAttribute('hidden', '');
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Inline level-up block (with skill browser)
// ---------------------------------------------------------------------------
function showInlineLevelUp() {
  pendingLevelUpDisplay = false;
  _pendingLevelUpCount  = 0;

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
    const ov = document.createElement('div');
    ov.className = 'levelup-choice-overlay';
    ov.innerHTML = `<span>↑ Allocate your stat points before continuing</span>`;
    dom.choiceArea.appendChild(ov);
  }

  // Track whether the skill browser panel is open.
  let skillBrowserOpen = false;

  const render = () => {
    const spent    = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain   = pendingStatPoints - spent;
    const allSpent = remain === 0;

    // ── Skill browser HTML ──────────────────────────────────────────────
    let skillBrowserHTML = '';
    if (skillBrowserOpen) {
      const availableSP  = Number(playerState.skill_points || 0);
      const available    = skillRegistry.filter(s => !playerHasSkill(s.key));
      const alreadyOwned = skillRegistry.filter(s =>  playerHasSkill(s.key));

      const emptyMsg = available.length === 0 && alreadyOwned.length === 0
        ? `<p class="skill-browser-empty">No skills defined in skills.txt yet.</p>`
        : '';

      const availableRows = available.map(s => {
        const spCost   = s.spCost ?? s.cost ?? 1;
        const canAfford = availableSP >= spCost;
        return `
          <div class="skill-browser-card ${canAfford ? '' : 'skill-browser-card--unaffordable'}">
            <div class="skill-browser-card-top">
              <div class="skill-browser-card-name">${s.label}</div>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-sp-badge ${canAfford ? 'skill-browser-sp-badge--can-afford' : ''}">${spCost} SP</span>
                <button class="skill-purchase-btn" data-sk="${s.key}" ${canAfford ? '' : 'disabled'}>Unlock</button>
              </div>
            </div>
            <div class="skill-browser-card-desc">${s.description || ''}</div>
          </div>`;
      }).join('');

      const ownedRows = alreadyOwned.map(s => {
        const spCost = s.spCost ?? s.cost ?? 1;
        return `
          <div class="skill-browser-card skill-browser-card--owned">
            <div class="skill-browser-card-top">
              <div class="skill-browser-card-name">${s.label}</div>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-owned-badge">✓ Learned</span>
              </div>
            </div>
            <div class="skill-browser-card-desc">${s.description || ''}</div>
          </div>`;
      }).join('');

      skillBrowserHTML = `
        <div class="skill-browser">
          <div class="skill-browser-header">
            <span class="skill-browser-title">[ SKILL BROWSER ]</span>
            <span class="skill-browser-sp-pool">
              <span class="skill-browser-sp-pool-label">Available SP</span>
              <span class="skill-browser-sp-pool-val">${availableSP}</span>
            </span>
          </div>
          ${emptyMsg}
          ${availableRows.length ? `<div class="skill-browser-section-label">Available</div>${availableRows}` : ''}
          ${ownedRows.length    ? `<div class="skill-browser-section-label skill-browser-section-label--owned">Learned</div>${ownedRows}` : ''}
        </div>`;
    }

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

      ${skillBrowserHTML}

      <div class="levelup-inline-footer">
        <button class="skill-browse-btn" data-browse>
          ${skillBrowserOpen ? '▲ Hide Skills' : '▼ Browse Skills'}
        </button>
        <button class="levelup-confirm-btn ${allSpent ? '' : 'levelup-confirm-btn--locked'}"
          data-confirm ${allSpent ? '' : 'aria-disabled="true"'}>
          ${allSpent ? 'Confirm' : `Spend all points to confirm (${remain} remaining)`}
        </button>
      </div>`;

    // ── Event listeners ──────────────────────────────────────────────────

    block.querySelectorAll('.alloc-btn').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.k;
        const s = Object.values(alloc).reduce((a, b) => a + b, 0);
        if (btn.dataset.op === 'plus'  && s < pendingStatPoints) alloc[k] += 1;
        if (btn.dataset.op === 'minus' && alloc[k] > 0)          alloc[k] -= 1;
        render();
      };
    });

    const browseBtn = block.querySelector('[data-browse]');
    if (browseBtn) {
      browseBtn.onclick = () => {
        skillBrowserOpen = !skillBrowserOpen;
        render();
      };
    }

    // Skill purchase buttons
    block.querySelectorAll('.skill-purchase-btn').forEach(btn => {
      btn.onclick = () => {
        const key    = btn.dataset.sk;
        const result = purchaseSkill(key);
        if (result.ok) {
          scheduleStatsRender();
          render();   // re-render to update SP display and move skill to "Owned"
        } else {
          console.warn(`[engine] Skill purchase failed: ${result.reason}`);
        }
      };
    });

    block.querySelector('[data-confirm]').onclick = () => {
      if (Object.values(alloc).reduce((a, b) => a + b, 0) < pendingStatPoints) return;
      Object.entries(alloc).forEach(([k, v]) => { playerState[k] = Number(playerState[k] || 0) + v; });
      pendingStatPoints = 0;
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
// FIX: scroll narrative back to top before the overlay appears, so the
// underlying content doesn't peek out at the bottom on short viewports.
// ---------------------------------------------------------------------------
function showEndingScreen(title, subtitle) {
  // Reset scroll before the overlay fades in.
  dom.narrativeContent.scrollTop = 0;

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
  return { playerState, tempState, statRegistry, skillRegistry, startup, currentScene, pendingStatPoints };
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
// Save system — multi-slot
// ---------------------------------------------------------------------------
function buildSavePayload(slot, label) {
  return {
    version:          SAVE_VERSION,
    slot:             String(slot),
    scene:            currentScene,
    label:            label ?? null,
    ip:               ip,
    characterName:    `${playerState.first_name || ''} ${playerState.last_name || ''}`.trim() || 'Unknown',
    playerState:      JSON.parse(JSON.stringify(playerState)),
    pendingStatPoints,
    timestamp:        Date.now(),
  };
}

function saveGameToSlot(slot, label = null) {
  const key = saveKeyForSlot(slot);
  if (!key) { console.warn(`[engine] Unknown save slot: "${slot}"`); return; }
  try {
    localStorage.setItem(key, JSON.stringify(buildSavePayload(slot, label)));
  } catch (err) {
    console.warn(`[engine] Save to slot "${slot}" failed:`, err);
  }
}

let _staleSaveFound = false;

function loadSaveFromSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const save = JSON.parse(raw);
    if (save.version !== SAVE_VERSION) {
      console.warn(`[engine] Slot "${slot}" version mismatch — discarding.`);
      _staleSaveFound = true;
      return null;
    }
    return save;
  } catch { return null; }
}

function deleteSaveSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (key) try { localStorage.removeItem(key); } catch (_) {}
}

async function restoreFromSave(save) {
  playerState       = { ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) };
  pendingStatPoints = save.pendingStatPoints ?? 0;
  // If there are unspent stat points, re-arm the level-up display so the
  // block renders and choices aren't permanently locked after a load.
  if (pendingStatPoints > 0) pendingLevelUpDisplay = true;
  // Ensure skills array exists even on saves predating the skill system.
  if (!Array.isArray(playerState.skills)) playerState.skills = [];
  clearTempState();
  await runStatsScene();
  await gotoScene(save.scene, save.label, save.ip ?? null);
}

// ---------------------------------------------------------------------------
// Slot card rendering
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
      const iCard = document.getElementById(`save-card-${slot}`);
      if (iCard) {
        const loadBtn = document.getElementById(`ingame-load-${slot}`);
        populateSlotCard({
          nameEl:    document.getElementById(`save-slot-name-${slot}`),
          metaEl:    document.getElementById(`save-slot-meta-${slot}`),
          loadBtn,
          deleteBtn: document.getElementById(`save-delete-${slot}`),
          cardEl:    iCard,
          save,
        });
        // Save button is always enabled in-game; never disable it
        const saveBtn = document.getElementById(`save-to-${slot}`);
        if (saveBtn) saveBtn.disabled = false;
      }
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
      _staleSaveFound = false;
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
    // Only focus the first field if the user hasn't already clicked somewhere else.
    if (!dom.charOverlay.contains(document.activeElement)) {
      try { dom.inputFirstName.focus(); } catch (_) {}
    }
  });

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
      // Inherit the label from the auto-save so we resume at the right checkpoint.
      const autoSave = loadSaveFromSlot('auto');
      saveGameToSlot(slot, autoSave?.label ?? null);
      hideSaveMenu();
      showToast(`Saved to Slot ${slot}`);
      refreshAllSlotCards();
    });
  });

  // In-game Load buttons (ingame-load-*)
  ['auto', 1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`ingame-load-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      if (!confirm(`Load save from ${slot === 'auto' ? 'auto-save' : 'Slot ' + slot}? Unsaved progress will be lost.`)) return;
      hideSaveMenu();
      await parseStartup();
      await parseSkills();
      await restoreFromSave(save);
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

  dom.splashNewBtn.addEventListener('click', async () => {
    hideSplash();
    const charData = await showCharacterCreation();
    playerState.first_name = charData.firstName;
    playerState.last_name  = charData.lastName;
    playerState.pronouns   = charData.pronouns;
    _gameInProgress = true;
    dom.saveBtn.classList.remove('hidden');
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || 'prologue');
  });

  dom.splashLoadBtn.addEventListener('click', () => {
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.add('hidden');
    dom.splashSlots.classList.remove('hidden');
    refreshAllSlotCards();
  });

  dom.splashSlotsBack.addEventListener('click', () => {
    dom.splashSlots.classList.add('hidden');
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.remove('hidden');
  });

  ['auto', 1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`slot-load-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSplash();
      _gameInProgress = true;
      dom.saveBtn.classList.remove('hidden');
      await parseStartup();
      await parseSkills();
      await restoreFromSave(save);
    });
  });

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
  // wireUI must succeed for any buttons to work — catch and surface errors.
  try {
    wireUI();
  } catch (err) {
    // If wireUI throws, we can't use the normal error display (it needs DOM).
    // Write directly to the body so the developer can see what failed.
    document.body.insertAdjacentHTML('beforeend',
      `<div style="position:fixed;inset:0;background:#0d0f1a;color:#e05555;font-family:monospace;
        padding:40px;z-index:9999;white-space:pre-wrap;font-size:14px;">
        [ENGINE] wireUI() failed — buttons will not work.\n\n${err.stack || err.message}</div>`
    );
    console.error('[engine] wireUI() failed:', err);
    return;
  }

  try {
    await parseStartup();
  } catch (err) {
    showEngineError(`Boot failed (parseStartup): ${err.message}`);
    return;
  }

  // parseSkills is non-critical — a failure here must never block the splash.
  try {
    // Race against a 5-second timeout so a hanging fetch never freezes boot.
    await Promise.race([
      parseSkills(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('skills.txt fetch timed out after 5s')), 5000)
      ),
    ]);
  } catch (err) {
    console.warn('[engine] parseSkills() failed or timed out:', err.message);
    // Ensure skills array always exists even on failure.
    if (!Array.isArray(playerState.skills)) playerState.skills = [];
  }

  showSplash();
}

document.addEventListener('DOMContentLoaded', boot); 