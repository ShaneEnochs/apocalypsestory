// Extended ChoiceScript-lite engine for System Awakening

//

// STAT SYSTEM — fully data-driven, zero hardcoded stat names:

// • *create_stat key "Label" defaultValue (in startup.txt)

// Registers a stat. Use any key, any label, any default.

// These are the stats shown in the level-up allocation screen.

// Example: *create_stat cunning "Cunning" 10

// • *stat_registered (in stats.txt)

// Expands to one display row per *create_stat entry.

// Put it once in stats.txt where you want attributes shown —

// you never need to list stat names in two places.

// • xp_up_mult / lvl_up_stat_gain (plain *create in startup.txt)

// Control XP threshold multiplier and stat points per level-up.

//

// OTHER FEATURES:

// • Stacking inventory — duplicate items become "Item (2)", "Item (3)", etc.

// • *temp varName value — scene-scoped variable, cleared on scene transitions



// ---------------------------------------------------------------------------

// DOM cache

// ---------------------------------------------------------------------------

const dom = {

narrativeContent: document.getElementById('narrative-content'),

choiceArea: document.getElementById('choice-area'),

chapterTitle: document.getElementById('chapter-title'),

narrativePanel: document.getElementById('narrative-panel'),

statusPanel: document.getElementById('status-panel'),

statusToggle: document.getElementById('status-toggle'),

restartBtn: document.getElementById('restart-btn'),

endingOverlay: document.getElementById('ending-overlay'),

endingTitle: document.getElementById('ending-title'),

endingContent: document.getElementById('ending-content'),

endingStats: document.getElementById('ending-stats'),

endingActionBtn: document.getElementById('ending-action-btn')

};



Object.entries(dom).forEach(([key, el]) => {

if (!el) console.warn(`[engine] DOM element missing for key "${key}" — check index.html IDs`);

});



// ---------------------------------------------------------------------------

// Engine state

// ---------------------------------------------------------------------------

let playerState = {}; // persistent variables (survives scene changes)

let tempState = {}; // *temp variables — cleared on scene transitions only

let startup = { sceneList: [] };



// Stat registry — populated by *create_stat in startup.txt.

// Each entry: { key: string, label: string, defaultVal: number }

let statRegistry = [];



let currentScene = null;

let currentLines = [];

let ip = 0;

let delayIndex = 0;

let awaitingChoice = null;

let pendingStatPoints = 0;

let pendingLevelUpDisplay = false;



const sceneCache = new Map();

const labelsCache = new Map();

const styleState = { groups: [], colors: {}, icons: {} };



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

// Interpolate ${varName} — check tempState first, then playerState

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



const stringSlots = [];

const withPlaceholders = trimmed.replace(/"([^"\\]|\\.)*"/g, (match) => {

stringSlots.push(match);

return `__STR${stringSlots.length - 1}__`;

});



const sanitized = withPlaceholders

.replace(/\band\b/g, '&&')

.replace(/\bor\b/g, '||')

.replace(/\bnot\b/g, '!')

.replace(/\btrue\b/gi, 'true')

.replace(/\bfalse\b/gi, 'false')

.replace(/[a-zA-Z_][\w]*/g, (token) => {

if (['true', 'false'].includes(token)) return token;

if (/^__STR\d+__$/.test(token)) return token;

// Normalise to lowercase so Strength and strength resolve identically

const k = normalizeKey(token);

// tempState has priority over playerState

if (Object.prototype.hasOwnProperty.call(tempState, k)) return `__t.${k}`;

if (Object.prototype.hasOwnProperty.call(playerState, k)) return `__s.${k}`;

return token;

})

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

*/

function setVar(command) {

const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);

if (!m) return;

const [, rawKey, rhs] = m;

const key = normalizeKey(rawKey);



// Decide which store owns this variable

const inTemp = Object.prototype.hasOwnProperty.call(tempState, key);

