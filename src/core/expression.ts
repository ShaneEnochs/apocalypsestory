// core/expression.js — Safe expression evaluator
//
// Parses and evaluates authoring-language expressions used in *if, *set,
// *selectable_if, and similar directives. Returns 0 (falsy) on any parse
// error so broken conditions fail closed rather than open.
//
// Supports: numbers, strings, booleans, variables, arithmetic (+−*/),
// comparisons (<, >, <=, >=, =, !=), logical operators (and, or, not),
// and built-in functions (random, round, floor, ceil, abs, min, max, length).
//
// Boolean operators always fully consume both sides of the expression before
// applying the result, so function calls inside or/and branches never leave
// unconsumed tokens in the stream.

import { playerState, tempState, normalizeKey, resolveStore } from './state.js';

interface Token {
  type:   string;
  value?: string | number | boolean;
}

const TT = {
  NUM: 'NUM', STR: 'STR', BOOL: 'BOOL', IDENT: 'IDENT',
  LBRACKET: '[', RBRACKET: ']', LPAREN: '(', RPAREN: ')',
  PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/',
  LT: '<', GT: '>', LTE: '<=', GTE: '>=', EQ: '=', NEQ: '!=',
  AND: 'AND', OR: 'OR', NOT: 'NOT',
  COMMA: ',',
  EOF: 'EOF',
};

function tokenise(src: string): Token[] {
  const tokens: Token[] = [];
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
    if ((SINGLE as Record<string, string>)[src[i]]) { tokens.push({ type: (SINGLE as Record<string, string>)[src[i]], value: src[i] }); i++; continue; }

    if (/[a-zA-Z_]/.test(src[i])) {
      let j = i;
      while (j < src.length && /[\w]/.test(src[j])) j++;
      const word  = src.slice(i, j);
      const lower = word.toLowerCase();
      if (lower === 'true')  { tokens.push({ type: TT.BOOL, value: true  }); i = j; continue; }
      if (lower === 'false') { tokens.push({ type: TT.BOOL, value: false }); i = j; continue; }
      if (lower === 'and')   { tokens.push({ type: TT.AND,  value: 'and' }); i = j; continue; }
      if (lower === 'or')    { tokens.push({ type: TT.OR,   value: 'or'  }); i = j; continue; }
      if (lower === 'not')   { tokens.push({ type: TT.NOT,  value: 'not' }); i = j; continue; }
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

function makeParser(tokens: Token[]): { parseExpr: () => unknown } {
  let pos = 0;

  function peek():    Token { return tokens[pos]; }
  function advance(): Token { return tokens[pos++]; }
  function expect(type: string): Token {
    if (peek().type !== type) {
      throw new Error(`[expression] Expected ${type} but got ${peek().type}`);
    }
    return advance();
  }

  function parseExpr(): unknown { return parseOr(); }

  // Both sides are always fully parsed before the boolean is applied so that
  // function calls inside or/and branches consume their tokens regardless of
  // whether the short-circuit result is already determined.
  function parseOr(): unknown {
    let left: unknown = parseAnd();
    while (peek().type === TT.OR) {
      advance();
      const right = parseAnd();
      left = left || right;
    }
    return left;
  }

  function parseAnd(): unknown {
    let left: unknown = parseNot();
    while (peek().type === TT.AND) {
      advance();
      const right = parseNot();
      left = left && right;
    }
    return left;
  }

  function parseNot(): unknown {
    if (peek().type === TT.NOT) {
      advance();
      return !parseNot();
    }
    return parseComparison();
  }

  function parseComparison(): unknown {
    let left: unknown = parseAddSub();
    const CMP = [TT.LT, TT.GT, TT.LTE, TT.GTE, TT.EQ, TT.NEQ];
    while (CMP.includes(peek().type)) {
      const op    = advance().type;
      const right = parseAddSub();
      if (op === TT.LT)  left = (left as any) <   (right as any);
      if (op === TT.GT)  left = (left as any) >   (right as any);
      if (op === TT.LTE) left = (left as any) <=  (right as any);
      if (op === TT.GTE) left = (left as any) >=  (right as any);
      if (op === TT.EQ)  left = (left as any) === (right as any);
      if (op === TT.NEQ) left = (left as any) !== (right as any);
    }
    return left;
  }

  function parseAddSub(): unknown {
    let left: unknown = parseMulDiv();
    while (peek().type === TT.PLUS || peek().type === TT.MINUS) {
      const op    = advance().type;
      const right = parseMulDiv();
      left = op === TT.PLUS ? (left as any) + (right as any) : (left as any) - (right as any);
    }
    return left;
  }

  function parseMulDiv(): unknown {
    let left: unknown = parseUnary();
    while (peek().type === TT.STAR || peek().type === TT.SLASH) {
      const op    = advance().type;
      const right = parseUnary();
      if (op === TT.SLASH && right === 0) {
        console.warn('[expression] Division by zero — returning 0');
        left = 0;
      } else {
        left = op === TT.STAR ? (left as any) * (right as any) : (left as any) / (right as any);
      }
    }
    return left;
  }

  function parseUnary(): unknown {
    if (peek().type === TT.MINUS) { advance(); return -(parseUnary() as number); }
    if (peek().type === TT.NOT)   { advance(); return !parseUnary(); }
    return parsePrimary();
  }

  function parsePrimary(): unknown {
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
      const val: unknown = parseExpr();
      expect(TT.RPAREN);
      return val;
    }

    if (tok.type === TT.IDENT) {
      advance();
      if (peek().type === TT.LPAREN) {
        advance();
        return parseFunction(tok.value as string);
      }
      const key   = normalizeKey(tok.value as string);
      const store = resolveStore(key);
      if (store !== null) return store[key];
      // Unknown identifiers return 0 (falsy) so *if conditions with typos
      // fail closed rather than silently evaluating to true.
      console.warn(`[expression] Unknown variable "${tok.value}" — returning 0. Check for typos in scene files.`);
      return 0;
    }

    throw new Error(`[expression] Unexpected token ${tok.type}`);
  }

  function parseArgList(): unknown[] {
    const args: unknown[] = [];
    if (peek().type === TT.RPAREN) { advance(); return args; }
    args.push(parseExpr());
    while (peek().type === TT.COMMA) { advance(); args.push(parseExpr()); }
    expect(TT.RPAREN);
    return args;
  }

  const BUILTINS: Record<string, (args: unknown[]) => unknown> = {
    random: (args) => {
      const lo = Math.ceil(Number(args[0]  ?? 1));
      const hi = Math.floor(Number(args[1] ?? lo));
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    },
    round:  (args) => Math.round(Number(args[0] ?? 0)),
    floor:  (args) => Math.floor(Number(args[0] ?? 0)),
    ceil:   (args) => Math.ceil(Number(args[0] ?? 0)),
    abs:    (args) => Math.abs(Number(args[0] ?? 0)),
    min:    (args) => Math.min(...args.map(Number)),
    max:    (args) => Math.max(...args.map(Number)),
    length: (args) => {
      const v = args[0];
      if (Array.isArray(v)) return v.length;
      return String(v ?? '').length;
    },
  };

  function parseFunction(name: string): unknown {
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

export function evalValue(expr: string): unknown {
  const trimmed = expr.trim();
  if (/^"[^"]*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === '[]') return [];
  try {
    const tokens = tokenise(trimmed);
    const parser = makeParser(tokens);
    return parser.parseExpr();
  } catch (err) {
    // Return 0 (falsy) on parse error so broken conditions fail closed.
    console.warn(`[expression] Parse error in "${trimmed}": ${(err as Error).message}`);
    return 0;
  }
}
