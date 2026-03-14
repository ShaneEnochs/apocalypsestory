// ---------------------------------------------------------------------------
// systems/skills.js — Skill registry and management
//
// Owns the skill data model: parsing skills.txt into a registry, checking
// ownership, granting/revoking skills, and purchasing with skill points.
//
// playerState.skills is an array of skill key strings.
// playerState.skill_points is the accumulated SP currency.
// skillRegistry is the ordered list of all defined skills parsed from skills.txt.
//
// Dependency graph (one-directional):
//   skills.js → state.js  (playerState, normalizeKey)
// ---------------------------------------------------------------------------

import { playerState, normalizeKey } from '../core/state.js';

// ---------------------------------------------------------------------------
// Skill registry — populated by parseSkills from skills.txt
// [{ key, label, spCost, description }]
// ---------------------------------------------------------------------------
export let skillRegistry = [];

// ---------------------------------------------------------------------------
// parseSkills — reads skills.txt via the injected fetch function and
// populates skillRegistry.
//
// Format in skills.txt:
//   *skill key "Label" sp_cost
//     Description text (indented lines, can span multiple lines).
// ---------------------------------------------------------------------------
export async function parseSkills(fetchTextFileFn) {
  let text;
  try {
    text = await fetchTextFileFn('skills');
  } catch (err) {
    // skills.txt is optional — if missing, the skill system is simply empty
    console.warn('[skills] skills.txt not found — skill system disabled.', err.message);
    skillRegistry = [];
    return;
  }

  const lines = text.split(/\r?\n/);
  const parsed = [];
  let current = null;

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('//')) continue;

    // New skill directive
    const m = trimmed.match(/^\*skill\s+([\w]+)\s+"([^"]+)"\s+(\d+)\s*$/);
    if (m) {
      // Finalise previous skill if any
      if (current) parsed.push(current);
      current = {
        key:         normalizeKey(m[1]),
        label:       m[2],
        spCost:      Number(m[3]),
        description: '',
      };
      continue;
    }

    // Indented description line (belongs to current skill)
    if (current && raw.match(/^\s+/) && trimmed) {
      current.description += (current.description ? ' ' : '') + trimmed;
    }
  }

  // Finalise last skill
  if (current) parsed.push(current);

  skillRegistry = parsed;

  if (skillRegistry.length === 0) {
    console.warn('[skills] No *skill entries found in skills.txt.');
  }
}

// ---------------------------------------------------------------------------
// playerHasSkill — checks whether playerState.skills contains the given key
// ---------------------------------------------------------------------------
export function playerHasSkill(key) {
  const k = normalizeKey(key);
  return Array.isArray(playerState.skills) && playerState.skills.includes(k);
}

// ---------------------------------------------------------------------------
// grantSkill — adds a skill to playerState.skills without spending SP.
// No-op if already owned. Initialises the array if needed.
// ---------------------------------------------------------------------------
export function grantSkill(key) {
  const k = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) playerState.skills = [];
  if (!playerState.skills.includes(k)) {
    playerState.skills.push(k);
  }
}

// ---------------------------------------------------------------------------
// revokeSkill — removes a skill from playerState.skills.
// Warns if not owned. No-op if the array doesn't exist.
// ---------------------------------------------------------------------------
export function revokeSkill(key) {
  const k = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) return;
  const idx = playerState.skills.indexOf(k);
  if (idx === -1) {
    console.warn(`[skills] *revoke_skill: "${k}" not owned — nothing to remove.`);
    return;
  }
  playerState.skills.splice(idx, 1);
}

// ---------------------------------------------------------------------------
// purchaseSkill — deducts SP from playerState.skill_points, then grants the
// skill. Returns true on success, false if already owned or can't afford.
// ---------------------------------------------------------------------------
export function purchaseSkill(key) {
  const k    = normalizeKey(key);
  const entry = skillRegistry.find(s => s.key === k);
  if (!entry) {
    console.warn(`[skills] purchaseSkill: "${k}" not found in skillRegistry.`);
    return false;
  }
  if (playerHasSkill(k)) {
    console.warn(`[skills] purchaseSkill: "${k}" already owned.`);
    return false;
  }
  const sp = Number(playerState.skill_points || 0);
  if (sp < entry.spCost) {
    console.warn(`[skills] purchaseSkill: not enough SP (have ${sp}, need ${entry.spCost}).`);
    return false;
  }
  playerState.skill_points = sp - entry.spCost;
  grantSkill(k);
  return true;
}
