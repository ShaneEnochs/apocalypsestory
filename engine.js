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

import {
  playerState, tempState, statRegistry, startup,
  currentScene, pendingStatPoints,
  patchPlayerState, parseStartup,
} from './engine/core/state.js';

import { evalValue }       from './engine/core/expression.js';

import {
  registerCallbacks, registerCaches,
  gotoScene,
} from './engine/core/interpreter.js';

import {
  loadSaveFromSlot, saveGameToSlot,
  deleteSaveSlot,
} from './engine/systems/saves.js';

import {
  init      as initNarrative,
  addParagraph, addSystem, clearNarrative, applyTransition,
  renderChoices,
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
function scheduleStatsRender() {
  if (_statsRenderPending) return;
  _statsRenderPending = true;
  Promise.resolve().then(() => { _statsRenderPending = false; runStatsScene(); });
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
  div.innerHTML = `<span class="system-block-label">[ ENGINE ERROR ]</span><span class="system-block-text">${message}\n\nUse the Restart button to reload.</span>`;
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
// wireUI — attaches all top-level event listeners.
// Overlay-internal wiring (char creation inputs, pronoun cards) is handled
// inside overlays.js; this function only wires the header controls and the
// overlay open/close triggers.
// ---------------------------------------------------------------------------
function wireUI() {
  // Status panel toggle
  dom.statusToggle.addEventListener('click', () => {
    const visible = dom.statusPanel.classList.toggle('status-visible');
    dom.statusPanel.classList.toggle('status-hidden', !visible);
    runStatsScene();
  });

  // Mobile: close status panel on outside tap
  document.addEventListener('click', e => {
    if (window.innerWidth <= 768 &&
        !dom.statusPanel.contains(e.target) &&
        e.target !== dom.statusToggle) {
      dom.statusPanel.classList.remove('status-visible');
      dom.statusPanel.classList.add('status-hidden');
    }
  });

  // Header save/load button
  dom.saveBtn.addEventListener('click', showSaveMenu);

  // In-game save menu — save to slot
  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-to-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const existing = loadSaveFromSlot(slot);
      if (existing && !confirm(`Overwrite Slot ${slot}?`)) return;
      saveGameToSlot(slot);
      hideSaveMenu();
      showToast(`Saved to Slot ${slot}`);
      refreshAllSlotCards();
    });
  });

  // In-game save menu — close / backdrop / Escape
  dom.saveMenuClose.addEventListener('click', hideSaveMenu);
  dom.saveOverlay.addEventListener('click', e => { if (e.target === dom.saveOverlay) hideSaveMenu(); });
  dom.saveOverlay.addEventListener('keydown', e => { if (e.key === 'Escape') hideSaveMenu(); });

  // In-game save menu — delete slot
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

  // In-game save menu — load slot
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

  // In-game save menu — restart
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

  // Splash — New Game
  dom.splashNewBtn.addEventListener('click', async () => {
    hideSplash();
    const charData = await showCharacterCreation();
    patchPlayerState({
      first_name: charData.firstName,
      last_name:  charData.lastName,
      pronouns:   charData.pronouns,
    });
    dom.saveBtn.classList.remove('hidden');
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || 'prologue');
  });

  // Splash — Load Game (show slot list)
  dom.splashLoadBtn.addEventListener('click', () => {
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.add('hidden');
    dom.splashSlots.classList.remove('hidden');
    refreshAllSlotCards();
  });

  dom.splashSlotsBack.addEventListener('click', () => {
    dom.splashSlots.classList.add('hidden');
    dom.splashOverlay.querySelector('.splash-btn-col')?.classList.remove('hidden');
  });

  // Splash — load from slot
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

  // Splash — delete slot
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

  // Character creation input wiring lives in overlays.js — call once here
  wireCharCreation();
}

// ---------------------------------------------------------------------------
// boot — initialise all modules, then show the splash screen
// ---------------------------------------------------------------------------
async function boot() {
  // 1. Register shared caches with the interpreter
  registerCaches(sceneCache, labelsCache);

  // 2. Initialise UI modules with their DOM slices and cross-module callbacks.
  //    Each init() stores references locally so no module reaches into dom{}.

  initNarrative({
    narrativeContent: dom.narrativeContent,
    choiceArea:       dom.choiceArea,
    narrativePanel:   dom.narrativePanel,
    onShowLevelUp:    showInlineLevelUp,
    scheduleStatsRender,
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
  });

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
    gotoScene,
    runStatsScene,
    fetchTextFile,
    evalValue,
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
    scheduleStatsRender,
    setChapterTitle: (t) => { dom.chapterTitle.textContent = t; },
    runStatsScene,
    fetchTextFile,
  });

  // 4. Wire all UI event listeners
  wireUI();

  // 5. Parse startup.txt and show the splash screen
  try {
    await parseStartup(fetchTextFile, evalValue);
    showSplash();
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', boot);
