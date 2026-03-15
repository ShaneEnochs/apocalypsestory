// ---------------------------------------------------------------------------
// ui/panels.js — Stats panel, level-up allocation, store, ending screen
//
// Phase 3: Added Store system — a full-screen overlay with Skills and Items
// tabs where players spend Essence. Store button appears in the status panel.
//
// FIX #5: All author-controlled strings rendered into innerHTML now pass
//   through escapeHtml() imported from narrative.js. This covers:
//     - inventory item names (from parseInventoryUpdateText / scene files)
//     - skill labels and descriptions (from skills.txt)
//     - journal entry and achievement text (from *journal / *achievement)
//     - stat group names (from stats.txt *stat_group)
//     - stat labels (from stats.txt *stat / *stat_registered)
//   These are author-controlled rather than player-controlled, so the XSS
//   risk is lower (a malicious author could inject via a scene file), but
//   defensive escaping is correct practice and costs nothing.
// ---------------------------------------------------------------------------

import {
  playerState, statRegistry,
  pendingStatPoints,
  setPendingStatPoints,
  setLevelUpInProgress, levelUpInProgress,
  normalizeKey,
} from '../core/state.js';

import { getAllocatableStatKeys, canLevelUp, performLevelUp } from '../systems/leveling.js';
import { skillRegistry, playerHasSkill, purchaseSkill } from '../systems/skills.js';
import { itemRegistry, purchaseItem } from '../systems/items.js';
import { itemBaseName } from '../systems/inventory.js';
import { getJournalEntries, getAchievements } from '../systems/journal.js';
import { escapeHtml } from './narrative.js'; // FIX #5: reuse shared sanitizer

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _statusPanel        = null;
let _endingOverlay      = null;
let _endingTitle        = null;
let _endingContent      = null;
let _endingStats        = null;
let _endingActionBtn    = null;
let _levelUpOverlay     = null;
let _storeOverlay       = null;
let _fetchTextFile      = null;   // async (name) → string
let _scheduleStats      = null;   // () → void
let _trapFocus          = null;   // (el, trigger) → release fn
let _showToast          = null;   // (msg: string) → void
let _onLevelUpConfirmed = null;   // (level: number) → void

export function init({ statusPanel,
                       endingOverlay, endingTitle, endingContent,
                       endingStats, endingActionBtn,
                       levelUpOverlay,
                       storeOverlay,
                       fetchTextFile, scheduleStatsRender, trapFocus,
                       showToast, onLevelUpConfirmed }) {
  _statusPanel        = statusPanel;
  _endingOverlay      = endingOverlay;
  _endingTitle        = endingTitle;
  _endingContent      = endingContent;
  _endingStats        = endingStats;
  _endingActionBtn    = endingActionBtn;
  _levelUpOverlay     = levelUpOverlay;
  _storeOverlay       = storeOverlay;
  _fetchTextFile      = fetchTextFile;
  _scheduleStats      = scheduleStatsRender;
  _trapFocus          = trapFocus;
  _showToast          = showToast || (() => {});
  _onLevelUpConfirmed = onLevelUpConfirmed || null;
}

// ---------------------------------------------------------------------------
// styleState — cached color / icon metadata parsed from stats.txt.
// Reset on each runStatsScene call so stale entries don't bleed across loads.
// ---------------------------------------------------------------------------
const styleState = { colors: {}, icons: {} };

// Active tab for the status panel — persists across re-renders
let _activeStatusTab = 'stats';

