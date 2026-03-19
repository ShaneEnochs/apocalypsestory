// ui/narrative.js — Narrative rendering, log management, choices
//
// Renders paragraphs, system blocks, input prompts, and choice buttons.
// Manages the narrative log used for save/load and undo replay.
//
// formatText resolves ${var} interpolation, pronoun tokens, and markdown.
// All substituted values are HTML-escaped before insertion into innerHTML
// to prevent XSS from player-controlled strings.
//
// escapeHtml is exported so panels.js can reuse it for inventory items,
// skill descriptions, journal entries, and stat labels.

import {
  playerState, tempState,
  normalizeKey, resolveStore,
  awaitingChoice, setAwaitingChoice,
} from '../core/state.js';
import type { ChoiceOption } from '../core/state.js';

export interface NarrativeLogEntry {
  type:     string;
  text?:    string;
  varName?: string;
  prompt?:  string;
  value?:   string | null;
}

// ---------------------------------------------------------------------------
// escapeHtml — sanitizes a runtime value for safe insertion into innerHTML.
// ---------------------------------------------------------------------------
export function escapeHtml(val: unknown): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Module-level DOM references and callbacks — populated by init()
// ---------------------------------------------------------------------------
let _narrativeContent!: HTMLElement;
let _choiceArea!:       HTMLElement;
let _narrativePanel!:   HTMLElement;
let _scheduleStats!:    () => void;
let _onBeforeChoice!:   () => void;

// Interpreter functions injected via init() to avoid circular import.
let _executeBlock!:   (start: number, end: number, resumeAfter?: number) => Promise<string>;
let _runInterpreter!: (opts?: { suppressAutoSave?: boolean }) => Promise<void>;

export function init({ narrativeContent, choiceArea, narrativePanel,
                       scheduleStatsRender, onBeforeChoice,
                       executeBlock, runInterpreter }: {
  narrativeContent:    HTMLElement;
  choiceArea:          HTMLElement;
  narrativePanel:      HTMLElement;
  scheduleStatsRender: () => void;
  onBeforeChoice:      () => void;
  executeBlock:        (start: number, end: number, resumeAfter?: number) => Promise<string>;
  runInterpreter:      (opts?: { suppressAutoSave?: boolean }) => Promise<void>;
}): void {
  _narrativeContent = narrativeContent;
  _choiceArea       = choiceArea;
  _narrativePanel   = narrativePanel;
  _scheduleStats    = scheduleStatsRender || (() => {});
  _onBeforeChoice   = onBeforeChoice   || (() => {});
  _executeBlock     = executeBlock     || null;
  _runInterpreter   = runInterpreter   || null;
}

export function setChoiceArea(el: HTMLElement): void { _choiceArea = el; }

// ---------------------------------------------------------------------------
// Narrative Log — records every piece of visible narrative content during play.
//
// Each entry: { type, text } for paragraph/system, or
//             { type, varName, prompt, value } for input.
//
// renderFromLog() consumes this log to rebuild the DOM without re-executing
// any scene code. Used by popUndo and restoreFromSave.
// ---------------------------------------------------------------------------
let _narrativeLog: NarrativeLogEntry[] = [];

export function getNarrativeLog(): NarrativeLogEntry[]        { return _narrativeLog; }
export function setNarrativeLog(log: NarrativeLogEntry[]): void { _narrativeLog = log; }
export function pushNarrativeLogEntry(e: NarrativeLogEntry): void { _narrativeLog.push(e); }
export function clearNarrativeLog(): void      { _narrativeLog = []; }

// ---------------------------------------------------------------------------
// Pronoun resolver — reads from flat playerState keys set at char creation
// ---------------------------------------------------------------------------
function resolvePronoun(lower: string, isCapital: boolean): string {
  const map: Record<string, string> = {
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
export function formatText(text: unknown): string {
  if (!text) return '';
  let result = String(text);

  // 1. Variable interpolation: ${varName}
  // Substituted values are HTML-escaped, and asterisks are escaped to &#42;
  // so player-controlled strings can't trigger **bold** / *italic* markdown.
  result = result.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k     = normalizeKey(v);
    const store = resolveStore(k);
    return escapeHtml(store ? store[k] : '').replace(/\*/g, '&#42;');
  });

  // 2. Pronoun tokens: {they}, {Them}, {their}, etc.
  result = result.replace(
    /\{(They|Them|Their|Theirs|Themself|they|them|their|theirs|themself)\}/g,
    (_, token) => {
      const lower     = token.toLowerCase();
      const isCapital = token.charCodeAt(0) >= 65 && token.charCodeAt(0) <= 90;
      return resolvePronoun(lower, isCapital).replace(/\*/g, '&#42;');
    }
  );

  // 3. Markdown: **bold** and *italic*
  result = result
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 4. Inline color spans: [cyan]...[/cyan], [amber]...[/amber], etc.
  const COLOR_TAGS = [
    'cyan', 'amber', 'green', 'red',
    'common', 'uncommon', 'rare', 'epic', 'legendary',
    'white', 'blue', 'purple', 'gold',
    'silver', 'dim', 'faint',
  ];
  for (const color of COLOR_TAGS) {
    const open  = new RegExp(`\\[${color}\\]`, 'g');
    const close = new RegExp(`\\[\\/${color}\\]`, 'g');
    result = result
      .replace(open,  `<span class="inline-accent-${color}">`)
      .replace(close, '</span>');
  }

  return result;
}

