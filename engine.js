// ---------------------------------------------------------------------------
// engine.js — System Awakening coordinator (Phase 4 complete)
//
// This file is the final coordinator after all four extraction phases.
// It owns: the DOM cache, fetchTextFile, scheduleStatsRender, boot, wireUI,
// and getEngineState. Everything else lives in a module under engine/.
//
// Module map:
//   engine/core/state.js        — all mutable state + variable management
//   engine/core/expression.js   — safe recursive descent expression evaluator
//   engine/core/parser.js       — parseLines, indexLabels, parseChoice, parseSystemBlock
//   engine/core/interpreter.js  — directive registry, executeBlock, gotoScene, runInterpreter
//   engine/systems/inventory.js — inventory add/remove/check
//   engine/systems/leveling.js  — XP, level-up, system reward parsing
//   engine/systems/saves.js     — localStorage save/load/slot management
//   engine/ui/narrative.js      — formatText, addParagraph, addSystem, clearNarrative,
//                                  applyTransition, renderChoices
//   engine/ui/panels.js         — runStatsScene, showInlineLevelUp, showEndingScreen
//   engine/ui/overlays.js       — trapFocus, showToast, slot cards, splash, save menu,
//                                  char creation, loadAndResume
//
// Phase 5 (next): add esbuild; bundle engine/main.js → engine.js for production.
// ---------------------------------------------------------------------------

// PATCH 1 of 6 — add pauseState, clearSessionState, exportSaveSlot, importSaveFromJSON
import {
  playerState, tempState, statRegistry, startup,
  currentScene, currentLines, ip, pendingStatPoints,
  awaitingChoice, delayIndex, pauseState,
  patchPlayerState, parseStartup,
  setPlayerState, setTempState, setPendingStatPoints,
  setCurrentScene, setCurrentLines, setIp, setDelayIndex,
  setAwaitingChoice, setPendingLevelUpDisplay,
  setChapterTitleState, clearPauseState,
  sessionState, clearSessionState,  // ENH-08: sessionState needed by pushUndoSnapshot/popUndo
} from './engine/core/state.js';

import { evalValue }       from './engine/core/expression.js';

import {
  registerCallbacks, registerCaches,
  gotoScene, runInterpreter,
  executeBlock,                     // FIX Main: needed for initNarrative callback
} from './engine/core/interpreter.js';

import { parseLines, indexLabels } from './engine/core/parser.js';

// PATCH 1 continued — add exportSaveSlot, importSaveFromJSON
import {
  loadSaveFromSlot, saveGameToSlot,
  deleteSaveSlot, exportSaveSlot, importSaveFromJSON,  // ENH-10
} from './engine/systems/saves.js';

import { parseSkills } from './engine/systems/skills.js';

import {
  init      as initNarrative,
  addParagraph, addSystem, clearNarrative, applyTransition,
  renderChoices, showInputPrompt, showPageBreak, setChoiceArea,
  getNarrativeLog, renderFromLog, pushNarrativeLogEntry,
} from './engine/ui/narrative.js';

import {
  init      as initPanels,
  runStatsScene, showInlineLevelUp, showEndingScreen,
} from './engine/ui/panels.js';

import {
  init      as initOverlays,
  trapFocus, showToast,
  refreshAllSlotCards,
  showSplash, hideSplash,
  showSaveMenu, hideSaveMenu,
  showCharacterCreation, wireCharCreation,
  loadAndResume,
} from './engine/ui/overlays.js';

