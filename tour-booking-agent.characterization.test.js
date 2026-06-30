/**
 * Characterization tests for bookGenericTour() and bookToursForLead().
 *
 * Purpose: capture CURRENT behavior (return values + exact external call
 * sequence/arguments) before refactoring, so the refactor can be verified
 * byte-for-byte against this baseline.
 *
 * Safety: every external dependency is faked in-process.
 *  - No real Playwright browser/page is ever created (bookGenericTour is
 *    driven with hand-built fake `page`/`frame` objects implementing only
 *    the methods the function under test calls).
 *  - No real HTTP calls: bookToursForLead is driven with a fake httpClient
 *    (no axios instance is ever used) and a fake launchBrowser/bookPropertyTour.
 *  - captureScreenshot's real fs.promises.mkdir/page.screenshot path is
 *    avoided by pointing TOUR_SCREENSHOT_DIR at the OS tmp dir AND by giving
 *    every fake page a no-op `screenshot()` method, so nothing is ever
 *    written under the real /Users/ej/... path and no actual image bytes
 *    are produced.
 *  - No calendar invites, SMS, email, or webhooks are reachable from this
 *    process at all; the module never calls those directly.
 */
process.env.TOUR_SCREENSHOT_DIR = require('os').tmpdir();

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bookGenericTour,
  bookToursForLead,
} = require('./tour-booking-agent');

// ─── Fake Playwright primitives ─────────────────────────────────────────────

function makeLocator({ visible = false, fillImpl, clickImpl, textContentImpl, allImpl } = {}) {
  return {
    isVisible: async () => visible,
    fill: fillImpl || (async () => {}),
    click: clickImpl || (async () => {}),
    textContent: textContentImpl || (async () => null),
    all: allImpl || (async () => []),
    selectOption: async () => { throw new Error('selectOption not supported by fake'); },
    evaluate: async () => {},
  };
}

// Builds a fake `page` whose `.locator(selector)` returns a visible,
// clickable "Schedule Tour" button locator, and is otherwise empty (no
// iframe, no other visible fields) so bookGenericTour falls through to the
// regular DOM-fill branch.
function makeBasePage({ calls, frames = [], confirmationText = null, formFieldVisibility = {} }) {
  const record = (name, ...args) => calls.push({ call: name, args });

  const page = {
    keyboard: {
      press: async (...args) => record('page.keyboard.press', ...args),
    },
    waitForTimeout: async (...args) => record('page.waitForTimeout', ...args),
    evaluate: async (fn, ...args) => {
      record('page.evaluate');
      return false; // no lightbox present by default
    },
    frames: () => {
      record('page.frames');
      return frames;
    },
    locator: (selector) => {
      record('page.locator', selector);
      if (/Schedule Tour|Schedule|Tour|Book/.test(selector) && selector.includes('button:has-text') === false) {
        // a/button "Book"/"Schedule" selectors used to find the launch button
      }
      if (selector.startsWith('button:has-text') || selector.startsWith('a:has-text')) {
        // booking trigger button selectors (step 1)
        return {
          first: () => makeLocator({
            visible: selector.includes('Schedule Tour'),
            clickImpl: async () => record('locator.click', selector),
          }),
        };
      }
      const visible = formFieldVisibility[selector] || false;
      return {
        first: () => makeLocator({
          visible,
          fillImpl: async (value) => record('locator.fill', selector, value),
          clickImpl: async () => record('locator.click', selector),
        }),
      };
    },
    waitForSelector: async (selector) => {
      record('page.waitForSelector', selector);
      if (!confirmationText) {
        const err = new Error(`Timeout waiting for selector ${selector}`);
        throw err;
      }
    },
    textContent: async (selector) => {
      record('page.textContent', selector);
      return confirmationText;
    },
    screenshot: async () => {
      record('page.screenshot');
    },
  };
  return page;
}

