// systems/save-manager.ts — Save/load orchestration and UI wiring
//
// Extracted from engine.ts: contains all the button-event wiring for the
// save menu, splash screen, undo button, export/import, and save codes.
// Called once during boot with the fully-built dom object.

import type { Dom } from '../core/dom.js';

import {
  loadSaveFromSlot, saveGameToSlot,
  deleteSaveSlot, exportSaveSlot, importSaveFromJSON,
  encodeSaveCode, decodeSaveCode,
} from './saves.js';

import {
  hideSaveMenu, showSaveMenu, refreshAllSlotCards, loadAndResume,
  hideSplash, showCharacterCreation, wireCharCreation,
} from '../ui/overlays.js';

import { showToast } from '../ui/overlays.js';
import { getNarrativeLog } from '../ui/narrative.js';
import { runStatsScene } from '../ui/panels.js';

import {
  patchPlayerState, startup,
} from '../core/state.js';

import { gotoScene } from '../core/interpreter.js';
import { popUndo, clearUndoStack, updateUndoBtn } from './undo.js';

// ---------------------------------------------------------------------------
// wireSaveUI — registers all save/load/undo/new-game event listeners.
// Must be called after all modules are initialised.
// ---------------------------------------------------------------------------
export function wireSaveUI(dom: Dom, opts: {
  scheduleStatsRender: () => void;
  setChapterTitle:     (t: string) => void;
}): void {
  const { scheduleStatsRender } = opts;

  // Status panel toggle
  dom.statusToggle?.addEventListener('click', () => {
    const visible = dom.statusPanel?.classList.toggle('status-visible');
    dom.statusPanel?.classList.toggle('status-hidden', !visible);
    scheduleStatsRender();
  });

  // Close status panel on outside click
  document.addEventListener('click', e => {
    if (
      !dom.statusPanel?.contains(e.target as Node) &&
      e.target !== dom.statusToggle &&
      !dom.storeOverlay?.contains(e.target as Node)
    ) {
      dom.statusPanel?.classList.remove('status-visible');
      dom.statusPanel?.classList.add('status-hidden');
    }
  });

  // Save menu
  dom.saveBtn?.addEventListener('click', showSaveMenu);
  dom.saveMenuClose?.addEventListener('click', hideSaveMenu);
  dom.saveOverlay?.addEventListener('click', e => { if (e.target === dom.saveOverlay) hideSaveMenu(); });
  dom.saveOverlay?.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') hideSaveMenu();
  });

  // Keyboard shortcut: Ctrl+S / Cmd+S → toggle save menu
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (dom.saveOverlay.classList.contains('hidden')) {
        showSaveMenu();
      } else {
        hideSaveMenu();
      }
    }
    // Ctrl+Z / Cmd+Z → undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      const btn = document.getElementById('undo-btn') as HTMLButtonElement | null;
      if (btn && !btn.disabled) {
        e.preventDefault();
        popUndo();
      }
    }
  });

  // Save to slot
  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-to-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const existing = loadSaveFromSlot(slot);
      if (existing && !confirm(`Overwrite Slot ${slot}?`)) return;
      saveGameToSlot(slot, null, getNarrativeLog());
      hideSaveMenu();
      showToast(`Saved to Slot ${slot}`);
      refreshAllSlotCards();
    });
  });

  // Delete save slot (in-game menu)
  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (confirm(`Delete Slot ${slot}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });

  // Load save slot (in-game menu)
  (['auto', 1, 2, 3] as Array<'auto'|1|2|3>).forEach(slot => {
    const btn = document.getElementById(`ingame-load-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSaveMenu();
      await loadAndResume(save);
    });
  });

  // Restart
  const ingameRestartBtn = document.getElementById('ingame-restart-btn');
  if (ingameRestartBtn) {
    ingameRestartBtn.addEventListener('click', () => {
      if (confirm('Return to the title screen? Manual saves will be kept.')) {
        hideSaveMenu();
        deleteSaveSlot('auto');
        location.reload();
      }
    });
  }

  // New game
  dom.splashNewBtn?.addEventListener('click', async () => {
    hideSplash();
    const charData = await showCharacterCreation();
    patchPlayerState({
      first_name:                  charData.firstName,
      last_name:                   charData.lastName,
      pronouns_subject:            charData.pronouns_subject,
      pronouns_object:             charData.pronouns_object,
      pronouns_possessive:         charData.pronouns_possessive,
      pronouns_possessive_pronoun: charData.pronouns_possessive_pronoun,
      pronouns_reflexive:          charData.pronouns_reflexive,
      pronouns_label:              charData.pronouns_label,
    });
    dom.saveBtn?.classList.remove('hidden');
    document.getElementById('undo-btn')?.classList.remove('hidden');
    clearUndoStack();
    await runStatsScene();
    await gotoScene(startup.sceneList[0] || 'prologue');
  });

  // Continue (splash load)
  dom.splashLoadBtn?.addEventListener('click', () => {
    dom.splashOverlay?.querySelector('.splash-btn-col')?.classList.add('hidden');
    dom.splashSlots?.classList.remove('hidden');
    refreshAllSlotCards();
  });

  dom.splashSlotsBack?.addEventListener('click', () => {
    dom.splashSlots?.classList.add('hidden');
    dom.splashOverlay?.querySelector('.splash-btn-col')?.classList.remove('hidden');
  });

  // Load from splash slots
  (['auto', 1, 2, 3] as Array<'auto'|1|2|3>).forEach(slot => {
    const btn = document.getElementById(`slot-load-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const save = loadSaveFromSlot(slot);
      if (!save) return;
      hideSplash();
      await loadAndResume(save);
    });
  });

  // Delete from splash slots
  (['auto', 1, 2, 3] as Array<'auto'|1|2|3>).forEach(slot => {
    const btn = document.getElementById(`slot-delete-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const label = slot === 'auto' ? 'the auto-save' : `Slot ${slot}`;
      if (confirm(`Delete ${label}? This cannot be undone.`)) {
        deleteSaveSlot(slot);
        refreshAllSlotCards();
      }
    });
  });

  wireCharCreation();

  // Undo button
  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) undoBtn.addEventListener('click', popUndo);
  updateUndoBtn();

  // Export save slots
  [1, 2, 3].forEach(slot => {
    const btn = document.getElementById(`save-export-${slot}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!exportSaveSlot(slot)) showToast(`Slot ${slot} is empty.`);
      else showToast(`Slot ${slot} exported.`);
    });
  });

  // Import save file
  const importInput = document.getElementById('save-import-file') as HTMLInputElement | null;
  if (importInput) {
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      const slotEl = document.getElementById('save-import-slot') as HTMLSelectElement | null;
      const targetSlot = Number(slotEl?.value || 1);
      try {
        const text   = await file.text();
        const json   = JSON.parse(text);
        const result = importSaveFromJSON(json, targetSlot);
        if (result.ok) {
          showToast(`Imported to Slot ${targetSlot}.`);
          refreshAllSlotCards();
        } else {
          showToast(`Import failed: ${(result as { ok: false; reason: string }).reason}`);
        }
      } catch {
        showToast('Import failed: file could not be parsed as JSON.');
      }
      importInput.value = '';
    });
  }

  // Save code — copy
  const codeCopyBtn = document.getElementById('save-code-copy');
  if (codeCopyBtn) {
    codeCopyBtn.addEventListener('click', () => {
      const code  = encodeSaveCode(getNarrativeLog());
      const field = document.getElementById('save-code-field') as HTMLInputElement | null;
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(code)
          .then(() => {
            showToast('Save code copied to clipboard.');
            if (field) field.value = code;
          })
          .catch(() => {
            if (field) { field.value = code; field.select(); }
            showToast('Code generated — copy it from the text box.');
          });
      } else {
        if (field) { field.value = code; field.select(); }
        showToast('Code generated — copy it from the text box.');
      }
    });
  }

  // Save code — load
  const codeLoadBtn = document.getElementById('save-code-load');
  if (codeLoadBtn) {
    codeLoadBtn.addEventListener('click', async () => {
      const field  = document.getElementById('save-code-field') as HTMLInputElement | null;
      const code   = field?.value?.trim();
      if (!code) { showToast('Paste a save code first.'); return; }

      const result = decodeSaveCode(code);
      if (!result.ok) {
        showToast(`Load failed: ${(result as { ok: false; reason: string }).reason}`);
        return;
      }

      hideSaveMenu();
      await loadAndResume(result.save);
      showToast('Save code loaded successfully.');
    });
  }
}
