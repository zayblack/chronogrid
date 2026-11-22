"use strict";

const STORAGE_KEY = "chronogrid.v1";
const $ = (id) => document.getElementById(id);

let state = loadState();
let filterGroup = null;
let editingId = null;
let presetSourceId = null;
let soundContext = null;
let soundLoopTimers = new Map();
let lastTick = Date.now();
let toastTimer = null;
let inlineEdit = null;
let dragId = null;
let lastSavedSig = new Map();

refreshSavedSignatures();

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function defaultTimer(overrides = {}) {
  return {
    id: uid(), label: "New timer", group: "", notes: "",
    duration: 300, mode: "down", remaining: 300, elapsed: 0,
    running: false, finished: false, endAt: null,
    color: "#5b8cff", fontSize: 56, progressStyle: "ring",
    showEnd: false, showProgress: true, showControls: true,
    autoStart: false, autoRestart: false, snooze: false, snoozeSec: 60,
    autoStartAt: "", repeat: "none", lastTriggered: "",
    sound: "beep", volume: 70, repeatSound: false,
    speak: false, speakText: "Timer {label} finished", speakLang: "en-US", speakRate: 1,
    notify: true, updateTitle: true,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function defaultState() {
  return {
    timers: [], presets: [], hour24: true, showSeconds: true, timezone: "",
    theme: "dark", activeSounds: [],
  };
}

const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Bring older saves (and imported backups) up to the syncable shape.
function migrateState(raw) {
  const base = defaultState();
  const s = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
  const now = new Date().toISOString();
  const fallback = typeof s.updatedAt === "string" && s.updatedAt ? s.updatedAt : now;

  s.timers = Array.isArray(s.timers) ? s.timers.filter(Boolean).map(t => ({
    ...defaultTimer(), ...t,
    id: t.id || uid(),
    updatedAt: typeof t.updatedAt === "string" && t.updatedAt ? t.updatedAt : fallback,
  })) : [];
  s.presets = Array.isArray(s.presets) ? s.presets.filter(p => p && typeof p === "object").map(p => ({
    id: p.id || uid(),
    name: p.name || "Preset",
    data: p.data && typeof p.data === "object" ? p.data : {},
    updatedAt: typeof p.updatedAt === "string" && p.updatedAt ? p.updatedAt : fallback,
  })) : [];
  s.deletedTimers = Array.isArray(s.deletedTimers) ? s.deletedTimers.filter(d => d && d.id) : [];
  s.deletedPresets = Array.isArray(s.deletedPresets) ? s.deletedPresets.filter(d => d && d.id) : [];
  s.activeSounds = Array.isArray(s.activeSounds) ? s.activeSounds : [];
  s.updatedAt = fallback;
  s.deviceId = s.deviceId || uid();
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateState({});
    return migrateState(JSON.parse(raw));
  } catch { return migrateState({}); }
}

// Runtime fields change every second; they must not make a timer look "newer"
// than the same timer on another device, or sync would churn constantly.
const RUNTIME_FIELDS = ["remaining", "elapsed", "endAt", "running", "finished", "lastTriggered"];

function configSignature(item, isTimer) {
  const copy = { ...item };
  delete copy.updatedAt;
  if (isTimer) RUNTIME_FIELDS.forEach(k => delete copy[k]);
  return JSON.stringify(copy);
}

function refreshSavedSignatures() {
  lastSavedSig = new Map();
  state.timers.forEach(t => lastSavedSig.set("t:" + t.id, configSignature(t, true)));
  state.presets.forEach(p => lastSavedSig.set("p:" + p.id, configSignature(p, false)));
}

// Any real edit to a timer/preset (label, duration, settings, ...) advances its
// timestamp so the "newest wins" merge can actually see the change.
function touchChangedItems() {
  const now = new Date().toISOString();
  state.timers.forEach(t => {
    if (lastSavedSig.get("t:" + t.id) !== configSignature(t, true)) t.updatedAt = now;
  });
  state.presets.forEach(p => {
    if (lastSavedSig.get("p:" + p.id) !== configSignature(p, false)) p.updatedAt = now;
  });
}

function saveState({ touch = true, notifySync = true } = {}) {
  if (touch) {
    touchChangedItems();
    state.updatedAt = new Date().toISOString();
  }
  const toSave = { ...state, activeSounds: [...soundLoopTimers.keys()] };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave)); } catch (e) { console.warn(e); }
  refreshSavedSignatures();
  if (notifySync && typeof scheduleSync === "function") scheduleSync();
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

/* ---------- Clock ---------- */
function buildClockNumbers() {
  const c = $("clockNumbers");
  for (let n = 1; n <= 12; n++) {
    const s = document.createElement("span");
    s.textContent = n;
    s.style.setProperty("--n", n);
    c.appendChild(s);
  }
}

