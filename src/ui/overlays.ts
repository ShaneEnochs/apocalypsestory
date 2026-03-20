// ui/overlays.js — Splash, save menu, character creation, toast, focus trap
//
// Owns every overlay and modal flow:
//   trapFocus, showToast, populateSlotCard, refreshAllSlotCards,
//   showSplash / hideSplash, showSaveMenu / hideSaveMenu,
//   wireCharCreation / showCharacterCreation, loadAndResume
//
// DOM nodes and cross-module callbacks are injected at boot via init().

import {
  loadSaveFromSlot, restoreFromSave,
  _staleSaveFound, clearStaleSaveFound,
  getCheckpoints, CHECKPOINT_PREFIX, decodeSaveCode,
} from '../systems/saves.js';

export interface CharacterData {
  firstName:                  string;
  lastName:                   string;
  pronouns_subject:           string;
  pronouns_object:            string;
  pronouns_possessive:        string;
  pronouns_possessive_pronoun: string;
  pronouns_reflexive:         string;
  pronouns_label:             string;
}

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------

// Splash
let _splashOverlay!: HTMLElement;
let _splashSlots!:   HTMLElement;

// Save menu
let _saveOverlay!: HTMLElement;
let _saveBtn!:     HTMLElement;

// Char creation
let _charOverlay!:    HTMLElement;
let _inputFirstName!: HTMLInputElement;
let _inputLastName!:  HTMLInputElement;
let _counterFirst!:   HTMLElement;
let _counterLast!:    HTMLElement;
let _errorFirstName!: HTMLElement;
let _errorLastName!:  HTMLElement;
let _charBeginBtn!:   HTMLButtonElement;

// Toast
let _toast!: HTMLElement;

// Callbacks injected by engine.js
let _runStatsScene!:      () => Promise<void>;
let _fetchTextFile!:      (name: string) => Promise<string>;
let _evalValue!:          (expr: string) => unknown;
let _renderFromLog!:      (log: unknown[], opts?: { skipAnimations?: boolean }) => void;
let _renderChoices!:      (choices: unknown[]) => void;
let _runInterpreter!:     (opts?: { suppressAutoSave?: boolean }) => Promise<void>;
let _clearNarrative!:     () => void;
let _applyTransition!:    () => void;
let _setChapterTitle!:    (t: string) => void;
let _parseAndCacheScene!: (name: string) => Promise<void>;
let _clearUndoStack:      (() => void) | null = null;
let _setChoiceArea:       ((el: HTMLElement | null) => void) | null = null;
let _setGameTitle:        ((t: string) => void) | null = null;

