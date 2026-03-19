// systems/skills.js — Skill registry and management
//
// Owns the skill data model: parsing skills.txt into a registry, checking
// ownership, granting/revoking skills, and purchasing with Essence.
//
// playerState.skills is an array of skill key strings.
// skillRegistry is the ordered list of all defined skills parsed from skills.txt.

import { playerState, normalizeKey } from '../core/state.js';

export interface SkillEntry {
  key:         string;
  label:       string;
  essenceCost: number;
  rarity:      string;
  description: string;
  condition:   string | null;
}

// ---------------------------------------------------------------------------
// Skill registry — populated by parseSkills from skills.txt
// [{ key, label, essenceCost, description, rarity, condition }]
// ---------------------------------------------------------------------------
export let skillRegistry: SkillEntry[] = [];

// ---------------------------------------------------------------------------
// parseSkills — reads skills.txt and populates skillRegistry.
//
// Format:  *skill key "Label" cost [rarity]
//            Description text (indented).
//          *require expression  (optional — hides until true)
// ---------------------------------------------------------------------------
export async function parseSkills(fetchTextFileFn: (name: string) => Promise<string>): Promise<void> {
  let text;
  try {
    text = await fetchTextFileFn('skills');
  } catch (err) {
    console.warn('[skills] skills.txt not found — skill system disabled.', (err as Error).message);
    skillRegistry = [];
    return;
  }

  const lines = text.split(/\r?\n/);
  const parsed: SkillEntry[] = [];
  let current: SkillEntry | null = null;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith('//')) continue;

    const m = trimmed.match(/^\*skill\s+([\w]+)\s+"([^"]+)"\s+(\d+)(?:\s+(common|uncommon|rare|epic|legendary))?\s*$/i);
    if (m) {
      if (current) parsed.push(current);
      current = {
        key:          normalizeKey(m[1]),
        label:        m[2],
        essenceCost:  Number(m[3]),
        rarity:       m[4] ? m[4].toLowerCase() : 'common',
        description:  '',
        condition:    null,
      };
      continue;
    }

    if (current && trimmed.startsWith('*require ')) {
      current.condition = trimmed.replace(/^\*require\s+/, '').trim();
      continue;
    }

    if (current && raw.match(/^\s+/) && trimmed) {
      current.description += (current.description ? ' ' : '') + trimmed;
    }
  }

  if (current) parsed.push(current);

  skillRegistry = parsed;

  if (skillRegistry.length === 0) {
    console.warn('[skills] No *skill entries found in skills.txt.');
  }
}

// ---------------------------------------------------------------------------
// playerHasSkill — checks whether playerState.skills contains the given key
// ---------------------------------------------------------------------------
export function playerHasSkill(key: string): boolean {
  const k = normalizeKey(key);
  return Array.isArray(playerState.skills) && playerState.skills.includes(k);
}

// ---------------------------------------------------------------------------
// grantSkill — adds a skill without spending Essence. No-op if already owned.
// ---------------------------------------------------------------------------
export function grantSkill(key: string): void {
  const k = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) playerState.skills = [];
  if (!playerState.skills.includes(k)) {
    playerState.skills.push(k);
  }
}

// ---------------------------------------------------------------------------
// revokeSkill — removes a skill. Warns if not owned.
// ---------------------------------------------------------------------------
export function revokeSkill(key: string): void {
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
// purchaseSkill — deducts Essence, then grants the skill.
// Returns true on success, false if already owned or can't afford.
// ---------------------------------------------------------------------------
export function purchaseSkill(key: string): boolean {
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
  const essence = Number(playerState.essence || 0);
  if (essence < entry.essenceCost) {
    console.warn(`[skills] purchaseSkill: not enough Essence (have ${essence}, need ${entry.essenceCost}).`);
    return false;
  }
  playerState.essence = essence - entry.essenceCost;
  grantSkill(k);
  return true;
}
