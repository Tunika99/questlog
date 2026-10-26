/* ============================================================
   Questlog - clickable prototype
   Vanilla JS, localStorage persistence, seeded demo history.
   ============================================================ */

"use strict";

/* ---------- utilities ---------- */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DAY = 86400000;
const HOUR = 3600000;

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function startOfWeek(t) { const d = new Date(startOfDay(t)); const dow = (d.getDay() + 6) % 7; return d.getTime() - dow * DAY; }
function ymd(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }

function fmtHours(sec) {
  if (sec < 3570) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
function fmtClock(t) { const d = new Date(t); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function fmtDayLabel(t) {
  return new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// deterministic rng for the demo seed
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================
   SOUND - synthesised, no assets, mutable
   ============================================================ */

const sfx = (() => {
  let ctx = null;
  const on = () => !db || db.settings?.sound !== false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone(freq, { dur = 0.2, type = "sine", gain = 0.13, delay = 0, to = null } = {}) {
    const c = ensure();
    if (!c || !on()) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  const seq = (freqs, { stagger = 0.08, ...opts } = {}) =>
    freqs.forEach((f, i) => tone(f, { ...opts, delay: i * stagger }));

  return {
    unlock: ensure,
    isOn: on,
    tap: () => tone(680, { dur: 0.06, gain: 0.06, type: "triangle" }),
    check: () => seq([659.25, 987.77], { dur: 0.24, gain: 0.11, stagger: 0.06 }),
    complete: () => seq([523.25, 659.25, 783.99], { dur: 0.5, gain: 0.12, stagger: 0.075 }),
    milestone: () => seq([523.25, 659.25, 783.99, 1046.5], { dur: 0.7, gain: 0.13, stagger: 0.085 }),
    // the pomodoro voice: falling = rest, rising = back to work
    pause: () => seq([440, 330], { dur: 0.26, gain: 0.1, stagger: 0.1 }),
    resume: () => seq([330, 440], { dur: 0.26, gain: 0.1, stagger: 0.1 }),
    breakStart: () => seq([880, 659.25, 523.25], { dur: 0.62, gain: 0.13, stagger: 0.13, type: "sine" }),
    workStart: () => seq([523.25, 659.25, 880], { dur: 0.52, gain: 0.14, stagger: 0.11, type: "sine" }),
    // earned moments get a fanfare, not a beep
    levelUp: () => seq([392, 523.25, 659.25, 783.99, 1046.5], { dur: 0.75, gain: 0.13, stagger: 0.1 }),
    record: () => seq([523.25, 783.99, 1046.5, 1318.5], { dur: 0.9, gain: 0.14, stagger: 0.12 }),
  };
})();

/* ---------- store ---------- */

const QUEST_COLORS = [
  "#E2B34E", "#E07A4F", "#D96C5A", "#D96C8A", "#C77FBF", "#B78FD6", "#8E8FD8",
  "#7FA8D9", "#6FBAC4", "#6FC2A0", "#8FB573", "#B9C46A", "#D9B26A", "#C98F6A",
];

/* a new quest gets a colour nobody else is using yet */
function nextFreeColour() {
  const taken = new Set(db.quests.map((q) => (q.color || "").toUpperCase()));
  return QUEST_COLORS.find((c) => !taken.has(c.toUpperCase())) || QUEST_COLORS[db.quests.length % QUEST_COLORS.length];
}
const STORE_KEY = "questlog_v1";

let db = null;

/* ---------- history: every save() is an undo point ---------- */

const history = { past: [], future: [], limit: 60 };
const HISTORY_KEY = "questlog_history_v1";
let lastSnapshot = null;

/* history survives reloads: restored on load, flushed when the page goes away */
function loadHistory() {
  try {
    const raw = appStore.getItem(HISTORY_KEY);
    if (!raw) return;
    const h = JSON.parse(raw);
    if (Array.isArray(h.past)) history.past = h.past.slice(-history.limit);
    if (Array.isArray(h.future)) history.future = h.future.slice(-history.limit);
  } catch (e) { /* start with an empty history */ }
}

function persistHistory() {
  if (cloud.frozen) return;   // leaving after a (dis)connect: nothing goes back into this browser
  try {
    appStore.setItem(HISTORY_KEY, JSON.stringify({
      past: history.past.slice(-40),
      future: history.future.slice(-40),
    }));
  } catch (e) { /* storage full - better to lose history than to crash */ }
}

let storageWarned = false;

/* private mode and full disks must not take the app down with them */
function writeStore(json, quiet = false) {
  if (cloud.frozen) return;
  try {
    appStore.setItem(STORE_KEY, json);
  } catch (e) {
    if (!storageWarned) {
      storageWarned = true;
      toast("Can't save to this browser - your work stays for this session only.", 6000);
    }
  }
  syncStateToServer();
  cloudSchedule(quiet);
}

// the slice of planned blocks Google Calendar mirrors: today and the next 60 days
function calendarPayload() {
  const from = startOfDay(Date.now()), to = from + 60 * DAY;
  return {
    from, to,
    blocks: (db.blocks || [])
      .filter((b) => b.end > from && b.start < to)
      .map((b) => ({ id: b.id, start: b.start, end: b.end, title: calendarTitle(b) })),
  };
}

function calendarTitle(b) {
  const titles = (b.taskIds || []).map(taskById).filter(Boolean).map((t) => t.title);
  return titles.length ? `Focus: ${titles.join(", ")}` : "Focus block";
}

/* mirrors a small daily summary to the local server on every save (incl. the
   15s focus checkpoint, undo, redo) - so Mac-side scripts can react even on
   days the browser tab never opens: a morning notification with today's
   belief, a "no focus block yet" nudge, a menu bar reading. Debounced and
   best-effort; the app must behave identically with the server unreachable. */
let syncStateTimer = null;
function syncStateToServer() {
  if (!ON_MAC_SERVER) return;
  clearTimeout(syncStateTimer);
  syncStateTimer = setTimeout(() => {
    // an empty browser (a second one, a private window) has nothing to report -
    // and must not overwrite the real state the everyday browser wrote
    if (!db.quests.length && !db.tasks.length && !(db.blocks || []).length && !(db.beliefs || []).length) return;
    const today = ymd(Date.now());
    const ds = startOfDay(Date.now());
    const cal = calendarPayload();
    fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Questlog": "1" },
      body: JSON.stringify({
        date: today,
        questSecondsToday: questSecondsBetween(ds, ds + DAY),
        blocksToday: blocksFor(today).length,
        primedToday: primedToday(),
        beliefToday: todaysBelief()?.text || null,
        beliefs: (db.beliefs || []).map((b) => b.text),
        calendarFrom: cal.from,
        calendarTo: cal.to,
        calendarBlocks: cal.blocks,
      }),
    }).catch(() => {});
  }, 800);
}

function save(label = "change") {
  const now = JSON.stringify(db);
  if (lastSnapshot === null) {
    lastSnapshot = now;
  } else if (now !== lastSnapshot) {
    history.past.push({ snap: lastSnapshot, label });
    if (history.past.length > history.limit) history.past.shift();
    history.future = [];
    lastSnapshot = now;
  }
  writeStore(now);
}

function undoLast() {
  const e = history.past.pop();
  if (!e) { toast("Nothing to undo.", 1800); return; }
  history.future.push({ snap: lastSnapshot, label: e.label });
  db = JSON.parse(e.snap);
  lastSnapshot = e.snap;
  writeStore(e.snap);
  persistHistory();
  renderAll();
  toast(`Undone: <span class="gold">${esc(e.label)}</span>`, 2400);
}

function redoLast() {
  const e = history.future.pop();
  if (!e) { toast("Nothing to redo.", 1800); return; }
  history.past.push({ snap: lastSnapshot, label: e.label });
  db = JSON.parse(e.snap);
  lastSnapshot = e.snap;
  writeStore(e.snap);
  persistHistory();
  renderAll();
  toast(`Redone: <span class="gold">${esc(e.label)}</span>`, 2400);
}

function load() {
  try {
    const raw = appStore.getItem(STORE_KEY);
    if (raw) {
      db = JSON.parse(raw);
      if (db && db.seedVersion === 4) {
        normalizeDb(db);
        rolloverOpenTasks();
        lastSnapshot = JSON.stringify(db);
        return;
      }
    }
  } catch (e) { /* re-seed */ }
  // a fresh install starts empty - demo data only on request (Cmd+K)
  db = emptyDb();
  save();
  lastSnapshot = JSON.stringify(db);
}

// fields added over time - an older save (or another device's) must not trip over them
function normalizeDb(d) {
  if (!d.blocks) d.blocks = [];
  if (!d.settings) d.settings = { sound: true };
  if (!d.progress) d.progress = { levels: {}, weekBeaten: null, dayBeaten: null };
  if (!d.cookies) d.cookies = [];
  if (!d.beliefs) d.beliefs = [];
  if (!d.reviews) d.reviews = [];
  if (!d.metrics) d.metrics = [];
  if (!d.weekGoals) d.weekGoals = [];
}

// a daily planner carries unfinished intent forward
function rolloverOpenTasks() {
  const today = ymd(Date.now());
  let changed = false;
  // tasks without a date live in Someday and must never be dragged into today
  for (const t of db.tasks) if (!t.done && !t.adhoc && t.date && t.date < today) { t.date = today; changed = true; }
  if (changed) save();
}

function seed() {
  const rng = mulberry32(42);
  const now = Date.now();
  const todayStart = startOfDay(now);
  const weekStart = startOfWeek(now);

  const quests = [
    { id: "q_mvp", name: "Ship the MVP", color: "#E2B34E", kind: "work", horizon: "Q3 2026" },
    { id: "q_run", name: "Run a half-marathon", color: "#8FB573", kind: "personal", horizon: "Q3 2026" },
    { id: "q_read", name: "Read 12 books", color: "#B78FD6", kind: "personal", horizon: "2026" },
  ];

  const tasks = [];
  const sessions = [];

  // hidden history tasks that carry past logged time
  const hist = {
    q_mvp: { id: "th_mvp", title: "Deep work - MVP", questId: "q_mvp", kind: "work" },
    q_run: { id: "th_run", title: "Training run", questId: "q_run", kind: "personal" },
    q_read: { id: "th_read", title: "Reading session", questId: "q_read", kind: "personal" },
  };
  for (const k in hist) tasks.push({ ...hist[k], done: true, order: 999, date: ymd(now - 7 * DAY) });

  // six past weeks of quest hours; Wednesday is the heavy day, week -3 is the record
  const weekTargets = [6.5, 8.0, 11.0, 18.4, 7.5, 9.0]; // weeks -6 .. -1
  const dayWeights = [0.16, 0.15, 0.25, 0.12, 0.14, 0.1, 0.08];
  weekTargets.forEach((target, wi) => {
    const ws = weekStart - (6 - wi) * 7 * DAY;
    for (let d = 0; d < 7; d++) {
      const dayHours = target * dayWeights[d];
      if (dayHours < 0.3) continue;
      const dStart = ws + d * DAY;
      // morning block: MVP (70%)
      const mStart = dStart + 9 * HOUR + Math.floor(rng() * 6) * 10 * 60000;
      sessions.push({ id: uid(), taskId: "th_mvp", start: mStart, end: mStart + dayHours * 0.7 * HOUR });
      // evening block: run or reading (30%)
      const eTask = rng() < 0.5 ? "th_run" : "th_read";
      const eStart = dStart + 18 * HOUR + Math.floor(rng() * 4) * 15 * 60000;
      sessions.push({ id: uid(), taskId: eTask, start: eStart, end: eStart + dayHours * 0.3 * HOUR });
    }
  });

  // current week - Monday
  const mon = weekStart;
  sessions.push({ id: uid(), taskId: "th_mvp", start: mon + 9.5 * HOUR, end: mon + 11.7 * HOUR }); // 2.2h
  sessions.push({ id: uid(), taskId: "th_run", start: mon + 18 * HOUR, end: mon + 19 * HOUR }); // 1h

  // today's task list
  const today = ymd(now);
  const mk = (title, questId, kind, done, order) => {
    const t = { id: uid(), title, questId, kind, done, order, date: today };
    tasks.push(t);
    return t;
  };
  const tPay = mk("Wire up payment flow", "q_mvp", "work", false, 1);
  const tRun = mk("Interval run 6×800m", "q_run", "personal", false, 2);
  const tReview = mk("Review onboarding copy", "q_mvp", "work", false, 3);
  const tRead = mk("Read: The Name of the Rose · ch. 4-6", "q_read", "personal", false, 4);
  mk("Reply to accountant", null, "work", false, 5);
  mk("Book dentist appointment", null, "personal", false, 6);
  const tAdmin = mk("Morning admin & email", null, "work", true, 7);
  mk("Standup + sprint notes", null, "work", true, 8);

  // time already logged today
  sessions.push({ id: uid(), taskId: tAdmin.id, start: todayStart + 8 * HOUR + 40 * 60000, end: todayStart + 9 * HOUR + 10 * 60000 });
  sessions.push({ id: uid(), taskId: tPay.id, start: todayStart + 9 * HOUR + 10 * 60000, end: todayStart + 10 * HOUR });

  // habits
  const habits = [
    { id: uid(), name: "Anki reviews", questId: null, checks: {} },
    { id: uid(), name: "Stretching 10 min", questId: "q_run", checks: {} },
    { id: uid(), name: "Read 20 pages", questId: "q_read", checks: {} },
  ];
  const streaks = [12, 4, 23];
  habits.forEach((h, i) => {
    for (let d = 1; d <= streaks[i]; d++) h.checks[ymd(now - d * DAY)] = true;
  });

  // three planned focus blocks for today, with tasks already packed in
  const blocks = [
    { id: uid(), date: today, start: todayStart + 9 * HOUR, end: todayStart + 12 * HOUR, taskIds: [tPay.id, tReview.id] },
    { id: uid(), date: today, start: todayStart + 13 * HOUR, end: todayStart + 16 * HOUR, taskIds: [tRead.id] },
    { id: uid(), date: today, start: todayStart + 17 * HOUR, end: todayStart + 20 * HOUR, taskIds: [tRun.id] },
  ];

  return {
    seedVersion: 4, quests, tasks, sessions, habits, blocks,
    settings: { sound: true },
    progress: { levels: {}, weekBeaten: null, dayBeaten: null },
    cookies: [
      { id: uid(), text: "Shipped the first prototype in a weekend, on no sleep.", date: ymd(now - 21 * DAY), kind: "manual" },
      { id: uid(), text: "Ran 15k in the rain when every part of me wanted to quit.", date: ymd(now - 9 * DAY), kind: "manual" },
    ],
  };
}

/* ---------- derived data ---------- */

const questById = (id) => db.quests.find((q) => q.id === id) || null;
const taskById = (id) => db.tasks.find((t) => t.id === id) || null;

function sessionSecondsBetween(a, b, filter) {
  let sec = 0;
  for (const s of db.sessions) {
    if (filter && !filter(s)) continue;
    const start = Math.max(s.start, a);
    const end = Math.min(s.end, b);
    if (end > start) sec += (end - start) / 1000;
  }
  return sec;
}

const isQuestSession = (s) => { const t = taskById(s.taskId); return !!(t && t.questId); };

function questSecondsBetween(a, b) { return sessionSecondsBetween(a, b, isQuestSession); }

function taskLoggedSeconds(taskId) {
  return db.sessions.filter((s) => s.taskId === taskId).reduce((acc, s) => acc + (s.end - s.start) / 1000, 0);
}

function questTotalSeconds(questId) {
  return db.sessions.reduce((acc, s) => {
    const t = taskById(s.taskId);
    return t && t.questId === questId ? acc + (s.end - s.start) / 1000 : acc;
  }, 0);
}



/* ---------- metrics: how a quest gets measured ---------- */

const metricsFor = (questId) => (db.metrics || []).filter((m) => m.questId === questId);

/* hours metrics read straight from the logged time, counters carry their own value */
function metricValue(m) {
  if (m.kind === "hours") return questRollupSeconds(m.questId) / 3600;
  return m.value || 0;
}

function metricProgress(m) {
  const v = metricValue(m);
  const target = m.target || 0;
  return { value: v, target, pct: target > 0 ? clamp(v / target, 0, 1) : 0, reached: target > 0 && v >= target };
}

function fmtMetric(m, v) {
  if (m.kind === "hours") return v < 10 ? v.toFixed(1) + "h" : Math.round(v) + "h";
  return String(Math.round(v * 100) / 100);
}

function bumpMetric(id, delta) {
  const m = (db.metrics || []).find((x) => x.id === id);
  if (!m || m.kind === "hours") return;
  const before = metricProgress(m).reached;
  m.value = Math.max(0, (m.value || 0) + delta);
  save(delta > 0 ? `+1 on "${m.name}"` : `-1 on "${m.name}"`);
  const after = metricProgress(m);
  if (!before && after.reached) {
    sfx.levelUp();
    addCookie(`Reached "${m.name}" - ${fmtMetric(m, after.value)} of ${fmtMetric(m, m.target)}.`, "earned");
    toast(`<span class="gold">${esc(m.name)} reached</span> - ${fmtMetric(m, after.value)} / ${fmtMetric(m, m.target)}. <em>Into the jar.</em>`, 6000);
  }
}

/* ---------- deadlines ---------- */

function deadlineInfo(q) {
  if (!q.deadline) return null;
  const days = Math.round((dateFromYmd(q.deadline) - startOfDay(Date.now())) / DAY);
  const label = days < 0 ? `${Math.abs(days)}d overdue`
    : days === 0 ? "due today"
    : days === 1 ? "1 day left"
    : `${days} days left`;
  const tone = days < 0 ? "over" : days <= 7 ? "soon" : "ok";
  return { days, label, tone, date: q.deadline };
}

/* ---------- sub-quests: a quest may sit under another ---------- */

const subQuests = (parentId) => db.quests.filter((q) => q.parentId === parentId && !q.archived);
const topQuests = () => db.quests.filter((q) => !q.parentId && !q.archived);

/* the quest and everything nested beneath it */
function questFamily(questId) {
  const ids = [questId];
  for (const child of db.quests.filter((q) => q.parentId === questId)) ids.push(...questFamily(child.id));
  return ids;
}

/* a parent's hours include the hours of its sub-quests */
function questRollupSeconds(questId) {
  return questFamily(questId).reduce((acc, id) => acc + questTotalSeconds(id), 0);
}

function questSecondsBetweenFor(questId, a, b) {
  const family = new Set(questFamily(questId));
  return db.sessions.reduce((acc, s) => {
    const t = taskById(s.taskId);
    if (!t || !family.has(t.questId)) return acc;
    const from = Math.max(s.start, a), to = Math.min(s.end, b);
    return to > from ? acc + (to - from) / 1000 : acc;
  }, 0);
}

/* every session ever logged against this quest family, newest first */
function questSessions(questId) {
  const family = new Set(questFamily(questId));
  return db.sessions
    .filter((s) => { const t = taskById(s.taskId); return t && family.has(t.questId); })
    .sort((a, b) => b.start - a.start);
}

function weeklyQuestSeconds(weekStart) { return questSecondsBetween(weekStart, weekStart + 7 * DAY); }

/* one pass over the sessions instead of one pass per day */
function questSecondsByDay(from, to, questId = null) {
  const family = questId ? new Set(questFamily(questId)) : null;
  const questTasks = new Set(
    db.tasks.filter((t) => (family ? family.has(t.questId) : !!t.questId)).map((t) => t.id)
  );
  const map = new Map();
  for (const s of db.sessions) {
    if (!questTasks.has(s.taskId)) continue;
    let a = Math.max(s.start, from);
    const end = Math.min(s.end, to);
    while (a < end) {
      const seg = Math.min(end, startOfDay(a) + DAY) - a;
      const k = ymd(a);
      map.set(k, (map.get(k) || 0) + seg / 1000);
      a += seg;
    }
  }
  return map;
}

function lastNWeeks(n) {
  const cur = startOfWeek(Date.now());
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ weekStart: cur - i * 7 * DAY, seconds: weeklyQuestSeconds(cur - i * 7 * DAY) });
  return out;
}

// best full week before the current one
function recordWeek() {
  const cur = startOfWeek(Date.now());
  let earliest = cur;
  for (const s of db.sessions) earliest = Math.min(earliest, startOfWeek(s.start));
  let best = null;
  for (let ws = earliest; ws < cur; ws += 7 * DAY) {
    const sec = weeklyQuestSeconds(ws);
    if (sec > 0 && (!best || sec > best.seconds)) best = { weekStart: ws, seconds: sec };
  }
  return best;
}

// best single day before today
function recordDay() {
  const today = startOfDay(Date.now());
  let earliest = today;
  for (const s of db.sessions) earliest = Math.min(earliest, startOfDay(s.start));
  let best = null;
  for (let d = earliest; d < today; d += DAY) {
    const sec = questSecondsBetween(d, d + DAY);
    if (sec > 0 && (!best || sec > best.seconds)) best = { dayStart: d, seconds: sec };
  }
  return best;
}

// cumulative quest-hours curve across a week: 8 points (day boundaries), optionally cut at `until`
function weekCurve(weekStart, until) {
  const pts = [0];
  for (let d = 1; d <= 7; d++) {
    const edge = Math.min(weekStart + d * DAY, until ?? Infinity);
    pts.push(questSecondsBetween(weekStart, edge));
    if (until && weekStart + d * DAY >= until) break;
  }
  return pts;
}

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

function blocksFor(dateYmd) {
  return (db.blocks || []).filter((b) => b.date === dateYmd).sort((a, b) => a.start - b.start);
}
function todayBlocks() { return blocksFor(ymd(Date.now())); }

/* instant-focus sessions keep their task (it carries the quest link and the hours)
   but are sessions, not to-dos - they never show up in a list */
const isListed = (t) => !t.adhoc;

function tasksFor(dateYmd) {
  return db.tasks.filter((t) => t.date === dateYmd && isListed(t)).sort((a, b) => a.order - b.order);
}

/* ============================================================
   PROGRESSION - every number below is earned, none invented
   ============================================================ */

// cumulative hours per level: the climb gets steeper, like the work does
const QUEST_TIERS = [10, 25, 50, 100, 175, 275, 400, 550, 750, 1000];
const TIER_NAMES = ["Ember", "Apprentice", "Journeyman", "Adept", "Expert",
                    "Master", "Virtuoso", "Luminary", "Legend", "Mythic"];

function questLevel(sec) {
  const hours = sec / 3600;
  let level = 0;
  for (let i = 0; i < QUEST_TIERS.length; i++) if (hours >= QUEST_TIERS[i]) level = i + 1;
  const floor = level === 0 ? 0 : QUEST_TIERS[level - 1];
  const next = level < QUEST_TIERS.length ? QUEST_TIERS[level] : null;
  return {
    level,
    name: level ? TIER_NAMES[level - 1] : "Unranked",
    nextName: next ? TIER_NAMES[level] : null,
    floor, next, hours,
    toNext: next ? next - hours : 0,
    progress: next ? clamp((hours - floor) / (next - floor), 0, 1) : 1,
  };
}

/* consecutive days that carried at least a minute of quest work */
function questDayStreak() {
  let d = startOfDay(Date.now());
  if (questSecondsBetween(d, d + DAY) < 60) d -= DAY; // today may still be young
  let streak = 0;
  while (questSecondsBetween(d, d + DAY) >= 60) { streak++; d -= DAY; }
  return streak;
}

function bestQuestDayStreak() {
  let earliest = startOfDay(Date.now());
  for (const s of db.sessions) earliest = Math.min(earliest, startOfDay(s.start));
  let best = 0, run = 0;
  for (let d = earliest; d <= startOfDay(Date.now()); d += DAY) {
    if (questSecondsBetween(d, d + DAY) >= 60) { run++; best = Math.max(best, run); }
    else run = 0;
  }
  return best;
}

const HONESTY_RANKS = [
  { min: 80, name: "Focused", note: "Almost everything you logged served a goal." },
  { min: 60, name: "Steady", note: "Most of your hours pulled in one direction." },
  { min: 40, name: "Split", note: "Half your week went to upkeep." },
  { min: 0, name: "Scattered", note: "The week belonged to other people's priorities." },
];
const honestyRank = (pct) => HONESTY_RANKS.find((r) => pct >= r.min);

/* bookkeeping for celebrations must not pollute the undo history */
function saveQuiet() {
  const now = JSON.stringify(db);
  lastSnapshot = now;
  writeStore(now, true);
}

/* fires once per genuine threshold crossing, wherever the time came from */
function checkProgressEvents() {
  if (!db.progress) db.progress = { levels: {}, weekBeaten: null, dayBeaten: null };
  const p = db.progress;
  let dirty = false;

  for (const q of db.quests) {
    const lvl = questLevel(questTotalSeconds(q.id)).level;
    const known = p.levels[q.id];
    if (known === undefined) { p.levels[q.id] = lvl; dirty = true; continue; }
    if (lvl > known) {
      p.levels[q.id] = lvl;
      dirty = true;
      const info = questLevel(questTotalSeconds(q.id));
      sfx.levelUp();
      sparkBurst($("#hero-num"), q.color, 22, 90);
      addCookie(`${QUEST_TIERS[lvl - 1]} hours into “${q.name}” - reached ${info.name}.`, "earned");
      toast(`<span class="gold">${esc(q.name)} reached ${info.name}</span> - level ${lvl}, ${QUEST_TIERS[lvl - 1]}h invested. <em>Into the jar.</em>`, 6000);
    } else if (lvl < known) { p.levels[q.id] = lvl; dirty = true; }
  }

  const ws = startOfWeek(Date.now());
  const recW = recordWeek();
  const curW = weeklyQuestSeconds(ws);
  if (recW && curW > recW.seconds && p.weekBeaten !== String(ws)) {
    p.weekBeaten = String(ws);
    dirty = true;
    sfx.record();
    sparkBurst($("#hero-num"), "#f6cd6d", 26, 120);
    addCookie(`Record week - ${fmtHours(curW)} of quest hours, past your old best of ${fmtHours(recW.seconds)}.`, "earned");
    toast(`<span class="gold">New record week</span> - ${fmtHours(curW)}, past your old best of ${fmtHours(recW.seconds)}. <em>Into the jar.</em>`, 7000);
  }

  const ds = startOfDay(Date.now());
  const recD = recordDay();
  const curD = questSecondsBetween(ds, ds + DAY);
  if (recD && curD > recD.seconds && p.dayBeaten !== ymd(ds)) {
    p.dayBeaten = ymd(ds);
    dirty = true;
    sfx.record();
    sparkBurst($("#hero-day-num"), "#f6cd6d", 20, 100);  // der Tagesrekord gehoert zur Tageszahl
    addCookie(`Best day ever logged - ${fmtHours(curD)} of quest hours.`, "earned");
    toast(`<span class="gold">Best day you've ever logged</span> - ${fmtHours(curD)}. <em>Into the jar.</em>`, 7000);
  }

  if (dirty) saveQuiet();
}

/* ---------- ui state ---------- */

const ui = {
  view: "timeline",   // the Day log is where a visit starts
  selectedTaskId: null,
  recordScope: "week",
  focus: null, // { taskId, segStart, committed, mode, phase, phaseStart, phaseBase, cycles } - survives leaving the overlay
  focusTicker: null,
  paletteIndex: 0,
  lastHeroSeconds: null,
  tlDate: null, // day shown in the day log; null = today
  questDetail: null, // quest id when the Quests view is showing one quest
  reviewsExpanded: false,
  doneExpanded: false, // Done section: today only, or the whole ledger
  upcomingExpanded: false,
  somedayExpanded: false,
  somedayBucket: "someday",
  somedayDate: null,
  animateList: true, // stagger rows in on view changes, not on every re-render
  justCompleted: null, // task id that should land in Done with a flourish
};

/* ============================================================
   DELIGHT - the reward for finishing things
   ============================================================ */

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* a burst of embers from an element's centre */
function sparkBurst(el, color = "#f6cd6d", count = 12, spread = 52) {
  if (reducedMotion || !el) return;
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const layer = document.createElement("div");
  layer.className = "spark-layer";
  for (let i = 0; i < count; i++) {
    const s = document.createElement("i");
    const ang = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const dist = spread * (0.55 + Math.random() * 0.7);
    const size = 3 + Math.random() * 4;
    s.style.cssText =
      `left:${cx}px;top:${cy}px;width:${size}px;height:${size}px;background:${color};` +
      `--dx:${(Math.cos(ang) * dist).toFixed(1)}px;--dy:${(Math.sin(ang) * dist).toFixed(1)}px;` +
      `animation-delay:${Math.floor(Math.random() * 70)}ms`;
    layer.appendChild(s);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 700);
}

/* logged hours physically travel into the headline number */
function flyToHero(fromEl, text, color = "#f6cd6d") {
  const hero = $("#hero-num");
  if (reducedMotion || !fromEl || !hero) { pulseHero(); return; }
  const a = fromEl.getBoundingClientRect();
  const b = hero.getBoundingClientRect();
  const chip = document.createElement("div");
  chip.className = "fly-chip";
  chip.textContent = text;
  chip.style.color = color;
  chip.style.left = a.left + a.width / 2 + "px";
  chip.style.top = a.top + a.height / 2 + "px";
  document.body.appendChild(chip);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  requestAnimationFrame(() => {
    chip.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55)`;
    chip.style.opacity = "0";
  });
  setTimeout(() => { chip.remove(); pulseHero(); }, 460);
}

function pulseHero() {
  const el = $("#hero-num");
  if (!el) return;
  el.classList.remove("shimmer");
  void el.offsetWidth;
  el.classList.add("shimmer");
}

/* ---------- toasts ---------- */

function toast(html, ms = 3400, onAction = null, actionLabel = "Undo") {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="toast-text">${html}</span>`;
  if (onAction) {
    ms = Math.max(ms, 6000);
    const b = document.createElement("button");
    b.className = "toast-undo";
    b.textContent = actionLabel;
    b.addEventListener("click", () => { onAction(); el.remove(); });
    el.appendChild(b);
  }
  $("#toasts").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 320); }, ms);
}

/* ============================================================
   RENDER - header / hero metric
   ============================================================ */