function populateTimezones() {
  const sel = $("timezoneSelect");
  let list = [];
  try { list = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : ["UTC"]; } catch { list = ["UTC"]; }
  const zones = ["", ...list];
  sel.innerHTML = "";
  for (const z of zones) {
    const opt = document.createElement("option");
    opt.value = z;
    opt.textContent = z || "Local time";
    sel.appendChild(opt);
  }
  sel.value = state.timezone || "";
}

function clockParts() {
  const now = new Date();
  try {
    if (state.timezone) {
      const parts = new Intl.DateTimeFormat("en-US", {
        hour: "numeric", minute: "numeric", second: "numeric",
        hour12: false, timeZone: state.timezone,
      }).formatToParts(now);
      const get = (t) => Number(parts.find(p => p.type === t)?.value || 0);
      let h = get("hour"); if (h === 24) h = 0;
      return { h, m: get("minute"), s: get("second"), now };
    }
  } catch (e) { /* fall back to local */ }
  return { h: now.getHours(), m: now.getMinutes(), s: now.getSeconds(), now };
}

function renderClock() {
  const { h, m, s, now } = clockParts();
  $("hourHand").style.transform = `translateX(-50%) rotate(${(h % 12) * 30 + m * 0.5}deg)`;
  $("minuteHand").style.transform = `translateX(-50%) rotate(${m * 6 + s * 0.1}deg)`;
  $("secondHand").style.transform = `translateX(-50%) rotate(${s * 6}deg)`;

  let hh = h;
  if (!state.hour24) { hh = h % 12 || 12; }
  const pad = (n) => String(n).padStart(2, "0");
  $("digitalTime").textContent = `${pad(hh)}:${pad(m)}` + (state.showSeconds ? `:${pad(s)}` : "") + (state.hour24 ? "" : ` ${h < 12 ? "AM" : "PM"}`);
  const dateOpts = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  try {
    $("digitalDate").textContent = state.timezone
      ? new Intl.DateTimeFormat(undefined, { ...dateOpts, timeZone: state.timezone }).format(now)
      : new Intl.DateTimeFormat(undefined, dateOpts).format(now);
  } catch { $("digitalDate").textContent = now.toDateString(); }
  $("timezoneLabel").textContent = state.timezone || "Local time";
  $("hour12Btn").classList.toggle("active", !state.hour24);
  $("hour24Btn").classList.toggle("active", state.hour24);
  $("secondsBtn").classList.toggle("active", state.showSeconds);
}

/* ---------- Timers ---------- */
function fmt(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
               : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseDurationInput(raw) {
  const parts = String(raw).trim().split(":");
  if (parts.length < 1 || parts.length > 3 || parts.some(p => !/^\d+$/.test(p))) return null;
  const total = parts.length === 1 ? Number(parts[0]) * 60
    : parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1])
    : Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  return Number.isFinite(total) ? Math.ceil(total) : null;
}

function startInlineEdit(timeEl, id) {
  const t = getTimer(id);
  if (!t || inlineEdit || timeEl.querySelector("input")) return;
  const original = timeEl.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "time-input-inline";
  input.value = fmt(t.duration);
  input.title = "Minutes (e.g. 7), MM:SS or HH:MM:SS — Enter saves, Esc cancels";
  input.setAttribute("aria-label", "Edit timer duration");
  timeEl.replaceChildren(input);
  inlineEdit = { id, input, timeEl, original };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finishInlineEdit(true); }
    else if (e.key === "Escape") { e.preventDefault(); finishInlineEdit(false); }
  });
  input.addEventListener("blur", () => finishInlineEdit(true));
  input.focus();
  input.select();
}

function finishInlineEdit(commit, gridWillRerender = false) {
  if (!inlineEdit) return;
  const { id, input, timeEl, original } = inlineEdit;
  inlineEdit = null;
  const raw = input.value;
  const parsed = commit ? parseDurationInput(raw) : null;
  const t = getTimer(id);
  if (commit && t && parsed !== null) {
    const duration = t.mode === "down" ? Math.max(1, parsed) : Math.max(0, parsed);
    t.duration = duration;
    t.remaining = t.mode === "down" ? duration : 0;
    t.elapsed = 0;
    t.finished = false;
    t.endAt = t.running && t.mode === "down" ? Date.now() + duration * 1000 : null;
    t.lastTriggered = "";
    stopSound(id);
    saveState();
    if (timeEl.isConnected) timeEl.textContent = fmt(duration);
    const card = document.querySelector(`.timer-card[data-id="${id}"]`);
    if (card) card.classList.remove("finished");
    if (!gridWillRerender) updateCard(t);
    toast(`Duration set to ${fmt(duration)}`);
  } else {
    if (commit && raw.trim()) toast("Invalid duration — use minutes, MM:SS or HH:MM:SS");
    if (timeEl.isConnected) timeEl.textContent = original;
  }
}

function progressFraction(t) {
  if (t.duration <= 0) return 0;
  return t.mode === "down" ? t.remaining / t.duration : Math.min(1, t.elapsed / t.duration);
}

