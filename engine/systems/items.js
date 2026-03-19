// systems/items.js — Item registry and purchase management
//
// Owns the item data model: parsing items.txt into a registry, and purchasing
// items with Essence. Purchased items are added to playerState.inventory via
// the inventory.js addInventoryItem function.
//
// itemRegistry is the ordered list of all defined items parsed from items.txt.

import { playerState, normalizeKey } from '../core/state.js';
import { addInventoryItem } from './inventory.js';

// ---------------------------------------------------------------------------
// Item registry — populated by parseItems from items.txt
// [{ key, label, essenceCost, description, rarity, condition }]
// ---------------------------------------------------------------------------
export let itemRegistry = [];

// ---------------------------------------------------------------------------
// parseItems — reads items.txt and populates itemRegistry.
//
// Format:  *item key "Label" cost [rarity]
//            Description text (indented).
//          *require expression  (optional — hides until true)
// ---------------------------------------------------------------------------
export async function parseItems(fetchTextFileFn) {
  let text;
  try {
    text = await fetchTextFileFn('items');
  } catch (err) {
    console.warn('[items] items.txt not found — item store disabled.', err.message);
    itemRegistry = [];
    return;
  }

  const lines = text.split(/\r?\n/);
  const parsed = [];
  let current = null;

  for (const raw of lines) {
    const trimmed = raw.trim();

    if (!trimmed || trimmed.startsWith('//')) continue;

    const m = trimmed.match(/^\*item\s+([\w]+)\s+"([^"]+)"\s+(\d+)(?:\s+(common|uncommon|rare|epic|legendary))?\s*$/i);
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

  itemRegistry = parsed;

  if (itemRegistry.length === 0) {
    console.warn('[items] No *item entries found in items.txt.');
  }
}

// ---------------------------------------------------------------------------
// purchaseItem — deducts Essence, then adds the item to inventory.
// Returns true on success, false if can't afford. Items stack on repeat buys.
// ---------------------------------------------------------------------------
export function purchaseItem(key) {
  const k     = normalizeKey(key);
  const entry = itemRegistry.find(i => i.key === k);
  if (!entry) {
    console.warn(`[items] purchaseItem: "${k}" not found in itemRegistry.`);
    return false;
  }
  const essence = Number(playerState.essence || 0);
  if (essence < entry.essenceCost) {
    console.warn(`[items] purchaseItem: not enough Essence (have ${essence}, need ${entry.essenceCost}).`);
    return false;
  }
  playerState.essence = essence - entry.essenceCost;
  addInventoryItem(entry.label);
  return true;
}