/* zaehlt eine Stundenzahl weich auf den neuen Wert hoch, statt sie zu ersetzen */
function heroCount(el, from, to) {
  const setVal = (v) => { el.innerHTML = `${(v / 3600).toFixed(1)}<span class="hero-unit">h</span>`; };
  if (from === to || document.hidden) { setVal(to); return; }
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
  const t0 = performance.now();
  const tick = (t) => {
    const p = clamp((t - t0) / 600, 0, 1);
    setVal(from + (to - from) * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => setVal(to), 700); // final value even if frames are throttled
}

function renderHeader() {
  const now = Date.now();
  $("#top-date").textContent = new Date(now).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });

  const weeks = lastNWeeks(8);
  // a running timer on a quest task counts live - watch the number grow
  // the checkpointed part already sits in db.sessions - only add what is not saved yet
  const liveSec = ui.focus && ui.focus.segStart && taskById(ui.focus.taskId)?.questId
    ? (Date.now() - (ui.focus.checkpointEnd || ui.focus.segStart)) / 1000 : 0;
  const cur = weeks[weeks.length - 1].seconds + liveSec;
  const prev = weeks[weeks.length - 2].seconds;
  const rec = recordWeek();

  // der laufende Timer zaehlt auch fuer heute - "jetzt" liegt ja im heutigen Tag
  const ds = startOfDay(now);
  const curDay = questSecondsBetween(ds, ds + DAY) + liveSec;

  // animated count-up on change
  heroCount($("#hero-num"), ui.lastHeroSeconds ?? cur, cur);
  ui.lastHeroSeconds = cur;
  heroCount($("#hero-day-num"), ui.lastDaySeconds ?? curDay, curDay);
  ui.lastDaySeconds = curDay;

  const diff = cur - prev;
  const arrow = diff >= 0 ? `<span class="up">▲ ${fmtHours(Math.abs(diff))}</span>` : `<span class="down">▼ ${fmtHours(Math.abs(diff))}</span>`;
  const hasHistory = db.sessions.length > 0;
  $("#hero-meta").innerHTML = hasHistory
    ? `${arrow} vs ${fmtHours(prev)} last week<br>` +
      (rec ? `<span class="rec">record week ${fmtHours(rec.seconds)}</span>` : "")
    : `<span class="rec">No hours logged yet.<br>Start a focus session - this is where it shows.</span>`;

  // sparkline
  const w = 120, h = 34, pad = 3;
  const max = Math.max(...weeks.map((x) => x.seconds), cur, 1);
  const px = (i) => pad + (i * (w - 2 * pad)) / (weeks.length - 1);
  const py = (s) => h - pad - (s / max) * (h - 2 * pad);
  if (!db.sessions.length) { $("#hero-spark").innerHTML = ""; renderLiveChip(); renderStreakChip(); return; }
  const line = weeks.map((x, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(x.seconds).toFixed(1)}`).join(" ");
  const recIdx = weeks.findIndex((x) => rec && x.weekStart === rec.weekStart);
  $("#hero-spark").innerHTML =
    `<path d="${line}" fill="none" stroke="rgba(226,179,78,0.55)" stroke-width="1.5"/>` +
    (recIdx >= 0 ? `<circle cx="${px(recIdx)}" cy="${py(weeks[recIdx].seconds)}" r="2.4" fill="none" stroke="#a89d88" stroke-width="1"/>` : "") +
    `<circle cx="${px(weeks.length - 1)}" cy="${py(cur)}" r="2.8" fill="#f6cd6d"/>`;

  renderLiveChip();
  renderStreakChip();
  checkProgressEvents();
}

function renderStreakChip() {
  const chip = $("#streak-chip");
  if (!chip) return;
  const streak = questDayStreak();
  chip.classList.toggle("hidden", streak < 2);
  if (streak < 2) return;
  const best = bestQuestDayStreak();
  $(".streak-n", chip).textContent = streak;
  chip.classList.toggle("hot", streak >= 7);
  chip.classList.toggle("record", streak >= best && best > 1);
  chip.title = streak >= best
    ? `${streak} days in a row - your longest run yet`
    : `${streak} days in a row · best ${best}`;
}

/* persistent chip for a timer running in the background (Toggl-style) */
function renderLiveChip() {
  const chip = $("#live-chip");
  const f = ui.focus;
  const ov = $("#focus-overlay");
  const overlayVisible = !ov.classList.contains("hidden") && !ov.classList.contains("leaving");
  if (!f || !f.segStart || overlayVisible) { chip.classList.add("hidden"); return; }
  const t = taskById(f.taskId);
  const q = t ? questById(t.questId) : null;
  chip.classList.remove("hidden");
  chip.style.setProperty("--quest-color", q ? q.color : "#6f6656");
  $(".lc-title", chip).textContent = t ? t.title : "";
  $(".lc-time", chip).textContent = fmtTimer(focusElapsed());
}

/* ============================================================
   RENDER - sidebar habits
   ============================================================ */

function habitStreak(h) {
  const today = ymd(Date.now());
  let streak = 0;
  let d = h.checks[today] ? startOfDay(Date.now()) : startOfDay(Date.now()) - DAY;
  while (h.checks[ymd(d)]) { streak++; d -= DAY; }
  return streak;
}

function renderHabits() {
  const list = $("#habit-list");
  list.innerHTML = "";
  const today = ymd(Date.now());
  for (const h of db.habits) {
    const q = questById(h.questId);
    const row = document.createElement("div");
    row.className = "habit-row";
    if (q) row.style.setProperty("--habit-color", q.color);
    const done = !!h.checks[today];
    const streak = habitStreak(h);
    const risk = habitAtRisk(h);
    row.classList.toggle("at-risk", risk);
    row.innerHTML =
      `<button class="habit-check ${done ? "done" : ""} ${risk ? "risk" : ""}" aria-label="${done ? "Uncheck" : "Check"} habit ${esc(h.name)}" aria-pressed="${done}" title="${
        risk ? "Missed yesterday - today is non-negotiable" : q ? "Counts toward " + esc(q.name) : "Daily habit"
      }">✓</button>` +
      `<span class="habit-name">${esc(h.name)}</span>` +
      `<span class="habit-streak ${streak >= 7 ? "hot" : ""} ${risk ? "broken" : ""}">${
        risk ? "broken" : streak > 0 ? streak + "d" : ""
      }</span>`;
    $(".habit-check", row).addEventListener("click", (e) => {
      const btn = e.currentTarget;
      if (h.checks[today]) delete h.checks[today];
      else {
        h.checks[today] = true;
        const streak = habitStreak(h);
        const milestone = streak > 0 && (streak % 7 === 0 || streak === 30 || streak === 100);
        btn.classList.add("done", "pop");
        sparkBurst(btn, q ? q.color : "#e2b34e", milestone ? 20 : 9, milestone ? 74 : 34);
        milestone ? sfx.milestone() : sfx.check();
        toast(milestone
          ? `<span class="gold">${streak} days straight</span> - ${esc(h.name)}. Don't break it now.`
          : `<span>${esc(h.name)}</span> <span class="gold">${streak} day streak</span>`, milestone ? 3800 : 2200);
      }
      save(`Check “${h.name}”`);
      setTimeout(renderHabits, reducedMotion ? 0 : 170);
    });
    row.addEventListener("click", (e) => {
      if (e.target.closest(".habit-check")) return;
      openHabitPop(h, row);
    });
    list.appendChild(row);
  }
}

/* ---------- habit detail popover ---------- */

/* a broken chain makes today non-negotiable */
function habitAtRisk(h) {
  const today = ymd(Date.now());
  if (h.checks[today]) return false;
  return !h.checks[ymd(Date.now() - DAY)];
}

function bestHabitStreak(h) {
  const times = Object.keys(h.checks)
    .map((s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).getTime(); })
    .sort((a, b) => a - b);
  let best = 0, cur = 0, prev = null;
  for (const t of times) {
    cur = prev != null && Math.round((t - prev) / DAY) === 1 ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = t;
  }
  return best;
}

function closeHabitPop() { $(".habit-pop")?.remove(); }

function openHabitPop(h, anchor) {
  closeHabitPop();
  closeQuestMenu();
  const q = questById(h.questId);
  const now = Date.now();
  const todayS = startOfDay(now);
  const cur = habitStreak(h);
  const best = bestHabitStreak(h);
  const total = Object.keys(h.checks).length;
  let last30 = 0;
  for (let i = 0; i < 30; i++) if (h.checks[ymd(now - i * DAY)]) last30++;
  const rate = Math.round((last30 / 30) * 100);

  const atRisk = habitAtRisk(h);
  let dots = "";
  for (let wi = 7; wi >= 0; wi--) {
    const ws = startOfWeek(now) - wi * 7 * DAY;
    for (let d = 0; d < 7; d++) {
      const day = ws + d * DAY;
      const cls = day > todayS ? "future" : h.checks[ymd(day)] ? "on" : "off";
      const isToday = day === todayS;
      dots += `<span class="hp-dot ${cls}${isToday ? " today" : ""}${isToday && atRisk ? " urgent" : ""}" title="${ymd(day)}${
        cls === "off" ? " - missed" : cls === "on" ? " - done" : ""
      }"></span>`;
    }
  }

  const pop = document.createElement("div");
  pop.className = "habit-pop";
  if (q) pop.style.setProperty("--habit-color", q.color);
  pop.innerHTML = `
    <div class="hp-name">${esc(h.name)}</div>
    <div class="hp-quest">${q ? `<span class="dot"></span>counts toward ${esc(q.name)}` : `<span class="dot"></span>standalone habit - link a quest below`}</div>
    <div class="hp-stats">
      <div class="hp-stat"><b>${cur}</b><span>streak</span></div>
      <div class="hp-stat"><b>${best}</b><span>best</span></div>
      <div class="hp-stat"><b>${rate}%</b><span>30 days</span></div>
    </div>
    <div class="hp-grid-label">Last 8 weeks · ${total} check-ins all-time</div>
    <div class="hp-grid">${dots}</div>
    ${atRisk ? `<div class="hp-warn">Chain broken yesterday. Today is non-negotiable.</div>` : ""}
    <div class="hp-row">
      <select id="hp-quest-sel">
        <option value="">No quest</option>
        ${db.quests.filter((x) => !x.archived || x.id === h.questId).map((x) => `<option value="${x.id}" ${h.questId === x.id ? "selected" : ""}>${esc(x.name)}${x.archived ? " (archived)" : ""}</option>`).join("")}
      </select>
      <button class="hp-del" id="hp-del">Delete</button>
    </div>`;
  document.body.appendChild(pop);

  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(r.right + 10, innerWidth - pop.offsetWidth - 8) + "px";
  pop.style.top = clamp(r.top - 12, 8, innerHeight - pop.offsetHeight - 8) + "px";

  $("#hp-quest-sel", pop).addEventListener("change", (e) => {
    h.questId = e.target.value || null;
    save("Relink habit");
    renderHabits();
    const rows = $$("#habit-list .habit-row");
    openHabitPop(h, rows[db.habits.indexOf(h)] || anchor);
  });
  $("#hp-del", pop).addEventListener("click", () => {
    db.habits = db.habits.filter((x) => x.id !== h.id);
    save(`Delete habit “${h.name}”`);
    renderHabits();
    closeHabitPop();
    toast(`Habit deleted: ${esc(h.name)}`, 2400, undoLast);
  });

  const dismiss = (e) => {
    if (e.target.closest(".habit-pop")) return;
    document.removeEventListener("pointerdown", dismiss, true);
    closeHabitPop();
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
}

function setupHabitForm() {
  const form = $("#habit-form");
  const sel = $("#habit-quest-select");
  $("#habit-add-btn").addEventListener("click", () => {
    form.classList.toggle("hidden");
    if (!form.classList.contains("hidden")) {
      sel.innerHTML = `<option value="">No quest</option>` +
        db.quests.filter((q) => !q.archived).map((q) => `<option value="${q.id}">${esc(q.name)}</option>`).join("");
      $("#habit-name-input").focus();
    }
  });
  $("#habit-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const name = e.target.value.trim();
      if (!name) return;
      db.habits.push({ id: uid(), name, questId: sel.value || null, checks: {} });
      save(`Add habit “${name}”`);
      e.target.value = "";
      form.classList.add("hidden");
      renderHabits();
      toast(`Habit added: <span class="gold">${esc(name)}</span>`, 2000);
    }
    if (e.key === "Escape") form.classList.add("hidden");
  });
}

/* ============================================================
   RENDER - Today view
   ============================================================ */

function todayTasks() { return tasksFor(ymd(Date.now())); }

/* ---------- scheduling & repetition ---------- */

const REPEAT_LABEL = { daily: "daily", weekdays: "weekdays", weekly: "weekly" };

function repeatLabel(t) {
  if (!t.repeat) return "";
  if (t.repeat === "everyN") {
    const n = t.repeatN || 2;
    return t.repeatUnit === "w" ? `every ${n}w` : `every ${n}d`;
  }
  return REPEAT_LABEL[t.repeat] || "";
}

function dateFromYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).getTime(); }

function nextOccurrence(dateStr, rule, n = 2, unit = "d") {
  let t = dateFromYmd(dateStr);
  if (rule === "weekly") t += 7 * DAY;
  else if (rule === "weekdays") { do { t += DAY; } while ([0, 6].includes(new Date(t).getDay())); }
  else if (rule === "everyN") t += Math.max(1, n) * (unit === "w" ? 7 : 1) * DAY;
  else t += DAY;
  return ymd(t);
}

function shortDate(dateStr) {
  const today = ymd(Date.now());
  if (dateStr === today) return "today";
  if (dateStr === ymd(Date.now() + DAY)) return "tomorrow";
  return new Date(dateFromYmd(dateStr)).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function upcomingTasks() {
  const today = ymd(Date.now());
  return db.tasks.filter((t) => !t.done && t.date && t.date > today && isListed(t)).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* the backlog: written down, not yet given a day */
const somedayTasks = () => db.tasks.filter((t) => !t.done && !t.date && isListed(t)).sort((a, b) => a.order - b.order);

function openScheduleMenu(anchor, t) {
  closeQuestMenu();
  const menu = document.createElement("div");
  menu.className = "qmenu sched-menu";
  menu.id = "qmenu";
  const today = ymd(Date.now());
  const opts = [
    ["Today", today],
    ["Tomorrow", ymd(Date.now() + DAY)],
    ["In a week", ymd(Date.now() + 7 * DAY)],
    ["Someday", ""],
  ];
  menu.innerHTML =
    `<div class="qm-head">Scheduled for</div>` +
    opts.map(([lab, d]) => `<button data-d="${d}" class="${(t.date || "") === d ? "on" : ""}">${lab}${
      d ? `<span class="qm-hint">${shortDate(d)}</span>` : `<span class="qm-hint">no day</span>`}</button>`).join("") +
    `<label class="qm-date">Pick a date<input type="date" id="sched-date" value="${t.date}" min="${today}"/></label>` +
    `<div class="qm-head">Repeats</div>` +
    ["", "daily", "weekdays", "weekly"].map((r) =>
      `<button data-r="${r}" class="${(t.repeat || "") === r ? "on" : ""}">${r ? "↻ " + REPEAT_LABEL[r] : "Never"}</button>`).join("") +
    `<div class="qm-custom ${t.repeat === "everyN" ? "on" : ""}">
       <span>↻ every</span>
       <input type="number" id="rep-n" min="1" max="99" value="${t.repeatN || 2}"/>
       <select id="rep-unit">
         <option value="d" ${t.repeatUnit !== "w" ? "selected" : ""}>days</option>
         <option value="w" ${t.repeatUnit === "w" ? "selected" : ""}>weeks</option>
       </select>
       <button id="rep-set">Set</button>
     </div>`;
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  menu.style.left = clamp(r.left - 60, 8, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = (r.bottom + menu.offsetHeight + 8 > innerHeight ? r.top - menu.offsetHeight - 6 : r.bottom + 6) + "px";

  $$("button[data-d]", menu).forEach((b) =>
    b.addEventListener("click", () => {
      closeQuestMenu();
      t.date = b.dataset.d;
      save(`Schedule “${t.title}”`);
      renderAll();
      if (t.date !== today) toast(`Scheduled for <span class="gold">${shortDate(t.date)}</span> - it'll be waiting.`, 2800);
    })
  );
  $("#sched-date", menu).addEventListener("change", (e) => {
    if (!e.target.value) return;
    closeQuestMenu();
    t.date = e.target.value;
    save(`Schedule “${t.title}”`);
    renderAll();
    toast(`Scheduled for <span class="gold">${shortDate(t.date)}</span>.`, 2800);
  });
  $$("button[data-r]", menu).forEach((b) =>
    b.addEventListener("click", () => {
      closeQuestMenu();
      t.repeat = b.dataset.r || null;
      save(t.repeat ? `Repeat “${t.title}”` : "Stop repeating");
      renderAll();
      if (t.repeat) toast(`Repeats <span class="gold">${repeatLabel(t)}</span> - a new one appears each time you finish.`, 3400);
    })
  );
  const applyCustom = () => {
    const n = clamp(parseInt($("#rep-n", menu).value, 10) || 2, 1, 99);
    t.repeat = "everyN";
    t.repeatN = n;
    t.repeatUnit = $("#rep-unit", menu).value;
    closeQuestMenu();
    save(`Repeat “${t.title}”`);
    renderAll();
    toast(`Repeats <span class="gold">${repeatLabel(t)}</span> - a new one appears each time you finish.`, 3400);
  };
  $("#rep-set", menu).addEventListener("click", applyCustom);
  $("#rep-n", menu).addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustom(); });
  setTimeout(() => document.addEventListener("pointerdown", qmenuDismiss, { once: true }), 0);
}

function doneDayLabel(dateStr) {
  if (!dateStr) return "Someday";
  const today = ymd(Date.now());
  const yest = ymd(Date.now() - DAY);
  if (dateStr === today) return "Today";
  if (dateStr === yest) return "Yesterday";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function renderToday() {
  const view = $("#view");
  const tasks = todayTasks();
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const allDone = db.tasks
    .filter((t) => t.done)
    .sort((a, b) => (a.date === b.date ? a.order - b.order : (a.date < b.date ? 1 : -1)));
  const upcoming = upcomingTasks();
  const someday = somedayTasks();
  const upcomingDayCount = new Set(upcoming.map((t) => t.date)).size;

  view.innerHTML = `
    <div class="view-inner">
      <h2 class="view-title">Today</h2>
      <div class="view-sub">Ordered by intent, not by hour. Drag to reprioritise.</div>
      <div id="week-goals"></div>
      <div id="quick-add" class="card">
        <span class="plus">＋</span>
        <input id="quick-add-input" type="text" placeholder="Add a task - press Enter, keep typing…" autocomplete="off"/>
        <span class="qa-hint"><span class="kbd">N</span> jump here</span>
      </div>
      <div class="task-list" id="open-list"></div>
      ${upcoming.length ? `
        <button class="list-label done-toggle ${ui.upcomingExpanded ? "open" : ""}" id="upcoming-toggle">
          <span class="dt-chev">▸</span>
          <span>Upcoming - ${upcoming.length} over ${upcomingDayCount} day${upcomingDayCount === 1 ? "" : "s"}</span>
          <span class="dt-hint">${ui.upcomingExpanded
            ? "drag a task onto another day - or up into today"
            : "everything you've pushed ahead"}</span>
        </button>
        <div id="upcoming-list"></div>` : ""}
      <button class="list-label done-toggle ${ui.somedayExpanded ? "open" : ""}" id="someday-toggle">
        <span class="dt-chev">▸</span>
        <span>Someday${someday.length ? ` - ${someday.length}` : ""}</span>
        <span class="dt-hint">${ui.somedayExpanded
          ? "give one a day and it moves into that day's list"
          : "catch things here, decide the day later"}</span>
      </button>
      <div id="someday-box"></div>
      ${done.length || ui.doneExpanded ? `
        <button class="list-label done-toggle ${ui.doneExpanded ? "open" : ""}" id="done-toggle">
          <span class="dt-chev">▸</span>
          <span>Done - ${ui.doneExpanded ? `${allDone.length} all time` : done.length}</span>
          <span class="dt-hint">${ui.doneExpanded ? "click to show today only" : "click to see everything you've finished"}</span>
        </button>
        <div class="task-list" id="done-list"></div>` : ""}
      <div class="record-card card" id="record-card"></div>
    </div>`;

  const openList = $("#open-list");
  if (!open.length) openList.innerHTML = `<div class="empty-note">Nothing planned. Add a task above - or steal one from a quest.</div>`;
  for (const t of open) openList.appendChild(taskRow(t));

  const upList = $("#upcoming-list");
  if (upList) {
    if (ui.upcomingExpanded) renderAgenda(upList, upcoming);
    $("#upcoming-toggle").addEventListener("click", () => {
      ui.upcomingExpanded = !ui.upcomingExpanded;
      db.settings = db.settings || {};
      db.settings.showUpcoming = ui.upcomingExpanded; // stays how you left it
      saveQuiet();
      ui.animateList = true;
      renderToday();
    });
  }

  const somedayBox = $("#someday-box");
  if (somedayBox) {
    if (ui.somedayExpanded) renderSomeday(somedayBox, someday);
    $("#someday-toggle").addEventListener("click", () => {
      // deliberately not persisted: Someday should be closed again next time
      ui.somedayExpanded = !ui.somedayExpanded;
      ui.animateList = true;
      renderToday();
    });
  }

  const doneList = $("#done-list");
  if (doneList) {
    if (!ui.doneExpanded) {
      for (const t of done) doneList.appendChild(taskRow(t));
    } else {
      // the whole ledger of finished work, newest day first
      let lastDate = null;
      for (const t of allDone) {
        if (t.date !== lastDate) {
          lastDate = t.date;
          const h = document.createElement("div");
          h.className = "done-day";
          h.textContent = doneDayLabel(t.date);
          doneList.appendChild(h);
        }
        doneList.appendChild(taskRow(t));
      }
      if (!allDone.length) doneList.innerHTML = `<div class="empty-note">Nothing finished yet. That changes today.</div>`;
    }
    $("#done-toggle").addEventListener("click", () => {
      ui.doneExpanded = !ui.doneExpanded;
      ui.animateList = true;
      renderToday();
    });
  }

  // rows rise into place when you arrive at the view, not on every keystroke
  const fresh = ui.animateList;
  ui.animateList = false;
  if (fresh && !reducedMotion) {
    $$(".task-row", view).forEach((r, i) => {
      r.classList.add("rise");
      r.style.animationDelay = Math.min(i * 14, 150) + "ms";
    });
  }

  renderWeekGoals();
  setupQuickAdd();
  setupReorder(openList);
  renderRecordCard(fresh);
}



/* Someday: write it down now, decide the day later */
function renderSomeday(host, list) {
  const bucket = ui.somedayBucket || "someday";
  const pickedDate = ui.somedayDate || ymd(Date.now() + 2 * DAY);
  host.innerHTML = `
    <div class="card someday-add">
      <span class="plus">+</span>
      <input type="text" id="someday-input" placeholder="Something for later..." autocomplete="off"
             aria-label="Add to someday"/>
      <div class="pill-toggle someday-bucket" id="someday-bucket">
        <button type="button" data-b="someday" class="${bucket === "someday" ? "on" : ""}">someday</button>
        <button type="button" data-b="tomorrow" class="${bucket === "tomorrow" ? "on" : ""}">tomorrow</button>
        <button type="button" data-b="date" class="${bucket === "date" ? "on" : ""}">${
          bucket === "date" ? esc(shortDate(pickedDate)) : "on a date"}</button>
      </div>
      <input type="date" id="someday-date" class="someday-date ${bucket === "date" ? "" : "hidden"}"
             value="${pickedDate}" min="${ymd(Date.now())}" aria-label="Pick the day"/>
    </div>
    <div class="task-list" id="someday-list"></div>`;

  const listEl = $("#someday-list", host);
  if (!list.length) {
    listEl.innerHTML = `<div class="empty-note">Nothing parked. Anything that is not for today belongs here.</div>`;
  }
  for (const t of list) listEl.appendChild(taskRow(t));

  $$("#someday-bucket button", host).forEach((b) =>
    b.addEventListener("click", () => {
      ui.somedayBucket = b.dataset.b;
      if (b.dataset.b === "date" && !ui.somedayDate) ui.somedayDate = pickedDate;
      renderSomeday(host, list);
      // showPicker needs an active user gesture and throws without one
      if (ui.somedayBucket === "date") {
        try { $("#someday-date")?.showPicker?.(); } catch (err) { /* the field is visible anyway */ }
      }
      $("#someday-input")?.focus();
    })
  );
  $("#someday-date", host)?.addEventListener("change", (e) => {
    if (!e.target.value) return;
    ui.somedayDate = e.target.value;
    ui.somedayBucket = "date";
    renderSomeday(host, list);
    $("#someday-input")?.focus();
  });

  $("#someday-input", host).addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const title = e.target.value.trim();
    if (!title) return;
    const b = ui.somedayBucket || "someday";
    const date = b === "tomorrow" ? ymd(Date.now() + DAY)
               : b === "date" ? (ui.somedayDate || ymd(Date.now() + DAY))
               : null;
    const maxOrder = db.tasks.length ? Math.max(...db.tasks.map((x) => x.order || 0)) : 0;
    db.tasks.push({ id: uid(), title, questId: null, kind: "work", done: false, order: maxOrder + 1, date });
    save(`Add "${title}"`);
    sfx.tap();
    renderToday();
    $("#someday-input")?.focus();
    if (date) toast(`<span class="gold">${esc(title)}</span> waits for ${esc(shortDate(date))}.`, 2400);
  });
}

/* the three goals set during the last review, living in Today */
function renderWeekGoals() {
  const host = $("#week-goals");
  if (!host) return;
  const ws = startOfWeek(Date.now());
  const goals = goalsForWeek(ws);
  const hit = goals.filter((g) => g.done).length;

  host.innerHTML = `
    <div class="card wg-card">
      <div class="wg-head">
        <span class="wg-title">This week's goals</span>
        ${goals.length ? `<span class="wg-score">${hit} of ${goals.length}</span>` : ""}
      </div>
      <div class="wg-list">
        ${goals.length ? goals.map((g) => {
          const q = questById(g.questId);
          return `<div class="wg-item ${g.done ? "done" : ""}" data-g="${g.id}"
                    style="--quest-color:${q ? q.color : "#6f6656"}">
            <button class="wg-check" title="${g.done ? "Not reached after all" : "Reached"}"
                    aria-label="Toggle goal">${g.done ? "✓" : ""}</button>
            <span class="wg-text" title="Click to edit">${esc(g.text)}</span>
            <button class="wg-quest-btn ${q ? "" : "none"}" title="Link to a quest">
              <span class="dot"></span>${q ? esc(q.name) : "no quest"}
            </button>
            <button class="wg-del" title="Remove goal" aria-label="Remove goal">x</button>
          </div>`;
        }).join("") : `<div class="empty-note wg-empty">No goals for this week yet. Name up to three.</div>`}
      </div>
      ${goals.length < 3 ? `
        <form class="wg-add" id="wg-add">
          <span class="plus">+</span>
          <input type="text" id="wg-input" maxlength="120"
                 placeholder="${goals.length ? "One more goal for this week..." : "What would make this a good week?"}"
                 autocomplete="off"/>
        </form>` : ""}
    </div>`;

  $$(".wg-item", host).forEach((row) => {
    const g = db.weekGoals.find((x) => x.id === row.dataset.g);
    if (!g) return;
    $(".wg-check", row).addEventListener("click", (e) => {
      g.done = !g.done;
      save(g.done ? "Reach weekly goal" : "Reopen weekly goal");
      if (g.done) { sfx.complete(); sparkBurst(e.currentTarget, questById(g.questId)?.color || "#e2b34e", 12, 48); }
      renderWeekGoals();
    });
    $(".wg-text", row).addEventListener("click", () => startGoalEdit(g, row));
    $(".wg-quest-btn", row).addEventListener("click", (e) =>
      openQuestMenu(e.currentTarget, (questId) => {
        g.questId = questId;
        save("Link goal to quest");
        renderWeekGoals();
      })
    );
    $(".wg-del", row).addEventListener("click", () => {
      db.weekGoals = db.weekGoals.filter((x) => x.id !== g.id);
      save("Remove weekly goal");
      renderWeekGoals();
      toast("Goal removed.", 2600, undoLast);
    });
  });

  $("#wg-add", host)?.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#wg-input").value.trim();
    if (!text) return;
    db.weekGoals.push({ id: uid(), weekStart: ws, text, questId: null, done: false });
    save("Add weekly goal");
    sfx.check();
    renderWeekGoals();
    $("#wg-input")?.focus();
  });
}

