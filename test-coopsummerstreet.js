const playwright = require('playwright');

async function testCoopSummerStreet() {
  console.log('[Test] Starting standalone test for coopsummerstreet.com');

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  // Hide navigator.webdriver
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const debugDir = '/Users/ej/Documents/ejwork/LeadInfo/BookingScreenshots/phase3-test';
  await require('fs').promises.mkdir(debugDir, { recursive: true });

  try {
    // 1. Load the page (use domcontentloaded instead of networkidle for SPAs)
    console.log('[Test] Navigating to https://coopsummerstreet.com/');
    try {
      await page.goto('https://coopsummerstreet.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (gotoErr) {
      console.log('[Test] Page load timeout (SPA behavior) — taking screenshot of partial load');
    }
    await page.waitForTimeout(3000); // Wait for JS to render
    await page.screenshot({ path: `${debugDir}/01_page_loaded.png`, fullPage: true });
    console.log('[Test] Screenshot saved: 01_page_loaded.png');

    // 2. Detect platform
    const html = (await page.content()).toLowerCase();
    const platform = html.includes('appfolio') ? 'appfolio'
                  : html.includes('leaselabs') ? 'leaselabs'
                  : 'generic';
    console.log(`[Test] Platform detected: ${platform}`);

    // 2.5. Close any promotional lightboxes / popups
    // Try Escape key first (many modals close on Escape)
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    
    // If still blocked, try clicking the lightbox close button directly
    const closeButtonSelectors = [
      'button:has-text("×")',
      'button:has-text("X")',
      '.lightbox-close',
      '[aria-label="Close"]',
      '.modal-close',
      '.popup-close',
      '.close',
      '#screen-modular-lightbox .close',
      '[data-el-id*="close" i]',
    ];
    for (const closeSel of closeButtonSelectors) {
      const closeBtn = page.locator(closeSel).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        console.log(`[Test] Closing popup with: ${closeSel}`);
        await closeBtn.click();
        await page.waitForTimeout(1000);
        break;
      }
    }
    
    // If still blocked, remove the lightbox from DOM via JS
    const lightboxHidden = await page.evaluate(() => {
      const lightbox = document.querySelector('#screen-modular-lightbox, .lightbox-slug-special, .screen-lightbox');
      if (lightbox) {
        lightbox.style.display = 'none';
        return true;
      }
      return false;
    });
    if (lightboxHidden) {
      console.log('[Test] Hidden lightbox via JS');
      await page.waitForTimeout(500);
    }
    
    await page.screenshot({ path: `${debugDir}/02b_after_popup_close.png`, fullPage: true });
    console.log('[Test] Screenshot saved: 02b_after_popup_close.png');

    // 3. Try to find booking button
    const buttonSelectors = [
      'button:has-text("Schedule Tour")',
      'button:has-text("Schedule")',
      'button:has-text("Tour")',
      'a:has-text("Book")',
      'a:has-text("Schedule")',
    ];
    let foundButton = false;
    for (const selector of buttonSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        console.log(`[Test] Found booking button: ${selector}`);
        foundButton = true;
        break;
      }
    }

    await page.screenshot({ path: `${debugDir}/02_button_search.png`, fullPage: true });
    console.log('[Test] Screenshot saved: 02_button_search.png');

    if (!foundButton) {
      console.log('[Test] No booking button found with basic selectors');
      console.log('[Test] Page may be a Vue SPA that renders dynamically after longer load');
    }

    // 4. Try to find any form fields
    const nameField = page.locator('input[type="text"], input[name*="name"], input[id*="name"]').first();
    const emailField = page.locator('input[type="email"], input[name*="email"], input[id*="email"]').first();
    const phoneField = page.locator('input[type="tel"], input[name*="phone"], input[id*="phone"]').first();

    const hasName = await nameField.isVisible().catch(() => false);
    const hasEmail = await emailField.isVisible().catch(() => false);
    const hasPhone = await phoneField.isVisible().catch(() => false);

    console.log(`[Test] Form fields found: name=${hasName}, email=${hasEmail}, phone=${hasPhone}`);

    // 5. Try clicking the booking button if found
    if (foundButton) {
      for (const selector of buttonSelectors) {
        const btn = page.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) {
          console.log(`[Test] Clicking button: ${selector}`);
          await btn.click();
          await page.waitForTimeout(5000); // Wait longer for SPA modal/form
          await page.screenshot({ path: `${debugDir}/03_after_click.png`, fullPage: true });
          console.log('[Test] Screenshot saved: 03_after_click.png');
          break;
        }
      }
    }

    // 6. Re-check form fields after click
    const nameField2 = page.locator('input[type="text"], input[name*="name"], input[id*="name"]').first();
    const emailField2 = page.locator('input[type="email"], input[name*="email"], input[id*="email"]').first();
    const phoneField2 = page.locator('input[type="tel"], input[name*="phone"], input[id*="phone"]').first();

    const hasName2 = await nameField2.isVisible().catch(() => false);
    const hasEmail2 = await emailField2.isVisible().catch(() => false);
    const hasPhone2 = await phoneField2.isVisible().catch(() => false);

    console.log(`[Test] Form fields after click: name=${hasName2}, email=${hasEmail2}, phone=${hasPhone2}`);

    console.log('[Test] Test complete. Screenshots saved to:', debugDir);

  } catch (err) {
    console.error('[Test] Error:', err.message);
    await page.screenshot({ path: `${debugDir}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }
}

testCoopSummerStreet();
