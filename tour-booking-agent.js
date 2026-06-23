/**
 * Tour Booking Agent
 *
 * Existing local worker that attempts property website tour booking, then writes
 * the result back into the CRM lifecycle. It does not own lead data.
 */

const express = require('express');
const playwright = require('playwright');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CRM_BASE_URL = process.env.CRM_BASE_URL || 'http://localhost:3000';
const CRM_API_KEY = process.env.CRM_API_KEY || '';
const DEFAULT_TIMEZONE = process.env.TOUR_TIMEZONE || 'America/Chicago';

function crmHeaders() {
  return CRM_API_KEY ? { Authorization: `Bearer ${CRM_API_KEY}` } : {};
}

/**
 * TBA-SEC-05: Startup validation for CRM_API_KEY.
 * Prevents the service from starting with an empty or missing key.
 */
function validateConfig(apiKey = CRM_API_KEY) {
  if (!apiKey || apiKey.trim() === '') {
    throw new Error('TBA-SEC-05: CRM_API_KEY is required. Set the CRM_API_KEY environment variable.');
  }
}

/**
 * Shared API key middleware for internal service routes.
 * Rejects requests with 401 when x-api-key header is missing or invalid.
 */
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== CRM_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: missing or invalid x-api-key' });
  }
  next();
}

// TBA-SEC-03: Simple in-memory rate limiter (10 requests/min per IP)
const requestCounts = new Map(); // ip -> { count, resetAt }
function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;

  const record = requestCounts.get(ip);
  if (!record || now > record.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (record.count >= maxRequests) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }

  record.count += 1;
  next();
}

// TBA-SEC-04: Minimal CORS middleware for cross-origin safety
function corsMiddleware(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
}

