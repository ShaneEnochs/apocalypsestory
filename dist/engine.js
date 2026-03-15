// engine/core/state.js
var playerState = {};
var tempState = {};
var statRegistry = [];
var sessionState = {};
var currentScene = null;
var currentLines = [];
var ip = 0;
var _gotoJumped = false;
var awaitingChoice = null;
var pendingStatPoints = 0;
var pendingLevelUpDisplay = false;
var _pendingLevelUpCount = 0;
var delayIndex = 0;
var startup = { sceneList: [] };
var pauseState = null;
function setPauseState(s) {
  pauseState = s;
}
function clearPauseState() {
  pauseState = null;
}
var chapterTitle = "\u2014";
function setChapterTitleState(t) {
  chapterTitle = t;
}
function setPlayerState(s) {
  playerState = s;
}
function patchPlayerState(patch) {
  Object.assign(playerState, patch);
}
function setTempState(s) {
  tempState = s;
}
function setStatRegistry(r) {
  statRegistry = r;
}
function setSessionState(s) {
  sessionState = s;
}
function clearSessionState() {
  sessionState = {};
}
function patchSessionState(p) {
  Object.assign(sessionState, p);
}
function setCurrentScene(s) {
  currentScene = s;
}
function setCurrentLines(l) {
  currentLines = l;
}
function setIp(n) {
  ip = n;
}
function advanceIp() {
  ip += 1;
}
function setGotoJumped(v) {
  _gotoJumped = v;
}
function setAwaitingChoice(c) {
  awaitingChoice = c;
}
function setPendingStatPoints(n) {
  pendingStatPoints = n;
}
function addPendingStatPoints(n) {
  pendingStatPoints += n;
}
function setPendingLevelUpDisplay(v) {
  pendingLevelUpDisplay = v;
}
function addPendingLevelUpCount(n) {
  _pendingLevelUpCount += n;
}
function setDelayIndex(n) {
  delayIndex = n;
}
function advanceDelayIndex() {
  delayIndex += 1;
}
function clearTempState() {
  tempState = {};
}
function normalizeKey(k) {
  return String(k).trim().toLowerCase();
}
function setVar(command, evalValueFn) {
  const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);
  const inTemp = Object.prototype.hasOwnProperty.call(tempState, key);
  const inPlayer = Object.prototype.hasOwnProperty.call(playerState, key);
  const store = inTemp ? tempState : playerState;
  if (!inTemp && !inPlayer) {
    console.warn(`[state] *set on undeclared variable "${key}" \u2014 did you mean *create or *temp?`);
    return;
  }
  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === "number") {
    const result = evalValueFn(`${store[key]} ${rhs}`);
    const coerced = Number.isFinite(result) ? result : evalValueFn(rhs);
    store[key] = coerced === 0 ? 0 : coerced;
  } else {
    store[key] = evalValueFn(rhs);
  }
}
function setStatClamped(command, evalValueFn) {
  const m = command.match(/^\*set_stat\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rest] = m;
  const key = normalizeKey(rawKey);
  const inTemp = Object.prototype.hasOwnProperty.call(tempState, key);
  const inPlayer = Object.prototype.hasOwnProperty.call(playerState, key);
  const store = inTemp ? tempState : playerState;
  if (!inTemp && !inPlayer) {
    console.warn(`[state] *set_stat on undeclared variable "${key}" \u2014 did you mean *create or *temp?`);
    return;
  }
  const minMatch = rest.match(/\bmin:\s*(-?[\d.]+)/i);
  const maxMatch = rest.match(/\bmax:\s*(-?[\d.]+)/i);
  const rhs = rest.replace(/\bmin:\s*-?[\d.]+/gi, "").replace(/\bmax:\s*-?[\d.]+/gi, "").trim();
  const minVal = minMatch ? Number(minMatch[1]) : -Infinity;
  const maxVal = maxMatch ? Number(maxMatch[1]) : Infinity;
  let newVal;
  if (/^[+\-*/]\s*/.test(rhs) && typeof store[key] === "number") {
    const result = evalValueFn(`${store[key]} ${rhs}`);
    newVal = Number.isFinite(result) ? result : evalValueFn(rhs);
  } else {
    newVal = evalValueFn(rhs);
  }
  if (typeof newVal === "number") {
    newVal = Math.min(maxVal, Math.max(minVal, newVal));
    newVal = newVal === 0 ? 0 : newVal;
  }
  store[key] = newVal;
}
function declareTemp(command, evalValueFn) {
  const m = command.match(/^\*temp\s+([a-zA-Z_][\w]*)(?:\s+(.+))?$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  tempState[normalizeKey(rawKey)] = rhs !== void 0 ? evalValueFn(rhs) : 0;
}
var _statRegistryWarningFired = false;
async function parseStartup(fetchTextFileFn, evalValueFn) {
  const text = await fetchTextFileFn("startup");
  const lines = text.split(/\r?\n/).map((raw) => ({
    raw,
    trimmed: raw.trim(),
    indent: (raw.match(/^\s*/)?.[0] || "").length
  }));
  playerState = {};
  tempState = {};
  statRegistry = [];
  startup = { sceneList: [] };
  let inSceneList = false;
  for (const line of lines) {
    if (!line.trimmed || line.trimmed.startsWith("//")) continue;
    if (line.trimmed.startsWith("*create_stat")) {
      inSceneList = false;
      const m = line.trimmed.match(/^\*create_stat\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(.+)$/);
      if (!m) {
        console.warn(`[state] Malformed *create_stat: ${line.trimmed}`);
        continue;
      }
      const [, rawKey, label, valStr] = m;
      const key = normalizeKey(rawKey);
      const dv = evalValueFn(valStr);
      playerState[key] = dv;
      statRegistry.push({ key, label, defaultVal: dv });
      continue;
    }
    if (line.trimmed.startsWith("*create")) {
      inSceneList = false;
      const m = line.trimmed.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);
      if (!m) continue;
      const [, rawKey, value] = m;
      playerState[normalizeKey(rawKey)] = evalValueFn(value);
      continue;
    }
    if (line.trimmed.startsWith("*scene_list")) {
      inSceneList = true;
      continue;
    }
    if (inSceneList && !line.trimmed.startsWith("*") && line.indent > 0) {
      startup.sceneList.push(line.trimmed);
    }
  }
  if (statRegistry.length === 0 && !_statRegistryWarningFired) {
    console.warn("[state] No *create_stat entries found \u2014 level-up allocation will be empty.");
    _statRegistryWarningFired = true;
  }
  const _LVL_CONFIG_KEYS = ["xp_up_mult", "lvl_up_stat_gain", "lvl_up_skill_gain", "xp_to_next"];
  const _missingConfig = _LVL_CONFIG_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(playerState, k));
  if (_missingConfig.length > 0) {
    console.warn(
      `[state] startup.txt is missing level-up config variable(s): ${_missingConfig.join(", ")}. The engine will use hardcoded fallback values. Add the missing *create declarations to startup.txt.`
    );
  }
}

// engine/core/expression.js
var TT = {
  NUM: "NUM",
  STR: "STR",
  BOOL: "BOOL",
  IDENT: "IDENT",
  LBRACKET: "[",
  RBRACKET: "]",
  LPAREN: "(",
  RPAREN: ")",
  PLUS: "+",
  MINUS: "-",
  STAR: "*",
  SLASH: "/",
  LT: "<",
  GT: ">",
  LTE: "<=",
  GTE: ">=",
  EQ: "=",
  NEQ: "!=",
  AND: "AND",
  OR: "OR",
  NOT: "NOT",
  COMMA: ",",
  EOF: "EOF"
};
function tokenise(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      i++;
      continue;
    }
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      tokens.push({ type: TT.STR, value: src.slice(i + 1, j).replace(/\\"/g, '"') });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(src[i])) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: TT.NUM, value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (src[i] === "<" && src[i + 1] === "=") {
      tokens.push({ type: TT.LTE, value: "<=" });
      i += 2;
      continue;
    }
    if (src[i] === ">" && src[i + 1] === "=") {
      tokens.push({ type: TT.GTE, value: ">=" });
      i += 2;
      continue;
    }
    if (src[i] === "!" && src[i + 1] === "=") {
      tokens.push({ type: TT.NEQ, value: "!=" });
      i += 2;
      continue;
    }
    if (src[i] === "&" && src[i + 1] === "&") {
      tokens.push({ type: TT.AND, value: "and" });
      i += 2;
      continue;
    }
    if (src[i] === "|" && src[i + 1] === "|") {
      tokens.push({ type: TT.OR, value: "or" });
      i += 2;
      continue;
    }
    if (src[i] === "=" && src[i + 1] === "=") {
      tokens.push({ type: TT.EQ, value: "=" });
      i += 2;
      continue;
    }
    const SINGLE = {
      "+": TT.PLUS,
      "-": TT.MINUS,
      "*": TT.STAR,
      "/": TT.SLASH,
      "<": TT.LT,
      ">": TT.GT,
      "=": TT.EQ,
      "(": TT.LPAREN,
      ")": TT.RPAREN,
      "[": TT.LBRACKET,
      "]": TT.RBRACKET,
      "!": TT.NOT,
      ",": TT.COMMA
    };
    if (SINGLE[src[i]]) {
      tokens.push({ type: SINGLE[src[i]], value: src[i] });
      i++;
      continue;
    }
    if (/[a-zA-Z_]/.test(src[i])) {
      let j = i;
      while (j < src.length && /[\w]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === "true") {
        tokens.push({ type: TT.BOOL, value: true });
        i = j;
        continue;
      }
      if (lower === "false") {
        tokens.push({ type: TT.BOOL, value: false });
        i = j;
        continue;
      }
      if (lower === "and") {
        tokens.push({ type: TT.AND, value: "and" });
        i = j;
        continue;
      }
      if (lower === "or") {
        tokens.push({ type: TT.OR, value: "or" });
        i = j;
        continue;
      }
      if (lower === "not") {
        tokens.push({ type: TT.NOT, value: "not" });
        i = j;
        continue;
      }
      tokens.push({ type: TT.IDENT, value: word });
      i = j;
      continue;
    }
    console.warn(`[expression] Unexpected character '${src[i]}' in expression: ${src}`);
    i++;
  }
  tokens.push({ type: TT.EOF });
  return tokens;
}
function makeParser(tokens) {
  let pos = 0;
  function peek() {
    return tokens[pos];
  }
  function advance() {
    return tokens[pos++];
  }
  function expect(type) {
    if (peek().type !== type) {
      throw new Error(`[expression] Expected ${type} but got ${peek().type}`);
    }
    return advance();
  }
  function parseExpr() {
    return parseOr();
  }
  function parseOr() {
    let left = parseAnd();
    while (peek().type === TT.OR) {
      advance();
      const right = parseAnd();
      left = left || right;
    }
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (peek().type === TT.AND) {
      advance();
      const right = parseNot();
      left = left && right;
    }
    return left;
  }
  function parseNot() {
    if (peek().type === TT.NOT) {
      advance();
      return !parseNot();
    }
    return parseComparison();
  }
  function parseComparison() {
    let left = parseAddSub();
    const CMP = [TT.LT, TT.GT, TT.LTE, TT.GTE, TT.EQ, TT.NEQ];
    while (CMP.includes(peek().type)) {
      const op = advance().type;
      const right = parseAddSub();
      if (op === TT.LT) left = left < right;
      if (op === TT.GT) left = left > right;
      if (op === TT.LTE) left = left <= right;
      if (op === TT.GTE) left = left >= right;
      if (op === TT.EQ) left = left == right;
      if (op === TT.NEQ) left = left != right;
    }
    return left;
  }
  function parseAddSub() {
    let left = parseMulDiv();
    while (peek().type === TT.PLUS || peek().type === TT.MINUS) {
      const op = advance().type;
      const right = parseMulDiv();
      left = op === TT.PLUS ? left + right : left - right;
    }
    return left;
  }
  function parseMulDiv() {
    let left = parseUnary();
    while (peek().type === TT.STAR || peek().type === TT.SLASH) {
      const op = advance().type;
      const right = parseUnary();
      if (op === TT.SLASH && right === 0) {
        console.warn("[expression] Division by zero \u2014 returning 0");
        left = 0;
      } else {
        left = op === TT.STAR ? left * right : left / right;
      }
    }
    return left;
  }
  function parseUnary() {
    if (peek().type === TT.MINUS) {
      advance();
      return -parseUnary();
    }
    if (peek().type === TT.NOT) {
      advance();
      return !parseUnary();
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = peek();
    if (tok.type === TT.NUM) {
      advance();
      return tok.value;
    }
    if (tok.type === TT.STR) {
      advance();
      return tok.value;
    }
    if (tok.type === TT.BOOL) {
      advance();
      return tok.value;
    }
    if (tok.type === TT.LBRACKET) {
      advance();
      if (peek().type === TT.RBRACKET) {
        advance();
        return [];
      }
      throw new Error("[expression] Non-empty array literals not supported");
    }
    if (tok.type === TT.LPAREN) {
      advance();
      const val = parseExpr();
      expect(TT.RPAREN);
      return val;
    }
    if (tok.type === TT.IDENT) {
      advance();
      if (peek().type === TT.LPAREN) {
        advance();
        return parseFunction(tok.value);
      }
      const key = normalizeKey(tok.value);
      if (Object.prototype.hasOwnProperty.call(tempState, key)) return tempState[key];
      if (Object.prototype.hasOwnProperty.call(sessionState, key)) return sessionState[key];
      if (Object.prototype.hasOwnProperty.call(playerState, key)) return playerState[key];
      console.warn(`[expression] Unknown variable "${tok.value}" \u2014 returning 0. Check for typos in scene files.`);
      return 0;
    }
    throw new Error(`[expression] Unexpected token ${tok.type}`);
  }
  function parseArgList() {
    const args = [];
    if (peek().type === TT.RPAREN) {
      advance();
      return args;
    }
    args.push(parseExpr());
    while (peek().type === TT.COMMA) {
      advance();
      args.push(parseExpr());
    }
    expect(TT.RPAREN);
    return args;
  }
  const BUILTINS = {
    random: (args) => {
      const lo = Math.ceil(Number(args[0] ?? 1));
      const hi = Math.floor(Number(args[1] ?? lo));
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    },
    round: (args) => Math.round(Number(args[0] ?? 0)),
    floor: (args) => Math.floor(Number(args[0] ?? 0)),
    ceil: (args) => Math.ceil(Number(args[0] ?? 0)),
    abs: (args) => Math.abs(Number(args[0] ?? 0)),
    min: (args) => Math.min(...args.map(Number)),
    max: (args) => Math.max(...args.map(Number)),
    length: (args) => {
      const v = args[0];
      if (Array.isArray(v)) return v.length;
      return String(v ?? "").length;
    }
  };
  function parseFunction(name) {
    const lower = name.toLowerCase();
    const fn = BUILTINS[lower];
    if (!fn) {
      console.warn(`[expression] Unknown function "${name}" \u2014 returning 0`);
      parseArgList();
      return 0;
    }
    return fn(parseArgList());
  }
  return { parseExpr };
}
function evalValue(expr) {
  const trimmed = expr.trim();
  if (/^"[^"]*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === "[]") return [];
  try {
    const tokens = tokenise(trimmed);
    const parser = makeParser(tokens);
    return parser.parseExpr();
  } catch (err) {
    console.warn(`[expression] Parse error in "${trimmed}": ${err.message}`);
    return 0;
  }
}