function startGoalEdit(g, row) {
  const textEl = $(".wg-text", row);
  if (!textEl || $(".wg-edit", row)) return;
  const input = document.createElement("input");
  input.className = "wg-edit";
  input.value = g.text;
  input.maxLength = 120;
  textEl.replaceWith(input);
  input.focus();
  input.select();
  let closed = false;
  const commit = (keep) => {
    if (closed) return;
    closed = true;
    const v = input.value.trim();
    if (keep && v && v !== g.text) { g.text = v; save("Edit weekly goal"); }
    renderWeekGoals();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

/* ---------- agenda: everything pushed ahead, and a way to move it ---------- */

function renderAgenda(container, upcoming) {
  const byDate = new Map();
  for (const t of upcoming) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  for (const [date, tasks] of byDate) {
    const away = Math.round((dateFromYmd(date) - startOfDay(Date.now())) / DAY);
    const questCount = tasks.filter((t) => t.questId).length;
    const day = document.createElement("div");
    day.className = "agenda-day";
    day.dataset.date = date;
    day.innerHTML = `
      <div class="ad-head">
        <span class="ad-label">${doneDayLabel(date)}</span>
        <span class="ad-away">in ${away} day${away === 1 ? "" : "s"}</span>
        <span class="ad-count">${tasks.length} task${tasks.length === 1 ? "" : "s"}${
          questCount ? ` · ${questCount} on quests` : ""}</span>
        <button class="ad-move" title="Reschedule this whole day">move all →</button>
      </div>
      <div class="ad-list"></div>`;
    const list = $(".ad-list", day);
    for (const t of tasks) list.appendChild(agendaRow(t));
    $(".ad-move", day).addEventListener("click", (e) => openDayMoveMenu(e.currentTarget, date, tasks));
    container.appendChild(day);
  }
  setupAgendaDrag(container);
}

function agendaRow(t) {
  const row = taskRow(t);
  const pull = document.createElement("button");
  pull.className = "ad-pull";
  pull.title = "Pull into today";
  pull.setAttribute("aria-label", `Move to today: ${t.title}`);
  pull.textContent = "↑";
  pull.addEventListener("click", (e) => {
    e.stopPropagation();
    moveTasksTo([t], ymd(Date.now()));
  });
  row.insertBefore(pull, $(".task-sched", row));
  return row;
}

function moveTasksTo(tasks, date) {
  if (!tasks.length) return;
  for (const t of tasks) t.date = date;
  const label = tasks.length === 1 ? `Reschedule “${tasks[0].title}”` : `Reschedule ${tasks.length} tasks`;
  save(label);
  renderAll();
  const where = date === ymd(Date.now()) ? "today's list" : shortDate(date);
  toast(tasks.length === 1
    ? `<span class="gold">${esc(tasks[0].title)}</span> → ${esc(where)}`
    : `${tasks.length} tasks → <span class="gold">${esc(where)}</span>`, 3000, undoLast);
}

function openDayMoveMenu(anchor, date, tasks) {
  closeQuestMenu();
  const base = dateFromYmd(date);
  const today = ymd(Date.now());
  const opts = [
    ["Today", today],
    ["Tomorrow", ymd(Date.now() + DAY)],
    ["A day later", ymd(base + DAY)],
    ["A week later", ymd(base + 7 * DAY)],
  ];
  const menu = document.createElement("div");
  menu.className = "qmenu sched-menu";
  menu.id = "qmenu";
  menu.innerHTML =
    `<div class="qm-head">Move all ${tasks.length} to</div>` +
    opts.map(([l, d]) => `<button data-d="${d}">${l}<span class="qm-hint">${shortDate(d)}</span></button>`).join("") +
    `<label class="qm-date">Pick a date<input type="date" id="day-move-date" value="${date}" min="${today}"/></label>`;
  document.body.appendChild(menu);

  const r = anchor.getBoundingClientRect();
  menu.style.left = clamp(r.right - menu.offsetWidth, 8, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = (r.bottom + menu.offsetHeight + 8 > innerHeight ? r.top - menu.offsetHeight - 6 : r.bottom + 6) + "px";

  $$("button[data-d]", menu).forEach((b) =>
    b.addEventListener("click", () => { closeQuestMenu(); moveTasksTo(tasks, b.dataset.d); })
  );
  $("#day-move-date", menu).addEventListener("change", (e) => {
    if (!e.target.value) return;
    closeQuestMenu();
    moveTasksTo(tasks, e.target.value);
  });
  setTimeout(() => document.addEventListener("pointerdown", qmenuDismiss, { once: true }), 0);
}

/* drag a task onto another day - or up into today */
function setupAgendaDrag(container) {
  let drag = null;   // { row, float, dx, dy, px, py, timer }

  const clearTargets = () =>
    $$(".agenda-day.drop-target, #open-list.drop-target").forEach((el) => el.classList.remove("drop-target"));

  const targetAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return el.closest(".agenda-day") || el.closest("#open-list");
  };

  // follow the pointer, highlight what's under it
  const paint = () => {
    if (!drag) return;
    drag.float.style.left = drag.px - drag.dx + "px";
    drag.float.style.top = drag.py - drag.dy + "px";
    clearTargets();
    const hit = targetAt(drag.px, drag.py);
    if (hit) hit.classList.add("drop-target");
  };

  // days below the fold must stay reachable: scroll while held near an edge
  const EDGE = 80, SPEED = 13;
  const autoScroll = () => {
    if (!drag) return;
    const view = $("#view");
    if (!view) return;
    const r = view.getBoundingClientRect();
    let d = 0;
    if (drag.py < r.top + EDGE) d = -SPEED * ((r.top + EDGE - drag.py) / EDGE);
    else if (drag.py > r.bottom - EDGE) d = SPEED * ((drag.py - (r.bottom - EDGE)) / EDGE);
    if (d) { view.scrollTop += d; paint(); }
  };

  const end = () => {
    clearInterval(drag.timer);
    clearTargets();
    drag.float.remove();
    drag.row.classList.remove("dragging-ghost");
    drag = null;
  };

  dragGesture(container, {
    pick: (e) => !e.target.closest("button, input, select") && e.target.closest(".task-row"),
    start: (row, x, y) => {
      const r = row.getBoundingClientRect();
      const float = row.cloneNode(true);
      float.classList.add("drag-float");
      float.style.width = r.width + "px";
      document.body.appendChild(float);
      row.classList.add("dragging-ghost");
      drag = { row, float, dx: x - r.left, dy: y - r.top, px: x, py: y, timer: setInterval(autoScroll, 16) };
      paint();
    },
    move: (row, x, y) => { drag.px = x; drag.py = y; paint(); },
    drop: (row, x, y) => {
      end();
      const hit = targetAt(x, y);
      const t = taskById(row.dataset.id);
      if (!hit || !t) { renderToday(); return; }
      const date = hit.id === "open-list" ? ymd(Date.now()) : hit.dataset.date;
      if (date === t.date) { renderToday(); return; }
      moveTasksTo([t], date);
    },
    abort: () => { end(); renderToday(); },
  });
}

function taskRow(t) {
  const q = questById(t.questId);
  const row = document.createElement("div");
  row.className = `task-row ${q ? "" : "no-quest"} ${t.done ? "done-row" : ""} ` +
    `${ui.selectedTaskId === t.id ? "selected" : ""} ${ui.justCompleted === t.id ? "landed" : ""}`;
  row.dataset.id = t.id;
  if (q) row.style.setProperty("--quest-color", q.color);
  const logged = taskLoggedSeconds(t.id);
  const blockIdx = todayBlocks().findIndex((b) => (b.taskIds || []).includes(t.id));
  row.innerHTML = `
    <button class="task-check ${t.done ? "done" : ""}" title="Mark done" aria-label="${t.done ? "Mark as not done" : "Mark done"}: ${esc(t.title)}" aria-pressed="${t.done}">✓</button>
    <div class="task-body">
      <span class="task-title">${esc(t.title)}</span>
      ${logged >= 60 ? `<span class="task-time has">${fmtHours(logged)}</span>` : ""}
    </div>
    ${blockIdx >= 0 ? `<span class="block-chip" title="Planned in Focus ${ROMAN[blockIdx]}">◱ ${ROMAN[blockIdx]}</span>` : ""}
    <button class="task-sched ${t.repeat || !t.date || t.date > ymd(Date.now()) ? "set" : ""}" title="Schedule / repeat" aria-label="Schedule or repeat: ${esc(t.title)}">
      ${t.repeat ? `↻ ${repeatLabel(t)}` : !t.date ? "someday" : t.date > ymd(Date.now()) ? shortDate(t.date) : "◷"}
    </button>
    <button class="quest-tag ${q ? "" : "none"}" title="Link to a quest" aria-label="Quest: ${q ? esc(q.name) : "none"}. Change">
      ${q ? `<span class="dot"></span>${esc(q.name)}` : "no quest"}
    </button>
    <button class="kind-toggle ${t.kind === "personal" ? "personal" : ""}" title="Work / personal" aria-label="Marked ${t.kind}. Toggle work or personal">${t.kind === "personal" ? "PERS" : "WORK"}</button>
    <button class="task-del" title="Delete task (⌫)" aria-label="Delete task: ${esc(t.title)}">✕</button>
    ${t.done ? "" : `<button class="task-focus-btn ${ui.focus?.taskId === t.id && ui.focus.segStart ? "rec" : ""}" title="Focus (F)" aria-label="Start focus on: ${esc(t.title)}">${ui.focus?.taskId === t.id && ui.focus.segStart ? "◉" : "▶"}</button>`}
  `;

  $(".task-check", row).addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDone(t.id, $(".task-check", row));
  });
  $(".quest-tag", row).addEventListener("click", (e) => {
    e.stopPropagation();
    openQuestMenu(e.currentTarget, (questId) => {
      t.questId = questId;
      if (t.metricId && !metricsFor(questId).some((m) => m.id === t.metricId)) t.metricId = null;
      save("Link quest"); renderAll();
    }, true, t);
  });
  $(".kind-toggle", row).addEventListener("click", (e) => {
    e.stopPropagation();
    t.kind = t.kind === "personal" ? "work" : "personal";
    save("Toggle work/personal"); renderToday();
  });
  const fbtn = $(".task-focus-btn", row);
  if (fbtn) fbtn.addEventListener("click", (e) => { e.stopPropagation(); enterFocus(t.id); });
  $(".task-sched", row).addEventListener("click", (e) => { e.stopPropagation(); openScheduleMenu(e.currentTarget, t); });
  $(".task-del", row).addEventListener("click", (e) => { e.stopPropagation(); deleteTask(t.id); });
  $(".task-title", row).addEventListener("dblclick", (e) => { e.stopPropagation(); startRename(t.id, row); });
  row.addEventListener("click", () => { ui.selectedTaskId = t.id; refreshSelection(); });
  return row;
}

function deleteTask(id) {
  const t = taskById(id);
  if (!t) return;
  if (ui.focus?.taskId === id) {
    if (ui.focus.segStart) commitFocusSegment();
    ui.focus = null;
    stopFocusTicker();
  }
  db.tasks = db.tasks.filter((x) => x.id !== id);
  for (const b of db.blocks || []) if (b.taskIds) b.taskIds = b.taskIds.filter((x) => x !== id);
  if (ui.selectedTaskId === id) ui.selectedTaskId = null;
  save(`Delete “${t.title}”`); renderAll();
  toast(`Deleted: ${esc(t.title)}`, 3400, undoLast);
}

function startRename(taskId, row) {
  const t = taskById(taskId);
  const titleEl = $(".task-title", row);
  if (!t || !titleEl || $(".title-edit", row)) return;
  const input = document.createElement("input");
  input.className = "title-edit";
  input.value = t.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let closed = false;
  const commit = () => {
    if (closed) return;
    closed = true;
    const v = input.value.trim();
    if (v && v !== t.title) { t.title = v; save("Rename task"); }
    renderAll();
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") commit();
    else if (ev.key === "Escape") { closed = true; renderAll(); }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("pointerdown", (ev) => ev.stopPropagation());
}

function refreshSelection() {
  $$(".task-row").forEach((r) => r.classList.toggle("selected", r.dataset.id === ui.selectedTaskId));
}

function toggleDone(taskId, checkEl) {
  const t = taskById(taskId);
  t.done = !t.done;
  if (t.metricId) bumpMetric(t.metricId, t.done ? 1 : -1);
  save(t.done ? `Complete “${t.title}”` : `Reopen “${t.title}”`);

  if (!t.done || !checkEl) { renderAll(); return; }

  const q = questById(t.questId);
  const color = q ? q.color : "#a89d88";
  const row = checkEl.closest(".task-row");
  const logged = taskLoggedSeconds(t.id);

  // a repeating task immediately queues its next appearance
  if (t.repeat) {
    const nextDate = nextOccurrence(t.date, t.repeat, t.repeatN, t.repeatUnit);
    db.tasks.push({
      id: uid(), title: t.title, questId: t.questId, kind: t.kind,
      done: false, order: t.order, date: nextDate,
      repeat: t.repeat, repeatN: t.repeatN, repeatUnit: t.repeatUnit,
    });
    t.repeat = null; // the finished instance stops carrying the rule
    save(`Complete “${t.title}”`);
    setTimeout(() => toast(`Next one waits on <span class="gold">${shortDate(nextDate)}</span>.`, 3000), 600);
  }

  checkEl.classList.add("done", "flash");
  row?.classList.add("completing");
  sparkBurst(checkEl, color, q ? 14 : 8, q ? 58 : 38);
  q ? sfx.complete() : sfx.check();

  // quest work sends its hours up to the headline number
  if (q && logged >= 60) setTimeout(() => flyToHero(row, `+${fmtHours(logged)}`, color), 110);

  ui.justCompleted = t.id;
  setTimeout(() => { renderAll(); setTimeout(() => { ui.justCompleted = null; }, 420); }, reducedMotion ? 0 : 300);

  toast(q
    ? `<span>Done:</span> <span class="gold">${esc(t.title)}</span>`
    : `Done: ${esc(t.title)}`, 2400);
}

function setupQuickAdd() {
  const input = $("#quick-add-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const title = input.value.trim();
      if (!title) return;
      const open = todayTasks().filter((t) => !t.done);
      const maxOrder = open.length ? Math.max(...open.map((t) => t.order)) : 0;
      db.tasks.push({ id: uid(), title, questId: null, kind: "work", done: false, order: maxOrder + 1, date: ymd(Date.now()) });
      save(`Add “${title}”`);
      renderToday();
      const ni = $("#quick-add-input");
      ni.focus();
    }
    if (e.key === "Escape") input.blur();
  });
}

/* quest picker menu, reused everywhere */
function openQuestMenu(anchor, onPick, allowNone = true, task = null) {
  closeQuestMenu();
  const menu = document.createElement("div");
  menu.className = "qmenu";
  menu.id = "qmenu";
  let html = "";
  for (const q of db.quests.filter((x) => !x.archived)) {
    html += `<button data-q="${q.id}"><span class="dot" style="background:${q.color}"></span>${esc(q.name)}</button>`;
  }
  if (allowNone) html += `<button data-q=""><span class="dot" style="background:#6f6656"></span>No quest</button>`;

  // a task on a quest with counters can feed one of them when it is finished
  const counters = task && task.questId
    ? metricsFor(task.questId).filter((m) => m.kind === "count") : [];
  if (counters.length) {
    html += `<div class="qm-head">Counts toward</div>`;
    html += counters.map((m) =>
      `<button data-m="${m.id}" class="${task.metricId === m.id ? "on" : ""}">◇ ${esc(m.name)}</button>`).join("");
    html += `<button data-m="" class="${task.metricId ? "" : "on"}">◇ nothing</button>`;
  }
  menu.innerHTML = html;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = clamp(r.left, 8, innerWidth - mw - 8) + "px";
  menu.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 6 : r.bottom + 6) + "px";
  $$("button", menu).forEach((b) =>
    b.addEventListener("click", () => {
      closeQuestMenu();
      if (b.dataset.m !== undefined) {
        if (task) { task.metricId = b.dataset.m || null; save("Link task to metric"); renderAll(); }
        return;
      }
      onPick(b.dataset.q || null);
    })
  );
  setTimeout(() => document.addEventListener("pointerdown", qmenuDismiss, { once: true }), 0);
}
function qmenuDismiss(e) { if (!e.target.closest("#qmenu")) closeQuestMenu(); }
function closeQuestMenu() { const m = $("#qmenu"); if (m) m.remove(); }

/* ---------- drag to reorder (pointer-based) ---------- */

/* One rule for every drag in the app. Mouse: a drag starts once the pointer has moved a
   few pixels. Touch: only after a still long-press - a swipe must stay a scroll, a tap a
   tap. If the browser takes the gesture over (pointercancel), the drag is undone and never
   committed: scrolling a list must not move a task. Listeners live on `el`, so they go
   when a render replaces it. */
const DRAG_LONG_PRESS = 380, DRAG_TOUCH_SLOP = 8, DRAG_MOUSE_SLOP = 5;

function dragGesture(el, { pick, start, move, drop, abort, tap }) {
  let g = null;   // { id, x, y, touch, active, timer, data }
  const reset = () => { if (g) clearTimeout(g.timer); g = null; };
  const activate = () => {
    g.active = true;
    clearTimeout(g.timer);
    try { el.setPointerCapture(g.id); } catch (err) { /* not all pointers can be captured */ }
    if (g.touch) navigator.vibrate?.(8);
    start(g.data, g.x, g.y);
  };
  // while a touch drag runs, the page must not scroll underneath it
  el.addEventListener("touchmove", (e) => { if (g?.active) e.preventDefault(); }, { passive: false });
  el.addEventListener("contextmenu", (e) => { if (g) e.preventDefault(); });

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || g) return;
    const data = pick(e);
    if (!data) return;
    const touch = e.pointerType !== "mouse";
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, touch, active: false, data };
    if (touch) g.timer = setTimeout(() => { if (g && !g.active) activate(); }, DRAG_LONG_PRESS);
    else e.preventDefault();   // no text selection while dragging with a mouse
  });
  el.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.id) return;
    if (!g.active) {
      const d = Math.hypot(e.clientX - g.x, e.clientY - g.y);
      if (g.touch) { if (d > DRAG_TOUCH_SLOP) reset(); return; }   // a swipe: the browser scrolls
      if (d < DRAG_MOUSE_SLOP) return;
      activate();
    }
    move(g.data, e.clientX, e.clientY);
  });
  el.addEventListener("pointerup", (e) => {
    if (!g || e.pointerId !== g.id) return;
    const s = g;
    reset();
    if (s.active) drop(s.data, e.clientX, e.clientY);
    else tap?.(s.data);
  });
  el.addEventListener("pointercancel", (e) => {
    if (!g || e.pointerId !== g.id) return;
    const s = g;
    reset();
    if (s.active) abort(s.data);
  });
}

function setupReorder(list) {
  let st = null;   // { float, offsetY }
  dragGesture(list, {
    pick: (e) => !e.target.closest("button, input") && e.target.closest(".task-row"),
    start: (row, x, y) => {
      const r = row.getBoundingClientRect();
      const float = row.cloneNode(true);
      float.classList.add("drag-float");
      float.style.width = r.width + "px";
      float.style.left = r.left + "px";
      float.style.top = r.top + "px";
      document.body.appendChild(float);
      row.classList.add("dragging-ghost");
      st = { float, offsetY: y - r.top };
    },
    move: (row, x, y) => {
      st.float.style.top = y - st.offsetY + "px";
      const before = $$(".task-row", list).filter((r) => r !== row)
        .find((sib) => { const r = sib.getBoundingClientRect(); return y < r.top + r.height / 2; });
      if (before) list.insertBefore(row, before);
      else list.appendChild(row);
    },
    drop: (row) => {
      st.float.remove();
      st = null;
      row.classList.remove("dragging-ghost");
      $$(".task-row", list).forEach((r, i) => { const t = taskById(r.dataset.id); if (t) t.order = i + 1; });
      save("Reorder tasks");
    },
    abort: () => { st.float.remove(); st = null; renderToday(); },   // every row back where it was
  });
}

/* ---------- record chart (You vs. Record-Self, AnkiLock style) ---------- */

function renderRecordCard(draw = false) {
  const card = $("#record-card");
  if (!card) return;
  const scope = ui.recordScope;
  const now = Date.now();

  let bannerHTML, chartHTML, legendHTML;

  if (scope === "week") {
    const ws = startOfWeek(now);
    const rec = recordWeek();
    const curCurve = weekCurve(ws, now);
    const you = curCurve[curCurve.length - 1];
    let recByNow = 0, recCurve = [];
    if (rec) {
      recCurve = weekCurve(rec.weekStart);
      recByNow = questSecondsBetween(rec.weekStart, rec.weekStart + (now - ws));
    }
    const delta = you - recByNow;
    bannerHTML = rec
      ? deltaBanner(delta, `your record week's pace`)
      : `<div class="delta-banner"><span class="rec">No history yet - set the first record.</span></div>`;
    chartHTML = weekChartSVG(curCurve, recCurve, now - ws);
    legendHTML = `
      <div class="li"><span class="swatch" style="background:#e2b34e"></span>this week (cumulative)</div>
      <div class="li"><span class="swatch" style="background:repeating-linear-gradient(90deg,#a89d88 0 4px,transparent 4px 7px)"></span>record week ${rec ? "· " + fmtHours(rec.seconds) : ""}</div>`;
  } else {
    const ds = startOfDay(now);
    const rec = recordDay();
    const you = questSecondsBetween(ds, ds + DAY);
    const timeOfDay = now - ds;
    let recTotal = 0, recByNow = 0, recLabel = "";
    if (rec) {
      recTotal = rec.seconds;
      recByNow = questSecondsBetween(rec.dayStart, rec.dayStart + timeOfDay);
      recLabel = fmtDayLabel(rec.dayStart);
    }
    const delta = you - recByNow;
    bannerHTML = rec
      ? deltaBanner(delta, `your best day's pace`)
      : `<div class="delta-banner"><span class="rec">No history yet - set the first record.</span></div>`;
    chartHTML = dayChartSVG(you, recTotal, recByNow, recLabel);
    legendHTML = `
      <div class="li"><span class="swatch" style="background:#e2b34e"></span>today</div>
      <div class="li"><span class="swatch" style="background:#a89d88"></span>best day, by this hour</div>
      <div class="li"><span class="swatch" style="background:rgba(168,157,136,0.25)"></span>best day, rest</div>`;
  }

  card.innerHTML = `
    <div class="record-head">
      <div class="record-title">You vs. record-self</div>
      <div class="seg" id="record-seg">
        <button data-s="day" class="${scope === "day" ? "on" : ""}">Day</button>
        <button data-s="week" class="${scope === "week" ? "on" : ""}">Week</button>
      </div>
    </div>
    ${bannerHTML}
    <div class="record-chart ${draw && !reducedMotion ? "drawing" : ""}">${chartHTML}</div>
    <div class="chart-legend">${legendHTML}</div>`;

  $$("#record-seg button").forEach((b) =>
    b.addEventListener("click", () => { ui.recordScope = b.dataset.s; renderRecordCard(true); })
  );
}

function deltaBanner(deltaSec, what) {
  const ahead = deltaSec >= 0;
  return `<div class="delta-banner ${ahead ? "ahead" : "behind"}">
    <span class="arrow">${ahead ? "↗" : "↘"}</span>
    ${ahead ? "Ahead of" : "Behind"} ${what} by ${fmtHours(Math.abs(deltaSec))}</div>`;
}

function weekChartSVG(curCurve, recCurve, elapsedMs) {
  const W = 640, H = 190, padL = 34, padR = 14, padT = 12, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxSec = Math.max(...curCurve, ...(recCurve.length ? recCurve : [0]), 3600) * 1.08;
  const x = (frac) => padL + frac * iw; // frac of week 0..1
  const y = (sec) => padT + ih - (sec / maxSec) * ih;

  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let grid = "";
  for (let d = 0; d <= 7; d++) {
    grid += `<line x1="${x(d / 7)}" y1="${padT}" x2="${x(d / 7)}" y2="${padT + ih}" stroke="rgba(255,246,226,0.05)"/>`;
    if (d < 7) grid += `<text x="${x((d + 0.5) / 7)}" y="${H - 7}" text-anchor="middle" font-size="10" fill="#6f6656">${days[d]}</text>`;
  }
  // y axis: a few hour marks
  const hourStep = maxSec > 12 * 3600 ? 6 : maxSec > 6 * 3600 ? 3 : 1;
  for (let hSec = hourStep * 3600; hSec < maxSec; hSec += hourStep * 3600) {
    grid += `<line x1="${padL}" y1="${y(hSec)}" x2="${W - padR}" y2="${y(hSec)}" stroke="rgba(255,246,226,0.04)"/>` +
      `<text x="${padL - 6}" y="${y(hSec) + 3}" text-anchor="end" font-size="10" fill="#6f6656">${hSec / 3600}h</text>`;
  }

  const curvePath = (curve, cutFrac) => {
    let d = "";
    curve.forEach((sec, i) => {
      const frac = cutFrac != null && i === curve.length - 1 ? cutFrac : i / 7;
      d += `${i ? "L" : "M"}${x(frac).toFixed(1)},${y(sec).toFixed(1)} `;
    });
    return d;
  };

  const nowFrac = clamp(elapsedMs / (7 * DAY), 0, 1);
  let rec = "";
  if (recCurve.length) {
    rec = `<path d="${curvePath(recCurve)}" fill="none" stroke="#a89d88" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.8"/>`;
  }
  const curD = curvePath(curCurve, nowFrac);
  const lastSec = curCurve[curCurve.length - 1];
  const area = `${curD} L${x(nowFrac)},${y(0)} L${x(0)},${y(0)} Z`;

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(226,179,78,0.22)"/><stop offset="100%" stop-color="rgba(226,179,78,0)"/>
    </linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#wg)"/>
    ${rec}
    <path d="${curD}" fill="none" stroke="#e2b34e" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="${x(nowFrac)}" cy="${y(lastSec)}" r="4" fill="#f6cd6d"/>
    <text x="${clamp(x(nowFrac) + 8, padL, W - 52)}" y="${clamp(y(lastSec) - 8, 12, H)}" font-size="11" font-weight="600" fill="#f6cd6d">${fmtHours(lastSec)}</text>
  </svg>`;
}

function dayChartSVG(you, recTotal, recByNow, recLabel) {
  const W = 640, H = 190, padB = 26, padT = 18;
  const maxSec = Math.max(you, recTotal, 3600) * 1.12;
  const ih = H - padT - padB;
  const y = (sec) => padT + ih - (sec / maxSec) * ih;
  const barW = 130;
  const x1 = W / 2 - barW - 40, x2 = W / 2 + 40;

  let bars = "";
  if (recTotal > 0) {
    // rest of the record day (light)
    bars += `<rect x="${x1}" y="${y(recTotal)}" width="${barW}" height="${Math.max(1, y(recByNow) - y(recTotal))}" rx="4" fill="rgba(168,157,136,0.22)"/>`;
    // achieved-by-now (dark)
    bars += `<rect x="${x1}" y="${y(recByNow)}" width="${barW}" height="${Math.max(1, y(0) - y(recByNow))}" rx="4" fill="#a89d88" opacity="0.75"/>`;
    bars += `<text x="${x1 + barW / 2}" y="${y(recTotal) - 7}" text-anchor="middle" font-size="11" font-weight="600" fill="#a89d88">${fmtHours(recTotal)}</text>`;
    bars += `<text x="${x1 + barW / 2}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="#6f6656">Best · ${esc(recLabel)}</text>`;
  }
  bars += `<rect x="${x2}" y="${y(you)}" width="${barW}" height="${Math.max(2, y(0) - y(you))}" rx="4" fill="#e2b34e"/>`;
  bars += `<text x="${x2 + barW / 2}" y="${y(you) - 7}" text-anchor="middle" font-size="11" font-weight="700" fill="#f6cd6d">${fmtHours(you)}</text>`;
  bars += `<text x="${x2 + barW / 2}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="#6f6656">Today</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <line x1="20" y1="${y(0)}" x2="${W - 20}" y2="${y(0)}" stroke="rgba(255,246,226,0.1)"/>
    ${bars}
  </svg>`;
}

/* ============================================================
   RENDER - Quests view
   ============================================================ */

function openQuest(id) {
  ui.view = "quests";   // opening a quest always means being in the quests section
  ui.questDetail = id;
  ui.animateList = true;
  renderAll();
  $("#view").scrollTop = 0;
}

function closeQuest() {
  ui.questDetail = null;
  ui.animateList = true;
  renderAll();
}

/* everything about one quest: its hours, its history, its children */
function renderQuestDetail(questId) {
  const q = questById(questId);
  if (!q) { closeQuest(); return; }
  const view = $("#view");

  const total = questRollupSeconds(q.id);
  const own = questTotalSeconds(q.id);
  const lv = questLevel(total);
  const kids = subQuests(q.id);
  const parent = q.parentId ? questById(q.parentId) : null;
  const dl = deadlineInfo(q);

  const ws = startOfWeek(Date.now());
  const weeks8 = [];
  for (let i = 7; i >= 0; i--) weeks8.push(ws - i * 7 * DAY);
  const weekVals = weeks8.map((w) => questSecondsBetweenFor(q.id, w, w + 7 * DAY));
  const maxWeek = Math.max(...weekVals, 1);

  const family = new Set(questFamily(q.id));
  const doneTasks = db.tasks
    .filter((t) => family.has(t.questId) && t.done)
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  const openCount = db.tasks.filter((t) => family.has(t.questId) && !t.done && isListed(t)).length;

  view.innerHTML = `
    <div class="view-inner">
      <button class="qd-back" id="qd-back">&larr; All quests</button>

      <div class="qd-head">
        <div class="qd-head-main">
          ${parent ? `<button class="qd-parent" id="qd-parent">part of ${esc(parent.name)}</button>` : ""}
          <h2 class="view-title qd-name">${esc(q.name)}</h2>
          <div class="qd-chips">
            ${dl ? `<span class="chip deadline ${dl.tone}" title="Deadline ${esc(dl.date)}">${dl.label}</span>` : ""}
            <span class="chip">${esc(q.horizon)}</span>
            <span class="chip">${q.kind}</span>
            <button class="chip qd-edit" id="qd-edit">edit</button>
          </div>
        </div>
        <div class="qd-hours">
          ${(total / 3600).toFixed(1)}<span class="u">h</span>
          <span class="qd-hours-sub">${kids.length
            ? `incl. ${((total - own) / 3600).toFixed(1)}h from sub-quests`
            : "invested"}</span>
        </div>
      </div>

      <div class="qd-level">
        <span class="ql-badge">Lvl ${lv.level}</span>
        <span class="ql-name">${lv.name}</span>
        <span class="ql-next">${lv.next
          ? `${lv.toNext < 1 ? Math.round(lv.toNext * 60) + "m" : lv.toNext.toFixed(1) + "h"} to ${lv.nextName}`
          : "every tier cleared"}</span>
      </div>
      <div class="ql-bar"><i style="width:${(lv.progress * 100).toFixed(1)}%"></i></div>
      <div class="ql-scale">
        ${QUEST_TIERS.slice(0, 6).map((h) => `<span class="ql-tick ${lv.hours >= h ? "on" : ""}">${h}h</span>`).join("")}
      </div>

      <div class="card qd-block">
        <div class="qd-block-title">Last 8 weeks</div>
        <div class="quest-activity">
          ${weekVals.map((v, i) => `<div class="bar ${i === weekVals.length - 1 ? "cur" : ""}"
             style="height:${Math.max(6, (v / maxWeek) * 100)}%" title="${fmtHours(v)}"></div>`).join("")}
        </div>
      </div>

      <div class="card heat-card compact" id="qd-heat"></div>

      <div class="qd-section">Metrics</div>
      <div class="qd-metrics" id="qd-metrics"></div>

      <div class="qd-section">Sub-quests</div>
      <div class="qd-subs" id="qd-subs"></div>

      <div class="qd-section">Log time by hand</div>
      <form class="card qd-manual" id="qd-manual">
        <input type="text" id="qm-title" placeholder="What did you do?" autocomplete="off" required/>
        <div class="qd-manual-row">
          <input type="date" id="qm-date" value="${ymd(Date.now())}" aria-label="Date"/>
          <input type="number" id="qm-mins" min="1" max="1440" step="5" value="60" aria-label="Minutes"/>
          <span class="qm-unit">min</span>
          <button type="submit" class="form-btn">Add</button>
        </div>
      </form>

      <div class="qd-section">Finished for this quest - ${doneTasks.length}</div>
      <div class="qd-done" id="qd-done"></div>
    </div>`;

  [".qd-head", ".ql-bar", ".ql-scale", ".quest-activity", ".qd-level"].forEach((sel) =>
    view.querySelector(sel)?.style.setProperty("--quest-color", q.color)
  );

  renderHeatmap("#qd-heat", { compact: true, questId: q.id, colour: q.color });
  renderQuestMetrics(q);

  const subsEl = $("#qd-subs");
  if (!kids.length) subsEl.innerHTML = `<div class="empty-note">No sub-quests yet. Break the ambition down if it helps.</div>`;
  kids.forEach((k) => {
    const klv = questLevel(questRollupSeconds(k.id));
    const row = document.createElement("button");
    row.className = "qd-sub-row";
    row.style.setProperty("--quest-color", k.color);
    row.innerHTML = `
      <span class="dot"></span>
      <span class="qd-sub-name">${esc(k.name)}</span>
      <span class="qd-sub-lvl">Lvl ${klv.level}</span>
      <span class="qd-sub-hours">${(questRollupSeconds(k.id) / 3600).toFixed(1)}h</span>`;
    row.addEventListener("click", () => openQuest(k.id));
    subsEl.appendChild(row);
  });
  const addSub = document.createElement("button");
  addSub.className = "link-task-btn qd-add-sub";
  addSub.textContent = "+ new sub-quest";
  addSub.addEventListener("click", () => showQuestForm(addSub, null, q.id));
  subsEl.appendChild(addSub);

  const doneEl = $("#qd-done");
  if (!doneTasks.length) {
    doneEl.innerHTML = `<div class="empty-note">Nothing finished yet${openCount ? ` - ${openCount} still open` : ""}.</div>`;
  } else {
    let lastDate = null;
    for (const t of doneTasks) {
      if (t.date !== lastDate) {
        lastDate = t.date;
        const h = document.createElement("div");
        h.className = "done-day";
        h.textContent = doneDayLabel(t.date);
        doneEl.appendChild(h);
      }
      const sec = taskLoggedSeconds(t.id);
      const sq = questById(t.questId);
      const row = document.createElement("div");
      row.className = "qd-done-row";
      row.style.setProperty("--quest-color", sq ? sq.color : q.color);
      row.innerHTML = `
        <span class="qd-check">✓</span>
        <span class="qd-done-title">${esc(t.title)}</span>
        ${sq && sq.id !== q.id ? `<span class="qd-done-sub">${esc(sq.name)}</span>` : ""}
        <span class="qd-done-time">${sec >= 60 ? fmtHours(sec) : ""}</span>`;
      doneEl.appendChild(row);
    }
  }

  $("#qd-back").addEventListener("click", closeQuest);
  $("#qd-parent")?.addEventListener("click", () => openQuest(q.parentId));
  $("#qd-edit").addEventListener("click", (e) => showQuestForm(e.currentTarget.closest(".view-inner"), q));

  $("#qd-manual").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = $("#qm-title").value.trim();
    const mins = clamp(parseInt($("#qm-mins").value, 10) || 0, 1, 1440);
    const dateStr = $("#qm-date").value || ymd(Date.now());
    if (!title) return;
    // lands mid-morning of that day so it sits sensibly on the timeline
    const start = dateFromYmd(dateStr) + 9 * HOUR;
    const task = { id: uid(), title, questId: q.id, kind: q.kind, done: true, order: 99, date: dateStr };
    db.tasks.push(task);
    db.sessions.push({ id: uid(), taskId: task.id, start, end: start + mins * 60000 });
    save(`Log ${mins}m on "${q.name}"`);
    sfx.check();
    renderAll();
    toast(`<span class="gold">${fmtHours(mins * 60)}</span> added to ${esc(q.name)}.`, 3000, undoLast);
  });
}