function makeFrame({ title, calls, fillThrows = {}, hasSubmitButton = true, confirmationBody = null, submitButtons = [] }) {
  const record = (name, ...args) => calls.push({ call: name, args });
  return {
    evaluate: async (fn) => {
      record('frame.evaluate');
      // Distinguish which evaluate call this is by the function body shape.
      const src = fn.toString();
      if (src.includes('document.title')) return title;
      if (src.includes('querySelectorAll')) {
        return hasSubmitButton ? { text: 'Book Tour', exists: true } : { exists: false };
      }
      if (src.includes('innerText')) {
        return confirmationBody;
      }
      return undefined;
    },
    locator: (selector) => {
      record('frame.locator', selector);
      return {
        fill: async (value) => {
          record('frame.locator.fill', selector, value);
          if (fillThrows[selector]) throw new Error(fillThrows[selector]);
        },
        all: async () => {
          record('frame.locator.all', selector);
          return submitButtons.map((label, i) => ({
            textContent: async () => label,
            click: async () => record('frame.button.click', label),
          }));
        },
      };
    },
  };
}

// ─── bookGenericTour characterization ───────────────────────────────────────

test('bookGenericTour [knock iframe success path] submits and returns confirmation', async () => {
  const calls = [];
  const widgetFrame = makeFrame({
    title: 'Knockbot Widgets Frame',
    calls,
    hasSubmitButton: true,
    confirmationBody: 'Thanks! Your tour has been booked for tomorrow.',
    submitButtons: ['Cancel', 'Book Tour'],
  });
  const page = makeBasePage({ calls, frames: [widgetFrame] });

  const property = { name: 'The Cooper', website: 'https://cooper.example.com' };
  const tourDetails = {
    leadId: 91,
    leadName: 'Casey Walker',
    leadEmail: 'casey@example.com',
    leadPhone: '+17135550123',
    date: '2026-07-04',
    time: '10:00',
    noSubmit: false,
  };

  const result = await bookGenericTour(page, property, tourDetails);

  assert.equal(result.success, true);
  assert.match(result.confirmationNumber, /^generic-\d+$/);
  assert.equal(result.confirmationText, 'Thanks! Your tour has been booked for tomorrow.');
  assert.ok(result.bookedAt);

  // Exact external call sequence/arguments (baseline)
  const calledNames = calls.map(c => c.call);
  assert.deepEqual(calledNames, [
    'page.keyboard.press',
    'page.waitForTimeout',
    'page.evaluate',
    'page.screenshot', // after_lightbox_close
    'page.locator',     // Schedule Tour selector match
    'locator.click',
    'page.waitForTimeout',
    'page.screenshot', // after_button_click
    'page.frames',
    'frame.evaluate',  // document.title check
    'frame.locator', 'frame.locator.fill', // firstName
    'frame.locator', 'frame.locator.fill', // lastName
    'frame.locator', 'frame.locator.fill', // email
    'frame.locator', 'frame.locator.fill', // phone
    'frame.locator', 'frame.locator.fill', // message
    'page.screenshot', // form_filled
    'frame.evaluate',  // submit button check
    'frame.locator', 'frame.locator.all', // find buttons to click
    'frame.button.click',
    'page.waitForTimeout',
    'page.screenshot', // after_submit
    'frame.evaluate',  // confirmation text check
  ]);

  assert.deepEqual(calls.find(c => c.call === 'locator.click').args, [
    'button:has-text("Schedule Tour")',
  ]);
  assert.deepEqual(
    calls.filter(c => c.call === 'frame.locator.fill').map(c => c.args),
    [
      ['#firstName', 'Casey'],
      ['#lastName', 'Walker'],
      ['#email', 'casey@example.com'],
      ['#Phone', '+17135550123'],
      ['textarea', 'Interested in touring this property'],
    ],
  );
});

