// ---------------------------------------------------------------------------
// systems/leveling.js — XP, level-up, and system reward parsing
//
// checkAndApplyLevelUp and applySystemRewards both accept an optional
// onChanged callback. When state changes, they call onChanged() — which
// engine.js wires to scheduleStatsRender(). This avoids a circular import
// with the UI layer while keeping the dependency explicit.
//
// BUG-01 fix: health supports string OR number. When health is a string,
//   "+N health" sets it to N (numeric). When health is already a number,
//   "+N health" adds N. This allows authors to transition from string status
//   ("Healthy") to a numeric HP system via the first health reward.
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
// applyVitalNumeric — applies a numeric delta (positive or negative) to a
// vital field.
//
// BUG-01 fix: health can be a string ("Healthy") or a number (100).
//   - If it is a string and the delta is positive, the reward SETS it to b,
//     transitioning the field from status-string mode to numeric-HP mode.
//   - If it is a string and the delta is negative (BUG-H), we transition to 0
//     rather than a negative number — a penalty against a string health means
//     the character is now at 0 HP.
//   - If it is already a number, the delta is simply added (can go negative).
//   - mana and max_mana are always numeric; no special handling needed.
// ---------------------------------------------------------------------------
function applyVitalNumeric(key, b) {
  if (key === 'health') {
    if (typeof playerState[key] === 'string') {
      // Transition: string → number. Positive delta sets it; negative clamps to 0.
      playerState[key] = b >= 0 ? b : 0;
    } else {
      playerState[key] = Number(playerState[key] || 0) + b;
    }
  } else {
    playerState[key] = Number(playerState[key] || 0) + b;
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
  // NOTE: health uses applyVitalNumeric to support string→number transition (BUG-01 fix).
  //
  // BUG-H fix: added negative patterns (sign: -1) for each vital and stat so
  // that system blocks describing penalties (e.g. "-30 health", "-5 mana") are
  // actually applied to playerState.  Previously only positive (+N) patterns
  // existed; negative rewards displayed as text but had no mechanical effect.
  //
  // Special case for health: if health is still a string ("Healthy") and we
  // receive a negative delta, we transition to 0 rather than a negative number.
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
    // Also match by key name in case the label uses different casing / spacing
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
