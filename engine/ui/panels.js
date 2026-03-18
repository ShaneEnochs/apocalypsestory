// ---------------------------------------------------------------------------
// ui/panels.js — Stats panel, store, ending screen
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
//
// FIX #6: Common rarity items/skills now correctly receive the
//   skill-rarity--common CSS class so they render white instead of
//   inheriting the base cyan color from .store-card-name / .skill-accordion-name.
// ---------------------------------------------------------------------------

import {
  playerState, statRegistry,
  normalizeKey,
} from '../core/state.js';

import { getAllocatableStatKeys } from '../systems/leveling.js';
import { skillRegistry, playerHasSkill, purchaseSkill } from '../systems/skills.js';
import { itemRegistry, purchaseItem } from '../systems/items.js';
import { itemBaseName } from '../systems/inventory.js';
import { getJournalEntries, getAchievements } from '../systems/journal.js';
import { escapeHtml } from './narrative.js';
import { evalValue } from '../core/expression.js';

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _statusPanel        = null;
let _endingOverlay      = null;
let _endingTitle        = null;
let _endingContent      = null;
let _endingStats        = null;
let _endingActionBtn    = null;
let _storeOverlay       = null;
let _fetchTextFile      = null;   // async (name) → string
let _scheduleStats      = null;   // () → void
let _trapFocus          = null;   // (el, trigger) → release fn
let _showToast          = null;   // (msg: string) → void

