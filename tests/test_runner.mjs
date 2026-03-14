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
    setItem(k, v) { this._data[k] = String(v); },
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
// Test framework — minimal assertion helpers
// ---------------------------------------------------------------------------
let _passed = 0;
let _failed = 0;
let _currentGroup = '';

function group(name) {
  _currentGroup = name;
  console.log(`\n━━━ ${name} ━━━`);
}

function assert(condition, description) {
  if (condition) {
    _passed++;
    console.log(`  ✓ ${description}`);
  } else {
    _failed++;
    console.error(`  ✗ FAIL: ${description}`);
  }
}

function assertEq(actual, expected, description) {
  const eq = actual === expected;
  if (eq) {
    _passed++;
    console.log(`  ✓ ${description}`);
  } else {
    _failed++;
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertDeepEq(actual, expected, description) {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) {
    _passed++;
    console.log(`  ✓ ${description}`);
  } else {
    _failed++;
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Import modules under test
// ---------------------------------------------------------------------------
import {
  playerState, tempState, setPlayerState, setTempState,
  normalizeKey, setVar, declareTemp,
  setStatRegistry, statRegistry,
} from '../engine/core/state.js';

import { evalValue } from '../engine/core/expression.js';
import { parseLines, indexLabels, parseChoice, parseSystemBlock } from '../engine/core/parser.js';
import { addInventoryItem, removeInventoryItem, itemBaseName, parseInventoryUpdateText } from '../engine/systems/inventory.js';
import { checkAndApplyLevelUp, applySystemRewards, getAllocatableStatKeys } from '../engine/systems/leveling.js';

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

// ============================= TESTS ========================================

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

// ---------------------------------------------------------------------------
group('Leveling — checkAndApplyLevelUp');
// ---------------------------------------------------------------------------
resetState();
import { pendingStatPoints, setPendingStatPoints, setPendingLevelUpDisplay, setPendingLevelUpCount } from '../engine/core/state.js';

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

playerState.health = 'Healthy';
applySystemRewards('+50 mana', () => {});
assertEq(playerState.mana, 150, '+50 mana applied');

// Inventory via system rewards
resetState();
applySystemRewards('Inventory updated: Magic Ring', () => {});
assert(playerState.inventory.some(i => itemBaseName(i) === 'Magic Ring'), 'inventory item added via system rewards');

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
const { skillRegistry: sr } = await import('../engine/systems/skills.js');
// Manually push a test skill into the registry
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

// We need a mock evalValue for the parser context
const choiceParsed = parseChoice(0, 0, { currentLines: choiceScene, evalValue });
assertEq(choiceParsed.choices.length, 3, '3 options parsed');
assertEq(choiceParsed.choices[0].text, 'Go left', 'option 1 text');
assertEq(choiceParsed.choices[0].selectable, true, 'option 1 selectable');
assertEq(choiceParsed.choices[2].text, 'Fly', 'option 3 text');
assertEq(choiceParsed.choices[2].selectable, false, 'option 3 not selectable (false condition)');

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n═══════════════════════════════════════════');
console.log(`  ${_passed} passed, ${_failed} failed`);
console.log('═══════════════════════════════════════════\n');

process.exit(_failed > 0 ? 1 : 0);