const inPlayer = Object.prototype.hasOwnProperty.call(playerState, key);

const store = inTemp ? tempState : playerState;



// Warn if the variable wasn't declared — likely an authoring typo

if (!inTemp && !inPlayer) {

console.warn(`[engine] *set on undeclared variable "${key}" — did you mean to use *create in startup.txt or *temp in this scene?`);

}



if (/^[+\-*/]\s*[\d\w]/.test(rhs) && typeof store[key] === 'number') {

store[key] = evalValue(`${store[key]} ${rhs}`);

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

* The variable persists for the entire scene file and is only cleared

* when transitioning to a new scene via *goto_scene.

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

// Level-up logic — uses startup-configurable multipliers

// ---------------------------------------------------------------------------

function checkAndApplyLevelUp() {

if (!Number(playerState.xp_to_next || 0)) return;

const mult = Number(playerState.xp_up_mult ?? 2.2);

const gain = Number(playerState.lvl_up_stat_gain ?? 5);

let changed = false;

while (Number(playerState.xp) >= Number(playerState.xp_to_next)) {

playerState.level = Number(playerState.level || 0) + 1;

playerState.xp_to_next = Math.floor(Number(playerState.xp_to_next) * mult);

pendingStatPoints += gain;

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

// Detect block type for CSS variant styling:
// XP-gain blocks get amber tint; level-up blocks get green tint.
const isXP = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(text);
const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
div.className = `system-block${isXP ? ' xp-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;

div.style.animationDelay = `${delayIndex * 80}ms`;

delayIndex += 1;

const formatted = formatText(text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');

div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;

dom.narrativeContent.insertBefore(div, dom.choiceArea);



// If this system block triggered a level-up, inject the inline allocation

// block immediately below it — in reading order, before any choices appear.

if (pendingLevelUpDisplay) {

showInlineLevelUp();

}

}



// ---------------------------------------------------------------------------

// Inventory helpers — stacking support

// ---------------------------------------------------------------------------



/**

* Returns the base name of an item, stripping any " (N)" suffix.

* e.g. "Iron Sword (2)" → "Iron Sword"

*/

function itemBaseName(item) {

return String(item).replace(/\s*\(\d+\)$/, '').trim();

}



/**

* Add an item to the inventory with stacking support.

* • First copy → stored as plain name: "Iron Sword"

* • Second copy → renamed to: "Iron Sword (2)"

* • Third copy → renamed to: "Iron Sword (3)" ...etc.

* One inventory slot per item type always shows the current quantity.

* Returns true if the state changed.

*/

function addInventoryItem(item) {

const normalized = itemBaseName(item);

if (!normalized) return false;

if (!Array.isArray(playerState.inventory)) playerState.inventory = [];



// Find the existing slot for this base name (if any)

const idx = playerState.inventory.findIndex(i => itemBaseName(i) === normalized);



if (idx === -1) {

// Brand new item — store plain name

playerState.inventory.push(normalized);

} else {

// Already exists — bump the quantity counter

const stackEntry = playerState.inventory[idx];

const countMatch = stackEntry.match(/\((\d+)\)$/);

const currentQty = countMatch ? Number(countMatch[1]) : 1;

playerState.inventory[idx] = `${normalized} (${currentQty + 1})`;

}



return true;

}



// ---------------------------------------------------------------------------

// System reward text parsers

// ---------------------------------------------------------------------------

function parseInventoryUpdateText(text) {

const m = text.match(/Inventory\s+updated\s*:\s*([^\n]+)/i);

if (!m) return [];



const payload = m[1].trim();

if (!payload ||

/^(mixed\s+survival\s+kit\s+assembled\.?|medical\s+supplies\s+acquired\.?|ritual\s+components\s+secured\.?)$/i.test(payload)) {

return [];

}



return payload

.split(',')

.map(entry => entry.trim().replace(/\.$/, ''))

.filter(Boolean);

}



/**

* Returns the list of stat keys that appear in the level-up allocation screen.

* These are exactly the stats declared with *create_stat in startup.txt.

* Returns an empty array (and warns) when no stats have been registered —

* the game will still run, level-ups will simply award no allocatable points.

*/

function getAllocatableStatKeys() {

if (statRegistry.length === 0) {

console.warn('[engine] No *create_stat entries found in startup.txt — level-up allocation will be empty.');

}

return statRegistry.map(e => e.key);

}



function applySystemRewards(text) {

let stateChanged = false;



// XP gains

const xpMatches = [

...(text.match(/XP\s+gained\s*:\s*\+\s*\d+/gi) || []),

...(text.match(/\+[^\S\n]*\d+[^\S\n]*(?:bonus[^\S\n]+)?XP\b/gi) || [])

];

let gainedTotal = 0;

xpMatches.forEach(entry => {

const amount = Number((entry.match(/\d+/) || [0])[0]);

if (Number.isFinite(amount) && amount > 0) gainedTotal += amount;

});

if (gainedTotal > 0) {

playerState.xp = Number(playerState.xp || 0) + gainedTotal;

checkAndApplyLevelUp();

stateChanged = true;

}



// "+N to all stats" — uses registry so custom stat keys are included

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



// Stat-gain patterns built entirely from the registry — no hardcoded names.

// For each registered stat we match both its human label ("Magic Power") and

// its snake_case key ("magic_power"), so authors can use either form in *system text.

// The three structural vitals (health / mana / max_mana) are always included.

const vitalsPatterns = [

{ regex: /\+\s*(\d+)\s+max\s+mana\b/i, key: 'max_mana' },

{ regex: /\+\s*(\d+)\s+mana\b/i, key: 'mana' },

{ regex: /\+\s*(\d+)\s+health\b/i, key: 'health' },

];



const statPatterns = [];

statRegistry.forEach(({ key, label }) => {

// Match by human label e.g. "+5 Magic Power"

const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${escapedLabel}\\b`, 'i'), key });



