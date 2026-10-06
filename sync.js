/* ============================================================
   CLOUD SYNC - one Questlog on every device
   ============================================================ */
// The truth lives in a JSON file in the owner's Google Drive, behind the Apps Script
// (google-calendar.gs). Every device keeps working from its own localStorage and
// syncs in the background. Merging is three-way per record: the last synced state
// ("base") tells what changed locally, so a task added on the phone and a session
// growing on the Mac both survive. Details in CLAUDE.md, "Sync".
// Loaded before app.js; everything here runs only after app.js has booted.

const CLOUD_KEY = "questlog_cloud_v1";            // { url, token } - per device
const CLOUD_SYNC_KEY = "questlog_sync_v1";        // { url, version, base } - last synced state
const CLOUD_PRESYNC_KEY = "questlog_presync_backup";
const CLOUD_PUBLIC_URL = "https://tunika99.github.io/questlog/";
const CLOUD_URL_PREFIX = "https://script.google.com/macros/s/";
const ON_MAC_SERVER = ["127.0.0.1", "localhost"].includes(location.hostname);

const CLOUD_PULL_EVERY = 60000;
const CLOUD_PUSH_SOON = 2000;
const CLOUD_PUSH_QUIET = 60000;   // focus checkpoints need not cross the network every 15 s
const CLOUD_TIMEOUT = 30000;
const CLOUD_TYPING_MS = 10000;

const cloud = {
  cfg: null, version: 0, base: null,
  chain: Promise.resolve(), pushTimer: null, pushDue: 0,
  status: "off", error: "", lastOk: 0, pointerDown: false, lastKey: 0,
};

/* ---------- three-way merge ---------- */
// Plain JSON comparison: a key-order difference only ever reads as "changed",
// and every rule below resolves "changed" towards keeping data, never losing it.

const cloudSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cloudIsObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const cloudIsRecords = (x) => Array.isArray(x) && x.every((r) => cloudIsObj(r) && typeof r.id === "string");

// when both sides changed the very same value, `local` wins - it is the fresher intent
function merge3(base, local, server) {
  if (cloudSame(local, base)) return server;
  if (cloudSame(server, base) || cloudSame(local, server)) return local;
  if (cloudIsObj(local) && cloudIsObj(server)) return mergeObjects(cloudIsObj(base) ? base : {}, local, server);
  if (cloudIsRecords(local) && cloudIsRecords(server)) return mergeRecords(cloudIsRecords(base) ? base : [], local, server);
  return local;
}

function mergeObjects(base, local, server) {
  const out = {};
  for (const k of new Set([...Object.keys(server), ...Object.keys(local)])) {
    const inL = k in local, inS = k in server;
    if (inL && inS) out[k] = merge3(base[k], local[k], server[k]);
    // one side removed the key: that stands, unless the other side changed it since
    else if (inL) { if (!(k in base) || !cloudSame(local[k], base[k])) out[k] = local[k]; }
    else if (!(k in base) || !cloudSame(server[k], base[k])) out[k] = server[k];
  }
  return out;
}

// arrays of { id, ... }: server order first, records new on this device appended
function mergeRecords(base, local, server) {
  const B = new Map(base.map((r) => [r.id, r]));
  const L = new Map(local.map((r) => [r.id, r]));
  const S = new Set(server.map((r) => r.id));
  const out = [];
  for (const s of server) {
    if (L.has(s.id)) out.push(merge3(B.get(s.id), L.get(s.id), s));
    else if (!B.has(s.id) || !cloudSame(s, B.get(s.id))) out.push(s);   // deleted here - unless changed there since
  }
  for (const l of local) {
    if (S.has(l.id)) continue;
    if (!B.has(l.id) || !cloudSame(l, B.get(l.id))) out.push(l);        // deleted there - unless changed here since
  }
  return out;
}

const cloudIsEmpty = (d) => !d || !["quests", "tasks", "sessions", "blocks", "habits", "beliefs"].some((k) => (d[k] || []).length);

/* ---------- state on this device ---------- */

function cloudLoadState() {
  try { cloud.cfg = JSON.parse(localStorage.getItem(CLOUD_KEY) || "null"); } catch (e) { cloud.cfg = null; }
  cloud.version = 0;
  cloud.base = null;
  if (!cloud.cfg) return;
  try {
    const s = JSON.parse(localStorage.getItem(CLOUD_SYNC_KEY) || "null");
    // a remembered base belongs to the store it came from, and to no other
    if (s && s.url === cloud.cfg.url) { cloud.version = s.version; cloud.base = s.base; }
  } catch (e) { /* the next pull rebuilds it */ }
}

function cloudSaveState() {
  try {
    localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify({ url: cloud.cfg.url, version: cloud.version, base: cloud.base }));
  } catch (e) { /* storage full - next boot counts as first contact, which keeps everything */ }
}

