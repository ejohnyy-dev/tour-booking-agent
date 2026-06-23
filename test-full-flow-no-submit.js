const playwright = require('playwright');

async function testFullBookingFlow() {
  console.log('[Test] Full booking flow test — fills form but stops before submit');

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const debugDir = '/Users/ej/Documents/ejwork/LeadInfo/BookingScreenshots/full-flow-test';
  await require('fs').promises.mkdir(debugDir, { recursive: true });

  // Lead data
  const leadName = 'Test Lead';
  const leadEmail = 'testlead@example.com';
  const leadPhone = '7135550001';
  const tourDate = '2026-06-23';
  const tourTime = '3:00 pm';

  try {
    // 1. Load page
    console.log('[Test] Loading coopsummerstreet.com');
    try {
      await page.goto('https://coopsummerstreet.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) { /* SPA may not fully load, continue */ }
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${debugDir}/01_loaded.png`, fullPage: true });

    // 2. Close lightbox
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const lightboxHidden = await page.evaluate(() => {
      const lb = document.querySelector('#screen-modular-lightbox, .lightbox-slug-special, .screen-lightbox');
      if (lb) { lb.style.display = 'none'; return true; }
      return false;
    });
    if (lightboxHidden) await page.waitForTimeout(500);
    await page.screenshot({ path: `${debugDir}/02_lightbox_closed.png`, fullPage: true });
    console.log('[Test] Lightbox closed');

    // 3. Click "Schedule" button
    const buttonSelectors = [
      'button:has-text("Schedule Tour")',
      'button:has-text("Schedule")',
      'a:has-text("Schedule")',
      'button:has-text("Tour")',
    ];
    let clicked = false;
    for (const sel of buttonSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        console.log(`[Test] Clicked: ${sel}`);
        break;
      }
    }
    if (!clicked) throw new Error('No booking button found');

    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${debugDir}/03_modal_open.png`, fullPage: true });

    // 4. Fill the form (all fields)
    // First name
    const firstName = page.locator('input[name*="firstName"], input[id*="firstName"], input[name*="first_name"], input[placeholder*="First" i]').first();
    if (await firstName.isVisible().catch(() => false)) {
      await firstName.fill('Test');
      console.log('[Test] Filled first name: Test');
    }

    // Last name
    const lastName = page.locator('input[name*="lastName"], input[id*="lastName"], input[name*="last_name"], input[placeholder*="Last" i]').first();
    if (await lastName.isVisible().catch(() => false)) {
      await lastName.fill('Lead');
      console.log('[Test] Filled last name: Lead');
    }

    // Email
    const email = page.locator('input[type="email"], input[name*="email"], input[id*="email"]').first();
    if (await email.isVisible().catch(() => false)) {
      await email.fill(leadEmail);
      console.log('[Test] Filled email:', leadEmail);
    }

    // Phone
    const phone = page.locator('input[type="tel"], input[name*="phone"], input[id*="phone"]').first();
    if (await phone.isVisible().catch(() => false)) {
      await phone.fill(leadPhone);
      console.log('[Test] Filled phone:', leadPhone);
    }

    // Date (if present)
    const dateField = page.locator('input[type="date"], input[name*="date"], input[id*="date"]').first();
    if (await dateField.isVisible().catch(() => false)) {
      await dateField.fill(tourDate);
      console.log('[Test] Filled date:', tourDate);
    }

    // Time (if present)
    const timeField = page.locator('select[name*="time"], select[id*="time"]').first();
    if (await timeField.isVisible().catch(() => false)) {
      const options = await timeField.locator('option').allTextContents();
      console.log('[Test] Available times:', options.slice(0, 10));
      // Try to select the requested time, or first available
      const timeToSelect = options.find(t => t.includes('3:00') || t.includes('3:00 pm')) || options[1];
      await timeField.selectOption(timeToSelect);
      console.log('[Test] Selected time:', timeToSelect);
    }

    // Tour type (select "In-Person Tour" if radio buttons)
    const inPersonRadio = page.locator('input[type="radio"][value*="in-person"], input[type="radio"][value*="In-Person"]').first();
    if (await inPersonRadio.isVisible().catch(() => false)) {
      await inPersonRadio.check();
      console.log('[Test] Selected In-Person Tour');
    }

    // Message
    const message = page.locator('textarea[name*="message"], textarea[id*="message"]').first();
    if (await message.isVisible().catch(() => false)) {
      await message.fill('Interested in touring this property');
      console.log('[Test] Filled message');
    }

    // 5. Screenshot of fully filled form
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${debugDir}/04_form_filled.png`, fullPage: true });
    console.log('[Test] Screenshot: 04_form_filled.png');

    // 6. STOP — Do NOT click submit
    console.log('[Test] ⏹️ STOPPING HERE — form is filled but NOT submitted');
    console.log('[Test] The "Book tour!" button is visible but will NOT be clicked');
    console.log('[Test] Screenshots saved to:', debugDir);

  } catch (err) {
    console.error('[Test] Error:', err.message);
    await page.screenshot({ path: `${debugDir}/error.png`, fullPage: true }).catch(() => {});
  } finally {
    await context.close();
    await browser.close();
  }
}

testFullBookingFlow();
