// ui/panels.js — Stats panel, store, ending screen
//
// Renders the status sidebar with tabs (Stats, Skills, Inv, Log), the
// Essence-based store overlay, and the ending screen.
//
// All author-controlled strings rendered into innerHTML pass through
// escapeHtml() for defensive XSS prevention.

import {
  playerState, statRegistry,
  normalizeKey,
} from '../core/state.js';

import { getAllocatableStatKeys } from '../systems/leveling.js';
import { skillRegistry, playerHasSkill, purchaseSkill } from '../systems/skills.js';
import { itemRegistry, purchaseItem } from '../systems/items.js';
import { itemBaseName } from '../systems/inventory.js';
import { getJournalEntries, getAchievements } from '../systems/journal.js';
import { escapeHtml, formatText } from './narrative.js';
import { glossaryRegistry } from '../systems/glossary.js';
import { evalValue } from '../core/expression.js';
import type { SkillEntry } from '../systems/skills.js';
import type { ItemEntry } from '../systems/items.js';

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _statusPanel!:     HTMLElement;
let _endingOverlay:    HTMLElement | null = null;
let _endingTitle:      HTMLElement | null = null;
let _endingContent:    HTMLElement | null = null;
let _endingStats:      HTMLElement | null = null;
let _endingActionBtn:  HTMLElement | null = null;
let _storeOverlay:     HTMLElement | null = null;
let _fetchTextFile!:   (name: string) => Promise<string>;
let _scheduleStats!:   () => void;
let _trapFocus:        ((el: HTMLElement, trigger: HTMLElement | null) => (() => void)) | null = null;
let _showToast!:       (msg: string, duration?: number, rarity?: string) => void;

export function init({ statusPanel,
                       endingOverlay, endingTitle, endingContent,
                       endingStats, endingActionBtn,
                       storeOverlay,
                       fetchTextFile, scheduleStatsRender, trapFocus,
                       showToast }: {
  statusPanel:        HTMLElement;
  endingOverlay:      HTMLElement | null;
  endingTitle:        HTMLElement | null;
  endingContent:      HTMLElement | null;
  endingStats:        HTMLElement | null;
  endingActionBtn:    HTMLElement | null;
  storeOverlay:       HTMLElement | null;
  fetchTextFile:      (name: string) => Promise<string>;
  scheduleStatsRender: () => void;
  trapFocus:          ((el: HTMLElement, trigger: HTMLElement | null) => (() => void)) | null;
  showToast:          ((msg: string, duration?: number, rarity?: string) => void) | null;
}): void {
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
  _showToast          = showToast ?? (() => {});
}

// ---------------------------------------------------------------------------
// styleState — cached color / icon metadata parsed from stats.txt.
// ---------------------------------------------------------------------------
const styleState: { colors: Record<string, string>; icons: Record<string, string> } = { colors: {}, icons: {} };

// Active tab for the status panel — persists across re-renders
let _activeStatusTab = 'stats';

// ---------------------------------------------------------------------------
// Empty-state SVG illustrations — monochrome cyan outlines, 48×48 viewBox.
// ---------------------------------------------------------------------------
const EMPTY_SKILLS_SVG = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <polygon points="24,3 42,13.5 42,34.5 24,45 6,34.5 6,13.5" stroke="var(--cyan)" stroke-width="1.5"/>
  <circle cx="24" cy="24" r="9" stroke="var(--cyan)" stroke-width="1.2" opacity="0.5"/>
  <line x1="24" y1="15" x2="24" y2="33" stroke="var(--cyan)" stroke-width="1" opacity="0.4"/>
  <line x1="15.2" y1="19.5" x2="32.8" y2="28.5" stroke="var(--cyan)" stroke-width="1" opacity="0.4"/>
  <line x1="32.8" y1="19.5" x2="15.2" y2="28.5" stroke="var(--cyan)" stroke-width="1" opacity="0.4"/>
</svg>`;

const EMPTY_INV_SVG = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M17 19 C14 23 12 29 12 35 C12 41 17 45 24 45 C31 45 36 41 36 35 C36 29 34 23 31 19 Z" stroke="var(--cyan)" stroke-width="1.5"/>
  <path d="M19 19 C19 14 21 11 24 11 C27 11 29 14 29 19" stroke="var(--cyan)" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M21 13 C22 10 26 10 27 13" stroke="var(--cyan)" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="24" y1="29" x2="24" y2="38" stroke="var(--cyan)" stroke-width="1" opacity="0.4"/>
  <line x1="19.5" y1="33.5" x2="28.5" y2="33.5" stroke="var(--cyan)" stroke-width="1" opacity="0.4"/>
</svg>`;

