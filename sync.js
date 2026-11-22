/* ChronoGrid sync — store one plain-JSON state file in a secret GitHub Gist.
   Loaded after app.js so it can use the same state and helpers. */
"use strict";

const SYNC_KEY = "chronogrid.sync.v1";
const GIST_FILE = "chronogrid-state.json";
const GITHUB_API = "https://api.github.com";
const SYNC_DEBOUNCE_MS = 2000;

let syncTimer = null;
let syncing = false;
let pendingSync = false;

/* ---------- Local sync settings (kept out of the exported state) ---------- */
function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch { return null; }
}

function saveSyncConfig(cfg) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(cfg)); } catch (e) { console.warn(e); }
}

function syncConfigured() {
  const cfg = loadSyncConfig();
  return !!(cfg && cfg.gistId && cfg.token);
}

function setSyncStatus(text) {
  const button = document.getElementById("syncBtn");
  if (button) button.textContent = text;
  const status = document.getElementById("syncStatus");
  if (status) {
    const cfg = loadSyncConfig();
    const last = cfg && cfg.lastSyncAt ? `Last synced: ${new Date(cfg.lastSyncAt).toLocaleString()}` : "Not synced yet";
    status.textContent = `${text} · ${last}`;
  }
}

function refreshSyncUi() {
  const cfg = loadSyncConfig();
  if (!cfg || !cfg.gistId || !cfg.token) setSyncStatus("Sync: off");
  else setSyncStatus(cfg.auto === false ? "Sync: manual" : "Sync: on");
}

/* ---------- Gist payload helpers ---------- */
function stripVolatile(value) {
  const copy = JSON.parse(JSON.stringify(value));
  delete copy.activeSounds;
  delete copy.deviceId;
  delete copy.sync;
  return copy;
}

function buildPayload(value) {
  return {
    version: 1,
    updatedAt: value.updatedAt,
    deviceId: value.deviceId,
    state: stripVolatile(value),
  };
}

function normalizeRemote(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Empty sync file");
  const raw = payload.state && typeof payload.state === "object" ? payload.state : payload;
  return migrateState(raw);
}

