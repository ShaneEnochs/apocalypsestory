
// ---------------------------------------------------------------------------
// engine.js — System Awakening coordinator (Phase 4 complete)
//
// FIX #S6 (sweep 5): popUndo no longer calls runInterpreter(). Previously
//   it re-ran the interpreter from the snapshot ip, which caused:
//   - BUG 2: a duplicate auto-save overwriting the player's actual progress
//   - BUG 3: potential duplicate paragraphs if lines existed between ip and *choice
//   Now popUndo restores awaitingChoice from the snapshot and calls
//   renderChoices directly to re-create buttons with live click handlers.
//   pushUndoSnapshot now captures awaitingChoice in the snapshot.
// ---------------------------------------------------------------------------

import {
  playerState, tempState, statRegistry, startup,
  currentScene, currentLines, ip,
  awaitingChoice,
  patchPlayerState, parseStartup, captureStartupDefaults,
  setPlayerState, setTempState,
  setCurrentScene, setCurrentLines, setIp,
  setAwaitingChoice,
  setChapterTitleState,
} from './engine/core/state.js';

import { evalValue }       from './engine/core/expression.js';

import {
  registerCallbacks, registerCaches,
  gotoScene, runInterpreter,
  executeBlock,
} from './engine/core/interpreter.js';

import { parseLines, indexLabels } from './engine/core/parser.js';

import {
  loadSaveFromSlot, saveGameToSlot,
  deleteSaveSlot, exportSaveSlot, importSaveFromJSON,
  encodeSaveCode, decodeSaveCode,
} from './engine/systems/saves.js';

import { parseSkills } from './engine/systems/skills.js';
import { parseItems }  from './engine/systems/items.js';

import {
  init      as initNarrative,
  addParagraph, addSystem, clearNarrative, applyTransition,
  renderChoices, showInputPrompt, showPageBreak, setChoiceArea,
  getNarrativeLog, renderFromLog,
  formatText,
} from './engine/ui/narrative.js';