// Match by snake_case key e.g. "+5 magic_power" (only when different from label)

const normKey = key.toLowerCase();

const normLabel = label.toLowerCase().replace(/\s+/g, '_');

if (normKey !== normLabel) {

const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _]');

statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${escapedKey}\\b`, 'i'), key });

}

});



[...vitalsPatterns, ...statPatterns].forEach(({ regex, key }) => {

const m = text.match(regex);

if (!m) return;

const bonus = Number(m[1]);

if (bonus <= 0) return;

playerState[key] = Number(playerState[key] || 0) + bonus;

stateChanged = true;

});



// Inventory items embedded in system text

const inventoryItems = parseInventoryUpdateText(text);

inventoryItems.forEach(item => {

if (addInventoryItem(item)) stateChanged = true;

});



if (stateChanged) scheduleStatsRender();

}



// ---------------------------------------------------------------------------

// Narrative clear

// ---------------------------------------------------------------------------

function clearNarrative() {

Array.from(dom.narrativeContent.children).forEach(el => {

if (el !== dom.choiceArea) el.remove();

});

dom.choiceArea.innerHTML = '';

delayIndex = 0;

}



function applyTransition() {

dom.narrativePanel.classList.add('transitioning');

setTimeout(() => dom.narrativePanel.classList.remove('transitioning'), 220);

}



// ---------------------------------------------------------------------------

// Startup parser

// Handles: *create, *create_stat, *scene_list, xp_up_mult, lvl_up_stat_gain

// ---------------------------------------------------------------------------

async function parseStartup() {

const text = await fetchTextFile('startup');

const lines = parseLines(text);

playerState = {};

tempState = {};

statRegistry = [];

startup.sceneList = [];



let inSceneList = false;



for (const line of lines) {

if (!line.trimmed || line.trimmed.startsWith('//')) continue;



// *create_stat key "Label" defaultValue

if (line.trimmed.startsWith('*create_stat')) {

inSceneList = false;

// Format: *create_stat key "Human Label" defaultValue

const m = line.trimmed.match(/^\*create_stat\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(.+)$/);

if (!m) {

console.warn(`[engine] Malformed *create_stat: ${line.trimmed}`);

continue;

}

const [, rawKey, label, valStr] = m;

const key = normalizeKey(rawKey);

const defaultVal = evalValue(valStr);

playerState[key] = defaultVal;

statRegistry.push({ key, label, defaultVal });

continue;

}



// *create key value (regular variable — not a registered stat)

if (line.trimmed.startsWith('*create')) {

inSceneList = false;

const m = line.trimmed.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);

if (!m) continue;

const [, rawKey, value] = m;

const key = normalizeKey(rawKey);

playerState[key] = evalValue(value);

continue;

}



if (line.trimmed.startsWith('*scene_list')) {

inSceneList = true;

continue;

}



if (inSceneList && !line.trimmed.startsWith('*') && line.indent > 0) {

startup.sceneList.push(line.trimmed);

}

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

clearTempState(); // ← temp vars cleared on every scene change

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

if (line.trimmed.startsWith('*elseif') || line.trimmed.startsWith('*else')) {

const bodyEnd = findBlockEnd(i + 1, indent);

i = bodyEnd;

continue;

}

break;

}

i += 1;

}

return i;

}



function evaluateCondition(raw) {

const condition = raw

.replace(/^\*if\s*/, '')

.replace(/^\*elseif\s*/, '')

.replace(/^\*loop\s*/, '')

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



let selectable = true;

let optionText = '';

let optionIndent = line.indent;



if (line.trimmed.startsWith('*selectable_if')) {

const m = line.trimmed.match(/^\*selectable_if\s*\((.+)\)\s*#(.*)$/);

if (m) { selectable = !!evalValue(m[1]); optionText = m[2].trim(); }

} else if (line.trimmed.startsWith('#')) {

optionText = line.trimmed.slice(1).trim();

}



if (optionText) {

const start = i + 1;

const end = findBlockEnd(start, optionIndent);

choices.push({ text: optionText, selectable, start, end });

i = end;

continue;

}

i += 1;

}

return { choices, end: i };

}



async function executeBlock(start, end) {

const savedIp = ip;

ip = start;

while (ip < end) {

await executeCurrentLine();

if (awaitingChoice) {

awaitingChoice._blockEnd = end;

awaitingChoice._savedIp = savedIp;

return;

}

}

if (ip === end) ip = savedIp;

}



function parseSystemBlock(startIndex) {

const parts = [];

let i = startIndex + 1;

while (i < currentLines.length) {

const t = currentLines[i].trimmed;

if (t === '*end_system') return { text: parts.join('\n'), endIp: i + 1, ok: true };

parts.push(currentLines[i].raw.replace(/^\s*/, ''));

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



// Plain narrative text

if (!t.startsWith('*')) { addParagraph(t); ip += 1; return; }



if (t.startsWith('*title')) {

dom.chapterTitle.textContent = t.replace('*title', '').trim();

ip += 1; return;

}



if (t.startsWith('*label')) {

// *label is a marker only — does NOT clear temp vars.
// Temp vars persist for the entire scene file; only *goto_scene clears them.

ip += 1; return;

}



if (t.startsWith('*comment')) { ip += 1; return; }



if (t.startsWith('*goto_scene')) {

const target = t.replace('*goto_scene', '').trim();

await gotoScene(target);

return;

}



if (t.startsWith('*goto')) {

const label = t.replace('*goto', '').trim();

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



// *temp — scene-scoped variable declaration (persists until *goto_scene)

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



if (t.startsWith('*check_item')) {

const item = t.replace('*check_item', '').trim().replace(/^"|"$/g, '');

// Result goes into tempState so it's automatically cleared after the scene

tempState._check_item = Array.isArray(playerState.inventory) &&

playerState.inventory.some(i => itemBaseName(i) === itemBaseName(item));

ip += 1; return;

}



if (t.startsWith('*if')) {

const chainEnd = findIfChainEnd(ip, line.indent);

let cursor = ip;

let executed = false;

while (cursor < chainEnd) {

const c = currentLines[cursor];

if (!c.trimmed) { cursor += 1; continue; }

if (c.trimmed.startsWith('*if') || c.trimmed.startsWith('*elseif')) {

const blockStart = cursor + 1;

const blockEnd = findBlockEnd(blockStart, c.indent);

if (!executed && evaluateCondition(c.trimmed)) {

await executeBlock(blockStart, blockEnd);

executed = true;

if (awaitingChoice) return;

}

cursor = blockEnd;

continue;

}

if (c.trimmed.startsWith('*else')) {

const blockStart = cursor + 1;

const blockEnd = findBlockEnd(blockStart, c.indent);

if (!executed) {

await executeBlock(blockStart, blockEnd);

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

const blockEnd = findBlockEnd(blockStart, line.indent);

let guard = 0;

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

// If a level-up is pending when choices are about to render, inject the

// allocation block first (if it hasn't been injected already by addSystem).

if (pendingLevelUpDisplay) {

showInlineLevelUp(); // inserts block, consumes pendingLevelUpDisplay flag

}



// Detect whether an unconfirmed level-up allocation is active.

// This covers the case where showInlineLevelUp() was already called earlier

// (e.g. from addSystem) before the choice buttons existed — the flag was

// consumed but the player still hasn't allocated their points.

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

// Level-up block is active — lock this button until allocation confirmed

btn.disabled = true;

}

btn.addEventListener('click', async () => {

dom.choiceArea.querySelectorAll('button').forEach(b => b.disabled = true);

const ctx = awaitingChoice;

awaitingChoice = null;

ip = ctx._savedIp !== undefined ? ctx._savedIp : ctx.end;

clearNarrative();

applyTransition();

await executeBlock(choice.start, choice.end);

if (!awaitingChoice) await runInterpreter();

});

dom.choiceArea.appendChild(btn);

});



// If an unconfirmed level-up is active, add the overlay telling the player

// to allocate points before continuing.

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

// Edge case: a level-up was triggered (e.g. via *set xp) but there was no

// *system block after it to call showInlineLevelUp(). Inject the block now,

// before the choices are visible so the player must allocate first.

if (pendingLevelUpDisplay) {

showInlineLevelUp();

}

// scrollTop reset removed — clearNarrative() handles scroll on scene changes,

// and resetting here caused a visible snap before staggered animations completed.

runStatsScene();

}



// ---------------------------------------------------------------------------

// Stats panel renderer

// ---------------------------------------------------------------------------

async function runStatsScene() {

const text = await fetchTextFile('stats');

const lines = parseLines(text);

let html = '';

styleState.groups = [];

styleState.colors = {};

styleState.icons = {};



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

// Expands to one *stat row for every *create_stat entry in startup.txt.

// This means you only define your stats in startup.txt — stats.txt just

// needs a single *stat_registered line where you want them to appear.

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

const icon = styleState.icons[e.key] ?? '';

const labelHtml = icon ? `${icon} ${e.label}` : e.label;

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

// Inline level-up block — injected into the narrative scroll in reading order

// ---------------------------------------------------------------------------

function showInlineLevelUp() {

pendingLevelUpDisplay = false; // consume the flag immediately



const keys = getAllocatableStatKeys();

const labelMap = Object.fromEntries(statRegistry.map(({ key, label }) => [key, label]));

const alloc = Object.fromEntries(keys.map(k => [k, 0]));



// Wrapper block injected before #choice-area, just like addSystem()

const block = document.createElement('div');

block.className = 'levelup-inline-block';

block.style.animationDelay = `${delayIndex * 80}ms`;

delayIndex += 1;

dom.narrativeContent.insertBefore(block, dom.choiceArea);



// Disable any choice buttons already in the DOM (may be empty if choices

// haven't rendered yet — renderChoices will handle that case via

// pendingStatPoints > 0 check).

dom.choiceArea.querySelectorAll('button').forEach(b => {

if (!b.dataset.unselectable) b.disabled = true;

});

// Only add overlay if choice buttons already exist; otherwise renderChoices

// will add it when the buttons are created.

if (dom.choiceArea.querySelector('button')) {

const choiceOverlay = document.createElement('div');

choiceOverlay.className = 'levelup-choice-overlay';

choiceOverlay.innerHTML = `<span>↑ Allocate your stat points before continuing</span>`;

dom.choiceArea.appendChild(choiceOverlay);

}



const render = () => {

const spent = Object.values(alloc).reduce((a, b) => a + b, 0);

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

<button class="alloc-btn" data-op="plus" data-k="${k}" ${remain <= 0 ? 'disabled' : ''}>+</button>

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



// +/− buttons

block.querySelectorAll('.alloc-btn').forEach(btn => {

btn.onclick = () => {

const key = btn.dataset.k;

const spent2 = Object.values(alloc).reduce((a, b) => a + b, 0);

if (btn.dataset.op === 'plus' && spent2 < pendingStatPoints) alloc[key] += 1;

if (btn.dataset.op === 'minus' && alloc[key] > 0) alloc[key] -= 1;

render();

};

});



// Confirm button — only fires when all points have been spent

block.querySelector('[data-confirm]').onclick = () => {

const spent = Object.values(alloc).reduce((a, b) => a + b, 0);

if (spent < pendingStatPoints) return; // hard block — must spend all points first



// Apply allocations

Object.entries(alloc).forEach(([k, v]) => {

playerState[k] = Number(playerState[k] || 0) + v;

});

pendingStatPoints = 0;



// Replace the interactive block with a compact summary line

block.innerHTML = `

