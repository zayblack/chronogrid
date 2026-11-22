/* ChronoGrid sync — store one plain-JSON state file in a secret GitHub Gist.
   Loaded after app.js so it can use the same state and helpers. */
"use strict";

const SYNC_KEY = "chronogrid.sync.v1";
const GIST_FILE = "chronogrid-state.json";
const GITHUB_API = "https://api.github.com";
const SYNC_DEBOUNCE_MS = 2000;
const SYNC_POLL_MS = 20000;

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

// Like stripVolatile, but also ignores a running timer's second-by-second
// fields so ticking alone never counts as a change worth pushing.
function syncComparable(value) {
  const copy = stripVolatile(value);
  if (Array.isArray(copy.timers)) {
    copy.timers = copy.timers.map(t => {
      const c = { ...t };
      for (const k of RUNTIME_FIELDS) delete c[k];
      return c;
    });
  }
  return copy;
}

// Like syncComparable, but also ignores bookkeeping metadata. This is what
// decides whether a toast is warranted: a newer timestamp or revision on its
// own is not something the user needs to be told about.
function contentSignature(value) {
  const copy = stripVolatile(value);
  const stripMeta = (o) => {
    delete o.updatedAt;
    delete o.rev;
    delete o.settingsRev;
    delete o.deletedAt;
    return o;
  };
  stripMeta(copy);
  if (Array.isArray(copy.timers)) {
    copy.timers = copy.timers.map(t => {
      const c = stripMeta({ ...t });
      for (const k of RUNTIME_FIELDS) delete c[k];
      return c;
    });
  }
  if (Array.isArray(copy.presets)) copy.presets = copy.presets.map(p => stripMeta({ ...p }));
  if (Array.isArray(copy.deletedTimers)) copy.deletedTimers = copy.deletedTimers.map(d => stripMeta({ ...d }));
  if (Array.isArray(copy.deletedPresets)) copy.deletedPresets = copy.deletedPresets.map(d => stripMeta({ ...d }));
  return JSON.stringify(copy);
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
// An edit point is a revision plus a timestamp. The revision is authoritative —
// wall-clock time only breaks ties when two devices edit from the same revision.
function pointOf(item, tsKey = "updatedAt") {
  return {
    rev: Number(item && item.rev) || 0,
    at: item && typeof item[tsKey] === "string" ? item[tsKey] : "",
  };
}

function isNewer(a, b) {
  if (a.rev !== b.rev) return a.rev > b.rev;
  return a.at > b.at;
}

function mergeCollection(localItems, remoteItems, localDeleted, remoteDeleted) {
  const localLive = new Map((localItems || []).filter(x => x && x.id).map(x => [x.id, x]));
  const remoteLive = new Map((remoteItems || []).filter(x => x && x.id).map(x => [x.id, x]));
  const localGone = new Map((localDeleted || []).filter(x => x && x.id).map(x => [x.id, x]));
  const remoteGone = new Map((remoteDeleted || []).filter(x => x && x.id).map(x => [x.id, x]));

  const allIds = new Set([...localLive.keys(), ...remoteLive.keys(), ...localGone.keys(), ...remoteGone.keys()]);
  const items = [];
  const deleted = [];
  const seen = new Set();

  function decide(id) {
    const localItem = localLive.get(id);
    const remoteItem = remoteLive.get(id);
    const localDel = localGone.get(id);
    const remoteDel = remoteGone.get(id);

    const lp = pointOf(localItem);
    const rp = pointOf(remoteItem);
    const remoteWins = isNewer(rp, lp);
    const liveItem = remoteWins ? (remoteItem || localItem) : (localItem || remoteItem);
    const livePoint = liveItem ? (remoteWins ? rp : lp) : { rev: -1, at: "" };

    const ldp = pointOf(localDel, "deletedAt");
    const rdp = pointOf(remoteDel, "deletedAt");
    const deletePoint = localDel || remoteDel ? (isNewer(ldp, rdp) ? ldp : rdp) : { rev: -1, at: "" };

    // A deletion only wins if it is strictly newer; ties keep the live item.
    if (liveItem && !isNewer(deletePoint, livePoint)) items.push(liveItem);
    else if (deletePoint.at) deleted.push({ id, deletedAt: deletePoint.at, rev: deletePoint.rev });
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
  const lp = pointOf({ rev: l.settingsRev, updatedAt: l.updatedAt });
  const rp = pointOf({ rev: r.settingsRev, updatedAt: r.updatedAt });
  const remoteSettingsWins = isNewer(rp, lp);
  const settingsSource = remoteSettingsWins ? r : l;

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
    settingsRev: remoteSettingsWins ? rp.rev : lp.rev,
    updatedAt: (l.updatedAt || "") >= (r.updatedAt || "") ? l.updatedAt : r.updatedAt,
    deviceId: l.deviceId,
    activeSounds: l.activeSounds,
  };
  const changed = contentSignature(merged) !== contentSignature(l);
  const differs = JSON.stringify(syncComparable(merged)) !== JSON.stringify(syncComparable(l));
  return { state: merged, changed, differs };
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

async function syncNow({ manual = false, quiet = false } = {}) {
  const cfg = loadSyncConfig();
  if (!cfg || !cfg.gistId || !cfg.token) {
    setSyncStatus("Sync: off");
    if (manual) { openSyncModal(); toast("Set up sync first"); }
    return;
  }
  if (syncing) { pendingSync = true; return; }
  if (!navigator.onLine) { setSyncStatus("Offline"); return; }

  syncing = true;
  if (!quiet) setSyncStatus("Syncing…");
  try {
    const remote = normalizeRemote(await pullRemote(cfg));
    const merged = mergeStates(state, remote);
    if (merged.differs) {
      // Revisions/timestamps may need to converge silently. Only tell the user
      // when actual timer or setting content changed.
      applyMerged(merged.state);
      if (merged.changed) toast("Applied changes from another device");
    }
    // Push whenever the local state still differs from what is stored remotely.
    if (manual || JSON.stringify(syncComparable(state)) !== JSON.stringify(syncComparable(remote))) {
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

  const autoAllowed = () => {
    const cfg = loadSyncConfig();
    return !!(cfg && cfg.auto !== false && cfg.gistId && cfg.token && navigator.onLine);
  };
  setInterval(() => {
    if (document.visibilityState === "visible" && autoAllowed()) syncNow({ quiet: true });
  }, SYNC_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && autoAllowed()) syncNow();
  });

  refreshSyncUi();
  const cfg = loadSyncConfig();
  if (cfg && cfg.auto !== false && cfg.gistId && cfg.token) syncNow();
}

initSync();
