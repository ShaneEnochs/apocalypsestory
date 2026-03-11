// tests.js — System Awakening engine test suite
// Run by opening tests.html in a browser (served via HTTP).

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetState(overrides = {}) {
  // Reset all module-level globals that tests may pollute.
  playerState = Object.assign({
    name: 'Alex',
    class_name: 'Unclassed',
    level: 1,
    xp: 0,
    xp_to_next: 100,
    health: 100,
    mana: 100,
    max_mana: 100,
    fortitude: 10,
    perception: 10,
    strength: 10,
    agility: 10,
    magic_power: 10,
    magic_regen: 10,
    inventory: [],
  }, overrides);
  // Reset instruction pointer and related state.
  ip = 0;
  currentLines = [];
  currentScene = null;
  awaitingChoice = null;
  sceneCache.clear();
  labelsCache.clear();
  // Reset stat points counter (module-level let).
  pendingStatPoints = 0;
}

function makeLines(text) {
  return parseLines(text);
}

// ── 1. parseLines ─────────────────────────────────────────────────────────────

describe('parseLines()', () => {
  it('splits on LF newlines', () => {
    const result = parseLines('a\nb\nc');
    expect(result.length).toBe(3);
  });

  it('splits on CRLF newlines', () => {
    const result = parseLines('a\r\nb\r\nc');
    expect(result.length).toBe(3);
  });

  it('returns objects with raw, trimmed, indent fields', () => {
    const [line] = parseLines('  hello');
    expect(line.raw).toBe('  hello');
    expect(line.trimmed).toBe('hello');
    expect(line.indent).toBe(2);
  });

  it('tracks 4-space indentation', () => {
    const [line] = parseLines('    deep');
    expect(line.indent).toBe(4);
  });

  it('empty lines have trimmed="" and indent=0', () => {
    const [line] = parseLines('');
    expect(line.trimmed).toBe('');
    expect(line.indent).toBe(0);
  });

  it('zero-indent line has indent=0', () => {
    const [line] = parseLines('*command');
    expect(line.indent).toBe(0);
  });

  it('preserves raw text exactly', () => {
    const raw = '  *set level 5  ';
    const [line] = parseLines(raw);
    expect(line.raw).toBe(raw);
    expect(line.trimmed).toBe('*set level 5');
  });
});

// ── 2. formatText ─────────────────────────────────────────────────────────────

describe('formatText()', () => {
  beforeEach(() => resetState({ name: 'Alex', class_name: 'Rogue' }));

  it('converts **bold** to <strong>', () => {
    expect(formatText('**bold**')).toBe('<strong>bold</strong>');
  });

  it('converts *italic* to <em>', () => {
    expect(formatText('*italic*')).toBe('<em>italic</em>');
  });

  it('substitutes ${varName} from playerState', () => {
    expect(formatText('Hello ${name}')).toBe('Hello Alex');
  });

  it('returns empty string for undefined variable', () => {
    expect(formatText('${unknown_var}')).toBe('');
  });

  it('handles multiple substitutions in one string', () => {
    const result = formatText('${name} is a ${class_name}');
    expect(result).toBe('Alex is a Rogue');
  });

  it('does not mangle text without special syntax', () => {
    expect(formatText('Plain text.')).toBe('Plain text.');
  });

  it('handles bold and variable together', () => {
    const result = formatText('**${name}**');
    expect(result).toBe('<strong>Alex</strong>');
  });
});

// ── 3. evalValue ──────────────────────────────────────────────────────────────

