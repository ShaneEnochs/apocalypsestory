// ============================================================
// SYSTEM AWAKENING — engine.js
// Core game engine: state management, rendering, transitions
// ============================================================


// ----------------------------------------------------------
// PLAYER STATE
// ----------------------------------------------------------
const createInitialState = () => ({
  name: "Alex",
  class: null,
  level: 0,
  xp: 0,
  xpToNext: 100,
  health: "Healthy",
  mana: 100,
  maxMana: 100,
  stats: {
    fortitude: 10,
    perception: 10,
    strength: 10,
    agility: 10,
    magicPower: 10,
    magicRegen: 10
  },
  skills: [],
  inventory: [],
  aspects: [],
  flags: {}
});

let playerState = createInitialState();
let currentNodeId = "intro";

// Track previous stat values for change animations
let prevStats = { ...playerState.stats };
let prevLevel = 0;

// ----------------------------------------------------------
// DOM REFERENCES
// ----------------------------------------------------------
const dom = {
  narrativeContent: document.getElementById('narrative-content'),
  choiceArea:       document.getElementById('choice-area'),
  chapterTitle:     document.getElementById('chapter-title'),
  narrativePanel:   document.getElementById('narrative-panel'),

  // Status panel
  statusName:    document.getElementById('status-name'),
  statusClass:   document.getElementById('status-class'),
  statusLevel:   document.getElementById('status-level'),
  statusXP:      document.getElementById('status-xp'),
  xpBarFill:     document.getElementById('xp-bar-fill'),
  statusHP:      document.getElementById('status-hp'),
  statusMana:    document.getElementById('status-mana'),

  statFortitude:   document.getElementById('stat-fortitude'),
  statPerception:  document.getElementById('stat-perception'),
  statStrength:    document.getElementById('stat-strength'),
  statAgility:     document.getElementById('stat-agility'),
  statMagicPower:  document.getElementById('stat-magicPower'),
  statMagicRegen:  document.getElementById('stat-magicRegen'),

  skillsList:     document.getElementById('skills-list'),
  inventoryList:  document.getElementById('inventory-list'),

  // Overlays
  levelupOverlay:  document.getElementById('levelup-overlay'),
  levelupContent:  document.getElementById('levelup-content'),
  levelupClose:    document.getElementById('levelup-close'),
  endingOverlay:   document.getElementById('ending-overlay'),
  endingBox:       document.getElementById('ending-box'),
  endingIcon:      document.getElementById('ending-icon'),
  endingTitle:     document.getElementById('ending-title'),
  endingContent:   document.getElementById('ending-content'),
  endingStats:     document.getElementById('ending-stats'),
  endingActionBtn: document.getElementById('ending-action-btn'),

  // Mobile toggle
  statusToggle:    document.getElementById('status-toggle'),
  statusPanel:     document.getElementById('status-panel')
};

// ----------------------------------------------------------
// RENDER ENGINE
// ----------------------------------------------------------

/**
 * Navigate to a node by ID.
 */
function goToNode(nodeId) {
  const node = storyNodes[nodeId];
  if (!node) {
    console.error(`[Engine] Node not found: "${nodeId}"`);
    return;
  }

  currentNodeId = nodeId;

  // Close mobile status panel on navigation (TD-05 fix)
  if (window.innerWidth <= 768) {
    dom.statusPanel.classList.add('status-hidden');
    dom.statusPanel.classList.remove('status-visible');
  }

  // Snapshot state before onEnter mutations (for diff animations)
  prevStats = { ...playerState.stats };
  prevXP = playerState.xp;
  prevLevel = playerState.level;

  // Run onEnter state mutations
  if (node.onEnter) {
    node.onEnter(playerState);
  }

  // Check for level-up after XP change.
  // If onEnter already hard-set the level (e.g. grinding_montage), prevLevel
  // comparison catches it. Otherwise checkAndApplyLevelUp handles XP threshold.
  const didLevelUp = playerState.level > prevLevel || checkAndApplyLevelUp();

  // Handle ending/death nodes
  if (node.ending) {
    renderContent(node);
    updateStatusPanel(didLevelUp);
    setTimeout(() => showEndingScreen(node), 800);
    return;
  }

  // Normal node
  renderContent(node);
  updateStatusPanel(didLevelUp);
}

/**
 * Check if XP threshold crossed and apply level-up.
 * Returns true if a level-up occurred.
 */
function checkAndApplyLevelUp() {
  if (playerState.xp >= playerState.xpToNext && playerState.level === prevLevel) {
    playerState.level += 1;
    playerState.xpToNext = Math.floor(playerState.xpToNext * 2.2);
    // Note: actual stat/skill points distributed at level-up screen
    return true;
  }
  return false;
}

/**
 * Render the narrative content and choices for a node.
 * Uses a transition fade if not first load.
 */