export function init({ statusPanel,
                       endingOverlay, endingTitle, endingContent,
                       endingStats, endingActionBtn,
                       storeOverlay,
                       fetchTextFile, scheduleStatsRender, trapFocus,
                       showToast }) {
  _statusPanel        = statusPanel;
  _endingOverlay      = endingOverlay;
  _endingTitle        = endingTitle;
  _endingContent      = endingContent;
  _endingStats        = endingStats;
  _endingActionBtn    = endingActionBtn;
  _storeOverlay       = storeOverlay;
  _fetchTextFile      = fetchTextFile;
  _scheduleStats      = scheduleStatsRender;
  _trapFocus          = trapFocus;
  _showToast          = showToast || (() => {});
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
    }
  });
  if (inGroup) statsHtml += `</div>`;

  // ACHIEVEMENTS as expandable accordions at bottom of stats tab
  const achvsForStats = getAchievements();
  if (achvsForStats.length > 0) {
    const achvAccordions = achvsForStats.map(a => {
      // Achievements may optionally have a title — text before " — " is the title
      const dashIdx = a.text.indexOf(' — ');
      const title   = dashIdx !== -1 ? escapeHtml(a.text.slice(0, dashIdx)) : escapeHtml(a.text);
      const body    = dashIdx !== -1 ? escapeHtml(a.text.slice(dashIdx + 3)) : '';
      return `<li class="skill-accordion skill-accordion--achievement">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name"><span class="journal-achievement-icon"></span> ${title}</span>
          ${body ? `<span class="skill-accordion-chevron">▾</span>` : ''}
        </button>
        ${body ? `<div class="skill-accordion-desc" style="display:none;">${body}</div>` : ''}
      </li>`;
    }).join('');
    statsHtml += `<div class="status-section"><div class="status-label status-section-header">Achievements</div><ul class="skill-accordion-list">${achvAccordions}</ul></div>`;
  }

  // SKILLS TAB — store button at top, then owned skills with rarity colors
  const hasSkillStore = skillRegistry.length > 0;
  let skillsHtml = hasSkillStore
    ? `<div class="status-store-row"><button class="status-store-btn" id="status-store-btn-skills" data-store-tab="skills">Skill Store</button></div>`
    : '';

  const ownedSkills = Array.isArray(playerState.skills) ? playerState.skills : [];
  if (ownedSkills.length === 0) {
    skillsHtml += `<p class="tag-empty" style="padding:0;border:none;background:none;margin-top:8px;">No skills learned yet.</p>`;
  } else {
    const skillItems = ownedSkills.map(k => {
      const entry   = skillRegistry.find(s => s.key === k);
      const label   = escapeHtml(entry ? entry.label : k);
      const desc    = escapeHtml(entry ? entry.description : '');
      const rarity  = entry?.rarity || 'common';
      // FIX #6: Always apply rarity class (including common) so CSS override works
      const rarCls  = ` skill-rarity--${rarity}`;
      return `<li class="skill-accordion"><button class="skill-accordion-btn" data-skill-key="${escapeHtml(k)}"><span class="skill-accordion-name${rarCls}">${label}</span><span class="skill-accordion-chevron">▾</span></button><div class="skill-accordion-desc" style="display:none;">${desc}</div></li>`;
    }).join('');
    skillsHtml += `<ul class="skill-accordion-list">${skillItems}</ul>`;
  }

  // INVENTORY TAB — store button at top, then items with rarity colors
  const hasItemStore = itemRegistry.length > 0;
  let inventoryHtml = hasItemStore
    ? `<div class="status-store-row"><button class="status-store-btn" id="status-store-btn-inv" data-store-tab="items">Item Store</button></div>`
    : '';

  const invItems = Array.isArray(playerState.inventory) ? playerState.inventory : [];
  if (invItems.length === 0) {
    inventoryHtml += `<p class="tag-empty" style="padding:0;border:none;background:none;margin-top:8px;">Nothing here yet.</p>`;
  } else {
    const invAccordions = invItems.map(invEntry => {
      const baseName = itemBaseName(invEntry);
      const regEntry = itemRegistry.find(r => r.label === baseName);
      const label    = escapeHtml(invEntry);
      const desc     = escapeHtml(regEntry ? regEntry.description : '');
      const rarity   = regEntry?.rarity || 'common';
      // FIX #6: Always apply rarity class (including common) so CSS override works
      const rarCls   = ` skill-rarity--${rarity}`;
      return `<li class="skill-accordion">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name${rarCls}">${label}</span>
          <span class="skill-accordion-chevron">▾</span>
        </button>
        <div class="skill-accordion-desc" style="display:none;">${desc || '<em style="color:var(--text-faint)">No description available.</em>'}</div>
      </li>`;
    }).join('');
    inventoryHtml += `<ul class="skill-accordion-list">${invAccordions}</ul>`;
  }

  // ACHIEVEMENTS TAB — accordion achievements + flat journal entries
  let achievementsHtml = '';
  const achvs = getAchievements();
  const jentries = getJournalEntries().filter(j => j.type !== 'achievement');

  if (achvs.length === 0 && jentries.length === 0) {
    achievementsHtml = `<p class="tag-empty" style="padding:0;border:none;background:none;">Nothing recorded yet.</p>`;
  } else {
    if (achvs.length > 0) {
      const achvAccordionItems = achvs.map(a => {
        const dashIdx = a.text.indexOf(' — ');
        const title   = dashIdx !== -1 ? escapeHtml(a.text.slice(0, dashIdx)) : escapeHtml(a.text);
        const body    = dashIdx !== -1 ? escapeHtml(a.text.slice(dashIdx + 3)) : '';
        return `<li class="skill-accordion skill-accordion--achievement">
          <button class="skill-accordion-btn">
            <span class="skill-accordion-name"><span class="journal-achievement-icon"></span> ${title}</span>
            ${body ? `<span class="skill-accordion-chevron">▾</span>` : ''}
          </button>
          ${body ? `<div class="skill-accordion-desc" style="display:none;">${body}</div>` : ''}
        </li>`;
      }).join('');
      achievementsHtml += `<div class="status-label status-section-header" style="margin-bottom:8px;">Achievements</div><ul class="skill-accordion-list" style="margin-bottom:14px;">${achvAccordionItems}</ul>`;
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
    // Store buttons — skills tab opens skills store, inv tab opens items store
    const skillsStoreBtn = _statusPanel.querySelector('#status-store-btn-skills');
    if (skillsStoreBtn) skillsStoreBtn.addEventListener('click', () => showStore('skills'));

    const invStoreBtn = _statusPanel.querySelector('#status-store-btn-inv');
    if (invStoreBtn) invStoreBtn.addEventListener('click', () => showStore('items'));

    // Skill/inventory/achievement accordions
    _statusPanel.querySelectorAll('.skill-accordion-btn').forEach(btn => {
      const desc = btn.nextElementSibling;
      if (!desc) return;  // achievements without body text have no desc element
      btn.addEventListener('click', () => {
        const isOpen = desc.style.display !== 'none';
        desc.style.display = isOpen ? 'none' : 'block';
        btn.classList.toggle('skill-accordion-btn--open', !isOpen);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Store system — full-screen overlay with Skills and Items tabs
// ---------------------------------------------------------------------------
let _storeTrapRelease = null;
let _storeActiveTab   = 'skills';   // preserved across open/close
let _preStoreTab      = null;       // remembers sidebar tab before store opened

export function showStore(tab = null) {
  if (!_storeOverlay) return;
  if (tab) _storeActiveTab = tab;
  // Remember which sidebar tab was active so hideStore can restore it
  _preStoreTab = _activeStatusTab;

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
  // Return to whichever sidebar tab was active before the store opened
  _activeStatusTab = _preStoreTab || (_storeActiveTab === 'items' ? 'inventory' : 'skills');
  _preStoreTab = null;
  _scheduleStats();
  // The document-level click-outside handler may close the sidebar in the
  // same event cycle (the close button is outside #status-panel). Re-apply
  // the visible class in the next frame so the sidebar stays open.
  requestAnimationFrame(() => {
    if (_statusPanel) {
      _statusPanel.classList.add('status-visible');
      _statusPanel.classList.remove('status-hidden');
    }
  });
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

  // Filter by *require condition — hide skills whose condition evaluates false
  const visible = skillRegistry.filter(s => {
    if (!s.condition) return true;
    try { return !!evalValue(s.condition); } catch { return true; }
  });

  // Split into available vs owned
  const available = visible.filter(s => !playerHasSkill(s.key));
  const owned     = visible.filter(s => playerHasSkill(s.key));

  let html = '';

  if (available.length > 0) {
    html += `<div class="store-section-label">Available</div>`;
    available.forEach(skill => {
      const canAfford = essence >= skill.essenceCost;
      const cardCls   = canAfford ? '' : 'store-card--unaffordable';
      const badgeCls  = canAfford ? 'store-cost-badge--can-afford' : '';
      const rarity    = skill.rarity || 'common';
      // FIX #6: Always apply rarity class (including common) so CSS override works
      const rarCls    = ` skill-rarity--${rarity}`;
      html += `
        <div class="store-card ${cardCls}" data-key="${escapeHtml(skill.key)}" data-type="skill">
          <div class="store-card-top">
            <span class="store-card-name${rarCls}">${escapeHtml(skill.label)}</span>
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
      const rarity = skill.rarity || 'common';
      // FIX #6: Always apply rarity class (including common) so CSS override works
      const rarCls = ` skill-rarity--${rarity}`;
      html += `
        <div class="store-card store-card--owned" data-key="${escapeHtml(skill.key)}">
          <div class="store-card-top">
            <span class="store-card-name${rarCls}">${escapeHtml(skill.label)}</span>
            <div class="store-card-actions">
              <span class="store-owned-badge">Owned</span>
            </div>
          </div>
          <div class="store-card-desc">${escapeHtml(skill.description)}</div>
        </div>`;
    });
  }

  if (available.length === 0 && owned.length === 0) {
    html = `<div class="store-empty">No skills available.</div>`;
  }

  container.innerHTML = html;

  // Wire purchase buttons
  container.querySelectorAll('.store-purchase-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (purchaseSkill(key)) {
        _showToast(`Skill unlocked: ${skillRegistry.find(s => s.key === key)?.label || key}`);
        renderStore();
      }
    });
  });
}

function renderItemsTab(container, essence) {
  if (itemRegistry.length === 0) {
    container.innerHTML = `<div class="store-empty">No items available.</div>`;
    return;
  }

  // Filter by *require condition
  const visible = itemRegistry.filter(item => {
    if (!item.condition) return true;
    try { return !!evalValue(item.condition); } catch { return true; }
  });

  if (visible.length === 0) {
    container.innerHTML = `<div class="store-empty">No items available.</div>`;
    return;
  }

  let html = '';
  visible.forEach(item => {
    const canAfford = essence >= item.essenceCost;
    const cardCls   = canAfford ? '' : 'store-card--unaffordable';
    const badgeCls  = canAfford ? 'store-cost-badge--can-afford' : '';
    const rarity    = item.rarity || 'common';
    // FIX #6: Always apply rarity class (including common) so CSS override works
    const rarCls    = ` skill-rarity--${rarity}`;
    html += `
      <div class="store-card ${cardCls}" data-key="${escapeHtml(item.key)}" data-type="item">
        <div class="store-card-top">
          <span class="store-card-name${rarCls}">${escapeHtml(item.label)}</span>
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
        renderStore();
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
