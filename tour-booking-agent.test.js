const assert = require('node:assert/strict');
const test = require('node:test');

const {
  bookToursForLead,
  calculateTourSchedule,
  detectBookingPlatform,
  validateBookingRequest,
} = require('./tour-booking-agent');

test('calculateTourSchedule builds 50 minute spaced ISO start times', () => {
  assert.deepEqual(calculateTourSchedule('14:00', 3, '2026-07-04'), [
    { date: '2026-07-04', time: '14:00', startsAt: '2026-07-04T14:00:00' },
    { date: '2026-07-04', time: '14:50', startsAt: '2026-07-04T14:50:00' },
    { date: '2026-07-04', time: '15:40', startsAt: '2026-07-04T15:40:00' },
  ]);
});

test('validateBookingRequest rejects missing CRM lead identity and bad time', () => {
  const result = validateBookingRequest({
    leadId: 'lead_123',
    clientPreferredTime: '2pm',
    properties: [{ name: 'The Cooper', website: 'https://example.com' }],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /leadId must be a positive integer/);
  assert.match(result.errors.join('\n'), /clientPreferredTime must be HH:MM/);
});

test('validateBookingRequest rejects non-numeric property ids', () => {
  const result = validateBookingRequest({
    leadId: 123,
    clientPreferredTime: '14:00',
    properties: [{ id: 'abc', name: 'The Cooper', website: 'https://example.com' }],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /properties\[0\]\.id must be a positive integer/);
});

test('validateBookingRequest accepts selectedProperties as the live workflow alias', () => {
  const result = validateBookingRequest({
    leadId: 123,
    clientPreferredTime: '14:00',
    selectedProperties: [{ id: 501, name: 'The Cooper', website: 'https://example.com' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.request.properties.length, 1);
  assert.equal(result.request.properties[0].id, 501);
});

test('detectBookingPlatform recognizes Appfolio, LeaseLabs, and generic pages', async () => {
  assert.equal(await detectBookingPlatform({
    content: async () => '<html>Powered by AppFolio Property Manager</html>',
    url: () => 'https://property.example.com',
  }), 'appfolio');

  assert.equal(await detectBookingPlatform({
    content: async () => '<html>Schedule with LeaseLabs</html>',
    url: () => 'https://property.example.com',
  }), 'leaselabs');

  assert.equal(await detectBookingPlatform({
    content: async () => '<html>Schedule a tour</html>',
    url: () => 'https://property.example.com',
  }), 'generic');
});

test('bookToursForLead returns non-mutating dry-run preview from CRM lead data', async () => {
  const calls = [];
  const httpClient = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/api/internal/leads/91')) {
        return {
          data: {
            leadId: 91,
            firstName: 'Casey',
            lastName: 'Walker',
            email: 'casey@example.com',
            phone: '+17135550123',
            moveInDate: '2026-08-01',
          },
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      if (url.endsWith('/api/internal/tours/create')) {
        return { data: { tourId: calls.length, ...body } };
      }
      if (url.endsWith('/api/internal/leads/91/itinerary')) {
        return { data: { leadId: 91, generated: true } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
  };

  const result = await bookToursForLead({
    leadId: 91,
    clientPreferredTime: '10:00',
    tourDate: '2026-07-04',
    dryRun: true,
    properties: [
      { id: 501, name: 'The Cooper', website: 'https://cooper.example.com', address: '123 Main St' },
      { id: 502, name: 'The Elm', website: 'https://elm.example.com', address: '456 Elm St' },
    ],
  }, null, null, { httpClient });

  assert.equal(result.success, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.bookings.length, 0);
  assert.equal(result.previewBookings.length, 2);
  assert.equal(result.previewBookings[0].wouldCreateTour, true);
  assert.equal(result.wouldCreateTours, 2);
  assert.equal(result.wouldGenerateItinerary, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.itinerary, null);

  const tourCreates = calls.filter(call => call.method === 'POST' && call.url.endsWith('/api/internal/tours/create'));
  assert.equal(tourCreates.length, 0);
  const itineraryRequest = calls.find(call => call.method === 'POST' && call.url.endsWith('/api/internal/leads/91/itinerary'));
  assert.equal(itineraryRequest, undefined);
});

test('bookToursForLead writes confirmed live tours and requests itinerary generation', async () => {
  const calls = [];
  const httpClient = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/api/internal/leads/91')) {
        return {
          data: {
            leadId: 91,
            firstName: 'Casey',
            lastName: 'Walker',
            email: 'casey@example.com',
            phone: '+17135550123',
            moveInDate: '2026-08-01',
          },
        };
      }
      // Pre-flight check for property websites
      if (url.startsWith('https://cooper.example.com') || url.startsWith('https://elm.example.com')) {
        return { status: 200, data: '<html>Schedule a tour</html>' };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      if (url.endsWith('/api/internal/tours/create')) {
        return { data: { tourId: calls.length, ...body } };
      }
      if (url.endsWith('/api/internal/leads/91/itinerary')) {
        return { data: { leadId: 91, generated: true } };
      }
      throw new Error(`unexpected POST ${url}`);
    },
  };

  const result = await bookToursForLead({
    leadId: 91,
    clientPreferredTime: '10:00',
    tourDate: '2026-07-04',
    properties: [
      { id: 501, name: 'The Cooper', website: 'https://cooper.example.com', address: '123 Main St' },
    ],
  }, null, null, {
    httpClient,
    launchBrowser: async () => ({}),
    bookPropertyTour: async () => ({
      success: true,
      confirmationNumber: 'live-91-1',
      bookedAt: '2026-06-21T12:00:00.000Z',
      platform: 'generic',
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.bookings.length, 1);
  assert.equal(result.itinerary.generated, true);

  const tourCreates = calls.filter(call => call.method === 'POST' && call.url.endsWith('/api/internal/tours/create'));
  assert.equal(tourCreates.length, 1);
  const itineraryRequest = calls.find(call => call.method === 'POST' && call.url.endsWith('/api/internal/leads/91/itinerary'));
  assert.deepEqual(itineraryRequest.body, {
    date: '2026-07-04',
    includeBackupProperties: true,
    sendDelivery: true,
    source: 'tour_booking_agent',
  });
  assert.deepEqual(tourCreates[0].body, {
    leadId: 91,
    propertyId: 501,
    propertyName: 'The Cooper',
    propertyAddress: '123 Main St',
    tourTime: '2026-07-04T10:00:00',
    requestedDate: '2026-07-04',
    confirmationNumber: 'live-91-1',
    status: 'confirmed',
    source: 'tour_booking_agent',
    bookingMetadata: {
      bookedAt: '2026-06-21T12:00:00.000Z',
      platform: 'generic',
      dryRun: false,
    },
  });
});

test('dry-run requestedCount limits CRM candidate preview without writeback', async () => {
  const calls = [];
  const httpClient = {
    async get(url) {
      calls.push({ method: 'GET', url });
      if (url.endsWith('/api/internal/leads/91')) return { data: { leadId: 91, firstName: 'Casey' } };
      if (url.endsWith('/api/internal/leads/91/tour-requests')) {
        return {
          data: [
            { propertyId: 501, propertyName: 'One', website: 'https://one.example.com' },
            { propertyId: 502, propertyName: 'Two', website: 'https://two.example.com' },
          ],
        };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      throw new Error(`unexpected POST ${url}`);
    },
  };

  const result = await bookToursForLead({
    leadId: 91,
    clientPreferredTime: '10:00',
    tourDate: '2026-07-04',
    dryRun: true,
    requestedCount: 1,
  }, null, null, { httpClient });

  assert.equal(result.success, true);
  assert.equal(result.previewBookings.length, 1);
  assert.equal(result.previewBookings[0].property, 'One');
  assert.equal(calls.filter(call => call.method === 'POST').length, 0);
});