// ---------------------------------------------------------------------------
// runStatsScene — parses stats.txt and rebuilds the status sidebar HTML.
//
// stats.txt directives:
//   *stat_group "Label"       — opens a collapsible section
//   *stat key "Label"         — renders one stat row
//   *stat_registered          — renders all statRegistry entries in order
//   *stat_color key className — attaches a CSS class to a stat value
//   *stat_icon  key "emoji"   — prepends an icon to a stat label
//   *inventory                — renders the inventory list
// ---------------------------------------------------------------------------
export async function runStatsScene() {
  const text  = await _fetchTextFile('stats');
  const lines = text.split(/\r?\n/).map(raw => ({ raw, trimmed: raw.trim() }));
  styleState.colors = {};
  styleState.icons  = {};

  // --- Parse stats.txt entries ---
  const entries = [];
  lines.forEach(line => {
    const t = line.trimmed;
    if (!t || t.startsWith('//')) return;

    if (t.startsWith('*stat_group')) {
      const sgm = t.match(/^\*stat_group\s+"([^"]+)"/);
      entries.push({ type: 'group', name: sgm ? sgm[1] : t.replace(/^\*stat_group\s*/, '').trim() });
    } else if (t.startsWith('*stat_color')) {
      const [, rawKey, color] = t.split(/\s+/);
      styleState.colors[normalizeKey(rawKey)] = color;
    } else if (t.startsWith('*stat_icon')) {
      const m = t.match(/^\*stat_icon\s+([\w_]+)\s+"(.+)"$/);
      if (m) styleState.icons[normalizeKey(m[1])] = m[2];
    } else if (t.startsWith('*inventory')) {
      entries.push({ type: 'inventory' });
    } else if (t.trim() === '*skills_registered') {
      entries.push({ type: 'skills' });
    } else if (t.trim() === '*journal_section') {
      entries.push({ type: 'journal' });
    } else if (t.trim() === '*achievements') {
      entries.push({ type: 'achievements' });
    } else if (t === '*stat_registered') {
      statRegistry.forEach(({ key, label }) => entries.push({ type: 'stat', key, label }));
    } else if (t.startsWith('*stat')) {
      const m = t.match(/^\*stat\s+([\w_]+)\s+"(.+)"$/);
      if (m) entries.push({ type: 'stat', key: normalizeKey(m[1]), label: m[2] });
    }
  });

  // --- Build tab content HTML ---

  // STATS TAB
  let statsHtml = '';
  let inGroup = false;
  entries.forEach(e => {
    if (e.type === 'group') {
      if (inGroup) statsHtml += `</div>`;
      statsHtml += `<div class="status-section"><div class="status-label status-section-header">${escapeHtml(e.name)}</div>`;
      inGroup = true;
    }
    if (e.type === 'stat') {
      const cc = styleState.colors[e.key] || '';
      const ic = styleState.icons[e.key]  ?? '';
      const rawVal = playerState[e.key] ?? '—';
      statsHtml += `<div class="status-row"><span class="status-label">${ic ? ic + ' ' : ''}${escapeHtml(e.label)}</span><span class="status-value ${cc}">${escapeHtml(rawVal)}</span></div>`;
      if (e.key === 'essence_to_next' && canLevelUp() && !levelUpInProgress) {
        statsHtml += `<div class="status-levelup-row"><button class="status-levelup-btn" id="status-levelup-btn">Level Up Available</button></div>`;
      }
    }
  });
  if (inGroup) statsHtml += `</div>`;

  // Store button lives at the bottom of stats tab
  const hasStoreContent = skillRegistry.length > 0 || itemRegistry.length > 0;
  if (hasStoreContent) {
    statsHtml += `<div class="status-store-row"><button class="status-store-btn" id="status-store-btn">◈ Store</button></div>`;
  }

  // SKILLS TAB
  let skillsHtml = '';
  const ownedSkills = Array.isArray(playerState.skills) ? playerState.skills : [];
  if (ownedSkills.length === 0) {
    skillsHtml = `<p class="tag-empty" style="padding:0;border:none;background:none;">No skills learned yet.</p>`;
  } else {
    const skillItems = ownedSkills.map(k => {
      const entry = skillRegistry.find(s => s.key === k);
      const label = escapeHtml(entry ? entry.label : k);
      const desc  = escapeHtml(entry ? entry.description : '');
      return `<li class="skill-accordion"><button class="skill-accordion-btn" data-skill-key="${escapeHtml(k)}"><span class="skill-accordion-name">${label}</span><span class="skill-accordion-chevron">▾</span></button><div class="skill-accordion-desc" style="display:none;">${desc}</div></li>`;
    }).join('');
    skillsHtml = `<ul class="skill-accordion-list">${skillItems}</ul>`;
  }

  // INVENTORY TAB — accordion cards matching Skills style
  let inventoryHtml = '';
  const invItems = Array.isArray(playerState.inventory) ? playerState.inventory : [];
  if (invItems.length === 0) {
    inventoryHtml = `<p class="tag-empty" style="padding:0;border:none;background:none;">Nothing here yet.</p>`;
  } else {
    const invAccordions = invItems.map(invEntry => {
      const baseName = itemBaseName(invEntry);
      const regEntry = itemRegistry.find(r => r.label === baseName);
      const label    = escapeHtml(invEntry);  // includes "(2)" stack count if present
      const desc     = escapeHtml(regEntry ? regEntry.description : '');
      return `<li class="skill-accordion">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name">${label}</span>
          <span class="skill-accordion-chevron">▾</span>
        </button>
        <div class="skill-accordion-desc" style="display:none;">${desc || '<em style="color:var(--text-faint)">No description available.</em>'}</div>
      </li>`;
    }).join('');
    inventoryHtml = `<ul class="skill-accordion-list">${invAccordions}</ul>`;
  }

  // ACHIEVEMENTS TAB — includes journal entries too
  let achievementsHtml = '';
  const achvs = getAchievements();
  const jentries = getJournalEntries().filter(j => j.type !== 'achievement');

  if (achvs.length === 0 && jentries.length === 0) {
    achievementsHtml = `<p class="tag-empty" style="padding:0;border:none;background:none;">Nothing recorded yet.</p>`;
  } else {
    if (achvs.length > 0) {
      const achvItems = achvs.map(a =>
        `<li class="journal-entry journal-entry--achievement"><span class="journal-achievement-icon">◆</span> ${escapeHtml(a.text)}</li>`
      ).join('');
      achievementsHtml += `<div class="status-label status-section-header" style="margin-bottom:8px;">Achievements</div><ul class="journal-list" style="margin-bottom:14px;">${achvItems}</ul>`;
    }
    if (jentries.length > 0) {
      const journalItems = [...jentries].reverse().map(j =>
        `<li class="journal-entry">${escapeHtml(j.text)}</li>`
      ).join('');
      achievementsHtml += `<div class="status-label status-section-header" style="margin-bottom:8px;">Journal</div><ul class="journal-list">${journalItems}</ul>`;
    }
  }

  // --- Build full panel HTML with tab bar ---
  const tabs = [
    { key: 'stats',        label: 'Stats' },
    { key: 'skills',       label: 'Skills' },
    { key: 'inventory',    label: 'Inv' },
    { key: 'achievements', label: 'Log' },
  ];

  const tabBarHtml = `<div class="status-tabs" id="status-tab-bar">
    ${tabs.map(t => `<button class="status-tab ${_activeStatusTab === t.key ? 'status-tab--active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
  </div>`;

  const contentMap = {
    stats:        statsHtml,
    skills:       skillsHtml,
    inventory:    inventoryHtml,
    achievements: achievementsHtml,
  };

  const panelHtml = `${tabBarHtml}<div class="status-tab-content" id="status-tab-pane">${contentMap[_activeStatusTab]}</div>`;

  _statusPanel.innerHTML = panelHtml;

  // --- Wire tab switching ---
  _statusPanel.querySelectorAll('.status-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeStatusTab = btn.dataset.tab;
      _statusPanel.querySelectorAll('.status-tab').forEach(b =>
        b.classList.toggle('status-tab--active', b.dataset.tab === _activeStatusTab)
      );
      const pane = _statusPanel.querySelector('#status-tab-pane');
      if (pane) pane.innerHTML = contentMap[_activeStatusTab];
      wireTabContent();
    });
  });

  wireTabContent();

  function wireTabContent() {
    // Level Up button
    const lvlBtn = _statusPanel.querySelector('#status-levelup-btn');
    if (lvlBtn) lvlBtn.addEventListener('click', () => showLevelUpModal());

    // Store button
    const storeBtn = _statusPanel.querySelector('#status-store-btn');
    if (storeBtn) storeBtn.addEventListener('click', () => showStore());

    // Skill accordions
    _statusPanel.querySelectorAll('.skill-accordion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const desc = btn.nextElementSibling;
        const isOpen = desc.style.display !== 'none';
        desc.style.display = isOpen ? 'none' : 'block';
        btn.classList.toggle('skill-accordion-btn--open', !isOpen);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// showLevelUpModal — full-screen blocking modal for manual level-up.
//
// Calls performLevelUp() to execute the level-up (deduct essence, increment
// level, award stat points), then presents the stat allocation grid.
// The modal traps focus and sets levelUpInProgress to prevent saving.
// ---------------------------------------------------------------------------
let _trapRelease = null;

export function showLevelUpModal() {
  if (!_levelUpOverlay) return;
  if (levelUpInProgress) return;

  // Execute the level-up
  const prevLevel = Number(playerState.level || 1);
  const newLevel = performLevelUp(() => {});
  if (newLevel === null) return;  // can't afford

  setLevelUpInProgress(true);

  // Snapshot stat points awarded for this level-up
  const pointsToSpend = pendingStatPoints;
  setPendingStatPoints(0);

  const keys     = getAllocatableStatKeys();
  const labelMap = {};
  statRegistry.forEach(({ key, label }) => { labelMap[key] = label; });
  const alloc = {};
  keys.forEach(k => { alloc[k] = 0; });

  let confirmed = false;

  const box = _levelUpOverlay.querySelector('.levelup-modal-box');
  if (!box) return;

  function render() {
    const spent    = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain   = pointsToSpend - spent;
    const allSpent = remain === 0;

    box.innerHTML = `
      <div class="levelup-modal-header">
        <span class="system-block-label">[ LEVEL UP ]</span>
        <div class="levelup-modal-title">
          Level ${prevLevel} → <strong>Level ${newLevel}</strong>
        </div>
        <div class="levelup-modal-subtitle">
          <span class="levelup-points-remaining">${remain} point${remain !== 1 ? 's' : ''} remaining</span>
        </div>
      </div>
      <div class="stat-alloc-grid">
        ${keys.map(k => `
          <div class="stat-alloc-item ${alloc[k] ? 'selected' : ''}">
            <span class="stat-alloc-name">${escapeHtml(labelMap[k] || k)}</span>
            <div class="stat-alloc-controls">
              <button class="alloc-btn" data-op="minus" data-k="${k}" ${alloc[k] <= 0 ? 'disabled' : ''}>−</button>
              <span class="stat-alloc-val ${alloc[k] ? 'buffed' : ''}">${Number(playerState[k] || 0) + alloc[k]}</span>
              <button class="alloc-btn" data-op="plus"  data-k="${k}" ${remain <= 0 ? 'disabled' : ''}>+</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="levelup-modal-footer">
        <button class="levelup-confirm-btn ${allSpent ? '' : 'levelup-confirm-btn--locked'}" ${allSpent ? '' : 'disabled'}>Confirm</button>
      </div>`;

    box.querySelectorAll('.alloc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const k  = btn.dataset.k;
        const op = btn.dataset.op;
        if (op === 'plus'  && remain > 0)    alloc[k]++;
        if (op === 'minus' && alloc[k] > 0)  alloc[k]--;
        render();
      });
    });

    box.querySelector('.levelup-confirm-btn')?.addEventListener('click', () => {
      if (confirmed) return;
      if (remain > 0) return;
      confirmed = true;

      // Apply stat allocations
      keys.forEach(k => {
        if (alloc[k]) playerState[k] = Number(playerState[k] || 0) + alloc[k];
      });

      if (_onLevelUpConfirmed) _onLevelUpConfirmed(newLevel);
      _showToast(`Reached Level ${newLevel}`);

      // Check if another level-up is available
      if (canLevelUp()) {
        showLevelAgainPrompt(box, newLevel);
      } else {
        setLevelUpInProgress(false);
        hideLevelUpModal();
        _scheduleStats();
      }
    });
  }

  // Show modal
  _levelUpOverlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    _levelUpOverlay.style.opacity = '1';
  });

  // Trap focus
  if (_trapFocus) {
    _trapRelease = _trapFocus(_levelUpOverlay, null);
  }

  render();

  // Focus first allocate button
  requestAnimationFrame(() => {
    const firstBtn = box.querySelector('.alloc-btn:not(:disabled)');
    if (firstBtn) firstBtn.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------------------
// showLevelAgainPrompt — shown inside the modal after confirm when
// the player can afford another level-up. Offers Yes / No.
// ---------------------------------------------------------------------------
function showLevelAgainPrompt(box, justReachedLevel) {
  box.innerHTML = `
    <div class="levelup-modal-header">
      <span class="system-block-label">[ LEVEL UP ]</span>
      <div class="levelup-modal-title">
        <strong>Level ${justReachedLevel}</strong> reached
      </div>
      <div class="levelup-modal-subtitle levelup-again-prompt">
        You have enough Essence to level up again. Continue?
      </div>
    </div>
    <div class="levelup-modal-footer levelup-again-footer">
      <button class="levelup-again-btn levelup-again-btn--yes" id="levelup-again-yes">Yes, Level Up</button>
      <button class="levelup-again-btn levelup-again-btn--no" id="levelup-again-no">No, Done</button>
    </div>`;

  box.querySelector('#levelup-again-yes')?.addEventListener('click', () => {
    // Close current modal state, then immediately open a new level-up
    setLevelUpInProgress(false);
    hideLevelUpModal();
    _scheduleStats();
    // Small delay so the DOM resets before the new modal opens
    requestAnimationFrame(() => {
      showLevelUpModal();
    });
  });

  box.querySelector('#levelup-again-no')?.addEventListener('click', () => {
    setLevelUpInProgress(false);
    hideLevelUpModal();
    _scheduleStats();
  });

  // Focus the Yes button
  requestAnimationFrame(() => {
    box.querySelector('#levelup-again-yes')?.focus({ preventScroll: true });
  });
}

function hideLevelUpModal() {
  if (!_levelUpOverlay) return;
  _levelUpOverlay.classList.add('hidden');
  _levelUpOverlay.style.opacity = '0';
  if (_trapRelease) { _trapRelease(); _trapRelease = null; }
}

// ---------------------------------------------------------------------------
// Store system — full-screen overlay with Skills and Items tabs
// ---------------------------------------------------------------------------
let _storeTrapRelease = null;
let _storeActiveTab   = 'skills';   // preserved across open/close

export function showStore() {
  if (!_storeOverlay) return;

  _storeOverlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    _storeOverlay.style.opacity = '1';
  });

  if (_trapFocus) {
    _storeTrapRelease = _trapFocus(_storeOverlay, null);
  }

  renderStore();
}