function renderTimers() {
  if (inlineEdit) finishInlineEdit(true, true);
  const grid = $("timersGrid");
  grid.innerHTML = "";
  const visible = state.timers.filter(t => !filterGroup || t.group === filterGroup);
  $("emptyState").hidden = visible.length > 0;
  for (const t of visible) grid.appendChild(buildCard(t));
  renderGroupFilters();
}

function buildCard(t) {
  const card = document.createElement("div");
  card.className = "timer-card" + (t.finished ? " finished" : "");
  card.dataset.id = t.id;
  card.style.setProperty("--card-color", t.color);
  card.style.setProperty("--card-font", t.fontSize + "px");

  const accent = document.createElement("div"); accent.className = "card-accent"; card.appendChild(accent);

  const head = document.createElement("div"); head.className = "card-head";
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle";
  handle.textContent = "⠿";
  handle.title = "Drag to reorder";
  handle.setAttribute("aria-label", "Drag to reorder timer");
  handle.addEventListener("pointerdown", () => { card.draggable = true; });
  handle.addEventListener("pointerup", () => { card.draggable = false; });
  handle.addEventListener("pointercancel", () => { card.draggable = false; });
  const titleWrap = document.createElement("div"); titleWrap.className = "card-title";
  const label = document.createElement("div"); label.className = "card-label"; label.textContent = t.label || "Untitled";
  const group = document.createElement("div"); group.className = "card-group"; group.textContent = t.group ? `#${t.group}` : "No group";
  titleWrap.append(label, group);
  const menu = document.createElement("div"); menu.className = "card-menu";
  const editBtn = mkIconBtn("✎", "Edit timer", () => openEditor(t.id));
  const savePresetBtn = mkIconBtn("★", "Save timer as preset", () => openPresets(t.id));
  const delBtn = mkIconBtn("🗑", "Delete timer", () => deleteTimer(t.id));
  menu.append(editBtn, savePresetBtn, delBtn);
  head.append(handle, titleWrap, menu); card.appendChild(head);

  const time = document.createElement("div"); time.className = "card-time"; time.dataset.role = "time";
  time.textContent = t.mode === "down" ? fmt(t.remaining) : fmt(t.elapsed); card.appendChild(time);

  if (t.showEnd) {
    const e = document.createElement("div"); e.className = "card-endtime"; e.dataset.role = "endtime";
    if (t.mode === "down") e.textContent = t.endAt ? `Ends at ${new Date(t.endAt).toLocaleTimeString()}` : `Duration ${fmt(t.duration)}`;
    else e.textContent = `Started ${new Date(Date.now() - t.elapsed * 1000).toLocaleTimeString()}`;
    card.appendChild(e);
  }

  if (t.showProgress && t.progressStyle !== "none") {
    const frac = progressFraction(t);
    if (t.progressStyle === "ring") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "card-progress-ring"); svg.setAttribute("width", "46"); svg.setAttribute("height", "46");
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", "23"); circle.setAttribute("cy", "23"); circle.setAttribute("r", "18");
      circle.setAttribute("fill", "none"); circle.setAttribute("stroke", "var(--border)"); circle.setAttribute("stroke-width", "4");
      const prog = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      prog.setAttribute("cx", "23"); prog.setAttribute("cy", "23"); prog.setAttribute("r", "18");
      prog.setAttribute("fill", "none"); prog.setAttribute("stroke", t.color); prog.setAttribute("stroke-width", "4");
      prog.setAttribute("stroke-linecap", "round");
      prog.setAttribute("stroke-dasharray", String(2 * Math.PI * 18));
      prog.setAttribute("stroke-dashoffset", String(2 * Math.PI * 18 * (1 - frac)));
      prog.setAttribute("transform", "rotate(-90 23 23)");
      svg.append(circle, prog); card.appendChild(svg);
    } else {
      const bar = document.createElement("div"); bar.className = "card-progress-bar";
      const fill = document.createElement("div"); fill.style.width = `${frac * 100}%`;
      bar.appendChild(fill); card.appendChild(bar);
    }
  }

  const status = document.createElement("div");
  status.dataset.role = "status";
  status.className = "card-status" + (t.finished ? " finished-status" : t.running ? " running" : "");
  status.textContent = t.finished ? "Finished" : t.running ? "Running" : "Paused";
  card.appendChild(status);

  if (t.showControls) {
    const controls = document.createElement("div"); controls.className = "card-controls";
    controls.appendChild(mkBtn(t.running ? "Pause" : (t.finished ? "Restart" : "Start"), "small", () => toggleTimer(t.id)));
    controls.appendChild(mkBtn("Reset", "small", () => resetTimer(t.id)));
    if (t.snooze && t.finished) controls.appendChild(mkBtn("Snooze", "small", () => snoozeTimer(t.id)));
    controls.appendChild(mkBtn("Edit", "small ghost", () => openEditor(t.id)));
    card.appendChild(controls);
  }
  if (t.notes) { const n = document.createElement("div"); n.className = "card-notes"; n.textContent = t.notes; card.appendChild(n); }
  return card;
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement("button"); b.className = "btn " + cls; b.textContent = text; b.addEventListener("click", onClick); return b;
}
function mkIconBtn(text, title, onClick) {
  const b = document.createElement("button"); b.textContent = text; b.title = title; b.addEventListener("click", onClick); return b;
}