export function init({
  splashOverlay, splashSlots,
  saveOverlay, saveBtn,
  charOverlay, inputFirstName, inputLastName,
  counterFirst, counterLast, errorFirstName, errorLastName, charBeginBtn,
  toast,
  runStatsScene, fetchTextFile, evalValue,
  renderFromLog, renderChoices,
  runInterpreter,
  clearNarrative, applyTransition, setChapterTitle,
  parseAndCacheScene, setChoiceArea,
  clearUndoStack,
  setGameTitle,
}: {
  splashOverlay:       HTMLElement;
  splashSlots:         HTMLElement;
  saveOverlay:         HTMLElement;
  saveBtn:             HTMLElement;
  charOverlay:         HTMLElement;
  inputFirstName:      HTMLInputElement;
  inputLastName:       HTMLInputElement;
  counterFirst:        HTMLElement;
  counterLast:         HTMLElement;
  errorFirstName:      HTMLElement;
  errorLastName:       HTMLElement;
  charBeginBtn:        HTMLButtonElement;
  toast:               HTMLElement;
  runStatsScene:       () => Promise<void>;
  fetchTextFile:       (name: string) => Promise<string>;
  evalValue:           (expr: string) => unknown;
  renderFromLog:       (log: unknown[], opts?: { skipAnimations?: boolean }) => void;
  renderChoices:       (choices: unknown[]) => void;
  runInterpreter:      (opts?: { suppressAutoSave?: boolean }) => Promise<void>;
  clearNarrative:      () => void;
  applyTransition:     () => void;
  setChapterTitle:     (t: string) => void;
  parseAndCacheScene:  (name: string) => Promise<void>;
  setChoiceArea:       ((el: HTMLElement | null) => void) | null;
  clearUndoStack:      (() => void) | null;
  setGameTitle:        ((t: string) => void) | null;
}): void {
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
export function trapFocus(overlayEl: HTMLElement, triggerEl: HTMLElement | null = null): () => void {
  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function getFocusable(): HTMLElement[] {
    try {
      return [...overlayEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        el => !el.closest('[hidden]') && getComputedStyle(el).display !== 'none'
      );
    } catch (_) { return []; }
  }

  function handleKeydown(e: KeyboardEvent): void {
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
// Toast queue — messages are displayed one at a time.
// ---------------------------------------------------------------------------
const _toastQueue: Array<{ message: string; durationMs: number; rarity?: string }> = [];
let   _toastActive = false;

function _processToastQueue(): void {
  if (_toastActive || _toastQueue.length === 0) return;
  _toastActive = true;

  const { message, durationMs, rarity } = _toastQueue.shift()!;

  _toast.textContent = message;
  _toast.className = _toast.className
    .split(' ')
    .filter((c: string) => c === 'toast' || c === 'hidden')
    .join(' ');
  if (rarity && rarity !== 'common') _toast.classList.add(`toast--rarity-${rarity}`);
  _toast.classList.remove('hidden', 'toast-hide');
  _toast.classList.add('toast-show');

  setTimeout(() => {
    _toast.classList.replace('toast-show', 'toast-hide');
    setTimeout(() => {
      _toast.classList.add('hidden');
      _toastActive = false;
      _processToastQueue();
    }, 300);
  }, durationMs);
}

export function showToast(message: string, durationMs = 4000, rarity?: string): void {
  _toastQueue.push({ message, durationMs, rarity });
  setTimeout(_processToastQueue, 0);
}

// ---------------------------------------------------------------------------
// Slot card helpers — sync a single card's DOM to a save (or null = empty)
// ---------------------------------------------------------------------------
export function populateSlotCard({ nameEl, metaEl, loadBtn, deleteBtn, cardEl, save }: {
  nameEl:    HTMLElement | null;
  metaEl:    HTMLElement | null;
  loadBtn:   HTMLElement | null;
  deleteBtn: HTMLElement | null;
  cardEl:    HTMLElement;
  save:      any;
}): void {
  const lbtn = loadBtn as HTMLButtonElement | null;
  if (save) {
    const d = new Date(save.timestamp);
    const sceneDisplay = save.label
      ? save.label
      : save.scene.replace(/\.txt$/i, '').toUpperCase();
    if (metaEl) metaEl.textContent  = `${sceneDisplay} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    if (nameEl) nameEl.textContent  = save.characterName || 'Unknown';
    if (lbtn)   lbtn.disabled       = false;
    cardEl.classList.remove('slot-card--empty');
    if (deleteBtn) deleteBtn.classList.remove('hidden');
  } else {
    if (nameEl) nameEl.textContent  = '— Empty —';
    if (metaEl) metaEl.textContent  = '';
    if (lbtn)   lbtn.disabled       = true;
    cardEl.classList.add('slot-card--empty');
    if (deleteBtn) deleteBtn.classList.add('hidden');
  }
}

// refreshAllSlotCards — updates every card in both splash and in-game menus
export function refreshAllSlotCards(): void {
  ['auto', 1, 2, 3].forEach(slot => {
    const save = loadSaveFromSlot(slot);
    const s    = String(slot);

    const sCard = document.getElementById(`slot-card-${s}`);
    if (sCard) populateSlotCard({
      nameEl:    document.getElementById(`slot-name-${s}`),
      metaEl:    document.getElementById(`slot-meta-${s}`),
      loadBtn:   document.getElementById(`slot-load-${s}`),
      deleteBtn: document.getElementById(`slot-delete-${s}`),
      cardEl:    sCard,
      save,
    });

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
// ---------------------------------------------------------------------------
export async function loadAndResume(save: any): Promise<void> {
  _saveBtn.classList.remove('hidden');
  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) undoBtn.classList.remove('hidden');
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

  if (_setGameTitle) {
    const ps = save.playerState || {};
    const title = ps.game_title || 'System Awakening';
    _setGameTitle(title);
  }
}

// ---------------------------------------------------------------------------
// Splash screen
// ---------------------------------------------------------------------------
export function showSplash(): void {
  ['auto', 1, 2, 3].forEach(loadSaveFromSlot);
  refreshAllSlotCards();

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

export function hideSplash(): void {
  _splashOverlay.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// In-game save menu
// ---------------------------------------------------------------------------
let _saveTrapRelease: (() => void) | null = null;

function refreshCheckpoints(): void {
  const list   = document.getElementById('checkpoint-list');
  const toggle = document.getElementById('checkpoint-toggle');
  if (!list || !toggle) return;

  const checkpoints = getCheckpoints().filter((cp): cp is NonNullable<typeof cp> => cp !== null);

  if (checkpoints.length === 0) {
    list.innerHTML = '<div class="checkpoint-empty">No checkpoints yet.</div>';
  } else {
    const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    list.innerHTML = checkpoints.map(cp => `
      <div class="checkpoint-card" data-slot="${cp.slot}">
        <span class="checkpoint-label">${escapeHtml(cp.label)}</span>
        <span class="checkpoint-time">${fmt.format(new Date(cp.timestamp))}</span>
        <button class="slot-load-btn slot-load-btn--load checkpoint-load-btn" data-checkpoint="${cp.slot}">Load</button>
      </div>`).join('');
  }

  // Collapse by default each time the menu opens
  list.classList.add('hidden');
  toggle.textContent = '▸ Checkpoints';

  // Toggle expand/collapse
  const newToggle = toggle.cloneNode(true) as HTMLElement;
  toggle.replaceWith(newToggle);
  newToggle.addEventListener('click', () => {
    const isHidden = list.classList.toggle('hidden');
    newToggle.textContent = isHidden ? '▸ Checkpoints' : '▾ Checkpoints';
  });

  // Wire load buttons
  list.querySelectorAll<HTMLElement>('.checkpoint-load-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const slot = Number(btn.dataset.checkpoint);
      const raw  = localStorage.getItem(`${CHECKPOINT_PREFIX}${slot}`);
      if (!raw) return;
      const result = decodeSaveCode(raw);
      if (!result.ok) {
        showToast(`Checkpoint load failed: ${(result as { ok: false; reason: string }).reason}`);
        return;
      }
      hideSaveMenu();
      await loadAndResume((result as { ok: true; save: unknown }).save);
      showToast('Checkpoint loaded.');
    });
  });
}

function escapeHtml(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function showSaveMenu(): void {
  refreshAllSlotCards();
  refreshCheckpoints();
  _saveOverlay.classList.remove('hidden');
  _saveOverlay.style.opacity = '1';
  _saveTrapRelease = trapFocus(_saveOverlay, _saveBtn);
}

export function hideSaveMenu(): void {
  _saveOverlay.classList.add('hidden');
  if (_saveTrapRelease) { _saveTrapRelease(); _saveTrapRelease = null; }
}

// ---------------------------------------------------------------------------
// Character creation
// ---------------------------------------------------------------------------
const NAME_MAX   = 14;
const NAME_REGEX = /^[\p{L}\p{M}'\- ]*$/u;

export function validateName(value: string, label: string): string | null {
  const t = value.trim();
  if (!t)                  return `${label} cannot be empty.`;
  if (t.length > NAME_MAX) return `${label} must be ${NAME_MAX} characters or fewer.`;
  if (!NAME_REGEX.test(t)) return `${label} may only contain letters, hyphens, and apostrophes.`;
  if (/\s{2,}/.test(t))    return `${label} cannot contain consecutive spaces.`;
  if (/\-{2,}/.test(t))    return `${label} cannot contain consecutive hyphens.`;
  return null;
}

export function wireCharCreation(): void {
  function handleInput(inputEl: HTMLInputElement, counterEl: HTMLElement, errorEl: HTMLElement, fieldLabel: string): void {
    const cleaned = inputEl.value.replace(/[^\p{L}\p{M}'\- ]/gu, '');
    if (cleaned !== inputEl.value) {
      const pos = Math.max(0, (inputEl.selectionStart ?? 0) - (inputEl.value.length - cleaned.length));
      inputEl.value = cleaned;
      try { inputEl.setSelectionRange(pos, pos); } catch (_) {}
    }
    counterEl.textContent = String(NAME_MAX - inputEl.value.length);
    // Validate against trimmed value so whitespace-only names show an error.
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
  _inputLastName.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !_charBeginBtn.disabled) _charBeginBtn.click();
  });

  const pronounCards = [..._charOverlay.querySelectorAll<HTMLElement>('.pronoun-card')];

  function selectCard(card: HTMLElement): void {
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
    card.addEventListener('keydown', (e: KeyboardEvent) => {
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
    const selected = _charOverlay.querySelector<HTMLElement>('.pronoun-card.selected');
    if (!selected) return;
    _charOverlay.classList.add('hidden');
    const overlay = _charOverlay as any;
    if (typeof overlay._trapRelease === 'function') {
      overlay._trapRelease();
      overlay._trapRelease = null;
    }
    if (typeof overlay._resolve === 'function') {
      overlay._resolve({
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
// that resolves with character data when the user submits.
export function showCharacterCreation(): Promise<CharacterData> {
  _inputFirstName.value = '';
  _inputLastName.value  = '';
  _counterFirst.textContent = String(NAME_MAX);
  _counterLast.textContent  = String(NAME_MAX);
  _errorFirstName.classList.add('hidden');
  _errorLastName.classList.add('hidden');
  _inputFirstName.classList.remove('char-input--error');
  _inputLastName.classList.remove('char-input--error');
  _charBeginBtn.disabled = true;

  _charOverlay.querySelectorAll<HTMLElement>('.pronoun-card').forEach((c: HTMLElement) => {
    const def = c.dataset.pronouns === 'they/them';
    c.classList.toggle('selected', def);
    c.setAttribute('aria-checked', def ? 'true' : 'false');
    c.setAttribute('tabindex', def ? '0' : '-1');
  });

  _charOverlay.classList.remove('hidden');
  _charOverlay.style.opacity = '1';
  requestAnimationFrame(() => {
    const release = trapFocus(_charOverlay, null);
    (_charOverlay as any)._trapRelease = release;
    try { _inputFirstName.focus(); } catch (_) {}
  });

  return new Promise(resolve => { (_charOverlay as any)._resolve = resolve; });
}