function hideStore() {
  if (!_storeOverlay) return;
  _storeOverlay.classList.add('hidden');
  _storeOverlay.style.opacity = '0';
  if (_storeTrapRelease) { _storeTrapRelease(); _storeTrapRelease = null; }
  _scheduleStats();
}

function renderStore() {
  const box = _storeOverlay.querySelector('.store-modal-box');
  if (!box) return;

  const essence = Number(playerState.essence || 0);

  box.innerHTML = `
    <div class="store-header">
      <span class="system-block-label">[ STORE ]</span>
      <div class="store-essence-pool">
        <span class="store-essence-label">Essence</span>
        <span class="store-essence-val">${essence}</span>
      </div>
      <button class="store-close-btn" id="store-close-btn">✕</button>
    </div>
    <div class="store-tabs">
      <button class="store-tab ${_storeActiveTab === 'skills' ? 'store-tab--active' : ''}" data-tab="skills">Skills</button>
      <button class="store-tab ${_storeActiveTab === 'items' ? 'store-tab--active' : ''}" data-tab="items">Items</button>
    </div>
    <div class="store-content" id="store-content"></div>`;

  // Wire close button
  box.querySelector('#store-close-btn')?.addEventListener('click', hideStore);

  // Wire tabs
  box.querySelectorAll('.store-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _storeActiveTab = tab.dataset.tab;
      renderStore();
    });
  });

  // Render active tab content
  const content = box.querySelector('#store-content');
  if (_storeActiveTab === 'skills') {
    renderSkillsTab(content, essence);
  } else {
    renderItemsTab(content, essence);
  }

  // Focus close button
  requestAnimationFrame(() => {
    box.querySelector('#store-close-btn')?.focus({ preventScroll: true });
  });
}

