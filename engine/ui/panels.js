// ---------------------------------------------------------------------------
// ui/panels.js — Stats panel, level-up allocation, ending screen
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
// All other logic is unchanged from the original.
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
let _fetchTextFile      = null;   // async (name) → string
let _scheduleStats      = null;   // () → void
let _trapFocus          = null;   // (el, trigger) → release fn
let _showToast          = null;   // (msg: string) → void
let _onLevelUpConfirmed = null;   // (level: number) → void

export function init({ statusPanel,
                       endingOverlay, endingTitle, endingContent,
                       endingStats, endingActionBtn,
                       levelUpOverlay,
                       fetchTextFile, scheduleStatsRender, trapFocus,
                       showToast, onLevelUpConfirmed }) {
  _statusPanel        = statusPanel;
  _endingOverlay      = endingOverlay;
  _endingTitle        = endingTitle;
  _endingContent      = endingContent;
  _endingStats        = endingStats;
  _endingActionBtn    = endingActionBtn;
  _levelUpOverlay     = levelUpOverlay;
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
  let html = '';
  styleState.colors = {};
  styleState.icons  = {};

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

  let inGroup = false;
  entries.forEach(e => {
    if (e.type === 'group') {
      if (inGroup) html += `</div>`;
      // FIX #5: escape group name (from stats.txt — author-controlled)
      html += `<div class="status-section"><div class="status-label status-section-header">${escapeHtml(e.name)}</div>`;
      inGroup = true;
    }
    if (e.type === 'stat') {
      const cc = styleState.colors[e.key] || '';
      const ic = styleState.icons[e.key]  ?? '';
      const rawVal = playerState[e.key] ?? '—';
      // FIX #5: escape both the label and the value. Label is author-controlled;
      // value can be player-controlled (e.g. first_name set via *input).
      html += `<div class="status-row"><span class="status-label">${ic ? ic + ' ' : ''}${escapeHtml(e.label)}</span><span class="status-value ${cc}">${escapeHtml(rawVal)}</span></div>`;
    }
    if (e.type === 'inventory') {
      if (inGroup) { html += `</div>`; inGroup = false; }
      const items = Array.isArray(playerState.inventory) && playerState.inventory.length
        // FIX #5: escape each inventory item name
        ? playerState.inventory.map(i => `<li>${escapeHtml(i)}</li>`).join('')
        : '<li class="tag-empty">Empty</li>';
      html += `<div class="status-section"><div class="status-label status-section-header">Inventory</div><ul class="tag-list">${items}</ul></div>`;
    }
    if (e.type === 'skills') {
      if (inGroup) { html += `</div>`; inGroup = false; }
      const owned = Array.isArray(playerState.skills) ? playerState.skills : [];
      if (owned.length === 0 && skillRegistry.length === 0) {
        // No skills defined and none owned — skip the section entirely
      } else {
        const skillItems = owned.length
          ? owned.map(k => {
              const entry = skillRegistry.find(s => s.key === k);
              // FIX #5: escape skill label and description (from skills.txt)
              const label = escapeHtml(entry ? entry.label : k);
              const desc  = escapeHtml(entry ? entry.description : '');
              return `<li class="skill-accordion"><button class="skill-accordion-btn" data-skill-key="${escapeHtml(k)}"><span class="skill-accordion-name">${label}</span><span class="skill-accordion-chevron">▾</span></button><div class="skill-accordion-desc" style="display:none;">${desc}</div></li>`;
            }).join('')
          : '<li class="tag-empty">No skills learned</li>';
        html += `<div class="status-section"><div class="status-label status-section-header">Skills</div><ul class="skill-accordion-list">${skillItems}</ul></div>`;
      }
    }
    if (e.type === 'achievements') {
      if (inGroup) { html += `</div>`; inGroup = false; }
      const achvs = getAchievements();
      if (achvs.length > 0) {
        // FIX #5: escape achievement text (from *achievement directive in scene files)
        const items = achvs.map(a => `<li class="journal-entry journal-entry--achievement"><span class="journal-achievement-icon">◆</span> ${escapeHtml(a.text)}</li>`).join('');
        html += `<div class="status-section"><div class="status-label status-section-header">Achievements</div><ul class="journal-list">${items}</ul></div>`;
      }
    }
    if (e.type === 'journal') {
      if (inGroup) { html += `</div>`; inGroup = false; }
      const jentries = getJournalEntries();
      if (jentries.length > 0) {
        // Show newest first in the sidebar
        const items = [...jentries].reverse().map(j => {
          const cls    = j.type === 'achievement' ? 'journal-entry journal-entry--achievement' : 'journal-entry';
          // FIX #5: escape journal text (from *journal directive in scene files)
          const prefix = j.type === 'achievement' ? '<span class="journal-achievement-icon">◆</span> ' : '';
          return `<li class="${cls}">${prefix}${escapeHtml(j.text)}</li>`;
        }).join('');
        html += `<div class="status-section"><div class="status-label status-section-header">Journal</div><ul class="journal-list">${items}</ul></div>`;
      }
    }
  });
  if (inGroup) html += `</div>`;

  // Level Up button — shown when the player can afford a level-up
  if (canLevelUp() && !levelUpInProgress) {
    html += `<div class="status-section status-levelup-section"><button class="status-levelup-btn" id="status-levelup-btn">⬡ Level Up</button></div>`;
  }

  _statusPanel.innerHTML = html;

  // Wire Level Up button
  const lvlBtn = _statusPanel.querySelector('#status-levelup-btn');
  if (lvlBtn) {
    lvlBtn.addEventListener('click', () => {
      showLevelUpModal();
    });
  }

  // Wire skill accordion toggles in the status panel
  _statusPanel.querySelectorAll('.skill-accordion-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const desc = btn.nextElementSibling;
      const isOpen = desc.style.display !== 'none';
      desc.style.display = isOpen ? 'none' : 'block';
      btn.classList.toggle('skill-accordion-btn--open', !isOpen);
    });
  });
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

      setLevelUpInProgress(false);
      hideLevelUpModal();
      _scheduleStats();

      if (_onLevelUpConfirmed) _onLevelUpConfirmed(newLevel);
      _showToast(`Reached Level ${newLevel}`);
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

function hideLevelUpModal() {
  if (!_levelUpOverlay) return;
  _levelUpOverlay.classList.add('hidden');
  _levelUpOverlay.style.opacity = '0';
  if (_trapRelease) { _trapRelease(); _trapRelease = null; }
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