function renderContent(node) {
  const isFirstRender = dom.narrativeContent.children.length === 0;

  if (!isFirstRender) {
    // Fade out
    dom.narrativePanel.classList.add('transitioning');
    setTimeout(() => {
      dom.narrativePanel.classList.remove('transitioning');
      _doRender(node);
    }, 280);
  } else {
    _doRender(node);
  }
}

function _doRender(node) {
  // Update chapter title
  dom.chapterTitle.textContent = node.title || '—';

  // Clear only the narrative paragraphs/system blocks — leave #choice-area in place
  // (choice-area is now a child of narrative-content, so innerHTML = '' would destroy it)
  Array.from(dom.narrativeContent.children).forEach(el => {
    if (el !== dom.choiceArea) el.remove();
  });
  dom.choiceArea.innerHTML = '';

  // Build text array: combine base text + flagText + class-specific text + afterClassText
  const textItems = buildTextArray(node);

  // Render paragraphs and system blocks with staggered animation
  // Insert before choice-area so text appears above choices
  textItems.forEach((item, index) => {
    const delay = index * 80;
    if (typeof item === 'string') {
      renderParagraph(item, delay);
    } else if (item && item.system) {
      renderSystemBlock(item.system, delay);
    }
  });

  // Scroll to top
  dom.narrativeContent.scrollTop = 0;

  // Render choices (inside choice-area, which is already in the DOM)
  const visibleChoices = (node.choices || []).filter(choice =>
    !choice.condition || choice.condition(playerState)
  );

  visibleChoices.forEach((choice, index) => {
    renderChoiceButton(choice, index, visibleChoices.length);
  });

  // After all staggered animations complete, scroll choices into view
  if (visibleChoices.length > 0) {
    const lastDelay = (textItems.length + visibleChoices.length) * 80 + 400;
    setTimeout(() => {
      dom.choiceArea.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, lastDelay);
  }
}

/**
 * Build the complete text array for a node.
 * Merges: base text → flagText inserts → classText → afterClassText
 *
 * flagText format: [ { condition: (state) => bool, items: [...text] }, ... ]
 * Items are inserted at the end of base text, before classText.
 */
function buildTextArray(node) {
  const items = [...(node.text || [])];

  // Insert flag-conditional paragraphs
  if (node.flagText) {
    node.flagText.forEach(entry => {
      if (!entry.condition || entry.condition(playerState)) {
        items.push(...entry.items);
      }
    });
  }

  // Insert class-specific text after base text + flagText
  if (node.classText && playerState.class && node.classText[playerState.class]) {
    items.push(node.classText[playerState.class]);
  }

  // Append afterClassText
  if (node.afterClassText) {
    items.push(...node.afterClassText);
  }

  return items;
}

/**
 * Render a narrative paragraph. Supports basic markdown-like syntax:
 * *text* → italic/amber, **text** → bold/cyan
 */
function renderParagraph(text, delayMs) {
  const p = document.createElement('p');
  p.className = 'narrative-paragraph';
  p.style.animationDelay = `${delayMs}ms`;
  p.innerHTML = formatText(text);
  // Insert before choice-area so text stays above choices
  dom.narrativeContent.insertBefore(p, dom.choiceArea);
}

/**
 * Render a system message block.
 */
function renderSystemBlock(text, delayMs) {
  const div = document.createElement('div');

  // Detect block type for styling
  const isXP = /xp gained|xp:/i.test(text);
  const isLevelUp = /level up/i.test(text);
  div.className = `system-block${isXP ? ' xp-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;
  div.style.animationDelay = `${delayMs}ms`;

  // Replace [Skill Name] with highlighted spans
  const formatted = text
    .replace(/\[([^\]]+)\]/g, '<span class="sys-highlight">[$1]</span>')
    .replace(/\n/g, '<br>');

  div.innerHTML = formatted;
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
}

/**
 * Render a choice button.
 */
function renderChoiceButton(choice, index, total) {
  const btn = document.createElement('button');
  btn.className = 'choice-btn';
  btn.style.animationDelay = `${(index + 1) * 80}ms`;

  // Inner content
  let html = `<span>${formatText(choice.text)}`;
  if (choice.note) {
    html += `<span class="choice-note">${choice.note}</span>`;
  }
  html += `</span>`;
  btn.innerHTML = html;

  btn.addEventListener('click', () => handleChoice(choice));
  dom.choiceArea.appendChild(btn);
}

/**
 * Handle a choice selection.
 */
function handleChoice(choice) {
  // Disable all choice buttons immediately (prevent double-click)
  dom.choiceArea.querySelectorAll('.choice-btn').forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = '0.4';
  });

  // Run onChoose callback if present
  if (choice.onChoose) {
    choice.onChoose(playerState);
  }

  // Navigate
  setTimeout(() => goToNode(choice.next), 200);
}

/**
 * Convert simple markdown-like syntax to HTML.
 * *text* → <em>, **text** → <strong>
 */
function formatText(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// ----------------------------------------------------------
// STATUS PANEL
// ----------------------------------------------------------

function updateStatusPanel(didLevelUp = false) {
  const s = playerState;

  // Name & class
  dom.statusName.textContent = s.name;
  dom.statusClass.textContent = s.class || 'Unclassed';
  dom.statusClass.className = `status-value status-class-badge${s.class ? ' has-class' : ''}`;

  // Level
  dom.statusLevel.textContent = s.level;

  // XP
  const xpDisplay = `${s.xp} / ${s.xpToNext}`;
  dom.statusXP.textContent = xpDisplay;
  const xpPct = Math.min(100, (s.xp / s.xpToNext) * 100);
  dom.xpBarFill.style.width = `${xpPct}%`;

  // HP & Mana
  dom.statusHP.textContent = s.health;
  dom.statusMana.textContent = `${s.mana} / ${s.maxMana}`;

  // Stats — animate changed values
  const statMap = {
    fortitude:   dom.statFortitude,
    perception:  dom.statPerception,
    strength:    dom.statStrength,
    agility:     dom.statAgility,
    magicPower:  dom.statMagicPower,
    magicRegen:  dom.statMagicRegen
  };

  Object.entries(statMap).forEach(([key, el]) => {
    el.textContent = s.stats[key];
    if (s.stats[key] > prevStats[key]) {
      el.classList.add('increased');
      setTimeout(() => el.classList.remove('increased'), 2000);
    }
  });

  // Skills
  dom.skillsList.innerHTML = '';
  if (s.skills.length === 0) {
    dom.skillsList.innerHTML = '<li class="tag-empty">None</li>';
  } else {
    s.skills.forEach(skill => {
      const li = document.createElement('li');
      li.textContent = skill;
      dom.skillsList.appendChild(li);
    });
  }

  // Inventory
  dom.inventoryList.innerHTML = '';
  if (s.inventory.length === 0) {
    dom.inventoryList.innerHTML = '<li class="tag-empty">Empty</li>';
  } else {
    s.inventory.forEach(item => {
      const li = document.createElement('li');
      li.textContent = item;
      dom.inventoryList.appendChild(li);
    });
  }

  // Trigger level-up overlay if needed
  if (didLevelUp) {
    setTimeout(() => showLevelUpOverlay(), 1200);
  }
}

// ----------------------------------------------------------
// PHASE 4: Interactive Level-Up Stat Allocation
// ----------------------------------------------------------

// Pending points pool (accumulates if multiple level-ups happen)
let pendingStatPoints = 0;
let pendingSkillPoints = 0;
let statAllocations = {};

const STAT_LABELS = {
  fortitude:'Fortitude', perception:'Perception', strength:'Strength',
  agility:'Agility', magicPower:'Mag.Power', magicRegen:'Mag.Regen'
};

function checkAndApplyLevelUp() {
  if (playerState.xp >= playerState.xpToNext && playerState.level === prevLevel) {
    playerState.level += 1;
    playerState.xpToNext = Math.floor(playerState.xpToNext * 2.2);
    pendingStatPoints += 10;
    pendingSkillPoints += 3;
    return true;
  }
  return false;
}


function showLevelUpOverlay() {
  statAllocations = {};
  Object.keys(STAT_LABELS).forEach(k => statAllocations[k] = 0);
  _renderLevelUpContent();
  dom.levelupOverlay.classList.remove('hidden');
}

function _renderLevelUpContent() {
  const s = playerState;
  const spent = Object.values(statAllocations).reduce((a,b)=>a+b, 0);
  const remaining = pendingStatPoints - spent;

  let html = `<div style="color:var(--cyan);margin-bottom:6px;">
    Reached <strong style="font-size:1.1em">Level ${s.level}</strong>
  </div>
  <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--amber);margin-bottom:14px;">
    Stat points to allocate: <strong>${remaining}</strong>
  </div>
  <div class="stat-alloc-grid">`;

  Object.entries(STAT_LABELS).forEach(([key, label]) => {
    const base = s.stats[key];
    const bonus = statAllocations[key] || 0;
    const total = base + bonus;
    html += `<div class="stat-alloc-item${bonus > 0 ? ' selected' : ''}" data-stat="${key}">
      <span class="stat-alloc-name">${label}</span>
      <span class="stat-alloc-val${bonus > 0 ? ' buffed' : ''}">${total}</span>
      ${bonus > 0 ? `<span style="font-size:0.6rem;color:var(--green);display:block;">+${bonus}</span>` : '<span style="font-size:0.6rem;color:transparent;display:block;">+0</span>'}
    </div>`;
  });

  html += `</div>
  <div style="font-size:0.65rem;color:var(--text-faint);margin-top:10px;">
    Click a stat to add a point · Click again to remove
  </div>`;

  dom.levelupContent.innerHTML = html;
  dom.levelupClose.textContent = remaining > 0 ? `Allocate ${remaining} remaining` : 'Confirm & Continue';
  dom.levelupClose.style.opacity = remaining > 0 ? '0.5' : '1';
  dom.levelupClose.style.pointerEvents = remaining > 0 ? 'none' : 'auto';

  dom.levelupContent.querySelectorAll('.stat-alloc-item').forEach(tile => {
    tile.addEventListener('click', () => {
      const key = tile.dataset.stat;
      const curSpent = Object.values(statAllocations).reduce((a,b)=>a+b, 0);
      if (statAllocations[key] > 0) {
        statAllocations[key]--;
      } else if (curSpent < pendingStatPoints) {
        statAllocations[key]++;
      }
      _renderLevelUpContent();
    });
  });
}

dom.levelupClose.addEventListener('click', () => {
  const spent = Object.values(statAllocations).reduce((a,b)=>a+b, 0);
  if (spent < pendingStatPoints) return;
  Object.entries(statAllocations).forEach(([k,v]) => { playerState.stats[k] += v; });
  pendingStatPoints = 0;
  pendingSkillPoints = 0;
  statAllocations = {};
  dom.levelupOverlay.classList.add('hidden');
  updateStatusPanel(false);
});

// ----------------------------------------------------------
// ENDING SCREEN
// ----------------------------------------------------------

function showEndingScreen(node) {
  const isWin = node.ending === 'win';
  const isDeath = node.ending === 'death';
  dom.endingBox.className = 'overlay-box' + (isDeath ? ' death-box' : isWin ? ' ending-box-win' : '');
  dom.endingIcon.textContent = isDeath ? '☠' : '◈';
  dom.endingTitle.textContent = node.endingLabel
    ? 'ENDING: ' + node.endingLabel
    : isDeath ? 'YOU DIED' : 'THE END';
  dom.endingContent.textContent = node.endingSubtitle || (isDeath ? 'Your journey ends here — for now.' : '');

  const s = playerState;
  const trueFlags = Object.keys(s.flags).filter(k => s.flags[k] === true);
  dom.endingStats.innerHTML =
    'Class: ' + (s.class || 'Unknown') + '&nbsp;&nbsp;|&nbsp;&nbsp;Level: ' + s.level + '<br>' +
    'Total XP: ' + s.xp + '<br>' +
    'Skills: ' + (s.skills.join(', ') || 'None') + '<br>' +
    'Milestones: ' + (trueFlags.length ? trueFlags.join(', ') : 'None');

  if (isDeath && node.retryNode) {
    dom.endingActionBtn.textContent = 'Try Again';
    dom.endingActionBtn.onclick = () => { dom.endingOverlay.classList.add('hidden'); goToNode(node.retryNode); };
  } else {
    dom.endingActionBtn.textContent = 'Play Again';
    dom.endingActionBtn.onclick = () => { dom.endingOverlay.classList.add('hidden'); resetGame(); };
  }
  dom.endingOverlay.classList.remove('hidden');
}

// ----------------------------------------------------------
// GAME RESET
// ----------------------------------------------------------

function resetGame() {
  playerState = createInitialState();
  prevStats = { ...playerState.stats };
  prevLevel = 0;
  pendingStatPoints = 0;
  pendingSkillPoints = 0;
  statAllocations = {};
  // Clear paragraphs without destroying the #choice-area child element
  Array.from(dom.narrativeContent.children).forEach(el => {
    if (el !== dom.choiceArea) el.remove();
  });
  dom.choiceArea.innerHTML = '';
  goToNode('intro');
}

// ----------------------------------------------------------
// MOBILE STATUS TOGGLE
// ----------------------------------------------------------
dom.statusToggle.addEventListener('click', () => {
  dom.statusPanel.classList.toggle('status-hidden');
  dom.statusPanel.classList.toggle('status-visible');
});

document.addEventListener('click', (e) => {
  if (window.innerWidth <= 768) {
    if (!dom.statusPanel.contains(e.target) && e.target !== dom.statusToggle) {
      dom.statusPanel.classList.remove('status-visible');
      dom.statusPanel.classList.add('status-hidden');
    }
  }
});

// ----------------------------------------------------------
// RESTART BUTTON
// ----------------------------------------------------------
document.getElementById('restart-btn').addEventListener('click', () => {
  if (confirm('Restart from the beginning? Your progress will be lost.')) resetGame();
});

// ----------------------------------------------------------
// BOOT
// ----------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  updateStatusPanel(false);
  goToNode('intro');
});
