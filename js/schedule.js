/**
 * SM-2 style scheduling in localStorage.
 * Stores only card ids and scheduling fields — never decrypted card text.
 */
export const STORAGE_KEY = "kc-revise-v1";
export const DEFAULT_NEW_PER_DAY = 20;
export const MASTERED_INTERVAL_DAYS = 21;

const GRADES = {
  again: 1,
  hard: 3,
  good: 4,
  easy: 5,
};

const SCHEDULE_FIELDS = ["ease", "interval", "reps", "lapses", "due", "last", "lastGrade", "introducedOn"];

export function localDayStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function endOfLocalDay(date = new Date()) {
  return startOfLocalDay(date) + 24 * 60 * 60 * 1000 - 1;
}

function emptyStore() {
  return { v: 1, settings: { newPerDay: DEFAULT_NEW_PER_DAY, scope: null }, cards: {} };
}

function sanitizeStringList(v, max = 200) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string" && x.length > 0 && x.length < 120).slice(0, max);
}

export function sanitizeScope(raw) {
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode === "practice" || raw.mode === "keypoints" ? raw.mode : "flashcards";
  return {
    branchIds: sanitizeStringList(raw.branchIds),
    sectionIds: sanitizeStringList(raw.sectionIds),
    domainIds: sanitizeStringList(raw.domainIds),
    mode,
  };
}

function coerceNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeCard(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {
    ease: Math.max(1.3, coerceNumber(raw.ease, 2.5)),
    interval: Math.max(0, coerceNumber(raw.interval, 0)),
    reps: Math.max(0, Math.round(coerceNumber(raw.reps, 0))),
    lapses: Math.max(0, Math.round(coerceNumber(raw.lapses, 0))),
    due: coerceNumber(raw.due, 0),
    last: coerceNumber(raw.last, 0),
    lastGrade: ["again", "hard", "good", "easy"].includes(raw.lastGrade) ? raw.lastGrade : null,
    introducedOn: typeof raw.introducedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.introducedOn)
      ? raw.introducedOn
      : null,
  };
  return out;
}

function sanitizeStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== "object") return store;
  const n = coerceNumber(raw.settings?.newPerDay, DEFAULT_NEW_PER_DAY);
  store.settings.newPerDay = Math.min(200, Math.max(0, Math.round(n)));
  store.settings.scope = sanitizeScope(raw.settings?.scope);
  const cards = raw.cards && typeof raw.cards === "object" ? raw.cards : {};
  for (const [id, rec] of Object.entries(cards)) {
    if (typeof id !== "string" || !/^[qt]:[^:]+:/.test(id)) continue;
    const clean = sanitizeCard(rec);
    if (clean) store.cards[id] = clean;
  }
  return store;
}

export function loadStore(storage) {
  const src = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!src) return emptyStore();
  try {
    const raw = src.getItem(STORAGE_KEY);
    if (!raw) return emptyStore();
    return sanitizeStore(JSON.parse(raw));
  } catch {
    return emptyStore();
  }
}

export function saveStore(store, storage) {
  const src = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!src) return;
  const safe = sanitizeStore(store);
  src.setItem(STORAGE_KEY, JSON.stringify(safe));
}

export function getNewPerDay(store) {
  return store?.settings?.newPerDay ?? DEFAULT_NEW_PER_DAY;
}

export function setNewPerDay(store, n) {
  store.settings = store.settings || {};
  store.settings.newPerDay = Math.min(200, Math.max(0, Math.round(Number(n) || 0)));
  return store.settings.newPerDay;
}

export function isNew(rec) {
  return !rec || (!rec.last && !rec.introducedOn);
}

export function isDue(rec, now = Date.now()) {
  if (!rec || isNew(rec)) return false;
  const due = rec.due || 0;
  return due <= endOfLocalDay(new Date(now));
}

export function isMastered(rec) {
  if (!rec) return false;
  return rec.interval >= MASTERED_INTERVAL_DAYS && (rec.lastGrade === "good" || rec.lastGrade === "easy");
}

export function introducedTodayCount(store, now = Date.now()) {
  const day = localDayStamp(new Date(now));
  let n = 0;
  for (const rec of Object.values(store.cards || {})) {
    if (rec?.introducedOn === day) n += 1;
  }
  return n;
}

export function remainingNewToday(store, now = Date.now()) {
  return Math.max(0, getNewPerDay(store) - introducedTodayCount(store, now));
}