function renderSkillsTab(container, essence) {
  if (skillRegistry.length === 0) {
    container.innerHTML = `<div class="store-empty">No skills available.</div>`;
    return;
  }

  // Split into available vs owned
  const available = skillRegistry.filter(s => !playerHasSkill(s.key));
  const owned     = skillRegistry.filter(s => playerHasSkill(s.key));

  let html = '';

  if (available.length > 0) {
    html += `<div class="store-section-label">Available</div>`;
    available.forEach(skill => {
      const canAfford = essence >= skill.essenceCost;
      const cardCls   = canAfford ? '' : 'store-card--unaffordable';
      const badgeCls  = canAfford ? 'store-cost-badge--can-afford' : '';
      html += `
        <div class="store-card ${cardCls}" data-key="${escapeHtml(skill.key)}" data-type="skill">
          <div class="store-card-top">
            <span class="store-card-name">${escapeHtml(skill.label)}</span>
            <div class="store-card-actions">
              <span class="store-cost-badge ${badgeCls}">${skill.essenceCost} Essence</span>
              <button class="store-purchase-btn" ${canAfford ? '' : 'disabled'} data-key="${escapeHtml(skill.key)}" data-type="skill">Unlock</button>
            </div>
          </div>
          <div class="store-card-desc">${escapeHtml(skill.description)}</div>
        </div>`;
    });
  }

  if (owned.length > 0) {
    html += `<div class="store-section-label store-section-label--owned">Owned</div>`;
    owned.forEach(skill => {
      html += `
        <div class="store-card store-card--owned" data-key="${escapeHtml(skill.key)}">
          <div class="store-card-top">
            <span class="store-card-name">${escapeHtml(skill.label)}</span>
            <div class="store-card-actions">
              <span class="store-owned-badge">Owned</span>
            </div>
          </div>
          <div class="store-card-desc">${escapeHtml(skill.description)}</div>
        </div>`;
    });
  }

  if (available.length === 0 && owned.length === 0) {
    html = `<div class="store-empty">No skills defined.</div>`;
  }

  container.innerHTML = html;

  // Wire purchase buttons
  container.querySelectorAll('.store-purchase-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (purchaseSkill(key)) {
        _showToast(`Skill unlocked: ${skillRegistry.find(s => s.key === key)?.label || key}`);
        renderStore();  // Re-render to reflect changes
      }
    });
  });
}