function getTimer(id) { return state.timers.find(t => t.id === id); }

function updateCard(t) {
  const card = document.querySelector(`.timer-card[data-id="${t.id}"]`);
  if (!card) return;
  const time = card.querySelector('[data-role="time"]');
  if (time && !(inlineEdit && inlineEdit.timeEl === time)) time.textContent = t.mode === "down" ? fmt(t.remaining) : fmt(t.elapsed);
  const status = card.querySelector('[data-role="status"]');
  if (status) {
    status.textContent = t.finished ? "Finished" : t.running ? "Running" : "Paused";
    status.className = "card-status" + (t.finished ? " finished-status" : t.running ? " running" : "");
  }
  const end = card.querySelector('[data-role="endtime"]');
  if (end) {
    end.textContent = t.mode === "down"
      ? (t.endAt ? `Ends at ${new Date(t.endAt).toLocaleTimeString()}` : `Duration ${fmt(t.duration)}`)
      : `Started ${new Date(Date.now() - t.elapsed * 1000).toLocaleTimeString()}`;
  }
  const frac = progressFraction(t);
  const ring = card.querySelector(".card-progress-ring circle:last-child");
  if (ring) ring.setAttribute("stroke-dashoffset", String(2 * Math.PI * 18 * (1 - frac)));
  const bar = card.querySelector(".card-progress-bar > div");
  if (bar) bar.style.width = `${frac * 100}%`;
}

function toggleTimer(id) {
  const t = getTimer(id); if (!t) return;
  if (t.finished) { resetTimer(id); }
  t.running = !t.running;
  if (t.running) {
    t.finished = false;
    t.endAt = t.mode === "down" ? Date.now() + t.remaining * 1000 : null;
    stopSound(id);
  }
  renderTimers(); saveState();
}

function resetTimer(id) {
  const t = getTimer(id); if (!t) return;
  t.running = false; t.finished = false;
  t.remaining = t.mode === "down" ? t.duration : 0;
  t.elapsed = 0; t.endAt = null; t.lastTriggered = "";
  stopSound(id); renderTimers(); saveState();
}

function snoozeTimer(id) {
  const t = getTimer(id); if (!t) return;
  t.finished = false; t.running = true;
  t.remaining = t.mode === "down" ? t.snoozeSec : 0;
  t.elapsed = 0;
  t.endAt = t.mode === "down" ? Date.now() + t.snoozeSec * 1000 : null;
  t.lastTriggered = "";
  stopSound(id); renderTimers(); saveState();
  toast(`Snoozed "${t.label}" for ${t.snoozeSec}s`);
}

function startAll() { state.timers.forEach(t => { if (!t.running && !t.finished) toggleTimer(t.id); }); }
function pauseAll() { state.timers.forEach(t => { if (t.running) toggleTimer(t.id); }); }
function resetAll() { state.timers.forEach(t => resetTimer(t.id)); }

function deleteTimer(id) {
  const t = getTimer(id); if (!t) return;
  if (!confirm(`Delete timer "${t.label}"?`)) return;
  stopSound(id);
  state.timers = state.timers.filter(x => x.id !== id);
  state.deletedTimers.push({ id, deletedAt: new Date().toISOString() });
  renderTimers(); saveState();
}

function clearDropMarkers(grid) {
  grid.querySelectorAll(".drop-before, .drop-after").forEach(el => el.classList.remove("drop-before", "drop-after"));
}

function moveTimerInState(id, targetId, after) {
  const from = state.timers.findIndex(t => t.id === id);
  if (from < 0) return;
  const [item] = state.timers.splice(from, 1);
  const targetIndex = targetId && targetId !== id ? state.timers.findIndex(t => t.id === targetId) : -1;
  const to = targetIndex < 0 ? state.timers.length : targetIndex + (after ? 1 : 0);
  state.timers.splice(to, 0, item);
  saveState();
  renderTimers();
}

/* ---------- Engine ---------- */
function tick() {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 5);
  lastTick = now;
  let changed = false, needRender = false;

  for (const t of state.timers) {
    checkSchedule(t, now);
    if (!t.running) continue;
    if (t.mode === "down") {
      t.remaining = Math.max(0, t.endAt ? (t.endAt - now) / 1000 : t.remaining - dt);
      t.elapsed = t.duration - t.remaining;
    } else {
      t.elapsed += dt;
      t.remaining = Math.max(0, t.duration - t.elapsed);
    }
    changed = true;
    if (t.mode === "down" ? t.remaining <= 0 : (t.duration > 0 && t.elapsed >= t.duration)) {
      onComplete(t, now);
      needRender = true;
    }
  }
  if (changed) saveState({ touch: false, notifySync: false });
  if (needRender) renderTimers();
  else if (changed) state.timers.forEach(updateCard);
  updateTitle();
}

