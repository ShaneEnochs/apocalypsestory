// ---------------------------------------------------------------------------
// systems/inventory.js — Inventory management
//
// Stacking inventory: duplicate items are tracked as "Item (2)", "Item (3)",
// etc. All functions operate directly on playerState.inventory.
//
// BUG-07 fix (original sweep): parseInventoryUpdateText no longer requires
//   item names to start with an uppercase letter.
//
// FIX #6 (sweep 2): addInventoryItem and removeInventoryItem now use an
//   explicit extractStackCount() helper instead of the fragile sparse-array
//   fallback pattern `(match || [, 1])[1]`.
//
//   OLD (fragile):
//     const c = (item.match(/\((\d+)\)$/) || [, 1])[1];
//     // relies on JS sparse array: [undefined, 1] — the [1] is a hole,
//     // not a real element. Works in practice but is a well-known footgun:
//     // minifiers can legally transform [, 1] to [undefined, 1] but the
//     // behaviour depends on the sparse-array semantics of [, N][1] === N.
//
//   NEW (explicit):
//     function extractStackCount(itemStr) {
//       const m = String(itemStr).match(/\((\d+)\)$/);
//       return m ? Number(m[1]) : 1;
//     }
//     const qty = extractStackCount(item);
//
//   Behaviour is identical — just no longer relies on sparse-array indexing.
// ---------------------------------------------------------------------------

import { playerState } from '../core/state.js';

// ---------------------------------------------------------------------------
// extractStackCount — returns the numeric stack count from an inventory
// string, or 1 if no "(N)" suffix is present.
//
// Examples:
//   "Sword"      → 1
//   "Sword (2)"  → 2
//   "Sword (10)" → 10
// ---------------------------------------------------------------------------
function extractStackCount(itemStr) {
  const m = String(itemStr).match(/\((\d+)\)$/);
  return m ? Number(m[1]) : 1;
}

// ---------------------------------------------------------------------------
// itemBaseName — strips the trailing stack count from an item name.
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
    // FIX #6: use extractStackCount() instead of (match || [, 1])[1]
    const count = extractStackCount(playerState.inventory[idx]);
    playerState.inventory[idx] = `${normalized} (${count + 1})`;
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

  // FIX #6: use extractStackCount() instead of (match || [, 1])[1]
  const qty = extractStackCount(playerState.inventory[idx]);
  if (qty <= 1)       playerState.inventory.splice(idx, 1);
  else if (qty === 2) playerState.inventory[idx] = normalized;
  else                playerState.inventory[idx] = `${normalized} (${qty - 1})`;
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
