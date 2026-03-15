// ---------------------------------------------------------------------------
// tests/e2e.spec.mjs — Playwright end-to-end test for System Awakening
//
// Boots the game in a real browser, plays through the complete prologue,
// exercises save/load, and verifies the ending screen.
//
// Prerequisites:
//   npm install -D @playwright/test
//   npx playwright install chromium
//
// Run:
//   npx playwright test tests/e2e.spec.mjs
//
// Or with headed browser (visible):
//   npx playwright test tests/e2e.spec.mjs --headed
//
// NOTE: Requires a local server serving the game files. The test starts one
// automatically using Playwright's webServer config, or you can serve manually:
//   npx serve .        (then run the test)
// ---------------------------------------------------------------------------

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helper: wait for a choice button to appear and click it by text content
// ---------------------------------------------------------------------------
async function pickChoice(page, textFragment) {
  const btn = page.locator('.choice-btn', { hasText: textFragment }).first();
  await btn.waitFor({ state: 'visible', timeout: 10000 });
  await btn.click();
}

// Helper: wait for narrative text to appear
async function waitForText(page, textFragment) {
  await page.locator('#narrative-content', { hasText: textFragment }).waitFor({ timeout: 10000 });
}

// Helper: wait for system block text
async function waitForSystem(page, textFragment) {
  await page.locator('.system-block', { hasText: textFragment }).waitFor({ timeout: 10000 });
}

