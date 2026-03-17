// ---------------------------------------------------------------------------
// ui/narrative.js — Narrative rendering, log management, choices
//
// FIX #4: formatText variable interpolation now HTML-escapes substituted
//   values before they are assigned via innerHTML. Player-controlled strings
//   (first_name, last_name, any variable set via *input) previously flowed
//   raw into innerHTML, enabling XSS. All substituted values are now passed
//   through escapeHtml() before insertion.
//
//   escapeHtml() is exported so panels.js can reuse the same helper for
//   inventory items, skill descriptions, journal entries, and stat labels.
//
//   Plain author-written narrative text and markdown (**bold** / *italic*)
//   are NOT escaped — only the dynamic values injected from state are.
//   This preserves all existing formatting behaviour for authored content.
//
// FIX Main + A + B (sweep 4): Choice click handler rewritten.
//   - awaitingChoice is now read directly from state.js (no circular import).
//   - setAwaitingChoice(null) is called before executeBlock so the stale
//     truthy value doesn't cause executeBlock to bail immediately.
//   - The correct resume IP (awaitingChoice.end — the whole choice block end)
//     is captured before clearing, not choice.end (individual option end).
//   - executeBlock and runInterpreter are received via init() callbacks
//     to avoid a circular import with interpreter.js.
//
// BUG J fix (sweep 6): choice container gets role="group" + aria-label;
//   disabled buttons get aria-disabled="true"; first enabled button
//   receives focus after render via requestAnimationFrame.
// BUG K fix (sweep 6): choiceMade guard prevents double-click / rapid-tap
//   race on touch devices.
// ANIM removal: all animationDelay stagger logic removed from addParagraph,
//   addSystem, showInputPrompt, renderChoices, and renderFromLog. The
//   delayIndex counter in state.js has also been removed. applyTransition
//   is now a no-op. All narrative elements render at full opacity immediately.
// ---------------------------------------------------------------------------

import {
  playerState, tempState,
  normalizeKey, resolveStore,
  awaitingChoice, setAwaitingChoice,
} from '../core/state.js';

// ---------------------------------------------------------------------------
// escapeHtml — sanitizes a runtime value for safe insertion into innerHTML.
// Handles &, <, >, " which are the HTML injection vectors.
// Exported for reuse in panels.js.
// ---------------------------------------------------------------------------
export function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _narrativeContent  = null;
let _choiceArea        = null;
let _narrativePanel    = null;
let _scheduleStats     = null;
let _onBeforeChoice    = null;

// FIX Main/A/B (sweep 4): interpreter functions injected via init() to avoid
// circular import (narrative.js → interpreter.js → [via callbacks] → narrative.js).
let _executeBlock      = null;
let _runInterpreter    = null;

export function init({ narrativeContent, choiceArea, narrativePanel,
                       scheduleStatsRender, onBeforeChoice,
                       executeBlock, runInterpreter }) {
  _narrativeContent = narrativeContent;
  _choiceArea       = choiceArea;
  _narrativePanel   = narrativePanel;
  _scheduleStats    = scheduleStatsRender || (() => {});
  _onBeforeChoice   = onBeforeChoice   || (() => {});
  _executeBlock     = executeBlock     || null;
  _runInterpreter   = runInterpreter   || null;
}

export function setChoiceArea(el) { _choiceArea = el; }

// ---------------------------------------------------------------------------
// Narrative Log — records every piece of visible narrative content during play.
//
// Each entry is a plain object describing one rendered item:
//   { type: 'paragraph', text }
//   { type: 'system',    text }
//   { type: 'input',     varName, prompt, value }   (value filled on submit)
//
// Choices and page-break buttons are NOT logged — they are transient
// interactive state, not historical narrative content. Page breaks clear the
// narrative when clicked, so the log resets to [] on clearNarrative().
//
// renderFromLog() consumes this log to rebuild the DOM without re-executing
// any scene code. Used by popUndo and restoreFromSave.
// ---------------------------------------------------------------------------
let _narrativeLog = [];

