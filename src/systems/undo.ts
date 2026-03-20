// systems/undo.ts — Undo snapshot stack
//
// Captures full engine state before each player choice so the player can
// step backwards. Up to UNDO_MAX snapshots are kept.
//
// All mutable state dependencies (playerState, ip, narrativeLog, etc.) are
// imported from their respective modules. DOM refs and UI callbacks are
// injected via initUndo().

import {
  playerState, tempState,
  currentScene, currentLines, ip,
  awaitingChoice, pageBreakIp,
  setPageBreakIp,
  setPlayerState, setTempState,
  setCurrentScene, setCurrentLines,
  setIp, setAwaitingChoice,
  setChapterTitleState,
} from '../core/state.js';

import { parseLines, indexLabels } from '../core/parser.js';
import type { AwaitingChoiceState } from '../core/state.js';
import { getNarrativeLog, renderFromLog, renderChoices } from '../ui/narrative.js';
import { runStatsScene } from '../ui/panels.js';

// ---------------------------------------------------------------------------
// UndoSnapshot — full engine state at a single point in time
// ---------------------------------------------------------------------------
export interface UndoSnapshot {
  playerState:    Record<string, unknown>;
  tempState:      Record<string, unknown>;
  scene:          string | null;
  ip:             number;
  narrativeLog:   unknown[];
  chapterTitle:   string | null;
  awaitingChoice: unknown;
}

const _undoStack: UndoSnapshot[] = [];
const UNDO_MAX = 10;

// DOM refs and caches — populated by initUndo()
let _chapterTitleEl: HTMLElement | null = null;
let _sceneCache: Map<string, string> | null = null;
let _labelsCache: Map<string, Record<string, number>> | null = null;

export function initUndo(opts: {
  chapterTitleEl: HTMLElement | null;
  sceneCache:     Map<string, string>;
  labelsCache:    Map<string, Record<string, number>>;
}): void {
  _chapterTitleEl = opts.chapterTitleEl;
  _sceneCache     = opts.sceneCache;
  _labelsCache    = opts.labelsCache;
}

// ---------------------------------------------------------------------------
// pushUndoSnapshot — called by engine just before a choice is rendered
// ---------------------------------------------------------------------------
export function pushUndoSnapshot(): void {
  _undoStack.push({
    playerState:    JSON.parse(JSON.stringify(playerState)),
    tempState:      JSON.parse(JSON.stringify(tempState)),
    scene:          currentScene,
    ip:             pageBreakIp ?? ip,
    narrativeLog:   JSON.parse(JSON.stringify(getNarrativeLog())),
    chapterTitle:   _chapterTitleEl?.textContent ?? null,
    awaitingChoice: awaitingChoice ? JSON.parse(JSON.stringify(awaitingChoice)) : null,
  });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  updateUndoBtn();
}

// ---------------------------------------------------------------------------
// popUndo — restores the most recent snapshot
// ---------------------------------------------------------------------------
export async function popUndo(): Promise<void> {
  if (_undoStack.length === 0) return;
  const snap = _undoStack.pop()!;

  setPlayerState(JSON.parse(JSON.stringify(snap.playerState)));
  setTempState(JSON.parse(JSON.stringify(snap.tempState)));
  if (snap.scene) setCurrentScene(snap.scene);

  if (snap.scene && _sceneCache) {
    const key  = snap.scene.endsWith('.txt') ? snap.scene : `${snap.scene}.txt`;
    const text = _sceneCache.get(key);
    if (text) {
      setCurrentLines(parseLines(text));
      indexLabels(snap.scene, currentLines, _labelsCache!);
    }
  }
  setIp(snap.ip);
  setAwaitingChoice(null);
  setPageBreakIp(null);

  if (_chapterTitleEl) _chapterTitleEl.textContent = snap.chapterTitle;
  setChapterTitleState(snap.chapterTitle ?? '');

  renderFromLog(snap.narrativeLog as Parameters<typeof renderFromLog>[0], { skipAnimations: true });

  if (snap.awaitingChoice) {
    setAwaitingChoice(snap.awaitingChoice as AwaitingChoiceState);
    renderChoices((snap.awaitingChoice as AwaitingChoiceState).choices);
  }

  await runStatsScene();
  updateUndoBtn();
}

// ---------------------------------------------------------------------------
// updateUndoBtn — enables/disables the undo button based on stack depth
// ---------------------------------------------------------------------------
export function updateUndoBtn(): void {
  const btn = document.getElementById('undo-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = _undoStack.length === 0;
}

// ---------------------------------------------------------------------------
// clearUndoStack — called on new game and load
// ---------------------------------------------------------------------------
export function clearUndoStack(): void {
  _undoStack.splice(0);
  updateUndoBtn();
}

// ---------------------------------------------------------------------------
// undoStackLength — exposed for engine to check before wiring
// ---------------------------------------------------------------------------
export function undoStackLength(): number {
  return _undoStack.length;
}
