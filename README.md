# ChronoGrid — Clock & Timers

A single-page clock and timer dashboard. No build step, no dependencies: open `index.html` in a browser (or run any static server in this folder).

## Features

- Analog + digital clock with 12/24h formatting, optional seconds, date, and timezone selection.
- Unlimited timer cards in a responsive grid; each runs independently.
- Per-timer settings:
  - Label, group, notes, duration (hh:mm:ss; double-click a card's time to edit it inline), count down / count up.
  - Accent color, font size, progress ring/bar/none, show/hide end time, progress, and controls.
  - Auto-start on load, auto-restart, snooze (configurable length), time-of-day auto-start with daily/weekday/weekly repeat.
  - Alarm sound (beep, chime, bell, alarm), volume, repeat-until-dismissed, voice announcement with configurable text, language, and rate.
  - Desktop notification and tab-title countdown.
- Built-in presets (Pomodoro, breaks, tea, eggs, workout, stopwatch) plus custom presets saved from any timer.
- Group filtering, bulk start/pause/reset, drag handles for card reordering (plus a reorder dialog).
- Dark/light theme, fullscreen mode, keyboard shortcuts (`N` new timer, `P` presets, `Space` start all, `Esc` close dialogs).
- Settings and timers persist in `localStorage`; export/import JSON for backup or transfer.

## Files

- `index.html` — markup and UI structure.
- `styles.css` — theme, layout, and card styling.
- `app.js` — clock rendering, timer engine, audio/voice, presets, persistence, service-worker registration.
- `sync.js` — optional PC ↔ phone sync through a secret GitHub Gist.
- `manifest.webmanifest` — install metadata: name, icons, colors, standalone display.
- `sw.js` — caches the app shell so the app works offline.
- `icons/` — PWA icons; run `python3 generate_icons.py` here (requires Pillow) to regenerate them.

## Android / PWA

The app is installable as a Progressive Web App. Serve this folder over **HTTPS** (GitHub Pages, Netlify, or any static host) — service workers need a secure context. `http://localhost` works for local testing, but a plain `http://<LAN-IP>` address will not make the app installable.

**Installing in Brave on Android**

1. Open the hosted URL in Brave.
2. Tap the ⋮ menu → **Add to Home screen** (some versions say **Install app**).
3. Confirm the name and tap **Add**, then launch it from the home screen.

If the icon or name is not picked up, disable Brave Shields for the site and try again.

Brave creates a **home-screen shortcut**, not a true WebAPK: it will not appear under Settings → Apps, its icon gets a small Brave badge, and closing Brave can stop sounds and voice announcements. Countdowns stay accurate because timers use wall-clock end times. Installing once with Chrome or Samsung Internet gives a genuine standalone app if you want that later.

Other browsers: Chrome (with Google Play Services) and Samsung Internet on Samsung phones install a real WebAPK; Firefox for Android uses ⋮ → **Install**; Edge, Opera and Samsung Internet on non-Samsung phones create shortcuts like Brave. In-app browsers (WhatsApp, Facebook, etc.) cannot install PWAs — open the URL in Brave directly.

**Updating after a change**

The service worker caches the app shell. Whenever you change `index.html`, `styles.css`, `app.js`, `sync.js`, the manifest or the icons, bump `CACHE_NAME` in `sw.js` (for example `chronogrid-v4` → `chronogrid-v5`) before deploying. Old caches are removed automatically, though users may need to reopen the app once to see the update.

## Syncing between PC and phone (GitHub Gist)

The app can keep both devices in sync through one **secret Gist** containing `chronogrid-state.json`. Timers, presets and settings are synced; the Gist token is not.

**One-time setup**

1. In GitHub, create a **fine-grained personal access token** with the account permission **Gists: write** and a sensible expiry (e.g. 90 days). A classic token with only the `gist` scope also works. Copy the token — GitHub shows it only once.
2. Open ChronoGrid on the first device and click **Sync setup**.
3. Paste the token into **GitHub personal access token**.
4. Leave **Gist ID** empty and click **Create secret Gist**. The ID is filled in for you. On the second device, paste that same Gist ID instead of creating another one.
5. Click **Save & sync**. Repeat steps 2–5 on the other device using the same Gist ID.

**How it behaves**

- With auto-sync on (the default), changes are pushed about 2 seconds after you stop editing. The remote copy is pulled on load, on reconnect, when you return to the tab, and every 20 seconds while the app is open — so edits on one device appear on the other automatically.
- Editing an existing timer (label, duration, colours, settings, etc.) updates its timestamp, so the newer edit wins on the other device. Running/paused countdown values are treated as local runtime state and are not merged.
- **Sync** in the toolbar forces an immediate sync and shows status: off, on, syncing, synced, offline or error.
- When both devices changed the same timer, the copy with the newer `updatedAt` wins; timers only present on one device are kept. Deletions are recorded so a removed timer does not come back. Presets merge the same way.
- Top-level settings (theme, timezone, 12/24h) follow the device with the newer overall change. A running countdown may jump after a merge — that is expected.
- Sync only happens while the app is open. Offline edits stay local and sync when you return online.
- The token is stored only in that device's `localStorage`, is never included in **Export**, and can be removed with **Sync setup → Forget this device**. Revoke the token on GitHub if you lose a device.

Export/Import still works and remains the recommended backup before clearing browser data.

## Notes

- Audio and voice need a user interaction first (browser autoplay policy); the start/preset click counts.
- Desktop notifications require permission, requested on first load.
- Timers use wall-clock end times, so they stay accurate when the tab is inactive.
- After the first load the app shell is cached by `sw.js`; timer data still lives in `localStorage`, so use Export before clearing site data.
