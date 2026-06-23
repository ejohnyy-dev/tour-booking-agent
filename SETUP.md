# Tour Booking Agent — Setup & Integration

## Overview

Autonomous browser agent that books apartment tours across multiple property websites. Uses Playwright for Chrome automation + Express API for CRM/n8n integration.

**What it does:**
1. Takes a CRM lead ID, optional property list, tour date, and preferred start time
2. Retrieves real lead profile data from CRM
3. Calculates smart tour schedule (30 min/tour + 20 min drive)
4. Books tours on each property's website (Appfolio, LeaseLabs, generic forms)
5. Stores confirmations in CRM via `/api/internal/tours/create`
6. Requests CRM itinerary generation via `/api/internal/leads/:leadId/itinerary`
7. Reports partial failures for manual review

---

## Installation

```bash
cd ~/Documents/ejwork/tour-booking-agent
npm install
```

---

## Configuration

### Environment Variables

Create `.env` file:

```bash
# CRM Integration
CRM_BASE_URL=http://localhost:3000
CRM_API_KEY=<your-jwt-token>

# Server
PORT=3001
NODE_ENV=production
```

---

## Running the Agent

### Local Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### As a Service (macOS)
Create `~/.config/launchd/tour-booking-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.txaptfinder.booking-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/ej/Documents/ejwork/tour-booking-agent/tour-booking-agent.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/ej/Documents/ejwork/tour-booking-agent</string>
  <key>StandardErrorPath</key>
  <string>/tmp/tour-booking-agent.err</string>
  <key>StandardOutPath</key>
  <string>/tmp/tour-booking-agent.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/.config/launchd/tour-booking-agent.plist
```

---

## API Endpoint

### Start Tour Booking

**POST** `/api/book-tours`

```json
{
  "leadId": 123,
  "tourDate": "2026-07-04",
  "clientPreferredTime": "14:00",
  "properties": [
    {
      "id": 501,
      "name": "Broadstone EaDo",
      "website": "https://broadstone.com/eado",
      "address": "123 Main St, Houston, TX"
    },
    {
      "id": 502,
      "name": "The Lofts at 203",
      "website": "https://thelofts203.com"
    }
  ],
  "async": true
}
```

**Response:**
```json
{
  "status": "booking_started",
  "leadId": 123,
  "tourDate": "2026-07-04",
  "message": "Tour booking agent started. Results will be written to CRM."
}
```

If `properties` is omitted, the agent pulls candidates from CRM
`GET /api/internal/leads/:leadId/tour-requests`. Use `"dryRun": true` for local
validation without launching Playwright, contacting property websites, or sending
the generated itinerary by email/SMS.

---

## How It Works

### 1. Smart Tour Scheduling

Input: Client wants to tour starting at 2:00 PM
Properties: 3 apartments

Schedule calculation:
- **Tour 1:** 2:00 PM - 2:30 PM (30 min tour + 20 min drive)
- **Tour 2:** 2:50 PM - 3:20 PM (30 min tour + 20 min drive)
- **Tour 3:** 3:40 PM - 4:10 PM

### 2. Platform Detection

For each property, agent:
1. Opens website
2. Detects booking platform (Appfolio / LeaseLabs / Generic)
3. Uses platform-specific handler to book

### 3. Booking Handlers

#### Appfolio
- Clicks "Schedule Tour"
- Fills: first name, phone, email
- Selects time slot matching calculated schedule
- Submits form
- Captures confirmation number

#### LeaseLabs
- Clicks "Schedule a Tour"
- Fills form fields (different selectors)
- Picks available time
- Captures confirmation

#### Generic Fallback
- Looks for booking buttons/links
- Fills visible form fields
- Submits via form.submit()
- Handles many custom implementations

### 4. Error Handling