function checkSchedule(t, now) {
  if (!t.autoStartAt || t.running || t.finished) return;
  const d = new Date(now);
  const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (timeStr !== t.autoStartAt) return;
  const day = d.getDay();
  let allowed = true;
  if (t.repeat === "weekdays") allowed = day >= 1 && day <= 5;
  else if (t.repeat === "weekly") allowed = t.lastTriggered !== d.toDateString();
  else if (t.repeat === "daily") allowed = true;
  else allowed = t.lastTriggered !== d.toDateString();
  if (!allowed) return;
  t.lastTriggered = d.toDateString();
  toggleTimer(t.id);
  toast(`Auto-started "${t.label}"`);
}

function onComplete(t, now) {
  t.running = false; t.finished = true; t.endAt = null;
  playSound(t);
  speak(t);
  if (t.notify && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(t.label, { body: `${t.label} finished` }); } catch {}
  }
  toast(`${t.label} finished!`);
  if (t.autoRestart) {
    setTimeout(() => {
      if (getTimer(t.id)) { resetTimer(t.id); toggleTimer(t.id); }
    }, 1000);
  }
}

function updateTitle() {
  document.title = "ChronoGrid — Clock & Timers";
  if (!state.timers.some(t => t.updateTitle && t.running)) return;
  const t = state.timers.find(x => x.updateTitle && x.running);
  document.title = `${t.mode === "down" ? fmt(t.remaining) : fmt(t.elapsed)} — ${t.label}`;
}

/* ---------- Audio ---------- */
function ensureAudio() {
  if (!soundContext) soundContext = new (window.AudioContext || window.webkitAudioContext)();
  if (soundContext.state === "suspended") soundContext.resume();
  return soundContext;
}

