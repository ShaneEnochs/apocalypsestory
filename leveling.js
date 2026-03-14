// ---------------------------------------------------------------------------
// systems/leveling.js — XP, level-up, and system reward parsing
//
// checkAndApplyLevelUp and applySystemRewards both accept an optional
// onChanged callback. When state changes, they call onChanged() — which
// engine.js wires to scheduleStatsRender(). This avoids a circular import
// with the UI layer while keeping the dependency explicit.
// ---------------------------------------------------------------------------

import { playerState, statRegistry,
         addPendingStatPoints, addPendingLevelUpCount,
         setPendingLevelUpDisplay }            from '../core/state.js';
import { addInventoryItem,
         parseInventoryUpdateText }            from './inventory.js';

// ---------------------------------------------------------------------------
// getAllocatableStatKeys — returns the ordered list of stat keys from the
// registry. Used by applySystemRewards and the level-up allocation UI.
// ---------------------------------------------------------------------------
export function getAllocatableStatKeys() {
  return statRegistry.map(e => e.key);
}

// ---------------------------------------------------------------------------
// checkAndApplyLevelUp — runs after any XP change.
//
// Increments level and awards stat points for each level threshold crossed.
// Guards against xp_to_next reaching zero (infinite loop risk).
// Calls onChanged() if any level-up occurred.
// ---------------------------------------------------------------------------
export function checkAndApplyLevelUp(onChanged) {
  if (!Number(playerState.xp_to_next || 0)) return;

  const mult      = Number(playerState.xp_up_mult       ?? 2.2);
  const gain      = Number(playerState.lvl_up_stat_gain  ?? 5);
  const skillGain = Number(playerState.lvl_up_skill_gain ?? 0);
  let changed = false;

  while (Number(playerState.xp) >= Number(playerState.xp_to_next)) {
    playerState.level      = Number(playerState.level || 0) + 1;
    playerState.xp_to_next = Math.floor(Number(playerState.xp_to_next) * mult);
    addPendingStatPoints(gain);
    addPendingLevelUpCount(1);
    // Award skill points — accumulate in playerState, spent via skill browser
    if (skillGain > 0) {
      playerState.skill_points = Number(playerState.skill_points || 0) + skillGain;
    }
    changed = true;
  }

  if (changed) {
    setPendingLevelUpDisplay(true);
    if (typeof onChanged === 'function') onChanged();
  }
}

// ---------------------------------------------------------------------------
// applySystemRewards — parses a system block string for structured rewards
// (XP gains, stat buffs, vital increases, inventory updates) and applies them
// directly to playerState.
//
// XP deduplication: tracks position ranges to avoid double-counting when two
// regex patterns match the same text (fix #3 from sweep 2).
// ---------------------------------------------------------------------------
export function applySystemRewards(text, onChanged) {
  let stateChanged = false;

  // --- XP ---
  const xpRanges = [];
  for (const pattern of [
    /XP\s+gained\s*:\s*\+\s*(\d+)/gi,
    /\+[^\S\n]*(\d+)[^\S\n]*(?:bonus[^\S\n]+)?XP\b/gi,
  ]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount) && amount > 0) {
        xpRanges.push({ start: match.index, end: match.index + match[0].length, amount });
      }
    }
  }
  // Sort and de-overlap before summing
  xpRanges.sort((a, b) => a.start - b.start);
  let lastEnd = -1, gainedTotal = 0;
  for (const r of xpRanges) {
    if (r.start >= lastEnd) { gainedTotal += r.amount; lastEnd = r.end; }
  }
  if (gainedTotal > 0) {
    playerState.xp = Number(playerState.xp || 0) + gainedTotal;
    checkAndApplyLevelUp(onChanged);
    stateChanged = true;
  }

  // --- +N to all stats ---
  const allStatsM = text.match(/\+\s*(\d+)\s+to\s+all\s+stats?/i);
  if (allStatsM) {
    const b = Number(allStatsM[1]);
    if (b > 0) {
      getAllocatableStatKeys().forEach(k => { playerState[k] = Number(playerState[k] || 0) + b; });
      stateChanged = true;
    }
  }

  // --- Vitals (health, mana, max_mana) + per-stat patterns ---
  const vitals = [
    { regex: /\+\s*(\d+)\s+max\s+mana\b/i, key: 'max_mana' },
    { regex: /\+\s*(\d+)\s+mana\b/i,       key: 'mana'     },
    { regex: /\+\s*(\d+)\s+health\b/i,     key: 'health'   },
  ];

  const statPatterns = [];
  statRegistry.forEach(({ key, label }) => {
    const el = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${el}\\b`, 'i'), key });
    // Also match by key name in case the label uses different casing / spacing
    const nk = key.toLowerCase(), nl = label.toLowerCase().replace(/\s+/g, '_');
    if (nk !== nl) {
      const ek = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _]');
      statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${ek}\\b`, 'i'), key });
    }
  });

  [...vitals, ...statPatterns].forEach(({ regex, key }) => {
    const m2 = text.match(regex);
    if (!m2) return;
    const b = Number(m2[1]);
    if (b > 0) { playerState[key] = Number(playerState[key] || 0) + b; stateChanged = true; }
  });

  // --- Inventory ---
  parseInventoryUpdateText(text).forEach(item => {
    if (addInventoryItem(item)) stateChanged = true;
  });

  if (stateChanged && typeof onChanged === 'function') onChanged();
}