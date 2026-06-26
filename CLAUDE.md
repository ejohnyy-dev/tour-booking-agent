# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Node.js service that autonomously books apartment tours on property websites on behalf of CRM leads. It exposes an Express HTTP API that n8n (or any HTTP client) calls; it then runs Playwright to fill booking forms on property sites and writes results back to a CRM.

## Commands

```bash
npm install          # install dependencies (playwright, express, axios, nodemon)
npm start            # run the Express server (production)
npm run dev          # run with nodemon (auto-restart on file changes)
npm test             # run the Node built-in test runner against *.test.js
node --test tour-booking-agent.test.js   # run a single test file
```

There is no lint or build step. Tests use `node:test` and `node:assert/strict` — no external test framework.

## Architecture

Everything lives in `tour-booking-agent.js` (one file, ~900 lines). It exports pure functions that the test suite can call directly with injected fakes.

### Request lifecycle (`POST /api/book-tours`)

1. **`validateBookingRequest(body)`** — normalises and validates the request. Returns `{ ok, errors, request }`. Accepts `properties` or `selectedProperties` (the n8n alias). If neither is provided and `useCrmTourRequests` is not false, the agent will fetch candidates from the CRM.
2. **`fetchLeadFromCRM`** — `GET /api/internal/leads/:leadId`
3. **`fetchTourRequestProperties`** — `GET /api/internal/leads/:leadId/tour-requests` (only called when no properties were given)
4. **`calculateTourSchedule(startTime, n, date)`** — produces an array of `{ date, time, startsAt }` objects, spaced **50 minutes** apart (30-min tour + 20-min drive buffer)
5. **`preFlightCheck`** — HTTP GET to the property website to verify it is reachable and contains booking-related content before launching the browser. Properties that fail are pushed to `errors` with `action: 'MANUAL_REVIEW'`, not thrown.
6. **`bookPropertyTour(browser, property, tourDetails)`** — opens a fresh browser context for each property, calls `detectBookingPlatform`, then dispatches to `bookAppfolioTour`, `bookLeaselabsTour`, or `bookGenericTour`.
7. **`storeTourBookingsInCRM`** — `POST /api/internal/tours/create` for each successful booking
8. **`alertEricOfFailures`** — `POST /api/internal/alerts/booking-failures` if any property failed
9. **`requestItineraryGeneration`** — `POST /api/internal/leads/:leadId/itinerary`

The `async` flag (default `true`) makes the endpoint return HTTP 202 immediately and run the booking in the background.

### Booking platforms

`detectBookingPlatform(page)` inspects HTML and URL for keywords:
- `appfolio` / `apartmentapp` → `bookAppfolioTour`
- `leaselabs` / `leaselab` → `bookLeaselabsTour`
- everything else → `bookGenericTour`

`bookGenericTour` handles two sub-cases:
- **Knock CRM iframe** (detected by `document.title === 'Knockbot Widgets Frame'`): fills `#firstName`, `#lastName`, `#email`, `#Phone`, `textarea` inside the iframe
- **Regular DOM**: uses broad attribute selectors to find name/email/phone/date/time fields

### Special request flags

| Flag | Effect |
|---|---|
| `dryRun: true` | Skips browser launch, CRM writes, and itinerary request; returns `previewBookings` |
| `noSubmit: true` | Fills all form fields but stops before clicking Submit |
| `async: true` (default) | Returns HTTP 202 immediately; booking runs in background |
| `requestedCount: N` | Caps the number of properties processed (max 8) |

### Dependency injection for tests

`bookToursForLead(input, _, _, options)` accepts:
- `options.httpClient` — replaces `axios` (used in every unit test)
- `options.bookPropertyTour` — replaces the real Playwright booker
- `options.launchBrowser` — replaces `playwright.chromium.launch`

### CRM API surface consumed

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/internal/leads/:id` | Fetch lead profile |
| GET | `/api/internal/leads/:id/tour-requests` | Fetch candidate properties |
| POST | `/api/internal/tours/create` | Store a confirmed booking |
| POST | `/api/internal/leads/:id/itinerary` | Request itinerary generation |
| POST | `/api/internal/alerts/booking-failures` | Alert on partial failures |

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `CRM_BASE_URL` | `http://localhost:3000` | CRM server base URL |
| `CRM_API_KEY` | _(empty)_ | JWT bearer token for CRM auth |
| `PORT` | `3001` | Express server port |
| `TOUR_TIMEZONE` | `America/Chicago` | Timezone for schedule display |
| `TOUR_SCREENSHOT_DIR` | `/Users/ej/Documents/ejwork/LeadInfo/BookingScreenshots` | Where debug screenshots are written |

Create a `.env` file — it is gitignored. No `.env.example` exists; see SETUP.md for the full list.

## Adding a New Booking Platform

1. Add a keyword check in `detectBookingPlatform()` that returns a new string key
2. Write `async function bookMyPlatformTour(page, property, tourDetails)` following the `bookAppfolioTour` pattern; return `{ success, confirmationNumber, bookedAt }` on success or `{ success: false, error }` on failure
3. Add a `case 'myplatform':` branch in the `switch` inside `bookPropertyTour()`

## Debug / One-Off Scripts

These scripts are **not part of the application** — they are standalone Playwright scripts used during development to inspect and test specific property websites:

- `inspect-form.js` — dumps all form fields in all frames for a given page
- `test-coopsummerstreet.js` — smoke-tests the full click-through on coopsummerstreet.com with screenshots
- `test-form-fill.js` — fills the Knock CRM iframe form at coopsummerstreet.com without submitting
- `test-full-flow-no-submit.js` — generic full-flow test that stops before submit

The `.backup*` and `.modified` files in the root are old snapshots and can be ignored.

## Property Field Aliases

`normalizeProperty()` accepts multiple field name variants from different CRM/n8n payloads:
- Name: `name` or `propertyName`
- URL: `website`, `url`, or `bookingUrl`
- ID: `id` or `propertyId`
- Address: `address` or `propertyAddress`
- Contact email: `contactEmail` or `propertyContactEmail`