// ---------------------------------------------------------------------------
// addParagraph — appends a narrative paragraph before the choice area
// ---------------------------------------------------------------------------
export function addParagraph(text: string, cls = 'narrative-paragraph'): void {
  const p = document.createElement('p');
  p.className = cls;
  p.innerHTML = formatText(text);
  _narrativeContent.insertBefore(p, _choiceArea);

  _narrativeLog.push({ type: 'paragraph', text });
}

// ---------------------------------------------------------------------------
// addSystem — renders a system block
// ---------------------------------------------------------------------------
export function addSystem(text: string): void {
  const div       = document.createElement('div');
  const isEssence = /Essence\s+gained|bonus\s+Essence|\+\d+\s+Essence/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isEssence ? ' essence-block' : ''}${isLevelUp ? ' levelup-block' : ''}`;

  const formatted = formatText(text).replace(/\\n/g, '\n').replace(/\n/g, '<br>');
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  _narrativeContent.insertBefore(div, _choiceArea);

  _narrativeLog.push({ type: 'system', text });
}

// ---------------------------------------------------------------------------
// clearNarrative — removes all narrative nodes, empties choice area
// ---------------------------------------------------------------------------
export function clearNarrative(): void {
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = '';
  _narrativeContent.scrollTo({ top: 0, behavior: 'instant' });
  _narrativeLog = [];
}

// ---------------------------------------------------------------------------
// applyTransition — no-op. Kept so all call sites remain valid.
// ---------------------------------------------------------------------------
export function applyTransition(): void {
  // intentionally empty
}

// ---------------------------------------------------------------------------
// renderChoices — builds choice buttons and wires click → executeBlock
// ---------------------------------------------------------------------------
export function renderChoices(choices: ChoiceOption[]): void {
  _choiceArea.innerHTML = '';

  _choiceArea.setAttribute('role', 'group');
  _choiceArea.setAttribute('aria-label', 'Story choices');

  // Single-fire guard prevents double-click / rapid-tap race.
  let choiceMade = false;

  choices.forEach((choice) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.innerHTML = `<span>${formatText(choice.text)}</span>`;

    // Render inline stat requirement badge if present.
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

  // Focus first enabled button for keyboard accessibility.
  requestAnimationFrame(() => {
    const firstEnabled = _choiceArea.querySelector<HTMLElement>('.choice-btn:not(:disabled)');
    if (firstEnabled) firstEnabled.focus({ preventScroll: true });
  });
}

// ---------------------------------------------------------------------------
// showPageBreak — inserts a "Continue" button that clears the screen.
// ---------------------------------------------------------------------------
export function showPageBreak(btnText: string, onContinue: () => void): void {
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
// ---------------------------------------------------------------------------
export function showInputPrompt(varName: string, prompt: string, onSubmit: (value: string) => void): void {
  const logEntry: NarrativeLogEntry = { type: 'input', varName, prompt, value: null };
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

  const field  = wrapper.querySelector('.input-prompt-field')  as HTMLInputElement;
  const submit = wrapper.querySelector('.input-prompt-submit') as HTMLButtonElement;

  field.addEventListener('input', () => {
    submit.disabled = !field.value.trim();
  });

  function doSubmit() {
    const value = field.value.trim();
    if (!value) return;

    logEntry.value = value;

    wrapper.classList.add('input-prompt-block--submitted');
    wrapper.innerHTML = `
      <span class="system-block-label">[ INPUT ]</span>
      <span class="input-prompt-label">${formatText(prompt)}</span>
      <span class="input-prompt-submitted-value">${escapeHtml(value)}</span>`;

    onSubmit(value);
  }

  submit.addEventListener('click', doSubmit);
  field.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') doSubmit();
  });

  requestAnimationFrame(() => field.focus({ preventScroll: true }));
}

// ---------------------------------------------------------------------------
// renderFromLog — paints the DOM from a log array with zero side effects.
//
// This is the heart of the save/load and undo approach: instead of
// re-executing scene code, we replay the visible record of what was shown.
// ---------------------------------------------------------------------------
export function renderFromLog(log: NarrativeLogEntry[], { skipAnimations = true }: { skipAnimations?: boolean } = {}): void {  // eslint-disable-line no-unused-vars
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
        const isEssence = /Essence\s+gained|bonus\s+Essence|\+\d+\s+Essence/i.test(entry.text ?? '');
        const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(entry.text ?? '');
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

  _narrativeLog = [...log];
}
