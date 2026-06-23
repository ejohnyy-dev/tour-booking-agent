const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1452, height: 890 } });
  const page = await context.newPage();
  
  try {
    // 1. Navigate to property page
    await page.goto('https://coopsummerstreet.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    
    // 2. Dismiss promotional lightbox
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const lb = document.querySelector('#screen-modular-lightbox');
      if (lb) lb.style.display = 'none';
    });
    await page.waitForTimeout(500);
    
    // 3. Click "Schedule a Tour" button
    const btn = page.locator('a:has-text("Schedule")').first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      console.log('Clicked Schedule button');
    }
    
    // 4. Wait for modal to open (wait longer for iframe to load)
    await page.waitForTimeout(5000);
    
    // 5. Find the Knockbot Widgets Frame
    const frames = page.frames();
    console.log('Total frames:', frames.length);
    
    let widgetFrame = null;
    for (const f of frames) {
      try {
        const title = await f.evaluate(() => document.title).catch(() => '');
        console.log('Frame title:', title, 'URL:', f.url().substring(0, 80));
        if (title === 'Knockbot Widgets Frame') {
          widgetFrame = f;
          break;
        }
      } catch (e) {}
    }
    
    if (!widgetFrame) {
      console.log('ERROR: Knockbot Widgets Frame not found');
      await browser.close();
      process.exit(1);
    }
    
    console.log('Found Knockbot Widgets Frame');
    
    // 6. Fill form fields using Playwright's fill() on iframe elements
    await widgetFrame.locator('#firstName').fill('EJ');
    console.log('Filled firstName');
    
    await widgetFrame.locator('#lastName').fill('Johnson');
    console.log('Filled lastName');
    
    await widgetFrame.locator('#email').fill('ej@example.com');
    console.log('Filled email');
    
    await widgetFrame.locator('#Phone').fill('5551234567');
    console.log('Filled phone');
    
    await widgetFrame.locator('textarea').fill('Looking for a 2-bedroom apartment. Would like to schedule a tour.');
    console.log('Filled message');
    
    // 7. Wait for UI to update
    await widgetFrame.waitForTimeout(1000);
    
    // 8. Take screenshot of filled form (without submitting)
    await page.screenshot({ 
      path: '/Users/ej/Documents/ejwork/LeadInfo/BookingScreenshots/playwright_form_filled_final_v2.png',
      fullPage: false 
    });
    console.log('Screenshot saved');
    
    // 9. Verify fields are filled
    const values = await widgetFrame.evaluate(() => {
      return {
        firstName: document.querySelector('#firstName')?.value || '',
        lastName: document.querySelector('#lastName')?.value || '',
        email: document.querySelector('#email')?.value || '',
        phone: document.querySelector('#Phone')?.value || '',
        message: document.querySelector('textarea')?.value || '',
      };
    });
    
    console.log('Form values:', JSON.stringify(values, null, 2));
    
    // 10. Check for submit button but DON'T click
    const submitBtn = await widgetFrame.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const b of btns) {
        const text = b.textContent.trim().toLowerCase();
        if (text.includes('book') || text.includes('submit') || text.includes('schedule') || text.includes('send')) {
          return { text: b.textContent.trim(), exists: true };
        }
      }
      return { exists: false };
    });
    
    console.log('Submit button found:', submitBtn);
    
    await browser.close();
    console.log('SUCCESS: Form filled but NOT submitted');
    
  } catch (e) {
    console.error('Error:', e.message);
    await browser.close();
    process.exit(1);
  }
})();