test('bookGenericTour [knock iframe + noSubmit] fills form but does not click submit', async () => {
  const calls = [];
  const widgetFrame = makeFrame({
    title: 'Knockbot Widgets Frame',
    calls,
    hasSubmitButton: true,
    submitButtons: ['Book Tour'],
  });
  const page = makeBasePage({ calls, frames: [widgetFrame] });

  const property = { name: 'The Cooper', website: 'https://cooper.example.com' };
  const tourDetails = {
    leadId: 91,
    leadName: 'Casey Walker',
    leadEmail: 'casey@example.com',
    leadPhone: '+17135550123',
    noSubmit: true,
  };

  const result = await bookGenericTour(page, property, tourDetails);

  assert.equal(result.success, true);
  assert.match(result.confirmationNumber, /^generic-no-submit-\d+$/);
  assert.equal(result.confirmationText, 'Form filled but not submitted (noSubmit mode)');

  const calledNames = calls.map(c => c.call);
  // Must stop right after the submit-button-existence check; no click, no
  // further waitForTimeout/screenshot/confirmation evaluate.
  assert.ok(!calledNames.includes('frame.button.click'));
  assert.equal(calledNames.filter(c => c === 'page.screenshot').length, 3); // lightbox, button_click, form_filled
  assert.deepEqual(calledNames.slice(-2), ['page.screenshot', 'frame.evaluate']);
});

test('bookGenericTour [no booking button found] returns failure without touching a frame', async () => {
  const calls = [];
  const page = makeBasePage({ calls, frames: [] });
  // Override locator so the trigger-button selectors are never visible.
  page.locator = (selector) => {
    calls.push({ call: 'page.locator', args: [selector] });
    return { first: () => makeLocator({ visible: false }) };
  };

  const property = { name: 'The Elm', website: 'https://elm.example.com' };
  const tourDetails = { leadId: 91, leadName: 'Casey Walker', leadEmail: 'c@example.com', leadPhone: '123', noSubmit: false };

  const result = await bookGenericTour(page, property, tourDetails);

  assert.deepEqual(result, { success: false, error: 'No booking button found on page' });

  const calledNames = calls.map(c => c.call);
  assert.deepEqual(calledNames, [
    'page.keyboard.press',
    'page.waitForTimeout',
    'page.evaluate',
    'page.screenshot',
    'page.locator', 'page.locator', 'page.locator', 'page.locator', 'page.locator',
  ]);
  assert.ok(!calledNames.includes('page.frames'));
});

test('bookGenericTour [regular DOM fallback success] fills visible fields and submits', async () => {
  const calls = [];
  const formFieldVisibility = {
    'input[name*="firstName"], input[id*="firstName"], input[name*="first_name"]': true,
    'input[name*="lastName"], input[id*="lastName"], input[name*="last_name"]': true,
    'input[type="email"], input[name*="email"], input[id*="email"]': true,
    'input[type="tel"], input[name*="phone"], input[id*="phone"]': true,
    'button[type="submit"], input[type="submit"], button:has-text("Book tour"), button:has-text("Submit"), button:has-text("Schedule")': true,
  };
  const page = makeBasePage({
    calls,
    frames: [],
    confirmationText: 'Your tour request has been submitted!',
    formFieldVisibility,
  });

  const property = { name: 'The Elm', website: 'https://elm.example.com' };
  const tourDetails = {
    leadId: 91,
    leadName: 'Casey Walker',
    leadEmail: 'casey@example.com',
    leadPhone: '+17135550123',
    date: '2026-07-04',
    time: '10:00',
    noSubmit: false,
  };

  const result = await bookGenericTour(page, property, tourDetails);

  assert.equal(result.success, true);
  assert.match(result.confirmationNumber, /^generic-\d+$/);
  assert.equal(result.confirmationText, 'Your tour request has been submitted!');

  const fillCalls = calls.filter(c => c.call === 'locator.fill').map(c => c.args);
  assert.deepEqual(fillCalls, [
    ['input[name*="firstName"], input[id*="firstName"], input[name*="first_name"]', 'Casey'],
    ['input[name*="lastName"], input[id*="lastName"], input[name*="last_name"]', 'Walker'],
    ['input[type="email"], input[name*="email"], input[id*="email"]', 'casey@example.com'],
    ['input[type="tel"], input[name*="phone"], input[id*="phone"]', '+17135550123'],
  ]);

  const clickCalls = calls.filter(c => c.call === 'locator.click').map(c => c.args[0]);
  assert.deepEqual(clickCalls, [
    'button:has-text("Schedule Tour")',
    'button[type="submit"], input[type="submit"], button:has-text("Book tour"), button:has-text("Submit"), button:has-text("Schedule")',
  ]);
});