export function getNarrativeLog()        { return _narrativeLog; }
export function setNarrativeLog(log)     { _narrativeLog = log; }
export function pushNarrativeLogEntry(e) { _narrativeLog.push(e); }
export function clearNarrativeLog()      { _narrativeLog = []; }

// ---------------------------------------------------------------------------
// Pronoun resolver — reads from flat playerState keys set at char creation
// ---------------------------------------------------------------------------
function resolvePronoun(lower, isCapital) {
  const map = {
    they:     playerState.pronouns_subject            || 'they',
    them:     playerState.pronouns_object             || 'them',
    their:    playerState.pronouns_possessive         || 'their',
    theirs:   playerState.pronouns_possessive_pronoun || 'theirs',
    themself: playerState.pronouns_reflexive          || 'themself',
  };
  const resolved = escapeHtml(map[lower] || lower);
  return isCapital
    ? resolved.charAt(0).toUpperCase() + resolved.slice(1)
    : resolved;
}

// ---------------------------------------------------------------------------
// formatText — resolves ${var} interpolation, pronoun tokens, and markdown.
// ---------------------------------------------------------------------------
export function formatText(text) {
  if (!text) return '';
  let result = String(text);

  // 1. Variable interpolation: ${varName}
  result = result.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k     = normalizeKey(v);
    const store = resolveStore(k);
    return escapeHtml(store ? store[k] : '');
  });

  // 2. Pronoun tokens: {they}, {Them}, {their}, {theirs}, etc.
  result = result.replace(
    /\{(They|Them|Their|Theirs|Themself|they|them|their|theirs|themself)\}/g,
    (_, token) => {
      const lower     = token.toLowerCase();
      const isCapital = token.charCodeAt(0) >= 65 && token.charCodeAt(0) <= 90;
      return resolvePronoun(lower, isCapital);
    }
  );

  // 3. Markdown: **bold** and *italic*
  result = result
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return result;
}

// ---------------------------------------------------------------------------
// addParagraph — appends a narrative paragraph before the choice area
// ---------------------------------------------------------------------------
export function addParagraph(text, cls = 'narrative-paragraph') {
  const p = document.createElement('p');
  p.className = cls;
  p.innerHTML = formatText(text);
  _narrativeContent.insertBefore(p, _choiceArea);

  // Log the raw text (before formatText) so renderFromLog can re-resolve
  // variable interpolation against the restored state on load/undo.
  _narrativeLog.push({ type: 'paragraph', text });
}

