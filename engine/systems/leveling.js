// ---------------------------------------------------------------------------
// systems/leveling.js — Essence, level-up, and system reward parsing
//
// Essence is the unified currency: it pays for leveling up, purchasing skills,
// and purchasing items.  Level-ups are manual (triggered by the player via the
// Level Up button in the status panel, which opens a modal).
//
// canLevelUp() — returns true when the player has enough essence.
// performLevelUp() — executes exactly one level-up (deducts essence, awards
//   stat points).  Called by the level-up modal.
//
// applySystemRewards parses "Essence gained:" patterns in system block text.
//
// BUG-01 fix: health supports string OR number (unchanged from original).
// ---------------------------------------------------------------------------

import { playerState, statRegistry,
         addPendingStatPoints }                  from '../core/state.js';
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
// canLevelUp — returns true if the player has enough essence to level up.
// Used by the status panel to show/hide the Level Up button.
// ---------------------------------------------------------------------------
export function canLevelUp() {
  const toNext = Number(playerState.essence_to_next || 0);
  if (toNext <= 0) return false;
  return Number(playerState.essence || 0) >= toNext;
}

// ---------------------------------------------------------------------------
// performLevelUp — executes exactly ONE level-up.
//
// Subtracts essence_to_next from essence, increments level, scales the
// threshold by the multiplier, and awards stat points.  Returns the new
// level number, or null if the player can't afford a level-up.
//
// The caller (the level-up modal) is responsible for presenting the stat
// allocation UI and calling onChanged to refresh the panel.
// ---------------------------------------------------------------------------
export function performLevelUp(onChanged) {
  if (!canLevelUp()) return null;

  const mult = Number(playerState.essence_up_mult ?? 2.2);
  const gain = Number(playerState.lvl_up_stat_gain ?? 5);

  // Deduct essence
  playerState.essence = Number(playerState.essence || 0) - Number(playerState.essence_to_next);

  // Advance level
  playerState.level = Number(playerState.level || 0) + 1;

  // Scale threshold
  playerState.essence_to_next = Math.floor(Number(playerState.essence_to_next) * mult);

  // Award stat points
  addPendingStatPoints(gain);

  if (typeof onChanged === 'function') onChanged();
  return playerState.level;
}

// ---------------------------------------------------------------------------
// applyVitalNumeric — (unchanged)
// ---------------------------------------------------------------------------
function applyVitalNumeric(key, b) {
  if (key === 'health') {
    if (typeof playerState[key] === 'string') {
      playerState[key] = b >= 0 ? b : 0;
    } else {
      playerState[key] = Number(playerState[key] || 0) + b;
    }
  } else {
    playerState[key] = Number(playerState[key] || 0) + b;
  }
}

// ---------------------------------------------------------------------------
// applySystemRewards — parses a system block string for structured rewards.
//
// Matches "Essence gained: +100" and "+100 Essence" patterns.
// All matched amounts are applied to playerState.essence.
// ---------------------------------------------------------------------------
export function applySystemRewards(text, onChanged) {
  let stateChanged = false;

  // --- Essence ---
  const essenceRanges = [];
  for (const pattern of [
    /Essence\s+gained\s*:\s*\+\s*(\d+)/gi,
    /\+[^\S\n]*(\d+)[^\S\n]*(?:bonus[^\S\n]+)?Essence\b/gi,
  ]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount) && amount > 0) {
        essenceRanges.push({ start: match.index, end: match.index + match[0].length, amount });
      }
    }
  }
  // Sort and de-overlap before summing
  essenceRanges.sort((a, b) => a.start - b.start);
  let lastEnd = -1, gainedTotal = 0;
  for (const r of essenceRanges) {
    if (r.start >= lastEnd) { gainedTotal += r.amount; lastEnd = r.end; }
  }
  if (gainedTotal > 0) {
    playerState.essence = Number(playerState.essence || 0) + gainedTotal;
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
    { regex: /\+\s*(\d+)\s+max\s+mana\b/i,  key: 'max_mana', sign:  1 },
    { regex: /\-\s*(\d+)\s+max\s+mana\b/i,  key: 'max_mana', sign: -1 },
    { regex: /\+\s*(\d+)\s+mana\b/i,         key: 'mana',     sign:  1 },
    { regex: /\-\s*(\d+)\s+mana\b/i,         key: 'mana',     sign: -1 },
    { regex: /\+\s*(\d+)\s+health\b/i,       key: 'health',   sign:  1 },
    { regex: /\-\s*(\d+)\s+health\b/i,       key: 'health',   sign: -1 },
  ];

  const statPatterns = [];
  statRegistry.forEach(({ key, label }) => {
    const el = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${el}\\b`, 'i'), key, sign:  1 });
    statPatterns.push({ regex: new RegExp(`\\-\\s*(\\d+)\\s+${el}\\b`, 'i'), key, sign: -1 });
    const nk = key.toLowerCase(), nl = label.toLowerCase().replace(/\s+/g, '_');
    if (nk !== nl) {
      const ek = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[ _]');
      statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${ek}\\b`, 'i'), key, sign:  1 });
      statPatterns.push({ regex: new RegExp(`\\-\\s*(\\d+)\\s+${ek}\\b`, 'i'), key, sign: -1 });
    }
  });

  [...vitals, ...statPatterns].forEach(({ regex, key, sign }) => {
    const m2 = text.match(regex);
    if (!m2) return;
    const b = Number(m2[1]);
    if (b > 0) {
      applyVitalNumeric(key, b * sign);
      stateChanged = true;
    }
  });

  // --- Inventory ---
  parseInventoryUpdateText(text).forEach(item => {
    if (addInventoryItem(item)) stateChanged = true;
  });

  if (stateChanged && typeof onChanged === 'function') onChanged();
}
