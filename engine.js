// Extended ChoiceScript-lite engine for System Awakening

const dom = {
  narrativeContent: document.getElementById('narrative-content'),
  choiceArea: document.getElementById('choice-area'),
  chapterTitle: document.getElementById('chapter-title'),
  narrativePanel: document.getElementById('narrative-panel'),
  statusPanel: document.getElementById('status-panel'),
  statusToggle: document.getElementById('status-toggle'),
  restartBtn: document.getElementById('restart-btn'),
  levelupOverlay: document.getElementById('levelup-overlay'),
  levelupContent: document.getElementById('levelup-content'),
  levelupClose: document.getElementById('levelup-close'),
  endingOverlay: document.getElementById('ending-overlay'),
  endingTitle: document.getElementById('ending-title'),
  endingContent: document.getElementById('ending-content'),
  endingStats: document.getElementById('ending-stats'),
  endingActionBtn: document.getElementById('ending-action-btn')
};

// Warn at startup if any expected DOM element is missing — catches HTML/ID drift early.
Object.entries(dom).forEach(([key, el]) => {
  if (!el) console.warn(`[engine] DOM element missing for key "${key}" — check index.html IDs`);
});

let playerState = {};
let startup = { sceneList: [] };
let currentScene = null;
let currentLines = [];
let ip = 0;
let delayIndex = 0;
let awaitingChoice = null;
let pendingStatPoints = 0;
const sceneCache = new Map();
const labelsCache = new Map();
const styleState = { groups: [], colors: {}, icons: {} };

let _statsRenderPending = false;
function scheduleStatsRender() {
  if (_statsRenderPending) return;
  _statsRenderPending = true;
  Promise.resolve().then(() => { _statsRenderPending = false; runStatsScene(); });
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

function parseLines(text) {
  return text.split(/\r?\n/).map(raw => {
    const indentMatch = raw.match(/^\s*/)?.[0] || '';
    return {
      raw,
      trimmed: raw.trim(),
      indent: indentMatch.length
    };
  });
}

function formatText(text) {
  return text
    .replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => playerState[v] ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function evalValue(expr) {
  const trimmed = expr.trim();
  // Fast-path: plain array literal — don't run through variable substitution
  if (trimmed === '[]') return [];

  // Extract quoted string literals before variable substitution so that
  // special characters inside strings (operators, brackets, keywords) are
  // not mangled by the token-replacement regex.
  const stringSlots = [];
  const withPlaceholders = trimmed.replace(/"([^"\\]|\\.)*"/g, (match) => {
    stringSlots.push(match);
    return `__STR${stringSlots.length - 1}__`;
  });

  const sanitized = withPlaceholders
    .replace(/\band\b/g, '&&')
    .replace(/\bor\b/g, '||')
    .replace(/\bnot\b/g, '!')
    .replace(/\btrue\b/gi, 'true')
    .replace(/\bfalse\b/gi, 'false')
    .replace(/[a-zA-Z_][\w]*/g, (token) => {
      if (['true', 'false'].includes(token)) return token;
      // Restore string placeholders untouched
      if (/^__STR\d+__$/.test(token)) return token;
      if (Object.prototype.hasOwnProperty.call(playerState, token)) return `__s.${token}`;
      return token;
    })
    // Restore the original quoted strings
    .replace(/__STR(\d+)__/g, (_, i) => stringSlots[Number(i)]);

  try {
    return Function('__s', `return (${sanitized});`)(playerState);
  } catch {
    // Last resort: strip outer quotes and return as plain string
    return trimmed.replace(/^"|"$/g, '');
  }
}

function setVar(command) {
  const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, key, rhs] = m;
  if (/^[+\-*/]\s*[\d\w]/.test(rhs) && typeof playerState[key] === 'number') {
    playerState[key] = evalValue(`${playerState[key]} ${rhs}`);
  } else {
    playerState[key] = evalValue(rhs);
  }
  checkAndApplyLevelUp();
  scheduleStatsRender();
}

