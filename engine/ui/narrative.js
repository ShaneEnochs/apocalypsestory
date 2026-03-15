// ---------------------------------------------------------------------------
// ui/narrative.js — Narrative rendering, text formatting, choice rendering
//
// Owns everything that puts words on screen during play:
//   formatText / resolvePronoun — variable interpolation, pronouns, markdown
//   addParagraph / addSystem / clearNarrative / applyTransition — DOM writers
//   renderChoices — builds choice buttons and wires click handlers
//
// DOM nodes and the showInlineLevelUp callback are injected at boot via
// init() to keep this module free of direct imports from main.js (which
// would be circular — main.js imports from here).
//
// Dependency graph:
//   narrative.js
//     → state.js       (playerState, tempState, delayIndex, awaitingChoice …)
//     → leveling.js    (applySystemRewards)
//     → interpreter.js (executeBlock, runInterpreter)
//     ← main.js        (injects dom slice + showInlineLevelUp via init())
// ---------------------------------------------------------------------------

import {
  playerState, tempState,
  pendingLevelUpDisplay, pendingStatPoints,
  awaitingChoice, setAwaitingChoice,
  delayIndex, advanceDelayIndex, setDelayIndex,
  normalizeKey,
} from '../core/state.js';

import { applySystemRewards }            from '../systems/leveling.js';
import { executeBlock, runInterpreter }  from '../core/interpreter.js';

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _narrativeContent = null;
let _choiceArea       = null;
let _narrativePanel   = null;
let _onShowLevelUp    = null;   // () → void  — wired to panels.showInlineLevelUp
let _scheduleStats    = null;   // () → void  — wired to main.scheduleStatsRender

export function init({ narrativeContent, choiceArea, narrativePanel,
                       onShowLevelUp, scheduleStatsRender }) {
  _narrativeContent = narrativeContent;
  _choiceArea       = choiceArea;
  _narrativePanel   = narrativePanel;
  _onShowLevelUp    = onShowLevelUp;
  _scheduleStats    = scheduleStatsRender;
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
// Exported so panels.js can use it for stat display if needed in future.
// ---------------------------------------------------------------------------
export function formatText(text) {
  // 1. Variable interpolation: ${varName}
  let result = text.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k = normalizeKey(v);
    return tempState[k] !== undefined ? tempState[k] : (playerState[k] ?? '');
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

    if (!choice.selectable) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      btn.dataset.unselectable = '1';
    } else if (levelUpActive) {
      btn.disabled = true;
    }

    btn.addEventListener('click', async () => {
      _choiceArea.querySelectorAll('button').forEach(b => b.disabled = true);
      // Snapshot awaitingChoice before clearing then clear it
      setAwaitingChoice(null);
      clearNarrative();
      applyTransition();
      await executeBlock(choice.start, choice.end);
      // executeBlock sets ip correctly on every exit path:
      //   normal completion → ip = resumeAfter (line after the choice branch)
      //   *goto inside branch → ip = goto target (must NOT be overwritten here)
      //   awaitingChoice set inside branch → guarded by the check below
      if (!awaitingChoice) { await runInterpreter(); }
    });

    _choiceArea.appendChild(btn);
  });

  if (levelUpActive) {
    const ov = document.createElement('div');
    ov.className = 'levelup-choice-overlay';
    ov.innerHTML = `<span>All stat points must be allocated</span>`;
    _choiceArea.appendChild(ov);
  }
}

// ---------------------------------------------------------------------------
// showInputPrompt — inline text input that pauses the interpreter.
// Used by the *input directive. Creates a styled input field in the narrative
// area and calls onSubmit(value) when the player presses Enter or clicks Submit.
// ---------------------------------------------------------------------------
export function showInputPrompt(varName, prompt, onSubmit) {
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
    const safe = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    wrapper.innerHTML = `<span class="system-block-label">[ INPUT ]</span><span class="system-block-text">${formatText(prompt)}: <strong>${safe}</strong></span>`;
    onSubmit(value);
  }

  field.addEventListener('keydown', e => { if (e.key === 'Enter') doSubmit(); });
  submit.addEventListener('click', doSubmit);

  requestAnimationFrame(() => { try { field.focus(); } catch (_) {} });
}
