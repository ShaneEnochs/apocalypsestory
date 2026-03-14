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
const SAVE_VERSION = 3;

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

let currentScene          = null;
let currentLines          = [];
let ip                    = 0;
let delayIndex            = 0;
let awaitingChoice        = null;
let pendingStatPoints     = 0;
let pendingLevelUpDisplay = false;

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
// HTML escaping — used whenever player-controlled or author-controlled strings
// are interpolated directly into innerHTML rather than set via textContent.
// ---------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------
function formatText(text) {
  // 1. Variable interpolation — escape values so player-entered strings
  //    (e.g. character names) cannot inject HTML into the narrative.
  let result = text.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k = normalizeKey(v);
    const val = tempState[k] !== undefined ? tempState[k] : (playerState[k] ?? '');
    return escapeHtml(val);
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

  // 3. Markdown — use non-greedy matching to handle multiple pairs correctly
  result = result
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

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
  const threshold = Number(playerState.xp_to_next || 0);
  if (threshold <= 0) return;
  const mult      = Number(playerState.xp_up_mult       ?? 2.2);
  const gain      = Number(playerState.lvl_up_stat_gain ?? 5);
  const spGain    = Number(playerState.lvl_up_skill_gain ?? 1);
  let changed = false;
  let guard   = 0;
  while (Number(playerState.xp) >= Number(playerState.xp_to_next) && guard < 200) {
    const t                      = Number(playerState.xp_to_next);
    if (t <= 0) break;
    playerState.xp               = Number(playerState.xp) - t;
    playerState.level            = Number(playerState.level || 0) + 1;
    playerState.xp_to_next       = Math.floor(t * mult);
    playerState.skill_points     = Number(playerState.skill_points || 0) + spGain;
    pendingStatPoints            += gain;
    changed = true;
    guard  += 1;
  }
  if (guard >= 200) console.warn('[engine] checkAndApplyLevelUp: runaway loop guard tripped.');
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

function getSkillEntry(key) {
  return skillRegistry.find(s => s.key === normalizeKey(key)) ?? null;
}

function playerHasSkill(key) {
  if (!Array.isArray(playerState.skills)) return false;
  return playerState.skills.includes(normalizeKey(key));
}

function grantSkill(key) {
  const nk = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) playerState.skills = [];
  if (playerState.skills.includes(nk)) return false;
  playerState.skills.push(nk);
  return true;
}

function revokeSkill(key) {
  const nk = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) return false;
  const idx = playerState.skills.indexOf(nk);
  if (idx === -1) return false;
  playerState.skills.splice(idx, 1);
  return true;
}

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
  let current = null;
  let descLines = [];

  function commitCurrent() {
    if (!current) return;
    current.description = descLines.join(' ').replace(/\s+/g, ' ').trim();
    skillRegistry.push(current);
    current   = null;
    descLines = [];
  }

  for (const line of lines) {
    if (line.trimmed.startsWith('//')) continue;

    if (line.trimmed.startsWith('*skill')) {
      commitCurrent();
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

    if (current && line.trimmed) {
      descLines.push(line.trimmed);
      continue;
    }
  }

  commitCurrent();

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
  div.innerHTML = `<span class="system-block-label">[ ENGINE ERROR ]</span><span class="system-block-text">${escapeHtml(message)}\n\nUse the Restart button to reload.</span>`;
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
  dom.chapterTitle.textContent = 'ERROR';
}

// ---------------------------------------------------------------------------
// Directive matching helper
// Tests whether a trimmed line starts with a given directive keyword,
// ensuring it doesn't false-match a longer word (e.g. *title vs *titlecard).
// Returns true if the line is exactly the directive or the directive followed
// by whitespace.
// ---------------------------------------------------------------------------
function isDirective(trimmedLine, directive) {
  if (!trimmedLine.startsWith(directive)) return false;
  if (trimmedLine.length === directive.length) return true;
  return /\s/.test(trimmedLine[directive.length]);
}