// ---------------------------------------------------------------------------
// DOM cache
// ---------------------------------------------------------------------------
const dom = {
  narrativeContent:   document.getElementById('narrative-content'),
  choiceArea:         document.getElementById('choice-area'),
  chapterTitle:       document.getElementById('chapter-title'),
  narrativePanel:     document.getElementById('narrative-panel'),
  statusPanel:        document.getElementById('status-panel'),
  statusToggle:       document.getElementById('status-toggle'),
  saveBtn:            document.getElementById('save-btn'),
  // Splash
  splashOverlay:      document.getElementById('splash-overlay'),
  splashNewBtn:       document.getElementById('splash-new-btn'),
  splashLoadBtn:      document.getElementById('splash-load-btn'),
  splashSlots:        document.getElementById('splash-slots'),
  splashSlotsBack:    document.getElementById('splash-slots-back'),
  // In-game save menu
  saveOverlay:        document.getElementById('save-overlay'),
  saveMenuClose:      document.getElementById('save-menu-close'),
  // Character creation
  charOverlay:        document.getElementById('char-creation-overlay'),
  inputFirstName:     document.getElementById('input-first-name'),
  inputLastName:      document.getElementById('input-last-name'),
  counterFirst:       document.getElementById('counter-first'),
  counterLast:        document.getElementById('counter-last'),
  errorFirstName:     document.getElementById('error-first-name'),
  errorLastName:      document.getElementById('error-last-name'),
  charBeginBtn:       document.getElementById('char-begin-btn'),
  // Ending
  endingOverlay:      document.getElementById('ending-overlay'),
  endingTitle:        document.getElementById('ending-title'),
  endingContent:      document.getElementById('ending-content'),
  endingStats:        document.getElementById('ending-stats'),
  endingActionBtn:    document.getElementById('ending-action-btn'),
  // Toast
  toast:              document.getElementById('toast'),
};

Object.entries(dom).forEach(([key, el]) => {
  if (!el) console.warn(`[engine] DOM element missing: "${key}" — check index.html IDs`);
});

// ---------------------------------------------------------------------------
// Caches — shared between interpreter and fetchTextFile
// ---------------------------------------------------------------------------
const sceneCache  = new Map();
const labelsCache = new Map();

// ---------------------------------------------------------------------------
// scheduleStatsRender — deferred stats panel refresh.
// Micro-task batching: multiple synchronous state changes in one tick only
// trigger a single re-render.
// ---------------------------------------------------------------------------
let _statsRenderPending = false;

// PATCH 3 of 6 — call updateUndoBtn inside scheduleStatsRender (BUG-09)
function scheduleStatsRender() {
  if (_statsRenderPending) return;
  _statsRenderPending = true;
  requestAnimationFrame(() => {
    _statsRenderPending = false;
    runStatsScene();
    updateUndoBtn();  // BUG-09 + ENH-08: keep undo button in sync with pauseState
  });
}

// ---------------------------------------------------------------------------
// fetchTextFile — loads .txt files with scene-level caching
// ---------------------------------------------------------------------------
async function fetchTextFile(name) {
  const key = name.endsWith('.txt') ? name : `${name}.txt`;
  if (sceneCache.has(key)) return sceneCache.get(key);
  const res = await fetch(key);
  if (!res.ok) throw new Error(`Failed to load ${key}`);
  const text = await res.text();
  sceneCache.set(key, text);
  return text;
}

// ---------------------------------------------------------------------------
// showEngineError — renders a red error block into the narrative area
// ---------------------------------------------------------------------------
function showEngineError(message) {
  clearNarrative();
  const div = document.createElement('div');
  div.className = 'system-block';
  div.style.borderLeftColor = 'var(--red)';
  div.style.color = 'var(--red)';
  const label = document.createElement('span');
  label.className = 'system-block-label';
  label.textContent = '[ ENGINE ERROR ]';
  const text = document.createElement('span');
  text.className = 'system-block-text';
  text.textContent = `${message}\n\nUse the Restart button to reload.`;
  div.appendChild(label);
  div.appendChild(text);
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
  dom.chapterTitle.textContent = 'ERROR';
}

// ---------------------------------------------------------------------------
// getEngineState — test accessor (no automated tests yet, kept for future use)
// ---------------------------------------------------------------------------
function getEngineState() {
  return { playerState, tempState, statRegistry, startup, currentScene, pendingStatPoints };
}

// ---------------------------------------------------------------------------
// Undo system — snapshots state on each choice, allows stepping back.
//
// Phase 2 rewrite: snapshots now store narrativeLog instead of narrativeHTML.
// popUndo restores by calling renderFromLog() — no innerHTML clobber, no
// interpreter re-run, no dead event listeners. This eliminates the entire
// class of bugs caused by innerHTML replacement (detached DOM refs, killed
// levelup-inline-block handlers, stale _choiceArea pointer in narrative.js).
//
// Limited to 10 entries. Each snapshot captures everything needed to
// fully restore the game to the moment before a choice was made.
// ---------------------------------------------------------------------------
const _undoStack = [];
const UNDO_MAX = 10;

