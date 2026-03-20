// core/dom.ts — Dom interface, DOM construction helper, and title helpers
//
// Centralises all getElementById/querySelector calls into one place.
// Every field is typed as its specific element type so the rest of the
// engine can use them without null-checks on every access.
//
// Also exports setChapterTitle, showChapterCard, and setGameTitle so engine.ts
// can stay slim — these are purely DOM-manipulation helpers with no side-effects
// beyond modifying text content and triggering CSS animations.

export interface Dom {
  narrativeContent: HTMLElement;
  choiceArea:       HTMLElement;
  chapterTitle:     HTMLElement;
  narrativePanel:   HTMLElement;
  statusPanel:      HTMLElement;
  statusToggle:     HTMLElement;
  saveBtn:          HTMLElement;
  gameTitle:        HTMLElement;
  splashTitle:      HTMLElement;
  splashTagline:    HTMLElement;
  splashOverlay:    HTMLElement;
  splashNewBtn:     HTMLElement;
  splashLoadBtn:    HTMLElement;
  splashSlots:      HTMLElement;
  splashSlotsBack:  HTMLElement;
  saveOverlay:      HTMLElement;
  saveMenuClose:    HTMLElement;
  charOverlay:      HTMLElement;
  inputFirstName:   HTMLInputElement;
  inputLastName:    HTMLInputElement;
  counterFirst:     HTMLElement;
  counterLast:      HTMLElement;
  errorFirstName:   HTMLElement;
  errorLastName:    HTMLElement;
  charBeginBtn:     HTMLButtonElement;
  endingOverlay:    HTMLElement | null;
  endingTitle:      HTMLElement | null;
  endingContent:    HTMLElement | null;
  endingStats:      HTMLElement | null;
  endingActionBtn:  HTMLElement | null;
  storeOverlay:     HTMLElement | null;
  toast:            HTMLElement;
}

import { setChapterTitleState } from './state.js';

// ---------------------------------------------------------------------------
// setChapterTitle — updates the chapter title DOM element and engine state.
// Shows a brief animated chapter card if the title actually changed.
// ---------------------------------------------------------------------------
export function setChapterTitle(t: string): void {
  const el   = document.getElementById('chapter-title');
  const prev = el?.textContent ?? '';
  if (el) el.textContent = t;
  setChapterTitleState(t);
  if (t && t !== prev && t !== '—') showChapterCard(t);
}

export function showChapterCard(title: string): void {
  document.querySelector('.chapter-card')?.remove();
  const card = document.createElement('div');
  card.className = 'chapter-card';
  const lbl  = document.createElement('span');
  lbl.className = 'chapter-card-label';
  lbl.textContent = 'Chapter';
  const ttl  = document.createElement('span');
  ttl.className = 'chapter-card-title';
  ttl.textContent = title;
  card.appendChild(lbl);
  card.appendChild(ttl);
  const np = document.getElementById('narrative-panel');
  if (np) np.insertBefore(card, np.firstChild);
  card.addEventListener('animationend', () => card.remove(), { once: true });
}

export function setGameTitle(t: string): void {
  const gt = document.getElementById('game-title');
  const st = document.querySelector('.splash-title') as HTMLElement | null;
  if (gt) gt.textContent = t;
  if (st) st.textContent = t;
  document.title = t;
}

// ---------------------------------------------------------------------------
// buildDom
// ---------------------------------------------------------------------------
export function buildDom(): Dom {
  function req(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) console.warn(`[dom] Missing element: "${id}" — check index.html IDs`);
    return el as HTMLElement;
  }

  return {
    narrativeContent: req('narrative-content'),
    choiceArea:       req('choice-area'),
    chapterTitle:     req('chapter-title'),
    narrativePanel:   req('narrative-panel'),
    statusPanel:      req('status-panel'),
    statusToggle:     req('status-toggle'),
    saveBtn:          req('save-btn'),
    gameTitle:        req('game-title'),
    splashTitle:      document.querySelector('.splash-title') as HTMLElement,
    splashTagline:    req('splash-tagline'),
    splashOverlay:    req('splash-overlay'),
    splashNewBtn:     req('splash-new-btn'),
    splashLoadBtn:    req('splash-load-btn'),
    splashSlots:      req('splash-slots'),
    splashSlotsBack:  req('splash-slots-back'),
    saveOverlay:      req('save-overlay'),
    saveMenuClose:    req('save-menu-close'),
    charOverlay:      req('char-creation-overlay'),
    inputFirstName:   req('input-first-name')   as HTMLInputElement,
    inputLastName:    req('input-last-name')     as HTMLInputElement,
    counterFirst:     req('counter-first'),
    counterLast:      req('counter-last'),
    errorFirstName:   req('error-first-name'),
    errorLastName:    req('error-last-name'),
    charBeginBtn:     req('char-begin-btn')      as HTMLButtonElement,
    endingOverlay:    document.getElementById('ending-overlay'),
    endingTitle:      document.getElementById('ending-title'),
    endingContent:    document.getElementById('ending-content'),
    endingStats:      document.getElementById('ending-stats'),
    endingActionBtn:  document.getElementById('ending-action-btn'),
    storeOverlay:     document.getElementById('store-overlay'),
    toast:            req('toast'),
  };
}
