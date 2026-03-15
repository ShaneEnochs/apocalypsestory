// ---------------------------------------------------------------------------
// systems/leveling.js — Essence, level-up, and system reward parsing
//
// Essence is the unified currency: it pays for leveling up, purchasing skills,
// and purchasing items.  Level-ups are manual (triggered by the player) but
// this module still exposes canLevelUp() for the UI to check eligibility and
// performLevelUp() for the UI to execute a single level-up.
//
// checkAndApplyLevelUp is kept for backward compatibility with
// applySystemRewards — it no longer auto-levels; it just flags that a
// level-up is available so the UI can show the button.
//
// applySystemRewards parses both legacy "XP" and new "Essence" patterns in
// system block text so existing scene content continues to work.
//
// BUG-01 fix: health supports string OR number (unchanged from original).
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
  addPendingLevelUpCount(1);

  if (typeof onChanged === 'function') onChanged();
  return playerState.level;
}

// ---------------------------------------------------------------------------
// checkAndApplyLevelUp — called after essence gains.
//
// In the new manual system this no longer auto-levels.  It simply checks
// whether the player CAN level up and sets pendingLevelUpDisplay so the UI
// can show a notification or button.
// ---------------------------------------------------------------------------
export function checkAndApplyLevelUp(onChanged) {
  if (canLevelUp()) {
    setPendingLevelUpDisplay(true);
    if (typeof onChanged === 'function') onChanged();
  }
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
// Supports BOTH legacy "XP" patterns and new "Essence" patterns so existing
// scene content continues to work without modification.
//   Legacy:  "XP gained: +100"  or  "+100 XP"
//   New:     "Essence gained: +100"  or  "+100 Essence"
//
// All matched amounts are applied to playerState.essence.
// ---------------------------------------------------------------------------
export function applySystemRewards(text, onChanged) {
  let stateChanged = false;

  // --- Essence (+ legacy XP) ---
  const essenceRanges = [];
  for (const pattern of [
    /(?:XP|Essence)\s+gained\s*:\s*\+\s*(\d+)/gi,
    /\+[^\S\n]*(\d+)[^\S\n]*(?:bonus[^\S\n]+)?(?:XP|Essence)\b/gi,
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