/* metrics turn an ambition into something you can watch move */
function renderQuestMetrics(q) {
  const host = $("#qd-metrics");
  if (!host) return;
  const list = metricsFor(q.id);
  host.innerHTML = "";

  if (!list.length) {
    host.innerHTML = `<div class="empty-note">No metrics yet. Name what "done" looks like in numbers.</div>`;
  }

  for (const m of list) {
    const p = metricProgress(m);
    const el = document.createElement("div");
    el.className = `metric-row ${p.reached ? "reached" : ""}`;
    el.style.setProperty("--quest-color", q.color);
    el.innerHTML = `
      <div class="metric-top">
        <span class="metric-name">${esc(m.name)}</span>
        ${m.kind === "hours" ? `<span class="metric-auto" title="Counted from your logged time">auto</span>` : ""}
        <span class="metric-val">${fmtMetric(m, p.value)}<span class="metric-sep"> / </span>${fmtMetric(m, m.target)}${
          m.unit && m.kind !== "hours" ? ` <span class="metric-unit">${esc(m.unit)}</span>` : ""}</span>
        ${m.kind === "count" ? `
          <span class="metric-btns">
            <button class="metric-btn minus" title="One less">-</button>
            <button class="metric-btn plus" title="One more">+1</button>
          </span>` : ""}
        <button class="metric-del" title="Remove metric" aria-label="Remove metric">x</button>
      </div>
      <div class="metric-bar"><i style="width:${(p.pct * 100).toFixed(1)}%"></i></div>`;

    $(".metric-plus, .metric-btn.plus", el)?.addEventListener("click", (e) => {
      bumpMetric(m.id, 1);
      sfx.check();
      sparkBurst(e.currentTarget, q.color, 9, 38);
      renderQuestDetail(q.id);
    });
    $(".metric-btn.minus", el)?.addEventListener("click", () => { bumpMetric(m.id, -1); renderQuestDetail(q.id); });
    $(".metric-del", el).addEventListener("click", () => {
      db.metrics = db.metrics.filter((x) => x.id !== m.id);
      db.tasks.forEach((t) => { if (t.metricId === m.id) t.metricId = null; });
      save(`Remove metric "${m.name}"`);
      renderQuestDetail(q.id);
      toast("Metric removed.", 2600, undoLast);
    });
    host.appendChild(el);
  }

  const add = document.createElement("button");
  add.className = "link-task-btn qd-add-sub";
  add.textContent = "+ new metric";
  add.addEventListener("click", () => showMetricForm(add, q));
  host.appendChild(add);
}

function showMetricForm(replaceEl, q) {
  const hasHours = metricsFor(q.id).some((m) => m.kind === "hours");
  const wrap = document.createElement("div");
  wrap.className = "card metric-form";
  wrap.innerHTML = `
    <div class="pill-toggle" id="mf-kind">
      <button type="button" data-k="hours" class="${hasHours ? "" : "on"}" ${hasHours ? "disabled" : ""}>Hours logged</button>
      <button type="button" data-k="count" class="${hasHours ? "on" : ""}">Something I count</button>
    </div>
    <input type="text" id="mf-name" placeholder="What is being measured?" autocomplete="off"/>
    <div class="metric-form-row">
      <label for="mf-target">Target</label>
      <input type="number" id="mf-target" min="1" step="1" value="20"/>
      <input type="text" id="mf-unit" placeholder="unit (books, km...)" autocomplete="off"/>
    </div>
    <div class="row">
      <button type="button" class="form-btn ghost" id="mf-cancel">Cancel</button>
      <button type="button" class="form-btn" id="mf-save">Add metric</button>
    </div>`;
  replaceEl.replaceWith(wrap);

  let kind = hasHours ? "count" : "hours";
  const nameEl = $("#mf-name", wrap), unitEl = $("#mf-unit", wrap);
  const syncKind = () => {
    $$("#mf-kind button", wrap).forEach((b) => b.classList.toggle("on", b.dataset.k === kind));
    if (kind === "hours") {
      nameEl.value = nameEl.value || "Hours on this quest";
      unitEl.value = "h";
      unitEl.disabled = true;
    } else {
      if (nameEl.value === "Hours on this quest") nameEl.value = "";
      unitEl.disabled = false;
      if (unitEl.value === "h") unitEl.value = "";
    }
  };
  syncKind();
  nameEl.focus();

  $$("#mf-kind button", wrap).forEach((b) =>
    b.addEventListener("click", () => { if (b.disabled) return; kind = b.dataset.k; syncKind(); }));
  $("#mf-cancel", wrap).addEventListener("click", () => renderQuestDetail(q.id));
  $("#mf-save", wrap).addEventListener("click", () => {
    const name = nameEl.value.trim();
    const target = Math.max(1, parseFloat($("#mf-target", wrap).value) || 0);
    if (!name) { nameEl.focus(); return; }
    db.metrics = db.metrics || [];
    db.metrics.push({
      id: uid(), questId: q.id, name, kind, target,
      unit: kind === "hours" ? "h" : unitEl.value.trim(), value: 0,
    });
    save(`Add metric "${name}"`);
    sfx.check();
    renderQuestDetail(q.id);
  });
  nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#mf-save", wrap).click(); });
}


/* every week you closed, and what you said about it */
function renderReviewHistory() {
  const host = $("#review-history");
  if (!host) return;
  const list = [...(db.reviews || [])].sort((a, b) => b.weekStart - a.weekStart);
  if (!list.length) { host.innerHTML = ""; return; }

  const fmtD = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const CAUSE = { system: "the system", biology: "the body", external: "the outside" };

  host.innerHTML = `
    <button class="list-label done-toggle ${ui.reviewsExpanded ? "open" : ""}" id="rvh-toggle">
      <span class="dt-chev">▸</span>
      <span>Past reviews - ${list.length}</span>
      <span class="dt-hint">what you saw, and what you changed</span>
    </button>
    <div class="rvh-list" id="rvh-list"></div>`;

  const box = $("#rvh-list", host);
  if (ui.reviewsExpanded) {
    box.innerHTML = list.map((r) => {
      const st = r.stats || {};
      return `<div class="rvh-item">
        <div class="rvh-head">
          <span class="rvh-week">${fmtD(r.weekStart)} - ${fmtD(r.weekStart + 6 * DAY)}</span>
          <span class="rvh-stats">${fmtHours(st.questSec || 0)} · ${st.tasksDone || 0} tasks · ${st.honesty || 0}%${
            st.goalsTotal ? ` · goals ${st.goalsHit}/${st.goalsTotal}` : ""}</span>
        </div>
        ${(() => {
          const goals = goalsForWeek(r.weekStart);
          if (!goals.length) return "";
          return `<div class="rvh-goals">${goals.map((g) => {
            const q = questById(g.questId);
            return `<span class="rvh-goal ${g.done ? "hit" : "miss"}" ${q ? `style="--quest-color:${q.color}"` : ""}>
              ${g.done ? "✓" : "✕"} ${esc(g.text)}</span>`;
          }).join("")}</div>`;
        })()}
        ${r.rootCause?.area || r.rootCause?.note ? `
          <div class="rvh-line"><b>Broke on:</b> ${esc(CAUSE[r.rootCause.area] || "-")}${
            r.rootCause.note ? ` - ${esc(r.rootCause.note)}` : ""}</div>` : ""}
        ${r.correction ? `<div class="rvh-line correction"><b>Changed:</b> ${esc(r.correction)}</div>` : ""}
      </div>`;
    }).join("");
  }

  $("#rvh-toggle", host).addEventListener("click", () => {
    ui.reviewsExpanded = !ui.reviewsExpanded;
    renderReviewHistory();
  });
}

function renderQuests() {
  if (ui.questDetail) { renderQuestDetail(ui.questDetail); return; }
  const view = $("#view");
  view.innerHTML = `
    <div class="view-inner wide">
      <h2 class="view-title">Quests</h2>
      <div class="view-sub">The ambitions your hours should serve - quarterly or yearly, work and personal alike.</div>
      <div class="card recap-card" id="recap-card"></div>
      <div id="review-history"></div>
      <div class="quest-grid" id="quest-grid"></div>
    </div>`;
  renderWeekRecap();
  renderReviewHistory();

  const grid = $("#quest-grid");
  const weeks8 = (() => { const cur = startOfWeek(Date.now()); const arr = []; for (let i = 7; i >= 0; i--) arr.push(cur - i * 7 * DAY); return arr; })();

  for (const q of topQuests()) {
    const total = questRollupSeconds(q.id);
    const ws = startOfWeek(Date.now());
    const thisWeek = questSecondsBetweenFor(q.id, ws, ws + 7 * DAY);
    const openTasks = db.tasks.filter((t) => questFamily(q.id).includes(t.questId) && !t.done && isListed(t));
    const kids = subQuests(q.id);
    const lv = questLevel(total);
    const dl = deadlineInfo(q);

    const card = document.createElement("div");
    card.className = "card quest-card";
    card.style.setProperty("--quest-color", q.color);
    card.innerHTML = `
      <div class="quest-card-head">
        <div class="quest-name">${esc(q.name)}</div>
        <button class="quest-edit" title="Edit quest" aria-label="Edit quest ${esc(q.name)}">✎</button>
      </div>
      <div class="quest-chips">
        ${dl ? `<span class="chip deadline ${dl.tone}" title="Deadline ${esc(dl.date)}">${dl.label}</span>` : ""}
        <span class="chip">${esc(q.horizon)}</span>
      </div>
      <div class="quest-hours-row">
        <div class="quest-hours">${(total / 3600).toFixed(1)}<span class="u">h</span></div>
        <div class="quest-week">· <b>${fmtHours(thisWeek)}</b> this week</div>
      </div>
      <div class="quest-level">
        <span class="ql-badge">Lvl ${lv.level}</span>
        <span class="ql-name">${lv.name}</span>
        <span class="ql-next">${lv.next
          ? `${lv.toNext < 1 ? Math.round(lv.toNext * 60) + "m" : lv.toNext.toFixed(1) + "h"} to ${lv.nextName}`
          : "every tier cleared"}</span>
      </div>
      <div class="ql-bar"><i style="width:${(lv.progress * 100).toFixed(1)}%"></i></div>
      ${kids.length ? `<div class="quest-subs">${kids.map((k) => `
        <span class="sub-chip" data-sub="${k.id}" style="--quest-color:${k.color}">
          <span class="dot"></span>${esc(k.name)}
          <b>${(questRollupSeconds(k.id) / 3600).toFixed(1)}h</b>
        </span>`).join("")}</div>` : ""}
      <div class="quest-foot">
        <span>${openTasks.length} open task${openTasks.length === 1 ? "" : "s"}</span>
        <button class="link-task-btn">+ link a task</button>
      </div>`;

    // the card itself opens the quest; the controls inside do their own thing
    card.addEventListener("click", (e) => {
      if (e.target.closest(".quest-edit, .link-task-btn, .sub-chip")) return;
      openQuest(q.id);
    });
    $(".quest-edit", card).addEventListener("click", (e) => { e.stopPropagation(); showQuestForm(card, q); });
    $$(".sub-chip", card).forEach((chip) =>
      chip.addEventListener("click", (e) => { e.stopPropagation(); openQuest(chip.dataset.sub); })
    );
    $(".link-task-btn", card).addEventListener("click", (e) => {
      e.stopPropagation();
      const unlinked = todayTasks().filter((t) => !t.done && t.questId !== q.id);
      if (!unlinked.length) { toast("No open tasks to link - add one in Today first.", 2600); return; }
      openTaskMenu(e.currentTarget, unlinked, (taskId) => {
        taskById(taskId).questId = q.id;
        save("Link task to quest"); renderAll();
        toast(`Linked to <span class="gold">${esc(q.name)}</span>`, 2200);
      });
    });
    grid.appendChild(card);
  }

  // new quest
  const add = document.createElement("button");
  add.className = "new-quest-card";
  add.textContent = "+ New quest";
  add.addEventListener("click", () => showQuestForm(add));
  grid.appendChild(add);

  // archived quests - resting, but their hours remain counted
  const archived = db.quests.filter((x) => x.archived);
  if (archived.length) {
    const sec = document.createElement("div");
    sec.innerHTML = `<div class="list-label">Archived - ${archived.length}</div>` +
      archived.map((q) => `
        <div class="archived-row" style="--quest-color:${q.color}" data-q="${q.id}">
          <span class="dot"></span>
          <span class="aq-name">${esc(q.name)}</span>
          <span class="chip">${esc(q.horizon)}</span>
          <span class="aq-hours">${fmtHours(questTotalSeconds(q.id))}</span>
          <button class="link-task-btn aq-restore">Restore</button>
        </div>`).join("");
    $$(".aq-restore", sec).forEach((b) =>
      b.addEventListener("click", () => {
        const q = questById(b.closest(".archived-row").dataset.q);
        q.archived = false;
        save(`Restore quest “${q.name}”`); renderAll();
      })
    );
    grid.parentElement.appendChild(sec);
  }
}

/* the accountability moment: how honest was this week? */
function renderWeekRecap() {
  const el = $("#recap-card");
  if (!el) return;
  const now = Date.now();
  const ws = startOfWeek(now);
  const questSec = weeklyQuestSeconds(ws);
  const totalSec = sessionSecondsBetween(ws, ws + 7 * DAY);
  const lastSec = weeklyQuestSeconds(ws - 7 * DAY);
  const pct = totalSec > 0 ? Math.round((questSec / totalSec) * 100) : 0;
  // a week with nothing logged deserves an invitation, not a verdict
  const rank = totalSec > 0
    ? honestyRank(pct)
    : { name: "Unwritten", note: "Nothing logged yet this week. The first focus session starts the record." };
  const diff = questSec - lastSec;
  const streak = questDayStreak();
  const bestStreak = bestQuestDayStreak();

  let bestD = null;
  for (let d = 0; d < 7; d++) {
    const s = questSecondsBetween(ws + d * DAY, ws + (d + 1) * DAY);
    if (s > 60 && (!bestD || s > bestD.s)) bestD = { d, s };
  }

  // top-level quests only; a parent already carries its sub-quests' hours
  const perQuest = db.quests
    .filter((q) => !q.parentId)
    .map((q) => ({ q, sec: questSecondsBetweenFor(q.id, ws, ws + 7 * DAY) }))
    .filter(({ q, sec }) => !q.archived || sec > 60)
    .sort((a, b) => b.sec - a.sec);
  const maxQ = Math.max(...perQuest.map((x) => x.sec), 1);
  const fmtD = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  el.innerHTML = `
    <div class="recap-head">
      <div>
        <div class="recap-title">This week, honestly</div>
        <div class="recap-sub">${fmtD(ws)} - ${fmtD(ws + 6 * DAY)} · quest hours vs everything else</div>
      </div>
      <div class="recap-hours">${(questSec / 3600).toFixed(1)}h<span>quest hours</span></div>
    </div>
    <div class="honesty-bar"><div class="hb-fill" style="width:${pct}%"></div></div>
    <div class="honesty-label">
      <span class="rank-pill rank-${rank.name.toLowerCase()}">${rank.name}</span>
      <b>${pct}%</b> of all logged time served a quest · ${fmtHours(totalSec)} logged in total
    </div>
    <div class="rank-note">${rank.note}</div>
    <div class="recap-rows">
      ${!perQuest.length ? `<div class="empty-note">No quests yet - name your first ambition below.</div>` : ""}
      ${perQuest.map(({ q, sec }) => `
        <div class="recap-row">
          <span class="dot" style="background:${q.color}"></span>
          <span class="rname">${esc(q.name)}</span>
          <span class="rbar"><i style="width:${Math.max(2, (sec / maxQ) * 100)}%;background:${q.color}"></i></span>
          <span class="rh">${sec > 60 ? fmtHours(sec) : " - "}</span>
        </div>`).join("")}
    </div>
    <div class="recap-foot">
      <span class="${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "▲" : "▼"} ${fmtHours(Math.abs(diff))} vs last week</span>
      ${bestD ? `<span>Best day: ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][bestD.d]} · ${fmtHours(bestD.s)}</span>` : ""}
      ${streak > 1 ? `<span>${streak}-day streak${streak >= bestStreak ? " - your longest" : ` · best ${bestStreak}`}</span>` : ""}
    </div>`;
}

/* ---------- heatmap: a year of focus, one square per day ---------- */

const HEAT_WEEKS = 52;
// fixed thresholds in hours - the colour means the same thing every week
const HEAT_STEPS = [0.75, 1.75, 3, 5];
const HEAT_FILLS = [
  "rgba(255,246,226,0.05)",
  "rgba(226,179,78,0.24)",
  "rgba(226,179,78,0.45)",
  "rgba(226,179,78,0.72)",
  "#f6cd6d",
];
const heatLevel = (h) => (h <= 0 ? 0 : h < HEAT_STEPS[0] ? 1 : h < HEAT_STEPS[1] ? 2 : h < HEAT_STEPS[2] ? 3 : 4);

function renderHeatmap(sel = "#heat-card", { compact = false, questId = null, colour = null } = {}) {
  const card = $(sel);
  if (!card) return;

  const today = startOfDay(Date.now());
  const lastCol = startOfWeek(today);
  const first = lastCol - (HEAT_WEEKS - 1) * 7 * DAY;
  const byDay = questSecondsByDay(first, today + DAY, questId);

  const fills = colour
    ? ["rgba(255,246,226,0.05)",
       `color-mix(in srgb, ${colour} 26%, transparent)`,
       `color-mix(in srgb, ${colour} 48%, transparent)`,
       `color-mix(in srgb, ${colour} 74%, transparent)`,
       colour]
    : HEAT_FILLS;

  const CELL = compact ? 9 : 11, GAP = compact ? 2.5 : 3;
  const STEP = CELL + GAP, PAD_L = compact ? 20 : 24, PAD_T = compact ? 13 : 16;
  const W = PAD_L + HEAT_WEEKS * STEP, H = PAD_T + 7 * STEP + 4;

  let cells = "", months = "";
  let lit = 0, best = { h: 0, key: "" }, total = 0, lastMonth = -1;

  for (let w = 0; w < HEAT_WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const day = first + (w * 7 + d) * DAY;
      const x = PAD_L + w * STEP, y = PAD_T + d * STEP;
      const label = new Date(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

      if (day > today) {
        cells += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5"
                   fill="rgba(255,246,226,0.02)"/>`;
        continue;
      }
      const hrs = (byDay.get(ymd(day)) || 0) / 3600;
      total += hrs;
      if (hrs > 0) lit++;
      if (hrs > best.h) best = { h: hrs, key: label };
      const lvl = heatLevel(hrs);
      cells += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2.5" fill="${HEAT_FILLS[lvl]}"
                 ${day === today ? 'stroke="rgba(246,205,109,0.85)" stroke-width="1.2"' : ""}>
                 <title>${esc(label)} - ${hrs > 0 ? hrs.toFixed(1) + "h" : "nothing logged"}</title></rect>`;
    }
    // month label whenever a new month starts in this column
    const m = new Date(first + w * 7 * DAY).getMonth();
    if (m !== lastMonth) {
      lastMonth = m;
      months += `<text x="${PAD_L + w * STEP}" y="10" font-size="9.5" fill="#6f6656">${
        new Date(first + w * 7 * DAY).toLocaleDateString("en-US", { month: "short" })}</text>`;
    }
  }

  const dayLabels = [[0, "M"], [2, "W"], [4, "F"]]
    .map(([d, l]) => `<text x="4" y="${PAD_T + d * STEP + 9}" font-size="9" fill="#6f6656">${l}</text>`).join("");

  card.innerHTML = `
    <div class="heat-head">
      <div class="heat-title">Focus heatmap</div>
      <div class="heat-sub">${lit ? `${lit} day${lit === 1 ? "" : "s"} lit · best ${best.h.toFixed(1)}h on ${esc(best.key)}` : "No quest hours logged yet"}</div>
    </div>
    <div class="heat-chart">
      <svg viewBox="0 0 ${W} ${H}" width="100%" role="img"
           aria-label="Quest hours per day over the last year">
        ${months}${dayLabels}${cells}
      </svg>
    </div>
    <div class="heat-foot">
      <span>${total.toFixed(1)}h in the last year</span>
      <span class="heat-legend">less ${HEAT_FILLS.map((f) =>
        `<i style="background:${f}"></i>`).join("")} more</span>
    </div>`;
}


/* ============================================================
   WEEKLY REVIEW - the honest look back, every Sunday
   ============================================================ */

const REVIEW_HOUR = 14; // Sunday 14:00

const goalsForWeek = (ws) => (db.weekGoals || []).filter((g) => g.weekStart === ws);

/* the objective numbers - no interpretation, just what happened */
function weekStats(ws) {
  const we = ws + 7 * DAY;
  const questSec = questSecondsBetween(ws, we);
  const totalSec = sessionSecondsBetween(ws, we);
  const tasksDone = db.tasks.filter((t) => t.done && isListed(t) && t.date >= ymd(ws) && t.date < ymd(we)).length;

  // habits: how many of the seven days each one was kept
  const habits = (db.habits || []).map((h) => {
    let hit = 0;
    const days = [];
    for (let d = 0; d < 7; d++) {
      const day = ws + d * DAY;
      const done = !!h.checks[ymd(day)];
      const future = day > startOfDay(Date.now());
      days.push(future ? "future" : done ? "on" : "off");
      if (done) hit++;
    }
    return { habit: h, hit, days };
  });

  const goals = goalsForWeek(ws);
  return {
    questSec, totalSec, tasksDone, habits, goals,
    goalsHit: goals.filter((g) => g.done).length,
    honesty: totalSec > 0 ? Math.round((questSec / totalSec) * 100) : 0,
    prevQuestSec: questSecondsBetween(ws - 7 * DAY, ws),
  };
}

/* which week is waiting to be reviewed, if any */
function dueReviewWeek() {
  const now = Date.now();
  const thisWeek = startOfWeek(now);
  const sunday14 = thisWeek + 6 * DAY + REVIEW_HOUR * HOUR;
  const candidate = now >= sunday14 ? thisWeek : thisWeek - 7 * DAY;
  if ((db.reviews || []).some((r) => r.weekStart === candidate)) return null;
  // nothing happened that week? then there is nothing to review
  const st = weekStats(candidate);
  if (!st.totalSec && !st.tasksDone && !st.goals.length && !st.habits.some((h) => h.hit)) return null;
  return candidate;
}

function maybeShowReview() {
  if (db.settings?.review === false) return;
  if ($("#review-overlay") || $("#priming-overlay")) return;
  const ws = dueReviewWeek();
  if (ws !== null) openReview(ws);
}

function closeReview() {
  const el = $("#review-overlay");
  if (!el) return;
  el.classList.add("leaving");
  setTimeout(() => el.remove(), 380);
}

/* the review itself: four steps, two of them optional */
function openReview(weekStart, isPreview = false) {
  if ($("#review-overlay")) return;
  const ws = weekStart;
  const st = weekStats(ws);
  const draft = {
    rootCause: { area: null, note: "" },
    correction: "",
    goals: [{ text: "", questId: null }, { text: "", questId: null }, { text: "", questId: null }],
    skipDiagnosis: false,
  };
  let step = 1;

  const overlay = document.createElement("div");
  overlay.id = "review-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Weekly review");
  overlay.innerHTML = `<div class="rv-sheet"><div class="rv-body" id="rv-body"></div></div>`;
  document.body.appendChild(overlay);

  const fmtD = (t) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const weekLabel = `${fmtD(ws)} - ${fmtD(ws + 6 * DAY)}`;

  function render() {
    const body = $("#rv-body", overlay);
    const dots = [1, 2, 3, 4].map((n) =>
      `<span class="rv-dot ${n === step ? "on" : ""} ${n < step ? "past" : ""}"></span>`).join("");

    if (step === 1) {
      const diff = st.questSec - st.prevQuestSec;
      body.innerHTML = `
        <div class="rv-top">
          <div class="rv-eyebrow">Weekly review · ${weekLabel}</div>
          <h2 class="rv-title">What actually happened</h2>
        </div>

        <div class="rv-stats">
          <div class="rv-stat"><b>${(st.questSec / 3600).toFixed(1)}h</b><span>quest hours</span>
            <i class="${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "▲" : "▼"} ${fmtHours(Math.abs(diff))} vs prior</i></div>
          <div class="rv-stat"><b>${st.tasksDone}</b><span>tasks finished</span></div>
          <div class="rv-stat"><b>${st.honesty}%</b><span>served a quest</span></div>
        </div>

        <div class="rv-section">Habits</div>
        <div class="rv-habits">
          ${st.habits.length ? st.habits.map((h) => `
            <div class="rv-habit">
              <span class="rv-habit-name">${esc(h.habit.name)}</span>
              <span class="rv-week">${h.days.map((d) => `<i class="${d}"></i>`).join("")}</span>
              <span class="rv-habit-hit ${h.hit >= 6 ? "good" : h.hit >= 4 ? "mid" : "low"}">${h.hit}/7</span>
            </div>`).join("") : `<div class="empty-note">No habits tracked.</div>`}
        </div>

        <div class="rv-section">Goals you set for this week</div>
        <div class="rv-goals-review">
          ${st.goals.length ? st.goals.map((g) => {
            const q = questById(g.questId);
            return `<div class="rv-goal-row ${g.done ? "hit" : "miss"}">
              <span class="rv-goal-mark">${g.done ? "✓" : "✕"}</span>
              <span class="rv-goal-text">${esc(g.text)}</span>
              ${q ? `<span class="rv-goal-quest" style="--quest-color:${q.color}">${esc(q.name)}</span>` : ""}
            </div>`;
          }).join("") : `<div class="empty-note">No goals were set for this week.</div>`}
          ${st.goals.length ? `<div class="rv-goal-score">${st.goalsHit} of ${st.goals.length} reached</div>` : ""}
        </div>

        <div class="rv-nav">
          <span class="rv-dots">${dots}</span>
          <button class="form-btn ghost" id="rv-skip">Nothing to fix - skip ahead</button>
          <button class="form-btn" id="rv-next">Look closer</button>
        </div>`;

      $("#rv-next", body).addEventListener("click", () => { step = 2; render(); });
      $("#rv-skip", body).addEventListener("click", () => { draft.skipDiagnosis = true; step = 4; render(); });

    } else if (step === 2) {
      body.innerHTML = `
        <div class="rv-top">
          <div class="rv-eyebrow">Step 2 · only if it applies</div>
          <h2 class="rv-title">Where did it break?</h2>
          <p class="rv-lede">Not who is to blame - what failed.</p>
        </div>
        <div class="rv-causes">
          ${[["system", "The system", "A trigger was missing, the plan had no home in the day."],
             ["biology", "The body", "Too little sleep, food, or recovery to draw on."],
             ["external", "The outside", "Something happened that was not mine to control."]]
            .map(([k, t, d]) => `
            <button class="rv-cause ${draft.rootCause.area === k ? "on" : ""}" data-c="${k}">
              <b>${t}</b><span>${d}</span>
            </button>`).join("")}
        </div>
        <textarea id="rv-note" class="rv-textarea" rows="3"
          placeholder="What exactly happened? One or two sentences.">${esc(draft.rootCause.note)}</textarea>
        <div class="rv-nav">
          <span class="rv-dots">${dots}</span>
          <button class="form-btn ghost" id="rv-back">Back</button>
          <button class="form-btn" id="rv-next">Next</button>
        </div>`;

      $$(".rv-cause", body).forEach((b) => b.addEventListener("click", () => {
        draft.rootCause.area = draft.rootCause.area === b.dataset.c ? null : b.dataset.c;
        render();
      }));
      $("#rv-note", body).addEventListener("input", (e) => { draft.rootCause.note = e.target.value; });
      $("#rv-back", body).addEventListener("click", () => { step = 1; render(); });
      $("#rv-next", body).addEventListener("click", () => { step = 3; render(); });

    } else if (step === 3) {
      body.innerHTML = `
        <div class="rv-top">
          <div class="rv-eyebrow">Step 3</div>
          <h2 class="rv-title">The one change</h2>
          <p class="rv-lede">Not five improvements. One, small enough to actually happen.</p>
        </div>
        <textarea id="rv-corr" class="rv-textarea big" rows="3"
          placeholder="Next week I will...">${esc(draft.correction)}</textarea>
        <div class="rv-nav">
          <span class="rv-dots">${dots}</span>
          <button class="form-btn ghost" id="rv-back">Back</button>
          <button class="form-btn" id="rv-next">Next</button>
        </div>`;
      $("#rv-corr", body).addEventListener("input", (e) => { draft.correction = e.target.value; });
      $("#rv-back", body).addEventListener("click", () => { step = 2; render(); });
      $("#rv-next", body).addEventListener("click", () => { step = 4; render(); });

    } else {
      const opts = db.quests.filter((q) => !q.archived);
      body.innerHTML = `
        <div class="rv-top">
          <div class="rv-eyebrow">Step 4 · the week ahead</div>
          <h2 class="rv-title">Three things that would make it a good week</h2>
          <p class="rv-lede">They show up in Today, and you will meet them again next Sunday.</p>
        </div>
        <div class="rv-goal-inputs">
          ${draft.goals.map((g, i) => `
            <div class="rv-goal-input">
              <span class="rv-goal-n">${i + 1}</span>
              <input type="text" data-i="${i}" class="rv-goal-text-in" value="${esc(g.text)}"
                     placeholder="${i === 0 ? "The one that matters most" : "Another goal"}" maxlength="120"/>
              <select data-i="${i}" class="rv-goal-quest-in">
                <option value="">no quest</option>
                ${opts.map((q) => `<option value="${q.id}" ${g.questId === q.id ? "selected" : ""}>${esc(q.name)}</option>`).join("")}
              </select>
            </div>`).join("")}
        </div>
        <div class="rv-nav">
          <span class="rv-dots">${dots}</span>
          <button class="form-btn ghost" id="rv-back">Back</button>
          <button class="form-btn" id="rv-finish">${isPreview ? "Save review" : "Close the week"}</button>
        </div>`;

      $$(".rv-goal-text-in", body).forEach((inp) =>
        inp.addEventListener("input", (e) => { draft.goals[+e.target.dataset.i].text = e.target.value; }));
      $$(".rv-goal-quest-in", body).forEach((sel) =>
        sel.addEventListener("change", (e) => { draft.goals[+e.target.dataset.i].questId = e.target.value || null; }));
      $("#rv-back", body).addEventListener("click", () => { step = draft.skipDiagnosis ? 1 : 3; render(); });
      $("#rv-finish", body).addEventListener("click", finish);
    }
  }

  function finish() {
    const nextWeek = ws + 7 * DAY;
    db.reviews = db.reviews || [];
    db.reviews.push({
      id: uid(), weekStart: ws, createdAt: Date.now(),
      stats: { questSec: st.questSec, totalSec: st.totalSec, tasksDone: st.tasksDone,
               goalsHit: st.goalsHit, goalsTotal: st.goals.length, honesty: st.honesty },
      rootCause: draft.rootCause, correction: draft.correction,
    });
    db.weekGoals = db.weekGoals || [];
    draft.goals.filter((g) => g.text.trim()).forEach((g) =>
      db.weekGoals.push({ id: uid(), weekStart: nextWeek, text: g.text.trim(), questId: g.questId, done: false }));

    save("Weekly review");
    sfx.levelUp();
    closeReview();
    setView("today");
    const n = draft.goals.filter((g) => g.text.trim()).length;
    toast(n ? `Week closed. <span class="gold">${n} goal${n > 1 ? "s" : ""}</span> waiting in Today.`
            : `Week closed.`, 5000);
  }

  render();

  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeReview(); document.removeEventListener("keydown", onKey, true); }
    else e.stopPropagation();
  };
  document.addEventListener("keydown", onKey, true);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay && isPreview) closeReview(); });
}