describe('evalValue()', () => {
  beforeEach(() => resetState({ level: 3, xp: 50, some_flag: true }));

  it('evaluates numeric literals', () => {
    expect(evalValue('42')).toBe(42);
  });

  it('evaluates floating point literals', () => {
    expect(evalValue('3.14')).toBeCloseTo(3.14);
  });

  it('evaluates quoted string literals', () => {
    expect(evalValue('"hello"')).toBe('hello');
  });

  it('evaluates true literal', () => {
    expect(evalValue('true')).toBe(true);
  });

  it('evaluates false literal', () => {
    expect(evalValue('false')).toBe(false);
  });

  it('returns empty array for []', () => {
    const v = evalValue('[]');
    expect(Array.isArray(v)).toBe(true);
    expect(v.length).toBe(0);
  });

  it('looks up variable from playerState', () => {
    expect(evalValue('level')).toBe(3);
  });

  it('evaluates arithmetic with variable', () => {
    expect(evalValue('xp + 10')).toBe(60);
  });

  it('translates "and" to &&', () => {
    expect(evalValue('true and false')).toBe(false);
    expect(evalValue('true and true')).toBe(true);
  });

  it('translates "or" to ||', () => {
    expect(evalValue('false or true')).toBe(true);
    expect(evalValue('false or false')).toBe(false);
  });

  it('translates "not" to !', () => {
    expect(evalValue('not true')).toBe(false);
    expect(evalValue('not false')).toBe(true);
  });

  it('evaluates comparison operator >=', () => {
    expect(evalValue('level >= 3')).toBe(true);
    expect(evalValue('level >= 5')).toBe(false);
  });

  it('evaluates equality with variable', () => {
    expect(evalValue('level == 3')).toBe(true);
    expect(evalValue('level == 99')).toBe(false);
  });

  it('does not mangle operators inside quoted strings', () => {
    // The word "not" inside a string should not be replaced with !
    expect(evalValue('"not this"')).toBe('not this');
  });

  it('does not throw for unknown identifier, returns identifier or empty', () => {
    // Should not throw — unknown vars may resolve as undefined/empty string
    expect(() => evalValue('totally_unknown_var')).not.toThrow();
  });
});

// ── 4. setVar / *set command ───────────────────────────────────────────────────

describe('setVar() — *set command', () => {
  beforeEach(() => resetState({ level: 1, xp: 0, xp_to_next: 100, class_name: 'Unclassed' }));

  it('assigns a numeric value', () => {
    setVar('*set level 5');
    expect(playerState.level).toBe(5);
  });

  it('assigns a string value', () => {
    setVar('*set class_name "Rogue"');
    expect(playerState.class_name).toBe('Rogue');
  });

  it('assigns boolean true', () => {
    setVar('*set some_flag true');
    expect(playerState.some_flag).toBe(true);
  });

  it('adds relative numeric value with + operator', () => {
    playerState.xp = 20;
    setVar('*set xp + 30');
    expect(playerState.xp).toBe(50);
  });

  it('subtracts relative numeric value with - operator', () => {
    playerState.health = 100;
    setVar('*set health - 20');
    expect(playerState.health).toBe(80);
  });

  it('does not crash on malformed command', () => {
    expect(() => setVar('*set')).not.toThrow();
  });
});

// ── 5. *flag command (via executeCurrentLine) ─────────────────────────────────

describe('*flag command', () => {
  beforeEach(() => resetState());

  it('sets the named flag to true', async () => {
    currentLines = makeLines('*flag maya_trust_high');
    ip = 0;
    await executeCurrentLine();
    expect(playerState.maya_trust_high).toBe(true);
  });

  it('setting an already-true flag keeps it true', async () => {
    playerState.team_formed = true;
    currentLines = makeLines('*flag team_formed');
    ip = 0;
    await executeCurrentLine();
    expect(playerState.team_formed).toBe(true);
  });

  it('does not crash with empty key', async () => {
    currentLines = makeLines('*flag ');
    ip = 0;
    await expect(executeCurrentLine()).resolves.not.toThrow();
  });
});

// ── 6. *uppercase / *lowercase ────────────────────────────────────────────────

describe('*uppercase and *lowercase commands', () => {
  beforeEach(() => resetState({ class_name: 'Rogue' }));

  it('*uppercase converts string to upper case', async () => {
    currentLines = makeLines('*uppercase class_name');
    ip = 0;
    await executeCurrentLine();
    expect(playerState.class_name).toBe('ROGUE');
  });

  it('*lowercase converts string to lower case', async () => {
    playerState.class_name = 'ROGUE';
    currentLines = makeLines('*lowercase class_name');
    ip = 0;
    await executeCurrentLine();
    expect(playerState.class_name).toBe('rogue');
  });

  it('*uppercase on non-string does not crash', async () => {
    playerState.level = 5;
    currentLines = makeLines('*uppercase level');
    ip = 0;
    await expect(executeCurrentLine()).resolves.not.toThrow();
    expect(playerState.level).toBe(5); // unchanged
  });
});