// ---------------------------------------------------------------------------
// Test: Full prologue playthrough
// ---------------------------------------------------------------------------
test.describe('System Awakening — Prologue', () => {

  test.beforeEach(async ({ page }) => {
    // Navigate to the game — adjust URL if using a different server
    await page.goto('http://localhost:3000');
    await page.waitForSelector('#splash-overlay', { state: 'visible' });
  });

  test('splash screen loads with New Game and Load Game buttons', async ({ page }) => {
    await expect(page.locator('#splash-new-btn')).toBeVisible();
    await expect(page.locator('#splash-load-btn')).toBeVisible();
    await expect(page.locator('.splash-title')).toHaveText('System Awakening');
  });

  test('character creation flow', async ({ page }) => {
    await page.click('#splash-new-btn');
    await page.waitForSelector('#char-creation-overlay:not(.hidden)', { timeout: 5000 });

    // Fill in name
    await page.fill('#input-first-name', 'Kael');
    await page.fill('#input-last-name', 'Storm');

    // Select pronouns (he/him)
    await page.click('[data-pronouns="he/him"]');

    // Begin button should be enabled
    await expect(page.locator('#char-begin-btn')).toBeEnabled();
    await page.click('#char-begin-btn');

    // Game should start — narrative content should appear
    await page.waitForSelector('#narrative-content .narrative-paragraph', { timeout: 10000 });

    // Save and undo buttons should be visible
    await expect(page.locator('#save-btn')).toBeVisible();
    await expect(page.locator('#undo-btn')).toBeVisible();
  });

  test('full prologue playthrough to ending', async ({ page }) => {
    // --- Character creation ---
    await page.click('#splash-new-btn');
    await page.waitForSelector('#char-creation-overlay:not(.hidden)');
    await page.fill('#input-first-name', 'Kael');
    await page.fill('#input-last-name', 'Storm');
    await page.click('[data-pronouns="he/him"]');
    await page.click('#char-begin-btn');

    // --- Opening → ramparts (automatic, no choices until kai_speaks) ---
    // Wait for the first choice to appear
    await page.waitForSelector('.choice-btn', { timeout: 15000 });

    // --- kai_speaks: pick first option ---
    await pickChoice(page, page.locator('.choice-btn').first());

    // --- Wait for next choice and pick ---
    await page.waitForSelector('.choice-btn', { timeout: 10000 });

    // Handle level-up if it appears (XP block at ramparts triggers it)
    const levelUpBlock = page.locator('.levelup-inline-block');
    if (await levelUpBlock.isVisible().catch(() => false)) {
      // Allocate all stat points — click + buttons until confirm is enabled
      while (true) {
        const plusBtns = page.locator('.alloc-btn[data-op="plus"]:not(:disabled)');
        const count = await plusBtns.count();
        if (count === 0) break;
        await plusBtns.first().click();
      }
      const confirmBtn = page.locator('.levelup-confirm-btn:not(.levelup-confirm-btn--locked)');
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
      }
    }

    // Keep picking the first available choice until we reach the ending
    for (let i = 0; i < 30; i++) {
      // Check for ending overlay
      const ending = page.locator('#ending-overlay:not(.hidden)');
      if (await ending.isVisible().catch(() => false)) break;

      // Check for level-up block and handle it
      const lvl = page.locator('.levelup-inline-block:not(.levelup-inline-block--confirmed)');
      if (await lvl.isVisible().catch(() => false)) {
        while (true) {
          const plusBtns = page.locator('.alloc-btn[data-op="plus"]:not(:disabled)');
          const count = await plusBtns.count();
          if (count === 0) break;
          await plusBtns.first().click();
        }
        const confirmBtn = page.locator('.levelup-confirm-btn:not(.levelup-confirm-btn--locked)');
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click();
        }
        continue;
      }

      // Wait for a choice button
      try {
        await page.waitForSelector('.choice-btn:not(:disabled)', { timeout: 5000 });
      } catch {
        // No choice appeared — might be at page break or end
        const pageBreak = page.locator('.page-break-btn');
        if (await pageBreak.isVisible().catch(() => false)) {
          await pageBreak.click();
          continue;
        }
        break;
      }

      // Click the first enabled choice
      const firstChoice = page.locator('.choice-btn:not(:disabled)').first();
      if (await firstChoice.isVisible().catch(() => false)) {
        await firstChoice.click();
      }
    }

    // Verify the ending screen appeared
    const endingOverlay = page.locator('#ending-overlay:not(.hidden)');
    await expect(endingOverlay).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#ending-title')).toHaveText('The End');
  });

  test('save and load cycle', async ({ page }) => {
    // --- Start game ---
    await page.click('#splash-new-btn');
    await page.waitForSelector('#char-creation-overlay:not(.hidden)');
    await page.fill('#input-first-name', 'Test');
    await page.fill('#input-last-name', 'Save');
    await page.click('[data-pronouns="they/them"]');
    await page.click('#char-begin-btn');

    // Wait for first choice
    await page.waitForSelector('.choice-btn', { timeout: 15000 });

    // Handle level-up if present
    const lvl = page.locator('.levelup-inline-block:not(.levelup-inline-block--confirmed)');
    if (await lvl.isVisible().catch(() => false)) {
      while (true) {
        const plusBtns = page.locator('.alloc-btn[data-op="plus"]:not(:disabled)');
        if (await plusBtns.count() === 0) break;
        await plusBtns.first().click();
      }
      const confirmBtn = page.locator('.levelup-confirm-btn:not(.levelup-confirm-btn--locked)');
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
    }

    // Open save menu
    await page.click('#save-btn');
    await page.waitForSelector('#save-overlay:not(.hidden)');

    // Save to slot 1
    await page.click('#save-to-1');

    // Verify toast appeared
    await expect(page.locator('.toast')).toBeVisible({ timeout: 3000 });

    // Make a choice to change state
    await page.waitForSelector('.choice-btn:not(:disabled)', { timeout: 5000 });
    await page.locator('.choice-btn:not(:disabled)').first().click();

    // Now load the save
    await page.click('#save-btn');
    await page.waitForSelector('#save-overlay:not(.hidden)');
    await page.click('#ingame-load-1');

    // Should be back at the choices — verify narrative content rendered
    await page.waitForSelector('.choice-btn', { timeout: 10000 });
    const choices = page.locator('.choice-btn');
    const count = await choices.count();
    expect(count).toBeGreaterThan(0);
  });

  test('debug overlay toggles with backtick', async ({ page }) => {
    // Start game
    await page.click('#splash-new-btn');
    await page.waitForSelector('#char-creation-overlay:not(.hidden)');
    await page.fill('#input-first-name', 'Debug');
    await page.fill('#input-last-name', 'Test');
    await page.click('[data-pronouns="they/them"]');
    await page.click('#char-begin-btn');
    await page.waitForSelector('.narrative-paragraph', { timeout: 10000 });

    // Debug should be hidden initially
    await expect(page.locator('#debug-overlay')).toHaveClass(/hidden/);

    // Toggle on
    await page.keyboard.press('Backquote');
    await expect(page.locator('#debug-overlay')).not.toHaveClass(/hidden/);
    await expect(page.locator('.debug-header')).toContainText('DEBUG');

    // Toggle off
    await page.keyboard.press('Backquote');
    await expect(page.locator('#debug-overlay')).toHaveClass(/hidden/);
  });

  test('undo button restores previous state', async ({ page }) => {
    // Start game
    await page.click('#splash-new-btn');
    await page.waitForSelector('#char-creation-overlay:not(.hidden)');
    await page.fill('#input-first-name', 'Undo');
    await page.fill('#input-last-name', 'Test');
    await page.click('[data-pronouns="they/them"]');
    await page.click('#char-begin-btn');

    // Wait for first choice
    await page.waitForSelector('.choice-btn', { timeout: 15000 });

    // Handle level-up if present
    const lvl = page.locator('.levelup-inline-block:not(.levelup-inline-block--confirmed)');
    if (await lvl.isVisible().catch(() => false)) {
      while (true) {
        const plusBtns = page.locator('.alloc-btn[data-op="plus"]:not(:disabled)');
        if (await plusBtns.count() === 0) break;
        await plusBtns.first().click();
      }
      const confirmBtn = page.locator('.levelup-confirm-btn:not(.levelup-confirm-btn--locked)');
      if (await confirmBtn.isVisible().catch(() => false)) await confirmBtn.click();
    }

    // Undo should be disabled (no history yet)
    await expect(page.locator('#undo-btn')).toBeDisabled();

    // Make a choice
    await page.waitForSelector('.choice-btn:not(:disabled)', { timeout: 5000 });
    await page.locator('.choice-btn:not(:disabled)').first().click();

    // Undo should now be enabled
    await page.waitForSelector('#undo-btn:not(:disabled)', { timeout: 5000 });

    // Click undo
    await page.click('#undo-btn');

    // Should see choices again
    await page.waitForSelector('.choice-btn', { timeout: 10000 });
    const choices = page.locator('.choice-btn');
    const count = await choices.count();
    expect(count).toBeGreaterThan(0);
  });

});