If a property fails to book:
- ⚠️ **Logs error** with reason
- ✅ **Continues to next property** (doesn't stop entire flow)
- 📧 **Alerts you at the end** with list of failures
- 🎯 Tasks you with manual follow-up

### 5. CRM Integration

Once tours are booked:
1. Stores each booking in the CRM `tours` table
2. Updates `leads.status = 'tours_scheduled'`
3. Saves a tour booking JSON artifact under `LeadInfo/Calendar`
4. Requests CRM itinerary generation, which saves itinerary artifacts under `LeadInfo/Itineraries`

n8n can still trigger this worker, but CRM remains the lifecycle source of truth.

---

## Integration with N8N Workflows

### Updated Workflow 2: Tour Requests → Guest Cards

**New flow:**
```
Guest cards sent → Agent gets notified → 
  ↓
Booking agent starts (via n8n HTTP node) →
  Asks lead: "What time works best for tours?" →
  Agent books all properties with calculated schedule →
  ↓ (when at least one booking succeeds)
  CRM itinerary endpoint called and partial failures logged
```

### N8N HTTP Node (in Workflow 2)

After sending guest cards, add HTTP Request node:

```
Method: POST
URL: http://localhost:3001/api/book-tours
Body:
{
  "leadId": "{{ $json.body.leadId || $json.leadId }}",
  "tourDate": "{{ $json.body.tourDate || $json.tourDate }}",
  "clientPreferredTime": "{{ $json.body.clientPreferredTime || $json.clientPreferredTime }}",
  "async": true
}
```

The live local Workflow 2 is wired this way and can omit `properties`; the agent
will fetch CRM tour-request candidates. Add `"dryRun": true` for supervised
smokes. Dry-runs are preview-only: they return `previewBookings`,
`wouldCreateTours`, and `wouldGenerateItinerary`, but do not create CRM tours,
change lead status, save LeadInfo files, or request itinerary generation.

---

## Logging

Logs are written to:
- **Console:** Real-time during execution
- **File:** `/tmp/tour-booking-agent.log` (if running as service)

### Example Output
```
🏠 Starting tour booking for lead lead_123
📍 Properties: Broadstone EaDo, The Lofts 203
⏰ Client preferred start time: 14:00
📅 Tour schedule: ["14:00", "14:50", "15:40"]

[1/3] Booking Broadstone EaDo at 14:00
  → Navigating to https://broadstone.com/eado
  → Detected platform: appfolio
  ✅ Booked: Broadstone EaDo at 14:00

[2/3] Booking The Lofts 203 at 14:50
  → Navigating to https://thelofts203.com
  → Detected platform: generic
  ✅ Booked: The Lofts 203 at 14:50

[3/3] Booking Available Apt Co at 15:40
  ⚠️  Failed: Available Apt Co - Timeout (no time slots available)

🎉 All tours booked! Triggering workflow...
🚀 Triggered n8n itinerary workflow
✅ Stored 2 tour bookings in CRM
📧 Alert sent to Eric: 1 tour booking failures
```

---

## Customization by Property

Each property has different form structures. To add support:

### 1. Identify the website structure
- Open property website
- Inspect the tour booking form
- Note button labels, input names, confirmation selectors

### 2. Add property-specific handler in agent

```javascript
// In detectBookingPlatform()
if (html.includes('mypropertyname.com')) {
  return 'myproperty';
}

// Add handler function
async function bookMyPropertyTour(page, property, tourDetails) {
  // Your specific implementation
  // Follow pattern in bookAppfolioTour()
}

// In bookPropertyTour() switch statement
case 'myproperty':
  booking = await bookMyPropertyTour(page, property, tourDetails);
  break;
```

3. Test with sample property
4. Deploy

---

## Troubleshooting

| Issue | Solution |
|---|---|
| "Playwright browser timeout" | Property site is slow. Increase page timeout (15s → 30s) |
| "No available time slots" | Agent can't find times matching calculated schedule. May need human intervention |
| "Form selector not found" | Property changed their website. Update handler or use generic fallback |
| "CRM endpoint 404" | Endpoint not exposed in your CRM server. Add to `/api/internal/tours/create` |
| "N8N webhook 404" | Update `N8N_TOURS_BOOKED_WEBHOOK` env var with correct URL |

---

## Security Notes

- ⚠️ **Do NOT store lead passwords** — agent uses public tour booking forms only
- ✅ Uses headless browser (no UI visible, can't be intercepted)
- ✅ All CRM communication uses JWT bearer tokens
- 🔒 Browser state is isolated per lead (new browser instance each time)

---

## Performance

- **Time per property:** 15-45 seconds (depends on website complexity)
- **For 3 properties:** ~2-3 minutes total
- **Browser memory:** ~150MB per instance (cleaned up after booking)

---

## Future Enhancements

- [ ] Add support for more platforms (Zillow, PadMapper, etc.)
- [ ] Schedule tours for specific days/times (not just consecutive)
- [ ] SMS client with available time options, client picks time
- [ ] Photo upload capability (some properties allow lead photos on guest card)
- [ ] ML: Learn which time slots are most commonly available
- [ ] Retry failed bookings with alternative times

---

## Support

Questions or issues? Check:
1. `/tmp/tour-booking-agent.log` for detailed logs
2. CRM endpoints are properly exposed
3. N8N webhook URL is correct
4. Property website hasn't changed structure