// ── 7. applySystemRewards ─────────────────────────────────────────────────────

describe('applySystemRewards()', () => {
  beforeEach(() => resetState({
    xp: 0, xp_to_next: 1000,
    fortitude: 10, perception: 10, strength: 10,
    agility: 10, magic_power: 10, magic_regen: 10,
    max_mana: 100, mana: 100, health: 100,
  }));

  it('parses "XP gained: +35" style and adds to xp', () => {
    applySystemRewards('XP gained: +35');
    expect(playerState.xp).toBe(35);
  });

  it('parses "+100 bonus XP" style and adds to xp', () => {
    applySystemRewards('+100 bonus XP');
    expect(playerState.xp).toBe(100);
  });

  it('accumulates multiple XP mentions', () => {
    applySystemRewards('XP gained: +35\n+50 bonus XP');
    expect(playerState.xp).toBe(85);
  });

  it('parses "+5 fortitude" and adds to stat', () => {
    applySystemRewards('+5 fortitude');
    expect(playerState.fortitude).toBe(15);
  });

  it('parses "+3 to all stats" and adds to all 6 stats', () => {
    applySystemRewards('+3 to all stats');
    expect(playerState.fortitude).toBe(13);
    expect(playerState.perception).toBe(13);
    expect(playerState.strength).toBe(13);
    expect(playerState.agility).toBe(13);
    expect(playerState.magic_power).toBe(13);
    expect(playerState.magic_regen).toBe(13);
  });

  it('parses "+7 magic power"', () => {
    applySystemRewards('+7 magic power');
    expect(playerState.magic_power).toBe(17);
  });

  it('parses "+4 magic regeneration"', () => {
    applySystemRewards('+4 magic regeneration');
    expect(playerState.magic_regen).toBe(14);
  });

  it('parses "+4 magic regen"', () => {
    applySystemRewards('+4 magic regen');
    expect(playerState.magic_regen).toBe(14);
  });

  it('parses "+10 max mana"', () => {
    applySystemRewards('+10 max mana');
    expect(playerState.max_mana).toBe(110);
  });

  it('parses "+5 mana"', () => {
    applySystemRewards('+5 mana');
    expect(playerState.mana).toBe(105);
  });

  it('parses "+8 health"', () => {
    applySystemRewards('+8 health');
    expect(playerState.health).toBe(108);
  });

  it('parses "+6 perception"', () => {
    applySystemRewards('+6 perception');
    expect(playerState.perception).toBe(16);
  });

  it('parses "+3 strength"', () => {
    applySystemRewards('+3 strength');
    expect(playerState.strength).toBe(13);
  });

  it('parses "+2 agility"', () => {
    applySystemRewards('+2 agility');
    expect(playerState.agility).toBe(12);
  });

  it('does not crash on text with no rewards', () => {
    expect(() => applySystemRewards('Just some plain text.')).not.toThrow();
    expect(playerState.xp).toBe(0);
  });

  it('triggers level-up when XP crosses xp_to_next', () => {
    playerState.xp = 0;
    playerState.xp_to_next = 50;
    applySystemRewards('XP gained: +60');
    expect(playerState.level).toBeGreaterThan(1);
  });
});

// ── 8. parseInventoryUpdateText ───────────────────────────────────────────────

