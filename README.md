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
- `app.js` — clock rendering, timer engine, audio/voice, presets, persistence.

## Notes

- Audio and voice need a user interaction first (browser autoplay policy); the start/preset click counts.
- Desktop notifications require permission, requested on first load.
- Timers use wall-clock end times, so they stay accurate when the tab is inactive.
