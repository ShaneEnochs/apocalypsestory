// ---------------------------------------------------------------------------
// ui/overlays.js — Splash, save menu, character creation, toast, focus trap
//
// Owns every overlay and modal flow:
//   trapFocus              — keyboard focus containment for overlays
//   showToast              — transient notification banner
//   populateSlotCard /
//   refreshAllSlotCards    — save slot card DOM sync
//   showSplash / hideSplash
//   showSaveMenu / hideSaveMenu
//   validateName /
//   wireCharCreation /
//   showCharacterCreation
//   loadAndResume          — shared helper used by both splash and in-game load
//
// DOM nodes and cross-module callbacks are injected at boot via init().
//
// Dependency graph:
//   overlays.js
//     → saves.js   (loadSaveFromSlot, restoreFromSave,
//                   _staleSaveFound, clearStaleSaveFound)
//     ← main.js    (injects dom slice + callbacks via init())
// ---------------------------------------------------------------------------

import {
  loadSaveFromSlot, restoreFromSave,
  _staleSaveFound, clearStaleSaveFound,
} from '../systems/saves.js';

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------

// Splash
let _splashOverlay  = null;
let _splashSlots    = null;

// Save menu
let _saveOverlay    = null;
let _saveBtn        = null;   // trigger element — focus returns here on close; also unhidden on load

// Char creation
let _charOverlay    = null;
let _inputFirstName = null;
let _inputLastName  = null;
let _counterFirst   = null;
let _counterLast    = null;
let _errorFirstName = null;
let _errorLastName  = null;
let _charBeginBtn   = null;

// Toast
let _toast          = null;

// Callbacks injected by main.js
let _runStatsScene       = null;   // async () → void
let _fetchTextFile       = null;   // async (name) → string
let _evalValue           = null;   // (expr) → value

// Phase 3 — new callbacks for the no-replay restoreFromSave
let _renderFromLog       = null;   // (log, opts) → void
let _renderChoices       = null;   // (choices) → void
let _runInterpreter      = null;   // async () → void
let _clearNarrative      = null;   // () → void
let _applyTransition     = null;   // () → void
let _setChapterTitle     = null;   // (t: string) → void
let _parseAndCacheScene  = null;   // async (name: string) → void
let _clearUndoStack      = null;   // () → void — clears undo history on load
let _setChoiceArea       = null;   // BUG-05 — (el) → void
let _setGameTitle        = null;   // (t: string) → void

export function init({
  splashOverlay, splashSlots,
  saveOverlay, saveBtn,
  charOverlay, inputFirstName, inputLastName,
  counterFirst, counterLast, errorFirstName, errorLastName, charBeginBtn,
  toast,
  runStatsScene, fetchTextFile, evalValue,
  // Callbacks needed by restoreFromSave:
  renderFromLog, renderChoices,
  runInterpreter,
  clearNarrative, applyTransition, setChapterTitle,
  parseAndCacheScene, setChoiceArea,
  clearUndoStack,
  setGameTitle,
}) {
  _splashOverlay  = splashOverlay;
  _splashSlots    = splashSlots;

  _saveOverlay    = saveOverlay;
  _saveBtn        = saveBtn;

  _charOverlay    = charOverlay;
  _inputFirstName = inputFirstName;
  _inputLastName  = inputLastName;
  _counterFirst   = counterFirst;
  _counterLast    = counterLast;
  _errorFirstName = errorFirstName;
  _errorLastName  = errorLastName;
  _charBeginBtn   = charBeginBtn;

  _toast          = toast;

  _runStatsScene      = runStatsScene;
  _fetchTextFile      = fetchTextFile;
  _evalValue          = evalValue;

  _renderFromLog      = renderFromLog;
  _renderChoices      = renderChoices;
  _runInterpreter     = runInterpreter;
  _clearNarrative     = clearNarrative;
  _applyTransition    = applyTransition;
  _setChapterTitle    = setChapterTitle;
  _parseAndCacheScene = parseAndCacheScene;
  _clearUndoStack     = clearUndoStack || null;
  _setChoiceArea      = setChoiceArea || null;
  _setGameTitle       = setGameTitle || null;
}

