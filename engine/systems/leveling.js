// ---------------------------------------------------------------------------
// systems/leveling.js — Leveling system removed.
// getAllocatableStatKeys is kept for the stats panel (*stat_registered).
// ---------------------------------------------------------------------------

import { statRegistry } from '../core/state.js';

export function getAllocatableStatKeys() {
  return statRegistry.map(e => e.key);
}