describe('parseInventoryUpdateText()', () => {
  it('returns empty array when no "Inventory updated:" line', () => {
    expect(parseInventoryUpdateText('Some other text')).toEqual([]);
  });

  it('returns single item', () => {
    expect(parseInventoryUpdateText('Inventory updated: Knife')).toEqual(['Knife']);
  });

  it('returns multiple items split by comma', () => {
    const result = parseInventoryUpdateText('Inventory updated: Knife, Bandage, Rope');
    expect(result).toEqual(['Knife', 'Bandage', 'Rope']);
  });

  it('strips trailing period from item', () => {
    expect(parseInventoryUpdateText('Inventory updated: Knife.')).toEqual(['Knife']);
  });

  it('ignores aggregate phrase "mixed survival kit assembled"', () => {
    expect(parseInventoryUpdateText('Inventory updated: mixed survival kit assembled.')).toEqual([]);
  });

  it('ignores "medical supplies acquired"', () => {
    expect(parseInventoryUpdateText('Inventory updated: medical supplies acquired.')).toEqual([]);
  });

  it('ignores "ritual components secured"', () => {
    expect(parseInventoryUpdateText('Inventory updated: ritual components secured.')).toEqual([]);
  });

  it('is case-insensitive for "Inventory updated:"', () => {
    const result = parseInventoryUpdateText('INVENTORY UPDATED: Sword');
    expect(result).toEqual(['Sword']);
  });
});

// ── 9. addInventoryItem ───────────────────────────────────────────────────────

describe('addInventoryItem()', () => {
  beforeEach(() => resetState({ inventory: [] }));

  it('adds item and returns true', () => {
    expect(addInventoryItem('Knife')).toBe(true);
    expect(playerState.inventory).toContain('Knife');
  });

  it('returns false on duplicate add', () => {
    addInventoryItem('Knife');
    expect(addInventoryItem('Knife')).toBe(false);
    expect(playerState.inventory.length).toBe(1);
  });

  it('returns false for empty string', () => {
    expect(addInventoryItem('')).toBe(false);
  });

  it('returns false for whitespace-only string', () => {
    expect(addInventoryItem('   ')).toBe(false);
  });

  it('initialises inventory array if it does not exist', () => {
    delete playerState.inventory;
    addInventoryItem('Shield');
    expect(Array.isArray(playerState.inventory)).toBe(true);
    expect(playerState.inventory).toContain('Shield');
  });

  it('trims whitespace from item name', () => {
    addInventoryItem('  Sword  ');
    expect(playerState.inventory).toContain('Sword');
  });
});

// ── 10. checkAndApplyLevelUp ──────────────────────────────────────────────────

describe('checkAndApplyLevelUp()', () => {
  beforeEach(() => resetState({ level: 1, xp: 0, xp_to_next: 100 }));

  it('does not level up when xp < xp_to_next', () => {
    playerState.xp = 99;
    checkAndApplyLevelUp();
    expect(playerState.level).toBe(1);
  });

  it('levels up when xp === xp_to_next', () => {
    playerState.xp = 100;
    checkAndApplyLevelUp();
    expect(playerState.level).toBe(2);
  });

  it('xp_to_next scales by floor(old * 2.2)', () => {
    playerState.xp = 100;
    const expected = Math.floor(100 * 2.2);
    checkAndApplyLevelUp();
    expect(playerState.xp_to_next).toBe(expected);
  });

  it('grants 5 pendingStatPoints per level', () => {
    pendingStatPoints = 0;
    playerState.xp = 100;
    checkAndApplyLevelUp();
    expect(pendingStatPoints).toBe(5);
  });

  it('applies multiple level-ups in one call when xp far exceeds threshold', () => {
    playerState.xp = 10000;
    playerState.xp_to_next = 100;
    checkAndApplyLevelUp();
    expect(playerState.level).toBeGreaterThan(2);
    expect(pendingStatPoints).toBeGreaterThanOrEqual(10); // at least 2 levels × 5 pts
  });

  it('does nothing when xp_to_next is 0', () => {
    playerState.xp_to_next = 0;
    playerState.xp = 999;
    checkAndApplyLevelUp();
    expect(playerState.level).toBe(1); // unchanged
  });
});

// ── 11. indexLabels ───────────────────────────────────────────────────────────

