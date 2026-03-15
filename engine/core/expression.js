// ---------------------------------------------------------------------------
// core/expression.js — Safe expression evaluator
//
// FIX #7: evalValue now returns 0 (falsy) on parse error instead of the raw
//   expression string (which was truthy and caused conditions to "fail open" —
//   e.g. a malformed *selectable_if condition would always enable the choice).
//
// FIX #8: parseOr and parseAnd no longer short-circuit token consumption.
//   Previously: `left = left || parseAnd()` — if left was truthy, parseAnd()
//   was never called, so its tokens were never consumed, corrupting the token
//   stream for subsequent expressions (e.g. `flag or random(1,6) > 3` would
//   leave `random(1,6) > 3` unconsumed and throw or misparse on the next call).
//   Now: the right-hand side is ALWAYS fully parsed before the boolean is
//   applied, matching how all other binary operators are handled.
// ---------------------------------------------------------------------------

import { playerState, tempState, sessionState, normalizeKey } from './state.js';

const TT = {
  NUM: 'NUM', STR: 'STR', BOOL: 'BOOL', IDENT: 'IDENT',
  LBRACKET: '[', RBRACKET: ']', LPAREN: '(', RPAREN: ')',
  PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/',
  LT: '<', GT: '>', LTE: '<=', GTE: '>=', EQ: '=', NEQ: '!=',
  AND: 'AND', OR: 'OR', NOT: 'NOT',
  COMMA: ',',
  EOF: 'EOF',
};

