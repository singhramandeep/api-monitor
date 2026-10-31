# Changelog

All notable changes to the API Monitor project (Chrome extension + standalone app).
The app reports its current version on the dashboard header and via `GET /api/ping`.

---

## v1.5.0 — Live capture: WebSockets + pulse

*Added*
- **WebSocket capture** in the extension (`chrome.debugger` → `Network.webSocket*` events):
  WS endpoint creates/open/close, plus per-frame traffic (incoming/outgoing/error)
  recorded with direction, timestamp and payload (up to 80 frames × 16 KB per connection,
  overflow flagged).
- **New "WS Frames" tab** in the request detail view — chronological frame list with
  direction arrows (↓ in / ↑ out / ⚠ error), per-frame time + size, JSON payloads
  auto-pretty-printed. Frames are kept in full records only (not pushed in the live
  feed), so streaming stays lean.
- **Header pulse**: 60-second requests-per-second sparkline next to the version chip,
  with per-second tooltips.
- Extension version bumps to `1.2.0` (reload the extension to get WS capture).

*Changed*
- "REST only" now also excludes websockets explicitly.
- Overview tab shows the WS frame count for websocket entries.
- Exported JSON/HAR include WS metadata (frames live in JSON export; HAR carries WS
  entries as zero-status records with `_apiMonitor` metadata).

---

## v1.4.0 — Export suite

*Added*
- **HAR export** (`GET /api/export/har`) — HTTP Archive 1.2 format, importable into
  Chrome DevTools, Charles, Fiddler, httpbin… includes timings (derived wait/receive),
  postData, response content (base64-flagged for binary) and `_apiMonitor` extras.
- **cURL collection export** (`GET /api/export/curl`) — a ready-to-run `.sh` with one
  command per capture (captured response status noted in a comment above each command).
- **Export dropdown** in the header replaces the single JSON link:
  JSON (full data) · HAR · cURL collection.

*Changed*
- Server-side cURL builder mirrors the dashboard's (same escaping and flags),
  kept in sync with the client copy.

---

## v1.3.0 — Deep search & keyboard flow

*Added*
- **Server-backed body search** (`GET /api/search?q=…`): the dashboard's
  **"in bodies"** checkbox switches the search box to grep across **request bodies,
  response bodies, URLs and error messages** across everything captured (newest first,
  max 40 hits). Rows carry the matched snippet in their tooltip and a `[field]` marker.
  Result view is point-in-time; retype to refresh.
- **Keyboard shortcuts**:
  - `/` focus search · `Esc` leave search / close detail
  - `j` / `k` move through the request list (arrow highlight + auto-scroll)
  - `Enter` open the highlighted request · `c` copy its cURL command

*Changed*
- `fontSizeHint`: search results list ignores live additions until refreshed (keeps
  results stable under load).

---

## v1.2.0 — Replay & diff

*Added*
- **Request replay** (`POST /api/replay`): re-issues a captured request from the app
  itself — same method, headers and body — over the real network (http/https,
  self-signed certs tolerated, 15 s timeout, response capped at 512 KB).
  New **Replay tab** in the detail view with status/duration/size of the fresh response.
- **Response diff**: side-by-side comparison of the *captured* response vs the
  *replayed* response with LCS-based line highlighting (added/removed/unchanged),
  capped at 800 lines per side. Perfect for "did my fix change the response?".

*Notes*
- Replay fires **real requests** to the captured target — use deliberately.

---

## v1.1.0 — Session control: pause/resume + marks

*Added*
- **Pause/Resume streaming**: freeze the live list to inspect calmly; captures keep
  buffering (badge shows the buffered count) and flow back in on Resume, oldest first.
- **Session marks**: `⚑ Mark` drops a labelled, timestamped divider between requests
  (`POST /api/mark`, delete via `DELETE /api/marks/:id`, `POST /api/marks/clear`).
  Marks render inline in the list wherever they fall chronologically — annotate
  "clicked Checkout", "bug appeared", "after fix" during reproduction runs.
  Marks live in memory for the server process lifetime (not written to disk).

*Changed*
- `Clear` now wipes both records and marks.
- Mark dividers are preserved during row-cap trimming of the request list.

---

## v1.0.0 — Initial release

- Chrome MV3 extension (`chrome.debugger`/CDP): per-tab capture toggling with full
  fidelity — request/response headers, bodies (200 KB cap/truncation flags), timings
  (TTFB + total), sizes, redirects, failures, initiators, resource types.
- Zero-dependency Node.js app: ingest + JSONL persistence (ring buffer + rotation),
  live dashboard over Server-Sent Events.
- Dashboard: live request list with search/filters (method, status class, host, min
  duration, REST-only toggle, endpoint grouping with avg call time), detail tabs
  (Overview/waterfall, Headers, Request, Response, cURL with copy buttons),
  insights (totals, errors, avg/p95 duration, req/min, status distribution, top
  hosts/endpoints, slowest requests, content types, traffic timeline),
  JSON export + full clear/purge.
