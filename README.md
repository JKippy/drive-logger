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
- Notes are stored only on the phone (localStorage) and are tied to the site address, so export after each drive.

## Development
```
index.html  style.css  app.js   UI, speech recognition, commands, GPS, export
core.js                         pure logic: keyword parsing, command grammar, priority, corrections, TSV/CSV
sw.js  manifest.json  icons/    PWA (network-first service worker)
test.js                         unit tests: node test.js
tools/*.js                      headless Chromium flows (fake speech recognizer)
```
- Unit tests: `node test.js`
- Serve locally: `python3 -m http.server 8787` → http://127.0.0.1:8787/
- Headless flows need `playwright-core` and Chrome:
  `npm i playwright-core` then `NODE_PATH=./node_modules node tools/cmdtest.js` (also `gpstest.js`, `accuracytest.js`,
  `timestamptest.js`, `shot.js`). Set `BASE_URL` to test another copy, e.g.
  `BASE_URL=https://jkippy.github.io/drive-logger/ node tools/smoketest.js`.
- Bump `CACHE` in `sw.js` on each release so installed copies refresh.

Dev note: during prototyping the app was also served from a temporary tunnel (hostc) on the build box. GitHub Pages is
the canonical URL.
