# Drive Logger

A hands-free voice "drive event recorder" for autonomous-vehicle test drives. Mount the phone on the dash, tap the mic,
and say **"log …"** or **"intervention …"**. Each note is saved with a timestamp (and GPS location), and the whole drive
copies straight into a spreadsheet.

**Live app: https://jkippy.github.io/drive-logger/** (canonical URL)

It's a static Progressive Web App: vanilla JS, no build step, nothing leaves the phone. Speech recognition is the browser's
Web Speech API (Safari on iPhone, Chrome on desktop/Android).

| Portrait | Landscape (dash mount) |
| --- | --- |
| <img src="screenshot.png" width="260"> | <img src="screenshot-landscape.png" width="520"> |

## Install on iPhone
1. Open **https://jkippy.github.io/drive-logger/** in **Safari**.
2. Share › **Add to Home Screen**.
3. Open it, tap the mic, and allow **Microphone** and **Location**.

## How to use
- Tap the orb (or **Start**). Say **"log"** or **"intervention"**, then describe the event:
  *"log left lane drift near exit 12"* · *"intervention took over at the light"*.
- A note is saved after about 2.5 s of silence (or when the recognizer finalizes the sentence). You get a short spoken
  reply ("Logged.", "Intervention noted.") or a chime, and the new card is briefly highlighted.
- Speech without a keyword or a command is ignored.
- **Copy** puts the current session on the clipboard as tab-separated rows. Paste into Google Sheets or Excel and it lands in columns.
- **More** has the full notes list (edit/delete), sessions (+ New session), Download CSV, Share, settings
  (spoken replies or chime, GPS, night dim, landscape control side), Corrections and Help.

### Voice commands (no keyword; say them as their own sentence)
| | Examples |
| --- | --- |
| Priority | "mark that high priority" · "make it medium" · "that's low priority" · "bump that to high" · "set priority high" · "that's urgent" · "give the one before that high priority" · "remove the priority" |
| Inline priority | "log **high priority** brake fade on the downhill" → `brake fade on the downhill $$$` |
| Delete | "scratch that" · "delete that last one" · "never mind" (within 60 s of a note) |
| Undo | "bring that back" · "undo" |
| Add | "add to that, …" (any time) · "also, …" (within 60 s) |
| Change type | "change that to an intervention" · "make that a log" · "that was an intervention" |
| Mark | "mark" saves a timestamped `[marked event]`; fill it in later with "add to that, …" |
| Ask | "read that back" · "what was the last note" · "how many notes" · "how many interventions" |
| Pause | "pause notes" / "stop taking notes" → only "resume notes" / "start taking notes" is heard |

Commands are never taken from text you're dictating after a keyword. The app stops listening while it speaks a reply so it
can't transcribe itself.

### Accuracy helpers
- Requests 5 recognition alternatives and prefers one that starts with a keyword or is a command.
- Common mishearings are accepted **at the start of an utterance only**: "blog", "lock", "logged", "logs", "lug", "long", "la" → *log*;
  "intervene", "in convention", "inter mention" → *intervention*. "log log …" collapses to one note.
- **Corrections** (More sheet): editable *heard → written* pairs applied to note text, seeded with AV terms
  (way mo → Waymo, lie dar → lidar, phantom breaking → phantom braking, zooks → Zoox, …).

## Data safety (crash-proofing)
Notes live only on the phone, so the app is built so a Safari crash, a killed tab or a wiped store doesn't lose them:

- **Two stores, written on every change.** Each create/edit/delete/priority change is written right away to
  **localStorage** (synchronously) **and IndexedDB** (a strict-durability transaction). On launch both are read and merged by
  note id; the newest `updatedAt` wins. Deletes are kept as tombstones so a stale store can't bring a deleted note back.
  If one store is wiped, corrupted or evicted, the other refills it.
- **Drafts.** The moment a keyword is heard, the in-progress note (with its keyword-time timestamp and GPS fix) is saved
  as a draft in both stores and updated as you keep talking. If the page dies before the note is final, the next launch
  restores it as a note ending in **“(recovered)”**.
- **Journal.** Every change event (create, edit, delete, priority, retype, restore, recover) is appended to a local journal
  (all events in IndexedDB, the newest 500 also in localStorage). **More › Recently deleted** lists deleted notes with a
  Restore button, and “bring that back” still undoes the last delete.
- **Backup / restore.** **More › Export full backup (JSON)** saves every note (including deleted ones), sessions, settings and
  the journal. **Restore from backup…** *merges*: missing notes are added and newer edits win. Nothing is overwritten or deleted,
  and restoring the same file twice changes nothing.
- **End-of-drive nudge.** Tapping **Stop**, or **New session**, while the session has notes that were never exported shows
  *“N notes not exported yet · Copy / Download / Share”*. The More sheet shows “N notes not exported” or the last export time.
- **Warnings.** A banner appears if a store fails (quota, blocked) or if the app detects **Private Browsing**, which erases
  everything when the tab closes. **More › Storage & backup** shows both stores' status, whether storage is *persistent*
  (`navigator.storage.persist()`), and whether you're in a browser tab or the Home Screen app.