function cloudConnect(cfg) {
  localStorage.setItem(CLOUD_KEY, JSON.stringify(cfg));
  cloudLoadState();
}

/* ---------- talking to the Apps Script ---------- */

async function cloudCall(action, params = {}, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CLOUD_TIMEOUT);
  try {
    const q = new URLSearchParams({ action, token: cloud.cfg.token, ...params });
    // a plain string body keeps this a "simple" request - Apps Script cannot answer a CORS preflight
    const res = await fetch(`${cloud.cfg.url}?${q}`, body === undefined
      ? { signal: ctl.signal }
      : { method: "POST", body: JSON.stringify(body), signal: ctl.signal });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || "no answer");
    return out;
  } finally {
    clearTimeout(timer);
  }
}

// one sync step at a time - two overlapping ones would merge against a stale base
function cloudRun(fn) {
  cloud.chain = cloud.chain.then(fn).catch(cloudFailed);
  return cloud.chain;
}

async function cloudSyncNow() {
  if (!cloud.cfg) return;
  if (cloud.status !== "ok") cloudSetStatus("syncing");
  const out = await cloudCall("load", { have: cloud.version });
  if (!out.same) await cloudAdopt(out.version, out.data);
  await cloudPush();
  cloudSetStatus("ok");
}

async function cloudPushNow() {
  if (!cloud.cfg) return;
  await cloudPush();
  cloudSetStatus("ok");
}

async function cloudPush(depth = 0) {
  const snapshot = JSON.stringify(db);
  if (snapshot === cloud.base) return;
  if (cloud.version === 0 && cloudIsEmpty(db)) return;   // never seed the store with an empty app
  const out = await cloudCall("save", {}, { baseVersion: cloud.version, data: snapshot });
  if (out.conflict) {
    if (depth >= 3) throw new Error("kept colliding with another device");
    await cloudAdopt(out.version, out.data);
    return cloudPush(depth + 1);
  }
  cloud.version = out.version;
  cloud.base = snapshot;
  cloudSaveState();
}

// take in what the store holds now, keeping whatever changed on this device
async function cloudAdopt(version, data) {
  const remote = data ? JSON.parse(data) : null;
  const build = () => {
    if (!remote) return db;   // empty store: ours goes up with the next push
    if (!cloud.base) return cloudIsEmpty(db) ? remote : merge3(emptyDb(), db, remote);   // first contact: union
    return merge3(JSON.parse(cloud.base), db, remote);
  };
  let merged = build();
  if (merged !== db && !cloudSame(merged, db)) {
    // never pull the floor away mid-edit: wait until the hands are off, then merge afresh
    while (cloudBusy()) await new Promise((r) => setTimeout(r, 1000));
    merged = build();
  }
  const firstContact = !cloud.base;
  cloud.version = version;
  cloud.base = data;
  cloudSaveState();
  if (merged === db || cloudSame(merged, db)) return;
  if (firstContact) {
    try { localStorage.setItem(CLOUD_PRESYNC_KEY, JSON.stringify(db)); } catch (e) { /* nice to have */ }
  }
  cloudApply(merged);
}

function cloudApply(merged) {
  db = merged;
  normalizeDb(db);
  // undo must not reach back across another device's changes - it would erase them everywhere
  history.past = [];
  history.future = [];
  persistHistory();
  lastSnapshot = JSON.stringify(db);
  writeStore(lastSnapshot);
  if (ui.questDetail && !questById(ui.questDetail)) ui.questDetail = null;
  if (ui.selectedTaskId && !taskById(ui.selectedTaskId)) ui.selectedTaskId = null;
  renderAll();
}

function cloudBusy() {
  if (cloud.pointerDown || Date.now() - cloud.lastKey < CLOUD_TYPING_MS) return true;
  const a = document.activeElement;
  const typingInto = a && ((/^(INPUT|TEXTAREA)$/.test(a.tagName) && a.value) || a.isContentEditable);
  if (typingInto) return true;
  return !!document.querySelector("#fb-detail, #review-overlay, #priming-overlay, .confirm-overlay, #qmenu, .tl-form, .fb-pop");
}

/* ---------- pushing changes out ---------- */

// called on every save; `quiet` bookkeeping (focus checkpoints) may wait a minute
function cloudSchedule(quiet) {
  if (!cloud.cfg) return;
  const due = Date.now() + (quiet ? CLOUD_PUSH_QUIET : CLOUD_PUSH_SOON);
  if (cloud.pushTimer && cloud.pushDue <= due) return;   // an earlier push is already coming
  clearTimeout(cloud.pushTimer);
  cloud.pushDue = due;
  cloud.pushTimer = setTimeout(() => { cloud.pushTimer = null; cloudRun(cloudPushNow); }, due - Date.now());
}