const EMPTY_LOG_SVG = `<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="8" y="6" width="30" height="37" rx="2" stroke="var(--cyan)" stroke-width="1.5"/>
  <line x1="15" y1="6" x2="15" y2="43" stroke="var(--cyan)" stroke-width="1.5"/>
  <line x1="20" y1="17" x2="33" y2="17" stroke="var(--cyan)" stroke-width="1" opacity="0.5"/>
  <line x1="20" y1="23" x2="33" y2="23" stroke="var(--cyan)" stroke-width="1" opacity="0.5"/>
  <line x1="20" y1="29" x2="33" y2="29" stroke="var(--cyan)" stroke-width="1" opacity="0.5"/>
  <line x1="20" y1="35" x2="28" y2="35" stroke="var(--cyan)" stroke-width="1" opacity="0.4"/>
  <path d="M35 30 Q39 33 35 36" stroke="var(--cyan)" stroke-width="1.5" stroke-linecap="round" fill="none"/>
</svg>`;

// Snapshot of last-known numeric stat values for diff / flash tracking.
const _prevStatValues: Map<string, number> = new Map();

// Pending stat-change flash directions — populated during render, consumed when
// the Stats tab is active (immediately or on next tab switch).
const _statChanges: Map<string, 'up' | 'down'> = new Map();

// Dirty flags — when true the tab needs a fresh HTML build.
const _dirtyTabs: Record<string, boolean> = {
  stats: true, skills: true, inventory: true, achievements: true,
};

// Module-level entries array from the most recent stats.txt parse.
// Stored so deferred (lazy) tab builds can access stat data without
// re-reading the file.
type StatsEntry = { type: string; name?: string; key?: string; label?: string };
let _lastEntries: StatsEntry[] = [];

// ---------------------------------------------------------------------------
// Per-tab HTML builders
// ---------------------------------------------------------------------------

function buildStatsTabHtml(entries: StatsEntry[]): string {
  let html = '';
  let inGroup = false;
  entries.forEach(e => {
    if (e.type === 'group') {
      if (inGroup) html += `</div>`;
      html += `<div class="status-section"><div class="status-label status-section-header">${escapeHtml(e.name)}</div>`;
      inGroup = true;
    }
    if (e.type === 'stat' && e.key) {
      const cc = styleState.colors[e.key] || '';
      const ic = styleState.icons[e.key]  ?? '';
      const rawVal = playerState[e.key] ?? '—';
      // Track stat changes vs previous render
      const numVal = parseFloat(String(rawVal));
      if (!isNaN(numVal)) {
        const prev = _prevStatValues.get(e.key);
        _prevStatValues.set(e.key, numVal);
        if (prev !== undefined && prev !== numVal) {
          _statChanges.set(e.key, numVal > prev ? 'up' : 'down');
        }
      }
      html += `<div class="status-row" data-stat-key="${e.key}"><span class="status-label">${ic ? ic + ' ' : ''}${escapeHtml(e.label)}</span><span class="status-value ${cc}">${formatText(String(rawVal))}</span></div>`;
    }
  });
  if (inGroup) html += `</div>`;

  const achvsForStats = getAchievements();
  if (achvsForStats.length > 0) {
    const achvAccordions = achvsForStats.map(a => {
      const dashIdx = a.text.indexOf(' — ');
      const title   = dashIdx !== -1 ? escapeHtml(a.text.slice(0, dashIdx)) : escapeHtml(a.text);
      const body    = dashIdx !== -1 ? escapeHtml(a.text.slice(dashIdx + 3)) : '';
      return `<li class="skill-accordion skill-accordion--achievement">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name"><span class="journal-achievement-icon"></span>${title}</span>
          ${body ? `<span class="skill-accordion-chevron">▾</span>` : ''}
        </button>
        ${body ? `<div class="skill-accordion-desc" style="display:none;">${body}</div>` : ''}
      </li>`;
    }).join('');
    html += `<div class="status-section"><div class="status-label status-section-header">Achievements</div><ul class="skill-accordion-list">${achvAccordions}</ul></div>`;
  }
  return html;
}