function pushUndoSnapshot() {
  // Deep-copy the narrative log at snapshot time so subsequent pushes don't
  // mutate the stored array.
  _undoStack.push({
    playerState:      JSON.parse(JSON.stringify(playerState)),
    tempState:        JSON.parse(JSON.stringify(tempState)),
    // FIX #13: include sessionState so popUndo can restore session-scoped flags
    sessionState:     JSON.parse(JSON.stringify(sessionState)),
    pendingStatPoints,
    scene:            currentScene,
    ip,
    narrativeLog:     JSON.parse(JSON.stringify(getNarrativeLog())),
    chapterTitle:     dom.chapterTitle.textContent,
  });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  updateUndoBtn();
}

async function popUndo() {
  if (_undoStack.length === 0) return;
  const snap = _undoStack.pop();
 
  // --- Restore game state ---
  setPlayerState(JSON.parse(JSON.stringify(snap.playerState)));
  setTempState(JSON.parse(JSON.stringify(snap.tempState)));
  // FIX #13: restore sessionState from snapshot.
  if (snap.sessionState !== undefined) {
    clearSessionState();
    Object.assign(sessionState, JSON.parse(JSON.stringify(snap.sessionState)));
  } else {
    clearSessionState();
  }
  setPendingStatPoints(snap.pendingStatPoints);
  setCurrentScene(snap.scene);
 
  // Re-parse lines so the interpreter has a live currentLines array.
  const text = sceneCache.get(snap.scene.endsWith('.txt') ? snap.scene : `${snap.scene}.txt`);
  if (text) {
    setCurrentLines(parseLines(text));
    indexLabels(snap.scene, currentLines, labelsCache);
  }
  setIp(snap.ip);
  setDelayIndex(0);
  setAwaitingChoice(null);
 
  clearPauseState();
 
  // --- Restore chapter title ---
  dom.chapterTitle.textContent = snap.chapterTitle;
  setChapterTitleState(snap.chapterTitle);
 
  // --- Restore narrative from log ---
  renderFromLog(snap.narrativeLog, { skipAnimations: true });
 
  dom.choiceArea = document.getElementById('choice-area');
  setChoiceArea(dom.choiceArea);
 
  if (snap.pendingStatPoints > 0) setPendingLevelUpDisplay(true);
 
  await runInterpreter();
  runStatsScene();
  updateUndoBtn();
}

// PATCH 2 of 6 — BUG-09: updateUndoBtn checks pauseState
function updateUndoBtn() {
  const btn = document.getElementById('undo-btn');
  if (!btn) return;
  btn.disabled = _undoStack.length === 0 || pauseState !== null;
}

// ---------------------------------------------------------------------------
// Debug overlay — toggled by backtick (`) key. Shows live engine state.
// ---------------------------------------------------------------------------
let _debugVisible = false;

function toggleDebug() {
  _debugVisible = !_debugVisible;
  const el = document.getElementById('debug-overlay');
  if (el) el.classList.toggle('hidden', !_debugVisible);
  if (_debugVisible) refreshDebug();
}

function refreshDebug() {
  const el = document.getElementById('debug-overlay');
  if (!el || !_debugVisible) return;

  const ps = { ...playerState };
  if (Array.isArray(ps.inventory) && ps.inventory.length > 5) ps.inventory = [...ps.inventory.slice(0, 5), `... +${ps.inventory.length - 5}`];
  if (Array.isArray(ps.skills) && ps.skills.length > 5) ps.skills = [...ps.skills.slice(0, 5), `... +${ps.skills.length - 5}`];
  if (Array.isArray(ps.journal) && ps.journal.length > 3) ps.journal = [`(${ps.journal.length} entries)`];

  const currentLine = currentLines[ip];
  const linePreview = currentLine ? currentLine.trimmed.slice(0, 80) : '(end)';

  el.innerHTML = `<div class="debug-header">DEBUG <button class="debug-close" onclick="this.parentElement.parentElement.classList.add('hidden')">&times;</button></div>
<div class="debug-body"><pre>scene:  ${currentScene || '(none)'}
ip:     ${ip} / ${currentLines.length}
line:   ${linePreview}
await:  ${awaitingChoice ? 'choice pending' : 'none'}
undo:   ${_undoStack.length} snapshots

playerState:
${JSON.stringify(ps, null, 2)}

tempState:
${JSON.stringify(tempState, null, 2)}</pre></div>`;
}