function tone(freq, duration, vol, type = "sine", delay = 0) {
  const ctx = ensureAudio();
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  const start = ctx.currentTime + delay;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(vol, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start(start); osc.stop(start + duration + 0.02);
}

function playSound(t) {
  if (t.sound === "none") return;
  const vol = (t.volume / 100) * 0.3;
  const play = () => {
    if (t.sound === "beep") { tone(880, 0.25, vol, "square"); tone(880, 0.25, vol, "square", 0.35); }
    else if (t.sound === "chime") { tone(523, 0.5, vol); tone(659, 0.5, vol, "sine", 0.15); tone(784, 0.7, vol, "sine", 0.3); }
    else if (t.sound === "bell") { tone(1046, 1.2, vol); tone(1568, 1.0, vol * 0.6, "sine", 0.05); }
    else if (t.sound === "alarm") { for (let i = 0; i < 3; i++) { tone(660, 0.2, vol, "square", i * 0.3); tone(880, 0.2, vol, "square", i * 0.3 + 0.1); } }
  };
  play();
  if (t.repeatSound) {
    stopSound(t.id);
    const iv = setInterval(play, 2500);
    soundLoopTimers.set(t.id, iv); saveState();
    const el = document.createElement("div");
    el.id = "dismiss-" + t.id;
    el.style.cssText = "position:fixed;top:20px;right:20px;z-index:300;background:var(--danger);color:#fff;padding:10px 14px;border-radius:8px;cursor:pointer;font-size:13px";
    el.textContent = `Dismiss alarm: ${t.label}`;
    el.onclick = () => { stopSound(t.id); el.remove(); };
    document.body.appendChild(el);
  }
}

function stopSound(id) {
  const iv = soundLoopTimers.get(id);
  if (iv) { clearInterval(iv); soundLoopTimers.delete(id); }
  document.getElementById("dismiss-" + id)?.remove();
  saveState();
}

function speak(t) {
  if (!t.speak || !("speechSynthesis" in window)) return;
  const text = (t.speakText || "Timer {label} finished").replace("{label}", t.label);
  const u = new SpeechSynthesisUtterance(text);
  u.lang = t.speakLang || "en-US"; u.rate = t.speakRate || 1;
  try { speechSynthesis.speak(u); } catch {}
}

/* ---------- Editor ---------- */
function openEditor(id = null) {
  editingId = id;
  const t = id ? getTimer(id) : defaultTimer();
  if (!t) return;
  $("editorTitle").textContent = id ? "Edit timer" : "New timer";
  $("editLabel").value = t.label;
  $("editHours").value = Math.floor(t.duration / 3600);
  $("editMinutes").value = Math.floor((t.duration % 3600) / 60);
  $("editSeconds").value = t.duration % 60;
  $("editMode").value = t.mode;
  $("editGroup").value = t.group;
  $("editFontSize").value = t.fontSize;
  $("editProgress").value = t.progressStyle;
  $("editColor").value = t.color;
  $("editShowEnd").checked = t.showEnd;
  $("editShowProgress").checked = t.showProgress;
  $("editShowControls").checked = t.showControls;
  $("editAutoStart").checked = t.autoStart;
  $("editAutoRestart").checked = t.autoRestart;
  $("editSnooze").checked = t.snooze;
  $("editSnoozeSec").value = t.snoozeSec;
  $("editAutoStartAt").value = t.autoStartAt;
  $("editRepeat").value = t.repeat;
  $("editSound").value = t.sound;
  $("editVolume").value = t.volume;
  $("volumeVal").textContent = t.volume + "%";
  $("editRepeatSound").checked = t.repeatSound;
  $("editSpeak").checked = t.speak;
  $("editSpeakText").value = t.speakText;
  $("editSpeakLang").value = t.speakLang;
  $("editSpeakRate").value = t.speakRate;
  $("editNotify").checked = t.notify;
  $("editUpdateTitle").checked = t.updateTitle;
  $("editNotes").value = t.notes;
  $("editDelete").hidden = !id;
  const groups = [...new Set(state.timers.map(x => x.group).filter(Boolean))];
  $("groupList").innerHTML = groups.map(g => `<option value="${escapeHtml(g)}"></option>`).join("");
  $("editorModal").hidden = false;
  setTimeout(() => $("editLabel").focus(), 50);
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function saveEditor() {
  const rawDuration = (Number($("editHours").value) || 0) * 3600 + (Number($("editMinutes").value) || 0) * 60 + (Number($("editSeconds").value) || 0);
  const duration = $("editMode").value === "up" ? Math.max(0, rawDuration) : Math.max(1, rawDuration);
  const data = {
    label: $("editLabel").value.trim() || "Untitled",
    duration,
    mode: $("editMode").value,
    group: $("editGroup").value.trim(),
    notes: $("editNotes").value.trim(),
    fontSize: Number($("editFontSize").value),
    progressStyle: $("editProgress").value,
    color: $("editColor").value,
    showEnd: $("editShowEnd").checked,
    showProgress: $("editShowProgress").checked,
    showControls: $("editShowControls").checked,
    autoStart: $("editAutoStart").checked,
    autoRestart: $("editAutoRestart").checked,
    snooze: $("editSnooze").checked,
    snoozeSec: Math.max(1, Number($("editSnoozeSec").value) || 60),
    autoStartAt: $("editAutoStartAt").value,
    repeat: $("editRepeat").value,
    sound: $("editSound").value,
    volume: Number($("editVolume").value),
    repeatSound: $("editRepeatSound").checked,
    speak: $("editSpeak").checked,
    speakText: $("editSpeakText").value.trim(),
    speakLang: $("editSpeakLang").value.trim() || "en-US",
    speakRate: Number($("editSpeakRate").value) || 1,
    notify: $("editNotify").checked,
    updateTitle: $("editUpdateTitle").checked,
  };
  if (editingId) {
    const t = getTimer(editingId);
    Object.assign(t, data);
    if (t.mode === "down" && !t.running) t.remaining = duration;
    if (t.mode === "up" && !t.running) t.remaining = duration;
    t.endAt = t.running && t.mode === "down" ? Date.now() + t.remaining * 1000 : null;
    if (t.autoStart && !t.running && !t.finished) { t.running = true; t.endAt = t.mode === "down" ? Date.now() + t.remaining * 1000 : null; }
  } else {
    const t = defaultTimer({ ...data, remaining: duration, elapsed: 0 });
    if (t.autoStart) { t.running = true; t.endAt = t.mode === "down" ? Date.now() + duration * 1000 : null; }
    state.timers.push(t);
  }
  $("editorModal").hidden = true;
  renderTimers(); saveState();
}

/* ---------- Presets ---------- */
const BUILT_IN = [
  { name: "Pomodoro", data: { label: "Pomodoro", duration: 1500, color: "#f85149", group: "Work", sound: "chime" } },
  { name: "Short break", data: { label: "Short break", duration: 300, color: "#3fb950", group: "Work", sound: "chime" } },
  { name: "Long break", data: { label: "Long break", duration: 900, color: "#3fb950", group: "Work", sound: "chime" } },
  { name: "Tea timer", data: { label: "Tea", duration: 180, color: "#d29922", sound: "bell" } },
  { name: "Boil eggs", data: { label: "Boil eggs", duration: 420, color: "#f0883e", sound: "alarm" } },
  { name: "Workout set", data: { label: "Rest", duration: 90, color: "#a371f7", group: "Fitness", sound: "beep" } },
  { name: "1 minute", data: { label: "1 minute", duration: 60, color: "#58a6ff", sound: "beep" } },
  { name: "Countdown stopwatch", data: { label: "Stopwatch", duration: 0, mode: "up", color: "#8b949e", progressStyle: "none", sound: "none" } },
];

function openPresets(sourceId = null) {
  presetSourceId = sourceId;
  const bi = $("presetBuiltIn"); bi.innerHTML = "";
  BUILT_IN.forEach((p, i) => {
    const el = document.createElement("div"); el.className = "preset-item";
    el.innerHTML = `<strong>${escapeHtml(p.name)}</strong><small>${p.data.mode === "up" ? "Count up" : fmt(p.data.duration)}</small>`;
    el.onclick = () => addFromPreset(p.data);
    bi.appendChild(el);
  });
  const cu = $("presetCustom"); cu.innerHTML = "";
  state.presets.forEach((p, i) => {
    const el = document.createElement("div"); el.className = "preset-item";
    el.innerHTML = `<strong>${escapeHtml(p.name)}</strong><small>${p.data.mode === "up" ? "Count up" : fmt(p.data.duration)}</small>`;
    el.onclick = () => addFromPreset(p.data);
    const del = document.createElement("button"); del.className = "btn tiny danger"; del.textContent = "×"; del.style.cssText = "float:right";
    del.onclick = (e) => {
      e.stopPropagation();
      const [removed] = state.presets.splice(i, 1);
      state.deletedPresets.push({ id: removed.id, deletedAt: new Date().toISOString() });
      saveState(); openPresets();
    };
    el.appendChild(del);
    cu.appendChild(el);
  });
  $("newPresetName").value = sourceId ? (getTimer(sourceId)?.label || "") : "";
  $("presetModal").hidden = false;
}

function addFromPreset(data) {
  const t = defaultTimer({ ...data, label: data.label || "Timer", remaining: data.mode === "up" ? 0 : (data.duration || 0), elapsed: 0 });
  state.timers.push(t);
  $("presetModal").hidden = true;
  renderTimers(); saveState(); toast(`Added "${t.label}"`);
}

function saveCurrentAsPreset() {
  const name = $("newPresetName").value.trim();
  if (!name) { toast("Enter a preset name"); return; }
  const source = presetSourceId ? getTimer(presetSourceId) : state.timers[state.timers.length - 1];
  if (!source) { toast("No timer to save"); return; }
  const { id, running, finished, endAt, remaining, elapsed, lastTriggered, ...data } = source;
  state.presets.push({ id: uid(), name, data, updatedAt: new Date().toISOString() });
  $("newPresetName").value = "";
  saveState(); openPresets(); toast(`Saved preset "${name}"`);
}

/* ---------- Filters & reorder ---------- */
function renderGroupFilters() {
  const box = $("groupFilters"); box.innerHTML = "";
  const groups = [...new Set(state.timers.map(t => t.group).filter(Boolean))];
  const all = mkBtn("All", "tiny " + (!filterGroup ? "active" : "ghost"), () => { filterGroup = null; renderTimers(); });
  box.appendChild(all);
  for (const g of groups) box.appendChild(mkBtn(g, "tiny " + (filterGroup === g ? "active" : "ghost"), () => { filterGroup = g; renderTimers(); }));
}

function openReorder() {
  const list = $("reorderList"); list.innerHTML = "";
  state.timers.forEach((t, i) => {
    const row = document.createElement("div"); row.className = "reorder-row";
    const name = document.createElement("span"); name.className = "name"; name.textContent = `${i + 1}. ${t.label}`;
    const up = mkBtn("↑", "tiny", () => move(i, -1));
    const down = mkBtn("↓", "tiny", () => move(i, 1));
    row.append(name, up, down); list.appendChild(row);
  });
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= state.timers.length) return;
    [state.timers[i], state.timers[j]] = [state.timers[j], state.timers[i]];
    saveState(); openReorder(); renderTimers();
  }
  $("reorderModal").hidden = false;
}

