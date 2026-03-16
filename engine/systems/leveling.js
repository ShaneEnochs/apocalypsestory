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
         addPendingStatPoints, startup }          from '../core/state.js';
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
// runOnLevelUp — executes the *on_level_up block from startup.txt.
//
// The block is a small list of pre-parsed line objects stored on startup.
// We run them through a lightweight inline interpreter that handles *if /
// *elseif / *else, *set, *set_stat, *grant_skill, *revoke_skill, *journal,
// and *achievement — the directives that make sense at level-up time.
// It intentionally does NOT support *choice, *goto, *system, or *page_break.
//
// evalValueFn and the skill/journal callbacks are injected to avoid circular
// imports (same pattern used throughout the engine).
// ---------------------------------------------------------------------------
export function runOnLevelUp({ evalValueFn, grantSkill, revokeSkill, addJournalEntry, scheduleStatsRender }) {
  const lines = startup.onLevelUpLines;
  if (!lines || lines.length === 0) return;

  let i = 0;

  function findBlockEnd(from, parentIndent) {
    let j = from;
    while (j < lines.length) {
      if (lines[j].trimmed && lines[j].indent <= parentIndent) break;
      j++;
    }
    return j;
  }

  function execLines(start, end) {
    let cursor = start;
    while (cursor < end) {
      const line = lines[cursor];
      if (!line.trimmed || line.trimmed.startsWith('//')) { cursor++; continue; }
      const t = line.trimmed;

      // *if / *elseif / *else chain
      if (t.startsWith('*if ') || t.startsWith('*if\t')) {
        cursor = execIfChain(cursor, line.indent);
        continue;
      }

      // *set
      if (t.startsWith('*set ')) {
        const m = t.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
        if (m) {
          const key = m[1].toLowerCase();
          const rhs = m[2];
          if (Object.prototype.hasOwnProperty.call(playerState, key)) {
            if (/^[+\-*/]\s*/.test(rhs) && typeof playerState[key] === 'number') {
              playerState[key] = evalValueFn(`${playerState[key]} ${rhs}`);
            } else {
              playerState[key] = evalValueFn(rhs);
            }
          } else {
            console.warn(`[on_level_up] *set: variable "${key}" not declared.`);
          }
        }
        cursor++; continue;
      }

      // *set_stat
      if (t.startsWith('*set_stat ')) {
        const m = t.match(/^\*set_stat\s+([a-zA-Z_][\w]*)\s+(.+)$/);
        if (m) {
          const key = m[1].toLowerCase();
          const rest = m[2];
          const minMatch = rest.match(/\bmin:\s*(-?[\d.]+)/i);
          const maxMatch = rest.match(/\bmax:\s*(-?[\d.]+)/i);
          const rhs = rest.replace(/\bmin:\s*-?[\d.]+/gi, '').replace(/\bmax:\s*-?[\d.]+/gi, '').trim();
          const minVal = minMatch ? Number(minMatch[1]) : -Infinity;
          const maxVal = maxMatch ? Number(maxMatch[1]) :  Infinity;
          if (Object.prototype.hasOwnProperty.call(playerState, key)) {
            let val;
            if (/^[+\-*/]\s*/.test(rhs) && typeof playerState[key] === 'number') {
              val = evalValueFn(`${playerState[key]} ${rhs}`);
            } else {
              val = evalValueFn(rhs);
            }
            if (typeof val === 'number') val = Math.min(maxVal, Math.max(minVal, val));
            playerState[key] = val;
          } else {
            console.warn(`[on_level_up] *set_stat: variable "${key}" not declared.`);
          }
        }
        cursor++; continue;
      }

      // *grant_skill
      if (t.startsWith('*grant_skill ')) {
        const key = t.replace(/^\*grant_skill\s*/, '').trim();
        if (grantSkill) grantSkill(key);
        cursor++; continue;
      }

      // *revoke_skill
      if (t.startsWith('*revoke_skill ')) {
        const key = t.replace(/^\*revoke_skill\s*/, '').trim();
        if (revokeSkill) revokeSkill(key);
        cursor++; continue;
      }

      // *journal
      if (t.startsWith('*journal ')) {
        const text = t.replace(/^\*journal\s*/, '').trim();
        if (text && addJournalEntry) addJournalEntry(text, 'entry');
        cursor++; continue;
      }

      // *achievement
      if (t.startsWith('*achievement ')) {
        const text = t.replace(/^\*achievement\s*/, '').trim();
        if (text && addJournalEntry) addJournalEntry(text, 'achievement', true);
        cursor++; continue;
      }

      // Unknown — skip with warning
      console.warn(`[on_level_up] Unsupported directive "${t.split(/\s/)[0]}" — skipped.`);
      cursor++;
    }
  }

  function execIfChain(start, indent) {
    let cursor = start;
    let executed = false;

    while (cursor < lines.length) {
      const line = lines[cursor];
      if (!line.trimmed) { cursor++; continue; }
      // End of chain — a non-empty line at same or lower indent that isn't part of the chain
      if (line.indent <= indent && cursor > start &&
          !line.trimmed.startsWith('*elseif') && !line.trimmed.startsWith('*else')) {
        return cursor;
      }

      const t = line.trimmed;

      if ((t.startsWith('*if ') || t.startsWith('*if\t')) && cursor === start) {
        const cond = t.replace(/^\*if\s+/, '');
        const blockStart = cursor + 1;
        const blockEnd   = findBlockEnd(blockStart, indent);
        if (!executed && evalValueFn(cond)) {
          execLines(blockStart, blockEnd);
          executed = true;
        }
        cursor = blockEnd;
        continue;
      }

      if (t.startsWith('*elseif ') || t.startsWith('*elseif\t')) {
        const cond = t.replace(/^\*elseif\s+/, '');
        const blockStart = cursor + 1;
        const blockEnd   = findBlockEnd(blockStart, indent);
        if (!executed && evalValueFn(cond)) {
          execLines(blockStart, blockEnd);
          executed = true;
        }
        cursor = blockEnd;
        continue;
      }

      if (t === '*else') {
        const blockStart = cursor + 1;
        const blockEnd   = findBlockEnd(blockStart, indent);
        if (!executed) execLines(blockStart, blockEnd);
        cursor = blockEnd;
        return cursor;
      }

      // Anything else at this indent level ends the chain
      return cursor;
    }

    return cursor;
  }

  execLines(0, lines.length);
  if (scheduleStatsRender) scheduleStatsRender();
}


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
