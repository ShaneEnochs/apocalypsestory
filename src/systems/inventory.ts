// systems/inventory.js — Inventory management
//
// Stacking inventory: duplicate items are tracked as "Item (2)", "Item (3)",
// etc. All functions operate directly on playerState.inventory.

import { playerState } from '../core/state.js';

// ---------------------------------------------------------------------------
// extractStackCount — returns the numeric stack count from an inventory
// string, or 1 if no "(N)" suffix is present.
// ---------------------------------------------------------------------------
function extractStackCount(itemStr: string): number {
  const m = String(itemStr).match(/\((\d+)\)$/);
  return m ? Number(m[1]) : 1;
}

// ---------------------------------------------------------------------------
// itemBaseName — strips the trailing stack count from an item name.
// e.g. "Sword (3)" → "Sword"
// ---------------------------------------------------------------------------
export function itemBaseName(item: string): string {
  return String(item).replace(/\s*\(\d+\)$/, '').trim();
}

// ---------------------------------------------------------------------------
// addInventoryItem — adds one copy of item to playerState.inventory.
// Creates the array if it doesn't exist. Returns true if successful.
// ---------------------------------------------------------------------------
export function addInventoryItem(item: string): boolean {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) playerState.inventory = [];

  const idx = playerState.inventory.findIndex((i: string) => itemBaseName(i) === normalized);
  if (idx === -1) {
    playerState.inventory.push(normalized);
  } else {
    const count = extractStackCount(playerState.inventory[idx]);
    playerState.inventory[idx] = `${normalized} (${count + 1})`;
  }
  return true;
}

// ---------------------------------------------------------------------------
// removeInventoryItem — removes one copy of item from playerState.inventory.
// Decrements the stack count, or removes entirely if count reaches 1.
// ---------------------------------------------------------------------------
export function removeInventoryItem(item: string): boolean {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) return false;

  const idx = playerState.inventory.findIndex((i: string) => itemBaseName(i) === normalized);
  if (idx === -1) {
    console.warn(`[inventory] *remove_item: "${normalized}" not found.`);
    return false;
  }

  const qty = extractStackCount(playerState.inventory[idx]);
  if (qty <= 1)       playerState.inventory.splice(idx, 1);
  else if (qty === 2) playerState.inventory[idx] = normalized;
  else                playerState.inventory[idx] = `${normalized} (${qty - 1})`;
  return true;
}

// ---------------------------------------------------------------------------
// parseInventoryUpdateText — extracts item names from a system block string.
// Used to detect "Inventory updated: Item A, Item B".
// ---------------------------------------------------------------------------
export function parseInventoryUpdateText(text: string): string[] {
  const m = text.match(/Inventory\s+updated\s*:\s*([^\n]+)/i);
  if (!m) return [];
  return m[1].trim().split(',')
    .map((e: string) => e.trim().replace(/\.$/, ''))
    .filter((e: string) => e &&
      e.length <= 60 &&
      !/\b(assembled|acquired|secured|updated|complete|lost|destroyed)\b/i.test(e));
}