/* ---------- Import / export ---------- */
function exportState() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = "chronogrid-backup.json"; a.click();
  URL.revokeObjectURL(url); toast("Exported settings");
}

function importState(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.timers)) throw new Error("Invalid file");
      state = migrateState(data);
      refreshSavedSignatures();
      saveState(); applyUiState(); renderTimers(); renderGroupFilters(); toast("Imported settings");
    } catch (e) { toast("Import failed: " + e.message); }
  };
  reader.readAsText(file);
}

function applyUiState() {
  document.documentElement.dataset.theme = state.theme;
  $("themeBtn").textContent = state.theme === "dark" ? "Light mode" : "Dark mode";
  $("timezoneSelect").value = state.timezone || "";
  $("hour24Btn").classList.toggle("active", state.hour24);
  $("hour12Btn").classList.toggle("active", !state.hour24);
  $("secondsBtn").classList.toggle("active", state.showSeconds);
  for (const [id, iv] of soundLoopTimers) { clearInterval(iv); document.getElementById("dismiss-" + id)?.remove(); }
  soundLoopTimers.clear();
  (state.activeSounds || []).forEach(id => { const t = getTimer(id); if (t && t.finished) playSound(t); });
}

/* ---------- Events ---------- */
function initEvents() {
  $("addTimerBtn").onclick = () => openEditor();
  $("addPresetBtn").onclick = () => openPresets();
  $("startAllBtn").onclick = startAll;
  $("pauseAllBtn").onclick = pauseAll;
  $("resetAllBtn").onclick = () => { if (confirm("Reset all timers?")) resetAll(); };
  $("orderBtn").onclick = openReorder;
  $("themeBtn").onclick = () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    $("themeBtn").textContent = state.theme === "dark" ? "Light mode" : "Dark mode";
    saveState();
  };
  $("fullscreenBtn").onclick = () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); };
  $("exportBtn").onclick = exportState;
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = (e) => { if (e.target.files[0]) importState(e.target.files[0]); e.target.value = ""; };
  $("clearFilterBtn").onclick = () => { filterGroup = null; renderTimers(); };

  const grid = $("timersGrid");
  grid.addEventListener("dblclick", (e) => {
    const timeEl = e.target.closest('[data-role="time"]');
    if (!timeEl) return;
    const card = timeEl.closest(".timer-card");
    if (card) startInlineEdit(timeEl, card.dataset.id);
  });
  const cleanupDrag = () => {
    dragId = null;
    clearDropMarkers(grid);
    grid.querySelectorAll(".timer-card").forEach(c => { c.classList.remove("dragging"); c.draggable = false; });
  };
  grid.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".timer-card");
    if (!card || !card.draggable) { e.preventDefault(); return; }
    dragId = card.dataset.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
    card.classList.add("dragging");
  });
  grid.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const card = e.target.closest(".timer-card");
    clearDropMarkers(grid);
    if (!card || card.dataset.id === dragId) return;
    const rect = card.getBoundingClientRect();
    card.classList.add(e.clientY > rect.top + rect.height / 2 ? "drop-after" : "drop-before");
  });
  grid.addEventListener("dragleave", (e) => {
    if (!grid.contains(e.relatedTarget)) clearDropMarkers(grid);
  });
  grid.addEventListener("drop", (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target.closest(".timer-card");
    if (card && card.dataset.id === dragId) { cleanupDrag(); return; }
    const id = dragId;
    const targetId = card ? card.dataset.id : null;
    const after = !!card && card.classList.contains("drop-after");
    cleanupDrag();
    moveTimerInState(id, targetId, after);
  });
  grid.addEventListener("dragend", cleanupDrag);
  $("hour12Btn").onclick = () => { state.hour24 = false; saveState(); renderClock(); };
  $("hour24Btn").onclick = () => { state.hour24 = true; saveState(); renderClock(); };
  $("secondsBtn").onclick = () => { state.showSeconds = !state.showSeconds; saveState(); renderClock(); };
  $("timezoneSelect").onchange = (e) => { state.timezone = e.target.value; saveState(); renderClock(); };

  $("editorClose").onclick = $("editCancel").onclick = () => { $("editorModal").hidden = true; };
  $("editSave").onclick = saveEditor;
  $("editDelete").onclick = () => { if (editingId) { deleteTimer(editingId); $("editorModal").hidden = true; } };
  $("editVolume").oninput = (e) => { $("volumeVal").textContent = e.target.value + "%"; };
  $("editorModal").onclick = (e) => { if (e.target === $("editorModal")) $("editorModal").hidden = true; };

  $("presetClose").onclick = $("presetCancel").onclick = () => { $("presetModal").hidden = true; };
  $("saveCurrentPreset").onclick = saveCurrentAsPreset;
  $("presetModal").onclick = (e) => { if (e.target === $("presetModal")) $("presetModal").hidden = true; };
  $("reorderClose").onclick = $("reorderDone").onclick = () => { $("reorderModal").hidden = true; };
  $("reorderModal").onclick = (e) => { if (e.target === $("reorderModal")) $("reorderModal").hidden = true; };

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (e.key === "n" || e.key === "N") openEditor();
    if (e.key === "p" || e.key === "P") openPresets();
    if (e.key === "Escape") document.querySelectorAll(".modal-backdrop").forEach(m => m.hidden = true);
    if (e.code === "Space") { e.preventDefault(); startAll(); }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastTick = Date.now(); tick(); } });
  window.addEventListener("beforeunload", saveState);
}

/* ---------- Init ---------- */
buildClockNumbers();
populateTimezones();
applyUiState();
renderClock();
renderTimers();
initEvents();
if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});

state.timers.forEach(t => {
  if (t.autoStart && !t.finished) {
    t.running = true;
    t.endAt = t.mode === "down" ? Date.now() + t.remaining * 1000 : null;
  }
});
setInterval(tick, 200);
setInterval(renderClock, 1000);

/* ---------- PWA: offline support and home-screen install ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js")
      .catch((err) => console.warn("Service worker registration failed:", err));
  });
}