// engine/core/parser.js
function parseLines(text) {
  return text.split(/\r?\n/).map((raw) => {
    const indentMatch = raw.match(/^\s*/)?.[0] || "";
    return { raw, trimmed: raw.trim(), indent: indentMatch.length };
  });
}
function indexLabels(sceneName, lines, labelsCache2) {
  const map = {};
  lines.forEach((line, idx) => {
    const m = line.trimmed.match(/^\*label\s+([\w_\-]+)/);
    if (m) map[m[1]] = idx;
  });
  labelsCache2.set(sceneName, map);
}
function parseChoice(startIndex, indent, ctx) {
  const { currentLines: currentLines2, evalValue: evalValue2, showEngineError: showEngineError2 } = ctx;
  const choices = [];
  let i = startIndex + 1;
  while (i < currentLines2.length) {
    const line = currentLines2[i];
    if (!line.trimmed) {
      i += 1;
      continue;
    }
    if (line.indent <= indent) break;
    let selectable = true;
    let optionText = "";
    const optionIndent = line.indent;
    if (line.trimmed.startsWith("*selectable_if")) {
      const m = line.trimmed.match(/^\*selectable_if\s*\((.+)\)\s*#(.*)$/);
      if (m) {
        selectable = !!evalValue2(m[1]);
        optionText = m[2].trim();
      } else {
        const msg = `[parser] Malformed *selectable_if at line ${i}: "${line.trimmed}"
Expected: *selectable_if (condition) #Option text`;
        console.warn(msg);
        if (typeof showEngineError2 === "function") showEngineError2(msg);
      }
    } else if (line.trimmed.startsWith("#")) {
      optionText = line.trimmed.slice(1).trim();
    }
    if (optionText) {
      let statTag = null;
      const tagMatch = optionText.match(/^(.*?)\s*\[([A-Za-z][^[\]]*?)\s+(\d+)\]\s*$/);
      if (tagMatch) {
        optionText = tagMatch[1].trim();
        statTag = { label: tagMatch[2].trim(), requirement: Number(tagMatch[3]) };
      }
      const start = i + 1;
      const end = findBlockEnd(start, optionIndent, currentLines2);
      choices.push({ text: optionText, selectable, start, end, statTag });
      i = end;
      continue;
    }
    i += 1;
  }
  return { choices, end: i };
}
function parseSystemBlock(startIndex, ctx) {
  const { currentLines: currentLines2 } = ctx;
  const parts = [];
  let baseIndent = null;
  let i = startIndex + 1;
  while (i < currentLines2.length) {
    const t = currentLines2[i].trimmed;
    if (t === "*end_system") return { text: parts.join("\n"), endIp: i + 1, ok: true };
    if (baseIndent === null && t) baseIndent = currentLines2[i].indent;
    const raw = currentLines2[i].raw;
    parts.push(
      baseIndent !== null ? raw.slice(Math.min(baseIndent, raw.search(/\S|$/))) : raw.trimStart()
    );
    i += 1;
  }
  return { text: "", endIp: currentLines2.length, ok: false };
}
function findBlockEnd(fromIndex, parentIndent, currentLines2) {
  let i = fromIndex;
  while (i < currentLines2.length) {
    const l = currentLines2[i];
    if (l.trimmed && l.indent <= parentIndent) break;
    i += 1;
  }
  return i;
}

// engine/systems/inventory.js
function extractStackCount(itemStr) {
  const m = String(itemStr).match(/\((\d+)\)$/);
  return m ? Number(m[1]) : 1;
}
function itemBaseName(item) {
  return String(item).replace(/\s*\(\d+\)$/, "").trim();
}
function addInventoryItem(item) {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) playerState.inventory = [];
  const idx = playerState.inventory.findIndex((i) => itemBaseName(i) === normalized);
  if (idx === -1) {
    playerState.inventory.push(normalized);
  } else {
    const count = extractStackCount(playerState.inventory[idx]);
    playerState.inventory[idx] = `${normalized} (${count + 1})`;
  }
  return true;
}
function removeInventoryItem(item) {
  const normalized = itemBaseName(item);
  if (!normalized) return false;
  if (!Array.isArray(playerState.inventory)) return false;
  const idx = playerState.inventory.findIndex((i) => itemBaseName(i) === normalized);
  if (idx === -1) {
    console.warn(`[inventory] *remove_item: "${normalized}" not found.`);
    return false;
  }
  const qty = extractStackCount(playerState.inventory[idx]);
  if (qty <= 1) playerState.inventory.splice(idx, 1);
  else if (qty === 2) playerState.inventory[idx] = normalized;
  else playerState.inventory[idx] = `${normalized} (${qty - 1})`;
  return true;
}
function parseInventoryUpdateText(text) {
  const m = text.match(/Inventory\s+updated\s*:\s*([^\n]+)/i);
  if (!m) return [];
  return m[1].trim().split(",").map((e) => e.trim().replace(/\.$/, "")).filter((e) => e && e.length <= 60 && !/\b(assembled|acquired|secured|updated|complete|lost|destroyed)\b/i.test(e));
}