test('bookGenericTour [no confirmation found] returns failure after submit attempt', async () => {
  const calls = [];
  const page = makeBasePage({ calls, frames: [], confirmationText: null, formFieldVisibility: {} });

  const property = { name: 'The Elm', website: 'https://elm.example.com' };
  const tourDetails = { leadId: 91, leadName: 'Casey Walker', leadEmail: 'c@example.com', leadPhone: '123', noSubmit: false };

  const result = await bookGenericTour(page, property, tourDetails);

  assert.deepEqual(result, { success: false, error: 'No confirmation text found after form submission' });
});

test('bookGenericTour [unexpected exception] is caught and wrapped', async () => {
  const calls = [];
  const page = makeBasePage({ calls, frames: [] });
  page.keyboard.press = async () => { throw new Error('boom'); };

  const result = await bookGenericTour(page, { name: 'X' }, { leadName: 'A B', leadEmail: '', leadPhone: '' });

  assert.deepEqual(result, { success: false, error: 'Generic booking failed: boom' });
});

// ─── bookToursForLead characterization ──────────────────────────────────────
// (Existing tour-booking-agent.test.js already covers: dry-run preview,
//  live success + itinerary writeback, and CRM-tour-request limiting.
//  These add the failure/edge-case paths to pin down behavior before
//  refactor: validation failure, no-properties-available, and a mixed
//  success/failure booking batch that triggers the failure alert.)

test('bookToursForLead [validation failure] short-circuits before any external call', async () => {
  const calls = [];
  const httpClient = {
    get: async (url) => { calls.push({ method: 'GET', url }); throw new Error('should not be called'); },
    post: async (url) => { calls.push({ method: 'POST', url }); throw new Error('should not be called'); },
  };

  const result = await bookToursForLead({ leadId: 'not-a-number', clientPreferredTime: 'bad' }, null, null, { httpClient });

  assert.equal(result.success, false);
  assert.equal(result.message, 'Booking request failed validation');
  assert.deepEqual(result.bookings, []);
  assert.ok(result.errors.some(e => /leadId must be a positive integer/.test(e.reason)));
  assert.equal(calls.length, 0);
});

test('bookToursForLead [no properties available] returns REVIEW error without scheduling', async () => {
  const calls = [];
  const httpClient = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/api/internal/leads/91')) return { data: { leadId: 91, firstName: 'Casey' } };
      if (url.endsWith('/api/internal/leads/91/tour-requests')) return { data: [] };
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url) {
      calls.push({ method: 'POST', url });
      throw new Error(`unexpected POST ${url}`);
    },
  };

  const result = await bookToursForLead({
    leadId: 91,
    clientPreferredTime: '10:00',
    tourDate: '2026-07-04',
  }, null, null, { httpClient });

  assert.equal(result.success, false);
  assert.equal(result.message, 'No properties available to book');
  assert.deepEqual(result.errors, [{ reason: 'No tour request properties available from CRM', action: 'REVIEW' }]);
  assert.deepEqual(
    calls.map(c => `${c.method} ${c.url}`),
    [
      'GET http://localhost:3000/api/internal/leads/91',
      'GET http://localhost:3000/api/internal/leads/91/tour-requests',
    ],
  );
});