describe('indexLabels()', () => {
  it('stores label name → line index in labelsCache', () => {
    const lines = makeLines('*label intro\nsome text\n*label fight');
    indexLabels('test_scene', lines);
    const map = labelsCache.get('test_scene');
    expect(map['intro']).toBe(0);
    expect(map['fight']).toBe(2);
  });

  it('indexes multiple labels in same scene', () => {
    const lines = makeLines('*label a\n*label b\n*label c');
    indexLabels('multi', lines);
    const map = labelsCache.get('multi');
    expect(Object.keys(map).length).toBe(3);
  });

  it('ignores non-label lines', () => {
    const lines = makeLines('some text\n*set level 5\n*label only_one');
    indexLabels('mixed', lines);
    const map = labelsCache.get('mixed');
    expect(Object.keys(map)).toEqual(['only_one']);
  });

  it('captures label names with hyphens and underscores', () => {
    const lines = makeLines('*label end_game\n*label bad-end');
    indexLabels('hyphen_scene', lines);
    const map = labelsCache.get('hyphen_scene');
    expect(map['end_game']).toBeDefined();
    expect(map['bad-end']).toBeDefined();
  });
});

// ── 12. findBlockEnd ──────────────────────────────────────────────────────────

describe('findBlockEnd()', () => {
  beforeEach(() => resetState());

  it('returns index of first non-blank line at or below parent indent', () => {
    currentLines = makeLines('*if true\n  body line\noutside');
    // from index 1 (body), parent indent is 0
    expect(findBlockEnd(1, 0)).toBe(2);
  });

  it('skips blank lines inside block', () => {
    currentLines = makeLines('*if true\n  line1\n\n  line2\noutside');
    // from index 1, parent indent 0 — should find 'outside' at index 4
    expect(findBlockEnd(1, 0)).toBe(4);
  });

  it('returns currentLines.length if no end found', () => {
    currentLines = makeLines('  line1\n  line2');
    expect(findBlockEnd(0, -1)).toBe(currentLines.length);
  });
});

// ── 13. findIfChainEnd ────────────────────────────────────────────────────────

describe('findIfChainEnd()', () => {
  beforeEach(() => resetState());

  it('stops at first line with indent less than chain indent', () => {
    currentLines = makeLines('*if true\n  body\noutside');
    // chain indent = 0
    expect(findIfChainEnd(0, 0)).toBe(2);
  });

  it('skips *elseif and *else at same indent', () => {
    const text = '*if false\n  body1\n*elseif true\n  body2\n*else\n  body3\noutside';
    currentLines = makeLines(text);
    const end = findIfChainEnd(0, 0);
    expect(end).toBe(6); // 'outside' is index 6
  });

  it('stops at same-indent non-chain keyword', () => {
    const text = '*if true\n  body\n*choice\n  #option';
    currentLines = makeLines(text);
    const end = findIfChainEnd(0, 0);
    expect(end).toBe(2);
  });
});

// ── 14. evaluateCondition ─────────────────────────────────────────────────────

describe('evaluateCondition()', () => {
  beforeEach(() => resetState({ level: 3, some_flag: true }));

  it('evaluates *if condition returning true', () => {
    expect(evaluateCondition('*if true')).toBe(true);
  });

  it('evaluates *if condition returning false', () => {
    expect(evaluateCondition('*if false')).toBe(false);
  });

  it('evaluates *elseif prefix', () => {
    expect(evaluateCondition('*elseif true')).toBe(true);
  });

  it('evaluates variable condition', () => {
    expect(evaluateCondition('*if level >= 3')).toBe(true);
    expect(evaluateCondition('*if level >= 10')).toBe(false);
  });

  it('evaluates flag condition', () => {
    expect(evaluateCondition('*if some_flag')).toBe(true);
  });

  it('strips surrounding parentheses', () => {
    expect(evaluateCondition('*if (true)')).toBe(true);
  });
});

// ── 15. parseChoice ───────────────────────────────────────────────────────────

