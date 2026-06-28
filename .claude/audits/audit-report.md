# Audit Report — tour-booking-agent
_Generated 2026-06-28. Read-only reconnaissance. Tools: jscpd, knip, custom complexity heuristic._

## Summary
- Lines of source scanned: 1,613 (6 `.js` files; excludes 3 committed `.backup*`/`.modified` snapshots totaling 1,966 more lines)
- Duplication: 4.9% of JS lines (8 clones; 94 duplicated lines). Rises to **46.7%** if the `.backup*`/`.modified` snapshots are included — see Caveats.
- Dead code: 1 unused file, 5 exports used internally-only (exported needlessly), 1 unused devDependency
- Complexity hotspots: 8 over threshold (1 oversized file, 4 long functions, 3 deep-nesting)
- Top 3 highest-impact cleanups:
  1. Delete the 3 committed stale snapshots `tour-booking-agent.js.backup-test`, `tour-booking-agent.js.backup.2026-06-22`, `tour-booking-agent.js.modified` (~1,966 lines, ~47% duplication of the live file).
  2. Refactor `bookGenericTour` (213 lines, nesting depth 6) and `bookToursForLead` (192 lines) in `tour-booking-agent.js`.
  3. Remove `inspect-form.js` (unused dev script) and trim `module.exports` to the symbols actually imported by tests.

## Duplication (jscpd)
Scan: `npx jscpd . --min-tokens 50` over the 6 source `.js` files (4.9% of JS lines duplicated). Top clone pairs, worst first:

| # | File A (lines) | File B (lines) | Tokens |
|---|----------------|----------------|--------|
| 1 | tour-booking-agent.test.js:86–105 | tour-booking-agent.test.js:148–167 | 122 |
| 2 | test-form-fill.js:92–104 | tour-booking-agent.js:618–630 | 107 |
| 3 | test-coopsummerstreet.js:4–19 | test-full-flow-no-submit.js:4–18 | 97 |
| 4 | tour-booking-agent.test.js:71–87 | tour-booking-agent.test.js:129–145 | 79 |
| 5 | test-coopsummerstreet.js:148–157 | test-full-flow-no-submit.js:140–149 | 67 |
| 6 | inspect-form.js:13–20 | test-form-fill.js:16–23 | 56 |
| 7 | inspect-form.js:7–13 | test-form-fill.js:10–16 | 52 |
| 8 | tour-booking-agent.js:630–640 | tour-booking-agent.js:711–722 | 50 |

Patterns: (a) the three `test-*`/`inspect-form` standalone scripts repeat the same browser-launch + lightbox-close + screenshot-dir boilerplate (clones 3, 5, 6, 7); (b) `tour-booking-agent.test.js` repeats near-identical CRM-mock GET/POST fixtures across two tests (clones 1, 4); (c) `tour-booking-agent.js` itself repeats the form-fill / `noSubmit` block twice internally (clones 2, 8 — the two `form_filled` capture paths at lines 618 and 711).

## Dead Code (knip)
knip ran successfully (no config needed) and was cross-checked with a ripgrep export/require fallback.

### Unused files
- `inspect-form.js` — flagged by knip as unused; it has no `module.exports` and is never required. It is a standalone manual debug script (shares boilerplate with the other test scripts). Confidence: high as a build/import target; it is runnable by hand via `node inspect-form.js`.

### Unused exports / types
`tour-booking-agent.js` exports 9 symbols (lines 880–891). The only external consumer is `tour-booking-agent.test.js`, which imports 4: `bookToursForLead`, `calculateTourSchedule`, `detectBookingPlatform`, `validateBookingRequest`. The remaining 5 are used **only inside `tour-booking-agent.js` itself**, so the export is dead surface (no `module.exports` needed for them):
- `normalizeProperty` — internal only (called at lines 137, 212)
- `startServer` — internal only (called at line 877 via `require.main`)
- `createApp` — internal only (called at line 869)
- `captureScreenshot` — internal only (many call sites)
- `preFlightCheck` — internal only (called at line 331)

Confidence: medium. They may be exported intentionally for future/integration tests (the source comments "Export new helpers for testing"). No JS types to report (plain JS, no TS).

### Unused dependencies
- `nodemon` (devDependency, `package.json:26`) — knip reports it as an unused devDependency and an "unlisted binary." It is in fact referenced by the `dev` script (`nodemon tour-booking-agent.js`), so this is a knip false-positive on the binary; treat as low priority. Runtime deps `playwright`, `express`, `axios` are all used.

## Complexity
Heuristic thresholds: function > 60 lines, nesting depth > 4, file > 400 lines. Worst offenders:

- `tour-booking-agent.js:1` — file is 891 lines (> 400)
- `tour-booking-agent.js:550` — function `bookGenericTour` is 213 lines (> 60)
- `tour-booking-agent.js:550` — function `bookGenericTour` nesting depth 6 (> 4)
- `tour-booking-agent.js:239` — function `bookToursForLead` is 192 lines (> 60)
- `tour-booking-agent.js:239` — function `bookToursForLead` nesting depth 5 (> 4)
- `test-coopsummerstreet.js:3` — function `testCoopSummerStreet` is 155 lines (> 60)
- `test-coopsummerstreet.js:3` — function `testCoopSummerStreet` nesting depth 6 (> 4)
- `test-full-flow-no-submit.js:3` — function `testFullBookingFlow` is 147 lines (> 60)

The two production hotspots both live in `tour-booking-agent.js`; the two test-script hotspots are long top-level driver functions that also drive the duplication findings above.

## Caveats
- **`node_modules` not installed** (per spec, no installs). knip therefore could not resolve dependency graphs deeply; results are best-effort. The `nodemon` "unused devDependency" finding is a known knip limitation (it does not parse the npm `dev` script binary) — verified false by ripgrep.
- **Backup/snapshot files excluded from the headline numbers but TRACKED IN GIT**: `tour-booking-agent.js.backup-test` (612 lines), `tour-booking-agent.js.backup.2026-06-22` (612 lines), and `tour-booking-agent.js.modified` (742 lines) are committed and are near-duplicates of the live `tour-booking-agent.js`. A second jscpd pass that includes them reports 22 clones / 1,385 duplicated lines / **46.68%**. They were excluded from the primary scan because they lack a `.js` extension (jscpd skipped them), and they are stale artifacts rather than live source. They are the single largest duplication liability in the repo.
- No `src/` layout — all source sits at the repo root; the 6 `.js` files were scanned directly.
- This was a read-only audit; nothing in the repo was modified. Only the report and the `complexity.py` heuristic were written under `.claude/audits/`.