/* ============================================================
   MORNING PRIMING - the ticket you pay before the day opens
   ============================================================ */

const HOLD_MS = 10000; // long enough to actually read the line, not just wait it out

/* one belief per calendar day, rotating through the list in order */
function todaysBelief() {
  const list = db.beliefs || [];
  if (!list.length) return null;
  const dayIndex = Math.floor(startOfDay(Date.now()) / DAY);
  return list[dayIndex % list.length];
}

function primedToday() { return db.progress?.primedOn === ymd(Date.now()); }

function maybeShowPriming() {
  if (db.settings?.priming === false) return;
  if (primedToday()) return;
  const belief = todaysBelief();
  if (!belief) return;
  openPriming(belief, false);
}

/* the overlay grabs the keyboard in capture phase - releasing it must be
   tied to closing, no matter which path closes it */
let primingRelease = null;

function closePriming() {
  if (primingRelease) { primingRelease(); primingRelease = null; }
  const el = $("#priming-overlay");
  if (!el) return;
  el.classList.add("leaving");
  setTimeout(() => el.remove(), 420);
}

function openPriming(belief, isPreview = true) {
  if ($("#priming-overlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "priming-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Morning priming");
  overlay.innerHTML = `
    <div class="pr-stage">
      <div class="pr-eyebrow">${isPreview ? "Preview" : "Before anything else"}</div>
      <p class="pr-belief ${belief.text.length > 200 ? "small" : belief.text.length > 90 ? "mid" : ""}"
         id="pr-belief">${esc(belief.text)}</p>
      <div class="pr-progress"><i id="pr-fill"></i></div>
      <button class="pr-hold" id="pr-hold" aria-label="Hold to continue">
        <span class="only-keys">Hold <span class="kbd">space</span> to begin the day</span>
        <span class="only-touch">Press and hold to begin the day</span>
      </button>
      <div class="pr-hint">Read it. Picture it. Let it land.</div>
    </div>`;
  document.body.appendChild(overlay);

  const fill = $("#pr-fill", overlay);
  const beliefEl = $("#pr-belief", overlay);
  let holdStart = null, timer = null, finished = false;

  const paint = (p) => {
    fill.style.width = (p * 100).toFixed(1) + "%";
    // the words come into focus as the seconds pass
    // only brightness changes - nothing that reflows the text while it is being read
    beliefEl.style.opacity = (0.6 + p * 0.4).toFixed(2);
  };
  paint(0);

  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    overlay.classList.add("done");
    sfx.workStart();
    if (!isPreview) {
      db.progress = db.progress || {};
      db.progress.primedOn = ymd(Date.now());
      saveQuiet();
    }
    detach();
    setTimeout(closePriming, 520);
  };

  const startHold = () => {
    if (holdStart || finished) return;
    holdStart = Date.now();
    overlay.classList.add("holding");
    sfx.tap();
    timer = setInterval(() => {
      const p = clamp((Date.now() - holdStart) / HOLD_MS, 0, 1);
      paint(p);
      if (p >= 1) finish();
    }, 30);
  };

  const cancelHold = () => {
    if (!holdStart || finished) return;
    holdStart = null;
    clearInterval(timer);
    overlay.classList.remove("holding");
    fill.classList.add("releasing");
    paint(0);
    setTimeout(() => fill.classList.remove("releasing"), 320);
  };

  const onKeyDown = (e) => {
    if (e.code !== "Space") {
      // nothing else gets through until the day is claimed
      if (e.key === "Escape" && isPreview) { e.stopPropagation(); closePriming(); }
      else e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    startHold();
  };
  const onKeyUp = (e) => {
    if (e.code !== "Space") return;
    e.stopPropagation();
    cancelHold();
  };

  function detach() {
    clearInterval(timer);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
  }

  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("keyup", onKeyUp, true);
  primingRelease = detach;

  const btn = $("#pr-hold", overlay);
  btn.addEventListener("pointerdown", (e) => { e.preventDefault(); startHold(); });
  btn.addEventListener("pointerup", cancelHold);
  btn.addEventListener("pointerleave", cancelHold);
  btn.addEventListener("pointercancel", cancelHold);
  // a long press on a phone would otherwise open a menu and cancel the hold halfway
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
}

/* ============================================================
   RENDER - Priming view
   ============================================================ */

function renderPriming() {
  const view = $("#view");
  const list = db.beliefs || [];
  const today = todaysBelief();
  const on = db.settings?.priming !== false;

  view.innerHTML = `
    <div class="view-inner">
      <h2 class="view-title">Priming</h2>
      <div class="view-sub">The first thing you read each morning. Who you are becoming, in your own words.</div>

      ${today ? `
        <div class="card pr-today">
          <div class="pr-today-label">Today's line</div>
          <p class="pr-today-text">${esc(today.text)}</p>
          <button class="form-btn ghost" id="pr-preview">Show the morning screen</button>
        </div>` : ""}

      <form class="jar-add card" id="belief-form">
        <span class="plus">+</span>
        <input type="text" id="belief-input" maxlength="400"
               placeholder="Write it in the present tense, as if it were already true..." autocomplete="off"/>
        <button type="submit" class="form-btn">Add</button>
      </form>

      <div class="belief-list" id="belief-list"></div>

      <div class="pr-setting">
        <label class="pr-toggle">
          <input type="checkbox" id="pr-enabled" ${on ? "checked" : ""}/>
          <span>Show the priming screen on the first open of each day</span>
        </label>
        ${list.length > 1 ? `<span class="pr-rotation">${list.length} lines, one per day, in rotation</span>` : ""}
      </div>
    </div>`;

  const listEl = $("#belief-list");
  if (!list.length) {
    listEl.innerHTML = `<div class="empty-note">No beliefs yet. The morning screen stays off until you write the first one.</div>`;
  }
  list.forEach((b, i) => {
    const isToday = today && b.id === today.id;
    const el = document.createElement("div");
    el.className = `belief-row ${isToday ? "is-today" : ""}`;
    el.innerHTML = `
      <span class="belief-index">${i + 1}</span>
      <span class="belief-text">${esc(b.text)}</span>
      ${isToday ? `<span class="belief-badge">today</span>` : ""}
      <button class="belief-del" title="Remove" aria-label="Remove belief">x</button>`;
    $(".belief-text", el).addEventListener("click", () => startBeliefEdit(b, el));
    $(".belief-del", el).addEventListener("click", () => {
      db.beliefs = db.beliefs.filter((x) => x.id !== b.id);
      save("Remove belief");
      renderPriming();
      toast("Line removed.", 2600, undoLast);
    });
    listEl.appendChild(el);
  });

  $("#belief-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#belief-input").value.trim();
    if (!text) return;
    db.beliefs = db.beliefs || [];
    db.beliefs.push({ id: uid(), text });
    save("Add belief");
    sfx.check();
    renderPriming();
    $("#belief-input")?.focus();
  });

  $("#pr-preview")?.addEventListener("click", () => openPriming(today, true));

  $("#pr-enabled").addEventListener("change", (e) => {
    db.settings = db.settings || {};
    db.settings.priming = e.target.checked;
    save(e.target.checked ? "Priming on" : "Priming off");
    toast(e.target.checked
      ? "The day starts with your line again."
      : "Morning screen off. You can still open it here.", 3000);
  });
}

function startBeliefEdit(b, row) {
  const textEl = $(".belief-text", row);
  if (!textEl || $(".belief-edit", row)) return;
  const input = document.createElement("input");
  input.className = "belief-edit";
  input.value = b.text;
  input.maxLength = 400;
  textEl.replaceWith(input);
  input.focus();
  input.select();
  let closed = false;
  const commit = (keep) => {
    if (closed) return;
    closed = true;
    const v = input.value.trim();
    if (keep && v && v !== b.text) { b.text = v; save("Edit belief"); }
    renderPriming();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

function openTaskMenu(anchor, tasks, onPick) {
  closeQuestMenu();
  const menu = document.createElement("div");
  menu.className = "qmenu";
  menu.id = "qmenu";
  menu.innerHTML = tasks.map((t) => {
    const q = questById(t.questId);
    return `<button data-t="${t.id}"><span class="dot" style="background:${q ? q.color : "#6f6656"}"></span>${esc(t.title)}</button>`;
  }).join("");
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = clamp(r.left, 8, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = (r.bottom + menu.offsetHeight + 8 > innerHeight ? r.top - menu.offsetHeight - 6 : r.bottom + 6) + "px";
  $$("button", menu).forEach((b) => b.addEventListener("click", () => { closeQuestMenu(); onPick(b.dataset.t); }));
  setTimeout(() => document.addEventListener("pointerdown", qmenuDismiss, { once: true }), 0);
}

function showQuestForm(replaceEl, editQuest = null, parentId = null) {
  const wrap = document.createElement("div");
  wrap.className = "card";
  wrap.innerHTML = `
    <form id="quest-form">
      <input type="text" id="qf-name" placeholder="Name the ambition - “Ship the MVP”…" autocomplete="off"/>
      <div class="row">
        <div class="color-swatches" id="qf-colors">
          ${QUEST_COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c}"></button>`).join("")}
        </div>
      </div>
      <div class="row">
        <div class="pill-toggle" id="qf-kind">
          <button type="button" data-k="work">Work</button>
          <button type="button" data-k="personal">Personal</button>
        </div>
        <div class="pill-toggle" id="qf-horizon">
          <button type="button" data-h="Q3 2026">This quarter</button>
          <button type="button" data-h="2026">This year</button>
        </div>
      </div>
      <div class="row qf-deadline-row">
        <label for="qf-deadline">Deadline</label>
        <input type="date" id="qf-deadline" value="${editQuest?.deadline || ""}"/>
        <button type="button" class="form-btn ghost" id="qf-deadline-clear">clear</button>
      </div>
      <div class="row">
        ${editQuest ? `
        <button type="button" class="form-btn ghost danger" id="qf-delete">Delete</button>
        <button type="button" class="form-btn ghost" id="qf-archive">${editQuest.archived ? "Restore" : "Archive"}</button>` : ""}
        <span style="flex:1"></span>
        <button type="button" class="form-btn ghost" id="qf-cancel">Cancel</button>
        <button type="submit" class="form-btn">${editQuest ? "Save changes" : "Create quest"}</button>
      </div>
    </form>`;
  replaceEl.replaceWith(wrap);

  const state = {
    color: editQuest?.color ?? nextFreeColour(),
    kind: editQuest?.kind ?? "work",
    horizon: editQuest?.horizon ?? "Q3 2026",
  };
  $("#qf-name").value = editQuest?.name ?? "";
  $("#qf-name").focus();
  const syncPills = () => {
    $$("#qf-colors button").forEach((b) => b.classList.toggle("on", b.dataset.c.toLowerCase() === state.color.toLowerCase()));
    $$("#qf-kind button").forEach((b) => b.classList.toggle("on", b.dataset.k === state.kind));
    $$("#qf-horizon button").forEach((b) => b.classList.toggle("on", b.dataset.h === state.horizon));
  };
  syncPills();
  $$("#qf-colors button").forEach((b) => b.addEventListener("click", () => { state.color = b.dataset.c; syncPills(); }));
  $$("#qf-kind button").forEach((b) => b.addEventListener("click", () => { state.kind = b.dataset.k; syncPills(); }));
  $$("#qf-horizon button").forEach((b) => b.addEventListener("click", () => { state.horizon = b.dataset.h; syncPills(); }));
  $("#qf-deadline-clear").addEventListener("click", () => { $("#qf-deadline").value = ""; });
  $("#qf-cancel").addEventListener("click", () => renderQuests());

  if (editQuest) {
    $("#qf-delete").addEventListener("click", () => {
      db.tasks.forEach((t) => { if (t.questId === editQuest.id) t.questId = null; });
      db.habits.forEach((h) => { if (h.questId === editQuest.id) h.questId = null; });
      // children move up a level rather than disappearing with the parent
      db.quests.forEach((x) => { if (x.parentId === editQuest.id) x.parentId = editQuest.parentId || null; });
      db.quests = db.quests.filter((x) => x.id !== editQuest.id);
      if (ui.questDetail === editQuest.id) ui.questDetail = editQuest.parentId || null;
      save(`Delete quest “${editQuest.name}”`); renderAll();
      toast("Quest deleted - its tasks are unlinked, logged time stays.", 3600, undoLast);
    });
    $("#qf-archive").addEventListener("click", () => {
      editQuest.archived = !editQuest.archived;
      save(editQuest.archived ? `Archive quest “${editQuest.name}”` : `Restore quest “${editQuest.name}”`);
      renderAll();
      toast(editQuest.archived ? "Archived - the hours stay counted, the quest rests." : "Quest restored.", 3000, undoLast);
    });
  }

  $("#quest-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#qf-name").value.trim();
    if (!name) return;
    if (editQuest) {
      editQuest.name = name;
      editQuest.color = state.color;
      editQuest.kind = state.kind;
      editQuest.horizon = state.horizon;
      editQuest.deadline = $("#qf-deadline").value || null;
      save(`Edit quest “${name}”`); renderAll();
    } else {
      db.quests.push({ id: uid(), name, color: state.color, kind: state.kind,
                       horizon: state.horizon, deadline: $("#qf-deadline").value || null, parentId });
      save(parentId ? `Create sub-quest “${name}”` : `Create quest “${name}”`);
      renderAll();
      toast(`New quest: <span class="gold">${esc(name)}</span>`, 2600);
    }
  });
}

/* ============================================================
   RENDER - Cookie jar
   Proof you've done hard things. Yours to fill; the app adds
   the ones it can honestly vouch for.
   ============================================================ */

function addCookie(text, kind = "manual") {
  db.cookies = db.cookies || [];
  if (kind === "earned" && db.cookies.some((c) => c.text === text)) return false;
  db.cookies.unshift({ id: uid(), text, date: ymd(Date.now()), kind });
  return true;
}

function renderCookies() {
  const view = $("#view");
  const jar = db.cookies || [];
  view.innerHTML = `
    <div class="view-inner">
      <h2 class="view-title">Cookie jar</h2>
      <div class="view-sub">Proof that you've done hard things. Reach in when the work feels impossible.</div>

      <div class="jar-top card">
        <div class="jar-reach" id="jar-reach">
          <div class="jar-glyph">◍</div>
          <div>
            <div class="jar-reach-title">Reach in</div>
            <div class="jar-reach-sub">${jar.length ? `${jar.length} ${jar.length === 1 ? "thing" : "things"} you're proud of` : "empty - put something in it"}</div>
          </div>
        </div>
        <div class="jar-drawn hidden" id="jar-drawn"></div>
      </div>

      <form class="jar-add card" id="jar-form">
        <span class="plus">＋</span>
        <input type="text" id="jar-input" maxlength="160"
               placeholder="Something you're proud of - “Ran the half in the rain”…" autocomplete="off"/>
        <button type="submit" class="form-btn">Add</button>
      </form>

      <div class="jar-grid" id="jar-grid"></div>
    </div>`;

  const grid = $("#jar-grid");
  if (!jar.length) {
    grid.innerHTML = `<div class="empty-note">Nothing in the jar yet. Add the first one - the hardest thing you've pulled off.</div>`;
  } else {
    for (const c of jar) {
      const el = document.createElement("div");
      el.className = `jar-note ${c.kind === "earned" ? "earned" : ""}`;
      el.innerHTML = `
        <div class="jn-text">${esc(c.text)}</div>
        <div class="jn-foot">
          <span class="jn-date">${doneDayLabel(c.date)}</span>
          ${c.kind === "earned" ? `<span class="jn-badge">earned</span>` : ""}
          <button class="jn-del" title="Remove" aria-label="Remove from cookie jar">✕</button>
        </div>`;
      $(".jn-del", el).addEventListener("click", () => {
        db.cookies = db.cookies.filter((x) => x.id !== c.id);
        save("Remove from cookie jar");
        renderCookies();
        toast("Taken out of the jar.", 2600, undoLast);
      });
      grid.appendChild(el);
    }
  }

  $("#jar-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#jar-input").value.trim();
    if (!text) return;
    addCookie(text);
    save("Add to cookie jar");
    sfx.check();
    renderCookies();
    sparkBurst($(".jar-glyph"), "#e2b34e", 10, 42);
    toast(`In the jar: <span class="gold">${esc(text)}</span>`, 2800);
  });

  $("#jar-reach").addEventListener("click", () => {
    const list = db.cookies || [];
    if (!list.length) { $("#jar-input")?.focus(); return; }
    const pick = list[Math.floor(Math.random() * list.length)];
    const drawn = $("#jar-drawn");
    drawn.classList.remove("hidden", "pop");
    void drawn.offsetWidth;
    drawn.classList.add("pop");
    drawn.innerHTML = `<div class="jd-text">${esc(pick.text)}</div><div class="jd-date">${doneDayLabel(pick.date)}</div>`;
    sfx.tap();
    sparkBurst($(".jar-glyph"), "#f6cd6d", 8, 40);
  });
}

/* ============================================================
   RENDER - Timeline (day log)
   ============================================================ */

const TL_START = 6, TL_END = 24, PX_H = 56;
const tlHeight = (TL_END - TL_START) * PX_H;

function tlDay() { return ui.tlDate ?? startOfDay(Date.now()); }
function tlShiftDay(delta) {
  const d = new Date(tlDay());
  d.setDate(d.getDate() + delta);
  ui.tlDate = startOfDay(d.getTime()) === startOfDay(Date.now()) ? null : startOfDay(d.getTime());
  renderTimeline();
}

function tlY(t) { return ((t - tlDay()) / HOUR - TL_START) * PX_H; }
function tlTime(y) { return tlDay() + (TL_START + y / PX_H) * HOUR; }
function snap5(t) { return Math.round(t / (5 * 60000)) * 5 * 60000; }

function renderTimeline() {
  const view = $("#view");
  const dayA = tlDay();
  const now = Date.now();
  // a redraw of the same day keeps its place - only arriving on a day jumps to the morning
  const keepScroll = ui.tlScrollDay === ymd(dayA) ? view.scrollTop : null;
  ui.tlScrollDay = ymd(dayA);
  const isToday = dayA === startOfDay(now);
  const dateLabel = isToday ? "Today" : new Date(dayA).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  // planning a later day? offer to bring today's leftovers along
  const dayTotalSec = sessionSecondsBetween(dayA, dayA + DAY);
  const offGrid = offGridSeconds(dayA);
  const dayQuestSec = questSecondsBetween(dayA, dayA + DAY);
  const carryOver = dayA > startOfDay(now)
    ? db.tasks.filter((t) => !t.done && t.date === ymd(now) && isListed(t))
    : [];

  view.innerHTML = `
    <div class="view-inner">
      <div class="view-head-row">
        <div>
          <h2 class="view-title">Day log</h2>
          <div class="view-sub">Plan focus blocks, pack tasks in, then log what actually happened.</div>
        </div>
        <div class="tl-nav">
          ${isToday ? "" : `<button id="tl-today-btn" class="tool-btn">Back to today</button>`}
          <button id="tl-prev" class="tl-nav-btn" title="Previous day (←)">‹</button>
          <span class="tl-nav-date">${dateLabel}</span>
          <button id="tl-next" class="tl-nav-btn" title="Next day (→)">›</button>
          ${offGrid > 60 ? `<span class="tl-offgrid" title="Logged outside ${TL_START}:00-${TL_END}:00">+${fmtHours(offGrid)} off-grid</span>` : ""}
          <span class="tl-day-total ${dayQuestSec > 0 ? "has-quest" : ""}"
                title="${fmtHours(dayQuestSec)} of it on quests">
            ${fmtHours(dayTotalSec)}<span class="tl-day-total-label">logged</span>
          </span>
        </div>
      </div>
      <div class="tl-toolbar">
        <span class="tl-toolbar-label">Focus blocks</span>
        <button id="fb-add" class="tool-btn">＋ Focus block</button>
        ${isToday ? `<button id="plan-tomorrow" class="tool-btn accent">Plan tomorrow →</button>` : ""}
        ${carryOver.length ? `<button id="carry-over" class="tool-btn accent">Carry over ${carryOver.length} from today</button>` : ""}
        <span class="tl-toolbar-hint">drag open time to plan a block · drag a task from the right into it</span>
      </div>
      <div class="tl-layout">
        <div class="tl-main">
          <div class="tl-heads">
            <div class="tl-heads-spacer"></div>
            <div class="tl-cal-head" id="tl-cal-head"><span class="tl-cal-label">Calendar</span></div>
          </div>
          <div class="tl-wrap">
            <div class="tl-hours" style="height:${tlHeight}px"></div>
            <div class="tl-cal" id="tl-cal" title="Google Calendar - read only"
                 style="height:${tlHeight}px; background-size:100% ${PX_H}px"></div>
            <div class="tl-grid" id="tl-grid" style="height:${tlHeight}px"></div>
          </div>
        </div>
        <aside class="tl-tray" id="tl-tray"></aside>
      </div>
    </div>`;

  $("#tl-prev").addEventListener("click", () => tlShiftDay(-1));
  $("#tl-next").addEventListener("click", () => tlShiftDay(1));
  $("#tl-today-btn")?.addEventListener("click", () => { ui.tlDate = null; renderTimeline(); });

  $("#plan-tomorrow")?.addEventListener("click", () => {
    tlShiftDay(1);
    toast(`Planning <span class="gold">tomorrow</span> - drag tasks from the right onto the timeline.`, 4200);
  });
  $("#carry-over")?.addEventListener("click", () => {
    const target = ymd(dayA);
    for (const t of carryOver) t.date = target;
    save(`Carry ${carryOver.length} tasks over`);
    renderTimeline();
    toast(`${carryOver.length} unfinished task${carryOver.length === 1 ? "" : "s"} moved to ${esc(dateLabel.toLowerCase())}.`, 4000, undoLast);
  });

  $("#fb-add").addEventListener("click", () => {
    const existing = blocksFor(ymd(dayA));
    let start = existing.length ? snap15(existing[existing.length - 1].end + 30 * 60000) : dayA + 9 * HOUR;
    start = clamp(start, dayA + TL_START * HOUR, dayA + (TL_END - 1) * HOUR);
    const id = uid();
    db.blocks.push({ id, date: ymd(dayA), start, end: Math.min(start + 3 * HOUR, dayA + TL_END * HOUR), taskIds: [] });
    save("Add focus block"); renderTimeline();
    openFbDetail(id); // plan it right away: duration, tasks, everything
  });

  const hours = $(".tl-hours");
  const grid = $("#tl-grid");
  for (let h = TL_START; h <= TL_END; h++) {
    const y = (h - TL_START) * PX_H;
    if (h < TL_END) {
      const lab = document.createElement("div");
      lab.className = "tl-hour-label";
      lab.style.top = y + "px";
      lab.textContent = `${String(h).padStart(2, "0")}:00`;
      hours.appendChild(lab);
    }
    const line = document.createElement("div");
    line.className = "tl-gridline";
    line.style.top = y + "px";
    grid.appendChild(line);
    if (h < TL_END) {
      const half = document.createElement("div");
      half.className = "tl-gridline half";
      half.style.top = y + PX_H / 2 + "px";
      grid.appendChild(half);
    }
  }

  // now line - only when looking at today
  if (isToday) {
    const nowY = tlY(now);
    if (nowY > 0 && nowY < tlHeight) {
      const nl = document.createElement("div");
      nl.className = "tl-nowline";
      nl.style.top = nowY + "px";
      grid.appendChild(nl);
    }
  }

  // planned focus blocks (behind the logged sessions)
  blocksFor(ymd(dayA)).forEach((b, i) => grid.appendChild(fbEl(b, i)));

  // logged sessions of the viewed day
  const dayB = dayA + DAY;
  for (const g of mergedSessions(dayA, dayB)) grid.appendChild(tlBlockEl(g));

  // running focus timer as a live, growing block
  if (isToday && ui.focus && ui.focus.segStart) {
    const t = taskById(ui.focus.taskId);
    const q = t ? questById(t.questId) : null;
    const live = document.createElement("div");
    live.className = `tl-block live ${q ? "" : "no-quest"}`;
    live.id = "tl-live";
    if (q) live.style.setProperty("--quest-color", q.color);
    live.style.top = clamp(tlY(ui.focus.segStart), 0, tlHeight) + "px";
    live.style.height = Math.max(14, tlY(now) - tlY(ui.focus.segStart)) + "px";
    live.innerHTML = `<div class="tl-block-title">${esc(t ? t.title : "")}</div><div class="tl-block-time"></div>`;
    grid.appendChild(live);
  }

  setupTimelineInteraction(grid);
  renderTray($("#tl-tray"), ymd(dayA), grid);
  renderCalColumn(dayA);

  setTimeout(() => { $("#view").scrollTop = keepScroll ?? Math.max(0, tlY(dayA + 7.5 * HOUR)); }, 0);
}

/* ---------- Google Calendar column: read-only, fetched per day via serve.py ---------- */

const CAL_TTL = 5 * 60000;
const calCache = {};
const calFetching = {};

function renderCalColumn(dayA) {
  const hit = calCache[ymd(dayA)];
  if (hit) drawCal(dayA, hit);
  // an empty column would read as "no appointments" - say that it is still coming
  else $("#tl-cal").innerHTML = `<div class="tl-cal-note">Loading calendar…</div>`;
  if (!hit || Date.now() - hit.at > CAL_TTL) fetchCal(dayA);
}

async function fetchCal(dayA) {
  const key = ymd(dayA);
  if (calFetching[key]) return;
  calFetching[key] = true;
  try {
    let out;
    if (ON_MAC_SERVER) {
      const res = await fetch(`/api/calendar/events?from=${dayA}&to=${dayA + DAY}`, { headers: { "X-Questlog": "1" } });
      out = await res.json();
    } else {
      out = cloud.cfg ? await cloudCall("events", { from: dayA, to: dayA + DAY }) : { ok: false, error: "not connected" };
    }
    calCache[key] = { at: Date.now(), ...out };
  } catch (e) {
    calCache[key] = { at: Date.now(), ok: false, error: ON_MAC_SERVER ? "local server unreachable" : String(e.message || e) };
  } finally {
    calFetching[key] = false;
  }
  if (ui.view === "timeline" && ymd(tlDay()) === key) drawCal(dayA, calCache[key]);
}

const calColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#7FA8D9");

