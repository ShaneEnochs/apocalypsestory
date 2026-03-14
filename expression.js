// ---------------------------------------------------------------------------
// core/expression.js — Safe expression evaluator
//
// Replaces the original evalValue() which used the Function() constructor
// (a code injection risk). This is a recursive descent parser supporting the
// full expression grammar used in scene files.
//
// Supported:
//   Literals:    number (42, 3.14), string ("hello"), boolean (true/false), [] (empty array)
//   Variables:   looked up in tempState first, then playerState
//   Arithmetic:  + - * /
//   Comparison:  < > <= >= = != (= is equality, not assignment)
//   Logical:     and or not  (also &&  ||  !)
//   Grouping:    (expr)
//
// Entry point: evalValue(expr, playerState, tempState)
// The function is exported both as a named export and wrapped so engine.js
// can call it in its original single-argument form via a closure over state.
// ---------------------------------------------------------------------------

import { playerState, tempState, normalizeKey } from './state.js';

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------
const TT = {
  NUM: 'NUM', STR: 'STR', BOOL: 'BOOL', IDENT: 'IDENT',
  LBRACKET: '[', RBRACKET: ']', LPAREN: '(', RPAREN: ')',
  PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/',
  LT: '<', GT: '>', LTE: '<=', GTE: '>=', EQ: '=', NEQ: '!=',
  AND: 'AND', OR: 'OR', NOT: 'NOT',
  EOF: 'EOF',
};

function tokenise(src) {
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    // Whitespace
    if (/\s/.test(src[i])) { i++; continue; }

    // String literal
    if (src[i] === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++; // skip escape
        j++;
      }
      tokens.push({ type: TT.STR, value: src.slice(i + 1, j).replace(/\\"/g, '"') });
      i = j + 1;
      continue;
    }

    // Number
    if (/[0-9]/.test(src[i]) || (src[i] === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      // Only treat leading '-' as part of the number if there's no preceding
      // token that could produce a value (i.e. this is unary minus at start).
      const isUnary = src[i] === '-' && tokens.length === 0;
      if (src[i] === '-' && !isUnary) {
        tokens.push({ type: TT.MINUS, value: '-' });
        i++;
        continue;
      }
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ type: TT.NUM, value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }

    // Two-character operators
    if (src[i] === '<' && src[i + 1] === '=') { tokens.push({ type: TT.LTE, value: '<=' }); i += 2; continue; }
    if (src[i] === '>' && src[i + 1] === '=') { tokens.push({ type: TT.GTE, value: '>=' }); i += 2; continue; }
    if (src[i] === '!' && src[i + 1] === '=') { tokens.push({ type: TT.NEQ, value: '!=' }); i += 2; continue; }
    if (src[i] === '&' && src[i + 1] === '&') { tokens.push({ type: TT.AND, value: 'and' }); i += 2; continue; }
    if (src[i] === '|' && src[i + 1] === '|') { tokens.push({ type: TT.OR,  value: 'or'  }); i += 2; continue; }
    // ==  →  treat as =  (equality)
    if (src[i] === '=' && src[i + 1] === '=') { tokens.push({ type: TT.EQ,  value: '='   }); i += 2; continue; }

    // Single-character operators and brackets
    const SINGLE = {
      '+': TT.PLUS,  '-': TT.MINUS, '*': TT.STAR, '/': TT.SLASH,
      '<': TT.LT,    '>': TT.GT,    '=': TT.EQ,
      '(': TT.LPAREN, ')': TT.RPAREN, '[': TT.LBRACKET, ']': TT.RBRACKET,
      '!': TT.NOT,
    };
    if (SINGLE[src[i]]) { tokens.push({ type: SINGLE[src[i]], value: src[i] }); i++; continue; }

    // Identifier or keyword
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

    // Unknown character — skip with a warning
    console.warn(`[expression] Unexpected character '${src[i]}' in expression: ${src}`);
    i++;
  }

  tokens.push({ type: TT.EOF });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — recursive descent, standard precedence levels
// ---------------------------------------------------------------------------
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

  // or-expr
  function parseExpr() { return parseOr(); }

  function parseOr() {
    let left = parseAnd();
    while (peek().type === TT.OR) { advance(); left = left || parseAnd(); }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek().type === TT.AND) { advance(); left = left && parseNot(); }
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
      if (op === TT.EQ)  left = left == right;   // intentional loose equality (matches old behaviour)
      if (op === TT.NEQ) left = left != right;   // intentional loose inequality
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
      left = op === TT.STAR ? left * right : left / right;
    }
    return left;
  }

  function parseUnary() {
    if (peek().type === TT.MINUS) { advance(); return -parsePrimary(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();

    if (tok.type === TT.NUM)  { advance(); return tok.value; }
    if (tok.type === TT.STR)  { advance(); return tok.value; }
    if (tok.type === TT.BOOL) { advance(); return tok.value; }

    // Empty array literal []
    if (tok.type === TT.LBRACKET) {
      advance();
      expect(TT.RBRACKET);
      return [];
    }

    // Grouping
    if (tok.type === TT.LPAREN) {
      advance();
      const val = parseExpr();
      expect(TT.RPAREN);
      return val;
    }

    // Variable lookup: tempState first, then playerState
    if (tok.type === TT.IDENT) {
      advance();
      const k = normalizeKey(tok.value);
      if (Object.prototype.hasOwnProperty.call(tempState,   k)) return tempState[k];
      if (Object.prototype.hasOwnProperty.call(playerState, k)) return playerState[k];
      // Identifier not found — return as string (matches original fallback behaviour)
      return tok.value;
    }

    // Unexpected token — return undefined and warn
    console.warn(`[expression] Unexpected token ${tok.type} in expression`);
    advance();
    return undefined;
  }

  return { parseExpr };
}

// ---------------------------------------------------------------------------
// evalValue — main entry point
//
// Accepts a raw expression string and returns the evaluated value.
// Strings that are just a quoted literal are unwrapped directly (fast path).
// On parse error, falls back to returning the trimmed string (same as the
// original Function() implementation's fallback).
// ---------------------------------------------------------------------------
export function evalValue(expr) {
  const trimmed = expr.trim();

  // Fast path: bare quoted string
  if (/^"[^"]*"$/.test(trimmed)) return trimmed.slice(1, -1);

  // Fast path: empty array literal
  if (trimmed === '[]') return [];

  try {
    const tokens = tokenise(trimmed);
    const parser = makeParser(tokens);
    return parser.parseExpr();
  } catch (err) {
    console.warn(`[expression] Parse error in "${trimmed}": ${err.message}`);
    // Graceful fallback: strip surrounding quotes if present, return as string
    return trimmed.replace(/^"|"$/g, '');
  }
}