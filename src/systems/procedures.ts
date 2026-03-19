// systems/procedures.ts — Reusable named procedure definitions
//
// Authors define procedures in procedures.txt with:
//
//   *procedure name
//     ... directives and text ...
//     *return
//
//   *procedure another_name
//     ...
//
// Any scene file can invoke a procedure with:
//   *call name
//
// Procedures share playerState and tempState with their callers — they are not
// isolated. They run in their own line context (separate ParsedLine array from
// the calling scene) and return via *return or by falling off the end.
//
// The registry is populated once at boot by parseProcedures() and is read-only
// thereafter. gotoScene() does not clear it — procedures persist for the whole
// session.

import { parseLines } from '../core/parser.js';
import type { ParsedLine } from '../core/state.js';

interface Procedure {
  name:  string;
  lines: ParsedLine[];
}

const procedureRegistry = new Map<string, Procedure>();

// ---------------------------------------------------------------------------
// parseProcedures — reads procedures.txt and populates the registry.
// Silently skips if the file does not exist (procedure system is optional).
// ---------------------------------------------------------------------------
export async function parseProcedures(
  fetchTextFileFn: (name: string) => Promise<string>,
): Promise<void> {
  let text: string;
  try {
    text = await fetchTextFileFn('procedures');
  } catch {
    console.warn('[procedures] procedures.txt not found — procedure system disabled.');
    return;
  }

  const rawLines = text.split(/\r?\n/);
  let currentName: string | null = null;
  let currentBlock: string[]     = [];

  function saveProc(): void {
    if (!currentName || currentBlock.length === 0) return;
    procedureRegistry.set(currentName, {
      name:  currentName,
      lines: parseLines(currentBlock.join('\n')),
    });
  }

  for (const raw of rawLines) {
    const trimmed = raw.trim();

    // Outside any procedure block — skip blank lines and comments
    if (!currentName && (!trimmed || trimmed.startsWith('//'))) continue;

    const m = trimmed.match(/^\*procedure\s+([\w]+)\s*$/);
    if (m) {
      saveProc();                       // save previous block (if any)
      currentName  = m[1].toLowerCase();
      currentBlock = [];
      continue;
    }

    if (currentName) currentBlock.push(raw);
  }

  saveProc();  // save final block

  console.log(`[procedures] Loaded ${procedureRegistry.size} procedure(s).`);
}

// ---------------------------------------------------------------------------
// getProcedure — returns a registered procedure by name (case-insensitive).
// Returns null if not found.
// ---------------------------------------------------------------------------
export function getProcedure(name: string): Procedure | null {
  return procedureRegistry.get(name.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// clearProcedureRegistry — resets the registry. Used by tests only.
// ---------------------------------------------------------------------------
export function clearProcedureRegistry(): void {
  procedureRegistry.clear();
}
