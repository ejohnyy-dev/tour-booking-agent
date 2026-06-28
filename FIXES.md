# FIXES — tour-booking-agent

Prioritized cleanup plan derived from `.claude/audits/audit-report.md` (read-only recon).
**Nothing here is applied yet.** Each item lists surgical scope + risk. Execute one at a time.

## P1 — Safe, high-value (low risk)
1. **Delete 3 committed stale snapshots** — single biggest liability (~1,966 lines, ~47% duplication of the live agent).
   - `tour-booking-agent.js.backup-test`
   - `tour-booking-agent.js.backup.2026-06-22`
   - `tour-booking-agent.js.modified`
   - Scope: delete only these 3 files. Risk: **low** (stale artifacts, not imported, not `.js`). Verify nothing references them by name first.
2. **Remove `inspect-form.js`** — unused standalone debug script (no `module.exports`, never required).
   - Risk: low-med. Confirm it isn't part of a documented manual workflow before deleting; otherwise leave.

## P2 — Dedup (low-medium risk)
3. **Extract browser-launch / lightbox-close / screenshot-dir boilerplate** shared by `test-coopsummerstreet.js`, `test-full-flow-no-submit.js`, `inspect-form.js`, `test-form-fill.js` (clones #3,5,6,7) into a small shared helper (e.g. `test-helpers.js`).
   - Risk: low (test scripts). **Test-first not required** (they are themselves the tests) but run them after.
4. **De-duplicate internal form-fill block** in `tour-booking-agent.js` (lines ~618–630 and ~711–722, the two `form_filled` capture paths — clones #2,8).
   - Risk: **medium** — production path. Write a characterization test capturing current booking output first.

## P3 — Complexity (test-first, higher risk)
5. **Refactor `bookGenericTour`** (`tour-booking-agent.js:550`, 213 lines, nesting depth 6) and **`bookToursForLead`** (`tour-booking-agent.js:239`, 192 lines).
   - Risk: **high** — core booking logic. REQUIRE characterization tests around both before touching.

## P4 — Hygiene
6. Trim `module.exports` in `tour-booking-agent.js` to the 4 symbols tests actually import (`bookToursForLead`, `calculateTourSchedule`, `detectBookingPlatform`, `validateBookingRequest`) — OR leave if intentional test surface. Low priority.
   - Note: `nodemon` "unused devDep" is a **false positive** (used by `dev` script). Do NOT remove.