// ---------------------------------------------------------------------------
// addSystem — renders a system block, applies rewards, triggers level-up UI
// ---------------------------------------------------------------------------
export function addSystem(text) {
  const div       = document.createElement('div');
  const isEssence = /Essence\s+gained|bonus\s+Essence|\+\d+\s+Essence/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isEssence ? ' essence-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;

  const formatted = formatText(text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  _narrativeContent.insertBefore(div, _choiceArea);

  // Log the raw system text so renderFromLog can reconstruct the block.
  _narrativeLog.push({ type: 'system', text });
}

// ---------------------------------------------------------------------------
// clearNarrative — removes all narrative nodes, empties choice area
// ---------------------------------------------------------------------------
export function clearNarrative() {
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = '';
  // Reset scroll position so new content starts at the top.
  // Use scrollTo with 'instant' to override the CSS scroll-behavior: smooth
  // which can cause the reset to animate and race with new content being added.
  _narrativeContent.scrollTo({ top: 0, behavior: 'instant' });

  // Clear the narrative log — a page break or scene transition starts fresh.
  _narrativeLog = [];
}

// ---------------------------------------------------------------------------
// applyTransition — formerly added a CSS 'transitioning' class for a
// fade/slide effect. Removed: the setTimeout race was a source of bugs
// where new content rendered while the panel was still opacity:0.
// Kept as a no-op so all call sites remain valid without changes.
// ---------------------------------------------------------------------------
export function applyTransition() {
  // intentionally empty
}

// ---------------------------------------------------------------------------
// renderChoices — builds choice buttons and wires click → executeBlock
//
// Called by the interpreter (via the cb.renderChoices callback registered
// in engine.js).
//
// BUG J fix: choice container gets role="group" + aria-label; permanently-
//   disabled buttons get aria-disabled="true"; first enabled button
//   receives focus after render via requestAnimationFrame.
// BUG K fix: choiceMade guard prevents double-click / rapid-tap executing
//   the same choice twice.
// ---------------------------------------------------------------------------
export function renderChoices(choices) {
  _choiceArea.innerHTML = '';

  // BUG J: mark container as a labelled group for screen readers
  _choiceArea.setAttribute('role', 'group');
  _choiceArea.setAttribute('aria-label', 'Story choices');

  // BUG K: single-fire guard — set true on the first click; all subsequent
  // clicks/taps in this choice round are silently dropped.
  let choiceMade = false;

  choices.forEach((choice) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.innerHTML = `<span>${formatText(choice.text)}</span>`;

    // ENH-09: Render inline stat requirement badge if the choice has one.
    if (choice.statTag) {
      const { label, requirement } = choice.statTag;
      const key = normalizeKey(label.replace(/\s+/g, '_'));
      const store = resolveStore(key);
      const val = store ? store[key] : null;
      const met = val !== null && Number(val) >= requirement;
      const badge = document.createElement('span');
      badge.className = `choice-stat-badge ${met ? 'choice-stat-badge--met' : 'choice-stat-badge--unmet'}`;
      badge.textContent = `${label} ${requirement}`;
      btn.appendChild(badge);
    }

    if (!choice.selectable) {
      btn.disabled = true;
      btn.classList.add('choice-btn--disabled');
      btn.dataset.unselectable = 'true';
      btn.setAttribute('aria-disabled', 'true');
    } else {
      btn.addEventListener('click', () => {
        if (choiceMade) return;
        choiceMade = true;

        _onBeforeChoice();
        clearNarrative();

        const choiceBlockEnd = awaitingChoice?.end ?? choice.end;
        const savedIp = awaitingChoice?._savedIp ?? choiceBlockEnd;
        setAwaitingChoice(null);

        _executeBlock(choice.start, choice.end, savedIp)
          .then(() => _runInterpreter())
          .catch(err => {
            console.error('[narrative] choice execution error:', err);
          });
      });
    }

    _choiceArea.appendChild(btn);
  });

  // BUG J: move keyboard focus to the first enabled button
  requestAnimationFrame(() => {
    const firstEnabled = _choiceArea.querySelector('.choice-btn:not(:disabled)');
    if (firstEnabled) firstEnabled.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------------------
// showPageBreak — inserts a "Continue" button that clears the screen.
// Used by the *page_break directive. The button text is configurable
// (e.g. "The next day..."). Clicking clears the screen and resumes.
//
// Page breaks are intentionally NOT logged: clicking one clears the narrative
// and starts a fresh screen, so the log resets via clearNarrative() anyway.
// ---------------------------------------------------------------------------
export function showPageBreak(btnText, onContinue) {
  const btn = document.createElement('button');
  btn.className = 'choice-btn page-break-btn';
  btn.textContent = btnText || 'Continue';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    onContinue();
  });
  _choiceArea.appendChild(btn);
}

// ---------------------------------------------------------------------------
// showInputPrompt — creates an inline text input in the narrative area.
// Used by the *input directive. Creates a styled input field in the narrative
// area and calls onSubmit(value) when the player presses Enter or clicks Submit.
// ---------------------------------------------------------------------------
export function showInputPrompt(varName, prompt, onSubmit) {
  // Create the log entry immediately with value: null. The value field is
  // mutated to the actual string inside doSubmit so that renderFromLog can
  // show the completed answer when restoring from an undo or save.
  const logEntry = { type: 'input', varName, prompt, value: null };
  _narrativeLog.push(logEntry);

  const wrapper = document.createElement('div');
  wrapper.className = 'input-prompt-block';
  wrapper.innerHTML = `
    <span class="system-block-label">[ INPUT ]</span>
    <label class="input-prompt-label">${formatText(prompt)}</label>
    <div class="input-prompt-row">
      <input type="text" class="input-prompt-field" autocomplete="off" spellcheck="false" maxlength="60" />
      <button class="input-prompt-submit" disabled>Submit</button>
    </div>`;
  _narrativeContent.insertBefore(wrapper, _choiceArea);

  const field  = wrapper.querySelector('.input-prompt-field');
  const submit = wrapper.querySelector('.input-prompt-submit');

  field.addEventListener('input', () => {
    submit.disabled = !field.value.trim();
  });

  function doSubmit() {
    const value = field.value.trim();
    if (!value) return;

    // Mutate the log entry so renderFromLog can show the submitted value
    logEntry.value = value;

    // Collapse the input widget to a read-only display
    wrapper.classList.add('input-prompt-block--submitted');
    wrapper.innerHTML = `
      <span class="system-block-label">[ INPUT ]</span>
      <span class="input-prompt-label">${formatText(prompt)}</span>
      <span class="input-prompt-submitted-value">${escapeHtml(value)}</span>`;

    onSubmit(value);
  }

  submit.addEventListener('click', doSubmit);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSubmit();
  });

  // Auto-focus the input field without scrolling to it — the player should
  // read from the top of the screen, not jump to the input widget.
  requestAnimationFrame(() => field.focus({ preventScroll: true }));
}