// ---------------------------------------------------------------------------
// wireUI — attaches all top-level event listeners.
// ---------------------------------------------------------------------------
function wireUI() {
  dom.statusToggle.addEventListener('click', () => {
    const visible = dom.statusPanel.classList.toggle('status-visible');
    dom.statusPanel.classList.toggle('status-hidden', !visible);
    runStatsScene();
  });

  document.addEventListener('click', e => {
    if (window.innerWidth <= 768 &&
        !dom.statusPanel.contains(e.target) &&
        e.target !== dom.statusToggle) {
      dom.statusPanel.classList.remove('status-visible');
      dom.statusPanel.classList.add('status-hidden');
    }
  });

  dom.saveBtn.addEventListener('click', showSaveMenu);

  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-to-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const existing = loadSaveFromSlot(slot);
      if (existing && !confirm(`Overwrite Slot ${slot}?`)) return;
      saveGameToSlot(slot, null, getNarrativeLog());
      hideSaveMenu();
      showToast(`Saved to Slot ${slot}`);
      refreshAllSlotCards();
    });
  });

  dom.saveMenuClose.addEventListener('click', hideSaveMenu);
  dom.saveOverlay.addEventListener('click', e => { if (e.target === dom.saveOverlay) hideSaveMenu(); });
  dom.saveOverlay.addEventListener('keydown', e => { if (e.key === 'Escape') hideSaveMenu(); });

  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (confirm(`Delete Slot ${slot}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });

  ['auto', 1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`ingame-load-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSaveMenu();
      await loadAndResume(save);
    });
  });

  const ingameRestartBtn = document.getElementById('ingame-restart-btn');
  if (ingameRestartBtn) {
    ingameRestartBtn.addEventListener('click', () => {
      if (confirm('Return to the title screen? Manual saves will be kept.')) {
        hideSaveMenu();
        deleteSaveSlot('auto');
        location.reload();
      }
    });
  }

  dom.splashNewBtn.addEventListener('click', async () => {
    hideSplash();
    const charData = await showCharacterCreation();
    patchPlayerState({
      first_name: charData.firstName,
      last_name:  charData.lastName,
      pronouns:   charData.pronouns,
    });
    dom.saveBtn.classList.remove('hidden');
    document.getElementById('undo-btn')?.classList.remove('hidden');
    _undoStack.splice(0);
    updateUndoBtn();
    clearSessionState();
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || 'prologue');
  });

  dom.splashLoadBtn.addEventListener('click', () => {
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.add('hidden');
    dom.splashSlots.classList.remove('hidden');
    refreshAllSlotCards();
  });

  dom.splashSlotsBack.addEventListener('click', () => {
    dom.splashSlots.classList.add('hidden');
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.remove('hidden');
  });

  ['auto', 1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`slot-load-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSplash();
      await loadAndResume(save);
    });
  });

  ['auto', 1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`slot-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const label = slot === 'auto' ? 'the auto-save' : `Slot ${slot}`;
      if (confirm(`Delete ${label}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });

  wireCharCreation();

  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) undoBtn.addEventListener('click', popUndo);

  document.addEventListener('keydown', e => {
    if (e.key === '`') { e.preventDefault(); toggleDebug(); }
  });

  // PATCH 6 of 6 — ENH-10: wire export/import buttons
  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-export-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!exportSaveSlot(slot)) showToast(`Slot ${slot} is empty.`);
      else showToast(`Slot ${slot} exported.`);
    });
  });

  const importInput = document.getElementById('save-import-file');
  if (importInput) {
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const targetSlot = Number(document.getElementById('save-import-slot')?.value || 1);
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const result = importSaveFromJSON(json, targetSlot);
        if (result.ok) {
          showToast(`Imported to Slot ${targetSlot}.`);
          refreshAllSlotCards();
        } else {
          showToast(`Import failed: ${result.reason}`);
        }
      } catch {
        showToast('Import failed: file could not be parsed as JSON.');
      }
      importInput.value = '';
    });
  }
}