function buildSkillsTabHtml(): string {
  const hasSkillStore = skillRegistry.length > 0;
  let html = hasSkillStore
    ? `<div class="status-store-row"><button class="status-store-btn" id="status-store-btn-skills" data-store-tab="skills">Skill Store</button></div>`
    : '';

  const ownedSkills = Array.isArray(playerState.skills) ? playerState.skills : [];
  if (ownedSkills.length === 0) {
    html += `<div class="empty-state">${EMPTY_SKILLS_SVG}<p class="empty-state-text">No skills learned yet.</p></div>`;
  } else {
    const skillItems = ownedSkills.map((k: string) => {
      const entry   = skillRegistry.find(s => s.key === k);
      const label   = escapeHtml(entry ? entry.label : k);
      const desc    = escapeHtml(entry ? entry.description : '');
      const rarity  = entry?.rarity || 'common';
      const rarCls  = ` skill-rarity--${rarity}`;
      return `<li class="skill-accordion skill-accordion--rarity-${rarity}"><button class="skill-accordion-btn" data-skill-key="${escapeHtml(k)}"><span class="skill-accordion-name${rarCls}">${label}</span><span class="skill-accordion-chevron">▾</span></button><div class="skill-accordion-desc" style="display:none;">${desc}</div></li>`;
    }).join('');
    html += `<ul class="skill-accordion-list">${skillItems}</ul>`;
  }
  return html;
}

function buildInventoryTabHtml(): string {
  const hasItemStore = itemRegistry.length > 0;
  let html = hasItemStore
    ? `<div class="status-store-row"><button class="status-store-btn" id="status-store-btn-inv" data-store-tab="items">Item Store</button></div>`
    : '';

  const invItems = Array.isArray(playerState.inventory) ? playerState.inventory : [];
  if (invItems.length === 0) {
    html += `<div class="empty-state">${EMPTY_INV_SVG}<p class="empty-state-text">Nothing here yet.</p></div>`;
  } else {
    const invAccordions = invItems.map((invEntry: string) => {
      const baseName = itemBaseName(invEntry);
      const regEntry = itemRegistry.find(r => r.label === baseName);
      const label    = escapeHtml(invEntry);
      const desc     = escapeHtml(regEntry ? regEntry.description : '');
      const rarity   = regEntry?.rarity || 'common';
      const rarCls   = ` skill-rarity--${rarity}`;
      return `<li class="skill-accordion skill-accordion--rarity-${rarity}">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name${rarCls}">${label}</span>
          <span class="skill-accordion-chevron">▾</span>
        </button>
        <div class="skill-accordion-desc" style="display:none;">${desc || '<em style="color:var(--text-faint)">No description available.</em>'}</div>
      </li>`;
    }).join('');
    html += `<ul class="skill-accordion-list">${invAccordions}</ul>`;
  }
  return html;
}