// ---------------------------------------------------------------------------
// Scene navigation
// ---------------------------------------------------------------------------
async function gotoScene(name, label = null, savedIp = null, isRestore = false) {
  let text;
  try {
    text = await fetchTextFile(name);
  } catch (err) {
    showEngineError(`Could not load scene "${name}".\n${err.message}`);
    return;
  }
  // During a restore, tempState was already populated by restoreFromSave.
  // Clearing it here would destroy the saved *temp variables, breaking every
  // *if that depends on them after a load.
  if (!isRestore) clearTempState();
  // Reset mid-scene state. During a restore we preserve pendingLevelUpDisplay
  // because restoreFromSave already set it from the saved pendingStatPoints —
  // clearing it here would leave choices locked with no level-up block shown.
  awaitingChoice = null;
  if (!isRestore) pendingLevelUpDisplay = false;
  currentScene = name;
  currentLines = parseLines(text);
  indexLabels(name, currentLines);
  ip = 0;
  clearNarrative();
  applyTransition();
  dom.chapterTitle.textContent = name.toUpperCase();
  if (savedIp !== null) {
    ip = savedIp;
    // Recover the chapter title that was in effect at the restore point by
    // scanning backward from savedIp for the most recent *title directive.
    let restoredTitle = null;
    for (let i = savedIp - 1; i >= 0; i--) {
      const l = currentLines[i];
      if (l && isDirective(l.trimmed, '*title')) {
        restoredTitle = l.trimmed.replace(/^\*title\s+/, '').trim();
        break;
      }
    }
    if (restoredTitle) dom.chapterTitle.textContent = restoredTitle;
  } else if (label) {
    const labels = labelsCache.get(name) || {};
    ip = labels[label] ?? 0;
  }
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

// ---------------------------------------------------------------------------
// parseChoice — parses a *choice block into an array of option descriptors.
//
// Supports:
//   #Text                                — plain option
//   *selectable_if (cond) #Text          — conditionally greyed-out option
//   *if cond / #Text / *elseif / *else   — conditionally shown/hidden options
// ---------------------------------------------------------------------------
function parseChoice(startIndex, indent) {
  const choices = [];
  let i = startIndex + 1;
  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    if (line.indent <= indent) break;

    const optionIndent = line.indent;

    // ── *if / *elseif / *else chains inside *choice ──
    // Walk the entire chain, evaluate each branch, and collect the # from
    // whichever branch wins (if any).
    if (line.trimmed.startsWith('*if') && !line.trimmed.startsWith('*if_')) {
      let cursor = i;
      let chainHandled = false;

      while (cursor < currentLines.length) {
        const cl = currentLines[cursor];
        if (!cl || !cl.trimmed) { cursor += 1; continue; }
        // Only process lines at the same indent as the opening *if
        if (cl.indent !== optionIndent) break;

        const isIf     = cl.trimmed.startsWith('*if') && !cl.trimmed.startsWith('*if_');
        const isElseIf = cl.trimmed.startsWith('*elseif');
        const isElse   = cl.trimmed.startsWith('*else') && !cl.trimmed.startsWith('*elseif');

        if (!isIf && !isElseIf && !isElse) break;

        const bodyStart = cursor + 1;
        const bodyEnd   = findBlockEnd(bodyStart, optionIndent);

        // *else always true; *if/*elseif evaluate the condition
        const condResult = isElse ? true : evaluateCondition(cl.trimmed);

        if (!chainHandled && condResult) {
          // Scan this branch body for a # option line
          for (let j = bodyStart; j < bodyEnd; j++) {
            const inner = currentLines[j];
            if (!inner.trimmed) continue;
            if (inner.trimmed.startsWith('#')) {
              const innerText   = inner.trimmed.slice(1).trim();
              const innerIndent = inner.indent;
              const innerStart  = j + 1;
              const innerEnd    = findBlockEnd(innerStart, innerIndent);
              choices.push({ text: innerText, selectable: true, start: innerStart, end: innerEnd });
              break;
            }
          }
          chainHandled = true;
        }

        cursor = bodyEnd;
        if (isElse) break;
      }

      i = cursor;
      continue;
    }

    // ── *selectable_if — option is always visible but may be greyed out ──
    if (line.trimmed.startsWith('*selectable_if')) {
      const m = line.trimmed.match(/^\*selectable_if\s*\((.+)\)\s*#(.*)$/);
      if (m) {
        const selectable = !!evalValue(m[1]);
        const optionText = m[2].trim();
        const start = i + 1;
        const end   = findBlockEnd(start, optionIndent);
        choices.push({ text: optionText, selectable, start, end });
        i = end;
        continue;
      }
      console.warn(`[engine] Malformed *selectable_if at line ${i} in "${currentScene}": ${line.trimmed}`);
      i += 1;
      continue;
    }

    // ── Plain # option ──
    if (line.trimmed.startsWith('#')) {
      const optionText = line.trimmed.slice(1).trim();
      const start = i + 1;
      const end   = findBlockEnd(start, optionIndent);
      choices.push({ text: optionText, selectable: true, start, end });
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

  if (isDirective(t, '*title'))   { dom.chapterTitle.textContent = t.replace(/^\*title\s+/, '').trim(); ip += 1; return; }
  if (isDirective(t, '*label'))   { ip += 1; return; }
  if (isDirective(t, '*comment')) { ip += 1; return; }

  // NOTE: *goto_scene MUST precede *goto.
  if (isDirective(t, '*goto_scene')) {
    await gotoScene(t.replace(/^\*goto_scene\s+/, '').trim());
    return;
  }

  if (isDirective(t, '*goto')) {
    const label  = t.replace(/^\*goto\s+/, '').trim();
    const labels = labelsCache.get(currentScene) || {};
    if (labels[label] === undefined) {
      showEngineError(`Unknown label "${label}" in scene "${currentScene}".`);
      ip = currentLines.length;
      return;
    }
    ip = labels[label];
    _gotoJumped = true;
    delayIndex = 0;
    return;
  }

  if (isDirective(t, '*system')) {
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
    addSystem(t.replace(/^\*system\s+/, '').trim().replace(/^"|"$/g, ''));
    ip += 1; return;
  }

  if (isDirective(t, '*temp'))  { declareTemp(t); ip += 1; return; }
  if (isDirective(t, '*set'))   { setVar(t);      ip += 1; return; }

  if (isDirective(t, '*flag')) {
    const key = normalizeKey(t.replace(/^\*flag\s+/, '').trim());
    if (key) { playerState[key] = true; scheduleStatsRender(); }
    ip += 1; return;
  }

  if (isDirective(t, '*save_point')) {
    const saveLabel = t.replace(/^\*save_point\s*/, '').trim() || null;
    ip += 1;
    const saved = saveGameToSlot('auto', saveLabel);
    addSystem(saved
      ? '[ AUTOSAVE SUCCESSFUL ]\nManual save slot available in Save·Load menu.'
      : '[ SAVE FAILED — storage unavailable ]');
    return;
  }

  if (isDirective(t, '*uppercase')) {
    const key = normalizeKey(t.replace(/^\*uppercase\s+/, '').trim());
    const store = Object.prototype.hasOwnProperty.call(tempState, key) ? tempState : playerState;
    if (typeof store[key] === 'string') store[key] = store[key].toUpperCase();
    ip += 1; return;
  }

  if (isDirective(t, '*lowercase')) {
    const key = normalizeKey(t.replace(/^\*lowercase\s+/, '').trim());
    const store = Object.prototype.hasOwnProperty.call(tempState, key) ? tempState : playerState;
    if (typeof store[key] === 'string') store[key] = store[key].toLowerCase();
    ip += 1; return;
  }

  if (isDirective(t, '*add_item')) {
    const item = t.replace(/^\*add_item\s+/, '').trim().replace(/^"|"$/g, '');
    if (!Array.isArray(playerState.inventory)) playerState.inventory = [];
    addInventoryItem(item);
    scheduleStatsRender();
    ip += 1; return;
  }

  if (isDirective(t, '*remove_item')) {
    removeInventoryItem(t.replace(/^\*remove_item\s+/, '').trim().replace(/^"|"$/g, ''));
    scheduleStatsRender();
    ip += 1; return;
  }

  if (isDirective(t, '*check_item')) {
    const checkArgs  = t.replace(/^\*check_item\s+/, '').trim();
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

  if (isDirective(t, '*check_skill')) {
    const args  = t.replace(/^\*check_skill\s+/, '').trim();
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

  if (isDirective(t, '*grant_skill')) {
    const key = normalizeKey(t.replace(/^\*grant_skill\s+/, '').trim().replace(/^"|"$/g, ''));
    if (!getSkillEntry(key)) {
      console.warn(`[engine] *grant_skill: "${key}" is not in the skill registry. Check skills.txt.`);
    }
    if (grantSkill(key)) scheduleStatsRender();
    ip += 1; return;
  }

  if (isDirective(t, '*revoke_skill')) {
    const key = normalizeKey(t.replace(/^\*revoke_skill\s+/, '').trim().replace(/^"|"$/g, ''));
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
          if (_gotoJumped) { _gotoJumped = false; return; }
        }
        cursor = be; continue;
      }
      if (c.trimmed.startsWith('*else')) {
        const bs = cursor + 1, be = findBlockEnd(bs, c.indent);
        if (!executed) {
          await executeBlock(bs, be, chainEnd);
          if (awaitingChoice) return;
          if (_gotoJumped) { _gotoJumped = false; return; }
        }
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
      if (_gotoJumped) { _gotoJumped = false; return; }
      guard += 1;
    }
    if (guard >= 100) console.warn(`[engine] *loop guard tripped in "${currentScene}"`);
    ip = blockEnd; return;
  }

  if (isDirective(t, '*choice')) {
    const parsed = parseChoice(ip, line.indent);
    awaitingChoice = { end: parsed.end, choices: parsed.choices };
    renderChoices(parsed.choices);
    return;
  }

  if (t === '*ending') { ip = currentLines.length; showEndingScreen('The End', 'Your path is complete.'); return; }

  console.warn(`[engine] Unrecognised directive "${t.split(/\s/)[0]}" in "${currentScene}" at line ${ip} — rendering as text.`);
  addParagraph(t);
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
      // Guard: if another click already cleared awaitingChoice, ignore.
      if (!awaitingChoice) return;
      dom.choiceArea.querySelectorAll('button').forEach(b => b.disabled = true);
      const ctx = awaitingChoice;
      awaitingChoice = null;
      const resumeAt = ctx._savedIp !== undefined ? ctx._savedIp : ctx.end;
      clearNarrative();
      applyTransition();
      await executeBlock(choice.start, choice.end);
      if (!awaitingChoice) {
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
  try {
    while (ip < currentLines.length) {
      _gotoJumped = false;
      await executeCurrentLine();
      if (awaitingChoice) break;
    }
  } catch (err) {
    console.error('[engine] Interpreter error:', err);
    showEngineError(`Interpreter crashed in "${currentScene}" near line ${ip}.\n${err.message}`);
    return;
  }
  if (pendingLevelUpDisplay) showInlineLevelUp();
  await runStatsScene();
}

// ---------------------------------------------------------------------------
// Stats panel renderer
// ---------------------------------------------------------------------------

// Cached parsed stats structure — populated once by parseStatsStructure(),
// reused on every render so we don't re-parse the file each frame.
let _statsParsedEntries = null;

async function parseStatsStructure() {
  let text;
  try {
    text = await fetchTextFile('stats');
  } catch (err) {
    console.warn('[engine] Could not load stats.txt:', err.message);
    return;
  }
  const lines = parseLines(text);
  const entries = [];

  lines.forEach(line => {
    const t = line.trimmed;
    if (!t || t.startsWith('//')) return;
    if (t.startsWith('*stat_group')) {
      entries.push({ type: 'group', name: t.replace(/^\*stat_group\s+/, '').trim().replace(/^"|"$/g, '') });
    } else if (t.startsWith('*stat_color')) {
      const parts = t.split(/\s+/);
      if (parts.length >= 3) entries.push({ type: 'color', key: normalizeKey(parts[1]), color: parts[2] });
    } else if (t.startsWith('*stat_icon')) {
      const m = t.match(/^\*stat_icon\s+([\w_]+)\s+"(.+)"$/);
      if (m) entries.push({ type: 'icon', key: normalizeKey(m[1]), icon: m[2] });
    } else if (t.startsWith('*inventory')) {
      entries.push({ type: 'inventory' });
    } else if (t.startsWith('*skills_registered')) {
      entries.push({ type: 'skills' });
    } else if (t === '*stat_registered') {
      entries.push({ type: 'stat_registered' });
    } else if (t.startsWith('*stat')) {
      const m = t.match(/^\*stat\s+([\w_]+)\s+"(.+)"$/);
      if (m) entries.push({ type: 'stat', key: normalizeKey(m[1]), label: m[2] });
    }
  });

  _statsParsedEntries = entries;
}

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
  // Parse the structure once; reuse on subsequent renders.
  if (!_statsParsedEntries) {
    await parseStatsStructure();
    if (!_statsParsedEntries) return;
  }

  let html = '';
  styleState.colors = {};
  styleState.icons  = {};
  for (const e of _statsParsedEntries) {
    if (e.type === 'color') styleState.colors[e.key] = e.color;
    if (e.type === 'icon')  styleState.icons[e.key]  = e.icon;
  }

  // Expand *stat_registered into concrete stat entries at render time
  const resolved = [];
  for (const e of _statsParsedEntries) {
    if (e.type === 'stat_registered') {
      statRegistry.forEach(({ key, label }) => resolved.push({ type: 'stat', key, label }));
    } else if (e.type !== 'color' && e.type !== 'icon') {
      resolved.push(e);
    }
  }

  let inGroup = false;
  resolved.forEach(e => {
    if (e.type === 'group') {
      if (inGroup) html += `</div>`;
      html += `<div class="status-section"><div class="status-label status-section-header">${escapeHtml(e.name)}</div>`;
      inGroup = true;
    }
    if (e.type === 'stat') {
      const cc = styleState.colors[e.key] || '';
      const ic = styleState.icons[e.key]  ?? '';
      html += `<div class="status-row"><span class="status-label">${ic ? escapeHtml(ic) + ' ' : ''}${escapeHtml(e.label)}</span><span class="status-value ${escapeHtml(cc)}">${escapeHtml(playerState[e.key] ?? '—')}</span></div>`;
    }
    if (e.type === 'inventory') {
      if (inGroup) { html += `</div>`; inGroup = false; }
      const items = Array.isArray(playerState.inventory) && playerState.inventory.length
        ? playerState.inventory.map(i => `<li>${escapeHtml(i)}</li>`).join('')
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
          if (!entry) return `<li class="skill-accordion"><button class="skill-accordion-btn" aria-expanded="false"><span class="skill-accordion-name">${escapeHtml(key)}</span><span class="skill-accordion-chevron">▾</span></button></li>`;
          return `<li class="skill-accordion">
            <button class="skill-accordion-btn" aria-expanded="false">
              <span class="skill-accordion-name">${escapeHtml(entry.label)}</span>
              <span class="skill-accordion-chevron">▾</span>
            </button>
            ${entry.description ? `<div class="skill-accordion-desc" hidden>${escapeHtml(entry.description)}</div>` : ''}
          </li>`;
        }).join('');
        html += `<div class="status-section"><div class="status-label status-section-header">Skills</div><ul class="skill-accordion-list">${skillItems}</ul></div>`;
      }
    }
  });
  if (inGroup) html += `</div>`;
  dom.statusPanel.innerHTML = html;

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

  let skillBrowserOpen = false;

  const render = () => {
    const spent    = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain   = pendingStatPoints - spent;
    const allSpent = remain === 0;

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
              <div class="skill-browser-card-name">${escapeHtml(s.label)}</div>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-sp-badge ${canAfford ? 'skill-browser-sp-badge--can-afford' : ''}">${spCost} SP</span>
                <button class="skill-purchase-btn" data-sk="${escapeHtml(s.key)}" ${canAfford ? '' : 'disabled'}>Unlock</button>
              </div>
            </div>
            <div class="skill-browser-card-desc">${escapeHtml(s.description || '')}</div>
          </div>`;
      }).join('');

      const ownedRows = alreadyOwned.map(s => {
        return `
          <div class="skill-browser-card skill-browser-card--owned">
            <div class="skill-browser-card-top">
              <div class="skill-browser-card-name">${escapeHtml(s.label)}</div>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-owned-badge">✓ Learned</span>
              </div>
            </div>
            <div class="skill-browser-card-desc">${escapeHtml(s.description || '')}</div>
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
            <span class="stat-alloc-name">${escapeHtml(labelMap[k] || k)}</span>
            <div style="display:flex;justify-content:center;gap:8px;align-items:center;">
              <button class="alloc-btn" data-op="minus" data-k="${escapeHtml(k)}" ${alloc[k] <= 0 ? 'disabled' : ''}>−</button>
              <span class="stat-alloc-val ${alloc[k] ? 'buffed' : ''}">${Number(playerState[k] || 0) + alloc[k]}</span>
              <button class="alloc-btn" data-op="plus"  data-k="${escapeHtml(k)}" ${remain <= 0 ? 'disabled' : ''}>+</button>
            </div>
          </div>
        `).join('')}
      </div>

      ${skillBrowserHTML}

      ${!skillBrowserOpen ? `<p style="font-family:var(--font-mono);font-size:0.62rem;letter-spacing:0.06em;color:var(--text-faint);margin:10px 0 4px;line-height:1.6;">Skill Points (SP) carry over between levels — you can spend them now or save them up for costlier skills.</p>` : ''}

      <div class="levelup-inline-footer">
        <button class="skill-browse-btn" data-browse>
          ${skillBrowserOpen ? '▲ Hide Skills' : '▼ Browse Skills'}
        </button>
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

    const browseBtn = block.querySelector('[data-browse]');
    if (browseBtn) {
      browseBtn.onclick = () => {
        skillBrowserOpen = !skillBrowserOpen;
        render();
      };
    }

    block.querySelectorAll('.skill-purchase-btn').forEach(btn => {
      btn.onclick = () => {
        const key    = btn.dataset.sk;
        const result = purchaseSkill(key);
        if (result.ok) {
          scheduleStatsRender();
          render();
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
// ---------------------------------------------------------------------------
function showEndingScreen(title, subtitle) {
  dom.narrativeContent.scrollTop = 0;

  dom.endingTitle.textContent     = title;
  dom.endingContent.textContent   = subtitle;
  dom.endingStats.innerHTML = `Level: ${escapeHtml(playerState.level || 0)}<br>XP: ${escapeHtml(playerState.xp || 0)}<br>Class: ${escapeHtml(playerState.class_name || 'Unclassed')}`;
  dom.endingActionBtn.textContent = 'Play Again';
  dom.endingOverlay.classList.remove('hidden');
  dom.endingOverlay.style.opacity = '1';
  const releaseTrap = trapFocus(dom.endingOverlay, null);
  dom.endingActionBtn.onclick = () => { releaseTrap(); resetGame(); };
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
    tempState:        JSON.parse(JSON.stringify(tempState)),
    pendingStatPoints,
    timestamp:        Date.now(),
  };
}

function saveGameToSlot(slot, label = null) {
  const key = saveKeyForSlot(slot);
  if (!key) { console.warn(`[engine] Unknown save slot: "${slot}"`); return false; }
  try {
    localStorage.setItem(key, JSON.stringify(buildSavePayload(slot, label)));
    return true;
  } catch (err) {
    console.warn(`[engine] Save to slot "${slot}" failed:`, err);
    return false;
  }
}

function copyAutoSaveToSlot(targetSlot) {
  const key = saveKeyForSlot(targetSlot);
  if (!key) { console.warn(`[engine] Unknown save slot: "${targetSlot}"`); return false; }
  const autoSave = loadSaveFromSlot('auto');
  if (!autoSave) { console.warn('[engine] copyAutoSaveToSlot: no auto-save to copy.'); return false; }
  try {
    const payload = { ...autoSave, slot: String(targetSlot), timestamp: Date.now() };
    localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn(`[engine] copyAutoSaveToSlot to slot "${targetSlot}" failed:`, err);
    return false;
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
  if (!save.scene || typeof save.scene !== 'string' || !save.scene.trim()) {
    showEngineError('Save data is corrupt: missing scene name. Cannot restore.');
    return;
  }
  playerState       = { ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) };
  pendingStatPoints = save.pendingStatPoints ?? 0;
  if (pendingStatPoints > 0) pendingLevelUpDisplay = true;
  if (!Array.isArray(playerState.skills)) playerState.skills = [];

  // Restore tempState from save payload.
  if (save.tempState && typeof save.tempState === 'object') {
    tempState = JSON.parse(JSON.stringify(save.tempState));
  } else {
    tempState = {};
  }

  await runStatsScene();
  await gotoScene(save.scene, save.label, save.ip ?? null, true);
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

    const iCard = document.getElementById(`save-card-${s}`);
    if (iCard) {
      const loadBtn = document.getElementById(`ingame-load-${s}`);
      populateSlotCard({
        nameEl:    document.getElementById(`save-slot-name-${s}`),
        metaEl:    document.getElementById(`save-slot-meta-${s}`),
        loadBtn,
        deleteBtn: document.getElementById(`save-delete-${s}`),
        cardEl:    iCard,
        save,
      });
      const saveBtn = document.getElementById(`save-to-${s}`);
      if (saveBtn) saveBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------
function showSplash() {
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
      const ok = copyAutoSaveToSlot(slot);
      if (!ok) {
        showToast('Nothing to save yet — reach a save point first.');
        return;
      }
      const card = document.getElementById(`save-card-${slot}`);
      if (card) {
        card.classList.remove('slot-card--saved');
        void card.offsetWidth;
        card.classList.add('slot-card--saved');
      }
      refreshAllSlotCards();
      showToast(`Saved to Slot ${slot}`);
      setTimeout(() => hideSaveMenu(), 500);
    });
  });

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
  try {
    wireUI();
  } catch (err) {
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

  try {
    await Promise.race([
      parseSkills(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('skills.txt fetch timed out after 5s')), 5000)
      ),
    ]);
  } catch (err) {
    console.warn('[engine] parseSkills() failed or timed out:', err.message);
    if (!Array.isArray(playerState.skills)) playerState.skills = [];
  }

  // Reset the stats cache so it's freshly parsed on first render.
  _statsParsedEntries = null;

  showSplash();
}

document.addEventListener('DOMContentLoaded', boot);