// ---------------------------------------------------------------------------
// boot — initialise all modules, then show the splash screen
// ---------------------------------------------------------------------------
async function boot() {
  // 1. Register shared caches with the interpreter
  registerCaches(sceneCache, labelsCache);

  // 2. Initialise UI modules with their DOM slices and cross-module callbacks.
  //    Each init() stores references locally so no module reaches into dom{}.

  // FIX Main (sweep 4): pass executeBlock and runInterpreter to initNarrative
  // so the choice click handler can call them without a circular import.
  initNarrative({
    narrativeContent: dom.narrativeContent,
    choiceArea:       dom.choiceArea,
    narrativePanel:   dom.narrativePanel,
    onShowLevelUp:    showInlineLevelUp,
    scheduleStatsRender,
    onBeforeChoice:   pushUndoSnapshot,
    executeBlock,
    runInterpreter,
  });

  initPanels({
    narrativeContent: dom.narrativeContent,
    choiceArea:       dom.choiceArea,
    statusPanel:      dom.statusPanel,
    endingOverlay:    dom.endingOverlay,
    endingTitle:      dom.endingTitle,
    endingContent:    dom.endingContent,
    endingStats:      dom.endingStats,
    endingActionBtn:  dom.endingActionBtn,
    fetchTextFile,
    scheduleStatsRender,
    trapFocus,
    onLevelUpConfirmed: (level) => {
      pushNarrativeLogEntry({ type: 'levelup_confirmed', level });
    },
  });

  // PATCH 5 of 6 — BUG-05 + ENH-08: add setChoiceArea and updated clearUndoStack
  initOverlays({
    splashOverlay:  dom.splashOverlay,
    splashSlots:    dom.splashSlots,
    saveOverlay:    dom.saveOverlay,
    saveBtn:        dom.saveBtn,
    charOverlay:    dom.charOverlay,
    inputFirstName: dom.inputFirstName,
    inputLastName:  dom.inputLastName,
    counterFirst:   dom.counterFirst,
    counterLast:    dom.counterLast,
    errorFirstName: dom.errorFirstName,
    errorLastName:  dom.errorLastName,
    charBeginBtn:   dom.charBeginBtn,
    toast:          dom.toast,
    runStatsScene,
    fetchTextFile,
    evalValue,
    renderFromLog,
    renderChoices,
    showInlineLevelUp,
    showPageBreak,
    showInputPrompt,
    runInterpreter,
    clearNarrative,
    applyTransition,
    setChapterTitle: (t) => { dom.chapterTitle.textContent = t; setChapterTitleState(t); },
    parseAndCacheScene: async (name) => {
      const text = await fetchTextFile(name);
      setCurrentLines(parseLines(text));
      indexLabels(name, currentLines, labelsCache);
    },
    setChoiceArea: (el) => {
      dom.choiceArea = el;
      setChoiceArea(el);
    },
    clearUndoStack: () => {
      _undoStack.splice(0);
      updateUndoBtn();
      clearSessionState();
    },
  });

  // 3. Register interpreter callbacks — must happen after initNarrative/Panels
  //    so the functions are the real implementations, not null.
  registerCallbacks({
    addParagraph,
    addSystem,
    clearNarrative,
    applyTransition,
    renderChoices,
    showInlineLevelUp,
    showEndingScreen,
    showEngineError,
    showInputPrompt,
    showPageBreak,
    scheduleStatsRender,
    setChapterTitle: (t) => { dom.chapterTitle.textContent = t; setChapterTitleState(t); },
    runStatsScene,
    fetchTextFile,
    getNarrativeLog,
  });

  // 4. Wire all UI event listeners
  wireUI();

  // 5. Parse startup.txt, skills.txt, and show the splash screen
  try {
    await parseStartup(fetchTextFile, evalValue);
    await parseSkills(fetchTextFile);
    showSplash();
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', boot);
