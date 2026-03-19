// src/core/state.ts
var playerState = {};
var tempState = {};
var statRegistry = [];
var currentScene = null;
var currentLines = [];
var ip = 0;
var awaitingChoice = null;
var startup = { sceneList: [] };
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
function setAwaitingChoice(c) {
  awaitingChoice = c;
}
function clearTempState() {
  tempState = {};
}
function normalizeKey(k) {
  return String(k).trim().toLowerCase();
}
function resolveStore(key) {
  if (Object.prototype.hasOwnProperty.call(tempState, key)) return tempState;
  if (Object.prototype.hasOwnProperty.call(playerState, key)) return playerState;
  return null;
}
var _startupDefaults = {};
function captureStartupDefaults() {
  _startupDefaults = JSON.parse(JSON.stringify(playerState));
}
function getStartupDefaults() {
  return _startupDefaults;
}
function setVar(command, evalValueFn) {
  const m = command.match(/^\*set\s+([a-zA-Z_][\w]*)\s+(.+)$/);
  if (!m) return;
  const [, rawKey, rhs] = m;
  const key = normalizeKey(rawKey);
  const store = resolveStore(key);
  if (!store) {
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
  const store = resolveStore(key);
  if (!store) {
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
    console.warn("[state] No *create_stat entries found in startup.txt.");
    _statRegistryWarningFired = true;
  }
}

// src/core/expression.ts
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
      const store = resolveStore(key);
      if (store !== null) return store[key];
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

// src/core/parser.ts
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

// src/systems/inventory.ts
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

// src/systems/saves.ts
var SAVE_VERSION = 9;
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
function crc16(str) {
  let crc = 65535;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? crc >>> 1 ^ 40961 : crc >>> 1;
    }
  }
  return crc.toString(16).padStart(4, "0");
}
function buildSaveCodePayload(label, narrativeLog) {
  const defaults = getStartupDefaults();
  const ps = {};
  for (const [k, v] of Object.entries(playerState)) {
    if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
      ps[k] = v;
    }
  }
  const payload = {
    v: SAVE_VERSION,
    s: currentScene,
    ip,
    ct: chapterTitle,
    ps,
    nl: narrativeLog || [],
    ts: Date.now()
  };
  if (label) payload.lb = label;
  if (awaitingChoice) payload.ac = JSON.parse(JSON.stringify(awaitingChoice));
  if (statRegistry.length > 0) payload.sr = JSON.parse(JSON.stringify(statRegistry));
  return payload;
}
function encodeSaveCode(narrativeLog, label = null) {
  const json = JSON.stringify(buildSaveCodePayload(label, narrativeLog));
  const compressed = btoa(unescape(encodeURIComponent(json)));
  const checksum = crc16(compressed);
  return `SA1|${compressed}|${checksum}`;
}
function decodeSaveCode(code) {
  const trimmed = code.trim();
  const parts = trimmed.split("|");
  if (parts.length !== 3) {
    return { ok: false, reason: "Invalid save code format." };
  }
  const [prefix, compressed, checksum] = parts;
  if (prefix !== "SA1") {
    return { ok: false, reason: `Unrecognized save code version: ${prefix}` };
  }
  if (crc16(compressed) !== checksum) {
    return { ok: false, reason: "Save code is corrupted (checksum mismatch). Check for missing characters." };
  }
  let json;
  try {
    const decoded = decodeURIComponent(escape(atob(compressed)));
    json = JSON.parse(decoded);
  } catch (err) {
    return { ok: false, reason: `Save code could not be decoded: ${err.message}` };
  }
  if (json.v !== SAVE_VERSION) {
    return { ok: false, reason: `Save code is from a different game version (v${json.v}, expected v${SAVE_VERSION}).` };
  }
  const defaults = getStartupDefaults();
  const fullPlayerState = { ...defaults, ...json.ps };
  return {
    ok: true,
    save: {
      version: json.v,
      scene: json.s,
      ip: json.ip,
      chapterTitle: json.ct,
      playerState: fullPlayerState,
      narrativeLog: json.nl || [],
      awaitingChoice: json.ac || null,
      statRegistry: json.sr || JSON.parse(JSON.stringify(statRegistry)),
      label: json.lb || null,
      characterName: `${fullPlayerState.first_name || ""} ${fullPlayerState.last_name || ""}`.trim() || "Unknown",
      timestamp: json.ts || Date.now()
    }
  };
}
function saveGameToSlot(slot, label = null, narrativeLog = []) {
  const key = saveKeyForSlot(slot);
  if (!key) {
    console.warn(`[saves] Unknown save slot: "${slot}"`);
    return;
  }
  try {
    const code = encodeSaveCode(narrativeLog, label);
    localStorage.setItem(key, code);
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
    if (raw.startsWith("SA1|")) {
      const result = decodeSaveCode(raw);
      if (result.ok) return result.save;
      const reason = result.reason;
      console.warn(`[saves] Slot "${slot}" decode failed: ${reason}`);
      if (reason.includes("different game version")) {
        setStaleSaveFound();
      }
      try {
        localStorage.removeItem(key);
      } catch (_) {
      }
      return null;
    }
    console.warn(`[saves] Slot "${slot}" contains legacy format \u2014 discarding.`);
    setStaleSaveFound();
    try {
      localStorage.removeItem(key);
    } catch (_) {
    }
    return null;
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
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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
  const defaults = getStartupDefaults();
  const deltaPs = {};
  for (const [k, v] of Object.entries(json.playerState)) {
    if (JSON.stringify(v) !== JSON.stringify(defaults[k])) {
      deltaPs[k] = v;
    }
  }
  const payload = {
    v: SAVE_VERSION,
    s: json.scene,
    ip: json.ip ?? 0,
    ct: json.chapterTitle || "",
    ps: deltaPs,
    nl: json.narrativeLog || [],
    ts: json.timestamp || Date.now()
  };
  if (json.label) payload.lb = json.label;
  if (json.awaitingChoice) payload.ac = json.awaitingChoice;
  if (json.statRegistry) payload.sr = json.statRegistry;
  try {
    const jsonStr = JSON.stringify(payload);
    const compressed = btoa(unescape(encodeURIComponent(jsonStr)));
    const checksum = crc16(compressed);
    const code = `SA1|${compressed}|${checksum}`;
    localStorage.setItem(key, code);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `localStorage write failed: ${err.message}` };
  }
}
async function restoreFromSave(save, {
  runStatsScene: runStatsScene2,
  renderFromLog: renderFromLog2,
  renderChoices: renderChoices2,
  runInterpreter: runInterpreter2,
  clearNarrative: clearNarrative2,
  applyTransition: applyTransition2,
  setChapterTitle: setChapterTitle2,
  setChoiceArea: setChoiceArea2,
  parseAndCacheScene,
  fetchTextFileFn,
  evalValueFn
}) {
  await parseStartup(fetchTextFileFn, evalValueFn);
  setPlayerState({ ...playerState, ...JSON.parse(JSON.stringify(save.playerState)) });
  clearTempState();
  if (Array.isArray(save.statRegistry) && save.statRegistry.length > 0) {
    const freshStatKeys = new Set(statRegistry.map((e) => e.key));
    const extra = save.statRegistry.filter((e) => !freshStatKeys.has(e.key));
    if (extra.length > 0) {
      setStatRegistry([...statRegistry, ...extra]);
    }
  }
  await parseAndCacheScene(save.scene);
  setCurrentScene(save.scene);
  setIp(save.ip ?? 0);
  setAwaitingChoice(null);
  if (save.chapterTitle) {
    setChapterTitle2(save.chapterTitle);
  }
  clearNarrative2();
  applyTransition2();
  renderFromLog2(save.narrativeLog ?? [], { skipAnimations: true });
  if (typeof setChoiceArea2 === "function") {
    setChoiceArea2(document.getElementById("choice-area"));
  }
  await runStatsScene2();
  if (save.awaitingChoice) {
    setAwaitingChoice(save.awaitingChoice);
    renderChoices2(save.awaitingChoice.choices);
  } else {
    await runInterpreter2({ suppressAutoSave: true });
  }
}