describe('parseChoice()', () => {
  beforeEach(() => resetState({ level: 3 }));

  it('parses two basic choices', () => {
    const text = '*choice\n  #Option A\n    Go A.\n  #Option B\n    Go B.';
    currentLines = makeLines(text);
    const result = parseChoice(0, 0);
    expect(result.choices.length).toBe(2);
    expect(result.choices[0].text).toBe('Option A');
    expect(result.choices[1].text).toBe('Option B');
  });

  it('choices are selectable by default', () => {
    const text = '*choice\n  #Option\n    body';
    currentLines = makeLines(text);
    const result = parseChoice(0, 0);
    expect(result.choices[0].selectable).toBe(true);
  });

  it('*selectable_if with false condition creates disabled choice', () => {
    playerState.level = 1;
    const text = '*choice\n  *selectable_if (level >= 5) #Locked Option\n    body';
    currentLines = makeLines(text);
    const result = parseChoice(0, 0);
    expect(result.choices[0].selectable).toBe(false);
  });

  it('*selectable_if with true condition creates enabled choice', () => {
    playerState.level = 10;
    const text = '*choice\n  *selectable_if (level >= 5) #Unlocked\n    body';
    currentLines = makeLines(text);
    const result = parseChoice(0, 0);
    expect(result.choices[0].selectable).toBe(true);
  });

  it('choice start/end correctly bracket the body', () => {
    const text = '*choice\n  #Option A\n    line1\n    line2\n  #Option B\n    line3';
    currentLines = makeLines(text);
    const result = parseChoice(0, 0);
    const choiceA = result.choices[0];
    // Body of Option A is lines 2 and 3
    expect(choiceA.start).toBe(2);
    expect(choiceA.end).toBe(4);
  });
});

// ── 16. parseSystemBlock ──────────────────────────────────────────────────────

describe('parseSystemBlock()', () => {
  beforeEach(() => resetState());

  it('reads lines until *end_system and returns joined text', () => {
    const text = '*system\n  Line one.\n  Line two.\n*end_system\nafter';
    currentLines = makeLines(text);
    const result = parseSystemBlock(0);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Line one.');
    expect(result.text).toContain('Line two.');
  });

  it('endIp points to line after *end_system', () => {
    const text = '*system\n  body\n*end_system\nafter';
    currentLines = makeLines(text);
    const result = parseSystemBlock(0);
    expect(result.endIp).toBe(3); // 'after' is line 3
  });

  it('returns ok=false when *end_system is missing', () => {
    currentLines = makeLines('*system\n  body line');
    const result = parseSystemBlock(0);
    expect(result.ok).toBe(false);
  });
});

// ── 17. fetchTextFile ─────────────────────────────────────────────────────────

describe('fetchTextFile()', () => {
  beforeEach(() => {
    sceneCache.clear();
    window._mockFetchCalls = [];
  });

  it('appends .txt to bare name', async () => {
    await fetchTextFile('startup');
    expect(window._mockFetchCalls.some(u => u === 'startup.txt')).toBe(true);
  });

  it('does not double-append .txt when already present', async () => {
    await fetchTextFile('startup.txt');
    expect(window._mockFetchCalls.every(u => u === 'startup.txt')).toBe(true);
  });

  it('returns cached result on second call (only one fetch call)', async () => {
    await fetchTextFile('startup');
    window._mockFetchCalls = []; // reset counter
    await fetchTextFile('startup');
    expect(window._mockFetchCalls.length).toBe(0);
  });

  it('throws an error on non-ok response', async () => {
    await expectAsync(fetchTextFile('nonexistent_file')).toBeRejected();
  });
});

// ── 18. showLevelUpOverlay ────────────────────────────────────────────────────

describe('showLevelUpOverlay()', () => {
  beforeEach(() => {
    resetState({ level: 2, fortitude: 10, perception: 10, strength: 10,
                 agility: 10, magic_power: 10, magic_regen: 10 });
    pendingStatPoints = 5;
    dom.levelupOverlay.classList.add('hidden');
    dom.levelupContent.innerHTML = '';
  });

  it('removes hidden class from overlay', () => {
    showLevelUpOverlay();
    expect(dom.levelupOverlay.classList.contains('hidden')).toBe(false);
  });

  it('renders the current level in the overlay content', () => {
    showLevelUpOverlay();
    expect(dom.levelupContent.innerHTML).toContain('Level 2');
  });

  it('shows remaining stat points count', () => {
    showLevelUpOverlay();
    expect(dom.levelupContent.innerHTML).toContain('5');
  });

  it('plus buttons are disabled when no points remain', () => {
    pendingStatPoints = 0;
    showLevelUpOverlay();
    const plusBtns = dom.levelupContent.querySelectorAll('.alloc-btn[data-op="plus"]');
    plusBtns.forEach(btn => expect(btn.disabled).toBe(true));
  });

  it('minus buttons are disabled when allocation for stat is 0', () => {
    showLevelUpOverlay();
    const minusBtns = dom.levelupContent.querySelectorAll('.alloc-btn[data-op="minus"]');
    minusBtns.forEach(btn => expect(btn.disabled).toBe(true));
  });

  it('clicking confirm applies allocation to playerState and clears pendingStatPoints', () => {
    pendingStatPoints = 5;
    showLevelUpOverlay();
    // Allocate all 5 points to fortitude
    const fortPlusBtn = dom.levelupContent.querySelector('.alloc-btn[data-op="plus"][data-k="fortitude"]');
    for (let i = 0; i < 5; i++) fortPlusBtn.click();
    // Click close/confirm
    dom.levelupClose.click();
    expect(playerState.fortitude).toBe(15);
    expect(pendingStatPoints).toBe(0);
  });

  it('hides overlay on confirm', () => {
    showLevelUpOverlay();
    dom.levelupClose.click();
    expect(dom.levelupOverlay.classList.contains('hidden')).toBe(true);
  });
});