function drawCal(dayA, data) {
  const col = $("#tl-cal"), head = $("#tl-cal-head");
  if (!col || !head) return;
  col.innerHTML = "";
  head.innerHTML = `<span class="tl-cal-label">Calendar</span>`;
  if (!data.ok) {
    const msg = data.error === "not connected" ? "Google Calendar not connected yet" : "Calendar unavailable";
    col.innerHTML = `<div class="tl-cal-note" title="${esc(data.error || "")}">${msg}</div>`;
    return;
  }

  const day = ymd(dayA), gridA = dayA + TL_START * HOUR, gridB = dayA + TL_END * HOUR;
  const timed = [], chips = [];
  for (const ev of data.events || []) {
    if (ev.allDay) { if (ev.start <= day && day < ev.end) chips.push({ ev, label: "all day" }); }
    else if (ev.end <= gridA || ev.start >= gridB) chips.push({ ev, label: fmtClock(ev.start) });
    else timed.push(ev);
  }
  for (const { ev, label } of chips) {
    const c = document.createElement("div");
    c.className = "tl-cal-chip";
    c.style.setProperty("--cal-color", calColor(ev.color));
    c.title = `${ev.title}\n${ev.calendar}`;
    c.innerHTML = `<span class="tl-cal-chip-time">${esc(label)}</span>${esc(ev.title)}`;
    head.appendChild(c);
  }

  // overlapping events share the width, like in any calendar
  timed.sort((a, b) => a.start - b.start || b.end - a.end);
  const placed = [];
  let cluster = [], laneEnds = [], clusterEnd = -Infinity;
  const flush = () => {
    const n = laneEnds.length;
    cluster.forEach((p) => { p.lanes = n; });
    cluster = []; laneEnds = []; clusterEnd = -Infinity;
  };
  for (const ev of timed) {
    if (cluster.length && ev.start >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= ev.start);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(ev.end); } else laneEnds[lane] = ev.end;
    const p = { ev, lane };
    cluster.push(p); placed.push(p);
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  if (cluster.length) flush();

  for (const { ev, lane, lanes } of placed) {
    const top = clamp(tlY(ev.start), 0, tlHeight);
    const height = Math.max(16, clamp(tlY(ev.end), 0, tlHeight) - top - 1);
    const el = document.createElement("div");
    el.className = `tl-cal-ev ${height < 30 ? "short" : ""}`;
    el.style.setProperty("--cal-color", calColor(ev.color));
    el.style.top = top + "px";
    el.style.height = height + "px";
    el.style.left = `calc(${(lane / lanes) * 100}% + 3px)`;
    el.style.width = `calc(${100 / lanes}% - 5px)`;
    const time = `${fmtClock(ev.start)}-${fmtClock(ev.end)}`;
    el.title = `${ev.title}\n${time}\n${ev.calendar}`;
    el.innerHTML = `<div class="tl-cal-ev-title">${esc(ev.title)}</div><div class="tl-cal-ev-time">${time}</div>`;
    col.appendChild(el);
  }

  if (day === ymd(Date.now())) {
    const y = tlY(Date.now());
    if (y > 0 && y < tlHeight) {
      const nl = document.createElement("div");
      nl.className = "tl-cal-now";
      nl.style.top = y + "px";
      col.appendChild(nl);
    }
  }
}

/* a short breather is not a new block - only a gap of 10 minutes or more splits one */
const MERGE_GAP = 10 * 60000;

function mergedSessions(dayA, dayB) {
  const runningId = ui.focus?.sessionId || null;
  const inDay = db.sessions
    .filter((s) => s.id !== runningId && s.end > dayA && s.start < dayB)
    .sort((a, b) => a.start - b.start);
  const groups = [];
  for (const s of inDay) {
    const last = groups[groups.length - 1];
    if (last && last.taskId === s.taskId && s.start - last.end < MERGE_GAP) {
      last.end = Math.max(last.end, s.end);
      last.logged += (s.end - s.start) / 1000;
      last.ids.push(s.id);
    } else {
      groups.push({ taskId: s.taskId, start: s.start, end: s.end, logged: (s.end - s.start) / 1000, ids: [s.id] });
    }
  }
  // the grid only shows TL_START..TL_END - anything outside would be squashed onto the edge
  const visA = dayA + TL_START * HOUR, visB = dayA + TL_END * HOUR;
  return groups.filter((g) => g.end > visA && g.start < visB);
}

/* time logged on that day that falls outside the visible hours */
function offGridSeconds(dayA) {
  const visA = dayA + TL_START * HOUR, visB = dayA + TL_END * HOUR;
  return db.sessions.reduce((acc, s) => {
    const a = Math.max(s.start, dayA), b = Math.min(s.end, dayA + DAY);
    if (b <= a) return acc;
    const inside = Math.max(0, Math.min(b, visB) - Math.max(a, visA));
    return acc + (b - a - inside) / 1000;
  }, 0);
}

/* the sessions behind a rendered block, in order */
function sessionsOfEl(el) {
  const ids = (el.dataset.sids || "").split(",").filter(Boolean);
  return ids.map((id) => db.sessions.find((x) => x.id === id)).filter(Boolean).sort((a, b) => a.start - b.start);
}

function tlBlockEl(g) {
  const t = taskById(g.taskId);
  const q = t ? questById(t.questId) : null;
  const el = document.createElement("div");
  el.className = `tl-block ${q ? "" : "no-quest"} ${g.ids.length > 1 ? "merged" : ""}`;
  el.dataset.sids = g.ids.join(",");
  if (q) el.style.setProperty("--quest-color", q.color);
  const top = clamp(tlY(g.start), 0, tlHeight);
  const bottom = clamp(tlY(g.end), 0, tlHeight);
  el.style.top = top + "px";
  el.style.height = Math.max(14, bottom - top) + "px";
  el.innerHTML = `
    <div class="tl-handle top"></div>
    <div class="tl-block-title">${esc(t ? t.title : "Logged time")}</div>
    <div class="tl-block-time">${fmtClock(g.start)}-${fmtClock(g.end)} · ${fmtHours(g.logged)}${
      g.ids.length > 1 ? ` <span class="tl-merged-note">${g.ids.length} sittings</span>` : ""}</div>
    <div class="tl-handle bottom"></div>`;
  return el;
}

/* ---------- the tray: that day's tasks, ready to be placed ---------- */

function renderTray(tray, dateStr, grid) {
  if (!tray) return;
  const open = tasksFor(dateStr).filter((t) => !t.done);
  const blocks = blocksFor(dateStr);
  const placedIn = (id) => blocks.findIndex((b) => (b.taskIds || []).includes(id));
  const unplaced = open.filter((t) => placedIn(t.id) < 0).length;
  const isToday = dateStr === ymd(Date.now());
  const pool = somedayTasks();   // the backlog, ready to be pulled into this day

  tray.innerHTML = `
    <div class="tray-head">
      <span class="tray-title">${isToday ? "Today's tasks" : doneDayLabel(dateStr)}</span>
      <span class="tray-count">${unplaced ? `${unplaced} unplaced` : open.length ? "all placed" : ""}</span>
    </div>
    <div class="tray-list" id="tray-list"></div>
    <input type="text" id="tray-add" class="tray-add"
           placeholder="${isToday ? "Add a task…" : "Add a task for that day…"}" autocomplete="off"
           aria-label="Add a task for ${esc(doneDayLabel(dateStr))}"/>
    ${pool.length ? `
      <div class="tray-pool-head">From Someday - ${pool.length}</div>
      <div class="tray-pool" id="tray-pool"></div>` : ""}
    <div class="tray-hint">Tick it off, set its quest, or drag it onto the timeline.</div>`;

  const list = $("#tray-list", tray);
  const doneToday = tasksFor(dateStr).filter((t) => t.done);
  if (!open.length && !doneToday.length) {
    list.innerHTML = `<div class="empty-note tray-empty">Nothing planned for this day yet.</div>`;
  }
  for (const t of [...open, ...doneToday]) {
    const q = questById(t.questId);
    const idx = placedIn(t.id);
    const el = document.createElement("div");
    el.className = `tray-item ${idx >= 0 ? "placed" : ""} ${t.done ? "is-done" : ""}`;
    el.dataset.id = t.id;
    if (q) el.style.setProperty("--quest-color", q.color);
    el.innerHTML = `
      <button class="tray-check ${t.done ? "done" : ""}"
              title="${t.done ? "Mark as not done" : "Mark done"}" aria-label="Toggle done: ${esc(t.title)}">✓</button>
      <span class="tray-item-title">${esc(t.title)}</span>
      <button class="tray-quest ${q ? "" : "none"}" title="Link to a quest" aria-label="Quest for ${esc(t.title)}">
        <span class="dot"></span>
      </button>
      ${idx >= 0 ? `<span class="tray-badge" title="In Focus ${ROMAN[idx]}">◱ ${ROMAN[idx]}</span>` : ""}`;

    $(".tray-check", el).addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDone(t.id, e.currentTarget);
    });
    $(".tray-quest", el).addEventListener("click", (e) => {
      e.stopPropagation();
      openQuestMenu(e.currentTarget, (questId) => {
        t.questId = questId;
        if (t.metricId && !metricsFor(questId).some((m) => m.id === t.metricId)) t.metricId = null;
        save("Link quest");
        renderTimeline();
      }, true, t);
    });
    list.appendChild(el);
  }

  const poolEl = $("#tray-pool", tray);
  if (poolEl) {
    for (const t of pool) {
      const q = questById(t.questId);
      const el = document.createElement("div");
      el.className = "tray-item from-pool";
      el.dataset.id = t.id;
      if (q) el.style.setProperty("--quest-color", q.color);
      el.innerHTML = `
        <span class="tray-item-title">${esc(t.title)}</span>
        <button class="tray-pull" title="Move to this day" aria-label="Move to ${esc(doneDayLabel(dateStr))}">+</button>`;
      $(".tray-pull", el).addEventListener("click", (e) => {
        e.stopPropagation();
        t.date = dateStr;
        save(`Pull "${t.title}" into ${doneDayLabel(dateStr)}`);
        renderTimeline();
        toast(`<span class="gold">${esc(t.title)}</span> -> ${esc(doneDayLabel(dateStr))}`, 2600, undoLast);
      });
      poolEl.appendChild(el);
    }
  }

  $("#tray-add", tray).addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const title = e.target.value.trim();
    if (!title) return;
    const maxOrder = open.length ? Math.max(...open.map((x) => x.order)) : 0;
    db.tasks.push({ id: uid(), title, questId: null, kind: "work", done: false, order: maxOrder + 1, date: dateStr });
    save(`Add “${title}”`);
    renderTimeline();
    $("#tray-add")?.focus();
  });

  setupTrayDrag(tray, grid);
}

/* drag a task out of the tray and drop it onto a time */
function setupTrayDrag(tray, grid) {
  let drag = null;   // { item, float, dx, dy }

  const clearHints = () => {
    $$(".fb.drop-target").forEach((el) => el.classList.remove("drop-target"));
    $("#tray-ghost")?.remove();
  };

  const end = () => {
    clearHints();
    drag.float.remove();
    drag.item.classList.remove("dragging-ghost");
    drag = null;
  };

  const insideGrid = (x, y) => {
    const gr = grid.getBoundingClientRect();
    return x >= gr.left && x <= gr.right && y >= gr.top && y <= gr.bottom;
  };

  dragGesture(tray, {
    pick: (e) => !e.target.closest("button, select, input") && e.target.closest(".tray-item"),
    start: (item, x, y) => {
      const r = item.getBoundingClientRect();
      const float = item.cloneNode(true);
      float.classList.add("tray-float");
      float.style.width = r.width + "px";
      document.body.appendChild(float);
      item.classList.add("dragging-ghost");
      drag = { item, float, dx: x - r.left, dy: y - r.top };
    },
    move: (item, x, y) => {
      drag.float.style.left = x - drag.dx + "px";
      drag.float.style.top = y - drag.dy + "px";
      clearHints();
      const el = document.elementFromPoint(x, y);
      const fb = el && el.closest(".fb");
      if (fb) { fb.classList.add("drop-target"); return; }
      // over empty timeline: preview the block that would be created
      if (insideGrid(x, y)) {
        const start = snap15(tlTime(clamp(y - grid.getBoundingClientRect().top, 0, tlHeight)));
        const ghost = document.createElement("div");
        ghost.className = "fb ghost-plan";
        ghost.id = "tray-ghost";
        ghost.style.top = tlY(start) + "px";
        ghost.style.height = PX_H + "px";
        ghost.innerHTML = `<div class="fb-head"><span class="fb-label">New block</span>
          <span class="fb-time">${fmtClock(start)}-${fmtClock(start + HOUR)}</span></div>`;
        grid.appendChild(ghost);
      }
    },
    drop: (item, x, y) => {
      end();
      const t = taskById(item.dataset.id);
      if (!t) { renderTimeline(); return; }
      const el = document.elementFromPoint(x, y);
      const fb = el && el.closest(".fb");

      if (fb) {
        const b = db.blocks.find((bl) => bl.id === fb.dataset.bid);
        if (b) {
          b.taskIds = b.taskIds || [];
          if (!b.taskIds.includes(t.id)) b.taskIds.push(t.id);
          if (t.date !== b.date) t.date = b.date;   // pulled out of Someday
          save(`Place “${t.title}”`);
          renderTimeline();
          const idx = blocksFor(b.date).findIndex((bl) => bl.id === b.id);
          toast(`<span class="gold">${esc(t.title)}</span> → Focus ${ROMAN[idx]}`, 2600, undoLast);
        }
        return;
      }
      if (!insideGrid(x, y)) { renderTimeline(); return; }

      // dropped on open time: a fresh one-hour block holding that task
      const dayA = tlDay();
      let start = snap15(tlTime(clamp(y - grid.getBoundingClientRect().top, 0, tlHeight)));
      start = clamp(start, dayA + TL_START * HOUR, dayA + (TL_END - 1) * HOUR);
      if (t.date !== ymd(dayA)) t.date = ymd(dayA);   // pulled out of Someday
      db.blocks.push({ id: uid(), date: ymd(dayA), start, end: start + HOUR, taskIds: [t.id] });
      save(`Plan “${t.title}” at ${fmtClock(start)}`);
      renderTimeline();
      toast(`<span class="gold">${esc(t.title)}</span> planned for ${fmtClock(start)}`, 3000, undoLast);
    },
    abort: () => { end(); renderTimeline(); },
  });
}

/* ---------- focus blocks: the plan layer over the log ---------- */

/* blocks snap to 5 minutes so 18:20 is just as plannable as 18:15 */
function snap15(t) { return snap5(t); }

function fbInnerHTML(b, idx) {
  const assigned = (b.taskIds || []).map(taskById).filter(Boolean);
  const logged = sessionSecondsBetween(b.start, b.end);
  return `
    <div class="fb-handle top"></div>
    <div class="fb-head">
      <span class="fb-label">Focus ${ROMAN[idx] || idx + 1}</span>
      <span class="fb-time">${fmtClock(b.start)}-${fmtClock(b.end)}</span>
      <span class="fb-meta">${assigned.length ? `${assigned.length} task${assigned.length > 1 ? "s" : ""}` : "empty - click to plan"}${logged > 60 ? ` · ${fmtHours(logged)} logged` : ""}</span>
    </div>
    <div class="fb-chips">${assigned.map((t) => {
      const q = questById(t.questId);
      return `<span class="fb-chip ${t.done ? "done" : ""}" style="--quest-color:${q ? q.color : "#6f6656"}">${esc(t.title)}</span>`;
    }).join("")}</div>
    <div class="fb-handle bottom"></div>`;
}

function fbEl(b, idx) {
  const el = document.createElement("div");
  el.className = "fb";
  el.dataset.bid = b.id;
  const top = clamp(tlY(b.start), 0, tlHeight);
  el.style.top = top + "px";
  el.style.height = Math.max(24, clamp(tlY(b.end), 0, tlHeight) - top) + "px";
  el.innerHTML = fbInnerHTML(b, idx);
  return el;
}

/* the block, full size: adjust its hours, pack it, start from it */

const DUR_PRESETS = [30, 60, 90, 120, 180, 240];
let fbDetailId = null;

function closeFbDetail() {
  $("#fb-detail")?.remove();
  fbDetailId = null;
}

function openFbDetail(blockId) {
  const b = (db.blocks || []).find((x) => x.id === blockId);
  if (!b) return;
  closeTlForm();
  closeFbDetail();
  fbDetailId = blockId;
  const overlay = document.createElement("div");
  overlay.id = "fb-detail";
  overlay.innerHTML = `<div class="fbd-sheet"></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) closeFbDetail(); });
  renderFbDetail();
}

function fbSetSpan(b, start, end) {
  const dayA = startOfDay(b.start);
  const lo = dayA + TL_START * HOUR, hi = dayA + TL_END * HOUR;
  const dur = clamp(end - start, 5 * 60000, hi - lo);
  b.start = clamp(snap15(start), lo, hi - dur);
  b.end = b.start + dur;
}

function renderFbDetail() {
  const sheet = $("#fb-detail .fbd-sheet");
  if (!sheet) return;
  const b = (db.blocks || []).find((x) => x.id === fbDetailId);
  if (!b) { closeFbDetail(); return; }

  const idx = blocksFor(b.date).findIndex((x) => x.id === b.id);
  const durMin = Math.round((b.end - b.start) / 60000);
  const planned = (b.end - b.start) / 1000;
  const logged = sessionSecondsBetween(b.start, b.end);
  const pct = planned > 0 ? clamp((logged / planned) * 100, 0, 100) : 0;
  const packed = (b.taskIds || []).map(taskById).filter(Boolean);
  const rest = tasksFor(b.date).filter((t) => !(b.taskIds || []).includes(t.id) && !t.done);

  const taskRow = (t, isPacked) => {
    const q = questById(t.questId);
    const sec = taskLoggedSeconds(t.id);
    return `<div class="fbd-task ${isPacked ? "" : "unpacked"} ${t.done ? "done" : ""}"
                 style="--quest-color:${q ? q.color : "#6f6656"}" data-t="${t.id}">
      <button class="fbd-check ${t.done ? "done" : ""}" data-act="check"
              title="${t.done ? "Mark as not done" : "Mark done"}" aria-label="Toggle done: ${esc(t.title)}">✓</button>
      <span class="fbd-task-title">${esc(t.title)}</span>
      <button class="fbd-quest ${q ? "" : "none"}" data-act="quest" title="Link to a quest">
        <span class="dot"></span>${q ? esc(q.name) : "no quest"}
      </button>
      ${sec > 60 ? `<span class="fbd-task-time">${fmtHours(sec)}</span>` : ""}
      ${isPacked && !t.done ? `<button class="fbd-icon-btn go" title="Focus this task">▶</button>` : ""}
      <button class="fbd-icon-btn ${isPacked ? "rm" : ""}" data-act="${isPacked ? "unpack" : "pack"}"
              title="${isPacked ? "Remove from block" : "Add to block"}">${isPacked ? "✕" : "＋"}</button>
    </div>`;
  };

  sheet.innerHTML = `
    <div class="fbd-top">
      <button class="fbd-close" title="Close (Esc)" aria-label="Close focus block">✕</button>
      <div class="fbd-label">Focus ${ROMAN[idx] || idx + 1}</div>
      <div class="fbd-time">${fmtClock(b.start)}-${fmtClock(b.end)}<small>${fmtHours(planned)} planned</small></div>
      <div class="fbd-progress">
        <div class="fbd-bar"><i style="width:${pct}%"></i></div>
        <div class="fbd-progress-label"><b>${fmtHours(logged)}</b> logged in this window · ${Math.round(pct)}% of the plan</div>
      </div>
    </div>
    <div class="fbd-body">
      <div class="fbd-section">Starts at</div>
      <div class="fbd-controls">
        <input type="time" id="fbd-start" value="${fmtClock(b.start)}" step="300"/>
        <span class="fbd-dur">
          <button class="fbd-step" id="fbd-minus" title="15 min shorter">−</button>
          ${DUR_PRESETS.map((m) => `<button class="fbd-chip ${m === durMin ? "on" : ""}" data-m="${m}">${m < 60 ? m + "m" : m / 60 + "h"}</button>`).join("")}
          <button class="fbd-step" id="fbd-plus" title="15 min longer">＋</button>
        </span>
      </div>

      <div class="fbd-section">In this block - ${packed.length || "nothing yet"}</div>
      <div class="fbd-list" id="fbd-packed">
        ${packed.map((t) => taskRow(t, true)).join("") || `<div class="empty-note">Empty. Add tasks below, or write a new one.</div>`}
      </div>

      <div class="fbd-section">Add from ${b.date === ymd(Date.now()) ? "today" : "that day"}</div>
      <div class="fbd-list" id="fbd-rest">
        ${rest.map((t) => taskRow(t, false)).join("") || `<div class="empty-note">Every task is already in a block.</div>`}
      </div>
      <div class="fbd-add-row">
        <input type="text" id="fbd-new" placeholder="New task straight into this block…" autocomplete="off"/>
      </div>
    </div>
    <div class="fbd-foot">
      <button class="form-btn ghost danger" id="fbd-del">Remove block</button>
      <span class="spacer"></span>
      <button class="form-btn" id="fbd-start-btn">Start focus</button>
    </div>`;

  const refresh = (label) => { save(label); renderTimeline(); renderFbDetail(); };

  $(".fbd-close", sheet).addEventListener("click", closeFbDetail);

  $("#fbd-start", sheet).addEventListener("change", (e) => {
    const [h, m] = e.target.value.split(":").map(Number);
    if (isNaN(h)) return;
    fbSetSpan(b, startOfDay(b.start) + h * HOUR + m * 60000, startOfDay(b.start) + h * HOUR + m * 60000 + (b.end - b.start));
    refresh("Move focus block");
  });
  $$(".fbd-chip", sheet).forEach((c) =>
    c.addEventListener("click", () => {
      fbSetSpan(b, b.start, b.start + Number(c.dataset.m) * 60000);
      refresh("Set block duration");
    })
  );
  $("#fbd-minus", sheet).addEventListener("click", () => {
    fbSetSpan(b, b.start, b.end - 15 * 60000);
    refresh("Set block duration");
  });
  $("#fbd-plus", sheet).addEventListener("click", () => {
    fbSetSpan(b, b.start, b.end + 15 * 60000);
    refresh("Set block duration");
  });

  $$(".fbd-task", sheet).forEach((row) => {
    const id = row.dataset.t;
    $('.fbd-check', row).addEventListener("click", (e) => {
      e.stopPropagation();
      toggleDone(id, e.currentTarget);
      setTimeout(renderFbDetail, 330);   // after toggleDone has re-rendered
    });
    $('.fbd-quest', row).addEventListener("click", (e) => {
      e.stopPropagation();
      const t = taskById(id);
      openQuestMenu(e.currentTarget, (questId) => {
        t.questId = questId;
        if (t.metricId && !metricsFor(questId).some((m) => m.id === t.metricId)) t.metricId = null;
        save("Link quest");
        renderTimeline();
        renderFbDetail();
      }, true, t);
    });
    $(".fbd-icon-btn[data-act]", row).addEventListener("click", () => {
      b.taskIds = b.taskIds || [];
      if (row.dataset.t && $(".fbd-icon-btn[data-act]", row).dataset.act === "pack") {
        if (!b.taskIds.includes(id)) b.taskIds.push(id);
        refresh("Pack focus block");
      } else {
        b.taskIds = b.taskIds.filter((x) => x !== id);
        refresh("Unpack focus block");
      }
    });
    $(".fbd-icon-btn.go", row)?.addEventListener("click", () => { closeFbDetail(); enterFocus(id, b.id); });
  });

  $("#fbd-new", sheet).addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const title = e.target.value.trim();
    if (!title) return;
    const open = tasksFor(b.date).filter((t) => !t.done);
    const maxOrder = open.length ? Math.max(...open.map((t) => t.order)) : 0;
    const t = { id: uid(), title, questId: null, kind: "work", done: false, order: maxOrder + 1, date: b.date };
    db.tasks.push(t);
    b.taskIds = [...(b.taskIds || []), t.id];
    save(`Add “${title}” to block`);
    renderTimeline(); renderFbDetail();
    $("#fbd-new")?.focus();
  });

  $("#fbd-del", sheet).addEventListener("click", () => {
    db.blocks = db.blocks.filter((x) => x.id !== b.id);
    save("Remove focus block");
    closeFbDetail(); renderAll();
    toast("Focus block removed - the plan bends, the log stays.", 2600, undoLast);
  });
  $("#fbd-start-btn", sheet).addEventListener("click", () => {
    const first = (b.taskIds || []).map(taskById).find((t) => t && !t.done);
    if (!first) { toast("Pack an open task into this block first.", 2600); return; }
    closeFbDetail();
    enterFocus(first.id, b.id);
  });
}

function setupTimelineInteraction(grid) {
  let op = null; // { kind: 'create'|'move'|'resize-top'|'resize-bottom', ... }

  const gridY = (clientY) => clamp(clientY - grid.getBoundingClientRect().top, 0, tlHeight);

  // what a press hits - read at pointerdown, acted on once the gesture is a drag or a tap
  const pick = (e) => {
    if (e.target.closest(".tl-form")) return null;
    closeTlForm();
    return {
      handle: e.target.closest(".tl-handle"), block: e.target.closest(".tl-block"),
      fbHandle: e.target.closest(".fb-handle"), fbNode: e.target.closest(".fb"), clientY: e.clientY,
    };
  };

  const begin = ({ handle, block, fbHandle, fbNode, clientY }) => {
    const y = gridY(clientY);

    if (fbHandle && fbNode) {
      const b = db.blocks.find((x) => x.id === fbNode.dataset.bid);
      op = { kind: fbHandle.classList.contains("top") ? "fb-resize-top" : "fb-resize-bottom", b, el: fbNode, moved: false };
      fbNode.classList.add("manipulating");
    } else if (fbNode) {
      const b = db.blocks.find((x) => x.id === fbNode.dataset.bid);
      op = { kind: "fb-move", b, el: fbNode, grabOffset: y - tlY(b.start), moved: false };
    } else if (handle && block) {
      const list = sessionsOfEl(block);
      if (!list.length) return;
      // resizing touches only the outer edge of the group
      const s = handle.classList.contains("top") ? list[0] : list[list.length - 1];
      op = { kind: handle.classList.contains("top") ? "resize-top" : "resize-bottom", s, list, el: block, moved: false };
      block.classList.add("manipulating");
    } else if (block) {
      const list = sessionsOfEl(block);
      if (!list.length) return;
      const s = { start: list[0].start, end: list[list.length - 1].end };
      op = {
        kind: "move", s, list, el: block,
        origins: list.map((x) => ({ x, start: x.start, end: x.end })),
        grabOffset: y - tlY(s.start), moved: false,
      };
    } else {
      // draw a new block
      const ghost = document.createElement("div");
      ghost.className = "tl-block ghost-new";
      ghost.style.top = y + "px";
      ghost.style.height = "2px";
      ghost.innerHTML = `<div class="tl-block-title">New block</div><div class="tl-block-time"></div>`;
      grid.appendChild(ghost);
      op = { kind: "create", anchorY: y, el: ghost, moved: false };
    }
  };

  const moveTo = (clientY) => {
    if (!op) return;
    const y = gridY(clientY);
    op.moved = true;

    if (op.kind === "create") {
      const top = Math.min(op.anchorY, y), h = Math.abs(y - op.anchorY);
      op.el.style.top = top + "px";
      op.el.style.height = Math.max(2, h) + "px";
      const a = snap5(tlTime(top)), b = snap5(tlTime(top + h));
      $(".tl-block-time", op.el).textContent = `${fmtClock(a)}-${fmtClock(b)}`;
    } else if (op.kind === "move") {
      const dur = op.s.end - op.s.start;
      let ns = snap5(tlTime(y - op.grabOffset));
      const dayA = tlDay();
      ns = clamp(ns, dayA + TL_START * HOUR, dayA + TL_END * HOUR - dur);
      op.pendStart = ns; op.pendEnd = ns + dur;
      op.el.style.top = tlY(ns) + "px";
      op.el.classList.add("manipulating");
      $(".tl-block-time", op.el).textContent = `${fmtClock(ns)}-${fmtClock(ns + dur)} · ${fmtHours(dur / 1000)}`;
    } else if (op.kind === "resize-top") {
      let ns = snap5(tlTime(y));
      ns = Math.min(ns, op.s.end - 5 * 60000);
      op.pendStart = ns;
      op.el.style.top = tlY(ns) + "px";
      op.el.style.height = tlY(op.s.end) - tlY(ns) + "px";
      $(".tl-block-time", op.el).textContent = `${fmtClock(ns)}-${fmtClock(op.s.end)} · ${fmtHours((op.s.end - ns) / 1000)}`;
    } else if (op.kind === "resize-bottom") {
      let ne = snap5(tlTime(y));
      ne = Math.max(ne, op.s.start + 5 * 60000);
      op.pendEnd = ne;
      op.el.style.height = tlY(ne) - tlY(op.s.start) + "px";
      $(".tl-block-time", op.el).textContent = `${fmtClock(op.s.start)}-${fmtClock(ne)} · ${fmtHours((ne - op.s.start) / 1000)}`;
    } else if (op.kind === "fb-move") {
      const dur = op.b.end - op.b.start;
      const dayA = tlDay();
      let ns = snap15(tlTime(y - op.grabOffset));
      ns = clamp(ns, dayA + TL_START * HOUR, dayA + TL_END * HOUR - dur);
      op.pendStart = ns; op.pendEnd = ns + dur;
      op.el.style.top = tlY(ns) + "px";
      op.el.classList.add("manipulating");
      $(".fb-time", op.el).textContent = `${fmtClock(ns)}-${fmtClock(ns + dur)}`;
    } else if (op.kind === "fb-resize-top") {
      const dayA = tlDay();
      let ns = snap15(tlTime(y));
      ns = clamp(ns, dayA + TL_START * HOUR, op.b.end - 5 * 60000);
      op.pendStart = ns;
      op.el.style.top = tlY(ns) + "px";
      op.el.style.height = tlY(op.b.end) - tlY(ns) + "px";
      $(".fb-time", op.el).textContent = `${fmtClock(ns)}-${fmtClock(op.b.end)}`;
    } else if (op.kind === "fb-resize-bottom") {
      const dayA = tlDay();
      let ne = snap15(tlTime(y));
      ne = clamp(ne, op.b.start + 5 * 60000, dayA + TL_END * HOUR);
      op.pendEnd = ne;
      op.el.style.height = tlY(ne) - tlY(op.b.start) + "px";
      $(".fb-time", op.el).textContent = `${fmtClock(op.b.start)}-${fmtClock(ne)}`;
    }
  };

  const finish = () => {
    if (!op) return;
    const o = op; op = null;
    o.el.classList.remove("manipulating");

    if (o.kind === "create") {
      const top = parseFloat(o.el.style.top), h = parseFloat(o.el.style.height);
      if (!o.moved || h < 8) {
        o.el.remove();
        // a plain click inside a focus block opens its packing popover
        const t = tlTime(o.anchorY);
        const hit = blocksFor(ymd(tlDay())).find((b) => t >= b.start && t < b.end);
        if (hit) {
          const el = $(`.fb[data-bid="${hit.id}"]`, grid);
          if (el) openFbDetail(hit.id);
        }
        return;
      }
      // dragging open time plans a focus block - tasks are made in the tray
      o.el.remove();
      let a = snap15(tlTime(top)), b = snap15(tlTime(top + h));
      if (b - a < 5 * 60000) b = a + 5 * 60000;
      const id = uid();
      db.blocks.push({ id, date: ymd(tlDay()), start: a, end: b, taskIds: [] });
      save("Plan focus block");
      renderTimeline();
      openFbDetail(id);
    } else if (o.kind === "move" && o.moved && o.pendStart != null) {
      const delta = o.pendStart - o.origins[0].start;
      o.origins.forEach(({ x, start, end }) => { x.start = start + delta; x.end = end + delta; });
      save("Move logged block"); renderAll();
    } else if (o.kind === "resize-top" && o.moved && o.pendStart != null) {
      o.s.start = o.pendStart; save("Resize logged block"); renderAll();
    } else if (o.kind === "resize-bottom" && o.moved && o.pendEnd != null) {
      o.s.end = o.pendEnd; save("Resize logged block"); renderAll();
    } else if (o.kind === "move" && !o.moved) {
      showTlEditForm(grid, o.el, o.list);
    } else if (o.kind === "fb-move") {
      if (o.moved && o.pendStart != null) { o.b.start = o.pendStart; o.b.end = o.pendEnd; save("Move focus block"); renderAll(); }
      else openFbDetail(o.b.id);
    } else if (o.kind === "fb-resize-top" && o.moved && o.pendStart != null) {
      o.b.start = o.pendStart; save("Resize focus block"); renderAll();
    } else if (o.kind === "fb-resize-bottom" && o.moved && o.pendEnd != null) {
      o.b.end = o.pendEnd; save("Resize focus block"); renderAll();
    }
  };

  dragGesture(grid, {
    pick,
    start: (hit) => begin(hit),
    move: (hit, x, y) => moveTo(y),
    drop: () => finish(),
    // the browser took the gesture over: nothing is planned, nothing moves
    abort: () => {
      if (!op) return;
      const o = op;
      op = null;
      if (o.kind === "create") o.el.remove();
      else renderTimeline();
    },
    tap: (hit) => { begin(hit); finish(); },
  });
}