// src/systems/skills.ts
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
    const m = trimmed.match(/^\*skill\s+([\w]+)\s+"([^"]+)"\s+(\d+)(?:\s+(common|uncommon|rare|epic|legendary))?\s*$/i);
    if (m) {
      if (current) parsed.push(current);
      current = {
        key: normalizeKey(m[1]),
        label: m[2],
        essenceCost: Number(m[3]),
        rarity: m[4] ? m[4].toLowerCase() : "common",
        description: "",
        condition: null
      };
      continue;
    }
    if (current && trimmed.startsWith("*require ")) {
      current.condition = trimmed.replace(/^\*require\s+/, "").trim();
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
  const essence = Number(playerState.essence || 0);
  if (essence < entry.essenceCost) {
    console.warn(`[skills] purchaseSkill: not enough Essence (have ${essence}, need ${entry.essenceCost}).`);
    return false;
  }
  playerState.essence = essence - entry.essenceCost;
  grantSkill(k);
  return true;
}

// src/systems/journal.ts
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

// src/core/interpreter.ts
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
var _gosubStack = [];
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
      return "choice";
    }
    if (ip < start || ip >= end) {
      return "goto";
    }
  }
  setIp(resumeAfter);
  return "normal";
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
  _gosubStack.length = 0;
  setCurrentScene(name);
  setCurrentLines(parseLines(text));
  indexLabels(name, currentLines, _labelsCache);
  setIp(0);
  cb.clearNarrative();
  cb.applyTransition();
  if (label) {
    const labels = _labelsCache.get(name) || {};
    setIp(labels[label] ?? 0);
  }
  setAwaitingChoice(null);
  await runInterpreter();
  if (chapterTitle === prevChapterTitle) {
    const fallback = name.replace(/\.txt$/i, "").toUpperCase();
    cb.setChapterTitle(fallback);
  }
}
async function runInterpreter({ suppressAutoSave = false } = {}) {
  while (ip < currentLines.length) {
    await executeCurrentLine();
    if (awaitingChoice) break;
  }
  cb.runStatsScene();
  if (!suppressAutoSave && cb.getNarrativeLog) {
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
registerCommand("*set_game_title", (t) => {
  const m = t.match(/^\*set_game_title\s+"([^"]+)"$/);
  const title = m ? m[1] : t.replace(/^\*set_game_title\s*/, "").trim();
  if (title) {
    playerState.game_title = title;
    if (cb.setGameTitle) cb.setGameTitle(title);
  }
  advanceIp();
});
registerCommand("*set_game_byline", (t) => {
  const m = t.match(/^\*set_game_byline\s+"([^"]+)"$/);
  const byline = m ? m[1] : t.replace(/^\*set_game_byline\s*/, "").trim();
  if (byline) {
    playerState.game_byline = byline;
    if (cb.setGameByline) cb.setGameByline(byline);
  }
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
    setStatRegistry([...statRegistry, { key, label, defaultVal: Number(defaultVal) }]);
  }
  advanceIp();
});
registerCommand("*temp", (t) => {
  declareTemp(t, evalValue);
  advanceIp();
});
function _handleAddEssence(n) {
  if (n > 0) {
    playerState.essence = Number(playerState.essence || 0) + n;
    cb.scheduleStatsRender();
  }
  advanceIp();
}
registerCommand("*award_essence", (t) => {
  _handleAddEssence(Number(t.replace(/^\*award_essence\s*/, "").trim()) || 0);
});
registerCommand("*add_essence", (t) => {
  _handleAddEssence(Number(t.replace(/^\*add_essence\s*/, "").trim()) || 0);
});
function stripItemName(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}
registerCommand("*add_item", (t) => {
  addInventoryItem(stripItemName(t.replace(/^\*add_item\s*/, "")));
  cb.scheduleStatsRender();
  advanceIp();
});
registerCommand("*grant_item", (t) => {
  addInventoryItem(stripItemName(t.replace(/^\*grant_item\s*/, "")));
  cb.scheduleStatsRender();
  advanceIp();
});
registerCommand("*remove_item", (t) => {
  removeInventoryItem(stripItemName(t.replace(/^\*remove_item\s*/, "")));
  cb.scheduleStatsRender();
  advanceIp();
});
registerCommand("*check_item", (t) => {
  const m = t.match(/^\*check_item\s+"([^"]+)"\s+([\w_]+)/);
  if (!m) {
    console.warn(`[interpreter] *check_item: malformed \u2014 expected: *check_item "Item Name" varName
Got: ${t}`);
    advanceIp();
    return;
  }
  const itemName = m[1];
  const varName = normalizeKey(m[2]);
  const inv = Array.isArray(playerState.inventory) ? playerState.inventory : [];
  const has = inv.some((i) => itemBaseName(i) === itemName);
  const store = resolveStore(varName);
  if (store) store[varName] = has;
  else tempState[varName] = has;
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
    const reason = await executeBlock(bs, be, be);
    if (reason === "choice" || reason === "goto") return;
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
registerCommand("*notify", (t) => {
  const m = t.match(/^\*notify\s+"([^"]+)"(?:\s+(\d+))?/);
  if (m) {
    const raw = m[1];
    const duration = m[2] ? Number(m[2]) : 2e3;
    const message = cb.formatText ? cb.formatText(raw).replace(/<[^>]+>/g, "") : raw;
    if (cb.showToast) cb.showToast(message, duration);
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
registerCommand("*save_point", (t) => {
  const label = t.replace(/^\*save_point\s*/, "").trim() || null;
  if (cb.getNarrativeLog) saveGameToSlot("auto", label, cb.getNarrativeLog());
  advanceIp();
});
registerCommand("*page_break", (t) => {
  const btnText = t.replace(/^\*page_break\s*/, "").trim() || "Continue";
  const resumeIp = ip + 1;
  setIp(currentLines.length);
  cb.showPageBreak(btnText, () => {
    cb.clearNarrative();
    setIp(resumeIp);
    runInterpreter().catch((err) => cb.showEngineError(err.message));
  });
});
registerCommand("*input", (t) => {
  const m = t.match(/^\*input\s+([a-zA-Z_][\w]*)\s+"([^"]+)"$/);
  if (!m) {
    cb.showEngineError(`*input requires: *input varName "Prompt text"
Got: ${t}`);
    setIp(currentLines.length);
    return;
  }
  const varName = normalizeKey(m[1]);
  const prompt = m[2];
  const resumeIp = ip + 1;
  setIp(currentLines.length);
  cb.showInputPrompt(varName, prompt, (value) => {
    const store = resolveStore(varName);
    if (!store) {
      cb.showEngineError(`*input: variable "${varName}" is not declared. Add *create ${varName} or *temp ${varName} before using *input.`);
      setIp(resumeIp);
      runInterpreter().catch((err) => cb.showEngineError(err.message));
      return;
    }
    store[varName] = value;
    setIp(resumeIp);
    runInterpreter().catch((err) => cb.showEngineError(err.message));
  });
});
registerCommand("*choice", (t, line) => {
  const parsed = parseChoice(ip, line.indent, {
    currentLines,
    evalValue,
    showEngineError: cb.showEngineError
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
        const reason = await executeBlock(bs, be, chainEnd);
        executed = true;
        if (reason === "choice" || reason === "goto") return;
      }
      cursor = be;
      continue;
    }
    if (isDirective(c.trimmed, "*else")) {
      const bs = cursor + 1, be = findBlockEnd2(bs, c.indent);
      if (!executed) {
        const reason = await executeBlock(bs, be, chainEnd);
        if (reason === "choice" || reason === "goto") return;
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
    const reason = await executeBlock(blockStart, blockEnd);
    if (reason === "choice") {
      const ac = awaitingChoice;
      if (ac) setAwaitingChoice({ ...ac, _savedIp: blockEnd });
      return;
    }
    if (reason === "goto") return;
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
registerCommand("*gosub", (t) => {
  const label = t.replace(/^\*gosub\s*/, "").trim();
  const labels = _labelsCache.get(currentScene) || {};
  if (labels[label] === void 0) {
    cb.showEngineError(`*gosub: Unknown label "${label}" in scene "${currentScene}".`);
    setIp(currentLines.length);
    return;
  }
  _gosubStack.push(ip + 1);
  setIp(labels[label]);
});
registerCommand("*return", () => {
  if (_gosubStack.length === 0) {
    cb.showEngineError(`*return without matching *gosub in scene "${currentScene}".`);
    setIp(currentLines.length);
    return;
  }
  setIp(_gosubStack.pop());
});
registerCommand("*finish", async () => {
  const list = startup.sceneList;
  const currentIdx = list.indexOf(currentScene.replace(/\.txt$/i, ""));
  const nextIdx = currentIdx + 1;
  if (nextIdx >= list.length) {
    cb.showEngineError(`*finish: no next scene after "${currentScene}" in scene_list.`);
    setIp(currentLines.length);
    return;
  }
  await gotoScene(list[nextIdx]);
});

// src/systems/items.ts
var itemRegistry = [];
async function parseItems(fetchTextFileFn) {
  let text;
  try {
    text = await fetchTextFileFn("items");
  } catch (err) {
    console.warn("[items] items.txt not found \u2014 item store disabled.", err.message);
    itemRegistry = [];
    return;
  }
  const lines = text.split(/\r?\n/);
  const parsed = [];
  let current = null;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const m = trimmed.match(/^\*item\s+([\w]+)\s+"([^"]+)"\s+(\d+)(?:\s+(common|uncommon|rare|epic|legendary))?\s*$/i);
    if (m) {
      if (current) parsed.push(current);
      current = {
        key: normalizeKey(m[1]),
        label: m[2],
        essenceCost: Number(m[3]),
        rarity: m[4] ? m[4].toLowerCase() : "common",
        description: "",
        condition: null
      };
      continue;
    }
    if (current && trimmed.startsWith("*require ")) {
      current.condition = trimmed.replace(/^\*require\s+/, "").trim();
      continue;
    }
    if (current && raw.match(/^\s+/) && trimmed) {
      current.description += (current.description ? " " : "") + trimmed;
    }
  }
  if (current) parsed.push(current);
  itemRegistry = parsed;
  if (itemRegistry.length === 0) {
    console.warn("[items] No *item entries found in items.txt.");
  }
}
function purchaseItem(key) {
  const k = normalizeKey(key);
  const entry = itemRegistry.find((i) => i.key === k);
  if (!entry) {
    console.warn(`[items] purchaseItem: "${k}" not found in itemRegistry.`);
    return false;
  }
  const essence = Number(playerState.essence || 0);
  if (essence < entry.essenceCost) {
    console.warn(`[items] purchaseItem: not enough Essence (have ${essence}, need ${entry.essenceCost}).`);
    return false;
  }
  playerState.essence = essence - entry.essenceCost;
  addInventoryItem(entry.label);
  return true;
}

// src/ui/narrative.ts
function escapeHtml(val) {
  return String(val ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
var _narrativeContent;
var _choiceArea;
var _narrativePanel;
var _scheduleStats;
var _onBeforeChoice;
var _executeBlock;
var _runInterpreter;
function init({
  narrativeContent,
  choiceArea,
  narrativePanel,
  scheduleStatsRender: scheduleStatsRender2,
  onBeforeChoice,
  executeBlock: executeBlock2,
  runInterpreter: runInterpreter2
}) {
  _narrativeContent = narrativeContent;
  _choiceArea = choiceArea;
  _narrativePanel = narrativePanel;
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
function resolvePronoun(lower, isCapital) {
  const map = {
    they: playerState.pronouns_subject || "they",
    them: playerState.pronouns_object || "them",
    their: playerState.pronouns_possessive || "their",
    theirs: playerState.pronouns_possessive_pronoun || "theirs",
    themself: playerState.pronouns_reflexive || "themself"
  };
  const resolved = escapeHtml(map[lower] || lower);
  return isCapital ? resolved.charAt(0).toUpperCase() + resolved.slice(1) : resolved;
}
function formatText(text) {
  if (!text) return "";
  let result = String(text);
  result = result.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_, v) => {
    const k = normalizeKey(v);
    const store = resolveStore(k);
    return escapeHtml(store ? store[k] : "").replace(/\*/g, "&#42;");
  });
  result = result.replace(
    /\{(They|Them|Their|Theirs|Themself|they|them|their|theirs|themself)\}/g,
    (_, token) => {
      const lower = token.toLowerCase();
      const isCapital = token.charCodeAt(0) >= 65 && token.charCodeAt(0) <= 90;
      return resolvePronoun(lower, isCapital).replace(/\*/g, "&#42;");
    }
  );
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const COLOR_TAGS = [
    "cyan",
    "amber",
    "green",
    "red",
    "common",
    "uncommon",
    "rare",
    "epic",
    "legendary",
    "white",
    "blue",
    "purple",
    "gold",
    "silver",
    "dim",
    "faint"
  ];
  for (const color of COLOR_TAGS) {
    const open = new RegExp(`\\[${color}\\]`, "g");
    const close = new RegExp(`\\[\\/${color}\\]`, "g");
    result = result.replace(open, `<span class="inline-accent-${color}">`).replace(close, "</span>");
  }
  return result;
}
function addParagraph(text, cls = "narrative-paragraph") {
  const p = document.createElement("p");
  p.className = cls;
  p.innerHTML = formatText(text);
  _narrativeContent.insertBefore(p, _choiceArea);
  _narrativeLog.push({ type: "paragraph", text });
}
function addSystem(text) {
  const div = document.createElement("div");
  const isEssence = /Essence\s+gained|bonus\s+Essence|\+\d+\s+Essence/i.test(text);
  const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(text);
  div.className = `system-block${isEssence ? " essence-block" : ""}${isLevelUp ? " levelup-block" : ""}`;
  const formatted = formatText(text).replace(/\\n/g, "\n").replace(/\n/g, "<br>");
  div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
  _narrativeContent.insertBefore(div, _choiceArea);
  _narrativeLog.push({ type: "system", text });
}
function clearNarrative() {
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = "";
  _narrativeContent.scrollTo({ top: 0, behavior: "instant" });
  _narrativeLog = [];
}
function applyTransition() {
}
function renderChoices(choices) {
  _choiceArea.innerHTML = "";
  _choiceArea.setAttribute("role", "group");
  _choiceArea.setAttribute("aria-label", "Story choices");
  let choiceMade = false;
  choices.forEach((choice) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.innerHTML = `<span>${formatText(choice.text)}</span>`;
    if (choice.statTag) {
      const { label, requirement } = choice.statTag;
      const key = normalizeKey(label.replace(/\s+/g, "_"));
      const store = resolveStore(key);
      const val = store ? store[key] : null;
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
      btn.setAttribute("aria-disabled", "true");
    } else {
      btn.addEventListener("click", () => {
        if (choiceMade) return;
        choiceMade = true;
        _onBeforeChoice();
        clearNarrative();
        const choiceBlockEnd = awaitingChoice?.end ?? choice.end;
        const savedIp = awaitingChoice?._savedIp ?? choiceBlockEnd;
        setAwaitingChoice(null);
        _executeBlock(choice.start, choice.end, savedIp).then(() => _runInterpreter()).catch((err) => {
          console.error("[narrative] choice execution error:", err);
        });
      });
    }
    _choiceArea.appendChild(btn);
  });
  requestAnimationFrame(() => {
    const firstEnabled = _choiceArea.querySelector(".choice-btn:not(:disabled)");
    if (firstEnabled) firstEnabled.focus({ preventScroll: true });
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
function showInputPrompt(varName, prompt, onSubmit) {
  const logEntry = { type: "input", varName, prompt, value: null };
  _narrativeLog.push(logEntry);
  const wrapper = document.createElement("div");
  wrapper.className = "input-prompt-block";
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
    logEntry.value = value;
    wrapper.classList.add("input-prompt-block--submitted");
    wrapper.innerHTML = `
      <span class="system-block-label">[ INPUT ]</span>
      <span class="input-prompt-label">${formatText(prompt)}</span>
      <span class="input-prompt-submitted-value">${escapeHtml(value)}</span>`;
    onSubmit(value);
  }
  submit.addEventListener("click", doSubmit);
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSubmit();
  });
  requestAnimationFrame(() => field.focus({ preventScroll: true }));
}
function renderFromLog(log, { skipAnimations = true } = {}) {
  for (const el of [..._narrativeContent.children]) {
    if (el !== _choiceArea) el.remove();
  }
  _choiceArea.innerHTML = "";
  _narrativeContent.scrollTo({ top: 0, behavior: "instant" });
  for (const entry of log) {
    switch (entry.type) {
      case "paragraph": {
        const p = document.createElement("p");
        p.className = "narrative-paragraph";
        p.innerHTML = formatText(entry.text);
        _narrativeContent.insertBefore(p, _choiceArea);
        break;
      }
      case "system": {
        const div = document.createElement("div");
        const isEssence = /Essence\s+gained|bonus\s+Essence|\+\d+\s+Essence/i.test(entry.text ?? "");
        const isLevelUp = /level\s*up|LEVEL\s*UP/i.test(entry.text ?? "");
        div.className = `system-block${isEssence ? " essence-block" : ""}${isLevelUp ? " levelup-block" : ""}`;
        const formatted = formatText(entry.text).replace(/\\n/g, "\n").replace(/\n/g, "<br>");
        div.innerHTML = `<span class="system-block-label">[ SYSTEM ]</span><span class="system-block-text">${formatted}</span>`;
        _narrativeContent.insertBefore(div, _choiceArea);
        break;
      }
      case "input": {
        const wrapper = document.createElement("div");
        wrapper.className = "input-prompt-block input-prompt-block--submitted";
        const safe = escapeHtml(entry.value ?? "\u2014");
        wrapper.innerHTML = `
          <span class="system-block-label">[ INPUT ]</span>
          <span class="input-prompt-label">${formatText(entry.prompt)}</span>
          <span class="input-prompt-submitted-value">${safe}</span>`;
        _narrativeContent.insertBefore(wrapper, _choiceArea);
        break;
      }
      default:
        console.warn("[narrative] renderFromLog: unknown entry type:", entry.type);
    }
  }
  _narrativeLog = [...log];
}

// src/ui/panels.ts
var _statusPanel;
var _endingOverlay = null;
var _endingTitle = null;
var _endingContent = null;
var _endingStats = null;
var _endingActionBtn = null;
var _storeOverlay = null;
var _fetchTextFile;
var _scheduleStats2;
var _trapFocus = null;
var _showToast;
function init2({
  statusPanel,
  endingOverlay,
  endingTitle,
  endingContent,
  endingStats,
  endingActionBtn,
  storeOverlay,
  fetchTextFile: fetchTextFile2,
  scheduleStatsRender: scheduleStatsRender2,
  trapFocus: trapFocus2,
  showToast: showToast2
}) {
  _statusPanel = statusPanel;
  _endingOverlay = endingOverlay;
  _endingTitle = endingTitle;
  _endingContent = endingContent;
  _endingStats = endingStats;
  _endingActionBtn = endingActionBtn;
  _storeOverlay = storeOverlay;
  _fetchTextFile = fetchTextFile2;
  _scheduleStats2 = scheduleStatsRender2;
  _trapFocus = trapFocus2;
  _showToast = showToast2 ?? (() => {
  });
}
var styleState = { colors: {}, icons: {} };
var _activeStatusTab = "stats";
async function runStatsScene() {
  const text = await _fetchTextFile("stats");
  const lines = text.split(/\r?\n/).map((raw) => ({ raw, trimmed: raw.trim() }));
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
  let statsHtml = "";
  let inGroup = false;
  entries.forEach((e) => {
    if (e.type === "group") {
      if (inGroup) statsHtml += `</div>`;
      statsHtml += `<div class="status-section"><div class="status-label status-section-header">${escapeHtml(e.name)}</div>`;
      inGroup = true;
    }
    if (e.type === "stat" && e.key) {
      const cc = styleState.colors[e.key] || "";
      const ic = styleState.icons[e.key] ?? "";
      const rawVal = playerState[e.key] ?? "\u2014";
      statsHtml += `<div class="status-row"><span class="status-label">${ic ? ic + " " : ""}${escapeHtml(e.label)}</span><span class="status-value ${cc}">${formatText(String(rawVal))}</span></div>`;
    }
  });
  if (inGroup) statsHtml += `</div>`;
  const achvsForStats = getAchievements();
  if (achvsForStats.length > 0) {
    const achvAccordions = achvsForStats.map((a) => {
      const dashIdx = a.text.indexOf(" \u2014 ");
      const title = dashIdx !== -1 ? escapeHtml(a.text.slice(0, dashIdx)) : escapeHtml(a.text);
      const body = dashIdx !== -1 ? escapeHtml(a.text.slice(dashIdx + 3)) : "";
      return `<li class="skill-accordion skill-accordion--achievement">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name"><span class="journal-achievement-icon">\u25C6</span> ${title}</span>
          ${body ? `<span class="skill-accordion-chevron">\u25BE</span>` : ""}
        </button>
        ${body ? `<div class="skill-accordion-desc" style="display:none;">${body}</div>` : ""}
      </li>`;
    }).join("");
    statsHtml += `<div class="status-section"><div class="status-label status-section-header">Achievements</div><ul class="skill-accordion-list">${achvAccordions}</ul></div>`;
  }
  const hasSkillStore = skillRegistry.length > 0;
  let skillsHtml = hasSkillStore ? `<div class="status-store-row"><button class="status-store-btn" id="status-store-btn-skills" data-store-tab="skills">\u25C8 Skill Store</button></div>` : "";
  const ownedSkills = Array.isArray(playerState.skills) ? playerState.skills : [];
  if (ownedSkills.length === 0) {
    skillsHtml += `<p class="tag-empty" style="padding:0;border:none;background:none;margin-top:8px;">No skills learned yet.</p>`;
  } else {
    const skillItems = ownedSkills.map((k) => {
      const entry = skillRegistry.find((s) => s.key === k);
      const label = escapeHtml(entry ? entry.label : k);
      const desc = escapeHtml(entry ? entry.description : "");
      const rarity = entry?.rarity || "common";
      const rarCls = ` skill-rarity--${rarity}`;
      return `<li class="skill-accordion"><button class="skill-accordion-btn" data-skill-key="${escapeHtml(k)}"><span class="skill-accordion-name${rarCls}">${label}</span><span class="skill-accordion-chevron">\u25BE</span></button><div class="skill-accordion-desc" style="display:none;">${desc}</div></li>`;
    }).join("");
    skillsHtml += `<ul class="skill-accordion-list">${skillItems}</ul>`;
  }
  const hasItemStore = itemRegistry.length > 0;
  let inventoryHtml = hasItemStore ? `<div class="status-store-row"><button class="status-store-btn" id="status-store-btn-inv" data-store-tab="items">\u25C8 Item Store</button></div>` : "";
  const invItems = Array.isArray(playerState.inventory) ? playerState.inventory : [];
  if (invItems.length === 0) {
    inventoryHtml += `<p class="tag-empty" style="padding:0;border:none;background:none;margin-top:8px;">Nothing here yet.</p>`;
  } else {
    const invAccordions = invItems.map((invEntry) => {
      const baseName = itemBaseName(invEntry);
      const regEntry = itemRegistry.find((r) => r.label === baseName);
      const label = escapeHtml(invEntry);
      const desc = escapeHtml(regEntry ? regEntry.description : "");
      const rarity = regEntry?.rarity || "common";
      const rarCls = ` skill-rarity--${rarity}`;
      return `<li class="skill-accordion">
        <button class="skill-accordion-btn">
          <span class="skill-accordion-name${rarCls}">${label}</span>
          <span class="skill-accordion-chevron">\u25BE</span>
        </button>
        <div class="skill-accordion-desc" style="display:none;">${desc || '<em style="color:var(--text-faint)">No description available.</em>'}</div>
      </li>`;
    }).join("");
    inventoryHtml += `<ul class="skill-accordion-list">${invAccordions}</ul>`;
  }
  let achievementsHtml = "";
  const achvs = getAchievements();
  const jentries = getJournalEntries().filter((j) => j.type !== "achievement");
  if (achvs.length === 0 && jentries.length === 0) {
    achievementsHtml = `<p class="tag-empty" style="padding:0;border:none;background:none;">Nothing recorded yet.</p>`;
  } else {
    if (achvs.length > 0) {
      const achvAccordionItems = achvs.map((a) => {
        const dashIdx = a.text.indexOf(" \u2014 ");
        const title = dashIdx !== -1 ? escapeHtml(a.text.slice(0, dashIdx)) : escapeHtml(a.text);
        const body = dashIdx !== -1 ? escapeHtml(a.text.slice(dashIdx + 3)) : "";
        return `<li class="skill-accordion skill-accordion--achievement">
          <button class="skill-accordion-btn">
            <span class="skill-accordion-name"><span class="journal-achievement-icon">\u25C6</span> ${title}</span>
            ${body ? `<span class="skill-accordion-chevron">\u25BE</span>` : ""}
          </button>
          ${body ? `<div class="skill-accordion-desc" style="display:none;">${body}</div>` : ""}
        </li>`;
      }).join("");
      achievementsHtml += `<div class="status-label status-section-header" style="margin-bottom:8px;">Achievements</div><ul class="skill-accordion-list" style="margin-bottom:14px;">${achvAccordionItems}</ul>`;
    }
    if (jentries.length > 0) {
      const journalItems = [...jentries].reverse().map(
        (j) => `<li class="journal-entry">${escapeHtml(j.text)}</li>`
      ).join("");
      achievementsHtml += `<div class="status-label status-section-header" style="margin-bottom:8px;">Journal</div><ul class="journal-list">${journalItems}</ul>`;
    }
  }
  const tabs = [
    { key: "stats", label: "Stats" },
    { key: "skills", label: "Skills" },
    { key: "inventory", label: "Inv" },
    { key: "achievements", label: "Log" }
  ];
  const tabBarHtml = `<div class="status-tabs" id="status-tab-bar">
    ${tabs.map((t) => `<button class="status-tab ${_activeStatusTab === t.key ? "status-tab--active" : ""}" data-tab="${t.key}">${t.label}</button>`).join("")}
  </div>`;
  const contentMap = {
    stats: statsHtml,
    skills: skillsHtml,
    inventory: inventoryHtml,
    achievements: achievementsHtml
  };
  const panelHtml = `${tabBarHtml}<div class="status-tab-content" id="status-tab-pane">${contentMap[_activeStatusTab]}</div>`;
  _statusPanel.innerHTML = panelHtml;
  _statusPanel.querySelectorAll(".status-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      _activeStatusTab = btn.dataset.tab ?? "stats";
      _statusPanel.querySelectorAll(".status-tab").forEach(
        (b) => b.classList.toggle("status-tab--active", b.dataset.tab === _activeStatusTab)
      );
      const pane = _statusPanel.querySelector("#status-tab-pane");
      if (pane) pane.innerHTML = contentMap[_activeStatusTab];
      wireTabContent();
    });
  });
  wireTabContent();
  function wireTabContent() {
    const skillsStoreBtn = _statusPanel.querySelector("#status-store-btn-skills");
    if (skillsStoreBtn) skillsStoreBtn.addEventListener("click", () => showStore("skills"));
    const invStoreBtn = _statusPanel.querySelector("#status-store-btn-inv");
    if (invStoreBtn) invStoreBtn.addEventListener("click", () => showStore("items"));
    _statusPanel.querySelectorAll(".skill-accordion-btn").forEach((btn) => {
      const desc = btn.nextElementSibling;
      if (!desc) return;
      btn.addEventListener("click", () => {
        const isOpen = desc.style.display !== "none";
        desc.style.display = isOpen ? "none" : "block";
        btn.classList.toggle("skill-accordion-btn--open", !isOpen);
      });
    });
  }
}
var _storeTrapRelease = null;
var _storeActiveTab = "skills";
var _preStoreTab = null;
function showStore(tab = null) {
  if (!_storeOverlay) return;
  if (tab) _storeActiveTab = tab;
  _preStoreTab = _activeStatusTab;
  const overlay = _storeOverlay;
  overlay.classList.remove("hidden");
  requestAnimationFrame(() => {
    overlay.style.opacity = "1";
  });
  if (_trapFocus) {
    _storeTrapRelease = _trapFocus(overlay, null);
  }
  renderStore();
}
function hideStore() {
  if (!_storeOverlay) return;
  _storeOverlay.classList.add("hidden");
  _storeOverlay.style.opacity = "0";
  if (_storeTrapRelease) {
    _storeTrapRelease();
    _storeTrapRelease = null;
  }
  _activeStatusTab = _preStoreTab || (_storeActiveTab === "items" ? "inventory" : "skills");
  _preStoreTab = null;
  _scheduleStats2();
  requestAnimationFrame(() => {
    if (_statusPanel) {
      _statusPanel.classList.add("status-visible");
      _statusPanel.classList.remove("status-hidden");
    }
  });
}
function renderStore() {
  if (!_storeOverlay) return;
  const box = _storeOverlay.querySelector(".store-modal-box");
  if (!box) return;
  const essence = Number(playerState.essence || 0);
  box.innerHTML = `
    <div class="store-header">
      <span class="system-block-label">[ STORE ]</span>
      <div class="store-essence-pool">
        <span class="store-essence-label">Essence</span>
        <span class="store-essence-val">${essence}</span>
      </div>
      <button class="store-close-btn" id="store-close-btn">\u2715</button>
    </div>
    <div class="store-tabs">
      <button class="store-tab ${_storeActiveTab === "skills" ? "store-tab--active" : ""}" data-tab="skills">Skills</button>
      <button class="store-tab ${_storeActiveTab === "items" ? "store-tab--active" : ""}" data-tab="items">Items</button>
    </div>
    <div class="store-content" id="store-content"></div>`;
  box.querySelector("#store-close-btn")?.addEventListener("click", hideStore);
  box.querySelectorAll(".store-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      _storeActiveTab = tab.dataset.tab ?? "skills";
      renderStore();
    });
  });
  const content = box.querySelector("#store-content");
  if (!content) return;
  if (_storeActiveTab === "skills") {
    renderSkillsTab(content, essence);
  } else {
    renderItemsTab(content, essence);
  }
  requestAnimationFrame(() => {
    box.querySelector("#store-close-btn")?.focus({ preventScroll: true });
  });
}
function renderSkillsTab(container, essence) {
  if (skillRegistry.length === 0) {
    container.innerHTML = `<div class="store-empty">No skills available.</div>`;
    return;
  }
  const visible = skillRegistry.filter((s) => {
    if (!s.condition) return true;
    try {
      return !!evalValue(s.condition);
    } catch {
      return true;
    }
  });
  const available = visible.filter((s) => !playerHasSkill(s.key));
  const owned = visible.filter((s) => playerHasSkill(s.key));
  let html = "";
  if (available.length > 0) {
    html += `<div class="store-section-label">Available</div>`;
    available.forEach((skill) => {
      const canAfford = essence >= skill.essenceCost;
      const cardCls = canAfford ? "" : "store-card--unaffordable";
      const badgeCls = canAfford ? "store-cost-badge--can-afford" : "";
      const rarity = skill.rarity || "common";
      const rarCls = ` skill-rarity--${rarity}`;
      html += `
        <div class="store-card ${cardCls}" data-key="${escapeHtml(skill.key)}" data-type="skill">
          <div class="store-card-top">
            <span class="store-card-name${rarCls}">${escapeHtml(skill.label)}</span>
            <div class="store-card-actions">
              <span class="store-cost-badge ${badgeCls}">${skill.essenceCost} Essence</span>
              <button class="store-purchase-btn" ${canAfford ? "" : "disabled"} data-key="${escapeHtml(skill.key)}" data-type="skill">Unlock</button>
            </div>
          </div>
          <div class="store-card-desc">${escapeHtml(skill.description)}</div>
        </div>`;
    });
  }
  if (owned.length > 0) {
    html += `<div class="store-section-label store-section-label--owned">Owned</div>`;
    owned.forEach((skill) => {
      const rarity = skill.rarity || "common";
      const rarCls = ` skill-rarity--${rarity}`;
      html += `
        <div class="store-card store-card--owned" data-key="${escapeHtml(skill.key)}">
          <div class="store-card-top">
            <span class="store-card-name${rarCls}">${escapeHtml(skill.label)}</span>
            <div class="store-card-actions">
              <span class="store-owned-badge">Owned</span>
            </div>
          </div>
          <div class="store-card-desc">${escapeHtml(skill.description)}</div>
        </div>`;
    });
  }
  if (available.length === 0 && owned.length === 0) {
    html = `<div class="store-empty">No skills available.</div>`;
  }
  container.innerHTML = html;
  container.querySelectorAll(".store-purchase-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key ?? "";
      if (purchaseSkill(key)) {
        _showToast(`Skill unlocked: ${skillRegistry.find((s) => s.key === key)?.label || key}`);
        renderStore();
      }
    });
  });
}
function renderItemsTab(container, essence) {
  if (itemRegistry.length === 0) {
    container.innerHTML = `<div class="store-empty">No items available.</div>`;
    return;
  }
  const visible = itemRegistry.filter((item) => {
    if (!item.condition) return true;
    try {
      return !!evalValue(item.condition);
    } catch {
      return true;
    }
  });
  if (visible.length === 0) {
    container.innerHTML = `<div class="store-empty">No items available.</div>`;
    return;
  }
  let html = "";
  visible.forEach((item) => {
    const canAfford = essence >= item.essenceCost;
    const cardCls = canAfford ? "" : "store-card--unaffordable";
    const badgeCls = canAfford ? "store-cost-badge--can-afford" : "";
    const rarity = item.rarity || "common";
    const rarCls = ` skill-rarity--${rarity}`;
    html += `
      <div class="store-card ${cardCls}" data-key="${escapeHtml(item.key)}" data-type="item">
        <div class="store-card-top">
          <span class="store-card-name${rarCls}">${escapeHtml(item.label)}</span>
          <div class="store-card-actions">
            <span class="store-cost-badge ${badgeCls}">${item.essenceCost} Essence</span>
            <button class="store-purchase-btn" ${canAfford ? "" : "disabled"} data-key="${escapeHtml(item.key)}" data-type="item">Buy</button>
          </div>
        </div>
        <div class="store-card-desc">${escapeHtml(item.description)}</div>
      </div>`;
  });
  container.innerHTML = html;
  container.querySelectorAll(".store-purchase-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key ?? "";
      if (purchaseItem(key)) {
        _showToast(`Purchased: ${itemRegistry.find((i) => i.key === key)?.label || key}`);
        renderStore();
      }
    });
  });
}
function showEndingScreen(title, content) {
  if (!_endingOverlay) return;
  if (_endingTitle) _endingTitle.textContent = title;
  if (_endingContent) _endingContent.textContent = content;
  const statsLines = [];
  statRegistry.forEach(({ key, label }) => {
    statsLines.push(`${label}: ${playerState[key] ?? "\u2014"}`);
  });
  if (_endingStats) _endingStats.textContent = statsLines.join("  \xB7  ");
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

// src/ui/overlays.ts
var _splashOverlay;
var _splashSlots;
var _saveOverlay;
var _saveBtn;
var _charOverlay;
var _inputFirstName;
var _inputLastName;
var _counterFirst;
var _counterLast;
var _errorFirstName;
var _errorLastName;
var _charBeginBtn;
var _toast;
var _runStatsScene;
var _fetchTextFile2;
var _evalValue;
var _renderFromLog;
var _renderChoices;
var _runInterpreter2;
var _clearNarrative;
var _applyTransition;
var _setChapterTitle;
var _parseAndCacheScene;
var _clearUndoStack = null;
var _setChoiceArea = null;
var _setGameTitle = null;
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
  renderFromLog: renderFromLog2,
  renderChoices: renderChoices2,
  runInterpreter: runInterpreter2,
  clearNarrative: clearNarrative2,
  applyTransition: applyTransition2,
  setChapterTitle: setChapterTitle2,
  parseAndCacheScene,
  setChoiceArea: setChoiceArea2,
  clearUndoStack,
  setGameTitle: setGameTitle2
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
  _runInterpreter2 = runInterpreter2;
  _clearNarrative = clearNarrative2;
  _applyTransition = applyTransition2;
  _setChapterTitle = setChapterTitle2;
  _parseAndCacheScene = parseAndCacheScene;
  _clearUndoStack = clearUndoStack || null;
  _setChoiceArea = setChoiceArea2 || null;
  _setGameTitle = setGameTitle2 || null;
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
var _toastQueue = [];
var _toastActive = false;
function _processToastQueue() {
  if (_toastActive || _toastQueue.length === 0) return;
  _toastActive = true;
  const { message, durationMs } = _toastQueue.shift();
  _toast.textContent = message;
  _toast.className = _toast.className.split(" ").filter((c) => c === "toast" || c === "hidden").join(" ");
  _toast.classList.remove("hidden", "toast-hide");
  _toast.classList.add("toast-show");
  setTimeout(() => {
    _toast.classList.replace("toast-show", "toast-hide");
    setTimeout(() => {
      _toast.classList.add("hidden");
      _toastActive = false;
      _processToastQueue();
    }, 300);
  }, durationMs);
}
function showToast(message, durationMs = 4e3) {
  _toastQueue.push({ message, durationMs });
  setTimeout(_processToastQueue, 0);
}
function populateSlotCard({ nameEl, metaEl, loadBtn, deleteBtn, cardEl, save }) {
  const lbtn = loadBtn;
  if (save) {
    const d = new Date(save.timestamp);
    const sceneDisplay = save.label ? save.label : save.scene.replace(/\.txt$/i, "").toUpperCase();
    if (metaEl) metaEl.textContent = `${sceneDisplay} \xB7 ${d.toLocaleDateString(void 0, { month: "short", day: "numeric", year: "numeric" })}`;
    if (nameEl) nameEl.textContent = save.characterName || "Unknown";
    if (lbtn) lbtn.disabled = false;
    cardEl.classList.remove("slot-card--empty");
    if (deleteBtn) deleteBtn.classList.remove("hidden");
  } else {
    if (nameEl) nameEl.textContent = "\u2014 Empty \u2014";
    if (metaEl) metaEl.textContent = "";
    if (lbtn) lbtn.disabled = true;
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
    if (iCard) populateSlotCard({
      nameEl: document.getElementById(`save-slot-name-${s}`),
      metaEl: document.getElementById(`save-slot-meta-${s}`),
      loadBtn: document.getElementById(`ingame-load-${s}`),
      deleteBtn: document.getElementById(`save-delete-${s}`),
      cardEl: iCard,
      save
    });
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
    runInterpreter: _runInterpreter2,
    clearNarrative: _clearNarrative,
    applyTransition: _applyTransition,
    setChapterTitle: _setChapterTitle,
    setChoiceArea: _setChoiceArea,
    parseAndCacheScene: _parseAndCacheScene,
    fetchTextFileFn: _fetchTextFile2,
    evalValueFn: _evalValue
  });
  if (_setGameTitle) {
    const ps = save.playerState || {};
    const title = ps.game_title || "System Awakening";
    _setGameTitle(title);
  }
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
      const pos = (inputEl.selectionStart ?? 0) - (inputEl.value.length - cleaned.length);
      inputEl.value = cleaned;
      try {
        inputEl.setSelectionRange(pos, pos);
      } catch (_) {
      }
    }
    counterEl.textContent = String(NAME_MAX - inputEl.value.length);
    const err = validateName(inputEl.value.trim() === "" ? "" : inputEl.value, fieldLabel);
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
    const overlay = _charOverlay;
    if (typeof overlay._trapRelease === "function") {
      overlay._trapRelease();
      overlay._trapRelease = null;
    }
    if (typeof overlay._resolve === "function") {
      overlay._resolve({
        firstName: _inputFirstName.value.trim(),
        lastName: _inputLastName.value.trim(),
        pronouns_subject: selected.dataset.subject,
        pronouns_object: selected.dataset.object,
        pronouns_possessive: selected.dataset.possessive,
        pronouns_possessive_pronoun: selected.dataset.possessivePronoun,
        pronouns_reflexive: selected.dataset.reflexive,
        pronouns_label: selected.dataset.pronouns
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
    try {
      _inputFirstName.focus();
    } catch (_) {
    }
  });
  return new Promise((resolve) => {
    _charOverlay._resolve = resolve;
  });
}