Safari limits to know about:
- In a regular Safari tab, Safari deletes all of a site's script-written storage (localStorage **and** IndexedDB) after
  7 days of browser use without visiting the site. **Home Screen web apps are exempt.**
- The Home Screen app and Safari tabs keep **separate** storage. Notes taken in one don't appear in the other, so pick one
  (the Home Screen app is recommended) and use a JSON backup to move between them.
- Two stores on the same phone don't protect against losing the phone or iOS clearing website data. Export after each drive.

### Backing up to Google Sheets (designed, not enabled)
The client already sends every change through a small outbox (`DLSync` in `store.js`). It does nothing until an endpoint is
configured, and there's no UI for that yet. The planned server is a Google Apps Script web app bound to a Sheet you own:
[`docs/sheets-sync.gs`](docs/sheets-sync.gs). It upserts each note by id, so retries never duplicate rows.
- The app POSTs `Content-Type: text/plain` with a JSON body. Apps Script can't answer a CORS preflight (there is no
  `doOptions`), so `application/json` fails. text/plain is a "simple request": there's no preflight, the `/exec` 302
  redirect to `script.googleusercontent.com` is followed, and the JSON reply is readable. That lets the app confirm each batch
  instead of firing blind with `no-cors`.
- Failed or offline sends stay in the outbox (localStorage) and retry with backoff, on reconnect, and when the app
  returns to the foreground.
- Security: the web app runs as the Sheet owner with access "Anyone". Whoever holds the URL can call it, so the script also
  checks a long random token that the app sends in the POST body rather than the URL, which keeps it out of logs and history.
  Rotate it by changing `TOKEN` and redeploying. Note text goes to Google under the owner's account; check that this is
  allowed for test-drive data.

## Export format
Tab-separated (Copy) or CSV (Download / Share). Header row optional for Copy, always included in the CSV.

| Date | Time | ISO timestamp | Type | Note | Lat | Lon |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-17 | 14:03:22 | 2026-10-17T14:03:22-04:00 | Intervention | took over at the light $$$ | 42.501220 | -83.444760 |

- Time is the phone's local time; the ISO timestamp includes the local UTC offset (EDT −04:00 / EST −05:00).
- Priority is kept inside the note text: `$$$` high, `$$` medium, `$` low.
- **Lat/Lon** are added as the last two columns only while GPS is on (default). They're blank when location is denied,
  unavailable, or older than 30 s. With GPS off the export is the original 5 columns.

### Timestamps
A note's time is the phone clock at the moment the recognizer first reported the keyword (or the start of the
utterance, if it opens with the keyword). Recognition typically reports words about 0.5–1.5 s after they're spoken, so
times may run that much late. The status row shows **Drive** (session elapsed time) and **GPS ±N m** (location
accuracy), and **Now** above the notes is the device clock, for comparison with note times.

## iOS notes
- Keep the app **in the foreground with the screen on**. iOS stops recognition when the screen locks or you switch apps;
  it resumes when you come back. The app holds a Screen Wake Lock (iOS 16.4+).
- Safari may ask for microphone and location permission again after a reload or relaunch, especially from the Home Screen.
- Needs **Siri & Dictation** enabled (Settings › General › Keyboard › Enable Dictation) and usually a network connection.
- Turn off Silent mode to hear spoken replies. Web apps can't vibrate on iPhone.
- If listening misbehaves in the Home Screen app, use it in a regular Safari tab.
- Notes are stored only on the phone (localStorage + IndexedDB) and are tied to the site address, so export after each drive. See *Data safety*.

## Development
```
index.html  style.css  app.js   UI, speech recognition, commands, GPS, export, nudge, backup UI
core.js                         pure logic: keyword parsing, command grammar, priority, corrections, TSV/CSV
persist.js                      pure logic: two-store merge, drafts/recovery, journal, backup/restore, export tracking
store.js                        localStorage + IndexedDB adapter, persist(), Private Browsing check, dormant Sheets outbox
docs/sheets-sync.gs             sample Apps Script endpoint (not deployed)
sw.js  manifest.json  icons/    PWA (network-first service worker)
test.js                         unit tests: node test.js
tools/*.js                      headless Chromium flows (fake speech recognizer)
```
- Unit tests: `node test.js`
- Serve locally: `python3 -m http.server 8787` → http://127.0.0.1:8787/
- Headless flows need `playwright-core` and Chrome:
  `npm i playwright-core` then `NODE_PATH=./node_modules node tools/cmdtest.js` (also `gpstest.js`, `accuracytest.js`,
  `timestamptest.js`, `durabilitytest.js`, `shot.js`). `durabilitytest.js` crashes the page and SIGKILLs the browser mid-note,
  wipes each store in turn, and round-trips a backup. Set `BASE_URL` to test another copy, e.g.
  `BASE_URL=https://jkippy.github.io/drive-logger/ node tools/smoketest.js`.
- Bump `CACHE` in `sw.js` on each release so installed copies refresh.

Dev note: during prototyping the app was also served from a temporary tunnel (hostc) on the build box. GitHub Pages is
the canonical URL.