<span class="system-block-label">[ LEVEL UP ]</span>

<span class="system-block-text levelup-confirmed-text">

Level ${playerState.level} reached — stats allocated.

</span>`;

block.classList.add('levelup-inline-block--confirmed');



// Remove the overlay and re-enable selectable choice buttons

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

dom.endingTitle.textContent = title;

dom.endingContent.textContent = subtitle;

dom.endingStats.innerHTML = `Level: ${playerState.level || 0}<br>XP: ${playerState.xp || 0}<br>Class: ${playerState.class_name || 'Unclassed'}`;

dom.endingActionBtn.textContent = 'Play Again';

dom.endingActionBtn.onclick = () => location.reload();

dom.endingOverlay.classList.remove('hidden');

}



function resetGame() { location.reload(); }



// ---------------------------------------------------------------------------

// Test accessor — returns live references to internal state objects.

// Used by the automated test harness (test_phase*.mjs). No-op in production

// since nothing calls this during normal gameplay.

// ---------------------------------------------------------------------------

function getEngineState() {

return { playerState, tempState, statRegistry, startup };

}



// ---------------------------------------------------------------------------

// UI wiring

// ---------------------------------------------------------------------------

function wireUI() {

dom.statusToggle.addEventListener('click', () => {

// Use the return value of toggle as the single source of truth so the two
// classes can never fall out of sync with each other.
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

if (confirm('Restart from the beginning?')) resetGame();

});

}



// ---------------------------------------------------------------------------

// Boot

// ---------------------------------------------------------------------------

async function boot() {

wireUI();

try {

await parseStartup();

await runStatsScene();

await gotoScene(startup.sceneList[0] || 'prologue');

} catch (err) {

showEngineError(`Boot failed: ${err.message}`);

}

}



document.addEventListener('DOMContentLoaded', boot);
