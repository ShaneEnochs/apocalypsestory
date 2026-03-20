#!/usr/bin/env npx tsx
// tools/lint.ts — Scene linter for System Awakening scene files
//
// Checks all scenes listed in startup.txt for:
//   • Undefined label references (*goto, *gosub)
//   • Unused label declarations (*label)
//   • Undefined variable references (*set, *if, ${var})
//   • *temp variables used before their declaration (in the same scene)
//   • *goto_scene / *gosub_scene references to unlisted scenes
//   • *call references to undefined procedures
//
// Usage:  npx tsx tools/lint.ts [--strict]
//   --strict: treat warnings as errors (exit code 1 if any issue found)

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(name: string): string | null {
  const path = join(ROOT, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

interface Issue {
  scene:   string;
  line:    number;
  level:   'error' | 'warn';
  message: string;
}

const issues: Issue[] = [];

function error(scene: string, line: number, msg: string): void {
  issues.push({ scene, line, level: 'error', message: msg });
}
function warn(scene: string, line: number, msg: string): void {
  issues.push({ scene, line, level: 'warn', message: msg });
}

// ---------------------------------------------------------------------------
// Parse startup.txt — collect global variables and scene list
// ---------------------------------------------------------------------------

function parseStartup(text: string): {
  globalVars:   Set<string>;
  sceneList:    string[];
  procedures:   Set<string>;
} {
  const globalVars = new Set<string>();
  const sceneList: string[] = [];

  const lines = text.split(/\r?\n/);
  let inSceneList = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*comment')) {
      inSceneList = false;
      if (trimmed.startsWith('*comment')) continue;
      continue;
    }

    if (trimmed.startsWith('*scene_list')) {
      inSceneList = true;
      continue;
    }

    if (inSceneList) {
      if (trimmed.startsWith('*')) {
        inSceneList = false;
      } else {
        sceneList.push(trimmed);
        continue;
      }
    }

    const mCreate = trimmed.match(/^\*(create|create_stat)\s+([a-zA-Z_][\w]*)/);
    if (mCreate) {
      globalVars.add(mCreate[2].toLowerCase());
    }
  }

  // Built-in variables always available
  for (const v of [
    'game_title', 'game_byline', 'first_name', 'last_name',
    'pronouns_subject', 'pronouns_object', 'pronouns_possessive',
    'pronouns_possessive_pronoun', 'pronouns_reflexive', 'pronouns_label',
    'class_name', 'level', 'essence', 'skills', 'journal', 'inventory',
    'health', 'mana', 'max_mana', 'loop_counter',
  ]) {
    globalVars.add(v);
  }

  return { globalVars, sceneList, procedures: new Set() };
}

// ---------------------------------------------------------------------------
// Parse procedures.txt to collect defined procedure names
// ---------------------------------------------------------------------------

function parseProcedureNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(/^\*proc\s+([a-zA-Z_][\w]*)/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

// ---------------------------------------------------------------------------
// Lint a single scene file
// ---------------------------------------------------------------------------

function lintScene(
  sceneName: string,
  text: string,
  globalVars: Set<string>,
  sceneList: Set<string>,
  procedures: Set<string>,
): void {
  const lines = text.split(/\r?\n/);

  // Pass 1: collect all defined labels, temp vars, and gather references
  const definedLabels  = new Map<string, number>(); // label → line number
  const usedLabels     = new Map<string, number>(); // label → first use line
  const tempVarOrder   = new Map<string, number>(); // varName → line declared

  // Pass 2: check references
  for (let i = 0; i < lines.length; i++) {
    const ln  = i + 1;           // 1-based line number for display
    const raw = lines[i];
    const t   = raw.trim();

    if (!t || t.startsWith('//') || t.startsWith('*comment')) continue;

    // Collect label definitions
    const mLabel = t.match(/^\*label\s+(\S+)/);
    if (mLabel) {
      const lbl = mLabel[1].toLowerCase();
      if (definedLabels.has(lbl)) {
        error(sceneName, ln, `Duplicate label "*label ${mLabel[1]}" (first defined at line ${definedLabels.get(lbl)})`);
      }
      definedLabels.set(lbl, ln);
    }

    // Collect temp declarations
    const mTemp = t.match(/^\*temp\s+([a-zA-Z_][\w]*)/);
    if (mTemp) {
      const v = mTemp[1].toLowerCase();
      if (!tempVarOrder.has(v)) tempVarOrder.set(v, ln);
    }
  }

  // Now collect all goto/gosub references (needs definedLabels to be complete)
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const t  = lines[i].trim();

    if (!t || t.startsWith('//') || t.startsWith('*comment')) continue;

    // *goto label
    const mGoto = t.match(/^\*goto\s+(\S+)/);
    if (mGoto && !t.startsWith('*goto_scene')) {
      const lbl = mGoto[1].toLowerCase();
      if (!usedLabels.has(lbl)) usedLabels.set(lbl, ln);
      if (!definedLabels.has(lbl)) {
        error(sceneName, ln, `*goto references undefined label "${mGoto[1]}"`);
      }
    }

    // *gosub label
    const mGosub = t.match(/^\*gosub\s+(\S+)/);
    if (mGosub && !t.startsWith('*gosub_scene')) {
      const lbl = mGosub[1].toLowerCase();
      if (!usedLabels.has(lbl)) usedLabels.set(lbl, ln);
      if (!definedLabels.has(lbl)) {
        error(sceneName, ln, `*gosub references undefined label "${mGosub[1]}"`);
      }
    }

    // *goto_scene sceneName
    const mGotoScene = t.match(/^\*goto_scene\s+(\S+)/);
    if (mGotoScene) {
      const ref = mGotoScene[1].toLowerCase().replace(/\.txt$/i, '');
      if (!sceneList.has(ref)) {
        error(sceneName, ln, `*goto_scene references unlisted scene "${mGotoScene[1]}"`);
      }
    }

    // *gosub_scene sceneName
    const mGosubScene = t.match(/^\*gosub_scene\s+(\S+)/);
    if (mGosubScene) {
      const ref = mGosubScene[1].toLowerCase().replace(/\.txt$/i, '');
      if (!sceneList.has(ref)) {
        error(sceneName, ln, `*gosub_scene references unlisted scene "${mGosubScene[1]}"`);
      }
    }

    // *call procedureName
    const mCall = t.match(/^\*call\s+([a-zA-Z_][\w]*)/);
    if (mCall && procedures.size > 0) {
      const proc = mCall[1].toLowerCase();
      if (!procedures.has(proc)) {
        error(sceneName, ln, `*call references undefined procedure "${mCall[1]}"`);
      }
    }

    // *set varName ...  — check var is declared
    const mSet = t.match(/^\*set\s+([a-zA-Z_][\w]*)/);
    if (mSet) {
      checkVarDeclared(sceneName, ln, mSet[1], globalVars, tempVarOrder, i, lines);
    }

    // *set_stat varName ...
    const mSetStat = t.match(/^\*set_stat\s+([a-zA-Z_][\w]*)/);
    if (mSetStat) {
      checkVarDeclared(sceneName, ln, mSetStat[1], globalVars, tempVarOrder, i, lines);
    }

    // *if / *elseif expressions — extract variable names from conditions
    const mIf = t.match(/^\*(if|elseif|loop)\s+(.+)/);
    if (mIf) {
      const expr = mIf[2];
      checkExpressionVars(sceneName, ln, expr, globalVars, tempVarOrder, i, lines);
    }

    // ${varName} interpolation in text lines
    if (!t.startsWith('*')) {
      const varRefs = [...t.matchAll(/\$\{([a-zA-Z_][\w]*)\}/g)];
      for (const m of varRefs) {
        checkVarDeclared(sceneName, ln, m[1], globalVars, tempVarOrder, i, lines);
      }
    }

    // ${varName} in quoted directive arguments
    if (t.startsWith('*')) {
      const varRefs = [...t.matchAll(/\$\{([a-zA-Z_][\w]*)\}/g)];
      for (const m of varRefs) {
        checkVarDeclared(sceneName, ln, m[1], globalVars, tempVarOrder, i, lines);
      }
    }
  }

  // Warn about declared labels never referenced (skip "opening" style labels)
  for (const [lbl, defLine] of definedLabels) {
    if (!usedLabels.has(lbl)) {
      warn(sceneName, defLine, `Label "${lbl}" is declared but never referenced`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for variable checking
// ---------------------------------------------------------------------------

function checkVarDeclared(
  sceneName:    string,
  ln:           number,
  varName:      string,
  globalVars:   Set<string>,
  tempVarOrder: Map<string, number>,
  lineIndex:    number,
  _lines:       string[],
): void {
  const key = varName.toLowerCase();

  // Global vars are always fine
  if (globalVars.has(key)) return;

  // Temp var declared before this line
  const tempLine = tempVarOrder.get(key);
  if (tempLine !== undefined) {
    if (tempLine <= lineIndex + 1) return; // declared at or before this line (1-based)
    error(sceneName, ln, `Variable "${varName}" used before its *temp declaration (declared at line ${tempLine})`);
    return;
  }

  // Unknown variable
  error(sceneName, ln, `Variable "${varName}" is used but never declared (*create or *temp)`);
}

function checkExpressionVars(
  sceneName:    string,
  ln:           number,
  expr:         string,
  globalVars:   Set<string>,
  tempVarOrder: Map<string, number>,
  lineIndex:    number,
  lines:        string[],
): void {
  // Extract bare identifiers that are likely variable names
  // Exclude keywords and string literals
  const keywords = new Set(['true', 'false', 'null', 'and', 'or', 'not', 'length']);
  // Remove string literals first
  const stripped = expr.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
  const tokens   = stripped.match(/\b([a-zA-Z_][\w]*)\b/g) ?? [];

  for (const tok of tokens) {
    if (keywords.has(tok.toLowerCase())) continue;
    if (!isNaN(Number(tok))) continue;
    checkVarDeclared(sceneName, ln, tok, globalVars, tempVarOrder, lineIndex, lines);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const strictMode = process.argv.includes('--strict');

// Load startup.txt
const startupText = readFile('startup.txt');
if (!startupText) {
  console.error('ERROR: startup.txt not found in project root.');
  process.exit(1);
}

const { globalVars, sceneList } = parseStartup(startupText);
const sceneSet = new Set(sceneList.map(s => s.toLowerCase().replace(/\.txt$/i, '')));

// Load procedures if present
let procedures = new Set<string>();
const procText = readFile('procedures.txt');
if (procText) procedures = parseProcedureNames(procText);

console.log(`\nSystem Awakening — Scene Linter`);
console.log(`${'─'.repeat(48)}`);
console.log(`Global variables : ${globalVars.size}`);
console.log(`Scenes to lint   : ${sceneList.join(', ') || '(none)'}`);
console.log(`Procedures found : ${procedures.size}`);
console.log(`${'─'.repeat(48)}\n`);

// Lint each scene
for (const sceneName of sceneList) {
  const filename = sceneName.endsWith('.txt') ? sceneName : `${sceneName}.txt`;
  const text = readFile(filename);
  if (!text) {
    error(sceneName, 0, `Scene file "${filename}" not found`);
    continue;
  }
  lintScene(sceneName, text, globalVars, sceneSet, procedures);
}

// Report
if (issues.length === 0) {
  console.log('✓ No issues found.\n');
  process.exit(0);
}

let errorCount = 0;
let warnCount  = 0;

for (const issue of issues) {
  const loc    = issue.line > 0 ? `:${issue.line}` : '';
  const prefix = issue.level === 'error' ? '✗ ERROR' : '⚠ WARN ';
  console.log(`${prefix}  ${issue.scene}${loc}  —  ${issue.message}`);
  if (issue.level === 'error') errorCount++;
  else warnCount++;
}

console.log(`\n${'─'.repeat(48)}`);
console.log(`${errorCount} error(s), ${warnCount} warning(s)\n`);

if (errorCount > 0 || (strictMode && warnCount > 0)) {
  process.exit(1);
}
