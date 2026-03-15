// ---------------------------------------------------------------------------
// systems/items.js — Item registry and purchase management
//
// Owns the item data model: parsing items.txt into a registry, and purchasing
// items with Essence. Purchased items are added to playerState.inventory via
// the inventory.js addInventoryItem function.
//
// playerState.inventory is an array of item name strings (with stack counts).
// Items are purchased with Essence (playerState.essence).
// itemRegistry is the ordered list of all defined items parsed from items.txt.
//
// Dependency graph (one-directional):
//   items.js → state.js     (playerState, normalizeKey)
//   items.js → inventory.js (addInventoryItem)
// ---------------------------------------------------------------------------

import { playerState, normalizeKey } from '../core/state.js';
import { addInventoryItem } from './inventory.js';

// ---------------------------------------------------------------------------
// Item registry — populated by parseItems from items.txt
// [{ key, label, essenceCost, description }]
// ---------------------------------------------------------------------------
export let itemRegistry = [];

// ---------------------------------------------------------------------------
// parseItems — reads items.txt via the injected fetch function and
// populates itemRegistry.
//
// Format in items.txt:
//   *item key "Label" cost
//     Description text (indented lines, can span multiple lines).
// ---------------------------------------------------------------------------
export async function parseItems(fetchTextFileFn) {
  let text;
  try {
    text = await fetchTextFileFn('items');
  } catch (err) {
    // items.txt is optional — if missing, the item store is simply empty
    console.warn('[items] items.txt not found — item store disabled.', err.message);
    itemRegistry = [];
    return;
  }

  const lines = text.split(/\r?\n/);
  const parsed = [];
  let current = null;

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('//')) continue;

    // New item directive
    const m = trimmed.match(/^\*item\s+([\w]+)\s+"([^"]+)"\s+(\d+)\s*$/);
    if (m) {
      // Finalise previous item if any
      if (current) parsed.push(current);
      current = {
        key:          normalizeKey(m[1]),
        label:        m[2],
        essenceCost:  Number(m[3]),
        description:  '',
      };
      continue;
    }

    // Indented description line (belongs to current item)
    if (current && raw.match(/^\s+/) && trimmed) {
      current.description += (current.description ? ' ' : '') + trimmed;
    }
  }

  // Finalise last item
  if (current) parsed.push(current);

  itemRegistry = parsed;

  if (itemRegistry.length === 0) {
    console.warn('[items] No *item entries found in items.txt.');
  }
}

// ---------------------------------------------------------------------------
// purchaseItem — deducts Essence from playerState.essence, then adds the
// item to inventory. Returns true on success, false if can't afford.
// Items can be purchased multiple times (they stack in inventory).
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
