// ---------------------------------------------------------------------------
// ui/panels.js — Stats panel, level-up allocation, ending screen
//
// Owns the three "display" panels that reflect game state:
//   runStatsScene     — builds the status sidebar from stats.txt
//   showInlineLevelUp — inline stat-allocation block in the narrative
//   showEndingScreen  — final overlay shown on *ending
//
// Deferred item resolved here: pendingLevelUpDisplay is no longer read as
// a standalone flag inside showInlineLevelUp / renderChoices. Instead,
// the flag is still set by leveling.js (it's the signal that a level-up
// occurred), but the *decision* of whether to show the UI is made by
// checking pendingStatPoints > 0 at render time, which is the ground truth.
// pendingLevelUpDisplay is cleared immediately when showInlineLevelUp runs
// so repeated calls are no-ops until the next level-up.
//
// DOM nodes and cross-module callbacks are injected at boot via init().
//
// Dependency graph:
//   panels.js
//     → state.js       (playerState, statRegistry, pendingStatPoints, …)
//     → leveling.js    (getAllocatableStatKeys)
//     ← main.js        (injects dom slice + callbacks via init())
// ---------------------------------------------------------------------------

import {
  playerState, statRegistry,
  pendingStatPoints,
  setPendingStatPoints, setPendingLevelUpDisplay,
  delayIndex, advanceDelayIndex,
  normalizeKey,
} from '../core/state.js';

import { getAllocatableStatKeys } from '../systems/leveling.js';

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _narrativeContent = null;
let _choiceArea       = null;
let _statusPanel      = null;
let _endingOverlay    = null;
let _endingTitle      = null;
let _endingContent    = null;
let _endingStats      = null;
let _endingActionBtn  = null;
let _fetchTextFile    = null;   // async (name) → string
let _scheduleStats    = null;   // () → void
let _trapFocus        = null;   // (el, trigger) → release fn

export function init({ narrativeContent, choiceArea, statusPanel,
                       endingOverlay, endingTitle, endingContent,
                       endingStats, endingActionBtn,
                       fetchTextFile, scheduleStatsRender, trapFocus }) {
  _narrativeContent = narrativeContent;
  _choiceArea       = choiceArea;
  _statusPanel      = statusPanel;
  _endingOverlay    = endingOverlay;
  _endingTitle      = endingTitle;
  _endingContent    = endingContent;
  _endingStats      = endingStats;
  _endingActionBtn  = endingActionBtn;
  _fetchTextFile    = fetchTextFile;
  _scheduleStats    = scheduleStatsRender;
  _trapFocus        = trapFocus;
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
      html += `<div class="status-section"><div class="status-label status-section-header">${e.name}</div>`;
      inGroup = true;
    }
    if (e.type === 'stat') {
      const cc = styleState.colors[e.key] || '';
      const ic = styleState.icons[e.key]  ?? '';
      html += `<div class="status-row"><span class="status-label">${ic ? ic + ' ' : ''}${e.label}</span><span class="status-value ${cc}">${playerState[e.key] ?? '—'}</span></div>`;
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
  _statusPanel.innerHTML = html;
}

// ---------------------------------------------------------------------------
// showInlineLevelUp — inline stat-allocation block inserted into the narrative.
//
// Deferred-item resolution: the check `pendingStatPoints > 0` is the
// authoritative guard. pendingLevelUpDisplay is cleared here immediately so
// callers that test the flag (addSystem, renderChoices) don't re-enter.
//
// The block closes choices until all points are allocated, then re-enables
// them and triggers a stats panel refresh.
// ---------------------------------------------------------------------------
export function showInlineLevelUp() {
  // Clear the trigger flag immediately — prevents re-entry from addSystem /
  // renderChoices if either is called again before the block is dismissed.
  setPendingLevelUpDisplay(false);

  // Guard: nothing to allocate (can happen if called spuriously)
  if (pendingStatPoints <= 0) return;

  const keys     = getAllocatableStatKeys();
  const labelMap = Object.fromEntries(statRegistry.map(({ key, label }) => [key, label]));
  const alloc    = Object.fromEntries(keys.map(k => [k, 0]));

  const block = document.createElement('div');
  block.className = 'levelup-inline-block';
  block.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();
  _narrativeContent.insertBefore(block, _choiceArea);

  // Disable non-unselectable choice buttons while points are unspent
  _choiceArea.querySelectorAll('button').forEach(b => {
    if (!b.dataset.unselectable) b.disabled = true;
  });
  if (_choiceArea.querySelector('button')) {
    const ov = document.createElement('div');
    ov.className = 'levelup-choice-overlay';
    ov.innerHTML = `<span>↑ Allocate your stat points before continuing</span>`;
    _choiceArea.appendChild(ov);
  }

  const render = () => {
    const spent    = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain   = pendingStatPoints - spent;
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
              <button class="alloc-btn" data-op="plus"  data-k="${k}" ${remain <= 0 ? 'disabled' : ''}>+</button>
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

    block.querySelectorAll('.alloc-btn').forEach(btn => {
      btn.onclick = () => {
        const k = btn.dataset.k;
        const s = Object.values(alloc).reduce((a, b) => a + b, 0);
        if (btn.dataset.op === 'plus'  && s < pendingStatPoints) alloc[k] += 1;
        if (btn.dataset.op === 'minus' && alloc[k] > 0)          alloc[k] -= 1;
        render();
      };
    });

    block.querySelector('[data-confirm]').onclick = () => {
      if (Object.values(alloc).reduce((a, b) => a + b, 0) < pendingStatPoints) return;
      Object.entries(alloc).forEach(([k, v]) => {
        playerState[k] = Number(playerState[k] || 0) + v;
      });
      setPendingStatPoints(0);
      block.innerHTML = `<span class="system-block-label">[ LEVEL UP ]</span><span class="system-block-text levelup-confirmed-text">Level ${playerState.level} reached — stats allocated.</span>`;
      block.classList.add('levelup-inline-block--confirmed');
      const ov = _choiceArea.querySelector('.levelup-choice-overlay');
      if (ov) ov.remove();
      _choiceArea.querySelectorAll('button').forEach(b => {
        if (!b.dataset.unselectable) b.disabled = false;
      });
      _scheduleStats();
    };
  };

  render();
}

// ---------------------------------------------------------------------------
// showEndingScreen — final overlay on *ending directive
// ---------------------------------------------------------------------------
export function showEndingScreen(title, subtitle) {
  _endingTitle.textContent   = title;
  _endingContent.textContent = subtitle;
  _endingStats.innerHTML     = `Level: ${playerState.level || 0}<br>XP: ${playerState.xp || 0}<br>Class: ${playerState.class_name || 'Unclassed'}`;
  _endingActionBtn.textContent = 'Play Again';
  _endingActionBtn.onclick     = () => location.reload();
  _endingOverlay.classList.remove('hidden');
  _endingOverlay.style.opacity = '1';
  _trapFocus(_endingOverlay, null);
}