function closeTlForm() { const f = $(".tl-form"); if (f) { f.remove(); const g = $(".ghost-new"); if (g) g.remove(); } }

function tlFormPosition(grid, blockEl, form) {
  const top = parseFloat(blockEl.style.top);
  form.style.top = clamp(top, 4, tlHeight - 150) + "px";
  form.style.left = "58%";
}

function showTlCreateForm(grid, ghostEl, a, b) {
  const form = document.createElement("div");
  form.className = "tl-form";
  form.innerHTML = `
    <div class="tl-form-time">${fmtClock(a)}-${fmtClock(b)} · ${fmtHours((b - a) / 1000)}</div>
    <input type="text" id="tlf-title" placeholder="What was this time?" autocomplete="off"/>
    <select id="tlf-quest">
      <option value="">No quest</option>
      ${db.quests.filter((q) => !q.archived).map((q) => `<option value="${q.id}">${esc(q.name)}</option>`).join("")}
    </select>
    <div class="row">
      <button class="form-btn ghost" id="tlf-cancel">Cancel</button>
      <button class="form-btn" id="tlf-save">Log it</button>
    </div>`;
  grid.appendChild(form);
  tlFormPosition(grid, ghostEl, form);
  $("#tlf-title", form).focus();

  const saveIt = () => {
    const title = $("#tlf-title", form).value.trim() || "Logged time";
    const questId = $("#tlf-quest", form).value || null;
    const viewedDate = ymd(tlDay());
    // back-logging a past day creates the task as already done
    const task = { id: uid(), title, questId, kind: "work", done: viewedDate < ymd(Date.now()), order: 99, date: viewedDate };
    db.tasks.push(task);
    db.sessions.push({ id: uid(), taskId: task.id, start: a, end: b });
    save(`Log “${title}”`); renderAll();
    const q = questById(questId);
    toast(q
      ? `Logged <span class="gold">${fmtHours((b - a) / 1000)}</span> to ${esc(q.name)} - quest hours grew.`
      : `Logged ${fmtHours((b - a) / 1000)} · ${esc(title)}`, 3000);
  };
  $("#tlf-save", form).addEventListener("click", saveIt);
  $("#tlf-title", form).addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveIt();
    if (e.key === "Escape") { form.remove(); ghostEl.remove(); }
  });
  $("#tlf-cancel", form).addEventListener("click", () => { form.remove(); ghostEl.remove(); });
}

function showTlEditForm(grid, blockEl, list) {
  const group = Array.isArray(list) ? list : [list];
  const first = group[0], last = group[group.length - 1];
  const logged = group.reduce((a, x) => a + (x.end - x.start) / 1000, 0);
  const t = taskById(first.taskId);
  const form = document.createElement("div");
  form.className = "tl-form";
  form.innerHTML = `
    <div class="tl-form-time">${fmtClock(first.start)}-${fmtClock(last.end)} · ${fmtHours(logged)}${
      group.length > 1 ? ` · ${group.length} sittings` : ""}</div>
    <input type="text" id="tlf-title" value="${esc(t ? t.title : "")}" autocomplete="off"/>
    <select id="tlf-quest">
      <option value="">No quest</option>
      ${db.quests.filter((q) => !q.archived || (t && t.questId === q.id)).map((q) => `<option value="${q.id}" ${t && t.questId === q.id ? "selected" : ""}>${esc(q.name)}${q.archived ? " (archived)" : ""}</option>`).join("")}
    </select>
    <div class="row">
      <button class="form-btn ghost" id="tlf-delete">${group.length > 1 ? "Delete all" : "Delete"}</button>
      <button class="form-btn" id="tlf-save">Save</button>
    </div>`;
  grid.appendChild(form);
  tlFormPosition(grid, blockEl, form);

  $("#tlf-save", form).addEventListener("click", () => {
    if (t) {
      t.title = $("#tlf-title", form).value.trim() || t.title;
      t.questId = $("#tlf-quest", form).value || null;
    }
    save("Edit logged block"); renderAll();
  });
  $("#tlf-delete", form).addEventListener("click", () => {
    const ids = new Set(group.map((x) => x.id));
    db.sessions = db.sessions.filter((x) => !ids.has(x.id));
    save("Delete logged block"); renderAll();
    toast(`${group.length > 1 ? group.length + " sittings" : "Block"} deleted - time un-logged.`, 2400, undoLast);
  });
  $("#tlf-title", form).addEventListener("keydown", (e) => { if (e.key === "Escape") form.remove(); });
}

/* ============================================================
   FOCUS MODE
   ============================================================ */


/* ============================================================
   DEEP WORK - hands the block over to Cold Turkey via serve.py
   ============================================================ */

const DEEPWORK_LISTS = [
  { key: "Firefox",   label: "Block Firefox",            hint: "the whole browser" },
  { key: "HyperFokus", label: "Block Ablenkungen",       hint: "the distraction list" },
  { key: "LockedIN",  label: "Allow only the whitelist", hint: "everything else off" },
];

/* the same four questions the shell function asks */
function askDeepwork(defaultHours = 1) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "confirm-overlay";
    wrap.innerHTML = `
      <div class="confirm-box dw-box" role="dialog" aria-modal="true" aria-label="Deep work">
        <div class="confirm-title">Lock the distractions away?</div>
        <div class="confirm-body">
          <div class="dw-row">
            <label for="dw-hours">How long</label>
            <input type="number" id="dw-hours" min="0.25" max="12" step="0.25" value="${defaultHours}"/>
            <span class="dw-unit">hours</span>
          </div>
          <div class="dw-lists">
            ${DEEPWORK_LISTS.map((l) => `
              <label class="dw-check">
                <input type="checkbox" data-k="${l.key}"/>
                <span><b>${l.label}</b><i>${l.hint}</i></span>
              </label>`).join("")}
          </div>
          <p class="cf-warn">Cold Turkey locks this in - it cannot be lifted early.</p>
        </div>
        <div class="dw-keys">
          <span><span class="kbd">space</span> not now</span>
          <span><span class="kbd">enter</span> block &amp; focus</span>
        </div>
        <div class="confirm-row dw-actions">
          <label class="dw-never"><input type="checkbox" id="dw-never"/> don't ask again</label>
          <button class="form-btn ghost" data-a="no">Not now</button>
          <button class="form-btn" data-a="yes">Block &amp; focus</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const done = (v) => {
      if ($("#dw-never", wrap)?.checked) {
        db.settings = db.settings || {};
        db.settings.askDeepwork = false;
        saveQuiet();
      }
      wrap.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      e.stopPropagation();
      const typing = e.target.tagName === "INPUT";   // let the fields keep their own keys
      if (e.key === "Escape") { e.preventDefault(); done(null); }
      else if (e.key === " " && !typing) { e.preventDefault(); done(null); }
      else if (e.key === "Enter") { e.preventDefault(); $('button[data-a="yes"]', wrap).click(); }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) done(null); });

    $('button[data-a="no"]', wrap).addEventListener("click", () => done(null));
    $('button[data-a="yes"]', wrap).addEventListener("click", () => {
      const hours = clamp(parseFloat($("#dw-hours", wrap).value) || 0, 0.25, 12);
      const lists = $$("#dw-lists input, .dw-lists input", wrap)
        .filter((c) => c.checked).map((c) => c.dataset.k);
      if (!lists.length) { toast("Pick at least one thing to block.", 2600); return; }
      done({ hours, lists });
    });
    // deliberately no autofocus: the hours field would swallow the space shortcut
    wrap.querySelector(".dw-box").setAttribute("tabindex", "-1");
    wrap.querySelector(".dw-box").focus();
  });
}

async function runDeepwork({ hours, lists }) {
  try {
    const res = await fetch("/api/deepwork", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Questlog": "1" },
      body: JSON.stringify({ hours, lists }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.ok) {
      sfx.workStart();
      toast(`Blocked for <span class="gold">${hours}h</span> - ${esc(data.started.join(", "))}.`, 5000);
    } else {
      toast(`Could not block: ${esc(data.error || "no answer from the local server")}`, 6000);
    }
  } catch (e) {
    toast("The local server is not answering - start Questlog with the launcher.", 6000);
  }
}

/* asked once when a fresh focus session begins */
async function maybeOfferDeepwork(defaultHours) {
  if (!ON_MAC_SERVER || db.settings?.askDeepwork === false) return;
  const answer = await askDeepwork(defaultHours);
  if (answer) await runDeepwork(answer);
}

/* start focusing without picking a task first - name it and link it while it runs */
function startInstantFocus() {
  if (ui.focus) { openFocusOverlay(); return; }
  const today = ymd(Date.now());
  const open = tasksFor(today).filter((t) => !t.done);
  const maxOrder = open.length ? Math.max(...open.map((t) => t.order)) : 0;
  const t = {
    id: uid(), title: "Focus session", questId: null, kind: "work",
    done: false, order: maxOrder + 1, date: today, adhoc: true,
  };
  db.tasks.push(t);
  save("Instant focus");
  enterFocus(t.id);
  toast(`Timer running - <span class="gold">click the title</span> to name it, or the line above to link a quest.`, 5200);
}

/* an unnamed instant session with nothing logged leaves no trace */
function maybePruneAdhoc(taskId) {
  const t = taskById(taskId);
  if (!t || !t.adhoc || taskLoggedSeconds(taskId) > 0) return;
  db.tasks = db.tasks.filter((x) => x.id !== taskId);
  for (const b of db.blocks || []) if (b.taskIds) b.taskIds = b.taskIds.filter((x) => x !== taskId);
  if (ui.selectedTaskId === taskId) ui.selectedTaskId = null;
  save("Discard empty focus session");
}

function focusPickQuest() {
  const f = ui.focus;
  if (!f) return;
  const t = taskById(f.taskId);
  if (!t) return;
  openQuestMenu($("#focus-quest"), (questId) => {
    t.questId = questId;
    save(questId ? "Link quest" : "Unlink quest");
    openFocusOverlay();
    renderHeader();
    const q = questById(questId);
    if (q) toast(`This session now counts toward <span class="gold">${esc(q.name)}</span>.`, 2600);
  });
}

function startFocusRename() {
  const f = ui.focus;
  if (!f) return;
  const t = taskById(f.taskId);
  const div = $("#focus-task");
  if (!t || div.classList.contains("hidden")) return;
  const input = document.createElement("input");
  input.className = "focus-task-input";
  input.value = t.title;
  div.classList.add("hidden");
  div.after(input);
  input.focus();
  input.select();
  let closed = false;
  const commit = (keep) => {
    if (closed) return;
    closed = true;
    if (keep) {
      const v = input.value.trim();
      if (v && v !== t.title) { t.title = v; save("Rename task"); }
    }
    input.remove();
    div.classList.remove("hidden");
    div.textContent = t.title;
    renderLiveChip();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // space must type, not pause
    if (e.key === "Enter") commit(true);
    else if (e.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

function enterFocus(taskId, blockId = null) {
  const t = taskById(taskId);
  if (!t || t.done) return;
  closeQuestMenu();
  if (ui.focus && ui.focus.taskId !== taskId) {
    // switching tasks stops the old timer - its time is already earned
    const logged = commitFocusSegment();
    if (logged > 3) toast(`Timer stopped - ${fmtHours(logged)} logged`, 2200);
    ui.focus = null;
  }
  let fresh = false;
  if (!ui.focus) {
    ui.focus = {
      taskId, blockId, segStart: Date.now(), committed: 0,
      mode: "stopwatch", phase: "work", phaseStart: Date.now(), phaseBase: 0, cycles: 0,
    };
    fresh = true;
  } else if (blockId) {
    ui.focus.blockId = blockId;
  }
  sfx.unlock();
  openFocusOverlay();
  // only a brand new session asks - never when simply reopening a running one
  if (fresh) maybeOfferDeepwork(suggestedDeepworkHours(blockId));
}

/* a planned block knows how long it should last - use that as the default */
function suggestedDeepworkHours(blockId) {
  const b = blockId ? (db.blocks || []).find((x) => x.id === blockId) : null;
  if (!b) return 1;
  return Math.max(0.25, Math.round(((b.end - b.start) / 3600000) * 4) / 4);
}

/* ---------- pomodoro cycle: work → break → work, each announced ---------- */

let POMO_WORK = 25 * 60;   // seconds (test hooks may shrink these)
let POMO_BREAK = 5 * 60;

const POMO_PRESETS = [{ work: 25, brk: 5 }, { work: 50, brk: 10 }];

/* the rhythm is the user's choice - stored in minutes, used in seconds */
function applyPomoSettings() {
  const p = db?.settings?.pomo;
  POMO_WORK = clamp(Math.round(p?.work ?? 25), 1, 180) * 60;
  POMO_BREAK = clamp(Math.round(p?.brk ?? 5), 1, 60) * 60;
}

function setPomoRhythm(workMin, brkMin) {
  db.settings = db.settings || {};
  db.settings.pomo = { work: clamp(Math.round(workMin), 1, 180), brk: clamp(Math.round(brkMin), 1, 60) };
  applyPomoSettings();
  save("Pomodoro rhythm");
  // restart the running phase on the new clock so the change takes effect at once
  const f = ui.focus;
  if (f && f.mode === "pomodoro") {
    f.phaseStart = Date.now();
    if (f.phase === "work") { f.phaseBase = f.committed; if (!f.segStart) f.segStart = Date.now(); }
  }
  renderPomoPresets();
  syncFocusPhaseUI();
  tickFocus();
  toast(`Pomodoro set to <span class="gold">${db.settings.pomo.work}/${db.settings.pomo.brk}</span>.`, 2800);
}

/* the preset row under the mode switch, only while pomodoro is on */
function renderPomoPresets() {
  const host = $("#pomo-presets");
  if (!host) return;
  const f = ui.focus;
  if (!f || f.mode !== "pomodoro") { host.classList.add("hidden"); host.innerHTML = ""; return; }

  const cur = db.settings?.pomo || { work: 25, brk: 5 };
  const isPreset = POMO_PRESETS.some((p) => p.work === cur.work && p.brk === cur.brk);
  host.classList.remove("hidden");
  host.innerHTML =
    POMO_PRESETS.map((p) =>
      `<button class="pomo-chip ${p.work === cur.work && p.brk === cur.brk ? "on" : ""}"
               data-w="${p.work}" data-b="${p.brk}">${p.work}/${p.brk}</button>`).join("") +
    `<button class="pomo-chip ${isPreset ? "" : "on"}" id="pomo-custom">custom</button>` +
    `<span class="pomo-custom-fields hidden" id="pomo-fields">
       <input type="number" id="pomo-w" min="1" max="180" value="${cur.work}" aria-label="Focus minutes"/>
       <span>/</span>
       <input type="number" id="pomo-b" min="1" max="60" value="${cur.brk}" aria-label="Break minutes"/>
       <button class="pomo-chip apply" id="pomo-apply">set</button>
     </span>`;

  $$(".pomo-chip[data-w]", host).forEach((b) =>
    b.addEventListener("click", () => setPomoRhythm(+b.dataset.w, +b.dataset.b)));
  $("#pomo-custom", host).addEventListener("click", () => {
    $("#pomo-fields", host).classList.toggle("hidden");
    $("#pomo-w", host)?.focus();
  });
  $("#pomo-apply", host).addEventListener("click", () =>
    setPomoRhythm(+$("#pomo-w", host).value || 25, +$("#pomo-b", host).value || 5));
  $$("#pomo-fields input", host).forEach((i) =>
    i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") $("#pomo-apply", host).click(); }));
}

function workPhaseElapsed() {
  const f = ui.focus;
  return f ? focusElapsed() - f.phaseBase : 0;
}

function enterBreakPhase() {
  const f = ui.focus;
  if (!f) return;
  commitFocusSegment();           // the work is banked before the rest begins
  f.phase = "break";
  f.phaseStart = Date.now();
  f.cycles = (f.cycles || 0) + 1;
  sfx.breakStart();
  syncFocusPhaseUI();
  renderHeader();
  toast(`<span class="gold">Pomodoro ${f.cycles} done</span> - ${fmtHours(POMO_WORK)} banked. Take ${Math.round(POMO_BREAK / 60)}.`, 5000);
}

function enterWorkPhase(skipped = false) {
  const f = ui.focus;
  if (!f) return;
  f.phase = "work";
  f.phaseStart = Date.now();
  f.phaseBase = f.committed;
  f.segStart = Date.now();
  sfx.workStart();
  syncFocusPhaseUI();
  toast(skipped
    ? `Break skipped - <span class="gold">back to work</span>.`
    : `Break over - <span class="gold">next ${Math.round(POMO_WORK / 60)} minutes</span>.`, 3600);
}

/* A phone freezes a web page in the background, so the chime cannot ring there. The end of
   each pomodoro phase therefore also goes into Google Calendar as a reminder - the phone's
   calendar app rings for it even with the browser closed. Touch screens only, and only when
   the moment actually changes. */
function pomoPhaseEnd() {
  const f = ui.focus;
  if (!f || f.mode !== "pomodoro") return null;
  if (f.phase === "break") return f.phaseStart + POMO_BREAK * 1000;
  if (!f.segStart) return null;   // paused
  return Date.now() + Math.max(0, POMO_WORK - workPhaseElapsed()) * 1000;
}

let phoneTimerSent = null;   // what Google Calendar holds now - null: unknown, so tell it once
let phoneTimerRetry = 0;
let phoneTimerChain = Promise.resolve();
function syncPhoneTimer() {
  if (!cloud.cfg || !matchMedia("(hover: none) and (pointer: coarse)").matches) return;
  if (Date.now() < phoneTimerRetry) return;
  const end = pomoPhaseEnd();
  const workDone = `Questlog: Pomodoro done - take ${Math.round(POMO_BREAK / 60)} min`;
  const breakDone = "Questlog: Break over - back to focus";
  // two phases ahead: the pomodoro runs on by itself, and a frozen page cannot plan the next one
  const timers = !end ? [] : ui.focus.phase === "break"
    ? [{ at: end, title: breakDone }, { at: end + POMO_WORK * 1000, title: workDone }]
    : [{ at: end, title: workDone }, { at: end + POMO_BREAK * 1000, title: breakDone }];
  const same = phoneTimerSent && phoneTimerSent.length === timers.length
    && timers.every((t, i) => Math.abs(t.at - phoneTimerSent[i].at) < 5000);   // seconds of drift are no change
  if (same) return;
  phoneTimerSent = timers;
  // in order: a pause right after a resume must not arrive first
  phoneTimerChain = phoneTimerChain.then(() => cloudCall("timer", {}, { timers })).catch(() => {
    phoneTimerSent = null;
    phoneTimerRetry = Date.now() + 30000;   // offline: try again, but not every second
  });
}

/* keeps the overlay's labels honest for the current phase */
function syncFocusPhaseUI() {
  const f = ui.focus;
  const overlay = $("#focus-overlay");
  if (!f || !overlay) return;
  const onBreak = f.mode === "pomodoro" && f.phase === "break";
  overlay.classList.toggle("on-break", onBreak);
  const pause = $("#focus-pause");
  if (onBreak) pause.textContent = "Skip break";
  else pause.textContent = f.segStart ? "Pause" : "Resume";
  const modeBtn = $('#focus-mode-switch button[data-mode="pomodoro"]');
  if (modeBtn) {
    const cur = db.settings?.pomo || { work: 25, brk: 5 };
    modeBtn.textContent = `Pomodoro ${cur.work}′`;
  }
  const badge = $("#focus-phase");
  if (badge) {
    badge.textContent = f.mode !== "pomodoro" ? "" : onBreak ? "Break" : `Work · pomodoro ${(f.cycles || 0) + 1}`;
    badge.classList.toggle("hidden", f.mode !== "pomodoro");
  }
}

function openFocusOverlay() {
  const f = ui.focus;
  if (!f) return;
  const t = taskById(f.taskId);
  const q = t ? questById(t.questId) : null;
  const overlay = $("#focus-overlay");
  overlay.classList.remove("hidden", "leaving");
  if (q) {
    overlay.style.setProperty("--quest-color", q.color);
    $("#focus-quest").innerHTML = `<span class="dot"></span>${esc(q.name)}`;
  } else {
    overlay.style.removeProperty("--quest-color");
    $("#focus-quest").innerHTML = `<span class="dot"></span>Unlinked - tap to make it count`;
  }
  $("#focus-task").classList.remove("hidden");
  $(".focus-task-input")?.remove();
  $("#focus-task").textContent = t ? t.title : "";
  $("#focus-timer").classList.toggle("paused", !f.segStart);
  $("#focus-timer").classList.remove("pomo-done");
  $$("#focus-mode-switch button").forEach((b) => b.classList.toggle("on", b.dataset.mode === f.mode));
  syncFocusPhaseUI();
  renderPomoPresets();
  renderMusicRow();
  renderFocusBlockList();
  ensureFocusTicker();
  tickFocus();
  renderLiveChip();
}

/* when focus was started from a planned block, the whole block is on screen */
function renderFocusBlockList() {
  const el = $("#focus-block-list");
  const f = ui.focus;
  if (!el) return;
  const block = f && f.blockId ? (db.blocks || []).find((b) => b.id === f.blockId) : null;
  if (!block) { el.classList.add("hidden"); el.innerHTML = ""; return; }

  const tasks = (block.taskIds || []).map(taskById).filter(Boolean);
  if (!tasks.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }

  const idx = blocksFor(block.date).findIndex((b) => b.id === block.id);
  const openLeft = tasks.filter((t) => !t.done).length;
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="fbl-head">Focus ${ROMAN[idx] || idx + 1} · ${openLeft} of ${tasks.length} left</div>
    <div class="fbl-list">${tasks.map((t) => {
      const q = questById(t.questId);
      return `<button class="fbl-item ${t.done ? "done" : ""} ${t.id === f.taskId ? "current" : ""}"
                data-t="${t.id}" style="--quest-color:${q ? q.color : "#6f6656"}">
        <span class="fbl-check">${t.done ? "✓" : ""}</span>
        <span class="fbl-title">${esc(t.title)}</span>
        ${t.id === f.taskId ? `<span class="fbl-now">timing</span>` : ""}
      </button>`;
    }).join("")}</div>`;

  $$(".fbl-item", el).forEach((btn) =>
    btn.addEventListener("click", () => {
      const t = taskById(btn.dataset.t);
      if (!t) return;
      if (t.id === ui.focus.taskId && !t.done) {
        // ticking off what you are timing: bank the time, move to the next one
        completeFocusTaskInBlock(block);
        return;
      }
      t.done = !t.done;
      save(t.done ? `Complete "${t.title}"` : `Reopen "${t.title}"`);
      if (t.done) { sfx.check(); sparkBurst(btn, questById(t.questId)?.color || "#e2b34e", 8, 34); }
      renderFocusBlockList();
      renderHeader();
    })
  );
}

/* finish the task being timed and roll straight into the next open one */
function completeFocusTaskInBlock(block) {
  const f = ui.focus;
  if (!f) return;
  const current = taskById(f.taskId);
  commitFocusSegment();
  if (current) {
    current.done = true;
    save(`Complete "${current.title}"`);
  }
  sfx.complete();
  const ring = $(".focus-ring-wrap");
  if (ring) sparkBurst(ring, questById(current?.questId)?.color || "#e2b34e", 18, 120);

  const next = (block.taskIds || []).map(taskById).find((t) => t && !t.done);
  if (next) {
    ui.focus = {
      ...f, taskId: next.id, segStart: Date.now(), committed: 0,
      phase: "work", phaseStart: Date.now(), phaseBase: 0,
    };
    openFocusOverlay();
    renderHeader();
    toast(`Next: <span class="gold">${esc(next.title)}</span>`, 3000);
  } else {
    toast(`<span class="gold">Block cleared</span> - everything in it is done.`, 4000);
    exitFocus();
  }
}

function ensureFocusTicker() {
  if (!ui.focusTicker) ui.focusTicker = setInterval(tickFocus, 250);
}
function stopFocusTicker() {
  clearInterval(ui.focusTicker);
  ui.focusTicker = null;
  syncPhoneTimer();   // nothing counts down any more - the phone must not ring
  syncMusic();
}

/* stop from the background chip: log the segment, end the focus context */
function stopFocusTimer(silent = false) {
  const f = ui.focus;
  if (!f) return;
  const logged = commitFocusSegment();
  const t = taskById(f.taskId);
  ui.focus = null;
  stopFocusTicker();
  maybePruneAdhoc(f.taskId);
  if (!silent && logged > 3) {
    const q = t ? questById(t.questId) : null;
    toast(q
      ? `Timer stopped - <span class="gold">+${fmtHours(logged)}</span> to ${esc(q.name)}`
      : `Timer stopped - ${fmtHours(logged)} logged`, 3000);
  }
  renderAll();
}

function focusElapsed() {
  const f = ui.focus;
  if (!f) return 0;
  return f.committed + (f.segStart ? (Date.now() - f.segStart) / 1000 : 0);
}

function timerDigits(str) {
  return [...str].map((c) => c === ":" ? `<span class="colon">:</span>` : `<span class="digit">${c}</span>`).join("");
}

