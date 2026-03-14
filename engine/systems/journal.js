// ---------------------------------------------------------------------------
// systems/journal.js — Journal and achievements
//
// playerState.journal is an array of entry objects:
//   [{ text: "...", timestamp: "...", type: "entry"|"achievement" }]
//
// Scene directives:
//   *journal "Entry text"           — adds a journal entry
//   *achievement "Achievement text" — adds an achievement (styled differently)
//
// The journal array is saved/loaded automatically because buildSavePayload
// deep-copies all of playerState. No save format change needed.
//
// Dependency graph:
//   journal.js → state.js (playerState)
// ---------------------------------------------------------------------------

import { playerState } from '../core/state.js';

// ---------------------------------------------------------------------------
// addJournalEntry — appends a timestamped entry to playerState.journal
// ---------------------------------------------------------------------------
export function addJournalEntry(text, type = 'entry') {
  if (!Array.isArray(playerState.journal)) playerState.journal = [];
  playerState.journal.push({
    text:      text.trim(),
    type,
    timestamp: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// getJournalEntries — returns the full journal array (newest last)
// ---------------------------------------------------------------------------
export function getJournalEntries() {
  return Array.isArray(playerState.journal) ? playerState.journal : [];
}

// ---------------------------------------------------------------------------
// getAchievements — returns only achievement-type entries
// ---------------------------------------------------------------------------
export function getAchievements() {
  return getJournalEntries().filter(e => e.type === 'achievement');
}