function renderItemsTab(container, essence) {
  if (itemRegistry.length === 0) {
    container.innerHTML = `<div class="store-empty">No items available.</div>`;
    return;
  }

  let html = '';
  itemRegistry.forEach(item => {
    const canAfford = essence >= item.essenceCost;
    const cardCls   = canAfford ? '' : 'store-card--unaffordable';
    const badgeCls  = canAfford ? 'store-cost-badge--can-afford' : '';
    html += `
      <div class="store-card ${cardCls}" data-key="${escapeHtml(item.key)}" data-type="item">
        <div class="store-card-top">
          <span class="store-card-name">${escapeHtml(item.label)}</span>
          <div class="store-card-actions">
            <span class="store-cost-badge ${badgeCls}">${item.essenceCost} Essence</span>
            <button class="store-purchase-btn" ${canAfford ? '' : 'disabled'} data-key="${escapeHtml(item.key)}" data-type="item">Buy</button>
          </div>
        </div>
        <div class="store-card-desc">${escapeHtml(item.description)}</div>
      </div>`;
  });

  container.innerHTML = html;

  // Wire purchase buttons
  container.querySelectorAll('.store-purchase-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (purchaseItem(key)) {
        _showToast(`Purchased: ${itemRegistry.find(i => i.key === key)?.label || key}`);
        renderStore();  // Re-render to reflect updated essence
      }
    });
  });
}

// ---------------------------------------------------------------------------
// showEndingScreen
// ---------------------------------------------------------------------------
export function showEndingScreen(title, content) {
  if (!_endingOverlay) return;
  _endingTitle.textContent   = title;
  _endingContent.textContent = content;

  const statsLines = [];
  statRegistry.forEach(({ key, label }) => {
    statsLines.push(`${label}: ${playerState[key] ?? '—'}`);
  });
  _endingStats.textContent = statsLines.join('  ·  ');

  _endingOverlay.classList.remove('hidden');
  _endingOverlay.style.opacity = '1';
  if (_trapFocus) {
    const release = _trapFocus(_endingOverlay, null);
    _endingOverlay._trapRelease = release;
  }

  _endingActionBtn?.addEventListener('click', () => {
    window.location.reload();
  }, { once: true });
}