function buildLogTabHtml(): string {
  let achievementsHtml = '';
  const achvs    = getAchievements();
  const jentries = getJournalEntries().filter(j => j.type !== 'achievement');

  if (achvs.length === 0 && jentries.length === 0) {
    return `<div class="empty-state">${EMPTY_LOG_SVG}<p class="empty-state-text">Nothing recorded yet.</p></div>`;
  }
  if (achvs.length > 0) {
    const achvAccordionItems = achvs.map(a => {
      const dashIdx = a.text.indexOf(' — ');
      const title   = dashIdx !== -1 ? escapeHtml(a.text.slice(0, dashIdx)) : escapeHtml(a.text);
      const body    = dashIdx !== -1 ? escapeHtml(a.text.slice(dashIdx + 3)) : '';
      return `<li class="skill-accordion skill-accordion--achievement">
          <button class="skill-accordion-btn">
            <span class="skill-accordion-name"><span class="journal-achievement-icon"></span>${title}</span>
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
  if (glossaryRegistry.length > 0) {
    const glossaryItems = glossaryRegistry.map(entry =>
      `<li class="skill-accordion">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name">${escapeHtml(entry.term)}</span>
          <span class="skill-accordion-chevron">▾</span>
        </button>
        <div class="skill-accordion-desc" style="display:none;">${escapeHtml(entry.description)}</div>
      </li>`
    ).join('');
    achievementsHtml += `<div class="status-label status-section-header" style="margin-bottom:8px;margin-top:14px;">Glossary</div><ul class="skill-accordion-list">${glossaryItems}</ul>`;
  }
  return achievementsHtml;
}

function buildTabHtml(tabKey: string, entries: StatsEntry[]): string {
  switch (tabKey) {
    case 'stats':        return buildStatsTabHtml(entries);
    case 'skills':       return buildSkillsTabHtml();
    case 'inventory':    return buildInventoryTabHtml();
    case 'achievements': return buildLogTabHtml();
    default:             return '';
  }
}

// Apply pending stat-change flash animations to the Stats tab DOM.
function applyStatFlashes(): void {
  if (_statChanges.size === 0) return;
  _statChanges.forEach((dir, key) => {
    const row   = _statusPanel.querySelector<HTMLElement>(`.status-row[data-stat-key="${key}"]`);
    const valEl = row?.querySelector<HTMLElement>('.status-value');
    if (valEl) {
      const cls = dir === 'up' ? 'stat-flash--up' : 'stat-flash--down';
      valEl.classList.add(cls);
      valEl.addEventListener('animationend', () => valEl.classList.remove(cls), { once: true });
    }
  });
  _statChanges.clear();
}

function wireTabContent(): void {
  const skillsStoreBtn = _statusPanel.querySelector('#status-store-btn-skills');
  if (skillsStoreBtn) skillsStoreBtn.addEventListener('click', () => showStore('skills'));
  const invStoreBtn = _statusPanel.querySelector('#status-store-btn-inv');
  if (invStoreBtn) invStoreBtn.addEventListener('click', () => showStore('items'));
  _statusPanel.querySelectorAll<HTMLElement>('.skill-accordion-btn').forEach(btn => {
    const desc = btn.nextElementSibling as HTMLElement | null;
    if (!desc) return;
    btn.addEventListener('click', () => {
      const isOpen = desc.style.display !== 'none';
      desc.style.display = isOpen ? 'none' : 'block';
      btn.classList.toggle('skill-accordion-btn--open', !isOpen);
    });
  });
}

// ---------------------------------------------------------------------------
// runStatsScene — parses stats.txt, marks all tabs dirty, rebuilds only the
// active tab immediately; other tabs rebuild lazily on first switch.
// ---------------------------------------------------------------------------
export async function runStatsScene(): Promise<void> {
  const text  = await _fetchTextFile('stats');
  const lines = text.split(/\r?\n/).map(raw => ({ raw, trimmed: raw.trim() }));
  styleState.colors = {};
  styleState.icons  = {};

  const entries: StatsEntry[] = [];
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

  _lastEntries = entries;

  // Mark all tabs dirty — they need fresh HTML for the new game state.
  Object.keys(_dirtyTabs).forEach(k => { _dirtyTabs[k] = true; });

  // Build the tab bar (always stable) and render only the active tab.
  const tabs = [
    { key: 'stats',        label: 'Stats' },
    { key: 'skills',       label: 'Skills' },
    { key: 'inventory',    label: 'Inv' },
    { key: 'achievements', label: 'Log' },
  ];

  const tabBarHtml = `<div class="status-tabs" role="tablist" id="status-tab-bar">
    ${tabs.map(t => `<button role="tab" aria-selected="${_activeStatusTab === t.key}" aria-controls="status-tab-pane" id="tab-${t.key}" class="status-tab ${_activeStatusTab === t.key ? 'status-tab--active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
  </div>`;

  const activeHtml = buildTabHtml(_activeStatusTab, entries);
  _dirtyTabs[_activeStatusTab] = false;

  _statusPanel.innerHTML = `${tabBarHtml}<div role="tabpanel" aria-labelledby="tab-${_activeStatusTab}" class="status-tab-content" id="status-tab-pane">${activeHtml}</div>`;

  // Wire tab switching with lazy rebuild
  _statusPanel.querySelectorAll<HTMLElement>('.status-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeStatusTab = btn.dataset.tab ?? 'stats';
      _statusPanel.querySelectorAll<HTMLElement>('.status-tab').forEach(b => {
        b.classList.toggle('status-tab--active', b.dataset.tab === _activeStatusTab);
        b.setAttribute('aria-selected', b.dataset.tab === _activeStatusTab ? 'true' : 'false');
      });
      const pane = _statusPanel.querySelector('#status-tab-pane');
      if (pane) {
        pane.setAttribute('aria-labelledby', `tab-${_activeStatusTab}`);
        if (_dirtyTabs[_activeStatusTab]) {
          pane.innerHTML = buildTabHtml(_activeStatusTab, _lastEntries);
          _dirtyTabs[_activeStatusTab] = false;
        }
        if (_activeStatusTab === 'stats') applyStatFlashes();
      }
      wireTabContent();
    });
  });

  wireTabContent();

  // Apply flash animations if Stats is the active tab right now.
  if (_activeStatusTab === 'stats') applyStatFlashes();
}

// ---------------------------------------------------------------------------
// Store system — full-screen overlay with Skills and Items tabs
// ---------------------------------------------------------------------------
let _storeTrapRelease: (() => void) | null = null;
let _storeActiveTab   = 'skills';
let _preStoreTab:     string | null = null;

export function showStore(tab: string | null = null): void {
  if (!_storeOverlay) return;
  if (tab) _storeActiveTab = tab;
  _preStoreTab = _activeStatusTab;

  const overlay = _storeOverlay;
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
  });

  if (_trapFocus) {
    _storeTrapRelease = _trapFocus(overlay, null);
  }

  renderStore();
}