function ghHeaders(cfg) {
  return {
    "Authorization": `Bearer ${cfg.token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function githubError(response) {
  try {
    const body = await response.json();
    return new Error(`GitHub ${response.status}: ${body.message || "request failed"}`);
  } catch { return new Error(`GitHub ${response.status}`); }
}

async function pullRemote(cfg) {
  const url = `${GITHUB_API}/gists/${encodeURIComponent(cfg.gistId)}`;
  const response = await fetch(url, { headers: ghHeaders(cfg) });
  if (!response.ok) throw await githubError(response);
  const gist = await response.json();
  const file = gist.files && gist.files[GIST_FILE];
  if (!file) throw new Error(`Gist is missing ${GIST_FILE}`);
  const text = file.truncated && file.raw_url
    ? await fetch(file.raw_url).then(r => r.text())
    : file.content;
  return JSON.parse(text);
}

async function pushRemote(cfg, payload) {
  const url = `${GITHUB_API}/gists/${encodeURIComponent(cfg.gistId)}`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: ghHeaders(cfg),
    body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(payload) } } }),
  });
  if (!response.ok) throw await githubError(response);
  return response.json();
}

async function createSecretGist(token) {
  const response = await fetch(`${GITHUB_API}/gists`, {
    method: "POST",
    headers: ghHeaders({ token }),
    body: JSON.stringify({
      description: "ChronoGrid timer sync (private)",
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify(buildPayload(state)) } },
    }),
  });
  if (!response.ok) throw await githubError(response);
  const gist = await response.json();
  return gist.id;
}

/* ---------- Merge ---------- */
function timestampOf(item) {
  return item && typeof item === "object" && typeof item.updatedAt === "string" ? item.updatedAt : "";
}

function mergeCollection(localItems, remoteItems, localDeleted, remoteDeleted) {
  const localLive = new Map((localItems || []).filter(x => x && x.id).map(x => [x.id, x]));
  const remoteLive = new Map((remoteItems || []).filter(x => x && x.id).map(x => [x.id, x]));
  const localGone = new Map((localDeleted || []).filter(x => x && x.id).map(x => [x.id, x.deletedAt || ""]));
  const remoteGone = new Map((remoteDeleted || []).filter(x => x && x.id).map(x => [x.id, x.deletedAt || ""]));

  const allIds = new Set([...localLive.keys(), ...remoteLive.keys(), ...localGone.keys(), ...remoteGone.keys()]);
  const items = [];
  const deleted = [];
  const seen = new Set();

  function decide(id) {
    const localItem = localLive.get(id);
    const remoteItem = remoteLive.get(id);
    const localDel = localGone.get(id) || "";
    const remoteDel = remoteGone.get(id) || "";

    const lt = timestampOf(localItem);
    const rt = timestampOf(remoteItem);
    // On a tie, prefer the live item and this device's copy.
    const liveItem = lt >= rt ? (localItem || remoteItem) : (remoteItem || localItem);
    const liveAt = lt >= rt ? lt : rt;
    const deletedAt = localDel >= remoteDel ? localDel : remoteDel;

    if (liveItem && liveAt >= deletedAt) items.push(liveItem);
    else if (deletedAt) deleted.push({ id, deletedAt });
    else if (liveItem) items.push(liveItem);
  }

  for (const item of localItems || []) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id); decide(item.id);
  }
  for (const item of remoteItems || []) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id); decide(item.id);
  }
  for (const id of allIds) {
    if (seen.has(id)) continue;
    seen.add(id); decide(id);
  }

  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const freshDeleted = deleted.filter(d => new Date(d.deletedAt).getTime() > cutoff);
  return { items, deleted: freshDeleted };
}

function mergeStates(local, remote) {
  const l = migrateState(local);
  const r = migrateState(remote);
  const timers = mergeCollection(l.timers, r.timers, l.deletedTimers, r.deletedTimers);
  const presets = mergeCollection(l.presets, r.presets, l.deletedPresets, r.deletedPresets);
  const settingsSource = (r.updatedAt || "").localeCompare(l.updatedAt || "") > 0 ? r : l;

  const merged = {
    ...l,
    timers: timers.items,
    presets: presets.items,
    deletedTimers: timers.deleted,
    deletedPresets: presets.deleted,
    hour24: settingsSource.hour24,
    showSeconds: settingsSource.showSeconds,
    timezone: settingsSource.timezone,
    theme: settingsSource.theme,
    updatedAt: (l.updatedAt || "").localeCompare(r.updatedAt || "") >= 0 ? l.updatedAt : r.updatedAt,
    deviceId: l.deviceId,
    activeSounds: l.activeSounds,
  };
  const changed = JSON.stringify(stripVolatile(merged)) !== JSON.stringify(stripVolatile(l));
  return { state: merged, changed };
}

function applyMerged(next) {
  state = migrateState(next);
  saveState({ touch: false, notifySync: false });
  applyUiState();
  renderClock();
  renderTimers();
  renderGroupFilters();
}

/* ---------- Sync orchestration ---------- */
function scheduleSync() {
  const cfg = loadSyncConfig();
  if (!cfg || cfg.auto === false || !cfg.gistId || !cfg.token) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), SYNC_DEBOUNCE_MS);
}

async function syncNow({ manual = false } = {}) {
  const cfg = loadSyncConfig();
  if (!cfg || !cfg.gistId || !cfg.token) {
    setSyncStatus("Sync: off");
    if (manual) { openSyncModal(); toast("Set up sync first"); }
    return;
  }
  if (syncing) { pendingSync = true; return; }
  if (!navigator.onLine) { setSyncStatus("Offline"); return; }

  syncing = true;
  setSyncStatus("Syncing…");
  try {
    const remote = normalizeRemote(await pullRemote(cfg));
    const merged = mergeStates(state, remote);
    if (merged.changed) {
      applyMerged(merged.state);
      toast("Applied changes from another device");
    }
    // Push whenever the local state still differs from what is stored remotely.
    if (manual || JSON.stringify(stripVolatile(state)) !== JSON.stringify(stripVolatile(remote))) {
      await pushRemote(cfg, buildPayload(state));
    }
    cfg.lastSyncAt = new Date().toISOString();
    saveSyncConfig(cfg);
    setSyncStatus("Synced");
  } catch (err) {
    console.warn("Sync failed:", err);
    setSyncStatus("Sync error");
    if (manual) toast("Sync failed: " + (err.message || "unknown error"));
  } finally {
    syncing = false;
    if (pendingSync) {
      pendingSync = false;
      setTimeout(() => syncNow(), 0);
    }
  }
}

/* ---------- Setup dialog ---------- */
function openSyncModal() {
  const cfg = loadSyncConfig() || {};
  $("syncToken").value = cfg.token || "";
  $("syncGistId").value = cfg.gistId || "";
  $("syncAuto").checked = cfg.auto !== false;
  refreshSyncUi();
  $("syncModal").hidden = false;
}

function saveSettingsFromDialog() {
  const previous = loadSyncConfig() || {};
  const cfg = {
    token: $("syncToken").value.trim(),
    gistId: $("syncGistId").value.trim(),
    auto: $("syncAuto").checked,
    lastSyncAt: previous.lastSyncAt || null,
  };
  if (!cfg.token || !cfg.gistId) { toast("Add a token and a Gist ID"); return null; }
  saveSyncConfig(cfg);
  return cfg;
}

function initSync() {
  $("syncBtn").onclick = () => { if (!syncConfigured()) openSyncModal(); else syncNow({ manual: true }); };
  $("syncSetupBtn").onclick = openSyncModal;
  $("syncClose").onclick = $("syncCancel").onclick = () => { $("syncModal").hidden = true; };

  $("syncSave").onclick = () => {
    const cfg = saveSettingsFromDialog();
    if (!cfg) return;
    $("syncModal").hidden = true;
    refreshSyncUi();
    syncNow({ manual: true });
  };

  $("syncCreateGist").onclick = async () => {
    const token = $("syncToken").value.trim();
    if (!token) { toast("Enter a GitHub token first"); return; }
    const button = $("syncCreateGist");
    button.disabled = true;
    button.textContent = "Creating…";
    try {
      const id = await createSecretGist(token);
      $("syncGistId").value = id;
      toast("Secret Gist created — now click Save & sync");
    } catch (err) {
      toast("Could not create Gist: " + (err.message || "unknown error"));
    } finally {
      button.disabled = false;
      button.textContent = "Create secret Gist";
    }
  };

  $("syncForget").onclick = () => {
    if (!confirm("Stop syncing on this device? The Gist itself is not deleted.")) return;
    localStorage.removeItem(SYNC_KEY);
    $("syncModal").hidden = true;
    refreshSyncUi();
    toast("Sync disabled on this device");
  };

  window.addEventListener("online", () => {
    const cfg = loadSyncConfig();
    if (cfg && cfg.auto !== false && cfg.gistId && cfg.token) syncNow();
  });

  refreshSyncUi();
  const cfg = loadSyncConfig();
  if (cfg && cfg.auto !== false && cfg.gistId && cfg.token) syncNow();
}

initSync();
