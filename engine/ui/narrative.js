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
// ---------------------------------------------------------------------------

import {
  playerState, tempState,
  pendingLevelUpDisplay, pendingStatPoints,
  delayIndex, setDelayIndex, advanceDelayIndex,
  normalizeKey,
} from '../core/state.js';

import { applySystemRewards } from '../systems/leveling.js';

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
let _onShowLevelUp     = null;
let _scheduleStats     = null;
let _onBeforeChoice    = null;

export function init({ narrativeContent, choiceArea, narrativePanel,
                       onShowLevelUp, scheduleStatsRender, onBeforeChoice }) {
  _narrativeContent = narrativeContent;
  _choiceArea       = choiceArea;
  _narrativePanel   = narrativePanel;
  _onShowLevelUp    = onShowLevelUp    || (() => {});
  _scheduleStats    = scheduleStatsRender || (() => {});
  _onBeforeChoice   = onBeforeChoice   || (() => {});
}

export function setChoiceArea(el) { _choiceArea = el; }

// ---------------------------------------------------------------------------
// Narrative Log — records every piece of visible narrative content during play.
//
// Each entry is a plain object describing one rendered item:
//   { type: 'paragraph', text }
//   { type: 'system',    text }
//   { type: 'input',     varName, prompt, value }   (value filled on submit)
//   { type: 'levelup_confirmed', level }
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
// renderFromLog — paints the DOM from a log array with zero side effects.
//
// This is the heart of the new save/load and undo approach: instead of
// re-executing scene code, we replay the visible record of what was shown.
// No rewards are re-applied, no interpreter runs, no state changes occur.
//
// opts.skipAnimations (default true): renders elements without CSS animation
// delay so the screen fills instantly on restore.
// ---------------------------------------------------------------------------
export function renderFromLog(log, { skipAnimations = true } = {}) {
  // Clear DOM — but do NOT touch _narrativeLog here; we're about to adopt
  // the incoming log as the new current log at the end of this function.
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = '';
  _narrativeContent.scrollTop = 0;

  if (skipAnimations) setDelayIndex(0);

  for (const entry of log) {
    switch (entry.type) {

      case 'paragraph': {
        const p = document.createElement('p');
        p.className = 'narrative-paragraph';
        if (skipAnimations) {
          p.style.opacity   = '1';
          p.style.transform = 'none';
          p.style.animation = 'none';
        } else {
          p.style.animationDelay = `${delayIndex * 80}ms`;
        }
        p.innerHTML = formatText(entry.text);
        _narrativeContent.insertBefore(p, _choiceArea);
        if (!skipAnimations) advanceDelayIndex();
        break;
      }

      case 'system': {
        const div       = document.createElement('div');
        const isXP      = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(entry.text);
        const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(entry.text);
        div.className = `system-block${isXP ? ' xp-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;
        if (skipAnimations) {
          div.style.opacity   = '1';
          div.style.transform = 'none';
          div.style.animation = 'none';
        } else {
          div.style.animationDelay = `${delayIndex * 80}ms`;
        }
        const formatted = formatText(entry.text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
        div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
        _narrativeContent.insertBefore(div, _choiceArea);
        if (!skipAnimations) advanceDelayIndex();
        // DO NOT call applySystemRewards — this is a pure render, no side effects.
        break;
      }

      case 'input': {
        // Render the completed input as a static read-only block.
        const wrapper = document.createElement('div');
        wrapper.className = 'input-prompt-block input-prompt-block--submitted';
        if (skipAnimations) {
          wrapper.style.opacity   = '1';
          wrapper.style.animation = 'none';
        }
        const safe = escapeHtml(entry.value || '');
        wrapper.innerHTML = `<span class="system-block-label">[ INPUT ]</span><span class="system-block-text">${formatText(entry.prompt)}: <strong>${safe}</strong></span>`;
        _narrativeContent.insertBefore(wrapper, _choiceArea);
        break;
      }

      case 'levelup_confirmed': {
        const block = document.createElement('div');
        block.className = 'levelup-inline-block levelup-inline-block--confirmed';
        if (skipAnimations) {
          block.style.opacity   = '0.55';
          block.style.animation = 'none';
        }
        block.innerHTML = `<span class="system-block-label">[ LEVEL UP ]</span><span class="system-block-text levelup-confirmed-text">Level ${entry.level} reached — stats allocated.</span>`;
        _narrativeContent.insertBefore(block, _choiceArea);
        break;
      }

      // Future entry types can be added here without touching any other code.
    }
  }

  // Adopt the supplied log as the current log so subsequent pushes append
  // correctly (e.g. if the interpreter continues after a restore).
  _narrativeLog = [...log];
  if (skipAnimations) setDelayIndex(log.length);
}

// ---------------------------------------------------------------------------
// Pronoun resolution
// ---------------------------------------------------------------------------
const PRONOUN_SETS = {
  'he/him':    { they: 'he',   them: 'him',  their: 'his',   themself: 'himself'  },
  'she/her':   { they: 'she',  them: 'her',  their: 'her',   themself: 'herself'  },
  'they/them': { they: 'they', them: 'them', their: 'their', themself: 'themself' },
  'xe/xem':    { they: 'xe',   them: 'xem',  their: 'xyr',   themself: 'xemself'  },
  'ze/zir':    { they: 'ze',   them: 'zir',  their: 'zir',   themself: 'zirself'  },
};

function resolvePronoun(tokenLower, capitalise) {
  const set  = PRONOUN_SETS[playerState.pronouns] ?? PRONOUN_SETS['they/them'];
  const word = set[tokenLower] ?? tokenLower;
  return capitalise ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}

// ---------------------------------------------------------------------------
// formatText — variable interpolation, pronoun tokens, markdown
//
// FIX #4: Variable substitutions (${varName}) now run through escapeHtml()
//   before being inserted. This prevents player-controlled values from being
//   injected as raw HTML (XSS). Authored narrative text and markdown marks
//   (**bold**, *italic*) are untouched.
//
// Exported so panels.js can use it for stat display if needed in future.
// ---------------------------------------------------------------------------
export function formatText(text) {
  // 1. Variable interpolation: ${varName}
  //    FIX #4: escape the substituted value so player-controlled strings
  //    (names, *input results) cannot inject HTML via innerHTML.
  let result = text.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k   = normalizeKey(v);
    const val = tempState[k] !== undefined ? tempState[k] : (playerState[k] ?? '');
    return escapeHtml(val);
  });

  // 2. Pronoun tokens: {they}, {Them}, {their}, etc.
  result = result.replace(
    /\{(They|Them|Their|Themself|they|them|their|themself)\}/g,
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
  p.style.animationDelay = `${delayIndex * 80}ms`;
  p.innerHTML = formatText(text);
  advanceDelayIndex();
  _narrativeContent.insertBefore(p, _choiceArea);

  // Log the raw text (before formatText) so renderFromLog can re-resolve
  // variable interpolation against the restored state on load/undo.
  _narrativeLog.push({ type: 'paragraph', text });
}

// ---------------------------------------------------------------------------
// addSystem — renders a system block, applies rewards, triggers level-up UI
// ---------------------------------------------------------------------------
export function addSystem(text) {
  applySystemRewards(text, _scheduleStats);

  const div       = document.createElement('div');
  const isXP      = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isXP ? ' xp-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;
  div.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();

  const formatted = formatText(text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  _narrativeContent.insertBefore(div, _choiceArea);

  // Log the raw system text so renderFromLog can reconstruct the block.
  _narrativeLog.push({ type: 'system', text });

  // pendingLevelUpDisplay is set by checkAndApplyLevelUp inside applySystemRewards
  if (pendingLevelUpDisplay) _onShowLevelUp();
}

// ---------------------------------------------------------------------------
// clearNarrative — removes all narrative nodes, empties choice area
// ---------------------------------------------------------------------------
export function clearNarrative() {
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = '';
  setDelayIndex(0);
  // Reset scroll position so new content starts at the top
  _narrativeContent.scrollTop = 0;

  // Clear the narrative log — a page break or scene transition starts fresh.
  _narrativeLog = [];
}

// ---------------------------------------------------------------------------
// applyTransition — brief fade/slide class on the narrative panel
// ---------------------------------------------------------------------------
export function applyTransition() {
  _narrativePanel.classList.add('transitioning');
  setTimeout(() => _narrativePanel.classList.remove('transitioning'), 220);
}

// ---------------------------------------------------------------------------
// renderChoices — builds choice buttons and wires click → executeBlock
//
// Called by the interpreter (via the cb.renderChoices callback registered
// in main.js). Disables choices while a level-up is pending.
// ---------------------------------------------------------------------------
export function renderChoices(choices) {
  // Show level-up UI before choices if points are still unspent
  if (pendingLevelUpDisplay) _onShowLevelUp();

  const levelUpActive = pendingStatPoints > 0;
  _choiceArea.innerHTML = '';

  choices.forEach((choice, idx) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.style.animationDelay = `${(delayIndex + idx) * 80}ms`;
    btn.innerHTML = `<span>${formatText(choice.text)}</span>`;

    // ENH-09: Render inline stat requirement badge if the choice has one.
    // Looks up the stat value by normalising the tag label to a state key
    // (lowercase, spaces→underscores), then colours the badge green/red.
    if (choice.statTag) {
      const { label, requirement } = choice.statTag;
      const key = normalizeKey(label.replace(/\s+/g, '_'));
      const val = tempState[key] !== undefined
        ? tempState[key]
        : (playerState[key] !== undefined ? playerState[key] : null);
      const met = val !== null && Number(val) >= requirement;
      const badge = document.createElement('span');
      badge.className = `stat-requirement-badge ${met ? 'stat-req--met' : 'stat-req--unmet'}`;
      badge.textContent = `${label} ${requirement}`;
      btn.appendChild(badge);
    }

    if (!choice.selectable || levelUpActive) {
      btn.disabled = true;
      btn.classList.add('choice-btn--disabled');
    } else {
      btn.addEventListener('click', () => {
        _onBeforeChoice();
        btn.disabled = true;
        _choiceArea.querySelectorAll('.choice-btn').forEach(b => { b.disabled = true; });
        import('../core/interpreter.js').then(({ executeBlock, runInterpreter, awaitingChoice: ac }) => {
          // executeBlock and runInterpreter are imported lazily to avoid circular dep at load time
        });
      });
    }

    _choiceArea.appendChild(btn);
  });
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
  wrapper.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();

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
    field.disabled  = true;
    submit.disabled = true;
    wrapper.classList.add('input-prompt-block--submitted');
    // Sanitize the displayed value — user input must never be injected raw into innerHTML
    const safe = escapeHtml(value);
    wrapper.innerHTML = `<span class="system-block-label">[ INPUT ]</span><span class="system-block-text">${formatText(prompt)}: <strong>${safe}</strong></span>`;

    // Record the submitted value in the existing log entry so that any undo
    // snapshot taken after this point captures the completed input correctly.
    logEntry.value = value;

    onSubmit(value);
  }

  field.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
  submit.addEventListener('click', doSubmit);

  requestAnimationFrame(() => { try { field.focus(); } catch (_) {} });
}

// ---------------------------------------------------------------------------
// showPageBreak — renders a full-width "Continue" button in the choice area.
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