function fmtTimer(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const RING_C = 2 * Math.PI * 172;

function tickFocus() {
  const f = ui.focus;
  if (!f) { stopFocusTicker(); return; }
  checkpointFocus();
  const el = focusElapsed();
  const ov = $("#focus-overlay");
  const overlayOpen = !ov.classList.contains("hidden") && !ov.classList.contains("leaving");

  // pomodoro drives itself, whether or not you are watching
  if (f.mode === "pomodoro") {
    if (f.phase === "break") {
      if ((Date.now() - f.phaseStart) / 1000 >= POMO_BREAK) enterWorkPhase();
    } else if (f.segStart && workPhaseElapsed() >= POMO_WORK) {
      enterBreakPhase();
    }
  }
  syncPhoneTimer();
  syncMusic();

  if (overlayOpen) {
    const timerEl = $("#focus-timer");
    const ring = $("#ring-fill");
    ring.setAttribute("stroke-dasharray", RING_C);
    if (f.mode === "pomodoro") {
      const onBreak = f.phase === "break";
      const span = onBreak ? POMO_BREAK : POMO_WORK;
      const used = onBreak ? (Date.now() - f.phaseStart) / 1000 : workPhaseElapsed();
      const remain = Math.max(0, span - used);
      timerEl.innerHTML = timerDigits(fmtTimer(remain));
      ring.style.strokeDashoffset = RING_C * (1 - clamp(remain / span, 0, 1));
    } else {
      timerEl.innerHTML = timerDigits(fmtTimer(el));
      // gentle minute sweep
      ring.style.strokeDashoffset = RING_C * (1 - ((el % 60) / 60));
    }
  }

  // background chip keeps ticking
  const chipTime = $("#live-chip .lc-time");
  if (chipTime && !$("#live-chip").classList.contains("hidden")) chipTime.textContent = fmtTimer(el);

  // live block growing on the timeline
  const live = $("#tl-live");
  if (live && f.segStart) {
    const now = Date.now();
    live.style.height = Math.max(14, tlY(now) - tlY(f.segStart)) + "px";
    const tEl = $(".tl-block-time", live);
    if (tEl) tEl.textContent = `${fmtClock(f.segStart)}-now · ${fmtHours((now - f.segStart) / 1000)}`;
  }
}

/* A running timer used to live only in memory - closing the tab threw the time away.
   The segment is now written to disk every few seconds, so at most CHECKPOINT_MS is lost. */
const CHECKPOINT_MS = 15000;

/* force a checkpoint regardless of the interval - used when the page goes away */
function checkpointNow() {
  const f = ui.focus;
  if (!f || !f.segStart) return;
  f.checkpointEnd = f.segStart;   // defeat the interval guard
  checkpointFocus();
}

function checkpointFocus() {
  const f = ui.focus;
  if (!f || !f.segStart) return;
  const now = Date.now();
  if (now - (f.checkpointEnd || f.segStart) < CHECKPOINT_MS) return;
  let sess = f.sessionId ? db.sessions.find((x) => x.id === f.sessionId) : null;
  if (!sess) {
    sess = { id: uid(), taskId: f.taskId, start: f.segStart, end: now };
    db.sessions.push(sess);
    f.sessionId = sess.id;
  } else {
    sess.end = now;
  }
  f.checkpointEnd = now;
  saveQuiet();   // a checkpoint is bookkeeping, not an undo step
}

function commitFocusSegment() {
  const f = ui.focus;
  if (!f || !f.segStart) return 0;
  const now = Date.now();
  const dur = now - f.segStart;
  const sess = f.sessionId ? db.sessions.find((x) => x.id === f.sessionId) : null;
  if (sess) {
    if (dur > 3000) sess.end = now;
    else db.sessions = db.sessions.filter((x) => x.id !== sess.id);
  } else if (dur > 3000) {
    db.sessions.push({ id: uid(), taskId: f.taskId, start: f.segStart, end: now });
  }
  f.sessionId = null;
  f.checkpointEnd = null;
  f.committed += dur / 1000;
  f.segStart = null;
  save("Log focus time");
  return dur / 1000;
}

function pauseFocus(silent = false) {
  const f = ui.focus;
  if (!f) return;

  // during a pomodoro break the button cuts the rest short instead
  if (f.mode === "pomodoro" && f.phase === "break") {
    enterWorkPhase(true);
    return;
  }

  if (f.segStart) {
    const logged = commitFocusSegment();
    if (!silent) sfx.pause();
    $("#focus-pause").textContent = "Resume";
    $("#focus-timer").classList.add("paused");
    syncMusic();
    renderHeader();
    if (!silent && logged > 3) {
      const t = taskById(f.taskId);
      const q = t ? questById(t.questId) : null;
      toast(q
        ? `Paused - <span class="gold">+${fmtHours(logged)}</span> to ${esc(q.name)}`
        : `Paused - ${fmtHours(logged)} logged`, 2800);
    }
  } else {
    f.segStart = Date.now();
    if (!silent) sfx.resume();
    $("#focus-pause").textContent = "Pause";
    $("#focus-timer").classList.remove("paused", "pomo-done");
    syncMusic();
  }
}

function completeFocus() {
  const f = ui.focus;
  if (!f) return;
  commitFocusSegment();
  const t = taskById(f.taskId);
  t.done = true;
  save(`Complete “${t.title}”`);
  const q = questById(t.questId);
  const total = f.committed;

  // the payoff: the ring blooms, embers scatter, the hours fly to the headline
  const ring = $(".focus-ring-wrap");
  const overlay = $("#focus-overlay");
  sfx.complete();
  if (!reducedMotion && ring) {
    overlay.classList.add("bloom");
    sparkBurst(ring, q ? q.color : "#e2b34e", 26, 190);
    setTimeout(() => overlay.classList.remove("bloom"), 620);
  }
  toast(q
    ? `<span class="gold">✓ ${esc(t.title)}</span> · +${fmtHours(total)} quest hours`
    : `✓ ${esc(t.title)} · ${fmtHours(total)} logged`, 4000);

  setTimeout(() => {
    if (q && total >= 60) flyToHero(ring, `+${fmtHours(total)}`, q.color);
    exitFocus();
  }, reducedMotion ? 0 : 420);
}

function exitFocus() {
  const f = ui.focus;
  const overlay = $("#focus-overlay");
  overlay.classList.add("leaving");
  setTimeout(() => { overlay.classList.add("hidden"); overlay.classList.remove("leaving"); }, 340);
  if (f && f.segStart) {
    // Toggl-style: the timer keeps running in the background
    const t = taskById(f.taskId);
    toast(`Timer keeps running - <span class="gold">${esc(t ? t.title : "")}</span>`, 2400);
  } else if (f) {
    ui.focus = null;
    stopFocusTicker();
    maybePruneAdhoc(f.taskId);
  }
  renderAll();
}

function setupFocusControls() {
  $("#focus-pause").addEventListener("click", () => pauseFocus());
  $("#focus-complete").addEventListener("click", completeFocus);
  $("#focus-quest").addEventListener("click", focusPickQuest);
  $("#focus-task").addEventListener("click", startFocusRename);
  $$("#focus-mode-switch button").forEach((b) =>
    b.addEventListener("click", () => {
      const f = ui.focus;
      if (!f) return;
      f.mode = b.dataset.mode;
      // a fresh pomodoro always starts on a full work phase
      f.phase = "work";
      f.phaseStart = Date.now();
      f.phaseBase = f.committed;
      f.cycles = 0;
      if (f.mode === "pomodoro" && !f.segStart) f.segStart = Date.now();
      $$("#focus-mode-switch button").forEach((x) => x.classList.toggle("on", x === b));
      $("#focus-timer").classList.remove("pomo-done");
      syncFocusPhaseUI();
      renderPomoPresets();
      tickFocus();
    })
  );
}

/* ============================================================
   MUSIC - your own focus tracks (the brainfm folder) under the timer
   ============================================================ */
// A web page cannot read a folder on its own: the files are picked once per device and
// then kept in this browser's IndexedDB, so later sessions play without asking again.
// Not on a shared computer - there they live in memory and leave with the tab.

const MUSIC_DB = "questlog-music";
const MUSIC_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i;

const music = {
  names: null,      // track names on this device (null = not looked up yet)
  mem: new Map(),   // name -> File/Blob, when not cached or not yet cached
  order: [], idx: 0, url: null, audio: null, picking: false, saving: false,
};

function musicIdb() {
  if (music.idb) return music.idb;
  music.idb = new Promise((resolve, reject) => {
    const req = indexedDB.open(MUSIC_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("tracks");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  music.idb.catch(() => { music.idb = null; });
  return music.idb;
}

function musicTx(mode, fn) {
  return musicIdb().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction("tracks", mode);
    const out = fn(tx.objectStore("tracks"));
    tx.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    tx.onerror = tx.onabort = () => reject(tx.error);
  }));
}

const musicCaches = () => appStore === localStorage;
const musicTouch = () => matchMedia("(hover: none) and (pointer: coarse)").matches;

async function musicLoadNames() {
  if (music.names) return music.names;
  let names = [];
  if (musicCaches()) { try { names = (await musicTx("readonly", (st) => st.getAllKeys())) || []; } catch (e) {} }
  music.names = [...new Set([...names, ...music.mem.keys()])];
  return music.names;
}

async function musicBlob(name) {
  if (music.mem.has(name)) return music.mem.get(name);
  try { return await musicTx("readonly", (st) => st.get(name)); } catch (e) { return null; }
}

/* "EuropaRising_Focus_DeepWork_…mp3" -> "Europa Rising" */
function musicTitle(name) {
  const base = name.replace(MUSIC_EXT, "").split("_")[0].replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return base || name;
}

function musicShuffle() {
  const a = [...(music.names || [])];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  music.order = a;
  music.idx = 0;
}

/* the folder picker - a whole folder on a computer, a handful of files on a phone */
function musicPick() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "audio/*";
    if (!musicTouch()) input.webkitdirectory = true;
    input.style.display = "none";
    document.body.appendChild(input);
    music.picking = true;
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      music.picking = false;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish([...input.files].filter((f) => MUSIC_EXT.test(f.name))));
    input.addEventListener("cancel", () => finish([]));
    input.click();
  });
}

async function musicChooseFolder() {
  const files = await musicPick();
  if (!files.length) { toast("No audio files picked - music stays off.", 3200); return false; }
  musicStopPlayback();
  music.mem = new Map(files.map((f) => [f.name, f]));
  music.names = files.map((f) => f.name);
  musicShuffle();
  toast(`<span class="gold">${files.length} track${files.length === 1 ? "" : "s"}</span> ready.`, 2800);
  musicCache(files);
  return true;
}

/* keep the picked tracks for later sessions - replaces whatever was cached before */
async function musicCache(files) {
  if (!musicCaches()) return;
  music.saving = true;
  try {
    await musicTx("readwrite", (st) => st.clear());
    for (const f of files) {
      await musicTx("readwrite", (st) => st.put(f, f.name));
      if (music.mem.get(f.name) === f) music.mem.delete(f.name);
    }
  } catch (e) {
    toast("Not enough room to keep the music in this browser - pick the folder again next time.", 5200);
  } finally {
    music.saving = false;
  }
}

async function musicForget() {
  musicStopPlayback();
  music.mem.clear();
  music.names = [];
  music.order = [];
  try { await musicTx("readwrite", (st) => st.clear()); } catch (e) {}
  setMusicOn(false);
  toast("Music forgotten on this device.", 2600);
}

/* what should be playing right now: music on, timer running, not on a break */
function musicWanted() {
  const f = ui.focus;
  return db.settings?.music === true && !!f && !!f.segStart && !(f.mode === "pomodoro" && f.phase === "break");
}

async function musicPlayCurrent() {
  if (!music.order.length) musicShuffle();
  const name = music.order[music.idx % music.order.length];
  const blob = name ? await musicBlob(name) : null;
  if (!blob) { musicNext(); return; }
  if (!music.audio) {
    music.audio = new Audio();
    music.audio.addEventListener("ended", () => musicNext());
  }
  if (music.url) URL.revokeObjectURL(music.url);
  music.url = URL.createObjectURL(blob);
  music.audio.src = music.url;
  music.audio.dataset.track = name;
  renderMusicRow();
  if (musicWanted()) music.audio.play().catch(() => {});
}

function musicNext() {
  if (!music.order.length) return;
  music.idx = (music.idx + 1) % music.order.length;
  if (music.idx === 0) musicShuffle();
  musicPlayCurrent();
}

function musicStopPlayback() {
  if (!music.audio) return;
  music.audio.pause();
  music.audio.removeAttribute("src");
  delete music.audio.dataset.track;
  if (music.url) { URL.revokeObjectURL(music.url); music.url = null; }
}

/* called on every focus tick and state change - cheap when nothing changes */
async function syncMusic() {
  if (!musicWanted()) {
    if (music.audio && !music.audio.paused) music.audio.pause();
    if (!ui.focus) musicStopPlayback();
    return;
  }
  if (music.busy) return;
  if (music.audio?.dataset.track) {
    if (music.audio.paused) music.audio.play().catch(() => {});
    return;
  }
  music.busy = true;
  try {
    await musicLoadNames();
    if (music.names.length) await musicPlayCurrent();
  } finally {
    music.busy = false;
  }
}

function setMusicOn(on) {
  db.settings = db.settings || {};
  db.settings.music = on;
  save(on ? "Music on" : "Music off");
  syncMusic();
  renderMusicRow();
}

async function toggleMusic() {
  if (db.settings?.music === true) { setMusicOn(false); return; }
  await musicLoadNames();
  if (!music.names.length && !(await musicChooseFolder())) { renderMusicRow(); return; }
  setMusicOn(true);
}

/* the small row under the mode switch: toggle, the track that plays, skip, folder */
function renderMusicRow() {
  const host = $("#focus-music");
  if (!host) return;
  const on = db.settings?.music === true;
  const track = music.audio?.dataset.track;
  host.classList.toggle("on", on);
  host.innerHTML = `
    <button class="fm-toggle" id="fm-toggle" title="Play your own focus tracks (M)">
      <span class="fm-icon" aria-hidden="true">♪</span>${on ? "Music on" : "Music"}</button>
    ${on && track ? `<span class="fm-track" title="${esc(track)}">${esc(musicTitle(track))}</span>
      <button class="fm-btn" id="fm-skip" title="Next track" aria-label="Next track">⏭</button>` : ""}
    ${on ? `<button class="fm-btn" id="fm-folder" title="Pick another folder, or forget the music" aria-label="Music folder">⋯</button>` : ""}`;
  $("#fm-toggle", host).addEventListener("click", toggleMusic);
  $("#fm-skip", host)?.addEventListener("click", musicNext);
  $("#fm-folder", host)?.addEventListener("click", (e) => openMusicMenu(e.currentTarget));
}

function openMusicMenu(anchor) {
  closeQuestMenu();
  const menu = document.createElement("div");
  menu.className = "qmenu";
  menu.id = "qmenu";
  menu.innerHTML =
    `<button data-a="pick">♪ ${musicTouch() ? "Pick other tracks…" : "Pick another folder…"}</button>` +
    `<button data-a="forget">Forget the music here</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = clamp(r.left, 8, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = clamp(r.top - menu.offsetHeight - 6, 8, innerHeight - menu.offsetHeight - 8) + "px";
  $$("button", menu).forEach((b) => b.addEventListener("click", async () => {
    closeQuestMenu();
    if (b.dataset.a === "pick") { if (await musicChooseFolder()) { syncMusic(); renderMusicRow(); } }
    else musicForget();
  }));
  setTimeout(() => document.addEventListener("pointerdown", qmenuDismiss, { once: true }), 0);
}

/* ============================================================
   BACKUP - your months of logged hours, in one file
   ============================================================ */

function confirmDialog({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "confirm-overlay";
    wrap.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="confirm-title">${esc(title)}</div>
        <div class="confirm-body">${body}</div>
        <div class="confirm-row">
          ${cancelLabel ? `<button class="form-btn ghost" data-a="no">${esc(cancelLabel)}</button>` : ""}
          <button class="form-btn ${danger ? "danger-solid" : ""}" data-a="yes">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(false); }
      else if (e.key === "Enter") { e.stopPropagation(); done(true); }
    };
    document.addEventListener("keydown", onKey, true);
    wrap.addEventListener("pointerdown", (e) => { if (e.target === wrap) done(false); });
    $$("button[data-a]", wrap).forEach((b) =>
      b.addEventListener("click", () => done(b.dataset.a === "yes"))
    );
    $('button[data-a="yes"]', wrap).focus();
  });
}

function exportBackup() {
  const stamp = ymd(Date.now());
  const payload = {
    app: "questlog",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    data: db,
  };
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `questlog-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    sfx.check();
    const n = db.sessions.length;
    toast(`Backup saved - <span class="gold">questlog-${stamp}.json</span> · ${n} logged sessions`, 4500);
  } catch (e) {
    toast("Couldn't create the backup file.", 4000);
  }
}

/* an old or partial backup must not leave the app in a broken state */
function normalizeImported(d) {
  return {
    seedVersion: 4,
    quests: Array.isArray(d.quests) ? d.quests : [],
    tasks: Array.isArray(d.tasks) ? d.tasks : [],
    sessions: Array.isArray(d.sessions) ? d.sessions : [],
    habits: Array.isArray(d.habits) ? d.habits : [],
    blocks: Array.isArray(d.blocks) ? d.blocks : [],
    cookies: Array.isArray(d.cookies) ? d.cookies : [],
    settings: d.settings && typeof d.settings === "object" ? d.settings : { sound: true },
    progress: d.progress && typeof d.progress === "object"
      ? d.progress : { levels: {}, weekBeaten: null, dayBeaten: null },
  };
}

function emptyDb() {
  return {
    seedVersion: 4,
    quests: [], tasks: [], sessions: [], habits: [], blocks: [], cookies: [], beliefs: [], reviews: [], weekGoals: [], metrics: [],
    settings: { sound: db?.settings?.sound !== false, showUpcoming: false },
    progress: { levels: {}, weekBeaten: null, dayBeaten: null },
  };
}

async function startFresh() {
  const ok = await confirmDialog({
    title: "Clear everything and start from scratch?",
    danger: true,
    confirmLabel: "Clear it all",
    body: `<p>Every quest, task, logged session, habit and cookie is removed - the app starts empty, ready for your own data.${cloud.cfg ? " On every synced device." : ""}</p>
           <p class="cf-warn">⌘Z brings it all back if you change your mind.</p>`,
  });
  if (!ok) return;
  db = emptyDb();
  save("Start fresh");
  ui.selectedTaskId = null;
  ui.upcomingExpanded = false;
  ui.tlDate = null;
  setView("today");
  toast("Empty. The first task you write is the real one.", 5000, undoLast);
}

function importBackup() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.style.display = "none";
  document.body.appendChild(input);

  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => toast("Couldn't read that file.", 4000);
    reader.onload = async () => {
      let payload;
      try { payload = JSON.parse(String(reader.result)); }
      catch (e) { toast("That file isn't valid JSON.", 4500); return; }

      const data = payload && payload.data ? payload.data : payload;
      if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.sessions)) {
        toast("That doesn't look like a Questlog backup.", 5000);
        return;
      }

      const when = payload.exportedAt
        ? new Date(payload.exportedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
        : "an unknown date";
      const hours = data.sessions.reduce((a, s) => a + (s.end - s.start) / 3600000, 0);

      const ok = await confirmDialog({
        title: "Replace everything with this backup?",
        danger: true,
        confirmLabel: "Replace",
        body: `<p>From <b>${esc(when)}</b> - ${data.tasks.length} tasks, ${data.sessions.length} logged
               sessions, ${hours.toFixed(1)}h in total.</p>
               <p class="cf-warn">Your current data is replaced${cloud.cfg ? " on every synced device" : ""}. You can undo this with ⌘Z.</p>`,
      });
      if (!ok) return;

      db = normalizeImported(data);
      save("Import backup");
      ui.selectedTaskId = null;
      renderAll();
      sfx.levelUp();
      toast(`Restored ${data.sessions.length} sessions from ${esc(when)}.`, 6000, undoLast);
    };
    reader.readAsText(file);
  });
  input.click();
}

function openBackupMenu(anchor) {
  closeQuestMenu();
  const menu = document.createElement("div");
  menu.className = "qmenu";
  menu.id = "qmenu";
  menu.innerHTML =
    `<button data-a="export">⤓ Export backup<span class="qm-hint">.json</span></button>` +
    `<button data-a="import">⤒ Import backup…</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = clamp(r.left, 8, innerWidth - menu.offsetWidth - 8) + "px";
  menu.style.top = clamp(r.top - menu.offsetHeight - 6, 8, innerHeight - menu.offsetHeight - 8) + "px";
  $$("button", menu).forEach((b) =>
    b.addEventListener("click", () => {
      closeQuestMenu();
      b.dataset.a === "export" ? exportBackup() : importBackup();
    })
  );
  setTimeout(() => document.addEventListener("pointerdown", qmenuDismiss, { once: true }), 0);
}

/* ============================================================
   COMMAND PALETTE
   ============================================================ */

function paletteItems() {
  const items = [
    { icon: "◉", label: "Instant focus - start a timer now", hint: "⌥F", run: startInstantFocus },
    { icon: "☀", label: "Go to Today", hint: "2", run: () => setView("today") },
    { icon: "◆", label: "Go to Quests", hint: "3", run: () => setView("quests") },
    { icon: "✦", label: "Go to Priming", hint: "5", run: () => setView("priming") },
    { icon: "◷", label: "Weekly review", run: () => openReview(startOfWeek(Date.now()), true) },
    { icon: "▤", label: "Go to Day log", hint: "1", run: () => setView("timeline") },
    { icon: "＋", label: "New task", hint: "N", run: () => { setView("today"); setTimeout(() => $("#quick-add-input")?.focus(), 50); } },
    { icon: "◇", label: "New quest", run: () => { setView("quests"); setTimeout(() => $(".new-quest-card")?.click(), 50); } },
  ];
  for (const t of todayTasks().filter((x) => !x.done)) {
    const q = questById(t.questId);
    items.push({
      icon: `<span class="dot" style="background:${q ? q.color : "#6f6656"}"></span>`,
      label: `Focus: ${t.title}`,
      hint: q ? q.name : "",
      run: () => enterFocus(t.id),
    });
  }
  if (history.past.length) {
    items.push({ icon: "↶", label: `Undo: ${history.past[history.past.length - 1].label}`, hint: "⌘Z", run: undoLast });
  }
  if (history.future.length) {
    items.push({ icon: "↷", label: `Redo: ${history.future[history.future.length - 1].label}`, hint: "⇧⌘Z", run: redoLast });
  }
  items.push({ icon: "⤓", label: "Export backup - save everything to a file", run: exportBackup });
  items.push({ icon: "⤒", label: "Import backup - restore from a file", run: importBackup });
  if (todaysBelief()) {
    items.push({ icon: "✦", label: "Show today's priming screen", run: () => openPriming(todaysBelief(), true) });
  }
  if (ON_MAC_SERVER && db.settings?.askDeepwork === false) {
    items.push({ icon: "⛨", label: "Ask about deep work again when focusing", run: () => {
      db.settings.askDeepwork = true; saveQuiet();
      toast("Questlog will ask again when you start a focus session.", 3000);
    } });
  }
  if (ON_MAC_SERVER) items.push({ icon: "⛨", label: "Deep work - block distractions now", run: async () => {
    const a = await askDeepwork(1);
    if (a) await runDeepwork(a);
  } });
  items.push(...cloudPaletteItems());
  items.push({ icon: "○", label: "Start fresh - clear all data", run: startFresh });
  items.push({ icon: "↺", label: "Load the demo data (replaces everything)", run: async () => {
    const ok = await confirmDialog({
      title: "Replace your data with the demo set?",
      danger: true, confirmLabel: "Load demo",
      body: `<p>This overwrites everything ${cloud.cfg ? "- on every synced device" : "currently in this browser"}.</p>
             <p class="cf-warn">Undo with Cmd+Z.</p>`,
    });
    if (!ok) return;
    db = seed();
    save("Load demo data");
    renderAll();
  } });
  return items;
}

let paletteFiltered = [];

function openPalette() {
  $("#palette-overlay").classList.remove("hidden");
  const input = $("#palette-input");
  input.value = "";
  ui.paletteIndex = 0;
  renderPaletteList("");
  input.focus();
}
function closePalette() { $("#palette-overlay").classList.add("hidden"); $("#palette-input").blur(); }

function fuzzyMatch(needle, hay) {
  needle = needle.toLowerCase(); hay = hay.toLowerCase();
  let i = 0;
  for (const c of hay) { if (c === needle[i]) i++; if (i === needle.length) return true; }
  return needle.length === 0;
}

function renderPaletteList(q) {
  paletteFiltered = paletteItems().filter((it) => fuzzyMatch(q, it.label));
  ui.paletteIndex = clamp(ui.paletteIndex, 0, Math.max(0, paletteFiltered.length - 1));
  $("#palette-list").innerHTML = paletteFiltered.map((it, i) => `
    <button class="palette-item ${i === ui.paletteIndex ? "selected" : ""}" data-i="${i}">
      <span class="pi-icon">${it.icon}</span>
      <span class="pi-label">${esc(it.label)}</span>
      ${it.hint ? `<span class="pi-hint">${esc(it.hint)}</span>` : ""}
    </button>`).join("") || `<div class="empty-note">No matches.</div>`;
  $$(".palette-item").forEach((b) =>
    b.addEventListener("click", () => { closePalette(); paletteFiltered[+b.dataset.i].run(); })
  );
}

function setupPalette() {
  $("#palette-input").addEventListener("input", (e) => { ui.paletteIndex = 0; renderPaletteList(e.target.value); });
  $("#palette-input").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); ui.paletteIndex++; renderPaletteList(e.target.value); }
    else if (e.key === "ArrowUp") { e.preventDefault(); ui.paletteIndex--; renderPaletteList(e.target.value); }
    else if (e.key === "Enter") { e.preventDefault(); const it = paletteFiltered[ui.paletteIndex]; if (it) { closePalette(); it.run(); } }
    else if (e.key === "Escape") closePalette();
  });
  $("#palette-overlay").addEventListener("pointerdown", (e) => { if (e.target.id === "palette-overlay") closePalette(); });
}

/* ============================================================
   FOCUS BLOCK REMINDERS - the plan taps you on the shoulder
   ============================================================ */

const remindedBlocks = new Set();

function checkBlockReminders() {
  if (ui.focus && ui.focus.segStart) return; // already deep in work
  const now = Date.now();
  for (const b of todayBlocks()) {
    if (remindedBlocks.has(b.id)) continue;
    // remind within the first 15 minutes of a planned block
    if (now >= b.start && now < b.end && now - b.start < 15 * 60000) {
      remindedBlocks.add(b.id);
      const idx = todayBlocks().findIndex((x) => x.id === b.id);
      const open = (b.taskIds || []).map(taskById).filter((t) => t && !t.done);
      toast(
        `<span class="gold">Focus ${ROMAN[idx]}</span> is starting - ${open.length ? `${open.length} task${open.length > 1 ? "s" : ""} packed` : "nothing packed yet"}`,
        12000,
        () => {
          if (open[0]) enterFocus(open[0].id, b.id);
          else { ui.tlDate = null; setView("timeline"); }
        },
        "Start focus"
      );
      break; // one reminder at a time
    }
  }
}

/* ============================================================
   NAVIGATION & KEYBOARD
   ============================================================ */

function setView(v) {
  // clicking a nav entry always lands on that section's main page
  ui.view = v;
  ui.questDetail = null;
  if (v === "timeline") ui.tlDate = null;
  ui.tlScrollDay = null;   // coming back to the Day log starts at the morning again
  ui.animateList = true;
  closeQuestMenu();
  closeNav();
  renderAll();
}

function closeNav() {
  document.body.classList.remove("nav-open");
  $("#nav-toggle")?.setAttribute("aria-expanded", "false");
}

function renderAll() {
  $$(".nav-item").forEach((b) => b.classList.toggle("on", b.dataset.view === ui.view));
  renderHeader();
  renderHabits();
  if (ui.view === "today") renderToday();
  else if (ui.view === "quests") renderQuests();
  else if (ui.view === "cookies") renderCookies();
  else if (ui.view === "priming") renderPriming();
  else renderTimeline();
}

function moveSelection(dir) {
  const open = todayTasks().filter((t) => !t.done);
  if (!open.length) return;
  let idx = open.findIndex((t) => t.id === ui.selectedTaskId);
  idx = idx === -1 ? (dir > 0 ? 0 : open.length - 1) : clamp(idx + dir, 0, open.length - 1);
  ui.selectedTaskId = open[idx].id;
  refreshSelection();
  $(`.task-row[data-id="${ui.selectedTaskId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setupKeyboard() {
  document.addEventListener("keydown", (e) => {
    if ($("#priming-overlay")) return; // the morning screen owns the keyboard
    const inPalette = !$("#palette-overlay").classList.contains("hidden");
    const inFocus = !$("#focus-overlay").classList.contains("hidden");
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "");

    // command palette - always available
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      inPalette ? closePalette() : openPalette();
      return;
    }
    // ⌥F starts focusing on the spot, from anywhere
    if (e.altKey && e.code === "KeyF" && !typing) {
      e.preventDefault();
      startInstantFocus();
      return;
    }
    if (e.key === "Escape" && $("#fb-detail")) { closeFbDetail(); return; }
    // real history: ⌘Z undo, ⇧⌘Z / ⌘Y redo
    if ((e.metaKey || e.ctrlKey) && !typing && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
      e.preventDefault();
      if (e.key.toLowerCase() === "y" || e.shiftKey) redoLast();
      else undoLast();
      return;
    }
    if (inPalette) return; // palette input handles its own keys

    if (inFocus) {
      if (e.key === " ") { e.preventDefault(); pauseFocus(); }
      else if (e.key.toLowerCase() === "m" && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); toggleMusic(); }
      else if (e.key.toLowerCase() === "c") completeFocus();
      else if (e.key === "Escape") exitFocus();
      return;
    }

    if (typing) return;

    switch (e.key) {
      case "1": setView("timeline"); break;
      case "2": setView("today"); break;
      case "3": setView("quests"); break;
      case "4": setView("cookies"); break;
      case "5": setView("priming"); break;
      case "n": case "N": case "a": case "A":
        if (ui.view !== "today") setView("today");
        e.preventDefault();
        $("#quick-add-input")?.focus();
        break;
      case "j": case "ArrowDown":
        if (ui.view === "today") { e.preventDefault(); moveSelection(1); }
        break;
      case "k": case "ArrowUp":
        if (ui.view === "today") { e.preventDefault(); moveSelection(-1); }
        break;
      case "f": case "F":
        if (ui.selectedTaskId) enterFocus(ui.selectedTaskId);
        break;
      case "e": case "E":
        if (ui.view === "today" && ui.selectedTaskId) {
          e.preventDefault();
          const row = $(`.task-row[data-id="${ui.selectedTaskId}"]`);
          if (row) startRename(ui.selectedTaskId, row);
        }
        break;
      case "Delete": case "Backspace":
        if (ui.view === "today" && ui.selectedTaskId) {
          e.preventDefault();
          deleteTask(ui.selectedTaskId);
        }
        break;
      case "ArrowLeft":
        if (ui.view === "timeline") { e.preventDefault(); tlShiftDay(-1); }
        break;
      case "ArrowRight":
        if (ui.view === "timeline") { e.preventDefault(); tlShiftDay(1); }
        break;
      case " ": case "x": case "X":
        if (ui.view === "today" && ui.selectedTaskId) {
          e.preventDefault();
          toggleDone(ui.selectedTaskId, $(`.task-row[data-id="${ui.selectedTaskId}"] .task-check`));
        }
        break;
      case "Escape": closeQuestMenu(); closeTlForm(); closeHabitPop(); closeFbDetail(); break;
    }
  });
}

/* ============================================================
   BOOT
   ============================================================ */

function boot() {
  load();
  loadHistory();
  applyPomoSettings();
  addEventListener("pagehide", () => { checkpointNow(); persistHistory(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { checkpointNow(); persistHistory(); }
  });
  $$(".nav-item").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  setupHabitForm();
  setupFocusControls();
  setupPalette();
  setupKeyboard();
  ui.upcomingExpanded = db.settings?.showUpcoming === true;
  const firstOpen = todayTasks().find((t) => !t.done);
  if (firstOpen) ui.selectedTaskId = firstOpen.id;
  // browsers only allow audio after a gesture - take the first one we get
  const unlock = () => sfx.unlock();
  addEventListener("pointerdown", unlock, { once: true });
  addEventListener("keydown", unlock, { once: true });

  const soundBtn = $("#sound-toggle");
  const syncSound = () => {
    const on = db.settings?.sound !== false;
    soundBtn.classList.toggle("muted", !on);
    $(".st-icon", soundBtn).textContent = on ? "♪" : "♪̸";
    $(".st-label", soundBtn).textContent = on ? "Sound on" : "Muted";
  };
  soundBtn.addEventListener("click", () => {
    db.settings = db.settings || {};
    db.settings.sound = db.settings.sound === false;
    save(db.settings.sound ? "Sound on" : "Mute");
    syncSound();
    if (db.settings.sound) { sfx.unlock(); sfx.check(); }
  });
  syncSound();

  $("#backup-btn").addEventListener("click", (e) => openBackupMenu(e.currentTarget));

  $("#nav-toggle").addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    $("#nav-toggle").setAttribute("aria-expanded", String(open));
  });
  addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("nav-open")) return;
    if (e.target.closest("#sidebar, #nav-toggle")) return;
    closeNav();
  });

  $("#instant-focus").addEventListener("click", startInstantFocus);
  $("#live-chip").addEventListener("click", () => { if (ui.focus) openFocusOverlay(); });
  $(".lc-stop").addEventListener("click", (e) => { e.stopPropagation(); stopFocusTimer(); });
  renderAll();
  // priming and review decide from the freshest state - another device may have done them already
  cloudBoot().finally(() => {
    syncPhoneTimer();   // a reload ends any running pomodoro - clear a reminder left behind
    maybeShowPriming();
    setTimeout(maybeShowReview, 1200);
  });
  setInterval(maybeShowReview, 5 * 60000);
  // keep the header honest, and let planned blocks speak up
  setInterval(renderHeader, 60000);
  checkBlockReminders();
  setInterval(checkBlockReminders, 30000);
  // the Mac-side scripts must not depend on a save happening - opening the app is enough
  syncStateToServer();
  setInterval(syncStateToServer, 5 * 60000);
}

boot();