// ── 19. showEndingScreen ──────────────────────────────────────────────────────

describe('showEndingScreen()', () => {
  beforeEach(() => {
    resetState({ level: 5, xp: 300, class_name: 'Rogue' });
    dom.endingOverlay.classList.add('hidden');
  });

  it('sets ending-title text', () => {
    showEndingScreen('The End', 'Your journey is over.');
    expect(dom.endingTitle.textContent).toBe('The End');
  });

  it('sets ending-content text', () => {
    showEndingScreen('Title', 'Your path is complete.');
    expect(dom.endingContent.textContent).toBe('Your path is complete.');
  });

  it('shows level from playerState', () => {
    showEndingScreen('T', 'S');
    expect(dom.endingStats.innerHTML).toContain('5');
  });

  it('shows XP from playerState', () => {
    showEndingScreen('T', 'S');
    expect(dom.endingStats.innerHTML).toContain('300');
  });

  it('shows class name from playerState', () => {
    showEndingScreen('T', 'S');
    expect(dom.endingStats.innerHTML).toContain('Rogue');
  });

  it('removes hidden class from ending overlay', () => {
    showEndingScreen('T', 'S');
    expect(dom.endingOverlay.classList.contains('hidden')).toBe(false);
  });
});

// ── 20. runStatsScene (integration, mocked fetch) ─────────────────────────────

describe('runStatsScene() — integration', () => {
  beforeEach(() => {
    resetState({ name: 'Tester', class_name: 'Mage', level: 3, xp: 50,
                 xp_to_next: 220, health: 80, mana: 130, max_mana: 130,
                 fortitude: 12, perception: 11, strength: 9, agility: 10,
                 magic_power: 15, magic_regen: 12, inventory: [] });
    sceneCache.clear();
  });

  it('renders stat groups as section headers', async () => {
    await runStatsScene();
    expect(dom.statusPanel.innerHTML).toContain('Operative');
    expect(dom.statusPanel.innerHTML).toContain('Progress');
    expect(dom.statusPanel.innerHTML).toContain('Vitals');
    expect(dom.statusPanel.innerHTML).toContain('Attributes');
  });

  it('renders stat values from playerState', async () => {
    await runStatsScene();
    expect(dom.statusPanel.innerHTML).toContain('Tester');
    expect(dom.statusPanel.innerHTML).toContain('Mage');
    expect(dom.statusPanel.innerHTML).toContain('15'); // magic_power
  });

  it('shows "Empty" when inventory is empty', async () => {
    await runStatsScene();
    expect(dom.statusPanel.innerHTML).toContain('Empty');
  });

  it('lists inventory items when present', async () => {
    playerState.inventory = ['Knife', 'Bandage'];
    await runStatsScene();
    expect(dom.statusPanel.innerHTML).toContain('Knife');
    expect(dom.statusPanel.innerHTML).toContain('Bandage');
  });

  it('applies icon prefix for stats with *stat_icon defined', async () => {
    // stats.txt defines *stat_icon name "◈"
    await runStatsScene();
    expect(dom.statusPanel.innerHTML).toContain('◈');
  });

  it('applies color class for stats with *stat_color defined', async () => {
    // stats.txt defines *stat_color level accent-cyan
    await runStatsScene();
    expect(dom.statusPanel.innerHTML).toContain('accent-cyan');
  });
});