// engine/systems/leveling.js
function getAllocatableStatKeys() {
  return statRegistry.map((e) => e.key);
}
function checkAndApplyLevelUp(onChanged) {
  if (!Number(playerState.xp_to_next || 0)) return;
  const mult = Number(playerState.xp_up_mult ?? 2.2);
  const gain = Number(playerState.lvl_up_stat_gain ?? 5);
  const skillGain = Number(playerState.lvl_up_skill_gain ?? 0);
  let changed = false;
  while (Number(playerState.xp) >= Number(playerState.xp_to_next)) {
    playerState.level = Number(playerState.level || 0) + 1;
    playerState.xp_to_next = Math.floor(Number(playerState.xp_to_next) * mult);
    addPendingStatPoints(gain);
    addPendingLevelUpCount(1);
    if (skillGain > 0) {
      playerState.skill_points = Number(playerState.skill_points || 0) + skillGain;
    }
    changed = true;
  }
  if (changed) {
    setPendingLevelUpDisplay(true);
    if (typeof onChanged === "function") onChanged();
  }
}
function applyVitalNumeric(key, b) {
  if (key === "health") {
    if (typeof playerState[key] === "string") {
      playerState[key] = b;
    } else {
      playerState[key] = Number(playerState[key] || 0) + b;
    }
  } else {
    playerState[key] = Number(playerState[key] || 0) + b;
  }
}
function applySystemRewards(text, onChanged) {
  let stateChanged = false;
  const xpRanges = [];
  for (const pattern of [
    /XP\s+gained\s*:\s*\+\s*(\d+)/gi,
    /\+[^\S\n]*(\d+)[^\S\n]*(?:bonus[^\S\n]+)?XP\b/gi
  ]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amount = Number(match[1]);
      if (Number.isFinite(amount) && amount > 0) {
        xpRanges.push({ start: match.index, end: match.index + match[0].length, amount });
      }
    }
  }
  xpRanges.sort((a, b) => a.start - b.start);
  let lastEnd = -1, gainedTotal = 0;
  for (const r of xpRanges) {
    if (r.start >= lastEnd) {
      gainedTotal += r.amount;
      lastEnd = r.end;
    }
  }
  if (gainedTotal > 0) {
    playerState.xp = Number(playerState.xp || 0) + gainedTotal;
    checkAndApplyLevelUp(onChanged);
    stateChanged = true;
  }
  const allStatsM = text.match(/\+\s*(\d+)\s+to\s+all\s+stats?/i);
  if (allStatsM) {
    const b = Number(allStatsM[1]);
    if (b > 0) {
      getAllocatableStatKeys().forEach((k) => {
        playerState[k] = Number(playerState[k] || 0) + b;
      });
      stateChanged = true;
    }
  }
  const vitals = [
    { regex: /\+\s*(\d+)\s+max\s+mana\b/i, key: "max_mana" },
    { regex: /\+\s*(\d+)\s+mana\b/i, key: "mana" },
    { regex: /\+\s*(\d+)\s+health\b/i, key: "health" }
  ];
  const statPatterns = [];
  statRegistry.forEach(({ key, label }) => {
    const el = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${el}\\b`, "i"), key });
    const nk = key.toLowerCase(), nl = label.toLowerCase().replace(/\s+/g, "_");
    if (nk !== nl) {
      const ek = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/_/g, "[ _]");
      statPatterns.push({ regex: new RegExp(`\\+\\s*(\\d+)\\s+${ek}\\b`, "i"), key });
    }
  });
  [...vitals, ...statPatterns].forEach(({ regex, key }) => {
    const m2 = text.match(regex);
    if (!m2) return;
    const b = Number(m2[1]);
    if (b > 0) {
      applyVitalNumeric(key, b);
      stateChanged = true;
    }
  });
  parseInventoryUpdateText(text).forEach((item) => {
    if (addInventoryItem(item)) stateChanged = true;
  });
  if (stateChanged && typeof onChanged === "function") onChanged();
}

// engine/systems/saves.js
var SAVE_VERSION = 6;
var SAVE_KEY_AUTO = "sa_save_auto";
var SAVE_KEY_SLOTS = { 1: "sa_save_slot_1", 2: "sa_save_slot_2", 3: "sa_save_slot_3" };
function saveKeyForSlot(slot) {
  return slot === "auto" ? SAVE_KEY_AUTO : SAVE_KEY_SLOTS[slot] ?? null;
}
var _staleSaveFound = false;
function clearStaleSaveFound() {
  _staleSaveFound = false;
}
function setStaleSaveFound() {
  _staleSaveFound = true;
}
function buildSavePayload(slot, label, narrativeLog) {
  return {
    version: SAVE_VERSION,
    slot: String(slot),
    scene: currentScene,
    label: label ?? null,
    ip,
    chapterTitle,
    pauseState: pauseState ?? null,
    awaitingChoice: awaitingChoice ? JSON.parse(JSON.stringify(awaitingChoice)) : null,
    // FIX #S6
    characterName: `${playerState.first_name || ""} ${playerState.last_name || ""}`.trim() || "Unknown",
    playerState: JSON.parse(JSON.stringify(playerState)),
    sessionState: JSON.parse(JSON.stringify(sessionState)),
    statRegistry: JSON.parse(JSON.stringify(statRegistry)),
    pendingStatPoints,
    narrativeLog: JSON.parse(JSON.stringify(narrativeLog ?? [])),
    timestamp: Date.now()
  };
}
function saveGameToSlot(slot, label = null, narrativeLog = []) {
  const key = saveKeyForSlot(slot);
  if (!key) {
    console.warn(`[saves] Unknown save slot: "${slot}"`);
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(buildSavePayload(slot, label, narrativeLog)));
  } catch (err) {
    console.warn(`[saves] Save to slot "${slot}" failed:`, err);
  }
}
function loadSaveFromSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const save = JSON.parse(raw);
    if (save.version !== SAVE_VERSION) {
      console.warn(`[saves] Slot "${slot}" version mismatch (v${save.version}) \u2014 discarding.`);
      setStaleSaveFound();
      return null;
    }
    return save;
  } catch {
    return null;
  }
}
function deleteSaveSlot(slot) {
  const key = saveKeyForSlot(slot);
  if (key) try {
    localStorage.removeItem(key);
  } catch (_) {
  }
}
function exportSaveSlot(slot) {
  const save = loadSaveFromSlot(slot);
  if (!save) return false;
  const safeName = (save.characterName || "Unknown").replace(/[^a-zA-Z0-9_\- ]/g, "").replace(/\s+/g, "_");
  const filename = `sa-save-slot${slot}-${safeName}.json`;
  const blob = new Blob([JSON.stringify(save, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
function importSaveFromJSON(json, targetSlot) {
  if (!json || typeof json !== "object" || Array.isArray(json))
    return { ok: false, reason: "File is not a valid JSON object." };
  if (json.version !== SAVE_VERSION)
    return { ok: false, reason: `Save version mismatch (file is v${json.version}, engine expects v${SAVE_VERSION}).` };
  if (!json.playerState || typeof json.playerState !== "object")
    return { ok: false, reason: "Save file is missing playerState." };
  if (!json.scene || typeof json.scene !== "string")
    return { ok: false, reason: "Save file is missing scene name." };
  const key = saveKeyForSlot(targetSlot);
  if (!key) return { ok: false, reason: `Invalid target slot: "${targetSlot}".` };
  const patched = { ...json, slot: String(targetSlot) };
  try {
    localStorage.setItem(key, JSON.stringify(patched));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `localStorage write failed: ${err.message}` };
  }
}
async function restoreFromSave(save, {
  runStatsScene: runStatsScene2,
  renderFromLog: renderFromLog2,
  renderChoices: renderChoices2,
  showInlineLevelUp: showInlineLevelUp2,
  showPageBreak: showPageBreak2,
  showInputPrompt: showInputPrompt2,
  runInterpreter: runInterpreter2,
  clearNarrative: clearNarrative2,
  applyTransition: applyTransition2,
  setChapterTitle,
  setChoiceArea: setChoiceArea2,
  parseAndCacheScene,
  fetchTextFileFn,
  evalValueFn
}) {
  await parseStartup(fetchTextFileFn, evalValueFn);
  const freshKeys = new Set(Object.keys(playerState));
  const savedFiltered = {};
  for (const [k, v] of Object.entries(save.playerState)) {
    if (freshKeys.has(k)) savedFiltered[k] = v;
  }
  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(savedFiltered)) });
  const savedPoints = save.pendingStatPoints ?? 0;
  setPendingStatPoints(savedPoints);
  if (savedPoints > 0) setPendingLevelUpDisplay(true);
  clearTempState();
  if (Array.isArray(save.statRegistry) && save.statRegistry.length > 0) {
    const freshStatKeys = new Set(statRegistry.map((e) => e.key));
    const extra = save.statRegistry.filter((e) => !freshStatKeys.has(e.key));
    if (extra.length > 0) {
      setStatRegistry([...statRegistry, ...extra]);
    }
  }
  if (save.sessionState && typeof save.sessionState === "object" && !Array.isArray(save.sessionState)) {
    setSessionState(JSON.parse(JSON.stringify(save.sessionState)));
  }
  await parseAndCacheScene(save.scene);
  setCurrentScene(save.scene);
  setIp(save.ip ?? 0);
  setDelayIndex(0);
  setAwaitingChoice(null);
  clearPauseState();
  if (save.chapterTitle) {
    setChapterTitle(save.chapterTitle);
  }
  clearNarrative2();
  applyTransition2();
  renderFromLog2(save.narrativeLog ?? [], { skipAnimations: true });
  if (typeof setChoiceArea2 === "function") {
    setChoiceArea2(document.getElementById("choice-area"));
  }
  await runStatsScene2();
  if (save.pauseState) {
    const ps = save.pauseState;
    setPauseState(ps);
    setIp(ps.resumeIp);
    switch (ps.type) {
      case "page_break":
        showPageBreak2(ps.btnText, () => {
          clearPauseState();
          clearNarrative2();
          applyTransition2();
          runInterpreter2().catch((err) => console.error("[saves] runInterpreter error after page_break restore:", err));
        });
        break;
      case "input":
        showInputPrompt2(ps.varName, ps.prompt, (value) => {
          clearPauseState();
          if (Object.prototype.hasOwnProperty.call(tempState, ps.varName)) {
            tempState[ps.varName] = value;
          } else {
            playerState[ps.varName] = value;
          }
          setIp(ps.resumeIp);
          runInterpreter2().catch((err) => console.error("[saves] runInterpreter error after input restore:", err));
        });
        break;
      case "delay":
        clearPauseState();
        setIp(ps.resumeIp);
        runInterpreter2().catch((err) => console.error("[saves] runInterpreter error after delay restore:", err));
        break;
    }
    return;
  }
  if (save.awaitingChoice) {
    setAwaitingChoice(save.awaitingChoice);
    renderChoices2(save.awaitingChoice.choices);
    if (savedPoints > 0) showInlineLevelUp2();
  }
}

// engine/systems/skills.js
var skillRegistry = [];
async function parseSkills(fetchTextFileFn) {
  let text;
  try {
    text = await fetchTextFileFn("skills");
  } catch (err) {
    console.warn("[skills] skills.txt not found \u2014 skill system disabled.", err.message);
    skillRegistry = [];
    return;
  }
  const lines = text.split(/\r?\n/);
  const parsed = [];
  let current = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const m = trimmed.match(/^\*skill\s+([\w]+)\s+"([^"]+)"\s+(\d+)\s*$/);
    if (m) {
      if (current) parsed.push(current);
      current = {
        key: normalizeKey(m[1]),
        label: m[2],
        spCost: Number(m[3]),
        description: ""
      };
      continue;
    }
    if (current && raw.match(/^\s+/) && trimmed) {
      current.description += (current.description ? " " : "") + trimmed;
    }
  }
  if (current) parsed.push(current);
  skillRegistry = parsed;
  if (skillRegistry.length === 0) {
    console.warn("[skills] No *skill entries found in skills.txt.");
  }
}
function playerHasSkill(key) {
  const k = normalizeKey(key);
  return Array.isArray(playerState.skills) && playerState.skills.includes(k);
}
function grantSkill(key) {
  const k = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) playerState.skills = [];
  if (!playerState.skills.includes(k)) {
    playerState.skills.push(k);
  }
}
function revokeSkill(key) {
  const k = normalizeKey(key);
  if (!Array.isArray(playerState.skills)) return;
  const idx = playerState.skills.indexOf(k);
  if (idx === -1) {
    console.warn(`[skills] *revoke_skill: "${k}" not owned \u2014 nothing to remove.`);
    return;
  }
  playerState.skills.splice(idx, 1);
}
function purchaseSkill(key) {
  const k = normalizeKey(key);
  const entry = skillRegistry.find((s) => s.key === k);
  if (!entry) {
    console.warn(`[skills] purchaseSkill: "${k}" not found in skillRegistry.`);
    return false;
  }
  if (playerHasSkill(k)) {
    console.warn(`[skills] purchaseSkill: "${k}" already owned.`);
    return false;
  }
  const sp = Number(playerState.skill_points || 0);
  if (sp < entry.spCost) {
    console.warn(`[skills] purchaseSkill: not enough SP (have ${sp}, need ${entry.spCost}).`);
    return false;
  }
  playerState.skill_points = sp - entry.spCost;
  grantSkill(k);
  return true;
}

// engine/systems/journal.js
function addJournalEntry(text, type = "entry", unique = false) {
  if (!Array.isArray(playerState.journal)) playerState.journal = [];
  const normalised = text.trim();
  if (unique && playerState.journal.some((e) => e.text === normalised && e.type === type)) {
    return false;
  }
  playerState.journal.push({ text: normalised, type, timestamp: Date.now() });
  return true;
}
function getJournalEntries() {
  return Array.isArray(playerState.journal) ? playerState.journal : [];
}
function getAchievements() {
  return getJournalEntries().filter((e) => e.type === "achievement");
}

// engine/core/interpreter.js
var cb = {};
function registerCallbacks(callbacks) {
  Object.assign(cb, callbacks);
}
var _sceneCache = null;
var _labelsCache = null;
function registerCaches(sceneCache2, labelsCache2) {
  _sceneCache = sceneCache2;
  _labelsCache = labelsCache2;
}
function isDirective(trimmed, directive) {
  if (!trimmed.startsWith(directive)) return false;
  const rest = trimmed.slice(directive.length);
  return rest === "" || /\s/.test(rest[0]);
}
function findBlockEnd2(fromIndex, parentIndent) {
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
    if (!line.trimmed) {
      i += 1;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent === indent) {
      if (isDirective(line.trimmed, "*elseif")) {
        i = findBlockEnd2(i + 1, indent);
        continue;
      }
      if (isDirective(line.trimmed, "*else")) {
        i = findBlockEnd2(i + 1, indent);
        break;
      }
      break;
    }
    i += 1;
  }
  return i;
}
function evaluateCondition(raw) {
  const condition = raw.replace(/^\*if\s*/, "").replace(/^\*elseif\s*/, "").replace(/^\*loop\s*/, "").trim();
  return !!evalValue(condition);
}
async function executeBlock(start, end, resumeAfter = end) {
  setIp(start);
  while (ip < end) {
    await executeCurrentLine();
    if (awaitingChoice) {
      const ac = awaitingChoice;
      ac._blockEnd = end;
      ac._savedIp = resumeAfter;
      setAwaitingChoice(ac);
      return;
    }
    if (_gotoJumped) {
      setGotoJumped(false);
      return;
    }
  }
  setIp(resumeAfter);
}
async function gotoScene(name, label = null) {
  let text;
  try {
    text = await cb.fetchTextFile(name);
  } catch (err) {
    cb.showEngineError(`Could not load scene "${name}".
${err.message}`);
    return;
  }
  const prevChapterTitle = chapterTitle;
  clearTempState();
  setCurrentScene(name);
  setCurrentLines(parseLines(text));
  indexLabels(name, currentLines, _labelsCache);
  setIp(0);
  setDelayIndex(0);
  cb.clearNarrative();
  cb.applyTransition();
  if (label) {
    const labels = _labelsCache.get(name) || {};
    setIp(labels[label] ?? 0);
  }
  setAwaitingChoice(null);
  setGotoJumped(false);
  clearPauseState();
  await runInterpreter();
  if (chapterTitle === prevChapterTitle) {
    const fallback = name.replace(/\.txt$/i, "").toUpperCase();
    cb.setChapterTitle(fallback);
  }
}
async function runInterpreter() {
  while (ip < currentLines.length) {
    await executeCurrentLine();
    if (awaitingChoice) break;
  }
  if (pendingLevelUpDisplay) cb.showInlineLevelUp();
  cb.runStatsScene();
  if (cb.getNarrativeLog) {
    saveGameToSlot("auto", null, cb.getNarrativeLog());
  }
}
var commands = /* @__PURE__ */ new Map();
function registerCommand(directive, handler) {
  commands.set(directive, handler);
}
async function executeCurrentLine() {
  const line = currentLines[ip];
  if (!line) return;
  if (!line.trimmed || line.trimmed.startsWith("//")) {
    advanceIp();
    return;
  }
  const t = line.trimmed;
  if (!t.startsWith("*")) {
    cb.addParagraph(t);
    advanceIp();
    return;
  }
  for (const [directive, handler] of commands) {
    if (isDirective(t, directive)) {
      await handler(t, line);
      return;
    }
  }
  console.warn(`[interpreter] Unknown directive "${t.split(/\s/)[0]}" in "${currentScene}" at line ${ip} \u2014 skipping.`);
  advanceIp();
}
registerCommand("*title", (t) => {
  cb.setChapterTitle(t.replace(/^\*title\s*/, "").trim());
  advanceIp();
});
registerCommand("*label", () => {
  advanceIp();
});
registerCommand("*comment", () => {
  advanceIp();
});
registerCommand("*goto_scene", async (t) => {
  await gotoScene(t.replace(/^\*goto_scene\s*/, "").trim());
});
registerCommand("*goto", (t) => {
  const label = t.replace(/^\*goto\s*/, "").trim();
  const labels = _labelsCache.get(currentScene) || {};
  if (labels[label] === void 0) {
    cb.showEngineError(`Unknown label "${label}" in scene "${currentScene}".`);
    setIp(currentLines.length);
    return;
  }
  setIp(labels[label]);
  setGotoJumped(true);
});
registerCommand("*system", (t) => {
  if (t.trimEnd() === "*system") {
    const parsed = parseSystemBlock(ip, { currentLines });
    if (!parsed.ok) {
      cb.showEngineError(`Unclosed *system block in "${currentScene}". Add *end_system.`);
      setIp(currentLines.length);
      return;
    }
    cb.addSystem(parsed.text);
    setIp(parsed.endIp);
  } else {
    cb.addSystem(t.replace(/^\*system\s*/, "").trim());
    advanceIp();
  }
});
registerCommand("*set", (t) => {
  setVar(t, evalValue);
  advanceIp();
});
registerCommand("*set_stat", (t) => {
  setStatClamped(t, evalValue);
  advanceIp();
});
registerCommand("*create", (t) => {
  const m = t.match(/^\*create\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) {
    advanceIp();
    return;
  }
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);
  playerState[key] = evalValue(rhs);
  advanceIp();
});
registerCommand("*create_stat", (t) => {
  const m = t.match(/^\*create_stat\s+([a-zA-Z_][\w]*)\s+"([^"]+)"\s+(.+)$/);
  if (!m) {
    advanceIp();
    return;
  }
  const [, rawKey, label, rhs] = m;
  const key = normalizeKey(rawKey);
  const defaultVal = evalValue(rhs);
  playerState[key] = defaultVal;
  if (!statRegistry.find((e) => e.key === key)) {
    setStatRegistry([...statRegistry, { key, label, defaultVal }]);
  }
  advanceIp();
});
registerCommand("*temp", (t) => {
  declareTemp(t, evalValue);
  advanceIp();
});
registerCommand("*add_xp", (t) => {
  const n = Number(t.replace(/^\*add_xp\s*/, "").trim()) || 0;
  if (n > 0) {
    playerState.xp = Number(playerState.xp || 0) + n;
    checkAndApplyLevelUp(cb.scheduleStatsRender);
    cb.scheduleStatsRender();
  }
  advanceIp();
});
registerCommand("*add_item", (t) => {
  addInventoryItem(t.replace(/^\*add_item\s*/, "").trim());
  cb.scheduleStatsRender();
  advanceIp();
});
registerCommand("*remove_item", (t) => {
  removeInventoryItem(t.replace(/^\*remove_item\s*/, "").trim());
  cb.scheduleStatsRender();
  advanceIp();
});
registerCommand("*grant_skill", (t) => {
  grantSkill(t.replace(/^\*grant_skill\s*/, "").trim());
  cb.scheduleStatsRender();
  advanceIp();
});
registerCommand("*revoke_skill", (t) => {
  revokeSkill(t.replace(/^\*revoke_skill\s*/, "").trim());
  cb.scheduleStatsRender();
  advanceIp();
});
registerCommand("*if_skill", async (t, line) => {
  const key = normalizeKey(t.replace(/^\*if_skill\s*/, "").trim());
  const cond = playerHasSkill(key);
  if (cond) {
    const bs = ip + 1, be = findBlockEnd2(bs, line.indent);
    await executeBlock(bs, be);
  } else {
    setIp(findBlockEnd2(ip + 1, line.indent));
  }
});
registerCommand("*journal", (t) => {
  const text = t.replace(/^\*journal\s*/, "").trim();
  if (text) {
    addJournalEntry(text, "entry");
    cb.scheduleStatsRender();
  }
  advanceIp();
});
registerCommand("*achievement", (t) => {
  const text = t.replace(/^\*achievement\s*/, "").trim();
  if (text) {
    addJournalEntry(text, "achievement", true);
    cb.scheduleStatsRender();
  }
  advanceIp();
});
registerCommand("*session_set", (t) => {
  const m = t.match(/^\*session_set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) {
    advanceIp();
    return;
  }
  const key = normalizeKey(m[1]);
  patchSessionState({ [key]: evalValue(m[2]) });
  advanceIp();
});
registerCommand("*save_point", (t) => {
  const label = t.replace(/^\*save_point\s*/, "").trim() || null;
  if (cb.getNarrativeLog) saveGameToSlot("auto", label, cb.getNarrativeLog());
  advanceIp();
});
registerCommand("*page_break", (t) => {
  if (pauseState !== null) {
    console.warn(`[interpreter] *page_break fired while pauseState is already "${pauseState.type}" \u2014 overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }
  const btnText = t.replace(/^\*page_break\s*/, "").trim() || "Continue";
  const resumeIp = ip + 1;
  setPauseState({ type: "page_break", btnText, resumeIp });
  setIp(currentLines.length);
  cb.showPageBreak(btnText, () => {
    clearPauseState();
    cb.clearNarrative();
    setIp(resumeIp);
    runInterpreter().catch((err) => cb.showEngineError(err.message));
  });
});
registerCommand("*delay", (t) => {
  if (pauseState !== null) {
    console.warn(`[interpreter] *delay fired while pauseState is already "${pauseState.type}" \u2014 overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }
  const ms = Number(t.replace(/^\*delay\s*/, "").trim()) || 500;
  const resumeIp = ip + 1;
  setPauseState({ type: "delay", ms, resumeIp });
  setIp(currentLines.length);
  setTimeout(() => {
    clearPauseState();
    setIp(resumeIp);
    runInterpreter().catch((err) => cb.showEngineError(err.message));
  }, ms);
});
registerCommand("*input", (t) => {
  const m = t.match(/^\*input\s+([a-zA-Z_][\w]*)\s+"([^"]+)"$/);
  if (!m) {
    cb.showEngineError(`*input requires: *input varName "Prompt text"
Got: ${t}`);
    setIp(currentLines.length);
    return;
  }
  if (pauseState !== null) {
    console.warn(`[interpreter] *input fired while pauseState is already "${pauseState.type}" \u2014 overwriting. Check scene "${currentScene}" near line ${ip}.`);
  }
  const varName = normalizeKey(m[1]);
  const prompt = m[2];
  const resumeIp = ip + 1;
  setPauseState({ type: "input", varName, prompt, resumeIp });
  setIp(currentLines.length);
  cb.showInputPrompt(varName, prompt, (value) => {
    clearPauseState();
    if (Object.prototype.hasOwnProperty.call(tempState, varName)) {
      tempState[varName] = value;
    } else {
      playerState[varName] = value;
    }
    setIp(resumeIp);
    runInterpreter().catch((err) => cb.showEngineError(err.message));
  });
});
registerCommand("*choice", (t, line) => {
  const parsed = parseChoice(ip, line.indent, {
    currentLines,
    evalValue,
    showEngineError: cb.showEngineError
    // FIX #1: wire up the BUG-06 callback
  });
  if (parsed.choices.length === 0) {
    cb.showEngineError(`*choice at line ${ip} in "${currentScene}" produced no options. Check for missing or malformed # lines.`);
    setIp(currentLines.length);
    return;
  }
  setAwaitingChoice({ end: parsed.end, choices: parsed.choices });
  cb.renderChoices(parsed.choices);
});
registerCommand("*ending", (t) => {
  const args = [...t.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const title = args[0] ?? "The End";
  const content = args[1] ?? "Your path is complete.";
  cb.showEndingScreen(title, content);
  setIp(currentLines.length);
});
registerCommand("*if", async (t, line) => {
  const chainEnd = findIfChainEnd(ip, line.indent);
  let cursor = ip, executed = false;
  while (cursor < chainEnd) {
    const c = currentLines[cursor];
    if (!c.trimmed) {
      cursor += 1;
      continue;
    }
    if (isDirective(c.trimmed, "*if") || isDirective(c.trimmed, "*elseif")) {
      const bs = cursor + 1, be = findBlockEnd2(bs, c.indent);
      if (!executed && evaluateCondition(c.trimmed)) {
        await executeBlock(bs, be, chainEnd);
        executed = true;
        if (awaitingChoice) return;
      }
      cursor = be;
      continue;
    }
    if (isDirective(c.trimmed, "*else")) {
      const bs = cursor + 1, be = findBlockEnd2(bs, c.indent);
      if (!executed) {
        await executeBlock(bs, be, chainEnd);
        if (awaitingChoice) return;
      }
      cursor = be;
      continue;
    }
    cursor += 1;
  }
  setIp(chainEnd);
});
registerCommand("*loop", async (t, line) => {
  const LOOP_GUARD = 1e4;
  const blockStart = ip + 1, blockEnd = findBlockEnd2(blockStart, line.indent);
  let guard = 0;
  while (evaluateCondition(t) && guard < LOOP_GUARD) {
    await executeBlock(blockStart, blockEnd);
    if (awaitingChoice) return;
    if (_gotoJumped) {
      setGotoJumped(false);
      return;
    }
    guard += 1;
  }
  if (guard >= LOOP_GUARD) {
    cb.showEngineError(`*loop guard tripped in scene "${currentScene}" after ${LOOP_GUARD} iterations \u2014 possible infinite loop. Check that the loop condition can become false.`);
  }
  setIp(blockEnd);
});
registerCommand("*patch_state", (t) => {
  const m = t.match(/^\*patch_state\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) {
    advanceIp();
    return;
  }
  patchPlayerState({ [normalizeKey(m[1])]: evalValue(m[2]) });
  advanceIp();
});

// engine/ui/narrative.js
function escapeHtml(val) {
  return String(val ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var _narrativeContent = null;
var _choiceArea = null;
var _narrativePanel = null;
var _onShowLevelUp = null;
var _scheduleStats = null;
var _onBeforeChoice = null;
var _executeBlock = null;
var _runInterpreter = null;
function init({
  narrativeContent,
  choiceArea,
  narrativePanel,
  onShowLevelUp,
  scheduleStatsRender: scheduleStatsRender2,
  onBeforeChoice,
  executeBlock: executeBlock2,
  runInterpreter: runInterpreter2
}) {
  _narrativeContent = narrativeContent;
  _choiceArea = choiceArea;
  _narrativePanel = narrativePanel;
  _onShowLevelUp = onShowLevelUp || (() => {
  });
  _scheduleStats = scheduleStatsRender2 || (() => {
  });
  _onBeforeChoice = onBeforeChoice || (() => {
  });
  _executeBlock = executeBlock2 || null;
  _runInterpreter = runInterpreter2 || null;
}
function setChoiceArea(el) {
  _choiceArea = el;
}
var _narrativeLog = [];
function getNarrativeLog() {
  return _narrativeLog;
}
function pushNarrativeLogEntry(e) {
  _narrativeLog.push(e);
}
function renderFromLog(log, { skipAnimations = true } = {}) {
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = "";
  _narrativeContent.scrollTop = 0;
  if (skipAnimations) setDelayIndex(0);
  for (const entry of log) {
    switch (entry.type) {
      case "paragraph": {
        const p = document.createElement("p");
        p.className = "narrative-paragraph";
        if (skipAnimations) {
          p.style.opacity = "1";
          p.style.transform = "none";
          p.style.animation = "none";
        } else {
          p.style.animationDelay = `${delayIndex * 80}ms`;
        }
        p.innerHTML = formatText(entry.text);
        _narrativeContent.insertBefore(p, _choiceArea);
        if (!skipAnimations) advanceDelayIndex();
        break;
      }
      case "system": {
        const div = document.createElement("div");
        const isXP = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(entry.text);
        const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(entry.text);
        div.className = `system-block${isXP ? " xp-block" : ""}${isLevelUp ? " levelup-block" : ""}`;
        if (skipAnimations) {
          div.style.opacity = "1";
          div.style.transform = "none";
          div.style.animation = "none";
        } else {
          div.style.animationDelay = `${delayIndex * 80}ms`;
        }
        const formatted = formatText(entry.text).replace(/\\n/g, "\n").replace(/\n/g, "<br>");
        div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
        _narrativeContent.insertBefore(div, _choiceArea);
        if (!skipAnimations) advanceDelayIndex();
        break;
      }
      case "input": {
        const wrapper = document.createElement("div");
        wrapper.className = "input-prompt-block input-prompt-block--submitted";
        if (skipAnimations) {
          wrapper.style.opacity = "1";
          wrapper.style.animation = "none";
        }
        const safe = escapeHtml(entry.value ?? "");
        wrapper.innerHTML = `<span class="system-block-label">[ INPUT ]</span><span class="system-block-text">${formatText(entry.prompt)}: <strong>${safe}</strong></span>`;
        _narrativeContent.insertBefore(wrapper, _choiceArea);
        break;
      }
      case "levelup_confirmed": {
        const block = document.createElement("div");
        block.className = "system-block levelup-inline-block levelup-inline-block--confirmed";
        if (skipAnimations) {
          block.style.opacity = "0.55";
          block.style.animation = "none";
        }
        block.innerHTML = `<span class="system-block-label">[ LEVEL UP ]</span><span class="system-block-text levelup-confirmed-text">Level ${entry.level} reached \u2014 stats allocated.</span>`;
        _narrativeContent.insertBefore(block, _choiceArea);
        break;
      }
    }
  }
  _narrativeLog = Array.isArray(log) ? [...log] : [];
}
function resolvePronoun(lower, isCapital) {
  const pronouns = playerState.pronouns || "they/them";
  const map = {
    "he/him": { they: "he", them: "him", their: "his", themself: "himself" },
    "she/her": { they: "she", them: "her", their: "her", themself: "herself" },
    "they/them": { they: "they", them: "them", their: "their", themself: "themself" }
  };
  const set = map[pronouns] || map["they/them"];
  const word = set[lower] || lower;
  return isCapital ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}
function formatText(text) {
  if (!text) return "";
  let result = String(text);
  result = result.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k = normalizeKey(v);
    const val = tempState[k] !== void 0 ? tempState[k] : playerState[k] ?? "";
    return escapeHtml(val);
  });
  result = result.replace(
    /\{(They|Them|Their|Themself|they|them|their|themself)\}/g,
    (_, token) => {
      const lower = token.toLowerCase();
      const isCapital = token.charCodeAt(0) >= 65 && token.charCodeAt(0) <= 90;
      return resolvePronoun(lower, isCapital);
    }
  );
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return result;
}
function addParagraph(text, cls = "narrative-paragraph") {
  const p = document.createElement("p");
  p.className = cls;
  p.style.animationDelay = `${delayIndex * 80}ms`;
  p.innerHTML = formatText(text);
  advanceDelayIndex();
  _narrativeContent.insertBefore(p, _choiceArea);
  _narrativeLog.push({ type: "paragraph", text });
}
function addSystem(text) {
  applySystemRewards(text, _scheduleStats);
  const div = document.createElement("div");
  const isXP = /XP\s+gained|bonus\s+XP|\+\d+\s+XP/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isXP ? " xp-block" : ""}${isLevelUp ? " levelup-block" : ""}`;
  div.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();
  const formatted = formatText(text).replace(/\\n/g, "\n").replace(/\n/g, "<br>");
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  _narrativeContent.insertBefore(div, _choiceArea);
  _narrativeLog.push({ type: "system", text });
  if (pendingLevelUpDisplay) _onShowLevelUp();
}
function clearNarrative() {
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = "";
  setDelayIndex(0);
  _narrativeContent.scrollTop = 0;
  _narrativeLog = [];
}
function applyTransition() {
  _narrativePanel.classList.add("transitioning");
  setTimeout(() => _narrativePanel.classList.remove("transitioning"), 220);
}
function renderChoices(choices) {
  if (pendingLevelUpDisplay) _onShowLevelUp();
  const levelUpActive = pendingStatPoints > 0;
  _choiceArea.innerHTML = "";
  choices.forEach((choice, idx) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.style.animationDelay = `${(delayIndex + idx) * 80}ms`;
    btn.innerHTML = `<span>${formatText(choice.text)}</span>`;
    if (choice.statTag) {
      const { label, requirement } = choice.statTag;
      const key = normalizeKey(label.replace(/\s+/g, "_"));
      const val = tempState[key] !== void 0 ? tempState[key] : playerState[key] !== void 0 ? playerState[key] : null;
      const met = val !== null && Number(val) >= requirement;
      const badge = document.createElement("span");
      badge.className = `choice-stat-badge ${met ? "choice-stat-badge--met" : "choice-stat-badge--unmet"}`;
      badge.textContent = `${label} ${requirement}`;
      btn.appendChild(badge);
    }
    if (!choice.selectable) {
      btn.disabled = true;
      btn.classList.add("choice-btn--disabled");
      btn.dataset.unselectable = "true";
    } else if (levelUpActive) {
      btn.disabled = true;
      btn.classList.add("choice-btn--disabled");
    } else {
      btn.addEventListener("click", () => {
        _onBeforeChoice();
        btn.disabled = true;
        _choiceArea.querySelectorAll(".choice-btn").forEach((b) => {
          b.disabled = true;
        });
        const choiceBlockEnd = awaitingChoice?.end ?? choice.end;
        const savedIp = awaitingChoice?._savedIp ?? choiceBlockEnd;
        setAwaitingChoice(null);
        _executeBlock(choice.start, choice.end, savedIp).then(() => _runInterpreter()).catch((err) => console.error("[narrative] choice execution error:", err));
      });
    }
    _choiceArea.appendChild(btn);
  });
}
function showInputPrompt(varName, prompt, onSubmit) {
  const logEntry = { type: "input", varName, prompt, value: null };
  _narrativeLog.push(logEntry);
  const wrapper = document.createElement("div");
  wrapper.className = "input-prompt-block";
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
  const field = wrapper.querySelector(".input-prompt-field");
  const submit = wrapper.querySelector(".input-prompt-submit");
  field.addEventListener("input", () => {
    submit.disabled = !field.value.trim();
  });
  function doSubmit() {
    const value = field.value.trim();
    if (!value) return;
    field.disabled = true;
    submit.disabled = true;
    wrapper.classList.add("input-prompt-block--submitted");
    const safe = escapeHtml(value);
    wrapper.innerHTML = `<span class="system-block-label">[ INPUT ]</span><span class="system-block-text">${formatText(prompt)}: <strong>${safe}</strong></span>`;
    logEntry.value = value;
    onSubmit(value);
  }
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSubmit();
  });
  submit.addEventListener("click", doSubmit);
  requestAnimationFrame(() => {
    try {
      field.focus();
    } catch (_) {
    }
  });
}
function showPageBreak(btnText, onContinue) {
  const btn = document.createElement("button");
  btn.className = "choice-btn page-break-btn";
  btn.textContent = btnText || "Continue";
  btn.addEventListener("click", () => {
    btn.disabled = true;
    onContinue();
  });
  _choiceArea.appendChild(btn);
}

// engine/ui/panels.js
var _narrativeContent2 = null;
var _choiceArea2 = null;
var _statusPanel = null;
var _endingOverlay = null;
var _endingTitle = null;
var _endingContent = null;
var _endingStats = null;
var _endingActionBtn = null;
var _fetchTextFile = null;
var _scheduleStats2 = null;
var _trapFocus = null;
var _onLevelUpConfirmed = null;
function init2({
  narrativeContent,
  choiceArea,
  statusPanel,
  endingOverlay,
  endingTitle,
  endingContent,
  endingStats,
  endingActionBtn,
  fetchTextFile: fetchTextFile2,
  scheduleStatsRender: scheduleStatsRender2,
  trapFocus: trapFocus2,
  onLevelUpConfirmed
}) {
  _narrativeContent2 = narrativeContent;
  _choiceArea2 = choiceArea;
  _statusPanel = statusPanel;
  _endingOverlay = endingOverlay;
  _endingTitle = endingTitle;
  _endingContent = endingContent;
  _endingStats = endingStats;
  _endingActionBtn = endingActionBtn;
  _fetchTextFile = fetchTextFile2;
  _scheduleStats2 = scheduleStatsRender2;
  _trapFocus = trapFocus2;
  _onLevelUpConfirmed = onLevelUpConfirmed || null;
}
var styleState = { colors: {}, icons: {} };
async function runStatsScene() {
  const text = await _fetchTextFile("stats");
  const lines = text.split(/\r?\n/).map((raw) => ({ raw, trimmed: raw.trim() }));
  let html = "";
  styleState.colors = {};
  styleState.icons = {};
  const entries = [];
  lines.forEach((line) => {
    const t = line.trimmed;
    if (!t || t.startsWith("//")) return;
    if (t.startsWith("*stat_group")) {
      const sgm = t.match(/^\*stat_group\s+"([^"]+)"/);
      entries.push({ type: "group", name: sgm ? sgm[1] : t.replace(/^\*stat_group\s*/, "").trim() });
    } else if (t.startsWith("*stat_color")) {
      const [, rawKey, color] = t.split(/\s+/);
      styleState.colors[normalizeKey(rawKey)] = color;
    } else if (t.startsWith("*stat_icon")) {
      const m = t.match(/^\*stat_icon\s+([\w_]+)\s+"(.+)"$/);
      if (m) styleState.icons[normalizeKey(m[1])] = m[2];
    } else if (t.startsWith("*inventory")) {
      entries.push({ type: "inventory" });
    } else if (t.trim() === "*skills_registered") {
      entries.push({ type: "skills" });
    } else if (t.trim() === "*journal_section") {
      entries.push({ type: "journal" });
    } else if (t.trim() === "*achievements") {
      entries.push({ type: "achievements" });
    } else if (t === "*stat_registered") {
      statRegistry.forEach(({ key, label }) => entries.push({ type: "stat", key, label }));
    } else if (t.startsWith("*stat")) {
      const m = t.match(/^\*stat\s+([\w_]+)\s+"(.+)"$/);
      if (m) entries.push({ type: "stat", key: normalizeKey(m[1]), label: m[2] });
    }
  });
  let inGroup = false;
  entries.forEach((e) => {
    if (e.type === "group") {
      if (inGroup) html += `</div>`;
      html += `<div class="status-section"><div class="status-label status-section-header">${escapeHtml(e.name)}</div>`;
      inGroup = true;
    }
    if (e.type === "stat") {
      const cc = styleState.colors[e.key] || "";
      const ic = styleState.icons[e.key] ?? "";
      const rawVal = playerState[e.key] ?? "\u2014";
      html += `<div class="status-row"><span class="status-label">${ic ? ic + " " : ""}${escapeHtml(e.label)}</span><span class="status-value ${cc}">${escapeHtml(rawVal)}</span></div>`;
    }
    if (e.type === "inventory") {
      if (inGroup) {
        html += `</div>`;
        inGroup = false;
      }
      const items = Array.isArray(playerState.inventory) && playerState.inventory.length ? playerState.inventory.map((i) => `<li>${escapeHtml(i)}</li>`).join("") : '<li class="tag-empty">Empty</li>';
      html += `<div class="status-section"><div class="status-label status-section-header">Inventory</div><ul class="tag-list">${items}</ul></div>`;
    }
    if (e.type === "skills") {
      if (inGroup) {
        html += `</div>`;
        inGroup = false;
      }
      const owned = Array.isArray(playerState.skills) ? playerState.skills : [];
      if (owned.length === 0 && skillRegistry.length === 0) {
      } else {
        const skillItems = owned.length ? owned.map((k) => {
          const entry = skillRegistry.find((s) => s.key === k);
          const label = escapeHtml(entry ? entry.label : k);
          const desc = escapeHtml(entry ? entry.description : "");
          return `<li class="skill-accordion"><button class="skill-accordion-btn" data-skill-key="${escapeHtml(k)}"><span class="skill-accordion-name">${label}</span><span class="skill-accordion-chevron">\u25BE</span></button><div class="skill-accordion-desc" style="display:none;">${desc}</div></li>`;
        }).join("") : '<li class="tag-empty">No skills learned</li>';
        html += `<div class="status-section"><div class="status-label status-section-header">Skills</div><ul class="skill-accordion-list">${skillItems}</ul></div>`;
      }
    }
    if (e.type === "achievements") {
      if (inGroup) {
        html += `</div>`;
        inGroup = false;
      }
      const achvs = getAchievements();
      if (achvs.length > 0) {
        const items = achvs.map((a) => `<li class="journal-entry journal-entry--achievement"><span class="journal-achievement-icon">\u25C6</span> ${escapeHtml(a.text)}</li>`).join("");
        html += `<div class="status-section"><div class="status-label status-section-header">Achievements</div><ul class="journal-list">${items}</ul></div>`;
      }
    }
    if (e.type === "journal") {
      if (inGroup) {
        html += `</div>`;
        inGroup = false;
      }
      const jentries = getJournalEntries();
      if (jentries.length > 0) {
        const items = [...jentries].reverse().map((j) => {
          const cls = j.type === "achievement" ? "journal-entry journal-entry--achievement" : "journal-entry";
          const prefix = j.type === "achievement" ? '<span class="journal-achievement-icon">\u25C6</span> ' : "";
          return `<li class="${cls}">${prefix}${escapeHtml(j.text)}</li>`;
        }).join("");
        html += `<div class="status-section"><div class="status-label status-section-header">Journal</div><ul class="journal-list">${items}</ul></div>`;
      }
    }
  });
  if (inGroup) html += `</div>`;
  _statusPanel.innerHTML = html;
  _statusPanel.querySelectorAll(".skill-accordion-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const desc = btn.nextElementSibling;
      const isOpen = desc.style.display !== "none";
      desc.style.display = isOpen ? "none" : "block";
      btn.classList.toggle("skill-accordion-btn--open", !isOpen);
    });
  });
}
function showInlineLevelUp() {
  if (pendingStatPoints <= 0) {
    setPendingLevelUpDisplay(false);
    return;
  }
  setPendingLevelUpDisplay(false);
  const keys = getAllocatableStatKeys();
  const labelMap = {};
  statRegistry.forEach(({ key, label }) => {
    labelMap[key] = label;
  });
  const alloc = {};
  keys.forEach((k) => {
    alloc[k] = 0;
  });
  const block = document.createElement("div");
  block.className = "levelup-inline-block";
  block.style.animationDelay = `${delayIndex * 80}ms`;
  advanceDelayIndex();
  _narrativeContent2.insertBefore(block, _choiceArea2);
  let skillBrowserOpen = false;
  function buildSkillBrowserHTML() {
    const available = skillRegistry.filter((s) => !playerHasSkill(s.key));
    const owned = skillRegistry.filter((s) => playerHasSkill(s.key));
    let html = `<div class="skill-browser">`;
    if (available.length) {
      html += `<div class="skill-browser-section-label">Available</div>`;
      available.forEach((s) => {
        const canAfford = playerState.skill_points >= s.spCost;
        html += `
          <div class="skill-browser-card ${canAfford ? "skill-browser-card--available" : "skill-browser-card--unaffordable"}">
            <div class="skill-browser-card-top">
              <span class="skill-browser-card-name">${escapeHtml(s.label)}</span>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-sp-badge ${canAfford ? "skill-browser-sp-badge--can-afford" : ""}">${s.spCost} SP</span>
                <button class="skill-purchase-btn" data-purchase-key="${escapeHtml(s.key)}" ${canAfford ? "" : "disabled"}>Unlock</button>
              </div>
            </div>
            <div class="skill-browser-card-desc">${escapeHtml(s.description)}</div>
          </div>`;
      });
    }
    if (owned.length) {
      html += `<div class="skill-browser-section-label skill-browser-section-label--owned">Learned</div>`;
      owned.forEach((s) => {
        html += `
          <div class="skill-browser-card skill-browser-card--owned">
            <div class="skill-browser-card-top">
              <span class="skill-browser-card-name">${escapeHtml(s.label)}</span>
              <div class="skill-browser-card-actions">
                <span class="skill-browser-owned-badge">\u2713 Learned</span>
              </div>
            </div>
            <div class="skill-browser-card-desc">${escapeHtml(s.description)}</div>
          </div>`;
      });
    }
    if (!available.length && !owned.length) {
      html += `<div class="skill-browser-empty">No skills defined.</div>`;
    }
    html += `</div>`;
    return html;
  }
  const render = () => {
    const spent = Object.values(alloc).reduce((a, b) => a + b, 0);
    const remain = pendingStatPoints - spent;
    const allSpent = remain === 0;
    const hasSkills = skillRegistry.length > 0;
    block.innerHTML = `
      <span class="system-block-label">[ LEVEL UP ]</span>
      <div class="levelup-inline-header">
        Reached <strong>Level ${playerState.level}</strong>
        <span class="levelup-points-remaining">${remain} point${remain !== 1 ? "s" : ""} remaining</span>
      </div>
      <div class="stat-alloc-grid">
        ${keys.map((k) => `
          <div class="stat-alloc-item ${alloc[k] ? "selected" : ""}">
            <span class="stat-alloc-name">${escapeHtml(labelMap[k] || k)}</span>
            <div style="display:flex;justify-content:center;gap:8px;align-items:center;">
              <button class="alloc-btn" data-op="minus" data-k="${k}" ${alloc[k] <= 0 ? "disabled" : ""}>\u2212</button>
              <span class="stat-alloc-val ${alloc[k] ? "buffed" : ""}">${Number(playerState[k] || 0) + alloc[k]}</span>
              <button class="alloc-btn" data-op="plus"  data-k="${k}" ${remain <= 0 ? "disabled" : ""}>+</button>
            </div>
          </div>
        `).join("")}
      </div>
      ${skillBrowserOpen ? buildSkillBrowserHTML() : ""}
      <div class="levelup-inline-footer" style="display:flex;gap:10px;justify-content:flex-end;align-items:center;flex-wrap:wrap;">
        ${hasSkills ? `<button class="skill-browse-btn" data-toggle-skills>${skillBrowserOpen ? "Hide Skills" : "Browse Skills"}</button>` : ""}
        <button class="levelup-confirm-btn ${allSpent ? "" : "levelup-confirm-btn--locked"}" ${allSpent ? "" : "disabled"}>Confirm</button>
      </div>`;
    block.querySelectorAll(".alloc-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.k;
        const op = btn.dataset.op;
        if (op === "plus" && remain > 0) alloc[k]++;
        if (op === "minus" && alloc[k] > 0) alloc[k]--;
        render();
      });
    });
    block.querySelector("[data-toggle-skills]")?.addEventListener("click", () => {
      skillBrowserOpen = !skillBrowserOpen;
      render();
    });
    block.querySelectorAll(".skill-purchase-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.purchaseKey;
        if (purchaseSkill(key)) {
          _scheduleStats2();
          render();
        }
      });
    });
    block.querySelector(".levelup-confirm-btn")?.addEventListener("click", () => {
      if (remain > 0) return;
      keys.forEach((k) => {
        if (alloc[k]) playerState[k] = Number(playerState[k] || 0) + alloc[k];
      });
      setPendingStatPoints(pendingStatPoints - Object.values(alloc).reduce((a, b) => a + b, 0));
      _scheduleStats2();
      block.classList.add("levelup-inline-block--confirmed");
      block.innerHTML = `<span class="system-block-label">[ LEVEL UP ]</span><span class="system-block-text levelup-confirmed-text">Level ${playerState.level} reached \u2014 stats allocated.</span>`;
      block.style.opacity = "0.55";
      if (_onLevelUpConfirmed) _onLevelUpConfirmed(playerState.level);
      _choiceArea2.querySelectorAll(".choice-btn").forEach((b) => {
        if (b.dataset.unselectable !== "true") {
          b.disabled = false;
          b.classList.remove("choice-btn--disabled");
        }
      });
    });
  };
  render();
}
function showEndingScreen(title, content) {
  if (!_endingOverlay) return;
  _endingTitle.textContent = title;
  _endingContent.textContent = content;
  const statsLines = [];
  statRegistry.forEach(({ key, label }) => {
    statsLines.push(`${label}: ${playerState[key] ?? "\u2014"}`);
  });
  _endingStats.textContent = statsLines.join("  \xB7  ");
  _endingOverlay.classList.remove("hidden");
  _endingOverlay.style.opacity = "1";
  if (_trapFocus) {
    const release = _trapFocus(_endingOverlay, null);
    _endingOverlay._trapRelease = release;
  }
  _endingActionBtn?.addEventListener("click", () => {
    window.location.reload();
  }, { once: true });
}

// engine/ui/overlays.js
var _splashOverlay = null;
var _splashSlots = null;
var _saveOverlay = null;
var _saveBtn = null;
var _charOverlay = null;
var _inputFirstName = null;
var _inputLastName = null;
var _counterFirst = null;
var _counterLast = null;
var _errorFirstName = null;
var _errorLastName = null;
var _charBeginBtn = null;
var _toast = null;
var _runStatsScene = null;
var _fetchTextFile2 = null;
var _evalValue = null;
var _renderFromLog = null;
var _renderChoices = null;
var _showInlineLevelUp = null;
var _showPageBreak = null;
var _showInputPrompt = null;
var _runInterpreter2 = null;
var _clearNarrative = null;
var _applyTransition = null;
var _setChapterTitle = null;
var _parseAndCacheScene = null;
var _clearUndoStack = null;
var _setChoiceArea = null;
function init3({
  splashOverlay,
  splashSlots,
  saveOverlay,
  saveBtn,
  charOverlay,
  inputFirstName,
  inputLastName,
  counterFirst,
  counterLast,
  errorFirstName,
  errorLastName,
  charBeginBtn,
  toast,
  runStatsScene: runStatsScene2,
  fetchTextFile: fetchTextFile2,
  evalValue: evalValue2,
  // Callbacks needed by the no-replay restoreFromSave:
  renderFromLog: renderFromLog2,
  renderChoices: renderChoices2,
  showInlineLevelUp: showInlineLevelUp2,
  showPageBreak: showPageBreak2,
  showInputPrompt: showInputPrompt2,
  runInterpreter: runInterpreter2,
  clearNarrative: clearNarrative2,
  applyTransition: applyTransition2,
  setChapterTitle,
  parseAndCacheScene,
  setChoiceArea: setChoiceArea2,
  // BUG-05: added setChoiceArea
  clearUndoStack
}) {
  _splashOverlay = splashOverlay;
  _splashSlots = splashSlots;
  _saveOverlay = saveOverlay;
  _saveBtn = saveBtn;
  _charOverlay = charOverlay;
  _inputFirstName = inputFirstName;
  _inputLastName = inputLastName;
  _counterFirst = counterFirst;
  _counterLast = counterLast;
  _errorFirstName = errorFirstName;
  _errorLastName = errorLastName;
  _charBeginBtn = charBeginBtn;
  _toast = toast;
  _runStatsScene = runStatsScene2;
  _fetchTextFile2 = fetchTextFile2;
  _evalValue = evalValue2;
  _renderFromLog = renderFromLog2;
  _renderChoices = renderChoices2;
  _showInlineLevelUp = showInlineLevelUp2;
  _showPageBreak = showPageBreak2;
  _showInputPrompt = showInputPrompt2;
  _runInterpreter2 = runInterpreter2;
  _clearNarrative = clearNarrative2;
  _applyTransition = applyTransition2;
  _setChapterTitle = setChapterTitle;
  _parseAndCacheScene = parseAndCacheScene;
  _clearUndoStack = clearUndoStack || null;
  _setChoiceArea = setChoiceArea2 || null;
}
function trapFocus(overlayEl, triggerEl = null) {
  const FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])'
  ].join(",");
  function getFocusable() {
    try {
      return [...overlayEl.querySelectorAll(FOCUSABLE)].filter(
        (el) => !el.closest("[hidden]") && getComputedStyle(el).display !== "none"
      );
    } catch (_) {
      return [];
    }
  }
  function handleKeydown(e) {
    if (e.key !== "Tab") return;
    const focusable = getFocusable();
    if (!focusable.length) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
  overlayEl.addEventListener("keydown", handleKeydown);
  requestAnimationFrame(() => {
    try {
      const focusable = getFocusable();
      if (focusable.length) focusable[0].focus();
    } catch (_) {
    }
  });
  return function release() {
    try {
      overlayEl.removeEventListener("keydown", handleKeydown);
    } catch (_) {
    }
    try {
      if (triggerEl && typeof triggerEl.focus === "function") triggerEl.focus();
    } catch (_) {
    }
  };
}
var _toastTimer = null;
function showToast(message, durationMs = 2200) {
  _toast.textContent = message;
  _toast.classList.remove("hidden", "toast-hide");
  _toast.classList.add("toast-show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    _toast.classList.replace("toast-show", "toast-hide");
    setTimeout(() => _toast.classList.add("hidden"), 300);
  }, durationMs);
}
function populateSlotCard({ nameEl, metaEl, loadBtn, deleteBtn, cardEl, save }) {
  if (save) {
    const d = new Date(save.timestamp);
    const sceneDisplay = save.label ? save.label : save.scene.toUpperCase();
    metaEl.textContent = `${sceneDisplay} \xB7 ${d.toLocaleDateString(void 0, { month: "short", day: "numeric", year: "numeric" })}`;
    nameEl.textContent = save.characterName || "Unknown";
    loadBtn.disabled = false;
    cardEl.classList.remove("slot-card--empty");
    if (deleteBtn) deleteBtn.classList.remove("hidden");
  } else {
    nameEl.textContent = "\u2014 Empty \u2014";
    metaEl.textContent = "";
    loadBtn.disabled = true;
    cardEl.classList.add("slot-card--empty");
    if (deleteBtn) deleteBtn.classList.add("hidden");
  }
}
function refreshAllSlotCards() {
  ["auto", 1, 2, 3].forEach((slot) => {
    const save = loadSaveFromSlot(slot);
    const s = String(slot);
    const sCard = document.getElementById(`slot-card-${s}`);
    if (sCard) populateSlotCard({
      nameEl: document.getElementById(`slot-name-${s}`),
      metaEl: document.getElementById(`slot-meta-${s}`),
      loadBtn: document.getElementById(`slot-load-${s}`),
      deleteBtn: document.getElementById(`slot-delete-${s}`),
      cardEl: sCard,
      save
    });
    const iCard = document.getElementById(`save-card-${s}`);
    if (iCard) {
      populateSlotCard({
        nameEl: document.getElementById(`save-slot-name-${s}`),
        metaEl: document.getElementById(`save-slot-meta-${s}`),
        loadBtn: document.getElementById(`ingame-load-${s}`),
        deleteBtn: document.getElementById(`save-delete-${s}`),
        cardEl: iCard,
        save
      });
    }
    const ingameLoad = document.getElementById(`ingame-load-${s}`);
    if (ingameLoad) ingameLoad.disabled = !save;
  });
}
async function loadAndResume(save) {
  _saveBtn.classList.remove("hidden");
  const undoBtn = document.getElementById("undo-btn");
  if (undoBtn) undoBtn.classList.remove("hidden");
  if (_clearUndoStack) _clearUndoStack();
  await restoreFromSave(save, {
    runStatsScene: _runStatsScene,
    renderFromLog: _renderFromLog,
    renderChoices: _renderChoices,
    showInlineLevelUp: _showInlineLevelUp,
    showPageBreak: _showPageBreak,
    showInputPrompt: _showInputPrompt,
    runInterpreter: _runInterpreter2,
    clearNarrative: _clearNarrative,
    applyTransition: _applyTransition,
    setChapterTitle: _setChapterTitle,
    setChoiceArea: _setChoiceArea,
    // BUG-05 fix
    parseAndCacheScene: _parseAndCacheScene,
    fetchTextFileFn: _fetchTextFile2,
    evalValueFn: _evalValue
  });
}
function showSplash() {
  ["auto", 1, 2, 3].forEach(loadSaveFromSlot);
  refreshAllSlotCards();
  const notice = document.getElementById("splash-stale-notice");
  if (notice) {
    if (_staleSaveFound) {
      notice.classList.remove("hidden");
      clearStaleSaveFound();
    } else {
      notice.classList.add("hidden");
    }
  }
  _splashOverlay.classList.remove("hidden");
  _splashOverlay.style.opacity = "1";
  _splashSlots.classList.add("hidden");
  _splashOverlay.querySelector(".splash-btn-col")?.classList.remove("hidden");
}
function hideSplash() {
  _splashOverlay.classList.add("hidden");
}
var _saveTrapRelease = null;
function showSaveMenu() {
  refreshAllSlotCards();
  _saveOverlay.classList.remove("hidden");
  _saveOverlay.style.opacity = "1";
  _saveTrapRelease = trapFocus(_saveOverlay, _saveBtn);
}
function hideSaveMenu() {
  _saveOverlay.classList.add("hidden");
  if (_saveTrapRelease) {
    _saveTrapRelease();
    _saveTrapRelease = null;
  }
}
var NAME_MAX = 14;
var NAME_REGEX = /^[\p{L}\p{M}'\- ]*$/u;
function validateName(value, label) {
  const t = value.trim();
  if (!t) return `${label} cannot be empty.`;
  if (t.length > NAME_MAX) return `${label} must be ${NAME_MAX} characters or fewer.`;
  if (!NAME_REGEX.test(t)) return `${label} may only contain letters, hyphens, and apostrophes.`;
  if (/\s{2,}/.test(t)) return `${label} cannot contain consecutive spaces.`;
  if (/\-{2,}/.test(t)) return `${label} cannot contain consecutive hyphens.`;
  return null;
}
function wireCharCreation() {
  function handleInput(inputEl, counterEl, errorEl, fieldLabel) {
    const cleaned = inputEl.value.replace(/[^\p{L}\p{M}'\- ]/gu, "");
    if (cleaned !== inputEl.value) {
      const pos = inputEl.selectionStart - (inputEl.value.length - cleaned.length);
      inputEl.value = cleaned;
      try {
        inputEl.setSelectionRange(pos, pos);
      } catch (_) {
      }
    }
    counterEl.textContent = NAME_MAX - inputEl.value.length;
    const err = validateName(inputEl.value, fieldLabel);
    inputEl.classList.toggle("char-input--error", !!err);
    errorEl.textContent = err || "";
    errorEl.classList.toggle("hidden", !err);
    updateBeginBtn();
  }
  _inputFirstName.addEventListener("input", () => handleInput(_inputFirstName, _counterFirst, _errorFirstName, "First name"));
  _inputLastName.addEventListener("input", () => handleInput(_inputLastName, _counterLast, _errorLastName, "Last name"));
  _inputLastName.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !_charBeginBtn.disabled) _charBeginBtn.click();
  });
  const pronounCards = [..._charOverlay.querySelectorAll(".pronoun-card")];
  function selectCard(card) {
    pronounCards.forEach((c) => {
      c.classList.remove("selected");
      c.setAttribute("aria-checked", "false");
      c.setAttribute("tabindex", "-1");
    });
    card.classList.add("selected");
    card.setAttribute("aria-checked", "true");
    card.setAttribute("tabindex", "0");
    card.focus();
    updateBeginBtn();
  }
  pronounCards.forEach((card) => {
    card.addEventListener("click", () => selectCard(card));
    card.addEventListener("keydown", (e) => {
      const idx = pronounCards.indexOf(card);
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        selectCard(pronounCards[(idx + 1) % pronounCards.length]);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        selectCard(pronounCards[(idx - 1 + pronounCards.length) % pronounCards.length]);
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        selectCard(card);
      }
    });
  });
  function updateBeginBtn() {
    const ok = !validateName(_inputFirstName.value, "First name") && !validateName(_inputLastName.value, "Last name") && !!_charOverlay.querySelector(".pronoun-card.selected");
    _charBeginBtn.disabled = !ok;
  }
  _charBeginBtn.addEventListener("click", () => {
    if (validateName(_inputFirstName.value, "First name") || validateName(_inputLastName.value, "Last name")) return;
    const selected = _charOverlay.querySelector(".pronoun-card.selected");
    if (!selected) return;
    _charOverlay.classList.add("hidden");
    if (typeof _charOverlay._trapRelease === "function") {
      _charOverlay._trapRelease();
      _charOverlay._trapRelease = null;
    }
    if (typeof _charOverlay._resolve === "function") {
      _charOverlay._resolve({
        firstName: _inputFirstName.value.trim(),
        lastName: _inputLastName.value.trim(),
        pronouns: selected.dataset.pronouns
      });
    }
  });
}
function showCharacterCreation() {
  _inputFirstName.value = "";
  _inputLastName.value = "";
  _counterFirst.textContent = String(NAME_MAX);
  _counterLast.textContent = String(NAME_MAX);
  _errorFirstName.classList.add("hidden");
  _errorLastName.classList.add("hidden");
  _inputFirstName.classList.remove("char-input--error");
  _inputLastName.classList.remove("char-input--error");
  _charBeginBtn.disabled = true;
  _charOverlay.querySelectorAll(".pronoun-card").forEach((c) => {
    const def = c.dataset.pronouns === "they/them";
    c.classList.toggle("selected", def);
    c.setAttribute("aria-checked", def ? "true" : "false");
    c.setAttribute("tabindex", def ? "0" : "-1");
  });
  _charOverlay.classList.remove("hidden");
  _charOverlay.style.opacity = "1";
  requestAnimationFrame(() => {
    const release = trapFocus(_charOverlay, null);
    _charOverlay._trapRelease = release;
  });
  setTimeout(() => {
    try {
      _inputFirstName.focus();
    } catch (_) {
    }
  }, 80);
  return new Promise((resolve) => {
    _charOverlay._resolve = resolve;
  });
}

// engine.js
var dom = {
  narrativeContent: document.getElementById("narrative-content"),
  choiceArea: document.getElementById("choice-area"),
  chapterTitle: document.getElementById("chapter-title"),
  narrativePanel: document.getElementById("narrative-panel"),
  statusPanel: document.getElementById("status-panel"),
  statusToggle: document.getElementById("status-toggle"),
  saveBtn: document.getElementById("save-btn"),
  splashOverlay: document.getElementById("splash-overlay"),
  splashNewBtn: document.getElementById("splash-new-btn"),
  splashLoadBtn: document.getElementById("splash-load-btn"),
  splashSlots: document.getElementById("splash-slots"),
  splashSlotsBack: document.getElementById("splash-slots-back"),
  saveOverlay: document.getElementById("save-overlay"),
  saveMenuClose: document.getElementById("save-menu-close"),
  charOverlay: document.getElementById("char-creation-overlay"),
  inputFirstName: document.getElementById("input-first-name"),
  inputLastName: document.getElementById("input-last-name"),
  counterFirst: document.getElementById("counter-first"),
  counterLast: document.getElementById("counter-last"),
  errorFirstName: document.getElementById("error-first-name"),
  errorLastName: document.getElementById("error-last-name"),
  charBeginBtn: document.getElementById("char-begin-btn"),
  endingOverlay: document.getElementById("ending-overlay"),
  endingTitle: document.getElementById("ending-title"),
  endingContent: document.getElementById("ending-content"),
  endingStats: document.getElementById("ending-stats"),
  endingActionBtn: document.getElementById("ending-action-btn"),
  toast: document.getElementById("toast")
};
Object.entries(dom).forEach(([key, el]) => {
  if (!el) console.warn(`[engine] DOM element missing: "${key}" \u2014 check index.html IDs`);
});
var sceneCache = /* @__PURE__ */ new Map();
var labelsCache = /* @__PURE__ */ new Map();
var _statsRenderPending = false;
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
  const key = name.endsWith(".txt") ? name : `${name}.txt`;
  if (sceneCache.has(key)) return sceneCache.get(key);
  const res = await fetch(key);
  if (!res.ok) throw new Error(`Failed to load ${key}`);
  const text = await res.text();
  sceneCache.set(key, text);
  return text;
}
function showEngineError(message) {
  clearNarrative();
  const div = document.createElement("div");
  div.className = "system-block";
  div.style.borderLeftColor = "var(--red)";
  div.style.color = "var(--red)";
  const label = document.createElement("span");
  label.className = "system-block-label";
  label.textContent = "[ ENGINE ERROR ]";
  const text = document.createElement("span");
  text.className = "system-block-text";
  text.textContent = `${message}

Use the Restart button to reload.`;
  div.appendChild(label);
  div.appendChild(text);
  dom.narrativeContent.insertBefore(div, dom.choiceArea);
  dom.chapterTitle.textContent = "ERROR";
}
var _undoStack = [];
var UNDO_MAX = 10;
function pushUndoSnapshot() {
  _undoStack.push({
    playerState: JSON.parse(JSON.stringify(playerState)),
    tempState: JSON.parse(JSON.stringify(tempState)),
    sessionState: JSON.parse(JSON.stringify(sessionState)),
    pendingStatPoints,
    scene: currentScene,
    ip,
    narrativeLog: JSON.parse(JSON.stringify(getNarrativeLog())),
    chapterTitle: dom.chapterTitle.textContent,
    // FIX #S6: capture awaitingChoice so popUndo can re-render choices
    // directly without re-running the interpreter.
    awaitingChoice: awaitingChoice ? JSON.parse(JSON.stringify(awaitingChoice)) : null
  });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  updateUndoBtn();
}
async function popUndo() {
  if (_undoStack.length === 0) return;
  const snap = _undoStack.pop();
  setPlayerState(JSON.parse(JSON.stringify(snap.playerState)));
  setTempState(JSON.parse(JSON.stringify(snap.tempState)));
  if (snap.sessionState !== void 0) {
    clearSessionState();
    Object.assign(sessionState, JSON.parse(JSON.stringify(snap.sessionState)));
  } else {
    clearSessionState();
  }
  setPendingStatPoints(snap.pendingStatPoints);
  setCurrentScene(snap.scene);
  const text = sceneCache.get(snap.scene.endsWith(".txt") ? snap.scene : `${snap.scene}.txt`);
  if (text) {
    setCurrentLines(parseLines(text));
    indexLabels(snap.scene, currentLines, labelsCache);
  }
  setIp(snap.ip);
  setDelayIndex(0);
  setAwaitingChoice(null);
  clearPauseState();
  dom.chapterTitle.textContent = snap.chapterTitle;
  setChapterTitleState(snap.chapterTitle);
  renderFromLog(snap.narrativeLog, { skipAnimations: true });
  dom.choiceArea = document.getElementById("choice-area");
  setChoiceArea(dom.choiceArea);
  if (snap.awaitingChoice) {
    setAwaitingChoice(snap.awaitingChoice);
    if (snap.pendingStatPoints > 0) setPendingLevelUpDisplay(true);
    renderChoices(snap.awaitingChoice.choices);
  }
  runStatsScene();
  updateUndoBtn();
}
function updateUndoBtn() {
  const btn = document.getElementById("undo-btn");
  if (!btn) return;
  btn.disabled = _undoStack.length === 0 || pauseState !== null;
}
var _debugVisible = false;
function toggleDebug() {
  _debugVisible = !_debugVisible;
  const el = document.getElementById("debug-overlay");
  if (el) el.classList.toggle("hidden", !_debugVisible);
  if (_debugVisible) refreshDebug();
}
function refreshDebug() {
  const el = document.getElementById("debug-overlay");
  if (!el || !_debugVisible) return;
  const ps = { ...playerState };
  if (Array.isArray(ps.inventory) && ps.inventory.length > 5) ps.inventory = [...ps.inventory.slice(0, 5), `... +${ps.inventory.length - 5}`];
  if (Array.isArray(ps.skills) && ps.skills.length > 5) ps.skills = [...ps.skills.slice(0, 5), `... +${ps.skills.length - 5}`];
  if (Array.isArray(ps.journal) && ps.journal.length > 3) ps.journal = [`(${ps.journal.length} entries)`];
  const currentLine = currentLines[ip];
  const linePreview = currentLine ? currentLine.trimmed.slice(0, 80) : "(end)";
  el.innerHTML = `<div class="debug-header">DEBUG <button class="debug-close" onclick="this.parentElement.parentElement.classList.add('hidden')">&times;</button></div>
<div class="debug-body"><pre>scene:  ${currentScene || "(none)"}
ip:     ${ip} / ${currentLines.length}
line:   ${linePreview}
await:  ${awaitingChoice ? "choice pending" : "none"}
undo:   ${_undoStack.length} snapshots

playerState:
${JSON.stringify(ps, null, 2)}

tempState:
${JSON.stringify(tempState, null, 2)}</pre></div>`;
}
function wireUI() {
  dom.statusToggle.addEventListener("click", () => {
    const visible = dom.statusPanel.classList.toggle("status-visible");
    dom.statusPanel.classList.toggle("status-hidden", !visible);
    runStatsScene();
  });
  document.addEventListener("click", (e) => {
    if (window.innerWidth <= 768 && !dom.statusPanel.contains(e.target) && e.target !== dom.statusToggle) {
      dom.statusPanel.classList.remove("status-visible");
      dom.statusPanel.classList.add("status-hidden");
    }
  });
  dom.saveBtn.addEventListener("click", showSaveMenu);
  [1, 2, 3].forEach((slot) => {
    const btn = document.getElementById(`save-to-${slot}`);
    if (!btn) return;
    btn.addEventListener("click", () => {
      const existing = loadSaveFromSlot(slot);
      if (existing && !confirm(`Overwrite Slot ${slot}?`)) return;
      saveGameToSlot(slot, null, getNarrativeLog());
      hideSaveMenu();
      showToast(`Saved to Slot ${slot}`);
      refreshAllSlotCards();
    });
  });
  dom.saveMenuClose.addEventListener("click", hideSaveMenu);
  dom.saveOverlay.addEventListener("click", (e) => {
    if (e.target === dom.saveOverlay) hideSaveMenu();
  });
  dom.saveOverlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideSaveMenu();
  });
  [1, 2, 3].forEach((slot) => {
    const btn = document.getElementById(`save-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (confirm(`Delete Slot ${slot}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });
  ["auto", 1, 2, 3].forEach((slot) => {
    const btn = document.getElementById(`ingame-load-${slot}`);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSaveMenu();
      await loadAndResume(save);
    });
  });
  const ingameRestartBtn = document.getElementById("ingame-restart-btn");
  if (ingameRestartBtn) {
    ingameRestartBtn.addEventListener("click", () => {
      if (confirm("Return to the title screen? Manual saves will be kept.")) {
        hideSaveMenu();
        deleteSaveSlot("auto");
        location.reload();
      }
    });
  }
  dom.splashNewBtn.addEventListener("click", async () => {
    hideSplash();
    const charData = await showCharacterCreation();
    patchPlayerState({
      first_name: charData.firstName,
      last_name: charData.lastName,
      pronouns: charData.pronouns
    });
    dom.saveBtn.classList.remove("hidden");
    document.getElementById("undo-btn")?.classList.remove("hidden");
    _undoStack.splice(0);
    updateUndoBtn();
    clearSessionState();
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || "prologue");
  });
  dom.splashLoadBtn.addEventListener("click", () => {
    dom.splashOverlay.querySelector(".splash-btn-col")?.classList.add("hidden");
    dom.splashSlots.classList.remove("hidden");
    refreshAllSlotCards();
  });
  dom.splashSlotsBack.addEventListener("click", () => {
    dom.splashSlots.classList.add("hidden");
    dom.splashOverlay.querySelector(".splash-btn-col")?.classList.remove("hidden");
  });
  ["auto", 1, 2, 3].forEach((slot) => {
    const btn = document.getElementById(`slot-load-${slot}`);
    if (!btn) return;
    btn.addEventListener("click", async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSplash();
      await loadAndResume(save);
    });
  });
  ["auto", 1, 2, 3].forEach((slot) => {
    const btn = document.getElementById(`slot-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener("click", () => {
      const label = slot === "auto" ? "the auto-save" : `Slot ${slot}`;
      if (confirm(`Delete ${label}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });
  wireCharCreation();
  const undoBtn = document.getElementById("undo-btn");
  if (undoBtn) undoBtn.addEventListener("click", popUndo);
  document.addEventListener("keydown", (e) => {
    if (e.key === "`") {
      e.preventDefault();
      toggleDebug();
    }
  });
  [1, 2, 3].forEach((slot) => {
    const btn = document.getElementById(`save-export-${slot}`);
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!exportSaveSlot(slot)) showToast(`Slot ${slot} is empty.`);
      else showToast(`Slot ${slot} exported.`);
    });
  });
  const importInput = document.getElementById("save-import-file");
  if (importInput) {
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const targetSlot = Number(document.getElementById("save-import-slot")?.value || 1);
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
        showToast("Import failed: file could not be parsed as JSON.");
      }
      importInput.value = "";
    });
  }
}
async function boot() {
  registerCaches(sceneCache, labelsCache);
  init({
    narrativeContent: dom.narrativeContent,
    choiceArea: dom.choiceArea,
    narrativePanel: dom.narrativePanel,
    onShowLevelUp: showInlineLevelUp,
    scheduleStatsRender,
    onBeforeChoice: pushUndoSnapshot,
    executeBlock,
    runInterpreter
  });
  init2({
    narrativeContent: dom.narrativeContent,
    choiceArea: dom.choiceArea,
    statusPanel: dom.statusPanel,
    endingOverlay: dom.endingOverlay,
    endingTitle: dom.endingTitle,
    endingContent: dom.endingContent,
    endingStats: dom.endingStats,
    endingActionBtn: dom.endingActionBtn,
    fetchTextFile,
    scheduleStatsRender,
    trapFocus,
    onLevelUpConfirmed: (level) => {
      pushNarrativeLogEntry({ type: "levelup_confirmed", level });
    }
  });
  init3({
    splashOverlay: dom.splashOverlay,
    splashSlots: dom.splashSlots,
    saveOverlay: dom.saveOverlay,
    saveBtn: dom.saveBtn,
    charOverlay: dom.charOverlay,
    inputFirstName: dom.inputFirstName,
    inputLastName: dom.inputLastName,
    counterFirst: dom.counterFirst,
    counterLast: dom.counterLast,
    errorFirstName: dom.errorFirstName,
    errorLastName: dom.errorLastName,
    charBeginBtn: dom.charBeginBtn,
    toast: dom.toast,
    runStatsScene,
    fetchTextFile,
    evalValue,
    renderFromLog,
    renderChoices,
    showInlineLevelUp,
    showPageBreak,
    showInputPrompt,
    runInterpreter,
    clearNarrative,
    applyTransition,
    setChapterTitle: (t) => {
      dom.chapterTitle.textContent = t;
      setChapterTitleState(t);
    },
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
      clearSessionState();
    }
  });
  registerCallbacks({
    addParagraph,
    addSystem,
    clearNarrative,
    applyTransition,
    renderChoices,
    showInlineLevelUp,
    showEndingScreen,
    showEngineError,
    showInputPrompt,
    showPageBreak,
    scheduleStatsRender,
    setChapterTitle: (t) => {
      dom.chapterTitle.textContent = t;
      setChapterTitleState(t);
    },
    runStatsScene,
    fetchTextFile,
    getNarrativeLog
  });
  wireUI();
  try {
    await parseStartup(fetchTextFile, evalValue);
    await parseSkills(fetchTextFile);
    showSplash();
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}
document.addEventListener("DOMContentLoaded", boot);
//# sourceMappingURL=engine.js.map