function hideStore(): void {
  if (!_storeOverlay) return;
  _storeOverlay.classList.add('hidden');
  _storeOverlay.style.opacity = '0';
  if (_storeTrapRelease) { _storeTrapRelease(); _storeTrapRelease = null; }
  _activeStatusTab = _preStoreTab || (_storeActiveTab === 'items' ? 'inventory' : 'skills');
  _preStoreTab = null;
  _scheduleStats();
  requestAnimationFrame(() => {
    if (_statusPanel) {
      _statusPanel.classList.add('status-visible');
      _statusPanel.classList.remove('status-hidden');
    }
  });
}

function renderStore(): void {
  if (!_storeOverlay) return;
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

  box.querySelector('#store-close-btn')?.addEventListener('click', hideStore);

  box.querySelectorAll<HTMLElement>('.store-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      _storeActiveTab = tab.dataset.tab ?? 'skills';
      renderStore();
    });
  });

  const content = box.querySelector('#store-content');
  if (!content) return;
  if (_storeActiveTab === 'skills') {
    renderSkillsTab(content, essence);
  } else {
    renderItemsTab(content, essence);
  }

  requestAnimationFrame(() => {
    (box.querySelector('#store-close-btn') as HTMLElement | null)?.focus({ preventScroll: true });
  });
}

function renderSkillsTab(container: Element, essence: number): void {
  if (skillRegistry.length === 0) {
    container.innerHTML = `<div class="store-empty">No skills available.</div>`;
    return;
  }

  const visible = skillRegistry.filter(s => {
    if (!s.condition) return true;
    try { return !!evalValue(s.condition); } catch { return true; }
  });

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
      const rarCls    = ` skill-rarity--${rarity}`;
      html += `
        <div class="store-card store-card--rarity-${rarity} ${cardCls}" data-key="${escapeHtml(skill.key)}" data-type="skill">
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
      const rarCls = ` skill-rarity--${rarity}`;
      html += `
        <div class="store-card store-card--rarity-${rarity} store-card--owned" data-key="${escapeHtml(skill.key)}">
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

  container.querySelectorAll<HTMLElement>('.store-purchase-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key ?? '';
      if (purchaseSkill(key)) {
        const entry = skillRegistry.find(s => s.key === key);
        _showToast(`Skill unlocked: ${entry?.label || key}`, 2500, entry?.rarity);
        renderStore();
      }
    });
  });
}

function renderItemsTab(container: Element, essence: number): void {
  if (itemRegistry.length === 0) {
    container.innerHTML = `<div class="store-empty">No items available.</div>`;
    return;
  }

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
    const rarCls    = ` skill-rarity--${rarity}`;
    html += `
      <div class="store-card store-card--rarity-${rarity} ${cardCls}" data-key="${escapeHtml(item.key)}" data-type="item">
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

  container.querySelectorAll<HTMLElement>('.store-purchase-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key ?? '';
      if (purchaseItem(key)) {
        const entry = itemRegistry.find(i => i.key === key);
        _showToast(`Purchased: ${entry?.label || key}`, 2500, entry?.rarity);
        renderStore();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// showEndingScreen
// ---------------------------------------------------------------------------
export function showEndingScreen(title: string, content: string): void {
  if (!_endingOverlay) return;
  if (_endingTitle)   _endingTitle.textContent   = title;
  if (_endingContent) _endingContent.textContent = content;

  const statsLines: string[] = [];
  statRegistry.forEach(({ key, label }) => {
    statsLines.push(`${label}: ${playerState[key] ?? '—'}`);
  });
  if (_endingStats) _endingStats.textContent = statsLines.join('  ·  ');

  _endingOverlay.classList.remove('hidden');
  _endingOverlay.style.opacity = '1';
  if (_trapFocus) {
    const release = _trapFocus(_endingOverlay, null);
    (_endingOverlay as any)._trapRelease = release;
  }

  _endingActionBtn?.addEventListener('click', () => {
    window.location.reload();
  }, { once: true });
}
