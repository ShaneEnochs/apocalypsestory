// engine.ts — System Awakening boot sequence
//
// Wires all modules together and starts the game. Everything non-trivial
// has been extracted into focused modules:
//   src/core/dom.ts             — Dom interface, buildDom(), title helpers
//   src/systems/undo.ts         — Undo snapshot stack
//   src/systems/save-manager.ts — Save/load UI wiring

import { buildDom, setChapterTitle, setGameTitle, registerChapterCardLog, initThemeToggle } from './src/core/dom.js';
import {
  playerState, startup,
  setCurrentLines, currentLines,
  parseStartup, captureStartupDefaults,
} from './src/core/state.js';
import { evalValue }             from './src/core/expression.js';
import { parseLines, indexLabels } from './src/core/parser.js';
import {
  registerCallbacks, registerCaches,
  runInterpreter, executeBlock,
} from './src/core/interpreter.js';
import { parseSkills }           from './src/systems/skills.js';
import { parseItems }            from './src/systems/items.js';
import { parseProcedures }       from './src/systems/procedures.js';
import { parseGlossary }         from './src/systems/glossary.js';
import { initUndo, pushUndoSnapshot, clearUndoStack } from './src/systems/undo.js';
import { wireSaveUI }            from './src/systems/save-manager.js';
import {
  init as initNarrative, addParagraph, addSystem,
  clearNarrative, applyTransition,
  renderChoices, showInputPrompt, showPageBreak, setChoiceArea,
  getNarrativeLog, renderFromLog, formatText, addImage, pushNarrativeLogEntry,
} from './src/ui/narrative.js';
import { init as initPanels, runStatsScene, showEndingScreen } from './src/ui/panels.js';
import { init as initOverlays, trapFocus, showToast, showSplash } from './src/ui/overlays.js';

// ---------------------------------------------------------------------------
// Caches shared by interpreter and engine
// ---------------------------------------------------------------------------
const sceneCache  = new Map<string, string>();
const labelsCache = new Map<string, Record<string, number>>();

// ---------------------------------------------------------------------------
// fetchTextFile — loads and caches scene text files
// ---------------------------------------------------------------------------
async function fetchTextFile(name: string): Promise<string> {
  const key = name.endsWith('.txt') ? name : `${name}.txt`;
  if (sceneCache.has(key)) return sceneCache.get(key)!;
  const res = await fetch(key);
  if (!res.ok) throw new Error(`Failed to load ${key}`);
  const text = await res.text();
  sceneCache.set(key, text);
  return text;
}

// ---------------------------------------------------------------------------
// showEngineError — renders a fatal error in the narrative panel
// ---------------------------------------------------------------------------
function showEngineError(message: string): void {
  clearNarrative();
  const div = document.createElement('div');
  div.className = 'system-block';
  div.style.borderLeftColor = div.style.color = 'var(--red)';
  const lbl = document.createElement('span');
  lbl.className = 'system-block-label'; lbl.textContent = '[ ENGINE ERROR ]';
  const txt = document.createElement('span');
  txt.className = 'system-block-text';
  txt.textContent = `${message}\n\nUse the Restart button to reload.`;
  div.append(lbl, txt);
  document.getElementById('narrative-content')
    ?.insertBefore(div, document.getElementById('choice-area'));
  const ct = document.getElementById('chapter-title');
  if (ct) ct.textContent = 'ERROR';
}

// ---------------------------------------------------------------------------
// scheduleStatsRender — batches rapid stat-change callbacks into one rAF
// ---------------------------------------------------------------------------
let _statsRenderPending = false;
function scheduleStatsRender(): void {
  if (_statsRenderPending) return;
  _statsRenderPending = true;
  requestAnimationFrame(() => {
    _statsRenderPending = false;
    runStatsScene();
    import('./src/systems/undo.js').then(m => m.updateUndoBtn());
  });
}

// ---------------------------------------------------------------------------
// boot — initialises every module and shows the splash screen
// ---------------------------------------------------------------------------
async function boot(): Promise<void> {
  initThemeToggle();
  const dom = buildDom();
  registerCaches(sceneCache, labelsCache);
  registerChapterCardLog(pushNarrativeLogEntry);
  initUndo({ chapterTitleEl: dom.chapterTitle, sceneCache, labelsCache });

  initNarrative({
    narrativeContent: dom.narrativeContent, choiceArea: dom.choiceArea,
    narrativePanel: dom.narrativePanel, scheduleStatsRender,
    onBeforeChoice: pushUndoSnapshot, executeBlock, runInterpreter,
  });
  initPanels({
    statusPanel: dom.statusPanel, endingOverlay: dom.endingOverlay,
    endingTitle: dom.endingTitle, endingContent: dom.endingContent,
    endingStats: dom.endingStats, endingActionBtn: dom.endingActionBtn,
    storeOverlay: dom.storeOverlay, fetchTextFile,
    scheduleStatsRender, trapFocus, showToast,
  });
  initOverlays({
    splashOverlay: dom.splashOverlay, splashSlots: dom.splashSlots,
    saveOverlay: dom.saveOverlay, saveBtn: dom.saveBtn,
    charOverlay: dom.charOverlay,
    inputFirstName: dom.inputFirstName, inputLastName: dom.inputLastName,
    counterFirst: dom.counterFirst, counterLast: dom.counterLast,
    errorFirstName: dom.errorFirstName, errorLastName: dom.errorLastName,
    charBeginBtn: dom.charBeginBtn, toast: dom.toast,
    runStatsScene, fetchTextFile, evalValue,
    renderFromLog:  renderFromLog as (log: unknown[], opts?: { skipAnimations?: boolean }) => void,
    renderChoices:  renderChoices as (choices: unknown[]) => void,
    runInterpreter, clearNarrative, applyTransition, setChapterTitle,
    parseAndCacheScene: async (name: string) => {
      const text = await fetchTextFile(name);
      setCurrentLines(parseLines(text));
      indexLabels(name, currentLines, labelsCache);
    },
    setChoiceArea: (el: HTMLElement | null) => {
      dom.choiceArea = el as HTMLElement;
      if (el) setChoiceArea(el);
    },
    clearUndoStack, setGameTitle,
  });
  registerCallbacks({
    addParagraph, addSystem, clearNarrative, applyTransition,
    renderChoices, showEndingScreen, showEngineError,
    showInputPrompt, showPageBreak, scheduleStatsRender,
    showToast, formatText, setChapterTitle, setGameTitle,
    setGameByline: (t: string) => {
      if (dom.splashTagline) dom.splashTagline.textContent = t;
    },
    runStatsScene, fetchTextFile, getNarrativeLog, addImage,
  });
  wireSaveUI(dom, { scheduleStatsRender, setChapterTitle });

  try {
    await parseStartup(fetchTextFile, evalValue);
    captureStartupDefaults();
    await parseSkills(fetchTextFile);
    await parseItems(fetchTextFile);
    await parseProcedures(fetchTextFile);
    await parseGlossary(fetchTextFile);
    setGameTitle(String(playerState.game_title  || ''));
    if (dom.splashTagline && playerState.game_byline)
      dom.splashTagline.textContent = String(playerState.game_byline);
    showSplash();
  } catch (err) {
    showEngineError(`Boot failed: ${(err as Error).message}`);
  }
}

document.addEventListener('DOMContentLoaded', boot);