function tokenise(src) {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }

    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++;
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

    if (src[i] === '<' && src[i + 1] === '=') { tokens.push({ type: TT.LTE, value: '<=' }); i += 2; continue; }
    if (src[i] === '>' && src[i + 1] === '=') { tokens.push({ type: TT.GTE, value: '>=' }); i += 2; continue; }
    if (src[i] === '!' && src[i + 1] === '=') { tokens.push({ type: TT.NEQ, value: '!=' }); i += 2; continue; }
    if (src[i] === '&' && src[i + 1] === '&') { tokens.push({ type: TT.AND, value: 'and' }); i += 2; continue; }
    if (src[i] === '|' && src[i + 1] === '|') { tokens.push({ type: TT.OR,  value: 'or'  }); i += 2; continue; }
    if (src[i] === '=' && src[i + 1] === '=') { tokens.push({ type: TT.EQ,  value: '='   }); i += 2; continue; }

    const SINGLE = {
      '+': TT.PLUS,  '-': TT.MINUS, '*': TT.STAR, '/': TT.SLASH,
      '<': TT.LT,    '>': TT.GT,    '=': TT.EQ,
      '(': TT.LPAREN, ')': TT.RPAREN, '[': TT.LBRACKET, ']': TT.RBRACKET,
      '!': TT.NOT,   ',': TT.COMMA,
    };
    if (SINGLE[src[i]]) { tokens.push({ type: SINGLE[src[i]], value: src[i] }); i++; continue; }

    if (/[a-zA-Z_]/.test(src[i])) {
      let j = i;
      while (j < src.length && /[\w]/.test(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === 'true')  { tokens.push({ type: TT.BOOL,  value: true  }); i = j; continue; }
      if (lower === 'false') { tokens.push({ type: TT.BOOL,  value: false }); i = j; continue; }
      if (lower === 'and')   { tokens.push({ type: TT.AND,   value: 'and' }); i = j; continue; }
      if (lower === 'or')    { tokens.push({ type: TT.OR,    value: 'or'  }); i = j; continue; }
      if (lower === 'not')   { tokens.push({ type: TT.NOT,   value: 'not' }); i = j; continue; }
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

  function peek()    { return tokens[pos]; }
  function advance() { return tokens[pos++]; }
  function expect(type) {
    if (peek().type !== type) {
      throw new Error(`[expression] Expected ${type} but got ${peek().type}`);
    }
    return advance();
  }

  function parseExpr() { return parseOr(); }

  // FIX #8: Always consume the right-hand side before applying the boolean,
  // so the token stream is never left in a partially-consumed state when the
  // left operand already determines the result. This is necessary because
  // the right side may contain function calls (e.g. random()) that must
  // consume their argument tokens regardless of the boolean outcome.
  function parseOr() {
    let left = parseAnd();
    while (peek().type === TT.OR) {
      advance();
      const right = parseAnd(); // always consume, even if left is already truthy
      left = left || right;
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek().type === TT.AND) {
      advance();
      const right = parseNot(); // always consume, even if left is already falsy
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
      /* eslint-disable eqeqeq */
      if (op === TT.LT)  left = left <  right;
      if (op === TT.GT)  left = left >  right;
      if (op === TT.LTE) left = left <= right;
      if (op === TT.GTE) left = left >= right;
      if (op === TT.EQ)  left = left == right;
      if (op === TT.NEQ) left = left != right;
      /* eslint-enable eqeqeq */
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
        console.warn('[expression] Division by zero — returning 0');
        left = 0;
      } else {
        left = op === TT.STAR ? left * right : left / right;
      }
    }
    return left;
  }

  function parseUnary() {
    if (peek().type === TT.MINUS) { advance(); return -parseUnary(); }
    if (peek().type === TT.NOT)   { advance(); return !parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();

    if (tok.type === TT.NUM)  { advance(); return tok.value; }
    if (tok.type === TT.STR)  { advance(); return tok.value; }
    if (tok.type === TT.BOOL) { advance(); return tok.value; }

    if (tok.type === TT.LBRACKET) {
      advance();
      if (peek().type === TT.RBRACKET) { advance(); return []; }
      throw new Error('[expression] Non-empty array literals not supported');
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
      if (Object.prototype.hasOwnProperty.call(tempState,    key)) return tempState[key];
      if (Object.prototype.hasOwnProperty.call(sessionState, key)) return sessionState[key]; // ENH-08
      if (Object.prototype.hasOwnProperty.call(playerState,  key)) return playerState[key];
      return tok.value; // unknown ident → string fallback
    }

    throw new Error(`[expression] Unexpected token ${tok.type}`);
  }

  function parseArgList() {
    const args = [];
    if (peek().type === TT.RPAREN) { advance(); return args; }
    args.push(parseExpr());
    while (peek().type === TT.COMMA) { advance(); args.push(parseExpr()); }
    expect(TT.RPAREN);
    return args;
  }

  const BUILTINS = {
    random: (args) => {
      const lo = Math.ceil(Number(args[0]  ?? 1));
      const hi = Math.floor(Number(args[1] ?? lo));
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    },
    round: (args) => Math.round(Number(args[0] ?? 0)),
    floor: (args) => Math.floor(Number(args[0] ?? 0)),
    ceil:  (args) => Math.ceil(Number(args[0] ?? 0)),
    abs:   (args) => Math.abs(Number(args[0] ?? 0)),
    min:   (args) => Math.min(...args.map(Number)),
    max:   (args) => Math.max(...args.map(Number)),
    length: (args) => {
      const v = args[0];
      if (Array.isArray(v)) return v.length;
      return String(v ?? '').length;
    },
  };

  function parseFunction(name) {
    const lower = name.toLowerCase();
    const fn    = BUILTINS[lower];
    if (!fn) {
      console.warn(`[expression] Unknown function "${name}" — returning 0`);
      parseArgList();
      return 0;
    }
    return fn(parseArgList());
  }

  return { parseExpr };
}

export function evalValue(expr) {
  const trimmed = expr.trim();
  if (/^"[^"]*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === '[]') return [];
  try {
    const tokens = tokenise(trimmed);
    const parser = makeParser(tokens);
    return parser.parseExpr();
  } catch (err) {
    // FIX #7: Return 0 (falsy) on parse error instead of the raw expression
    // string (which was truthy, causing broken conditions to "fail open" —
    // e.g. a malformed *selectable_if condition would always enable the choice).
    console.warn(`[expression] Parse error in "${trimmed}": ${err.message}`);
    return 0;
  }
}
