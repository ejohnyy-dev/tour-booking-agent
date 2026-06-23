const playwright = require('playwright');

async function inspectForm() {
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  await page.goto('https://coopsummerstreet.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);
  
  // Close lightbox
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const lb = document.querySelector('#screen-modular-lightbox, .lightbox-slug-special');
    if (lb) lb.style.display = 'none';
  });
  await page.waitForTimeout(500);
  
  // Click Schedule
  const btn = page.locator('a:has-text("Schedule")').first();
  if (await btn.isVisible().catch(() => false)) await btn.click();
  await page.waitForTimeout(3000);
  
  // Check each frame for inputs
  const frames = page.frames();
  console.log(`Total frames: ${frames.length}`);
  
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const url = frame.url();
    const inputs = await frame.locator('input, textarea, select').all();
    if (inputs.length > 0) {
      console.log(`\nFrame ${i}: ${url} — ${inputs.length} inputs`);
      for (let j = 0; j < Math.min(inputs.length, 10); j++) {
        const tag = await inputs[j].evaluate(e => e.tagName);
        const type = await inputs[j].evaluate(e => e.type);
        const name = await inputs[j].evaluate(e => e.name);
        const id = await inputs[j].evaluate(e => e.id);
        const placeholder = await inputs[j].evaluate(e => e.placeholder);
        console.log(`  [${j}] ${tag} type=${type} name=${name} id=${id} placeholder=${placeholder}`);
      }
    } else {
      console.log(`Frame ${i}: ${url} — no inputs`);
    }
  }
  
  await browser.close();
}

inspectForm();
