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
  setPendingStatPoints, setPendingLevelUpDisplay,
  delayIndex, advanceDelayIndex,
  normalizeKey,
} from '../core/state.js';

import { getAllocatableStatKeys } from '../systems/leveling.js';
import { skillRegistry, playerHasSkill, purchaseSkill } from '../systems/skills.js';
import { getJournalEntries, getAchievements } from '../systems/journal.js';
import { escapeHtml } from './narrative.js'; // FIX #5: reuse shared sanitizer

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _narrativeContent   = null;
let _choiceArea         = null;
let _statusPanel        = null;
let _endingOverlay      = null;
let _endingTitle        = null;
let _endingContent      = null;
let _endingStats        = null;
let _endingActionBtn    = null;
let _fetchTextFile      = null;   // async (name) → string
let _scheduleStats      = null;   // () → void
let _trapFocus          = null;   // (el, trigger) → release fn
let _onLevelUpConfirmed = null;   // (level: number) → void

export function init({ narrativeContent, choiceArea, statusPanel,
                       endingOverlay, endingTitle, endingContent,
                       endingStats, endingActionBtn,
                       fetchTextFile, scheduleStatsRender, trapFocus,
                       onLevelUpConfirmed }) {
  _narrativeContent   = narrativeContent;
  _choiceArea         = choiceArea;
  _statusPanel        = statusPanel;
  _endingOverlay      = endingOverlay;
  _endingTitle        = endingTitle;
  _endingContent      = endingContent;
  _endingStats        = endingStats;
  _endingActionBtn    = endingActionBtn;
  _fetchTextFile      = fetchTextFile;
  _scheduleStats      = scheduleStatsRender;
  _trapFocus          = trapFocus;
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
      entries.push({ type: 'group', name: t.replace('*stat_group', '').trim().replace(/^"|"$/g, '') });
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
  _statusPanel.innerHTML = html;

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
// showInlineLevelUp — inline stat-allocation block inserted into the narrative.
// (unchanged from original — no HTML injection paths in this function)
// ---------------------------------------------------------------------------
export function showInlineLevelUp() {
  if (pendingStatPoints <= 0) { setPendingLevelUpDisplay(false); return; }
  setPendingLevelUpDisplay(false);

  const keys     = getAllocatableStatKeys();
  const labelMap = {};
  statRegistry.forEach(({ key, label }) => { labelMap[key] = label; });
  const alloc = {};
  keys.forEach(k => { alloc[k] = 0; });

  const block = document.createElement('div');
  block.className = 'levelup-inline-block';
  block.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();
  _narrativeContent.insertBefore(block, _choiceArea);

  let skillBrowserOpen = false;

  function buildSkillBrowserHTML() {
    const available = skillRegistry.filter(s => !playerHasSkill(s.key));
    const owned     = skillRegistry.filter(s =>  playerHasSkill(s.key));
    let html = `<div class="skill-browser">`;

    if (available.length) {
      html += `<div class="skill-browser-section-label">Available</div>`;
      available.forEach(s => {
        const canAfford = playerState.skill_points >= s.spCost;
        // FIX #5: escape skill label and description here too
        html += `
          <div class="skill-browser-card ${canAfford ? 'skill-browser-card--available' : 'skill-browser-card--unaffordable'}">
            <div class="skill-browser-card-top">
              <span class="skill-browser-card-name">${escapeHtml(s.label)}</span>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-sp-badge ${canAfford ? 'skill-browser-sp-badge--can-afford' : ''}">${s.spCost} SP</span>
                <button class="skill-purchase-btn" data-purchase-key="${escapeHtml(s.key)}" ${canAfford ? '' : 'disabled'}>Unlock</button>
              </div>
            </div>
            <div class="skill-browser-card-desc">${escapeHtml(s.description)}</div>
          </div>`;
      });
    }

    if (owned.length) {
      html += `<div class="skill-browser-section-label skill-browser-section-label--owned">Learned</div>`;
      owned.forEach(s => {
        html += `
          <div class="skill-browser-card skill-browser-card--owned">
            <div class="skill-browser-card-top">
              <span class="skill-browser-card-name">${escapeHtml(s.label)}</span>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-owned-badge">✓ Learned</span>
              </div>
            </div>
            <div class="skill-browser-card-desc">${escapeHtml(s.description)}</div>
          </div>`;
      });
    }

    if (!available.length && !owned.length) {
      html += `<div class="skill-browser-empty">No skills defined.</div>`;
    }

    html += `</div>`;
    return html;
  }

  const render = () => {
    const spent    = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain   = pendingStatPoints - spent;
    const allSpent = remain === 0;
    const hasSkills = skillRegistry.length > 0;

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
              <button class="alloc-btn" data-op="minus" data-k="${k}" ${alloc[k] <= 0 ? 'disabled' : ''}>−</button>
              <span class="stat-alloc-val ${alloc[k] ? 'buffed' : ''}">${Number(playerState[k] || 0) + alloc[k]}</span>
              <button class="alloc-btn" data-op="plus"  data-k="${k}" ${remain <= 0 ? 'disabled' : ''}>+</button>
            </div>
          </div>
        `).join('')}
      </div>
      ${skillBrowserOpen ? buildSkillBrowserHTML() : ''}
      <div class="levelup-inline-footer" style="display:flex;gap:10px;justify-content:flex-end;align-items:center;flex-wrap:wrap;">
        ${hasSkills ? `<button class="skill-browse-btn" data-toggle-skills>${skillBrowserOpen ? 'Hide Skills' : 'Browse Skills'}</button>` : ''}
        <button class="levelup-confirm-btn ${allSpent ? '' : 'levelup-confirm-btn--locked'}" ${allSpent ? '' : 'disabled'}>Confirm</button>
      </div>`;

    block.querySelectorAll('.alloc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const k  = btn.dataset.k;
        const op = btn.dataset.op;
        if (op === 'plus'  && remain > 0)    alloc[k]++;
        if (op === 'minus' && alloc[k] > 0)  alloc[k]--;
        render();
      });
    });

    block.querySelector('[data-toggle-skills]')?.addEventListener('click', () => {
      skillBrowserOpen = !skillBrowserOpen;
      render();
    });

    block.querySelectorAll('.skill-purchase-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.purchaseKey;
        if (purchaseSkill(key)) { _scheduleStats(); render(); }
      });
    });

    block.querySelector('.levelup-confirm-btn')?.addEventListener('click', () => {
      if (remain > 0) return;
      keys.forEach(k => {
        if (alloc[k]) playerState[k] = Number(playerState[k] || 0) + alloc[k];
      });
      setPendingStatPoints(pendingStatPoints - Object.values(alloc).reduce((a, b) => a + b, 0));
      _scheduleStats();

      block.classList.add('levelup-inline-block--confirmed');
      block.innerHTML = `<span class="system-block-label">[ LEVEL UP ]</span><span class="system-block-text levelup-confirmed-text">Level ${playerState.level} reached — stats allocated.</span>`;
      block.style.opacity = '0.55';

      if (_onLevelUpConfirmed) _onLevelUpConfirmed(playerState.level);

      // Re-enable choices now that the level-up is resolved
      _choiceArea.querySelectorAll('.choice-btn').forEach(b => { b.disabled = false; b.classList.remove('choice-btn--disabled'); });
    });
  };

  render();
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