// ---------------------------------------------------------------------------
// trapFocus — keyboard focus containment for modal overlays.
// Returns a release() function that removes the listener and restores focus.
// ---------------------------------------------------------------------------
export function trapFocus(overlayEl, triggerEl = null) {
  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function getFocusable() {
    try {
      return [...overlayEl.querySelectorAll(FOCUSABLE)].filter(
        el => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none'
      );
    } catch (_) { return []; }
  }

  function handleKeydown(e) {
    if (e.key !== 'Tab') return;
    const focusable = getFocusable();
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }

  overlayEl.addEventListener('keydown', handleKeydown);
  requestAnimationFrame(() => {
    try {
      const focusable = getFocusable();
      if (focusable.length) focusable[0].focus();
    } catch (_) {}
  });

  return function release() {
    try { overlayEl.removeEventListener('keydown', handleKeydown); } catch (_) {}
    try { if (triggerEl && typeof triggerEl.focus === 'function') triggerEl.focus(); } catch (_) {}
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Toast queue — messages are displayed one at a time.
// ---------------------------------------------------------------------------
// showToast — transient notification banner.
// Toasts queue in call order. Processing is deferred by one setTimeout(0)
// tick so toasts queued synchronously in the same interpreter pass
// accumulate before the first one starts displaying.
// ---------------------------------------------------------------------------
const _toastQueue = [];
let   _toastActive = false;

function _processToastQueue() {
  if (_toastActive || _toastQueue.length === 0) return;
  _toastActive = true;

  const { message, durationMs } = _toastQueue.shift();

  _toast.textContent = message;
  _toast.className = _toast.className
    .split(' ')
    .filter(c => c === 'toast' || c === 'hidden')
    .join(' ');
  _toast.classList.remove('hidden', 'toast-hide');
  _toast.classList.add('toast-show');

  setTimeout(() => {
    _toast.classList.replace('toast-show', 'toast-hide');
    setTimeout(() => {
      _toast.classList.add('hidden');
      _toastActive = false;
      _processToastQueue();   // show next in queue
    }, 300);
  }, durationMs);
}

export function showToast(message, durationMs = 4000) {
  _toastQueue.push({ message, durationMs });
  setTimeout(_processToastQueue, 0);
}

// ---------------------------------------------------------------------------
// Slot card helpers — sync a single card's DOM to a save (or null = empty)
// ---------------------------------------------------------------------------
export function populateSlotCard({ nameEl, metaEl, loadBtn, deleteBtn, cardEl, save }) {
  if (save) {
    const d = new Date(save.timestamp);
    // BUG-L fix: strip any .txt extension from the scene name before
    // uppercasing it. If a *goto_scene directive ever passes "scene.txt"
    // instead of "scene", currentScene would contain the extension and the
    // slot card would display "PROLOGUE.TXT" instead of "PROLOGUE".
    const sceneDisplay = save.label
      ? save.label
      : save.scene.replace(/\.txt$/i, '').toUpperCase();  // ENH-06
    metaEl.textContent  = `${sceneDisplay} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    nameEl.textContent  = save.characterName || 'Unknown';
    loadBtn.disabled    = false;
    cardEl.classList.remove('slot-card--empty');
    if (deleteBtn) deleteBtn.classList.remove('hidden');
  } else {
    nameEl.textContent  = '— Empty —';
    metaEl.textContent  = '';
    loadBtn.disabled    = true;
    cardEl.classList.add('slot-card--empty');
    if (deleteBtn) deleteBtn.classList.add('hidden');
  }
}

// refreshAllSlotCards — updates every card in both splash and in-game menus
export function refreshAllSlotCards() {
  ['auto', 1, 2, 3].forEach(slot => {
    const save = loadSaveFromSlot(slot);
    const s    = String(slot);

    // Splash screen slot cards
    const sCard = document.getElementById(`slot-card-${s}`);
    if (sCard) populateSlotCard({
      nameEl:    document.getElementById(`slot-name-${s}`),
      metaEl:    document.getElementById(`slot-meta-${s}`),
      loadBtn:   document.getElementById(`slot-load-${s}`),
      deleteBtn: document.getElementById(`slot-delete-${s}`),
      cardEl:    sCard,
      save,
    });

    // In-game save menu slot cards (save-card-* prefix)
    // populateSlotCard sets loadBtn.disabled correctly — no second pass needed.
    const iCard = document.getElementById(`save-card-${s}`);
    if (iCard) populateSlotCard({
      nameEl:    document.getElementById(`save-slot-name-${s}`),
      metaEl:    document.getElementById(`save-slot-meta-${s}`),
      loadBtn:   document.getElementById(`ingame-load-${s}`),
      deleteBtn: document.getElementById(`save-delete-${s}`),
      cardEl:    iCard,
      save,
    });
  });
}

// ---------------------------------------------------------------------------
// loadAndResume — shared helper used by splash load and in-game load flows.
// Shows the save button, calls restoreFromSave with all injected dependencies.
// ---------------------------------------------------------------------------
export async function loadAndResume(save) {
  _saveBtn.classList.remove('hidden');
  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) undoBtn.classList.remove('hidden');
  // Clear undo history — snapshots from a previous session must not survive
  // a load, or the player could undo back into the wrong game state.
  if (_clearUndoStack) _clearUndoStack();
  await restoreFromSave(save, {
    runStatsScene:      _runStatsScene,
    renderFromLog:      _renderFromLog,
    renderChoices:      _renderChoices,
    runInterpreter:     _runInterpreter,
    clearNarrative:     _clearNarrative,
    applyTransition:    _applyTransition,
    setChapterTitle:    _setChapterTitle,
    setChoiceArea:      _setChoiceArea,
    parseAndCacheScene: _parseAndCacheScene,
    fetchTextFileFn:    _fetchTextFile,
    evalValueFn:        _evalValue,
  });

  // Restore game title from playerState after save restore
  if (_setGameTitle) {
    const ps = save.playerState || {};
    const title = ps.game_title || 'System Awakening';
    _setGameTitle(title);
  }
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------
export function showSplash() {
  // Pre-load all slots so card states are current before display
  ['auto', 1, 2, 3].forEach(loadSaveFromSlot);
  refreshAllSlotCards();

  // Stale-save notice: shown once on boot if a version-mismatched save exists
  const notice = document.getElementById('splash-stale-notice');
  if (notice) {
    if (_staleSaveFound) {
      notice.classList.remove('hidden');
      clearStaleSaveFound();
    } else {
      notice.classList.add('hidden');
    }
  }

  _splashOverlay.classList.remove('hidden');
  _splashOverlay.style.opacity = '1';
  _splashSlots.classList.add('hidden');
  _splashOverlay.querySelector('.splash-btn-col')?.classList.remove('hidden');
}

export function hideSplash() {
  _splashOverlay.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// In-game save menu
// ---------------------------------------------------------------------------
let _saveTrapRelease = null;

export function showSaveMenu() {
  refreshAllSlotCards();
  _saveOverlay.classList.remove('hidden');
  _saveOverlay.style.opacity = '1';
  _saveTrapRelease = trapFocus(_saveOverlay, _saveBtn);
}

export function hideSaveMenu() {
  _saveOverlay.classList.add('hidden');
  if (_saveTrapRelease) { _saveTrapRelease(); _saveTrapRelease = null; }
}

// ---------------------------------------------------------------------------
// Character creation
// ---------------------------------------------------------------------------
const NAME_MAX   = 14;
const NAME_REGEX = /^[\p{L}\p{M}'\- ]*$/u;

export function validateName(value, label) {
  const t = value.trim();
  if (!t)                  return `${label} cannot be empty.`;
  if (t.length > NAME_MAX) return `${label} must be ${NAME_MAX} characters or fewer.`;
  if (!NAME_REGEX.test(t)) return `${label} may only contain letters, hyphens, and apostrophes.`;
  if (/\s{2,}/.test(t))    return `${label} cannot contain consecutive spaces.`;
  if (/\-{2,}/.test(t))    return `${label} cannot contain consecutive hyphens.`;
  return null;
}

// wireCharCreation — attaches all input/keyboard/click handlers to the
// character creation overlay. Called once from main.js wireUI().
export function wireCharCreation() {
  function handleInput(inputEl, counterEl, errorEl, fieldLabel) {
    const cleaned = inputEl.value.replace(/[^\p{L}\p{M}'\- ]/gu, '');
    if (cleaned !== inputEl.value) {
      const pos = inputEl.selectionStart - (inputEl.value.length - cleaned.length);
      inputEl.value = cleaned;
      try { inputEl.setSelectionRange(pos, pos); } catch (_) {}
    }
    counterEl.textContent = NAME_MAX - inputEl.value.length;
    // BUG-7 fix: validate against the trimmed value so that a name with only
    // leading/trailing spaces shows an "empty" error in real-time, matching
    // what the submit handler stores after trimming.
    const err = validateName(inputEl.value.trim() === '' ? '' : inputEl.value, fieldLabel);
    inputEl.classList.toggle('char-input--error', !!err);
    errorEl.textContent = err || '';
    errorEl.classList.toggle('hidden', !err);
    updateBeginBtn();
  }

  _inputFirstName.addEventListener('input', () =>
    handleInput(_inputFirstName, _counterFirst, _errorFirstName, 'First name'));
  _inputLastName.addEventListener('input',  () =>
    handleInput(_inputLastName,  _counterLast,  _errorLastName,  'Last name'));
  _inputLastName.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !_charBeginBtn.disabled) _charBeginBtn.click();
  });

  const pronounCards = [..._charOverlay.querySelectorAll('.pronoun-card')];

  function selectCard(card) {
    pronounCards.forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('aria-checked', 'false');
      c.setAttribute('tabindex', '-1');
    });
    card.classList.add('selected');
    card.setAttribute('aria-checked', 'true');
    card.setAttribute('tabindex', '0');
    card.focus();
    updateBeginBtn();
  }

  pronounCards.forEach(card => {
    card.addEventListener('click', () => selectCard(card));
    card.addEventListener('keydown', e => {
      const idx = pronounCards.indexOf(card);
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); selectCard(pronounCards[(idx + 1) % pronounCards.length]);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); selectCard(pronounCards[(idx - 1 + pronounCards.length) % pronounCards.length]);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault(); selectCard(card);
      }
    });
  });

  function updateBeginBtn() {
    const ok = !validateName(_inputFirstName.value, 'First name') &&
               !validateName(_inputLastName.value,  'Last name')  &&
               !!_charOverlay.querySelector('.pronoun-card.selected');
    _charBeginBtn.disabled = !ok;
  }

  _charBeginBtn.addEventListener('click', () => {
    if (validateName(_inputFirstName.value, 'First name') ||
        validateName(_inputLastName.value,  'Last name'))  return;
    const selected = _charOverlay.querySelector('.pronoun-card.selected');
    if (!selected) return;
    _charOverlay.classList.add('hidden');
    if (typeof _charOverlay._trapRelease === 'function') {
      _charOverlay._trapRelease();
      _charOverlay._trapRelease = null;
    }
    if (typeof _charOverlay._resolve === 'function') {
      _charOverlay._resolve({
        firstName:                _inputFirstName.value.trim(),
        lastName:                 _inputLastName.value.trim(),
        pronouns_subject:         selected.dataset.subject,
        pronouns_object:          selected.dataset.object,
        pronouns_possessive:      selected.dataset.possessive,
        pronouns_possessive_pronoun: selected.dataset.possessivePronoun,
        pronouns_reflexive:       selected.dataset.reflexive,
        pronouns_label:           selected.dataset.pronouns,
      });
    }
  });
}

// showCharacterCreation — resets and shows the overlay; returns a Promise
// that resolves with { firstName, lastName, pronouns } when the user submits.
export function showCharacterCreation() {
  _inputFirstName.value = '';
  _inputLastName.value  = '';
  _counterFirst.textContent = String(NAME_MAX);
  _counterLast.textContent  = String(NAME_MAX);
  _errorFirstName.classList.add('hidden');
  _errorLastName.classList.add('hidden');
  _inputFirstName.classList.remove('char-input--error');
  _inputLastName.classList.remove('char-input--error');
  _charBeginBtn.disabled = true;

  _charOverlay.querySelectorAll('.pronoun-card').forEach(c => {
    const def = c.dataset.pronouns === 'they/them';
    c.classList.toggle('selected', def);
    c.setAttribute('aria-checked', def ? 'true' : 'false');
    c.setAttribute('tabindex', def ? '0' : '-1');
  });

  _charOverlay.classList.remove('hidden');
  _charOverlay.style.opacity = '1';
  requestAnimationFrame(() => {
    const release = trapFocus(_charOverlay, null);
    _charOverlay._trapRelease = release;
    // Focus the first name input inside the same rAF that wires the focus
    // trap, so tab order is established before the field is focused.
    try { _inputFirstName.focus(); } catch (_) {}
  });

  return new Promise(resolve => { _charOverlay._resolve = resolve; });
}