function checkAndApplyLevelUp() {
  const xp = Number(playerState.xp || 0);
  const next = Number(playerState.xp_to_next || 0);
  if (!next) return;
  let changed = false;
  while (Number(playerState.xp) >= Number(playerState.xp_to_next)) {
    playerState.level = Number(playerState.level || 0) + 1;
    playerState.xp_to_next = Math.floor(Number(playerState.xp_to_next) * 2.2);
    pendingStatPoints += 5;
    changed = true;
  }
  if (changed) showLevelUpOverlay();
}

function addParagraph(text, cls = 'narrative-paragraph') {
  const p = document.createElement('p');
  p.className = cls;
  p.style.animationDelay = `${delayIndex * 80}ms`;
  p.innerHTML = formatText(text);
  delayIndex += 1;
  dom.narrativeContent.insertBefore(p, dom.choiceArea);
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'system-block';
  div.style.animationDelay = `${delayIndex * 80}ms`;
  delayIndex += 1;
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatText(text)}</span>`;
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
}

function clearNarrative() {
  Array.from(dom.narrativeContent.children).forEach(el => {
    if (el !== dom.choiceArea) el.remove();
  });
  dom.choiceArea.innerHTML = '';
  delayIndex = 0;
}

function applyTransition() {
  dom.narrativePanel.classList.add('transitioning');
  setTimeout(() => dom.narrativePanel.classList.remove('transitioning'), 220);
}

async function parseStartup() {
  const text = await fetchTextFile('startup');
  const lines = parseLines(text);
  playerState = {};
  startup.sceneList = [];

  let inSceneList = false;

  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith('//')) continue;
    if (line.trimmed.startsWith('*create')) {
      inSceneList = false; // a *create after *scene_list would be malformed — reset
      const m = line.trimmed.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);
      if (!m) continue;
      const [, key, value] = m;
      playerState[key] = evalValue(value);
      continue;
    }
    if (line.trimmed.startsWith('*scene_list')) {
      inSceneList = true;
      continue;
    }
    // Only collect indented non-command lines when we're inside a *scene_list block
    if (inSceneList && !line.trimmed.startsWith('*') && line.indent > 0) {
      startup.sceneList.push(line.trimmed);
    }
  }
}

function indexLabels(sceneName, lines) {
  const map = {};
  lines.forEach((line, idx) => {
    const m = line.trimmed.match(/^\*label\s+([\w_\-]+)/);
    if (m) map[m[1]] = idx;
  });
  labelsCache.set(sceneName, map);
}

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

async function gotoScene(name, label = null) {
  let text;
  try {
    text = await fetchTextFile(name);
  } catch (err) {
    showEngineError(`Could not load scene "${name}".\n${err.message}`);
    return;
  }
  currentScene = name;
  currentLines = parseLines(text);
  indexLabels(name, currentLines);
  ip = 0;
  clearNarrative();
  applyTransition();
  dom.chapterTitle.textContent = name.toUpperCase();
  if (label) {
    const labels = labelsCache.get(name) || {};
    ip = labels[label] ?? 0;
  }
  await runInterpreter();
}

function findBlockEnd(fromIndex, parentIndent) {
  let i = fromIndex;
  while (i < currentLines.length) {
    const l = currentLines[i];
    if (l.trimmed && l.indent <= parentIndent) break;
    i += 1;
  }
  return i;
}

function findIfChainEnd(fromIndex, indent) {
  let i = fromIndex + 1;
  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    // Anything indented less than the *if means we've left the chain entirely
    if (line.indent < indent) break;
    if (line.indent === indent) {
      if (line.trimmed.startsWith('*elseif') || line.trimmed.startsWith('*else')) {
        // Skip the body of this branch so we don't misread its contents
        const bodyEnd = findBlockEnd(i + 1, indent);
        i = bodyEnd;
        continue;
      }
      // Same-indent non-chain keyword — chain is over
      break;
    }
    i += 1;
  }
  return i;
}

function evaluateCondition(raw) {
  const condition = raw.replace(/^\*if\s*/, '').replace(/^\*elseif\s*/, '').replace(/^\*loop\s*/, '').trim();
  return !!evalValue(condition.replace(/^\(|\)$/g, ''));
}

function parseChoice(startIndex, indent) {
  const choices = [];
  let i = startIndex + 1;
  while (i < currentLines.length) {
    const line = currentLines[i];
    if (!line.trimmed) { i += 1; continue; }
    if (line.indent <= indent) break;

    let selectable = true;
    let optionText = '';
    let optionIndent = line.indent;

    if (line.trimmed.startsWith('*selectable_if')) {
      const m = line.trimmed.match(/^\*selectable_if\s*\((.+)\)\s*#(.*)$/);
      if (m) {
        selectable = !!evalValue(m[1]);
        optionText = m[2].trim();
      }
    } else if (line.trimmed.startsWith('#')) {
      optionText = line.trimmed.slice(1).trim();
    }

    if (optionText) {
      const start = i + 1;
      const end = findBlockEnd(start, optionIndent);
      choices.push({ text: optionText, selectable, start, end });
      i = end;
      continue;
    }

    i += 1;
  }

  return { choices, end: i };
}

async function executeBlock(start, end) {
  const savedIp = ip;
  ip = start;
  while (ip < end) {
    await executeCurrentLine();
    if (awaitingChoice) {
      // Don't restore ip — the choice handler will set ip = ctx.end after the
      // player picks, then call runInterpreter() to continue from there.
      // We do record the block's end so the choice handler can resume correctly.
      awaitingChoice._blockEnd = end;
      awaitingChoice._savedIp = savedIp;
      return;
    }
  }
  ip = savedIp;
}

async function executeCurrentLine() {
  const line = currentLines[ip];
  if (!line) return;
  if (!line.trimmed || line.trimmed.startsWith('//')) {
    ip += 1;
    return;
  }

  const t = line.trimmed;

  if (!t.startsWith('*')) {
    addParagraph(t);
    ip += 1;
    return;
  }

  if (t.startsWith('*title')) {
    dom.chapterTitle.textContent = t.replace('*title', '').trim();
    ip += 1;
    return;
  }

  if (t.startsWith('*label')) {
    ip += 1;
    return;
  }

  if (t.startsWith('*comment')) {
    ip += 1;
    return;
  }

  if (t.startsWith('*goto_scene')) {
    const target = t.replace('*goto_scene', '').trim();
    await gotoScene(target);
    return;
  }

  if (t.startsWith('*goto')) {
    const label = t.replace('*goto', '').trim();
    const labels = labelsCache.get(currentScene) || {};
    ip = labels[label] ?? ip + 1;
    applyTransition();
    return;
  }

  if (t.startsWith('*system')) {
    addSystem(t.replace('*system', '').trim().replace(/^"|"$/g, ''));
    ip += 1;
    return;
  }

  if (t.startsWith('*set')) {
    setVar(t);
    ip += 1;
    return;
  }

  if (t.startsWith('*uppercase')) {
    const key = t.replace('*uppercase', '').trim();
    if (typeof playerState[key] === 'string') playerState[key] = playerState[key].toUpperCase();
    ip += 1;
    return;
  }

  if (t.startsWith('*lowercase')) {
    const key = t.replace('*lowercase', '').trim();
    if (typeof playerState[key] === 'string') playerState[key] = playerState[key].toLowerCase();
    ip += 1;
    return;
  }

  if (t.startsWith('*add_item')) {
    const item = t.replace('*add_item', '').trim().replace(/^"|"$/g, '');
    if (!Array.isArray(playerState.inventory)) playerState.inventory = [];
    if (!playerState.inventory.includes(item)) playerState.inventory.push(item);
    scheduleStatsRender();
    ip += 1;
    return;
  }

  if (t.startsWith('*check_item')) {
    const item = t.replace('*check_item', '').trim().replace(/^"|"$/g, '');
    playerState._check_item = Array.isArray(playerState.inventory) && playerState.inventory.includes(item);
    ip += 1;
    return;
  }

  if (t.startsWith('*if')) {
    const chainEnd = findIfChainEnd(ip, line.indent);
    let cursor = ip;
    let executed = false;
    while (cursor < chainEnd) {
      const c = currentLines[cursor];
      if (!c.trimmed) { cursor += 1; continue; }
      if (c.trimmed.startsWith('*if') || c.trimmed.startsWith('*elseif')) {
        const blockStart = cursor + 1;
        const blockEnd = findBlockEnd(blockStart, c.indent);
        if (!executed && evaluateCondition(c.trimmed)) {
          await executeBlock(blockStart, blockEnd);
          executed = true;
          if (awaitingChoice) return;
        }
        cursor = blockEnd;
        continue;
      }
      if (c.trimmed.startsWith('*else')) {
        const blockStart = cursor + 1;
        const blockEnd = findBlockEnd(blockStart, c.indent);
        if (!executed) {
          await executeBlock(blockStart, blockEnd);
          if (awaitingChoice) return;
        }
        cursor = blockEnd;
        continue;
      }
      cursor += 1;
    }
    ip = chainEnd;
    return;
  }

  if (t.startsWith('*loop')) {
    const blockStart = ip + 1;
    const blockEnd = findBlockEnd(blockStart, line.indent);
    let guard = 0;
    while (evaluateCondition(t) && guard < 100) {
      await executeBlock(blockStart, blockEnd);
      if (awaitingChoice) return;
      guard += 1;
    }
    if (guard >= 100) console.warn(`[engine] *loop guard tripped at line ${ip} — possible infinite loop in scene "${currentScene}"`);

    ip = blockEnd;
    return;
  }

  if (t.startsWith('*choice')) {
    const parsed = parseChoice(ip, line.indent);
    awaitingChoice = { end: parsed.end, choices: parsed.choices };
    renderChoices(parsed.choices);
    return;
  }

  if (t.startsWith('*ending')) {
    showEndingScreen('The End', 'Your path is complete.');
    return;
  }

  ip += 1;
}

function renderChoices(choices) {
  dom.choiceArea.innerHTML = '';
  choices.forEach((choice, idx) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.style.animationDelay = `${(delayIndex + idx) * 80}ms`;
    btn.innerHTML = `<span>${formatText(choice.text)}</span>`;
    if (!choice.selectable) {
      btn.disabled = true;
      btn.style.opacity = '0.4';
    }
    btn.addEventListener('click', async () => {
      dom.choiceArea.querySelectorAll('button').forEach(b => b.disabled = true);
      const ctx = awaitingChoice;
      awaitingChoice = null;
      // If the choice was inside an executeBlock, resume after that block ends.
      // Otherwise resume after the *choice command's own parsed end.
      ip = ctx._savedIp !== undefined ? ctx._savedIp : ctx.end;
      await executeBlock(choice.start, choice.end);
      if (!awaitingChoice) await runInterpreter();
    });
    dom.choiceArea.appendChild(btn);
  });
}

async function runInterpreter() {
  while (ip < currentLines.length) {
    await executeCurrentLine();
    if (awaitingChoice) break;
  }
  dom.narrativeContent.scrollTop = 0;
  runStatsScene();
}

async function runStatsScene() {
  const text = await fetchTextFile('stats');
  const lines = parseLines(text);
  let html = '';
  styleState.groups = [];
  styleState.colors = {};
  styleState.icons = {};

  const entries = [];
  lines.forEach((line) => {
    const t = line.trimmed;
    if (!t || t.startsWith('//')) return;

    if (t.startsWith('*stat_group')) {
      const name = t.replace('*stat_group', '').trim().replace(/^"|"$/g, '');
      entries.push({ type: 'group', name });
    } else if (t.startsWith('*stat_color')) {
      const [, key, color] = t.split(/\s+/);
      styleState.colors[key] = color;
    } else if (t.startsWith('*stat_icon')) {
      const m = t.match(/^\*stat_icon\s+([\w_]+)\s+"(.+)"$/);
      if (m) styleState.icons[m[1]] = m[2];
    } else if (t.startsWith('*inventory')) {
      entries.push({ type: 'inventory' });
    } else if (t.startsWith('*stat')) {
      const m = t.match(/^\*stat\s+([\w_]+)\s+"(.+)"$/);
      if (m) entries.push({ type: 'stat', key: m[1], label: m[2] });
    }
  });

  entries.forEach(e => {
    if (e.type === 'group') {
      html += `<div class="status-section"><div class="status-label status-section-header">${e.name}</div>`;
    }
    if (e.type === 'stat') {
      const colorClass = styleState.colors[e.key] || '';
      const icon = styleState.icons[e.key] ?? '';
      // Only prepend icon + space when an icon is actually defined for this key
      const labelHtml = icon ? `${icon} ${e.label}` : e.label;
      html += `<div class="status-row"><span class="status-label">${labelHtml}</span><span class="status-value ${colorClass}">${playerState[e.key] ?? '—'}</span></div>`;
    }
    if (e.type === 'inventory') {
      const items = Array.isArray(playerState.inventory) && playerState.inventory.length
        ? playerState.inventory.map(i => `<li>${i}</li>`).join('')
        : '<li class="tag-empty">Empty</li>';
      html += `<div class="status-section"><div class="status-label status-section-header">Inventory</div><ul class="tag-list">${items}</ul></div>`;
    }
    if (e.type === 'group') html += `</div>`;
  });

  dom.statusPanel.innerHTML = html;
}

function showLevelUpOverlay() {
  const keys = ['fortitude', 'perception', 'strength', 'agility', 'magic_power', 'magic_regen'];
  const labels = {
    fortitude: 'Fortitude', perception: 'Perception', strength: 'Strength',
    agility: 'Agility', magic_power: 'Mag.Power', magic_regen: 'Mag.Regen'
  };
  const alloc = Object.fromEntries(keys.map(k => [k, 0]));

  const render = () => {
    const spent = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain = pendingStatPoints - spent;
    dom.levelupContent.innerHTML = `
      <div style="color:var(--cyan);margin-bottom:6px;">Reached <strong>Level ${playerState.level}</strong></div>
      <div style="font-family:var(--font-mono);font-size:0.7rem;color:var(--amber);margin-bottom:14px;">Stat points: <strong>${remain}</strong></div>
      <div class="stat-alloc-grid">
      ${keys.map(k => `
        <div class="stat-alloc-item ${alloc[k] ? 'selected' : ''}">
          <span class="stat-alloc-name">${labels[k]}</span>
          <div style="display:flex;justify-content:center;gap:8px;">
            <button class="alloc-btn" data-op="minus" data-k="${k}" ${alloc[k] <= 0 ? 'disabled' : ''}>−</button>
            <span class="stat-alloc-val ${alloc[k] ? 'buffed' : ''}">${Number(playerState[k] || 0) + alloc[k]}</span>
            <button class="alloc-btn" data-op="plus" data-k="${k}" ${remain <= 0 ? 'disabled' : ''}>+</button>
          </div>
        </div>
      `).join('')}
      </div>`;

    dom.levelupContent.querySelectorAll('.alloc-btn').forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.k;
        if (btn.dataset.op === 'plus' && Object.values(alloc).reduce((a, b) => a + b, 0) < pendingStatPoints) alloc[key] += 1;
        if (btn.dataset.op === 'minus' && alloc[key] > 0) alloc[key] -= 1;
        render();
      };
    });
  };

  render();
  dom.levelupOverlay.classList.remove('hidden');
  dom.levelupClose.onclick = () => {
    Object.entries(alloc).forEach(([k, v]) => playerState[k] = Number(playerState[k] || 0) + v);
    pendingStatPoints = 0;
    dom.levelupOverlay.classList.add('hidden');
    runStatsScene();
  };
}

function showEndingScreen(title, subtitle) {
  dom.endingTitle.textContent = title;
  dom.endingContent.textContent = subtitle;
  dom.endingStats.innerHTML = `Level: ${playerState.level || 0}<br>XP: ${playerState.xp || 0}<br>Class: ${playerState.class_name || 'Unclassed'}`;
  dom.endingActionBtn.textContent = 'Play Again';
  dom.endingActionBtn.onclick = () => location.reload();
  dom.endingOverlay.classList.remove('hidden');
}

function resetGame() {
  location.reload();
}

function wireUI() {
  dom.statusToggle.addEventListener('click', () => {
    dom.statusPanel.classList.toggle('status-hidden');
    dom.statusPanel.classList.toggle('status-visible');
    runStatsScene();
  });

  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 768 && !dom.statusPanel.contains(e.target) && e.target !== dom.statusToggle) {
      dom.statusPanel.classList.remove('status-visible');
      dom.statusPanel.classList.add('status-hidden');
    }
  });

  dom.restartBtn.addEventListener('click', () => {
    if (confirm('Restart from the beginning?')) resetGame();
  });
}

async function boot() {
  wireUI();
  try {
    await parseStartup();
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || 'prologue');
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}

document.addEventListener('DOMContentLoaded', boot);
