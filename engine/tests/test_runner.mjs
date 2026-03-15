// ---------------------------------------------------------------------------
// tests/test_runner.mjs — Automated test suite for System Awakening engine
//
// Tests all pure logic modules: expression evaluator, parser, inventory,
// leveling, skills, and journal. No browser or DOM required.
//
// Usage: node tests/test_runner.mjs
//
// Each test group sets up minimal state, runs assertions, and reports
// pass/fail. The script exits with code 1 if any test fails.
//
// NOTE: This must be run from the repo root so relative imports resolve.
// The modules import from each other using their real relative paths.
//
// Bug fix tests added:
//   BUG-01 — health supports string OR numeric rewards
//   BUG-03 — *set arithmetic shorthand normalises -0 to 0
//   BUG-06 — malformed *selectable_if captured by showEngineError callback
//   BUG-07 — parseInventoryUpdateText accepts lowercase item names
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Minimal DOM shim — enough for modules that reference playerState but don't
// actually touch DOM in the code paths we test.
// ---------------------------------------------------------------------------
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    getElementById: () => null,
    createElement:  () => ({ className: '', style: {}, innerHTML: '', appendChild: () => {}, addEventListener: () => {} }),
    addEventListener: () => {},
    activeElement: null,
  };
  globalThis.window = { innerWidth: 1024 };
  globalThis.localStorage = {
    _data: {},
    getItem(k) { return this._data[k] ?? null; },
    setItem(k, v) { this._data[k] = v; },
    removeItem(k) { delete this._data[k]; },
  };
}

// ---------------------------------------------------------------------------
// Test runner scaffolding
// ---------------------------------------------------------------------------
let _passed = 0;
let _failed = 0;
let _group  = '';

function group(name) {
  _group = name;
  console.log(`\n── ${name}`);
}

function assert(condition, label) {
  if (condition) {
    _passed++;
    console.log(`  ✓ ${label}`);
  } else {
    _failed++;
    console.error(`  ✗ ${label}`);
  }
}