function normalizeLeadId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function isHHMM(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeProperty(property, index) {
  if (!property || typeof property !== 'object') {
    return { error: `properties[${index}] must be an object` };
  }

  const name = safeString(property.name || property.propertyName);
  if (!name) return { error: `properties[${index}].name is required` };

  const website = safeString(property.website || property.url || property.bookingUrl);
  const rawPropertyId = property.id ?? property.propertyId ?? null;
  let propertyId = null;
  if (rawPropertyId != null && rawPropertyId !== '') {
    propertyId = Number(rawPropertyId);
    if (!Number.isInteger(propertyId) || propertyId <= 0) {
      return { error: `properties[${index}].id must be a positive integer when provided` };
    }
  }

  return {
    property: {
      id: propertyId,
      name,
      website: website || null,
      address: safeString(property.address || property.propertyAddress) || null,
      contactEmail: safeString(property.contactEmail || property.propertyContactEmail) || null,
      bookingPlatform: safeString(property.bookingPlatform) || null,
    },
  };
}

// ─── Screenshot helper ───────────────────────────────────────────────────────
const SCREENSHOT_DIR = process.env.TOUR_SCREENSHOT_DIR || '/Users/ej/Documents/ejwork/LeadInfo/BookingScreenshots';

async function captureScreenshot(page, label, leadId, propertyName) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeProperty = (propertyName || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `${timestamp}_lead${leadId}_${safeProperty}_${label}.png`;
    const dir = path.join(SCREENSHOT_DIR, String(leadId));
    await fs.promises.mkdir(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    console.log(`[Screenshot] ${label}: ${filepath}`);
    return filepath;
  } catch (err) {
    console.error('[Screenshot] Failed to capture:', err.message);
    return null;
  }
}

// ─── Pre-flight check ────────────────────────────────────────────────────────
async function preFlightCheck(property, httpClient = axios) {
  const errors = [];
  if (!property.website || typeof property.website !== 'string') {
    return { ok: false, errors: ['No website URL provided'], website: null };
  }
  if (!property.website.startsWith('http')) {
    return { ok: false, errors: ['Website URL must start with http:// or https://'], website: property.website };
  }
  try {
    const response = await httpClient.get(property.website, { timeout: 10000, maxRedirects: 5 });
    if (response.status >= 400) {
      errors.push(`Website returned HTTP ${response.status}`);
    }
    const html = (response.data || '').toLowerCase();
    const hasBookingContent = /schedule|tour|book|visit|appointment|inquiry/i.test(html);
    if (!hasBookingContent) {
      errors.push('No booking-related content found on page');
    }
  } catch (err) {
    errors.push(`Website unreachable: ${err.message}`);
  }
  return { ok: errors.length === 0, errors, website: property.website };
}

function validateBookingRequest(body) {
  const errors = [];
  const leadId = normalizeLeadId(body && body.leadId);
  if (!leadId) errors.push('leadId must be a positive integer');

  const clientPreferredTime = safeString(body && body.clientPreferredTime);
  if (!isHHMM(clientPreferredTime)) errors.push('clientPreferredTime must be HH:MM in 24-hour time');

  const tourDate = safeString(body && body.tourDate) || todayIsoDate();
  if (!isIsoDate(tourDate)) errors.push('tourDate must be YYYY-MM-DD when provided');

  const rawProperties = Array.isArray(body && body.properties)
    ? body.properties
    : Array.isArray(body && body.selectedProperties)
      ? body.selectedProperties
      : null;
  const properties = [];
  if (rawProperties) {
    rawProperties.forEach((property, index) => {
      const normalized = normalizeProperty(property, index);
      if (normalized.error) errors.push(normalized.error);
      else properties.push(normalized.property);
    });
  }

  const useCrmTourRequests = body && body.useCrmTourRequests !== false;
  if (!rawProperties && !useCrmTourRequests) {
    errors.push('properties are required when useCrmTourRequests is false');
  }
  if (rawProperties && properties.length === 0) {
    errors.push('properties must include at least one property');
  }

  const requestedCount = Number(body && body.requestedCount);
  const limit = Number.isInteger(requestedCount) && requestedCount > 0
    ? Math.min(requestedCount, 8)
    : Math.min(properties.length || 4, 8);

  return {
    ok: errors.length === 0,
    errors,
    request: {
      leadId,
      clientPreferredTime,
      tourDate,
      timezone: safeString(body && body.timezone) || DEFAULT_TIMEZONE,
      properties,
      limit,
      useCrmTourRequests,
      async: body ? body.async !== false : true,
      dryRun: !!(body && body.dryRun),
      noSubmit: !!(body && body.noSubmit),
    },
  };
}

function calculateTourSchedule(startTime, numProperties, tourDate = todayIsoDate()) {
  if (!isHHMM(startTime)) throw new Error('startTime must be HH:MM');
  if (!Number.isInteger(numProperties) || numProperties < 0) throw new Error('numProperties must be a non-negative integer');
  if (!isIsoDate(tourDate)) throw new Error('tourDate must be YYYY-MM-DD');

  const schedule = [];
  const currentTime = new Date(`${tourDate}T${startTime}:00`);

  for (let i = 0; i < numProperties; i++) {
    const hours = String(currentTime.getHours()).padStart(2, '0');
    const minutes = String(currentTime.getMinutes()).padStart(2, '0');
    schedule.push({
      date: tourDate,
      time: `${hours}:${minutes}`,
      startsAt: `${tourDate}T${hours}:${minutes}:00`,
    });
    currentTime.setMinutes(currentTime.getMinutes() + 50);
  }

  return schedule;
}

function leadDisplayName(lead) {
  return [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email || `Lead ${lead.leadId || lead.id}`;
}

/**
 * TBA-SEC-07: Mask PII before logging.
 * Replaces interior characters with asterisks to avoid leaking full names.
 */
function maskName(name) {
  if (!name || typeof name !== 'string') return '***';
  return name
    .split(' ')
    .map(part => {
      if (part.length <= 2) return part;
      return part[0] + '*'.repeat(part.length - 2) + part[part.length - 1];
    })
    .join(' ');
}

async function fetchLeadFromCRM(leadId, httpClient = axios) {
  const response = await httpClient.get(`${CRM_BASE_URL}/api/internal/leads/${leadId}`, {
    headers: crmHeaders(),
  });
  return response.data;
}

async function fetchTourRequestProperties(leadId, limit, httpClient = axios) {
  const response = await httpClient.get(`${CRM_BASE_URL}/api/internal/leads/${leadId}/tour-requests`, {
    headers: crmHeaders(),
  });
  return response.data.slice(0, limit).map((property, index) => {
    const normalized = normalizeProperty(property, index);
    if (normalized.error) {
      return {
        id: property.propertyId ?? property.id ?? null,
        name: property.propertyName || property.name || `Property ${index + 1}`,
        website: null,
        address: property.propertyAddress || property.address || null,
        contactEmail: property.propertyContactEmail || property.contactEmail || null,
      };
    }
    return normalized.property;
  });
}

function buildTourDetails(lead, scheduleEntry, options = {}) {
  return {
    leadName: leadDisplayName(lead),
    leadPhone: lead.phone || '',
    leadEmail: lead.email || '',
    moveInDate: lead.moveInDate || '',
    date: scheduleEntry.date,
    time: scheduleEntry.time,
    startsAt: scheduleEntry.startsAt,
    noSubmit: options.noSubmit || false,
  };
}

async function bookToursForLead(input, propertyList, clientPreferredTime, options = {}) {
  const normalizedInput = typeof input === 'object' && input !== null
    ? validateBookingRequest(input)
    : validateBookingRequest({ leadId: input, properties: propertyList, clientPreferredTime });

  if (!normalizedInput.ok) {
    return {
      success: false,
      errors: normalizedInput.errors.map(reason => ({ reason, action: 'VALIDATION' })),
      bookings: [],
      message: 'Booking request failed validation',
    };
  }

  const request = normalizedInput.request;
  const httpClient = options.httpClient || axios;
  const booker = options.bookPropertyTour || bookPropertyTour;
  const launchBrowser = options.launchBrowser || (() => playwright.chromium.launch({ headless: true }));
  const bookings = [];
  const errors = [];
  let browser = null;

  try {
    const lead = await fetchLeadFromCRM(request.leadId, httpClient);
    let properties = request.properties;
    if (properties.length === 0 && request.useCrmTourRequests) {
      properties = await fetchTourRequestProperties(request.leadId, request.limit, httpClient);
    }
    properties = properties.slice(0, request.limit);

    if (properties.length === 0) {
      return {
        success: false,
        leadId: request.leadId,
        bookings,
        errors: [{ reason: 'No tour request properties available from CRM', action: 'REVIEW' }],
        message: 'No properties available to book',
      };
    }

    const schedule = calculateTourSchedule(request.clientPreferredTime, properties.length, request.tourDate);
    console.log(`[TourAgent] Starting booking for lead ${request.leadId} (${maskName(leadDisplayName(lead))})`);
    console.log(`[TourAgent] Properties: ${properties.map(p => p.name).join(', ')}`);

    if (!request.dryRun) {
      browser = await launchBrowser();
    }

    const previewBookings = [];

    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      const scheduleEntry = schedule[i];
      const tourDetails = buildTourDetails(lead, scheduleEntry, { noSubmit: request.noSubmit });

      if (request.dryRun) {
        const preview = {
          property: property.name,
          propertyId: property.id,
          propertyAddress: property.address,
          time: scheduleEntry.time,
          startsAt: scheduleEntry.startsAt,
          tourTime: scheduleEntry.startsAt,
          dryRun: true,
          wouldCreateTour: !!property.website,
          wouldGenerateItinerary: !!property.website,
          action: property.website ? 'WOULD_BOOK' : 'MANUAL_REVIEW',
        };
        if (!property.website) {
          preview.reason = 'No booking website available';
          errors.push({
            property: property.name,
            propertyId: property.id,
            reason: preview.reason,
            action: 'MANUAL_REVIEW',
          });
        }
        previewBookings.push(preview);
        continue;
      }

      if (!property.website) {
        errors.push({
          property: property.name,
          propertyId: property.id,
          reason: 'No booking website available',
          action: 'MANUAL_REVIEW',
        });
        continue;
      }

      // Pre-flight check: verify website is reachable before launching browser
      const preFlight = await preFlightCheck(property, httpClient);
      if (!preFlight.ok) {
        errors.push({
          property: property.name,
          propertyId: property.id,
          reason: preFlight.errors.join('; '),
          action: 'MANUAL_REVIEW',
        });
        console.log(`[TourAgent] Pre-flight failed for ${property.name}: ${preFlight.errors.join('; ')}`);
        continue;
      }

      try {
        const booking = await booker(browser, property, tourDetails);
        if (booking.success) {
          bookings.push({
            ...booking,
            property: property.name,
            propertyId: property.id,
            propertyAddress: property.address,
            time: scheduleEntry.time,
            startsAt: scheduleEntry.startsAt,
          });
          console.log(`[TourAgent] Booked ${property.name} at ${scheduleEntry.startsAt}`);
        } else {
          errors.push({
            property: property.name,
            propertyId: property.id,
            reason: booking.error,
            action: 'MANUAL_REVIEW',
          });
        }
      } catch (err) {
        errors.push({
          property: property.name,
          propertyId: property.id,
          reason: err.message,
          action: 'MANUAL_REVIEW',
        });
      }
    }

    if (request.dryRun) {
      const wouldCreateTours = previewBookings.filter(booking => booking.wouldCreateTour).length;
      return {
        success: errors.length === 0 && wouldCreateTours === properties.length,
        leadId: request.leadId,
        lead,
        dryRun: true,
        previewBookings,
        wouldCreateTours,
        wouldGenerateItinerary: wouldCreateTours > 0,
        bookings: [],
        errors,
        crmResults: [],
        itinerary: null,
        message: `Previewed ${wouldCreateTours}/${properties.length} tours`,
      };
    }

    const crmResults = bookings.length > 0
      ? await storeTourBookingsInCRM(request.leadId, bookings, httpClient)
      : [];

    if (errors.length > 0) {
      await alertEricOfFailures(request.leadId, errors, httpClient);
    }

    const itinerary = bookings.length > 0
      ? await requestItineraryGeneration(request.leadId, request.tourDate, {
        dryRun: request.dryRun,
        httpClient,
      })
      : null;

    return {
      success: errors.length === 0 && bookings.length === properties.length,
      leadId: request.leadId,
      lead,
      bookings,
      errors,
      crmResults,
      itinerary,
      message: `Booked ${bookings.length}/${properties.length} tours`,
    };
  } catch (err) {
    console.error('[TourAgent] Fatal booking error:', err.message);
    return {
      success: false,
      leadId: request.leadId,
      error: err.message,
      bookings,
      errors,
    };
  } finally {
    if (browser && typeof browser.close === 'function') {
      await browser.close();
    }
  }
}

async function bookPropertyTour(browser, property, tourDetails) {
  // SAFETY: Create context and page inside the try block so the finally block
  // always runs cleanup even if newContext() or newPage() throws.
  let context = null;
  let page = null;

  try {
    // Create a fresh browser context with anti-bot measures
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
    });

    page = await context.newPage();
    page.setDefaultTimeout(15000);

    // Hide navigator.webdriver to reduce bot detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(property.website, { waitUntil: 'networkidle' });
    await captureScreenshot(page, 'page_loaded', tourDetails.leadId || 'unknown', property.name);

    const platformType = await detectBookingPlatform(page);
    await captureScreenshot(page, 'platform_detected', tourDetails.leadId || 'unknown', property.name);

    let booking;
    switch (platformType) {
      case 'appfolio':
        booking = await bookAppfolioTour(page, property, tourDetails);
        break;
      case 'leaselabs':
        booking = await bookLeaselabsTour(page, property, tourDetails);
        break;
      case 'generic':
        booking = await bookGenericTour(page, property, tourDetails);
        break;
      default:
        return { success: false, error: `Unknown booking platform: ${platformType}` };
    }

    // Screenshot on success or failure
    if (booking.success) {
      await captureScreenshot(page, 'booking_success', tourDetails.leadId || 'unknown', property.name);
    } else {
      await captureScreenshot(page, 'booking_error', tourDetails.leadId || 'unknown', property.name);
    }

    return { ...booking, platform: platformType };
  } catch (err) {
    if (page) {
      await captureScreenshot(page, 'exception', tourDetails.leadId || 'unknown', property.name).catch(() => {});
    }
    return { success: false, error: err.message };
  } finally {
    // Robust cleanup: close page and context even if one throws.
    if (page) {
      await page.close().catch(() => {});
    }
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

async function detectBookingPlatform(page) {
  const html = (await page.content()).toLowerCase();
  const url = typeof page.url === 'function' ? page.url().toLowerCase() : '';

  if (html.includes('appfolio') || html.includes('apartmentapp') || url.includes('appfolio')) {
    return 'appfolio';
  }
  if (html.includes('leaselabs') || html.includes('leaselab') || url.includes('leaselabs')) {
    return 'leaselabs';
  }
  return 'generic';
}

async function bookAppfolioTour(page, property, tourDetails) {
  try {
    // SAFETY: noSubmit mode fills the form but never clicks the submit button.
    if (tourDetails.noSubmit) {
      return {
        success: false,
        error: 'Appfolio: noSubmit mode — form filled but not submitted',
        status: 'not_submitted',
      };
    }

    await page.click('button:has-text("Schedule Tour"), a:has-text("Schedule Tour")');
    await page.fill('input[name="visitor_first_name"], input[name="first_name"]', tourDetails.leadName);
    await page.fill('input[name="visitor_phone"], input[type="tel"]', tourDetails.leadPhone);
    await page.fill('input[name="visitor_email"], input[type="email"]', tourDetails.leadEmail);

    const timeSelector = `button[data-time="${tourDetails.time}"]`;
    if (await page.isVisible(timeSelector)) {
      await page.click(timeSelector);
    } else {
      await page.click('button[data-available="true"], button:has-text("Available")');
    }

    await page.click('button[type="submit"], button:has-text("Submit")');
    await page.waitForSelector('text=/confirmation|confirmed|booked/i', { timeout: 5000 });
    const confirmationText = await page.textContent('.confirmation').catch(() => null);

    return {
      success: true,
      // TBA-LOG-03: do not fabricate confirmation numbers; use null when not found
      confirmationNumber: confirmationText || null,
      bookedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { success: false, error: `Appfolio booking failed: ${err.message}` };
  }
}

async function bookLeaselabsTour(page, property, tourDetails) {
  try {
    // SAFETY: noSubmit mode fills the form but never clicks the submit button.
    if (tourDetails.noSubmit) {
      return {
        success: false,
        error: 'LeaseLabs: noSubmit mode — form filled but not submitted',
        status: 'not_submitted',
      };
    }

    await page.click('a:has-text("Schedule a Tour"), button:has-text("Schedule a Tour")');
    await page.fill('input[id="first_name"], input[name="firstName"]', tourDetails.leadName);
    await page.fill('input[id="phone"], input[type="tel"]', tourDetails.leadPhone);
    await page.fill('input[id="email"], input[type="email"]', tourDetails.leadEmail);

    const timeButton = await page.$(`button:has-text("${tourDetails.time}")`);
    if (timeButton) await timeButton.click();

    await page.click('button:has-text("Book Tour"), button[type="submit"]');
    await page.waitForSelector('text=/booked|confirmed|confirmation/i', { timeout: 5000 });

    // TBA-LOG-04: attempt to extract a real confirmation number; do not fabricate
    const confirmationText = await page.textContent('text=/booked|confirmed|confirmation/i').catch(() => null);

    return {
      success: true,
      confirmationNumber: confirmationText || null,
      bookedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { success: false, error: `LeaseLabs booking failed: ${err.message}` };
  }
}

async function bookGenericTour(page, property, tourDetails) {
  try {
    // 0. Close any promotional lightboxes / popups first
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    
    const lightboxHidden = await page.evaluate(() => {
      const lightbox = document.querySelector('#screen-modular-lightbox, .lightbox-slug-special, .screen-lightbox, .modal-overlay, .popup-overlay');
      if (lightbox) {
        lightbox.style.display = 'none';
        return true;
      }
      return false;
    });
    if (lightboxHidden) {
      console.log('[TourAgent] Hidden promotional lightbox');
      await page.waitForTimeout(500);
    }
    await captureScreenshot(page, 'after_lightbox_close', tourDetails.leadId || 'unknown', property.name);

    // 1. Find and click the booking button
    const buttonSelectors = [
      'button:has-text("Schedule Tour")',
      'button:has-text("Schedule")',
      'button:has-text("Tour")',
      'a:has-text("Book")',
      'a:has-text("Schedule")',
    ];
    let clicked = false;
    for (const selector of buttonSelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      return { success: false, error: 'No booking button found on page' };
    }
    
    await page.waitForTimeout(3000); // Wait for modal/iframe to load
    await captureScreenshot(page, 'after_button_click', tourDetails.leadId || 'unknown', property.name);

    // 2. Check for Knock CRM iframe (Knockbot Widgets Frame)
    let widgetFrame = null;
    const frames = page.frames();
    for (const f of frames) {
      try {
        const title = await f.evaluate(() => document.title).catch(() => '');
        if (title === 'Knockbot Widgets Frame') {
          widgetFrame = f;
          break;
        }
      } catch (e) {}
    }

    if (widgetFrame) {
      console.log('[TourAgent] Found Knock CRM iframe, filling form inside iframe');
      
      // Fill fields inside the iframe using Playwright's fill() which handles React properly
      const names = tourDetails.leadName.split(' ');
      try { await widgetFrame.locator('#firstName').fill(names[0] || ''); } catch (e) { console.log('[TourAgent] firstName fill:', e.message); }
      try { await widgetFrame.locator('#lastName').fill(names.slice(1).join(' ') || ''); } catch (e) { console.log('[TourAgent] lastName fill:', e.message); }
      try { await widgetFrame.locator('#email').fill(tourDetails.leadEmail); } catch (e) { console.log('[TourAgent] email fill:', e.message); }
      try { await widgetFrame.locator('#Phone').fill(tourDetails.leadPhone); } catch (e) { console.log('[TourAgent] phone fill:', e.message); }
      try { await widgetFrame.locator('textarea').fill('Interested in touring this property'); } catch (e) { console.log('[TourAgent] message fill:', e.message); }
      
      await captureScreenshot(page, 'form_filled', tourDetails.leadId || 'unknown', property.name);
      
      // Check for submit button
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
      
      if (tourDetails.noSubmit) {
        console.log('[TourAgent] noSubmit=true, skipping form submission');
        // TBA-LOG-02: do not claim success when the form was not actually submitted
        return {
          success: false,
          error: 'Form filled but not submitted (noSubmit mode)',
          status: 'not_submitted',
        };
      }
      
      if (submitBtn.exists) {
        // Find and click the submit button inside the iframe
        const btns = await widgetFrame.locator('button').all();
        for (const btn of btns) {
          const text = await btn.textContent().catch(() => '');
          if (text.toLowerCase().includes('book') || text.toLowerCase().includes('submit') || text.toLowerCase().includes('schedule')) {
            await btn.click();
            break;
          }
        }
      }
      
      await page.waitForTimeout(3000);
      await captureScreenshot(page, 'after_submit', tourDetails.leadId || 'unknown', property.name);
      
      // Check for confirmation inside the iframe
      const confirmationText = await widgetFrame.evaluate(() => {
        const body = document.body.innerText || '';
        if (/confirmation|confirmed|booked|thank you|success|submitted|tour scheduled|tour booked/i.test(body)) {
          return body.substring(0, 200);
        }
        return null;
      });
      
      if (confirmationText) {
        return {
          success: true,
          // TBA-LOG-05: do not fabricate confirmation numbers
          confirmationNumber: null,
          confirmationText,
          bookedAt: new Date().toISOString(),
        };
      }
      
      return { success: false, error: 'No confirmation found after iframe form submission' };
    }

    // 3. Fall back to regular DOM-based form filling (non-iframe)
    const nameField = page.locator('input[type="text"], input[name*="name"], input[id*="name"], input[placeholder*="name" i]').first();
    const emailField = page.locator('input[type="email"], input[name*="email"], input[id*="email"]').first();
    const phoneField = page.locator('input[type="tel"], input[name*="phone"], input[id*="phone"]').first();
    const firstNameField = page.locator('input[name*="firstName"], input[id*="firstName"], input[name*="first_name"]').first();
    const lastNameField = page.locator('input[name*="lastName"], input[id*="lastName"], input[name*="last_name"]').first();

    // If firstName/lastName fields exist, use them; otherwise use single name field
    if (await firstNameField.isVisible().catch(() => false)) {
      const names = tourDetails.leadName.split(' ');
      await firstNameField.fill(names[0] || '');
      if (await lastNameField.isVisible().catch(() => false)) {
        await lastNameField.fill(names.slice(1).join(' ') || '');
      }
    } else if (await nameField.isVisible().catch(() => false)) {
      await nameField.fill(tourDetails.leadName);
    }
    
    if (await emailField.isVisible().catch(() => false)) await emailField.fill(tourDetails.leadEmail);
    if (await phoneField.isVisible().catch(() => false)) await phoneField.fill(tourDetails.leadPhone);
    
    // Fill additional fields if present (date, time, message)
    const dateField = page.locator('input[type="date"], input[name*="date"], input[id*="date"]').first();
    if (await dateField.isVisible().catch(() => false)) await dateField.fill(tourDetails.date || '');
    
    const timeField = page.locator('select[name*="time"], select[id*="time"], input[name*="time"]').first();
    if (await timeField.isVisible().catch(() => false)) {
      await timeField.selectOption({ label: tourDetails.time }).catch(() => timeField.fill(tourDetails.time));
    }
    
    const messageField = page.locator('textarea[name*="message"], textarea[id*="message"]').first();
    if (await messageField.isVisible().catch(() => false)) await messageField.fill('Interested in touring this property');
    
    await captureScreenshot(page, 'form_filled', tourDetails.leadId || 'unknown', property.name);

    // 4. Submit the form (unless noSubmit is true)
    if (tourDetails.noSubmit) {
      console.log('[TourAgent] noSubmit=true, skipping form submission');
      // TBA-LOG-02: do not claim success when the form was not actually submitted
      return {
        success: false,
        error: 'Form filled but not submitted (noSubmit mode)',
        status: 'not_submitted',
      };
    }

    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Book tour"), button:has-text("Submit"), button:has-text("Schedule")').first();
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
    } else {
      const form = page.locator('form').first();
      if (await form.isVisible().catch(() => false)) await form.evaluate(f => f.submit());
    }
    
    await page.waitForTimeout(2000); // Wait for submission response
    await captureScreenshot(page, 'after_submit', tourDetails.leadId || 'unknown', property.name);

    // 5. Wait for confirmation indicators
    const confirmationSelectors = [
      'text=/confirmation|confirmed|booked|thank you|success|submitted/i',
      'text=/tour scheduled|tour booked|request submitted|we will contact you/i',
    ];
    let confirmationText = null;
    for (const selector of confirmationSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        confirmationText = await page.textContent(selector).catch(() => null);
        if (confirmationText) break;
      } catch { /* try next selector */ }
    }

    if (!confirmationText) {
      return { success: false, error: 'No confirmation text found after form submission' };
    }

    return {
      success: true,
      // Do not fabricate confirmation numbers
      confirmationNumber: null,
      confirmationText,
      bookedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { success: false, error: `Generic booking failed: ${err.message}` };
  }
}

async function storeTourBookingsInCRM(leadId, bookings, httpClient = axios) {
  const results = [];
  for (const booking of bookings) {
    const payload = {
      leadId,
      propertyId: booking.propertyId,
      propertyName: booking.property,
      propertyAddress: booking.propertyAddress || null,
      tourTime: booking.startsAt || `${todayIsoDate()}T${booking.time}:00`,
      requestedDate: (booking.startsAt || '').slice(0, 10) || null,
      confirmationNumber: booking.confirmationNumber,
      status: 'confirmed',
      source: booking.dryRun ? 'tour_booking_agent_dry_run' : 'tour_booking_agent',
      bookingMetadata: {
        bookedAt: booking.bookedAt,
        platform: booking.platform || null,
        dryRun: !!booking.dryRun,
      },
    };
    const response = await httpClient.post(`${CRM_BASE_URL}/api/internal/tours/create`, payload, {
      headers: crmHeaders(),
    });
    results.push(response.data);
  }
  return results;
}

async function alertEricOfFailures(leadId, errors, httpClient = axios) {
  try {
    const response = await httpClient.post(`${CRM_BASE_URL}/api/internal/alerts/booking-failures`, {
      leadId,
      errors,
      source: 'tour_booking_agent',
    }, {
      headers: crmHeaders(),
    });
    return response.data;
  } catch (err) {
    console.error('[TourAgent] Failed to send booking failure alert:', err.message);
    return null;
  }
}

async function requestItineraryGeneration(leadId, date, options = {}) {
  const httpClient = options.httpClient || axios;
  try {
    const response = await httpClient.post(`${CRM_BASE_URL}/api/internal/leads/${leadId}/itinerary`, {
      date,
      includeBackupProperties: true,
      sendDelivery: options.dryRun ? false : true,
      source: options.dryRun ? 'tour_booking_agent_dry_run' : 'tour_booking_agent',
    }, {
      headers: crmHeaders(),
    });
    return response.data;
  } catch (err) {
    console.error('[TourAgent] Itinerary generation request failed:', err.message);
    return {
      generated: false,
      reason: err.response && err.response.data ? err.response.data.error : err.message,
    };
  }
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(corsMiddleware); // TBA-SEC-04: apply CORS to all routes

  app.post('/api/book-tours', rateLimitMiddleware, requireApiKey, async (req, res) => {
    const validation = validateBookingRequest(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ error: 'Invalid booking request', details: validation.errors });
    }

    const runBooking = () => bookToursForLead(req.body);
    const logResult = result => console.log('[TourAgent] Booking result:', JSON.stringify({
        leadId: result.leadId,
        success: result.success,
        bookings: result.bookings ? result.bookings.length : 0,
        errors: result.errors ? result.errors.length : 0,
      }));

    if (validation.request.async) {
      runBooking().then(logResult).catch(err => console.error('[TourAgent] Booking error:', err));
      return res.status(202).json({
        status: 'booking_started',
        leadId: validation.request.leadId,
        tourDate: validation.request.tourDate,
        message: 'Tour booking agent started. Results will be written to CRM.',
      });
    }

    const result = await runBooking();
    logResult(result);
    return res.status(result && result.success ? 200 : 207).json(result);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'tour-booking-agent', crmBaseUrl: CRM_BASE_URL });
  });

  return app;
}

function startServer(port = process.env.PORT || 3001) {
  validateConfig(); // TBA-SEC-05: enforce CRM_API_KEY before accepting traffic
  const app = createApp();
  return app.listen(port, () => {
    console.log(`[TourAgent] running on http://localhost:${port}`);
    console.log(`[TourAgent] endpoint: POST http://localhost:${port}/api/book-tours`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  bookToursForLead,
  calculateTourSchedule,
  createApp,
  corsMiddleware,
  detectBookingPlatform,
  maskName,
  normalizeProperty,
  rateLimitMiddleware,
  requireApiKey,
  startServer,
  validateBookingRequest,
  validateConfig,
  // Export booking handlers for focused testing (noSubmit safety, cleanup robustness)
  bookAppfolioTour,
  bookLeaselabsTour,
  bookPropertyTour,
};
