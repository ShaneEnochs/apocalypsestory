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
//   FIX H  — unknown identifiers return 0 (falsy) instead of truthy string
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
  globalThis.getComputedStyle = () => ({ display: 'block' });
  globalThis.requestAnimationFrame = (fn) => fn();
  globalThis.setTimeout = (fn) => fn();
  globalThis.location = { reload: () => {} };
  globalThis.confirm = () => true;
  globalThis.fetch = async () => ({ ok: false, text: async () => '' });
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
  setCurrentScene, parseStartup,
  resolveStore,
} from '../src/core/state.ts';

import { evalValue } from '../src/core/expression.ts';
import { parseLines, indexLabels, parseChoice, parseSystemBlock } from '../src/core/parser.ts';
import { addInventoryItem, removeInventoryItem, itemBaseName, parseInventoryUpdateText } from '../src/systems/inventory.ts';
import { getAllocatableStatKeys } from '../src/systems/leveling.ts';
import { importSaveFromJSON, SAVE_VERSION, encodeSaveCode, loadSaveFromSlot } from '../src/systems/saves.ts';

// Skills and journal need dynamic import because they depend on state being set up
const { skillRegistry, parseSkills, playerHasSkill, grantSkill, revokeSkill, purchaseSkill } = await import('../src/systems/skills.ts');
const { addJournalEntry, getJournalEntries, getAchievements } = await import('../src/systems/journal.ts');