// engine.ts
var dom = {
  narrativeContent: document.getElementById("narrative-content"),
  choiceArea: document.getElementById("choice-area"),
  chapterTitle: document.getElementById("chapter-title"),
  narrativePanel: document.getElementById("narrative-panel"),
  statusPanel: document.getElementById("status-panel"),
  statusToggle: document.getElementById("status-toggle"),
  saveBtn: document.getElementById("save-btn"),
  gameTitle: document.getElementById("game-title"),
  splashTitle: document.querySelector(".splash-title"),
  splashTagline: document.getElementById("splash-tagline"),
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
  storeOverlay: document.getElementById("store-overlay"),
  toast: document.getElementById("toast")
};
Object.entries(dom).forEach(([key, el]) => {
  if (!el) console.warn(`[engine] DOM element missing: "${key}" \u2014 check index.html IDs`);
});
var sceneCache = /* @__PURE__ */ new Map();
var labelsCache = /* @__PURE__ */ new Map();
function setChapterTitle(t) {
  if (dom.chapterTitle) dom.chapterTitle.textContent = t;
  setChapterTitleState(t);
}
function setGameTitle(t) {
  if (dom.gameTitle) dom.gameTitle.textContent = t;
  if (dom.splashTitle) dom.splashTitle.textContent = t;
  document.title = t;
}
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
  dom.narrativeContent?.insertBefore(div, dom.choiceArea);
  if (dom.chapterTitle) dom.chapterTitle.textContent = "ERROR";
}
var _undoStack = [];
var UNDO_MAX = 10;
function pushUndoSnapshot() {
  _undoStack.push({
    playerState: JSON.parse(JSON.stringify(playerState)),
    tempState: JSON.parse(JSON.stringify(tempState)),
    scene: currentScene,
    ip,
    narrativeLog: JSON.parse(JSON.stringify(getNarrativeLog())),
    chapterTitle: dom.chapterTitle?.textContent ?? null,
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
  if (snap.scene) setCurrentScene(snap.scene);
  if (snap.scene) {
    const text = sceneCache.get(snap.scene.endsWith(".txt") ? snap.scene : `${snap.scene}.txt`);
    if (text) {
      setCurrentLines(parseLines(text));
      indexLabels(snap.scene, currentLines, labelsCache);
    }
  }
  setIp(snap.ip);
  setAwaitingChoice(null);
  if (dom.chapterTitle) dom.chapterTitle.textContent = snap.chapterTitle;
  setChapterTitleState(snap.chapterTitle ?? "");
  renderFromLog(snap.narrativeLog, { skipAnimations: true });
  if (snap.awaitingChoice) {
    setAwaitingChoice(snap.awaitingChoice);
    renderChoices(snap.awaitingChoice.choices);
  }
  runStatsScene();
  updateUndoBtn();
}
function updateUndoBtn() {
  const btn = document.getElementById("undo-btn");
  if (!btn) return;
  btn.disabled = _undoStack.length === 0;
}
function wireUI() {
  dom.statusToggle?.addEventListener("click", () => {
    const visible = dom.statusPanel?.classList.toggle("status-visible");
    dom.statusPanel?.classList.toggle("status-hidden", !visible);
    runStatsScene();
  });
  document.addEventListener("click", (e) => {
    if (!dom.statusPanel?.contains(e.target) && e.target !== dom.statusToggle && !dom.storeOverlay?.contains(e.target)) {
      dom.statusPanel?.classList.remove("status-visible");
      dom.statusPanel?.classList.add("status-hidden");
    }
  });
  dom.saveBtn?.addEventListener("click", showSaveMenu);
  dom.saveMenuClose?.addEventListener("click", hideSaveMenu);
  dom.saveOverlay?.addEventListener("click", (e) => {
    if (e.target === dom.saveOverlay) hideSaveMenu();
  });
  dom.saveOverlay?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideSaveMenu();
  });
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
  dom.splashNewBtn?.addEventListener("click", async () => {
    hideSplash();
    const charData = await showCharacterCreation();
    patchPlayerState({
      first_name: charData.firstName,
      last_name: charData.lastName,
      pronouns_subject: charData.pronouns_subject,
      pronouns_object: charData.pronouns_object,
      pronouns_possessive: charData.pronouns_possessive,
      pronouns_possessive_pronoun: charData.pronouns_possessive_pronoun,
      pronouns_reflexive: charData.pronouns_reflexive,
      pronouns_label: charData.pronouns_label
    });
    dom.saveBtn?.classList.remove("hidden");
    document.getElementById("undo-btn")?.classList.remove("hidden");
    _undoStack.splice(0);
    updateUndoBtn();
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || "prologue");
  });
  dom.splashLoadBtn?.addEventListener("click", () => {
    dom.splashOverlay?.querySelector(".splash-btn-col")?.classList.add("hidden");
    dom.splashSlots?.classList.remove("hidden");
    refreshAllSlotCards();
  });
  dom.splashSlotsBack?.addEventListener("click", () => {
    dom.splashSlots?.classList.add("hidden");
    dom.splashOverlay?.querySelector(".splash-btn-col")?.classList.remove("hidden");
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
      const slotEl = document.getElementById("save-import-slot");
      const targetSlot = Number(slotEl?.value || 1);
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
  const codeCopyBtn = document.getElementById("save-code-copy");
  if (codeCopyBtn) {
    codeCopyBtn.addEventListener("click", () => {
      const code = encodeSaveCode(getNarrativeLog());
      const field = document.getElementById("save-code-field");
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code).then(() => {
          showToast("Save code copied to clipboard.");
          if (field) field.value = code;
        }).catch(() => {
          if (field) {
            field.value = code;
            field.select();
          }
          showToast("Code generated \u2014 copy it from the text box.");
        });
      } else {
        if (field) {
          field.value = code;
          field.select();
        }
        showToast("Code generated \u2014 copy it from the text box.");
      }
    });
  }
  const codeLoadBtn = document.getElementById("save-code-load");
  if (codeLoadBtn) {
    codeLoadBtn.addEventListener("click", async () => {
      const field = document.getElementById("save-code-field");
      const code = field?.value?.trim();
      if (!code) {
        showToast("Paste a save code first.");
        return;
      }
      const result = decodeSaveCode(code);
      if (!result.ok) {
        showToast(`Load failed: ${result.reason}`);
        return;
      }
      hideSaveMenu();
      await loadAndResume(result.save);
      showToast("Save code loaded successfully.");
    });
  }
}
async function boot() {
  registerCaches(sceneCache, labelsCache);
  init({
    narrativeContent: dom.narrativeContent,
    choiceArea: dom.choiceArea,
    narrativePanel: dom.narrativePanel,
    scheduleStatsRender,
    onBeforeChoice: pushUndoSnapshot,
    executeBlock,
    runInterpreter
  });
  init2({
    statusPanel: dom.statusPanel,
    endingOverlay: dom.endingOverlay,
    endingTitle: dom.endingTitle,
    endingContent: dom.endingContent,
    endingStats: dom.endingStats,
    endingActionBtn: dom.endingActionBtn,
    storeOverlay: dom.storeOverlay,
    fetchTextFile,
    scheduleStatsRender,
    trapFocus,
    showToast
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
    runInterpreter,
    clearNarrative,
    applyTransition,
    setChapterTitle,
    parseAndCacheScene: async (name) => {
      const text = await fetchTextFile(name);
      setCurrentLines(parseLines(text));
      indexLabels(name, currentLines, labelsCache);
    },
    setChoiceArea: (el) => {
      dom.choiceArea = el;
      if (el) setChoiceArea(el);
    },
    clearUndoStack: () => {
      _undoStack.splice(0);
      updateUndoBtn();
    },
    setGameTitle
  });
  registerCallbacks({
    addParagraph,
    addSystem,
    clearNarrative,
    applyTransition,
    renderChoices,
    showEndingScreen,
    showEngineError,
    showInputPrompt,
    showPageBreak,
    scheduleStatsRender,
    showToast,
    formatText,
    setChapterTitle,
    setGameTitle,
    setGameByline: (t) => {
      if (dom.splashTagline) dom.splashTagline.innerHTML = t;
    },
    runStatsScene,
    fetchTextFile,
    getNarrativeLog
  });
  wireUI();
  try {
    await parseStartup(fetchTextFile, evalValue);
    captureStartupDefaults();
    await parseSkills(fetchTextFile);
    await parseItems(fetchTextFile);
    const title = playerState.game_title || "";
    const byline = playerState.game_byline || "";
    setGameTitle(title);
    if (dom.splashTagline && byline) dom.splashTagline.innerHTML = byline;
    showSplash();
  } catch (err) {
    showEngineError(`Boot failed: ${err.message}`);
  }
}
document.addEventListener("DOMContentLoaded", boot);
//# sourceMappingURL=engine.js.map