// ---------------------------------------------------------------------------
// renderFromLog — paints the DOM from a log array with zero side effects.
//
// This is the heart of the save/load and undo approach: instead of
// re-executing scene code, we replay the visible record of what was shown.
// No rewards are re-applied, no interpreter runs, no state changes occur.
//
// The skipAnimations option is retained for API compatibility but is now a
// no-op — all elements render at full opacity immediately since CSS
// animation-based staggering has been removed.
// ---------------------------------------------------------------------------
export function renderFromLog(log, { skipAnimations = true } = {}) {  // eslint-disable-line no-unused-vars
  // Clear DOM — but do NOT touch _narrativeLog here; we're about to adopt
  // the incoming log as the new current log at the end of this function.
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = '';
  _narrativeContent.scrollTo({ top: 0, behavior: 'instant' });

  for (const entry of log) {
    switch (entry.type) {

      case 'paragraph': {
        const p = document.createElement('p');
        p.className = 'narrative-paragraph';
        p.innerHTML = formatText(entry.text);
        _narrativeContent.insertBefore(p, _choiceArea);
        break;
      }

      case 'system': {
        const div       = document.createElement('div');
        const isEssence = /Essence\s+gained|bonus\s+Essence|\+\d+\s+Essence/i.test(entry.text);
        const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(entry.text);
        div.className = `system-block${isEssence ? ' essence-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;
        const formatted = formatText(entry.text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
        div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
        _narrativeContent.insertBefore(div, _choiceArea);
        break;
      }

      case 'input': {
        const wrapper = document.createElement('div');
        wrapper.className = 'input-prompt-block input-prompt-block--submitted';
        const safe = escapeHtml(entry.value ?? '—');
        wrapper.innerHTML = `
          <span class="system-block-label">[ INPUT ]</span>
          <span class="input-prompt-label">${formatText(entry.prompt)}</span>
          <span class="input-prompt-submitted-value">${safe}</span>`;
        _narrativeContent.insertBefore(wrapper, _choiceArea);
        break;
      }

      default:
        console.warn('[narrative] renderFromLog: unknown entry type:', entry.type);
    }
  }

  // Adopt the incoming log as the current live log.
  _narrativeLog = [...log];
}