import {
  init      as initPanels,
  runStatsScene, showEndingScreen,
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

const dom = {
  narrativeContent:   document.getElementById('narrative-content'),
  choiceArea:         document.getElementById('choice-area'),
  chapterTitle:       document.getElementById('chapter-title'),
  narrativePanel:     document.getElementById('narrative-panel'),
  statusPanel:        document.getElementById('status-panel'),
  statusToggle:       document.getElementById('status-toggle'),
  saveBtn:            document.getElementById('save-btn'),
  gameTitle:          document.getElementById('game-title'),
  splashTitle:        document.querySelector('.splash-title'),
  splashTagline: document.getElementById('splash-tagline'),
  splashOverlay:      document.getElementById('splash-overlay'),
  splashNewBtn:       document.getElementById('splash-new-btn'),
  splashLoadBtn:      document.getElementById('splash-load-btn'),
  splashSlots:        document.getElementById('splash-slots'),
  splashSlotsBack:    document.getElementById('splash-slots-back'),
  saveOverlay:        document.getElementById('save-overlay'),
  saveMenuClose:      document.getElementById('save-menu-close'),
  charOverlay:        document.getElementById('char-creation-overlay'),
  inputFirstName:     document.getElementById('input-first-name'),
  inputLastName:      document.getElementById('input-last-name'),
  counterFirst:       document.getElementById('counter-first'),
  counterLast:        document.getElementById('counter-last'),
  errorFirstName:     document.getElementById('error-first-name'),
  errorLastName:      document.getElementById('error-last-name'),
  charBeginBtn:       document.getElementById('char-begin-btn'),
  endingOverlay:      document.getElementById('ending-overlay'),
  endingTitle:        document.getElementById('ending-title'),
  endingContent:      document.getElementById('ending-content'),
  endingStats:        document.getElementById('ending-stats'),
  endingActionBtn:    document.getElementById('ending-action-btn'),
  storeOverlay:       document.getElementById('store-overlay'),
  toast:              document.getElementById('toast'),
};

Object.entries(dom).forEach(([key, el]) => {
  if (!el) console.warn(`[engine] DOM element missing: "${key}" — check index.html IDs`);
});

const sceneCache  = new Map();
const labelsCache = new Map();

let _statsRenderPending = false;

function scheduleStatsRender() {
  if (_statsRenderPending) return;
  _statsRenderPending = true;
  requestAnimationFrame(() => {
    _statsRenderPending = false;
    runStatsScene();
    updateUndoBtn();
  });
}

async function fetchTextFile(name) {
  const key = name.endsWith('.txt') ? name : `${name}.txt`;
  if (sceneCache.has(key)) return sceneCache.get(key);
  const res = await fetch(key);
  if (!res.ok) throw new Error(`Failed to load ${key}`);
  const text = await res.text();
  sceneCache.set(key, text);
  return text;
}

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
// Undo system
// ---------------------------------------------------------------------------
const _undoStack = [];
const UNDO_MAX = 10;

function pushUndoSnapshot() {
  _undoStack.push({
    playerState:      JSON.parse(JSON.stringify(playerState)),
    tempState:        JSON.parse(JSON.stringify(tempState)),
    scene:            currentScene,
    ip,
    narrativeLog:     JSON.parse(JSON.stringify(getNarrativeLog())),
    chapterTitle:     dom.chapterTitle.textContent,
    awaitingChoice:   awaitingChoice
      ? JSON.parse(JSON.stringify(awaitingChoice))
      : null,
  });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  updateUndoBtn();
}

async function popUndo() {
  if (_undoStack.length === 0) return;
  const snap = _undoStack.pop();

  setPlayerState(JSON.parse(JSON.stringify(snap.playerState)));
  setTempState(JSON.parse(JSON.stringify(snap.tempState)));
  setCurrentScene(snap.scene);

  const text = sceneCache.get(snap.scene.endsWith('.txt') ? snap.scene : `${snap.scene}.txt`);
  if (text) {
    setCurrentLines(parseLines(text));
    indexLabels(snap.scene, currentLines, labelsCache);
  }
  setIp(snap.ip);
  setAwaitingChoice(null);

  dom.chapterTitle.textContent = snap.chapterTitle;
  setChapterTitleState(snap.chapterTitle);

  renderFromLog(snap.narrativeLog, { skipAnimations: true });

  dom.choiceArea = document.getElementById('choice-area');
  setChoiceArea(dom.choiceArea);

  // FIX #S6 (BUG 2 + BUG 3): Restore choices directly from the snapshot
  // instead of calling runInterpreter(). This avoids:
  //   - BUG 2: runInterpreter writes an auto-save, overwriting the player's
  //     actual progress with the undo'd state.
  //   - BUG 3: runInterpreter re-executes lines between ip and *choice,
  //     potentially duplicating paragraphs already painted by renderFromLog.
  if (snap.awaitingChoice) {
    setAwaitingChoice(snap.awaitingChoice);
    renderChoices(snap.awaitingChoice.choices);
  }

  runStatsScene();
  updateUndoBtn();
}

function updateUndoBtn() {
  const btn = document.getElementById('undo-btn');
  if (!btn) return;
  btn.disabled = _undoStack.length === 0;
}

// ---------------------------------------------------------------------------
// wireUI
// ---------------------------------------------------------------------------
function wireUI() {
  dom.statusToggle.addEventListener('click', () => {
    const visible = dom.statusPanel.classList.toggle('status-visible');
    dom.statusPanel.classList.toggle('status-hidden', !visible);
    runStatsScene();
  });

  document.addEventListener('click', e => {
    if (!dom.statusPanel.contains(e.target) &&
        e.target !== dom.statusToggle &&
        !dom.storeOverlay?.contains(e.target)) {
      dom.statusPanel.classList.remove('status-visible');
      dom.statusPanel.classList.add('status-hidden');
    }
  });

  dom.saveBtn.addEventListener('click', () => {
    showSaveMenu();
  });

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
      first_name:                  charData.firstName,
      last_name:                   charData.lastName,
      pronouns_subject:            charData.pronouns_subject,
      pronouns_object:             charData.pronouns_object,
      pronouns_possessive:         charData.pronouns_possessive,
      pronouns_possessive_pronoun: charData.pronouns_possessive_pronoun,
      pronouns_reflexive:          charData.pronouns_reflexive,
      pronouns_label:              charData.pronouns_label,
    });
    dom.saveBtn.classList.remove('hidden');
    document.getElementById('undo-btn')?.classList.remove('hidden');
    _undoStack.splice(0);
    updateUndoBtn();
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

  // Save code system — Copy Code / Load Code
  const codeCopyBtn = document.getElementById('save-code-copy');
  if (codeCopyBtn) {
    codeCopyBtn.addEventListener('click', () => {
      const code = encodeSaveCode(getNarrativeLog());
      const field = document.getElementById('save-code-field');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => {
          showToast('Save code copied to clipboard.');
          if (field) field.value = code;
        }).catch(() => {
          if (field) { field.value = code; field.select(); }
          showToast('Code generated — copy it from the text box.');
        });
      } else {
        if (field) { field.value = code; field.select(); }
        showToast('Code generated — copy it from the text box.');
      }
    });
  }

  const codeLoadBtn = document.getElementById('save-code-load');
  if (codeLoadBtn) {
    codeLoadBtn.addEventListener('click', async () => {
      const field = document.getElementById('save-code-field');
      const code = field?.value?.trim();
      if (!code) { showToast('Paste a save code first.'); return; }

      const result = decodeSaveCode(code);
      if (!result.ok) { showToast(`Load failed: ${result.reason}`); return; }

      hideSaveMenu();
      await loadAndResume(result.save);
      showToast('Save code loaded successfully.');
    });
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot() {
  registerCaches(sceneCache, labelsCache);

  initNarrative({
    narrativeContent: dom.narrativeContent,
    choiceArea:       dom.choiceArea,
    narrativePanel:   dom.narrativePanel,
    scheduleStatsRender,
    onBeforeChoice:   pushUndoSnapshot,
    executeBlock,
    runInterpreter,
  });

  initPanels({
    statusPanel:      dom.statusPanel,
    endingOverlay:    dom.endingOverlay,
    endingTitle:      dom.endingTitle,
    endingContent:    dom.endingContent,
    endingStats:      dom.endingStats,
    endingActionBtn:  dom.endingActionBtn,
    storeOverlay:     dom.storeOverlay,
    fetchTextFile,
    scheduleStatsRender,
    trapFocus,
    showToast,
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
    runStatsScene,
    fetchTextFile,
    evalValue,
    renderFromLog,
    renderChoices,
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
    },
    setGameTitle: (t) => {
      if (dom.gameTitle)   dom.gameTitle.textContent = t;
      if (dom.splashTitle) dom.splashTitle.textContent = t;
      document.title = t;
    },
  });

  registerCallbacks({
    addParagraph,
    addSystem,
    clearNarrative,
    applyTransition,
    renderChoices,
    showEndingScreen,
    showEngineError,
    showInputPrompt,
    showPageBreak,
    scheduleStatsRender,
    showToast,
    formatText,
    setChapterTitle: (t) => { dom.chapterTitle.textContent = t; setChapterTitleState(t); },
    setGameTitle: (t) => {
      if (dom.gameTitle)   dom.gameTitle.textContent = t;
      if (dom.splashTitle) dom.splashTitle.textContent = t;
      document.title = t;
    },
    setGameByline: (t) => {
      if (dom.splashTagline) dom.splashTagline.innerHTML = t;
    },
    runStatsScene,
    fetchTextFile,
    getNarrativeLog,
  });

  wireUI();

  try {
    await parseStartup(fetchTextFile, evalValue);
    captureStartupDefaults();
    await parseSkills(fetchTextFile);
    await parseItems(fetchTextFile);

    const title = playerState.game_title || '';
    if (dom.gameTitle) dom.gameTitle.textContent = title;
    if (dom.splashTitle) dom.splashTitle.textContent = title;
    document.title = title;

    const byline = playerState.game_byline || '';
    if (dom.splashTagline && byline) dom.splashTagline.innerHTML = byline;
    showSplash();
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', boot);