test('bookToursForLead [mixed success/failure] alerts on failures and still books/itinerary for successes', async () => {
  const calls = [];
  const httpClient = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/api/internal/leads/91')) {
        return { data: { leadId: 91, firstName: 'Casey', lastName: 'Walker', email: 'c@example.com', phone: '123' } };
      }
      if (url.startsWith('https://cooper.example.com')) {
        return { status: 200, data: '<html>Schedule a tour</html>' };
      }
      if (url.startsWith('https://broken.example.com')) {
        return { status: 200, data: '<html>nothing useful here</html>' };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      if (url.endsWith('/api/internal/tours/create')) return { data: { tourId: calls.length, ...body } };
      if (url.endsWith('/api/internal/alerts/booking-failures')) return { data: { alerted: true } };
      if (url.endsWith('/api/internal/leads/91/itinerary')) return { data: { leadId: 91, generated: true } };
      throw new Error(`unexpected POST ${url}`);
    },
  };

  const bookerCalls = [];
  const result = await bookToursForLead({
    leadId: 91,
    clientPreferredTime: '10:00',
    tourDate: '2026-07-04',
    properties: [
      { id: 501, name: 'The Cooper', website: 'https://cooper.example.com', address: '123 Main St' },
      { id: 502, name: 'The Broken One', website: 'https://broken.example.com', address: '456 Elm St' },
      { id: 503, name: 'No Website Co', website: '' },
    ],
  }, null, null, {
    httpClient,
    launchBrowser: async () => ({ closed: false }),
    bookPropertyTour: async (browser, property, tourDetails) => {
      bookerCalls.push({ property: property.name, tourDetails });
      return {
        success: true,
        confirmationNumber: `live-91-${property.id}`,
        bookedAt: '2026-06-21T12:00:00.000Z',
        platform: 'generic',
      };
    },
  });

  assert.equal(result.success, false); // not all 3 properties booked
  assert.equal(result.message, 'Booked 1/3 tours');
  assert.equal(result.bookings.length, 1);
  assert.equal(result.bookings[0].property, 'The Cooper');
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map(e => e.property), ['The Broken One', 'No Website Co']);
  assert.equal(result.errors[0].reason, 'No booking-related content found on page');
  assert.equal(result.errors[1].reason, 'No booking website available');
  assert.equal(result.itinerary.generated, true);

  // booker only invoked for the property that passed pre-flight
  assert.deepEqual(bookerCalls.map(c => c.property), ['The Cooper']);

  const callSummaries = calls.map(c => `${c.method} ${c.url}`);
  assert.deepEqual(callSummaries, [
    'GET http://localhost:3000/api/internal/leads/91',
    'GET https://cooper.example.com',
    'GET https://broken.example.com',
    'POST http://localhost:3000/api/internal/tours/create',
    'POST http://localhost:3000/api/internal/alerts/booking-failures',
    'POST http://localhost:3000/api/internal/leads/91/itinerary',
  ]);

  const alertCall = calls.find(c => c.url.endsWith('/api/internal/alerts/booking-failures'));
  assert.deepEqual(alertCall.body.errors.map(e => e.property), ['The Broken One', 'No Website Co']);
  assert.equal(alertCall.body.leadId, 91);
});

test('bookToursForLead [fatal error before booking loop] is caught and reported', async () => {
  const calls = [];
  const httpClient = {
    async get(url) {
      calls.push({ method: 'GET', url });
      throw new Error('CRM unreachable');
    },
    async post() { throw new Error('should not be called'); },
  };

  const result = await bookToursForLead({
    leadId: 91,
    clientPreferredTime: '10:00',
    tourDate: '2026-07-04',
    properties: [{ id: 501, name: 'The Cooper', website: 'https://cooper.example.com' }],
  }, null, null, { httpClient });

  assert.equal(result.success, false);
  assert.equal(result.error, 'CRM unreachable');
  assert.deepEqual(result.bookings, []);
  assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['GET http://localhost:3000/api/internal/leads/91']);
});