// ── 21. parseStartup (integration, mocked fetch) ──────────────────────────────

describe('parseStartup() — integration', () => {
  beforeEach(() => {
    playerState = {};
    startup.sceneList = [];
    sceneCache.clear();
  });

  it('populates playerState from *create commands', async () => {
    await parseStartup();
    expect(playerState.name).toBe('Alex');
    expect(playerState.level).toBe(1);
    expect(playerState.health).toBe(100);
  });

  it('populates startup.sceneList from *scene_list block', async () => {
    await parseStartup();
    expect(startup.sceneList.length).toBeGreaterThan(0);
    expect(startup.sceneList[0]).toBe('prologue');
  });

  it('initialises inventory as empty array', async () => {
    await parseStartup();
    expect(Array.isArray(playerState.inventory)).toBe(true);
    expect(playerState.inventory.length).toBe(0);
  });

  it('handles comments without crashing', async () => {
    window.setMockFile('startup', `// This is a comment
*create level 1
// Another comment
*scene_list
  prologue`);
    await expect(parseStartup()).resolves.not.toThrow();
    sceneCache.clear(); // Restore default mock
    window.setMockFile('startup', `*create name "Alex"
*create class_name "Unclassed"
*create level 1
*create xp 0
*create xp_to_next 100
*create health 100
*create mana 100
*create max_mana 100
*create fortitude 10
*create perception 10
*create strength 10
*create agility 10
*create magic_power 10
*create magic_regen 10
*create inventory []
*scene_list
  prologue`);
  });
});

// ── 22. Full scene execution (integration, mocked fetch) ──────────────────────

describe('Full scene execution — integration', () => {
  beforeEach(async () => {
    resetState({ level: 1, xp: 0, xp_to_next: 100 });
    sceneCache.clear();
    labelsCache.clear();
    // Use default prologue mock with a known structure
    window.setMockFile('prologue', `*title Test Chapter
Hello world.
*choice
  #Option A
    You chose A.
  #Option B
    You chose B.
*label end_label
The end.`);
  });

  it('gotoScene sets chapter title from *title command', async () => {
    await gotoScene('prologue');
    expect(dom.chapterTitle.textContent).toBe('Test Chapter');
  });

  it('narrative paragraphs appear in narrativeContent', async () => {
    await gotoScene('prologue');
    expect(dom.narrativeContent.innerHTML).toContain('Hello world.');
  });

  it('*choice pauses execution and renders choice buttons', async () => {
    await gotoScene('prologue');
    const buttons = dom.choiceArea.querySelectorAll('button');
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain('Option A');
    expect(buttons[1].textContent).toContain('Option B');
  });

  it('awaitingChoice is set after *choice is reached', async () => {
    await gotoScene('prologue');
    expect(awaitingChoice).not.toBeNull();
  });

  it('clicking a choice button executes its block', async () => {
    await gotoScene('prologue');
    const buttons = dom.choiceArea.querySelectorAll('button');
    buttons[0].click();
    // Allow microtasks to process
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dom.narrativeContent.innerHTML).toContain('You chose A.');
  });

  it('*goto navigates to a labeled section within the scene', async () => {
    window.setMockFile('prologue', `*title Nav Test
*goto end_label
Should not appear.
*label end_label
End reached.`);
    sceneCache.clear();
    await gotoScene('prologue');
    expect(dom.narrativeContent.innerHTML).not.toContain('Should not appear.');
    expect(dom.narrativeContent.innerHTML).toContain('End reached.');
  });

  it('*goto_scene loads a different scene', async () => {
    window.setMockFile('second', `*title Second Scene\nSecond scene loaded.`);
    window.setMockFile('prologue', `*goto_scene second`);
    sceneCache.clear();
    await gotoScene('prologue');
    expect(dom.chapterTitle.textContent).toBe('Second Scene');
    expect(dom.narrativeContent.innerHTML).toContain('Second scene loaded.');
  });
});