export function markIntroduced(store, cardId, now = Date.now()) {
  const rec = store.cards[cardId] || (store.cards[cardId] = sanitizeCard({ ease: 2.5 }));
  if (!rec.introducedOn) rec.introducedOn = localDayStamp(new Date(now));
  return rec;
}

/** SM-2 interval update. Again requeues for the same day (due now). */
export function review(store, cardId, grade, now = Date.now()) {
  if (!["again", "hard", "good", "easy"].includes(grade)) return null;
  const rec = store.cards[cardId] || (store.cards[cardId] = sanitizeCard({ ease: 2.5 }));
  if (!rec.introducedOn) rec.introducedOn = localDayStamp(new Date(now));
  const q = GRADES[grade];
  let ease = rec.ease || 2.5;
  let interval = rec.interval || 0;
  let reps = rec.reps || 0;
  let lapses = rec.lapses || 0;

  ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  ease = Math.max(1.3, ease);

  if (q < 3) {
    lapses += 1;
    reps = 0;
    interval = 0;
    rec.due = now;
  } else {
    if (reps === 0) {
      interval = grade === "easy" ? 4 : grade === "hard" ? 1 : 1;
    } else if (reps === 1) {
      interval = grade === "easy" ? 7 : grade === "hard" ? 3 : 6;
    } else {
      const mul = grade === "hard" ? Math.max(1.2, ease - 0.15) : grade === "easy" ? ease * 1.3 : ease;
      interval = Math.max(1, Math.round(interval * mul));
    }
    reps += 1;
    rec.due = startOfLocalDay(new Date(now)) + interval * 24 * 60 * 60 * 1000;
  }

  rec.ease = Math.round(ease * 1000) / 1000;
  rec.interval = interval;
  rec.reps = reps;
  rec.lapses = lapses;
  rec.last = now;
  rec.lastGrade = grade;
  return rec;
}

export function statsForCards(store, cards, now = Date.now()) {
  let total = cards.length;
  let seen = 0;
  let mastered = 0;
  let due = 0;
  let neu = 0;
  let reviewedGoodEasy = 0;
  let reviewed = 0;
  for (const card of cards) {
    const rec = store.cards[card.id];
    if (isNew(rec)) neu += 1;
    else {
      if (isDue(rec, now)) due += 1;
      if (rec.last) {
        seen += 1;
        reviewed += 1;
        if (rec.lastGrade === "good" || rec.lastGrade === "easy") reviewedGoodEasy += 1;
      } else {
        seen += rec.introducedOn ? 1 : 0;
      }
      if (isMastered(rec)) mastered += 1;
    }
  }
  const readiness = reviewed ? Math.round((1000 * reviewedGoodEasy) / reviewed) / 10 : null;
  return { total, seen, mastered, due, new: neu, reviewed, reviewedGoodEasy, readiness };
}

export function buildQueue(store, cards, now = Date.now()) {
  const due = [];
  const fresh = [];
  for (const card of cards) {
    const rec = store.cards[card.id];
    if (isNew(rec)) fresh.push(card);
    else if (isDue(rec, now)) due.push(card);
  }
  due.sort((a, b) => {
    const da = store.cards[a.id]?.due || 0;
    const db = store.cards[b.id]?.due || 0;
    return da - db || a.id.localeCompare(b.id);
  });
  fresh.sort((a, b) => a.id.localeCompare(b.id));
  const leftoverNew = [];
  const already = [];
  const today = localDayStamp(new Date(now));
  for (const card of fresh) {
    const rec = store.cards[card.id];
    if (rec?.introducedOn === today) already.push(card);
    else leftoverNew.push(card);
  }
  const cap = remainingNewToday(store, now);
  const introduce = leftoverNew.slice(0, cap);
  return [...due, ...already, ...introduce];
}

export function resetProgress(store) {
  store.cards = {};
  return store;
}

export function exportProgress(store) {
  const safe = sanitizeStore(store);
  return JSON.stringify({ v: 1, exportedAt: new Date().toISOString(), settings: safe.settings, cards: safe.cards }, null, 2);
}

export function importProgress(raw, { replace = true } = {}) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const incoming = sanitizeStore(parsed);
  if (replace) return incoming;
  const store = emptyStore();
  store.settings = incoming.settings;
  return store;
}

export function mergeImport(current, raw, { replace = true } = {}) {
  const incoming = importProgress(raw, { replace: true });
  if (replace) return incoming;
  const store = sanitizeStore(current);
  store.settings = incoming.settings;
  Object.assign(store.cards, incoming.cards);
  return store;
}

export { SCHEDULE_FIELDS, emptyStore, sanitizeStore };