/* ---------- status in the sidebar ---------- */

function cloudSetStatus(status, error = "") {
  cloud.status = status;
  cloud.error = error;
  if (status === "ok") cloud.lastOk = Date.now();
  cloudRenderStatus();
}

function cloudFailed(e) {
  const offline = !navigator.onLine || e instanceof TypeError || e?.name === "AbortError";
  cloudSetStatus(offline ? "offline" : "error", String(e?.message || e));
}

function cloudRenderStatus() {
  const el = document.getElementById("sync-status");
  if (!el) return;
  el.hidden = !cloud.cfg;
  if (!cloud.cfg) return;
  const label = { syncing: "Syncing…", ok: "Synced", offline: "Offline - changes wait here", error: "Sync problem" }[cloud.status] || "Sync";
  el.className = `sync-status is-${cloud.status}`;
  el.innerHTML = `<span class="sync-dot"></span>${label}`;
  el.title = cloud.status === "error" ? cloud.error
    : cloud.lastOk ? `Last synced ${new Date(cloud.lastOk).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - click to sync now`
    : "";
}

/* ---------- connecting a device ---------- */

function cloudConnectLink() {
  const b64 = btoa(JSON.stringify({ u: cloud.cfg.url, t: cloud.cfg.token }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${CLOUD_PUBLIC_URL}#connect=${b64}`;
}

async function cloudReadConnectLink() {
  const m = location.hash.match(/^#connect=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  // the key must not linger in the address bar or a shared screenshot
  window.history.replaceState(null, "", location.pathname + location.search);
  let cfg;
  try {
    const raw = JSON.parse(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")));
    cfg = { url: String(raw.u || ""), token: String(raw.t || "") };
  } catch (e) { return; }
  // the link decides where this device sends everything - an Apps Script and nothing else
  if (!cfg.url.startsWith(CLOUD_URL_PREFIX) || !cfg.token) return;
  if (cloud.cfg && cloud.cfg.url !== cfg.url) {
    const ok = await confirmDialog({
      title: "Connect this device to a different sync store?",
      confirmLabel: "Switch",
      body: `<p>This device already syncs elsewhere. Only switch if you made this link yourself.</p>`,
    });
    if (!ok) return;
  }
  cloudConnect(cfg);
  toast("This device is connected - your Questlog is on its way.", 4000);
}

async function cloudFetchMacConfig() {
  try {
    const res = await fetch("/api/cloud-config", { headers: { "X-Questlog": "1" } });
    const out = await res.json();
    if (out.ok && String(out.url).startsWith(CLOUD_URL_PREFIX) && out.token) cloudConnect({ url: out.url, token: out.token });
  } catch (e) { /* no local server - stay unconnected */ }
}

function cloudPaletteItems() {
  if (!cloud.cfg) return [];
  return [
    { icon: "⟳", label: "Sync now", run: () => cloudRun(cloudSyncNow) },
    { icon: "⧉", label: "Copy link to connect another device", run: async () => {
      await navigator.clipboard.writeText(cloudConnectLink());
      toast("Link copied. It carries your sync key - send it only to yourself.", 5000);
    } },
  ];
}

// resolves after the first sync, so priming and review see this device's freshest state
async function cloudBoot() {
  addEventListener("pointerdown", () => { cloud.pointerDown = true; }, true);
  addEventListener("pointerup", () => { cloud.pointerDown = false; }, true);
  addEventListener("pointercancel", () => { cloud.pointerDown = false; }, true);
  addEventListener("keydown", () => { cloud.lastKey = Date.now(); }, true);
  cloudLoadState();
  await cloudReadConnectLink();
  if (!cloud.cfg && ON_MAC_SERVER) await cloudFetchMacConfig();
  const statusEl = document.getElementById("sync-status");
  statusEl?.addEventListener("click", async () => {
    await cloudRun(cloudSyncNow);
    if (cloud.status === "error") toast(`Sync problem: ${esc(cloud.error)}`, 6000);
  });
  cloudRenderStatus();
  if (!cloud.cfg) return;
  setInterval(() => { if (document.visibilityState === "visible") cloudRun(cloudSyncNow); }, CLOUD_PULL_EVERY);
  document.addEventListener("visibilitychange", () => {
    // coming back: fetch what changed elsewhere; leaving: get ours out while we still can
    cloudRun(document.visibilityState === "visible" ? cloudSyncNow : cloudPushNow);
  });
  // never hold the app hostage to a slow network
  await Promise.race([cloudRun(cloudSyncNow), new Promise((r) => setTimeout(r, 5000))]);
}

if (typeof module !== "undefined") module.exports = { merge3, cloudIsEmpty };
