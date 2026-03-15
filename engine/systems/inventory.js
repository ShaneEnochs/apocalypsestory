// ---------------------------------------------------------------------------
// systems/inventory.js — Inventory management
//
// Stacking inventory: duplicate items are tracked as "Item (2)", "Item (3)",
// etc. All functions operate directly on playerState.inventory.
//
// BUG-07 fix: parseInventoryUpdateText no longer requires item names to start
// with an uppercase letter. The restriction silently dropped valid lowercase
// names like "rusty dagger" or "ancient map". The filter now relies only on
// the word-exclusion list and length check.
// ---------------------------------------------------------------------------

import { playerState } from '../core/state.js';

// ---------------------------------------------------------------------------
// itemBaseName — strips the trailing stack count from an item name
// e.g. "Sword (3)" → "Sword"
// ---------------------------------------------------------------------------
export function itemBaseName(item) {
  return String(item).replace(/\s*\(\d+\)$/, '').trim();
}

// ---------------------------------------------------------------------------
// addInventoryItem — adds one copy of item to playerState.inventory.
// Creates the array if it doesn't exist. Returns true if successful.
// ---------------------------------------------------------------------------
export function addInventoryItem(item) {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) playerState.inventory = [];

  const idx = playerState.inventory.findIndex(i => itemBaseName(i) === normalized);
  if (idx === -1) {
    playerState.inventory.push(normalized);
  } else {
    const c = (playerState.inventory[idx].match(/\((\d+)\)$/) || [, 1])[1];
    playerState.inventory[idx] = `${normalized} (${Number(c) + 1})`;
  }
  return true;
}

// ---------------------------------------------------------------------------
// removeInventoryItem — removes one copy of item from playerState.inventory.
// Decrements the stack count, or removes entirely if count reaches 1.
// Logs a warning if the item is not found. Returns true if successful.
// ---------------------------------------------------------------------------
export function removeInventoryItem(item) {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) return false;

  const idx = playerState.inventory.findIndex(i => itemBaseName(i) === normalized);
  if (idx === -1) {
    console.warn(`[inventory] *remove_item: "${normalized}" not found.`);
    return false;
  }

  const c   = (playerState.inventory[idx].match(/\((\d+)\)$/) || [, 1])[1];
  const qty = Number(c);
  if (qty <= 1)      playerState.inventory.splice(idx, 1);
  else if (qty === 2) playerState.inventory[idx] = normalized;
  else               playerState.inventory[idx] = `${normalized} (${qty - 1})`;
  return true;
}

// ---------------------------------------------------------------------------
// parseInventoryUpdateText — extracts item names from a system block string.
// Used by applySystemRewards to detect "Inventory updated: Item A, Item B".
//
// BUG-07 fix: removed the /^[A-Z0-9]/ uppercase-start requirement.
// Item names are now matched case-insensitively; only the word-exclusion list
// and max-length check remain as filters. Authors can now use lowercase item
// names freely.
// ---------------------------------------------------------------------------
export function parseInventoryUpdateText(text) {
  const m = text.match(/Inventory\s+updated\s*:\s*([^\n]+)/i);
  if (!m) return [];
  return m[1].trim().split(',')
    .map(e => e.trim().replace(/\.$/, ''))
    .filter(e => e &&
      e.length <= 60 &&
      !/\b(assembled|acquired|secured|updated|complete|lost|destroyed)\b/i.test(e));
}
