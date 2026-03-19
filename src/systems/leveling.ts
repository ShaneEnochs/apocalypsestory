// systems/leveling.js — Leveling system stub
//
// The leveling system was removed but getAllocatableStatKeys is still used
// by the stats panel for *stat_registered rendering.

import { statRegistry } from '../core/state.js';

export function getAllocatableStatKeys() {
  return statRegistry.map(e => e.key);
}