function assertEq(actual, expected, label) {
  const ok = Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    _passed++;
    console.log(`  ✓ ${label}`);
  } else {
    _failed++;
    console.error(`  ✗ ${label}  →  got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

function assertDeepEq(actual, expected, label) {
  assertEq(JSON.stringify(actual), JSON.stringify(expected), label);
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import {
  playerState, tempState, setPlayerState, setTempState,
  normalizeKey, setVar, setStatClamped, declareTemp,
  setStatRegistry, statRegistry,
  sessionState, clearSessionState, patchSessionState,
  setCurrentScene, parseStartup,
  pendingStatPoints, setPendingStatPoints, setPendingLevelUpDisplay, setPendingLevelUpCount,
} from '../engine/core/state.js';

import { evalValue } from '../engine/core/expression.js';
import { parseLines, indexLabels, parseChoice, parseSystemBlock } from '../engine/core/parser.js';
import { addInventoryItem, removeInventoryItem, itemBaseName, parseInventoryUpdateText } from '../engine/systems/inventory.js';
import { checkAndApplyLevelUp, applySystemRewards, getAllocatableStatKeys } from '../engine/systems/leveling.js';
import { importSaveFromJSON, SAVE_VERSION, buildSavePayload, loadSaveFromSlot } from '../engine/systems/saves.js';

// Skills and journal need dynamic import because they depend on state being set up
const { skillRegistry, parseSkills, playerHasSkill, grantSkill, revokeSkill, purchaseSkill } = await import('../engine/systems/skills.js');
const { addJournalEntry, getJournalEntries, getAchievements } = await import('../engine/systems/journal.js');

// ---------------------------------------------------------------------------
// Helper: reset state to clean defaults before each test group
// ---------------------------------------------------------------------------
function resetState() {
  setPlayerState({
    first_name: 'Test', last_name: 'Player', pronouns: 'they/them',
    class_name: 'Warrior', level: 1, xp: 0, xp_to_next: 1000,
    xp_up_mult: 1.2, lvl_up_stat_gain: 2, lvl_up_skill_gain: 1,
    skill_points: 0, health: 'Healthy', mana: 100, max_mana: 100,
    body: 10, mind: 10, spirit: 10, social: 10,
    inventory: [], skills: [], journal: [],
    loop_counter: 0,
  });
  setTempState({});
  setStatRegistry([
    { key: 'body',   label: 'Body',   defaultVal: 10 },
    { key: 'mind',   label: 'Mind',   defaultVal: 10 },
    { key: 'spirit', label: 'Spirit', defaultVal: 10 },
    { key: 'social', label: 'Social', defaultVal: 10 },
  ]);
}

// ===========================================================================
// TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
group('Expression evaluator — literals and arithmetic');
// ---------------------------------------------------------------------------
resetState();

assertEq(evalValue('42'), 42, 'integer literal');
assertEq(evalValue('3.14'), 3.14, 'float literal');
assertEq(evalValue('"hello"'), 'hello', 'string literal');
assertEq(evalValue('true'), true, 'bool true');
assertEq(evalValue('false'), false, 'bool false');
assertDeepEq(evalValue('[]'), [], 'empty array literal');
assertEq(evalValue('2 + 3'), 5, 'addition');
assertEq(evalValue('10 - 4'), 6, 'subtraction');
assertEq(evalValue('3 * 7'), 21, 'multiplication');
assertEq(evalValue('15 / 3'), 5, 'division');
assertEq(evalValue('2 + 3 * 4'), 14, 'precedence: mul before add');
assertEq(evalValue('(2 + 3) * 4'), 20, 'grouping parens');
assertEq(evalValue('-5'), -5, 'unary minus');
assertEq(evalValue('10 + -3'), 7, 'add negative');

// ---------------------------------------------------------------------------
group('Expression evaluator — comparisons and logic');
// ---------------------------------------------------------------------------
assertEq(evalValue('5 > 3'), true, '5 > 3');
assertEq(evalValue('3 > 5'), false, '3 > 5');
assertEq(evalValue('5 >= 5'), true, '5 >= 5');
assertEq(evalValue('5 = 5'), true, '5 = 5 (loose)');
assertEq(evalValue('5 != 3'), true, '5 != 3');
assertEq(evalValue('true and true'), true, 'true and true');
assertEq(evalValue('true and false'), false, 'true and false');
assertEq(evalValue('false or true'), true, 'false or true');
assertEq(evalValue('not false'), true, 'not false');
assertEq(evalValue('not true'), false, 'not true');
assertEq(evalValue('(1 > 0) and (2 > 1)'), true, 'compound: (1>0) and (2>1)');

// ---------------------------------------------------------------------------
group('Expression evaluator — variable lookup');
// ---------------------------------------------------------------------------
resetState();
playerState.body = 15;
tempState.temp_var = 42;

assertEq(evalValue('body'), 15, 'reads playerState.body');
assertEq(evalValue('temp_var'), 42, 'reads tempState.temp_var (priority)');
assertEq(evalValue('body + 5'), 20, 'arithmetic with variable');
assertEq(evalValue('nonexistent'), 'nonexistent', 'unknown ident → string fallback');

// ---------------------------------------------------------------------------
group('Expression evaluator — built-in functions');
// ---------------------------------------------------------------------------
resetState();

const rnd = evalValue('random(1, 6)');
assert(rnd >= 1 && rnd <= 6, `random(1,6) = ${rnd} is in [1,6]`);

assertEq(evalValue('round(3.7)'), 4, 'round(3.7) = 4');
assertEq(evalValue('floor(3.9)'), 3, 'floor(3.9) = 3');
assertEq(evalValue('ceil(3.1)'), 4, 'ceil(3.1) = 4');
assertEq(evalValue('abs(-7)'), 7, 'abs(-7) = 7');
assertEq(evalValue('min(3, 1, 5)'), 1, 'min(3,1,5) = 1');
assertEq(evalValue('max(3, 1, 5)'), 5, 'max(3,1,5) = 5');
assertEq(evalValue('length("hello")'), 5, 'length("hello") = 5');

playerState.inventory = ['sword', 'shield'];
assertEq(evalValue('length(inventory)'), 2, 'length(inventory) = 2 (array)');

for (let i = 0; i < 20; i++) {
  const v = evalValue('random(1, 100)');
  assert(v >= 1 && v <= 100, `random(1,100) iteration ${i+1}: ${v}`);
}

// ---------------------------------------------------------------------------
group('Parser — parseLines');
// ---------------------------------------------------------------------------
const testScene = `*title Test Scene
*label start

Hello world.
  indented line.

*choice
  #Option A
    You chose A.
  #Option B
    You chose B.`;

const parsed = parseLines(testScene);
assertEq(parsed.length, 11, 'parseLines: correct line count');
assertEq(parsed[0].trimmed, '*title Test Scene', 'line 0 trimmed');
assertEq(parsed[0].indent, 0, 'line 0 indent');
assertEq(parsed[4].trimmed, 'indented line.', 'line 4 trimmed');
assert(parsed[4].indent > 0, 'line 4 has indent');

// ---------------------------------------------------------------------------
group('Parser — indexLabels');
// ---------------------------------------------------------------------------
const labelsCache = new Map();
indexLabels('test', parsed, labelsCache);
const labels = labelsCache.get('test');
assertEq(labels['start'], 1, 'label "start" at line 1');
assertEq(labels['nonexistent'], undefined, 'missing label is undefined');

// ---------------------------------------------------------------------------
group('Parser — parseSystemBlock');
// ---------------------------------------------------------------------------
const sysScene = parseLines(`*system
  XP gained: +500
  +2 to all stats
*end_system`);

const sysParsed = parseSystemBlock(0, { currentLines: sysScene });
assert(sysParsed.ok, 'parseSystemBlock found *end_system');
assertEq(sysParsed.endIp, 4, 'endIp after *end_system');
assert(sysParsed.text.includes('XP gained: +500'), 'text contains XP line');

const sysBroken = parseLines(`*system
  Some text
  More text`);
const sysBrokenParsed = parseSystemBlock(0, { currentLines: sysBroken });
assertEq(sysBrokenParsed.ok, false, 'unclosed system block: ok=false');

// ---------------------------------------------------------------------------
group('Parser — parseChoice');
// ---------------------------------------------------------------------------
const choiceScene = parseLines(`*choice
  #Go left
    You went left.
  #Go right
    You went right.
  *selectable_if (false) #Fly
    You flew.
After choice.`);

const choiceParsed = parseChoice(0, 0, { currentLines: choiceScene, evalValue });
assertEq(choiceParsed.choices.length, 3, '3 options parsed');
assertEq(choiceParsed.choices[0].text, 'Go left', 'option 1 text');
assertEq(choiceParsed.choices[0].selectable, true, 'option 1 selectable');
assertEq(choiceParsed.choices[2].text, 'Fly', 'option 3 text');
assertEq(choiceParsed.choices[2].selectable, false, 'option 3 not selectable (false condition)');

// BUG-06 fix test: malformed *selectable_if should call showEngineError callback
// ---------------------------------------------------------------------------
group('Parser — BUG-06: malformed *selectable_if triggers showEngineError');
// ---------------------------------------------------------------------------
const malformedScene = parseLines(`*choice
  *selectable_if missing_parens_and_hash
    This branch should be skipped.
  #Valid option
    Goes through.`);

let errorCaptured = '';
const malformedParsed = parseChoice(0, 0, {
  currentLines: malformedScene,
  evalValue,
  showEngineError: (msg) => { errorCaptured = msg; },
});
assert(errorCaptured.includes('[parser] Malformed'), 'showEngineError called for malformed *selectable_if');
assertEq(malformedParsed.choices.length, 1, 'malformed option dropped; valid option retained');
assertEq(malformedParsed.choices[0].text, 'Valid option', 'remaining choice is correct');

// ---------------------------------------------------------------------------
group('Inventory — add, remove, stacking');
// ---------------------------------------------------------------------------
resetState();

addInventoryItem('Sword');
assertDeepEq(playerState.inventory, ['Sword'], 'add Sword');

addInventoryItem('Sword');
assertDeepEq(playerState.inventory, ['Sword (2)'], 'stack Sword → (2)');

addInventoryItem('Sword');
assertDeepEq(playerState.inventory, ['Sword (3)'], 'stack Sword → (3)');

addInventoryItem('Shield');
assertDeepEq(playerState.inventory, ['Sword (3)', 'Shield'], 'add Shield');

removeInventoryItem('Sword');
assertDeepEq(playerState.inventory, ['Sword (2)', 'Shield'], 'remove one Sword → (2)');

removeInventoryItem('Sword');
assertDeepEq(playerState.inventory, ['Sword', 'Shield'], 'remove one Sword → unstacked');

removeInventoryItem('Sword');
assertDeepEq(playerState.inventory, ['Shield'], 'remove last Sword');

assertEq(itemBaseName('Healing Potion (5)'), 'Healing Potion', 'itemBaseName strips count');
assertEq(itemBaseName('Simple Key'), 'Simple Key', 'itemBaseName no-op on plain name');

// ---------------------------------------------------------------------------
group('Inventory — parseInventoryUpdateText');
// ---------------------------------------------------------------------------
const invParsed = parseInventoryUpdateText('Inventory updated: Ancient Blade, Crystal Shard');
assertDeepEq(invParsed, ['Ancient Blade', 'Crystal Shard'], 'parses two items');

const invEmpty = parseInventoryUpdateText('Nothing here');
assertDeepEq(invEmpty, [], 'no match returns empty');

// BUG-07 fix test: lowercase item names must now be accepted
// ---------------------------------------------------------------------------
group('Inventory — BUG-07: parseInventoryUpdateText accepts lowercase names');
// ---------------------------------------------------------------------------
const invLower = parseInventoryUpdateText('Inventory updated: rusty dagger, ancient map');
assertDeepEq(invLower, ['rusty dagger', 'ancient map'], 'lowercase item names parsed correctly');

const invMixed = parseInventoryUpdateText('Inventory updated: Iron Shield, lesser potion');
assertDeepEq(invMixed, ['Iron Shield', 'lesser potion'], 'mixed-case items parsed correctly');

// Exclusion list still works
const invExcluded = parseInventoryUpdateText('Inventory updated: assembled');
assertDeepEq(invExcluded, [], 'excluded word "assembled" still filtered out');

// ---------------------------------------------------------------------------
group('Leveling — checkAndApplyLevelUp');
// ---------------------------------------------------------------------------
resetState();

setPendingStatPoints(0);
setPendingLevelUpDisplay(false);
setPendingLevelUpCount(0);

playerState.xp = 1500;  // crosses thresholds: 1000 → 1200 → 1440 (3 level-ups)
let changed = false;
checkAndApplyLevelUp(() => { changed = true; });

assertEq(playerState.level, 4, 'leveled up to 4 (crossed 3 thresholds)');
assertEq(changed, true, 'onChanged callback fired');
assert(playerState.xp_to_next > 1440, 'xp_to_next increased past 1440');
assertEq(playerState.skill_points, 3, '3 skill points awarded (1 per level-up)');

// ---------------------------------------------------------------------------
group('Leveling — applySystemRewards');
// ---------------------------------------------------------------------------
resetState();
setPendingStatPoints(0);

playerState.xp = 0;
applySystemRewards('XP gained: +500', () => {});
assertEq(playerState.xp, 500, 'XP reward applied');

playerState.body = 10;
applySystemRewards('+3 to all stats', () => {});
assertEq(playerState.body, 13, '+3 to all stats applied to body');
assertEq(playerState.mind, 13, '+3 to all stats applied to mind');

applySystemRewards('+50 mana', () => {});
assertEq(playerState.mana, 150, '+50 mana applied');

// Inventory via system rewards
resetState();
applySystemRewards('Inventory updated: Magic Ring', () => {});
assert(playerState.inventory.some(i => itemBaseName(i) === 'Magic Ring'), 'inventory item added via system rewards');

// BUG-01 fix tests: health as string OR number
// ---------------------------------------------------------------------------
group('Leveling — BUG-01: health supports string and numeric rewards');
// ---------------------------------------------------------------------------
resetState();
assertEq(typeof playerState.health, 'string', 'health starts as string "Healthy"');

// First health reward: string → number (SET, not ADD)
applySystemRewards('+100 health', () => {});
assertEq(playerState.health, 100, 'first +health reward sets string health to 100 (not NaN)');
assertEq(typeof playerState.health, 'number', 'health is now a number after first reward');

// Subsequent numeric rewards: ADD
applySystemRewards('+50 health', () => {});
assertEq(playerState.health, 150, 'subsequent +health reward adds to numeric health');

// Health stays numeric through multiple rewards
applySystemRewards('+25 health', () => {});
assertEq(playerState.health, 175, 'third +health reward continues adding correctly');

// String health is preserved when no reward fires
resetState();
assertEq(playerState.health, 'Healthy', 'health reset to "Healthy" (string preserved)');
applySystemRewards('+50 mana', () => {});
assertEq(playerState.health, 'Healthy', 'mana reward does not corrupt string health');

// ---------------------------------------------------------------------------
group('State — setVar and declareTemp');
// ---------------------------------------------------------------------------
resetState();

setVar('*set body 25', evalValue);
assertEq(playerState.body, 25, '*set body 25');

setVar('*set body +5', evalValue);
assertEq(playerState.body, 30, '*set body +5 (arithmetic shorthand)');

declareTemp('*temp myVar 99', evalValue);
assertEq(tempState.myvar, 99, '*temp myVar 99 (normalized key)');

declareTemp('*temp flag true', evalValue);
assertEq(tempState.flag, true, '*temp flag true');

// BUG-03 fix test: *set arithmetic shorthand must not store -0
// ---------------------------------------------------------------------------
group('State — BUG-03: *set normalises -0 to 0');
// ---------------------------------------------------------------------------
resetState();
playerState.body = 0;
setVar('*set body - 0', evalValue);
const bodyVal = playerState.body;
// Object.is(-0, 0) is false; JSON.stringify(-0) === "0" so test both
assert(bodyVal === 0, '*set body - 0 stores 0, not -0');
assert(!Object.is(bodyVal, -0), '*set body - 0 does not store negative zero');

// ---------------------------------------------------------------------------
group('State — normalizeKey');
// ---------------------------------------------------------------------------
assertEq(normalizeKey('  MyVar  '), 'myvar', 'normalizeKey trims and lowercases');
assertEq(normalizeKey('UPPER'), 'upper', 'normalizeKey uppercases');

// ---------------------------------------------------------------------------
group('Skills — grant, revoke, purchase, hasSkill');
// ---------------------------------------------------------------------------
resetState();

assert(!playerHasSkill('blade_dancer'), 'does not have blade_dancer initially');

grantSkill('blade_dancer');
assert(playerHasSkill('blade_dancer'), 'has blade_dancer after grant');
assertDeepEq(playerState.skills, ['blade_dancer'], 'skills array contains blade_dancer');

grantSkill('blade_dancer');  // duplicate grant
assertDeepEq(playerState.skills, ['blade_dancer'], 'duplicate grant is no-op');

revokeSkill('blade_dancer');
assert(!playerHasSkill('blade_dancer'), 'blade_dancer revoked');
assertDeepEq(playerState.skills, [], 'skills array empty after revoke');

const { skillRegistry: sr } = await import('../engine/systems/skills.js');
sr.push({ key: 'test_skill', label: 'Test Skill', spCost: 3, description: 'A test.' });

playerState.skill_points = 5;
const bought = purchaseSkill('test_skill');
assert(bought, 'purchaseSkill returns true');
assert(playerHasSkill('test_skill'), 'has test_skill after purchase');
assertEq(playerState.skill_points, 2, 'SP deducted (5 - 3 = 2)');

const buyAgain = purchaseSkill('test_skill');
assert(!buyAgain, 'cannot buy already-owned skill');

playerState.skill_points = 0;
sr.push({ key: 'expensive', label: 'Expensive', spCost: 10, description: 'Costly.' });
const cantAfford = purchaseSkill('expensive');
assert(!cantAfford, 'cannot afford skill with 0 SP');

// ---------------------------------------------------------------------------
group('Journal — entries and achievements');
// ---------------------------------------------------------------------------
resetState();

addJournalEntry('Found a hidden passage.', 'entry');
addJournalEntry('Defeated the guardian.', 'achievement');
addJournalEntry('Reached the throne room.', 'entry');

const journal = getJournalEntries();
assertEq(journal.length, 3, '3 journal entries');
assertEq(journal[0].text, 'Found a hidden passage.', 'first entry text');
assertEq(journal[1].type, 'achievement', 'second entry is achievement');

const achievements = getAchievements();
assertEq(achievements.length, 1, '1 achievement');
assertEq(achievements[0].text, 'Defeated the guardian.', 'achievement text');

// ===========================================================================
// ENHANCEMENT TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
group('ENH-02 — Journal deduplication (unique flag)');
// ---------------------------------------------------------------------------
resetState();

// Non-unique inserts always
const r1 = addJournalEntry('Found cache.', 'entry');
const r2 = addJournalEntry('Found cache.', 'entry');
assertEq(r1, true,  'non-unique insert 1 returns true');
assertEq(r2, true,  'non-unique insert 2 returns true (no dedup)');
assertEq(playerState.journal.length, 2, 'non-unique: both entries stored');

resetState();

// Unique deduplicates same text+type
const u1 = addJournalEntry('Discovered shrine.', 'entry', true);
const u2 = addJournalEntry('Discovered shrine.', 'entry', true);
const u3 = addJournalEntry('Discovered shrine.', 'entry', true);
assertEq(u1, true,  'unique insert 1 returns true');
assertEq(u2, false, 'unique insert 2 returns false (duplicate)');
assertEq(u3, false, 'unique insert 3 returns false (duplicate)');
assertEq(playerState.journal.length, 1, 'unique: only one entry stored');

// Same text, different type is NOT a duplicate
const ua = addJournalEntry('Discovered shrine.', 'achievement', true);
assertEq(ua, true, 'same text, different type is not a duplicate');
assertEq(playerState.journal.length, 2, 'entry + achievement both stored');

// Non-unique and unique: unique flag deduplicates against ALL existing entries
// (regardless of whether they were inserted with or without the unique flag)
resetState();
addJournalEntry('Event.', 'entry');          // non-unique: always inserts
assertEq(playerState.journal.length, 1, 'non-unique insert stored');
addJournalEntry('Event.', 'entry', true);   // unique: already exists, so deduplicates
assertEq(playerState.journal.length, 1, 'unique call deduplicates against existing non-unique entry');
addJournalEntry('Event.', 'entry', true);   // unique again — still deduplicates
assertEq(playerState.journal.length, 1, 'second unique call also deduplicates');

// ---------------------------------------------------------------------------
group('ENH-03 — Stat clamping (*set_stat)');
// ---------------------------------------------------------------------------

resetState();
playerState.body = 10;

// Clamp max
setStatClamped('*set_stat body +8 max:15', evalValue);
assertEq(playerState.body, 15, '*set_stat +8 clamped to max:15 (10+8=18 → 15)');

// Clamp min
setStatClamped('*set_stat body -20 min:0', evalValue);
assertEq(playerState.body, 0, '*set_stat -20 clamped to min:0 (15-20=-5 → 0)');

// Both bounds
playerState.body = 10;
setStatClamped('*set_stat body +100 min:0 max:30', evalValue);
assertEq(playerState.body, 30, '*set_stat with both bounds clamps correctly');

// Absolute assignment (no arithmetic shorthand)
setStatClamped('*set_stat body 99 max:20', evalValue);
assertEq(playerState.body, 20, '*set_stat absolute assignment clamped to max:20');

// No bounds — behaves like *set
playerState.body = 10;
setStatClamped('*set_stat body +5', evalValue);
assertEq(playerState.body, 15, '*set_stat with no bounds behaves like *set');

// Undeclared var — no-op, no crash
setStatClamped('*set_stat nonexistent +5 max:10', evalValue);
assertEq(playerState.nonexistent, undefined, '*set_stat on undeclared var is a no-op');

// Negative min (below zero)
playerState.body = 5;
setStatClamped('*set_stat body -10 min:-5', evalValue);
assertEq(playerState.body, -5, '*set_stat with negative min clamps to -5');

// ---------------------------------------------------------------------------
group('ENH-04 — Boot warning for missing level-up config');
// ---------------------------------------------------------------------------

// Capture console.warn calls
const warnMessages = [];
const origWarn = console.warn;
console.warn = (...args) => { warnMessages.push(args.join(' ')); origWarn(...args); };

// Startup with all config keys present — no config warning
const fullStartupText = `*create xp_up_mult 1.2
*create lvl_up_stat_gain 2
*create lvl_up_skill_gain 1
*create xp_to_next 1000
*create_stat body "Body" 10
*scene_list
  prologue`;

await parseStartup(async () => fullStartupText, evalValue);
const warnsBefore = warnMessages.length;
const hasConfigWarn = warnMessages.some(m => m.includes('Missing level-up config') || m.includes('missing level-up config'));
assertEq(hasConfigWarn, false, 'no level-up config warning when all keys present');

// Startup missing xp_up_mult — should warn
warnMessages.length = 0;
const missingKeyStartup = `*create lvl_up_stat_gain 2
*create lvl_up_skill_gain 1
*create xp_to_next 1000
*create_stat body "Body" 10
*scene_list
  prologue`;

await parseStartup(async () => missingKeyStartup, evalValue);
const hasMissingWarn = warnMessages.some(m => m.includes('xp_up_mult'));
assert(hasMissingWarn, 'warns about missing xp_up_mult after parseStartup');

// Restore console.warn
console.warn = origWarn;
resetState();

// ---------------------------------------------------------------------------
group('ENH-07 — *flag_check mark-and-test');
// ---------------------------------------------------------------------------

resetState();

// Simulate *flag_check by calling the logic directly
// (interpreter can't run without DOM; we test the state logic directly)

// Manual simulation of the flag_check directive logic
function simulateFlagCheck(flagKey, destKey) {
  const inTemp   = Object.prototype.hasOwnProperty.call(tempState,   flagKey);
  const inPlayer = Object.prototype.hasOwnProperty.call(playerState, flagKey);
  const flagStore = inTemp ? tempState : playerState;

  if (!inTemp && !inPlayer) playerState[flagKey] = false;

  const wasAlreadySet = !!flagStore[flagKey];
  if (!wasAlreadySet) flagStore[flagKey] = true;

  const destInTemp = Object.prototype.hasOwnProperty.call(tempState, destKey);
  if (destInTemp) {
    tempState[destKey] = !wasAlreadySet;
  } else {
    if (!Object.prototype.hasOwnProperty.call(playerState, destKey)) playerState[destKey] = false;
    playerState[destKey] = !wasAlreadySet;
  }
}

simulateFlagCheck('visited_shrine', 'first_visit');
assertEq(playerState.visited_shrine, true, 'flagKey set to true on first call');
assertEq(playerState.first_visit, true,    'destKey is true on first call');

simulateFlagCheck('visited_shrine', 'first_visit');
assertEq(playerState.visited_shrine, true,  'flagKey stays true on second call');
assertEq(playerState.first_visit, false,    'destKey is false on second call');

simulateFlagCheck('visited_shrine', 'first_visit');
assertEq(playerState.first_visit, false, 'destKey remains false on third call');

// Works with tempState dest_var
resetState();
tempState.temp_dest = false;
simulateFlagCheck('seen_boss', 'temp_dest');
assertEq(playerState.seen_boss, true,  'flagKey in playerState');
assertEq(tempState.temp_dest, true,    'destKey in tempState on first call');
simulateFlagCheck('seen_boss', 'temp_dest');
assertEq(tempState.temp_dest, false,   'destKey in tempState false on second call');

// ---------------------------------------------------------------------------
group('ENH-08 — Session state (*persist)');
// ---------------------------------------------------------------------------
resetState();
clearSessionState();

// sessionState is invisible until assigned
assertEq(evalValue('session_var'), 'session_var', 'unknown session var → string fallback before assignment');

// Manual session state simulation (promotion logic)
function simulatePersist(key) {
  if (Object.prototype.hasOwnProperty.call(tempState, key)) {
    patchSessionState({ [key]: tempState[key] });
    delete tempState[key];
  } else if (!Object.prototype.hasOwnProperty.call(sessionState, key)) {
    console.warn(`[test] *persist: "${key}" not in tempState`);
  }
}

// Promote temp var into session
tempState.cutscene_mode = true;
simulatePersist('cutscene_mode');
assertEq(Object.prototype.hasOwnProperty.call(tempState, 'cutscene_mode'), false, 'key removed from tempState after persist');
assertEq(sessionState.cutscene_mode, true, 'key promoted into sessionState');

// evalValue can read it
assertEq(evalValue('cutscene_mode'), true, 'evalValue reads from sessionState');

// tempState takes priority over sessionState
tempState.cutscene_mode = false;
assertEq(evalValue('cutscene_mode'), false, 'tempState shadows sessionState in evalValue');
delete tempState.cutscene_mode;
assertEq(evalValue('cutscene_mode'), true, 'sessionState readable again after temp deleted');

// clearSessionState wipes it
clearSessionState();
assertEq(evalValue('cutscene_mode'), 'cutscene_mode', 'clearSessionState empties session layer');

// playerState still lower priority than both temp and session
playerState.prio_test = 'player';
sessionState.prio_test = 'session';
tempState.prio_test    = 'temp';
assertEq(evalValue('prio_test'), 'temp',    'tempState > sessionState > playerState');
delete tempState.prio_test;
assertEq(evalValue('prio_test'), 'session', 'sessionState > playerState when no temp');
delete sessionState.prio_test;
assertEq(evalValue('prio_test'), 'player',  'playerState used when temp and session absent');

// ---------------------------------------------------------------------------
group('ENH-10 — Save export/import (importSaveFromJSON)');
// ---------------------------------------------------------------------------
// exportSaveSlot triggers a DOM download — skip in Node environment.
// Test importSaveFromJSON (pure logic) thoroughly.

resetState();
playerState.xp = 500;
playerState.level = 2;
// Set currentScene so buildSavePayload gets a valid scene name
setCurrentScene('test_scene');
// Build a valid payload to use as import source
const validPayload = buildSavePayload(1, null, []);

// Valid import
const importResult = importSaveFromJSON(validPayload, 2);
assertEq(importResult.ok, true, 'valid import returns ok:true');
const loaded = loadSaveFromSlot(2);
assert(loaded !== null, 'imported save loadable from target slot');
assertEq(loaded.slot, '2', 'imported save has target slot stamped');
assertEq(loaded.playerState.xp, 500, 'imported playerState.xp preserved');

// Wrong version
const wrongVersion = { ...validPayload, version: SAVE_VERSION - 1 };
const versionResult = importSaveFromJSON(wrongVersion, 1);
assertEq(versionResult.ok, false, 'wrong version import returns ok:false');
assert(versionResult.reason.includes('version mismatch'), 'version mismatch reason returned');

// Missing playerState
const noState = { ...validPayload };
delete noState.playerState;
const noStateResult = importSaveFromJSON(noState, 1);
assertEq(noStateResult.ok, false, 'missing playerState returns ok:false');

// Missing scene
const noScene = { ...validPayload };
delete noScene.scene;
const noSceneResult = importSaveFromJSON(noScene, 1);
assertEq(noSceneResult.ok, false, 'missing scene returns ok:false');

// Non-object input
assertEq(importSaveFromJSON(null, 1).ok,     false, 'null input returns ok:false');
assertEq(importSaveFromJSON('string', 1).ok, false, 'string input returns ok:false');
assertEq(importSaveFromJSON([], 1).ok,       false, 'array input returns ok:false');

// Invalid slot
const badSlot = importSaveFromJSON(validPayload, 99);
assertEq(badSlot.ok, false, 'invalid slot returns ok:false');

// ---------------------------------------------------------------------------
group('ENH-09 — Stat tag extraction in parseChoice');
// ---------------------------------------------------------------------------
const statTagScene = parseLines(`*choice
  #Force the door [Body 15]
    You shoulder it open.
  #Pick the lock [Mind 10]
    You work the tumblers.
  #Wait outside
    You decide to wait.
  *selectable_if (false) #Smash it [Body 20]
    You smash it.`);

const statTagParsed = parseChoice(0, 0, { currentLines: statTagScene, evalValue });

// Text is stripped of the tag
assertEq(statTagParsed.choices[0].text, 'Force the door', 'stat tag stripped from option text');
assertEq(statTagParsed.choices[1].text, 'Pick the lock',  'second stat tag stripped');
assertEq(statTagParsed.choices[2].text, 'Wait outside',    'option without tag unchanged');
assertEq(statTagParsed.choices[3].text, 'Smash it',        'selectable_if option tag stripped');

// statTag object populated correctly
assertEq(statTagParsed.choices[0].statTag?.label,       'Body', 'statTag.label correct');
assertEq(statTagParsed.choices[0].statTag?.requirement, 15,     'statTag.requirement correct');
assertEq(statTagParsed.choices[1].statTag?.label,       'Mind', 'second statTag.label correct');
assertEq(statTagParsed.choices[1].statTag?.requirement, 10,     'second statTag.requirement correct');
assertEq(statTagParsed.choices[2].statTag, null, 'option without tag has null statTag');
assertEq(statTagParsed.choices[3].statTag?.label,       'Body', 'selectable_if statTag.label correct');
assertEq(statTagParsed.choices[3].statTag?.requirement, 20,     'selectable_if statTag.requirement correct');

// Multi-word label
const multiWordScene = parseLines(`*choice
  #Climb the wall [Upper Body Strength 12]
    You haul yourself up.`);
const mwParsed = parseChoice(0, 0, { currentLines: multiWordScene, evalValue });
assertEq(mwParsed.choices[0].text, 'Climb the wall', 'multi-word stat tag: text correct');
assertEq(mwParsed.choices[0].statTag?.label, 'Upper Body Strength', 'multi-word statTag.label correct');
assertEq(mwParsed.choices[0].statTag?.requirement, 12, 'multi-word statTag.requirement correct');

// Tag at start — should NOT match (tag must be at end)
const noTagScene = parseLines(`*choice
  #[Body 10] Force the door
    You push.`);
const noTagParsed = parseChoice(0, 0, { currentLines: noTagScene, evalValue });
// The raw text has a tag at the start — since our regex anchors at the end,
// statTag should be null and text left as-is
assertEq(noTagParsed.choices[0].statTag, null, 'tag at start of text is not extracted');

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n═══════════════════════════════════════════');
console.log(`  ${_passed} passed, ${_failed} failed`);
console.log('═══════════════════════════════════════════\n');

process.exit(_failed > 0 ? 1 : 0);