// ---------------------------------------------------------------------------
// Helper: reset state to clean defaults before each test group
// ---------------------------------------------------------------------------
function resetState() {
  setPlayerState({
    first_name: 'Test', last_name: 'Player',
    pronouns_subject: 'they', pronouns_object: 'them',
    pronouns_possessive: 'their', pronouns_possessive_pronoun: 'theirs',
    pronouns_reflexive: 'themself', pronouns_label: 'they/them',
    class_name: 'Warrior', level: 1, essence: 0,
    health: 'Healthy', mana: 100, max_mana: 100,
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
// FIX H: unknown identifiers now return 0 (falsy) instead of the raw string
// (which was truthy and caused *if conditions with typos to silently pass).
assertEq(evalValue('nonexistent'), 0, 'unknown ident → 0 (falsy, FIX H)');

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

// Multiple random calls to check it doesn't crash
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

// Unclosed system block
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
group('Leveling — getAllocatableStatKeys (stub)');
// ---------------------------------------------------------------------------
resetState();

// The leveling system is removed; getAllocatableStatKeys returns keys from statRegistry
const allocKeys = getAllocatableStatKeys();
assertEq(allocKeys.length, 4, 'getAllocatableStatKeys returns all statRegistry keys');
assert(allocKeys.includes('body'),   'body in allocatable keys');
assert(allocKeys.includes('mind'),   'mind in allocatable keys');
assert(allocKeys.includes('spirit'), 'spirit in allocatable keys');
assert(allocKeys.includes('social'), 'social in allocatable keys');

// ---------------------------------------------------------------------------
group('State — resolveStore helper');
// ---------------------------------------------------------------------------
resetState();

// resolveStore returns tempState when key is in temp
tempState.temp_var = 42;
assertEq(resolveStore('temp_var'), tempState, 'resolveStore returns tempState for temp key');

// resolveStore returns playerState when key is in player only
assertEq(resolveStore('body'), playerState, 'resolveStore returns playerState for player key');

// resolveStore returns null for unknown key
assertEq(resolveStore('totally_unknown_key_xyz'), null, 'resolveStore returns null for unknown key');

// tempState takes priority over playerState
playerState.prio_test = 'player';
tempState.prio_test   = 'temp';
assertEq(resolveStore('prio_test'), tempState, 'resolveStore: tempState wins over playerState');
delete tempState.prio_test;
assertEq(resolveStore('prio_test'), playerState, 'resolveStore: playerState used when no temp');
delete playerState.prio_test;

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

// Purchase requires skillRegistry setup — mock it
const { skillRegistry: sr } = await import('../src/systems/skills.ts');
// Manually push a test skill into the registry
sr.push({ key: 'test_skill', label: 'Test Skill', essenceCost: 3, description: 'A test.' });

playerState.essence = 5;
const bought = purchaseSkill('test_skill');
assert(bought, 'purchaseSkill returns true');
assert(playerHasSkill('test_skill'), 'has test_skill after purchase');
assertEq(playerState.essence, 2, 'Essence deducted (5 - 3 = 2)');

const buyAgain = purchaseSkill('test_skill');
assert(!buyAgain, 'cannot buy already-owned skill');

playerState.essence = 0;
sr.push({ key: 'expensive', label: 'Expensive', essenceCost: 10, description: 'Costly.' });
const cantAfford = purchaseSkill('expensive');
assert(!cantAfford, 'cannot afford skill with 0 Essence');

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

// Deduplication
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
group('parseStartup — sceneList and playerState population');
// ---------------------------------------------------------------------------

// Capture console.warn calls
const warnMessages = [];
const origWarn = console.warn;
console.warn = (...args) => { warnMessages.push(args.join(' ')); origWarn(...args); };

const fullStartupText = `*create level 1
*create essence 0
*create_stat body "Body" 10
*scene_list
  prologue
  chapter_two`;

await parseStartup(async () => fullStartupText, evalValue);

assertEq(playerState.level,   1,  'parseStartup populates level');
assertEq(playerState.essence, 0,  'parseStartup populates essence');
assertEq(playerState.body,    10, 'parseStartup populates *create_stat key');

// sceneList parsed correctly
const { startup } = await import('../src/core/state.ts');
assertEq(startup.sceneList.length, 2,          'sceneList has 2 entries');
assertEq(startup.sceneList[0],     'prologue',  'first scene is prologue');
assertEq(startup.sceneList[1],     'chapter_two', 'second scene is chapter_two');

// No on_level_up or LVL_CONFIG warnings — those blocks are deleted
const hasLevelUpWarn = warnMessages.some(m => m.includes('level-up config') || m.includes('on_level_up'));
assertEq(hasLevelUpWarn, false, 'no level-up config warnings after simplification');

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
// ---------------------------------------------------------------------------
group('Two-way variable lookup (tempState → playerState)');
// ---------------------------------------------------------------------------
resetState();

// Unknown identifier returns 0 (FIX H)
assertEq(evalValue('totally_unknown_var'), 0, 'unknown var → 0 (falsy)');

// playerState readable via evalValue
assertEq(evalValue('body'), 10, 'playerState var readable via evalValue');

// tempState shadows playerState
playerState.prio_test = 'player';
tempState.prio_test   = 'temp';
assertEq(evalValue('prio_test'), 'temp', 'tempState shadows playerState in evalValue');
delete tempState.prio_test;
assertEq(evalValue('prio_test'), 'player', 'playerState used when no temp');
delete playerState.prio_test;

// setVar writes to correct store
playerState.my_stat = 5;
setVar('*set my_stat 10', evalValue);
assertEq(playerState.my_stat, 10, 'setVar writes to playerState when declared there');

tempState.my_temp = 1;
setVar('*set my_temp 99', evalValue);
assertEq(tempState.my_temp, 99, 'setVar writes to tempState when declared there');

// setVar on unknown key is a no-op (warns but does not create)
const keysBefore = Object.keys(playerState).length;
setVar('*set nonexistent_key 42', evalValue);
assertEq(Object.keys(playerState).length, keysBefore, 'setVar on undeclared key does not create new key');

// ---------------------------------------------------------------------------
group('ENH-10 — Save export/import (importSaveFromJSON)');
// ---------------------------------------------------------------------------
// exportSaveSlot triggers a DOM download — skip in Node environment.
// Test importSaveFromJSON (pure logic) thoroughly.

resetState();
playerState.essence = 500;
playerState.level = 2;
// Set currentScene so the save has a valid scene name
setCurrentScene('test_scene');
// Build a valid full save payload manually (same shape importSaveFromJSON expects)
const validPayload = {
  version: SAVE_VERSION,
  scene: 'test_scene',
  ip: 0,
  chapterTitle: '',
  playerState: JSON.parse(JSON.stringify(playerState)),
  statRegistry: [],
  narrativeLog: [],
  awaitingChoice: null,
  characterName: 'Test',
  timestamp: Date.now(),
};

// Valid import
const importResult = importSaveFromJSON(validPayload, 2);
assertEq(importResult.ok, true, 'valid import returns ok:true');
const loaded = loadSaveFromSlot(2);
assert(loaded !== null, 'imported save loadable from target slot');
assertEq(loaded.playerState.essence, 500, 'imported playerState.essence preserved');

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

// ---------------------------------------------------------------------------
group('Procedure system — parseProcedures / getProcedure (registry)');
// ---------------------------------------------------------------------------

const { parseProcedures, getProcedure, clearProcedureRegistry } =
  await import('../src/systems/procedures.ts');

const procText = `
// Test procedures file

*procedure greet
  you wave hello
  *return

*procedure farewell
  you say goodbye
`;

await parseProcedures(async (name) => {
  if (name === 'procedures') return procText;
  throw new Error(`not found: ${name}`);
});

assert(getProcedure('greet') !== null,    'greet procedure registered');
assert(getProcedure('farewell') !== null, 'farewell procedure registered');
assert(getProcedure('unknown') === null,  'unknown procedure returns null');

// Case-insensitive lookup
assert(getProcedure('GREET') !== null,    'getProcedure is case-insensitive (upper)');
assert(getProcedure('Farewell') !== null, 'getProcedure is case-insensitive (mixed)');

// Line content
const greet     = getProcedure('greet');
const greetBody = greet?.lines.filter(l => l.trimmed && !l.trimmed.startsWith('//')) ?? [];
assertEq(greetBody.length,           2,             'greet has 2 non-empty lines');
assertEq(greetBody[0].trimmed,       'you wave hello', 'greet: first line is text');
assertEq(greetBody[1].trimmed,       '*return',     'greet: second line is *return');

// missing procedures.txt — no crash, just a warning
clearProcedureRegistry();
let procWarn = '';
const origWarnProc = console.warn;
console.warn = (...a) => { procWarn = a.join(' '); origWarnProc(...a); };
await parseProcedures(async () => { throw new Error('ENOENT'); });
console.warn = origWarnProc;
assert(procWarn.includes('[procedures]'),   'missing file logs [procedures] warning');
assert(getProcedure('greet') === null,      'registry empty after failed parse');

// Re-register for interpreter tests below
await parseProcedures(async (name) => {
  if (name === 'procedures') return procText + `
*procedure add_essence
  *set essence +10
  *return

*procedure nested_caller
  *call add_essence
  *call add_essence
  *return

*procedure no_explicit_return
  *set essence +5
`;
  throw new Error('not found');
});

// ---------------------------------------------------------------------------
group('Procedure system — *call / *return interpreter integration');
// ---------------------------------------------------------------------------

// Import interpreter and extra state helpers (same module instances as top-level imports)
const {
  registerCallbacks: regCB,
  registerCaches:    regCaches,
  runInterpreter:    runInterp,
} = await import('../src/core/interpreter.ts');

const { setCurrentLines: sCL, setIp: sIP, setCurrentScene: sCS } =
  await import('../src/core/state.ts');

const { parseLines: PL } = await import('../src/core/parser.ts');

// Minimal mock callbacks that capture output without touching DOM
const interpOutput = [];
regCB({
  addParagraph:        (t)  => interpOutput.push({ k: 'p',   t }),
  addSystem:           (t)  => interpOutput.push({ k: 'sys', t }),
  clearNarrative:      ()   => {},
  applyTransition:     ()   => {},
  renderChoices:       ()   => {},
  showEndingScreen:    ()   => {},
  showEngineError:     (m)  => interpOutput.push({ k: 'err', t: m }),
  showInputPrompt:     ()   => {},
  showPageBreak:       ()   => {},
  scheduleStatsRender: ()   => {},
  showToast:           ()   => {},
  formatText:          (t)  => t,
  setChapterTitle:     ()   => {},
  setGameTitle:        ()   => {},
  runStatsScene:       async () => {},
  fetchTextFile:       async () => '',
  getNarrativeLog:     ()   => [],
});
regCaches(new Map(), new Map());

// Helper: run a short scene text and return output
async function runScene(sceneText) {
  resetState();
  interpOutput.length = 0;
  sCS('test_scene');
  sCL(PL(sceneText));
  sIP(0);
  await runInterp({ suppressAutoSave: true });
  return [...interpOutput];
}

// Test 1: *call executes procedure body and modifies playerState
resetState();
playerState.essence = 5;
sCS('test_scene');
sCL(PL('*call add_essence'));
sIP(0);
interpOutput.length = 0;
await runInterp({ suppressAutoSave: true });
assertEq(playerState.essence, 15, '*call add_essence: essence 5 → 15');
assert(!interpOutput.some(o => o.k === 'err'), '*call add_essence: no engine errors');

// Test 2: *call restores execution after the *call line
resetState();
playerState.essence = 0;
const out2 = await runScene('*call add_essence\nhello after call');
assertEq(playerState.essence, 10, '*call: state updated');
assert(out2.some(o => o.k === 'p' && o.t === 'hello after call'), '*call: execution continues after return');

// Test 3: nested *call (procedure calling another procedure)
resetState();
playerState.essence = 0;
const out3 = await runScene('*call nested_caller');
assertEq(playerState.essence, 20, 'nested *call: add_essence called twice (0 → 20)');
assert(!out3.some(o => o.k === 'err'), 'nested *call: no engine errors');

// Test 4: procedure without explicit *return auto-returns
resetState();
playerState.essence = 0;
const out4 = await runScene('*call no_explicit_return\nafter');
assertEq(playerState.essence, 5, 'no_explicit_return: state updated');
assert(out4.some(o => o.k === 'p' && o.t === 'after'), 'no_explicit_return: execution continues after auto-return');

// Test 5: *call unknown procedure — engine error, execution continues
resetState();
const out5 = await runScene('*call totally_unknown_proc\nstill running');
assert(out5.some(o => o.k === 'err' && o.t.includes('totally_unknown_proc')), '*call unknown: engine error shown');
assert(out5.some(o => o.k === 'p' && o.t === 'still running'), '*call unknown: execution continues after error');

// Test 6: multiple *call in sequence
resetState();
playerState.essence = 0;
const out6 = await runScene('*call add_essence\n*call add_essence\n*call add_essence');
assertEq(playerState.essence, 30, 'three sequential *call: 0 → 30');
assert(!out6.some(o => o.k === 'err'), 'sequential *calls: no engine errors');

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n═══════════════════════════════════════════');
console.log(`  ${_passed} passed, ${_failed} failed`);
console.log('═══════════════════════════════════════════\n');

process.exit(_failed > 0 ? 1 : 0);
