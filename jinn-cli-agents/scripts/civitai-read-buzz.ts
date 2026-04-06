// @ts-nocheck
/**
 * Quick Playwright script to read current Buzz and 7d change from the
 * Civitai Buzz Dashboard using a saved browser profile.
 *
 * Usage (example):
 *   npx tsx scripts/civitai-read-buzz.ts
 *
 * Optional env:
 *   PLAYWRIGHT_PROFILE_DIR=/absolute/path/to/profile
 *   PLAYWRIGHT_HEADLESS=true|false
 */

import { chromium } from 'playwright';

const DEFAULT_PROFILE = `${process.cwd()}/.playwright-mcp/google-profile`;
const PROFILE_DIR = process.env.PLAYWRIGHT_PROFILE_DIR || DEFAULT_PROFILE;
const HEADLESS = String(process.env.PLAYWRIGHT_HEADLESS || 'true') === 'true';
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL || undefined; // e.g., 'chrome'
const KEEP_OPEN = String(process.env.PLAYWRIGHT_KEEP_OPEN || 'false') === 'true';
const FAST = String(process.env.PLAYWRIGHT_FAST || 'true') === 'true';
const BUZZ_ONLY = ['1', 'true', 'yes'].includes(String(process.env.BUZZ_ONLY || 'false').toLowerCase());
const TARGET_URL = 'https://civitai.com/user/buzz-dashboard';

function extractNumbers(text: string): string[] {
  return Array.from(text.matchAll(/\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b/g)).map(m => m[0]);
}

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 1000 },
    channel: CHANNEL as any,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await context.newPage();
  // Spoof a stable Chrome user agent via CDP (Chromium only)
  try {
    // @ts-ignore
    const cdp = await context.newCDPSession(page as any);
    await cdp.send('Network.enable');
    await cdp.send('Network.setUserAgentOverride', {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.88 Safari/537.36',
    });
  } catch {}

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: FAST ? 30000 : 90000 });
    if (!FAST) {
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(800);
    }

    // If not authenticated, attempt Google SSO click on the Civitai auth wall
    try {
      const onAuthWall = await page.locator('text=Sign Up or Log In').first().isVisible({ timeout: FAST ? 500 : 2000 }).catch(() => false);
      if (onAuthWall) {
        const selectors = [
          'button:has-text("Google")',
          'a:has-text("Google")',
          '[data-provider="google"]',
          'div[role="button"]:has-text("Google")'
        ];
        let clicked = false;
        for (const sel of selectors) {
          const loc = page.locator(sel).first();
          if (await loc.isVisible({ timeout: FAST ? 300 : 1000 }).catch(() => false)) {
            const [popup] = await Promise.all([
              context.waitForEvent('page').catch(() => null),
              loc.click({ timeout: FAST ? 3000 : 10000 })
            ]);
            if (popup) {
              try {
                await popup.waitForLoadState('domcontentloaded', { timeout: FAST ? 10000 : 60000 });
                if (!FAST) await popup.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
              } catch {}
            }
            clicked = true;
            break;
          }
        }
        if (clicked) {
          // Give SSO a chance to complete and redirect back
          if (!FAST) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: FAST ? 20000 : 90000 });
          if (!FAST) await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(400);
        }
      }
    } catch {}

    // Try to extract numbers near the Current Buzz heading
    // Faster extraction using Playwright locators
    let sectionText = '';
    try {
      const h = page.locator('h3:has-text("Current Buzz")');
      const container = h.locator('xpath=ancestor::*[self::div or self::section][1]');
      sectionText = (await container.innerText({ timeout: FAST ? 1000 : 3000 })).replace(/\s+/g, ' ').trim();
    } catch {}
    if (!sectionText) {
      // Fallback: grab body text and slice around keyword
      const body = await page.locator('body').innerText({ timeout: FAST ? 1000 : 3000 }).catch(() => '');
      const idx = body.toLowerCase().indexOf('current buzz');
      sectionText = idx >= 0 ? body.slice(idx, idx + 400) : body.slice(0, 400);
      sectionText = sectionText.replace(/\s+/g, ' ').trim();
    }
    const nums = extractNumbers(sectionText);
    // Heuristic: first number is current Buzz, second is 7d change
    const currentBuzz = nums[0] || null;
    const sevenDayChange = nums[1] || null;

    if (BUZZ_ONLY && currentBuzz) {
      // eslint-disable-next-line no-console
      console.log(String(currentBuzz));
      return;
    }

    const payload = {
      ok: Boolean(currentBuzz),
      url: TARGET_URL,
      current_buzz: currentBuzz,
      seven_day_change: sevenDayChange,
      captured_at: new Date().toISOString(),
      context_sample: sectionText,
      note: 'Numbers parsed near "Current Buzz" heading; DOM can change over time.',
    };

    // Print JSON result
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload, null, 2));
  } catch (err: any) {
    const errorOut = {
      ok: false,
      url: TARGET_URL,
      error: err?.message || String(err),
    };
    if (BUZZ_ONLY) {
      // eslint-disable-next-line no-console
      console.error('');
    } else {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(errorOut, null, 2));
    }
    process.exitCode = 1;
  } finally {
    if (KEEP_OPEN && !HEADLESS) {
      // Keep the browser window open for manual login/debug. Exit when user closes it.
      // eslint-disable-next-line no-console
      console.log('[INFO] Browser left open for manual interaction. Close the window to exit.');
      await new Promise<void>(() => {});
    }
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

main();


