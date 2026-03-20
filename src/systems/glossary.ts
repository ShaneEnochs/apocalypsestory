// systems/glossary.ts — Glossary/tooltip term registry
//
// Parses glossary.txt and maintains a runtime registry of defined terms.
// Terms can also be added dynamically via *define_term in scene files.
// formatText in narrative.ts uses glossaryRegistry to wrap matching words
// in tooltip spans.

export interface GlossaryEntry {
  term:        string;
  description: string;
}

export let glossaryRegistry: GlossaryEntry[] = [];

// ---------------------------------------------------------------------------
// parseGlossary — reads glossary.txt and populates glossaryRegistry.
// File not existing is silently ignored (glossary is optional).
// ---------------------------------------------------------------------------
export async function parseGlossary(fetchTextFileFn: (name: string) => Promise<string>): Promise<void> {
  let text: string;
  try {
    text = await fetchTextFileFn('glossary');
  } catch {
    // glossary.txt is optional
    return;
  }

  const lines = text.split(/\r?\n/);
  let currentTerm: string | null = null;
  const descLines: string[] = [];

  function flush(): void {
    if (currentTerm !== null) {
      const description = descLines.map(l => l.trim()).filter(Boolean).join(' ');
      addGlossaryTerm(currentTerm, description);
    }
    currentTerm = null;
    descLines.length = 0;
  }

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;

    const m = trimmed.match(/^\*term\s+"([^"]+)"/);
    if (m) {
      flush();
      currentTerm = m[1];
    } else if (currentTerm !== null && trimmed) {
      descLines.push(trimmed);
    }
  }
  flush();
}

// ---------------------------------------------------------------------------
// addGlossaryTerm — adds or replaces a term at runtime.
// ---------------------------------------------------------------------------
export function addGlossaryTerm(term: string, description: string): void {
  const existing = glossaryRegistry.findIndex(e => e.term.toLowerCase() === term.toLowerCase());
  if (existing !== -1) {
    glossaryRegistry[existing] = { term, description };
  } else {
    glossaryRegistry.push({ term, description });
  }
}

// ---------------------------------------------------------------------------
// getGlossaryEntry — case-insensitive lookup.
// ---------------------------------------------------------------------------
export function getGlossaryEntry(term: string): GlossaryEntry | null {
  return glossaryRegistry.find(e => e.term.toLowerCase() === term.toLowerCase()) || null;
}
