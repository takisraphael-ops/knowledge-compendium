/**
 * Cross-device study progress: SRS, mock-exam history, bookmarks, recent
 * topics, personal scratch notes, PBQ scores, and UI prefs. Compendium topic
 * text is never stored here. Personal notes are the reader's own `kc-notes-v1`
 * map. PBQ scores are the reader's own `kc-pbq-v1` map.
 */
import { decryptJson, encryptJson } from "./crypto.js";
import { loadPbqProgress, mergePbqProgress, sanitizePbqProgress, savePbqProgress } from "./pbq.js";
import { loadStore, sanitizeScope, sanitizeStore, saveStore } from "./schedule.js";

export const PROGRESS_VERSION = 1;
export const PROGRESS_AAD = "kc-progress-v1";
export const BOOKMARKS_KEY = "kc-bookmarks-v1";
export const RECENT_KEY = "kc-recent-v1";
export const NOTES_KEY = "kc-notes-v1";
export const MOCK_HISTORY_KEY = "kc-mock-history-v1";
export const NOTE_TEXT_CAP = 50000;
export const THEME_KEY = "kc-theme-v1";
export const VIEW_MODE_KEY = "kc-view-mode-v1";
export const AUTOFOLD_KEY = "kc-autofold-v1";
export const HISTORY_CAP = 50;
export const RECENT_CAP = 40;
export const BOOKMARK_CAP = 500;
/** Study stand-in for a 750/900 scaled score. */
export const PASS_PCT = 83;

const ID_RE = /^[a-zA-Z0-9:_./-]+$/;

function progressError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

export function cleanId(id, max = 120) {
  if (typeof id !== "string") return "";
  const s = id.trim();
  if (!s || s.length > max || !ID_RE.test(s)) return "";
  return s;
}

function coerceNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readJson(storage, key) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function sanitizeBookmarks(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.ids) ? raw.ids : [];
  const out = [];
  const seen = new Set();
  for (const id of list) {
    const clean = cleanId(id);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= BOOKMARK_CAP) break;
  }
  return out;
}

/** `{ [nodeId]: { text, updatedAt } }`. Blank notes are removed. */
export function sanitizeNotes(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [id, rec] of Object.entries(src)) {
    const clean = cleanId(id);
    if (!clean || !rec || typeof rec !== "object" || typeof rec.text !== "string") continue;
    const text = rec.text.length > NOTE_TEXT_CAP ? rec.text.slice(0, NOTE_TEXT_CAP) : rec.text;
    if (!text.trim()) continue;
    const at = Number(rec.updatedAt);
    const prev = out[clean];
    const note = { text, updatedAt: Number.isFinite(at) ? at : 0 };
    if (!prev || note.updatedAt >= prev.updatedAt) out[clean] = note;
  }
  return out;
}

/** Per-node newest `updatedAt` wins. A missing side keeps the side that has the note. */
export function mergeNotes(current, incoming) {
  const cur = sanitizeNotes(current);
  const inc = sanitizeNotes(incoming);
  const out = { ...cur };
  for (const [id, note] of Object.entries(inc)) {
    const prev = out[id];
    if (!prev || note.updatedAt > prev.updatedAt) out[id] = note;
  }
  return out;
}

export function loadNotes(storage) {
  return sanitizeNotes(readJson(storage, NOTES_KEY));
}

export function saveNotes(notes, storage) {
  const safe = sanitizeNotes(notes);
  if (storage) {
    if (Object.keys(safe).length) storage.setItem(NOTES_KEY, JSON.stringify(safe));
    else storage.removeItem?.(NOTES_KEY);
  }
  return safe;
}

/** Write one scratch note. An empty trimmed value deletes that topic's entry. */
export function upsertNote(storage, id, text, now = Date.now()) {
  const clean = cleanId(id);
  const all = loadNotes(storage);
  if (!clean) return all;
  const body = typeof text === "string" ? text : "";
  if (!body.trim()) delete all[clean];
  else all[clean] = { text: body.length > NOTE_TEXT_CAP ? body.slice(0, NOTE_TEXT_CAP) : body, updatedAt: now };
  return saveNotes(all, storage);
}

export function sanitizeRecent(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const id = cleanId(typeof item === "string" ? item : item?.id);
    if (!id || seen.has(id)) continue;
    const atRaw = typeof item === "object" && item ? Number(item.at) : NaN;
    const at = Number.isFinite(atRaw) ? atRaw : 0;
    seen.add(id);
    out.push({ id, at });
    if (out.length >= RECENT_CAP) break;
  }
  return out;
}

/** Partial prefs: only keys that were actually present and valid. */
export function sanitizePrefs(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const prefs = {};
  if (src.theme === "dark" || src.theme === "light") prefs.theme = src.theme;
  if (src.viewMode === "map" || src.viewMode === "outline") prefs.viewMode = src.viewMode;
  if (typeof src.autoFold === "boolean") prefs.autoFold = src.autoFold;
  else if (src.autoFold === "0" || src.autoFold === "1" || src.autoFold === "false" || src.autoFold === "true") {
    prefs.autoFold = src.autoFold === "1" || src.autoFold === "true";
  }
  if (src.examVersion === "701" || src.examVersion === "801") prefs.examVersion = src.examVersion;
  return prefs;
}

export function normalizePrefs(raw) {
  const p = sanitizePrefs(raw);
  return {
    theme: p.theme || "light",
    viewMode: p.viewMode || "map",
    autoFold: p.autoFold !== false,
    examVersion: p.examVersion === "701" ? "701" : "801",
  };
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(coerceNumber(v, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function sanitizeAttempt(raw) {
  if (!raw || typeof raw !== "object") return null;
  const date = typeof raw.date === "string" ? raw.date.trim() : "";
  const when = Date.parse(date);
  if (!date || Number.isNaN(when)) return null;
  const examVersion = raw.examVersion === "701" ? "701" : "801";
  const total = clampInt(raw.total, 0, 500, 0);
  if (!total) return null;
  const correct = clampInt(raw.correct, 0, total, 0);
  const pct = total ? Math.round((100 * correct) / total) : 0;
  const domains = [];
  const seen = new Set();
  for (const row of Array.isArray(raw.domains) ? raw.domains : []) {
    const id = cleanId(row?.id, 80);
    if (!id || seen.has(id)) continue;
    const dTotal = clampInt(row?.total, 0, 500, 0);
    if (!dTotal) continue;
    const dCorrect = clampInt(row?.correct, 0, dTotal, 0);
    const label = typeof row?.label === "string" ? row.label.replace(/\s+/g, " ").trim().slice(0, 160) : id;
    seen.add(id);
    domains.push({
      id,
      label: label || id,
      correct: dCorrect,
      total: dTotal,
      pct: Math.round((100 * dCorrect) / dTotal),
    });
  }
  const id = cleanId(raw.id, 80) || `m-${when.toString(36)}`;
  return {
    id,
    date: new Date(when).toISOString(),
    examVersion,
    length: clampInt(raw.length, 1, 500, total),
    total,
    correct,
    pct,
    passed: pct >= PASS_PCT,
    durationSec: clampInt(raw.durationSec, 0, 172800, 0),
    domains,
  };
}

export function sanitizeHistory(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of list) {
    const clean = sanitizeAttempt(row);
    if (!clean) continue;
    const idx = out.findIndex((item) => sameAttempt(item, clean));
    if (idx === -1) out.push(clean);
    else out[idx] = preferAttempt(out[idx], clean);
    if (out.length > HISTORY_CAP * 2) break;
  }
  out.sort(byDateDesc);
  return out.slice(0, HISTORY_CAP);
}

function byDateDesc(a, b) {
  const c = String(b.date).localeCompare(String(a.date));
  if (c) return c;
  return String(a.id).localeCompare(String(b.id));
}

export function sameAttempt(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.date && b.date && a.date === b.date && a.examVersion === b.examVersion) return true;
  return false;
}

function preferAttempt(a, b) {
  return String(b.date) > String(a.date) ? b : a;
}

export function reviewWeight(rec) {
  if (!rec) return { reviews: 0, last: 0 };
  return {
    reviews: (rec.reps || 0) + (rec.lapses || 0),
    last: rec.last || 0,
  };
}

/** Keep the card with more review events. Ties go to the newer last-review time. */
export function preferSrsCard(current, incoming) {
  if (!current) return incoming || null;
  if (!incoming) return current;
  const c = reviewWeight(current);
  const i = reviewWeight(incoming);
  if (i.reviews !== c.reviews) return i.reviews > c.reviews ? incoming : current;
  if (i.last !== c.last) return i.last > c.last ? incoming : current;
  return current;
}

export function mergeSrsStores(current, incoming) {
  const cur = sanitizeStore(current);
  const inc = sanitizeStore(incoming);
  const cards = { ...cur.cards };
  for (const [id, rec] of Object.entries(inc.cards || {})) {
    cards[id] = preferSrsCard(cards[id], rec);
  }
  cur.cards = cards;
  return sanitizeStore(cur);
}

export function mergeHistory(current, incoming) {
  return sanitizeHistory([...sanitizeHistory(incoming), ...sanitizeHistory(current)]);
}

export function mergeBookmarks(current, incoming) {
  return sanitizeBookmarks([...sanitizeBookmarks(current), ...sanitizeBookmarks(incoming)]);
}

/**
 * Union recent topics, newest activity first.
 * Items that already carry `at` sort by that time. Bare ids keep their list order
 * and sit behind anything with a real timestamp.
 */
export function mergeRecent(current, incoming) {
  const ranked = new Map();
  const consider = (item, order) => {
    const prev = ranked.get(item.id);
    if (!prev) {
      ranked.set(item.id, { id: item.id, at: item.at || 0, order });
      return;
    }
    if ((item.at || 0) > (prev.at || 0)) {
      prev.at = item.at;
      prev.order = order;
    } else if (!item.at && !prev.at && order < prev.order) {
      prev.order = order;
    }
  };
  sanitizeRecent(current).forEach((item, i) => consider(item, i));
  sanitizeRecent(incoming).forEach((item, i) => consider({ ...item, at: item.at || 0 }, i));
  return [...ranked.values()]
    .sort((a, b) => (b.at || 0) - (a.at || 0) || a.order - b.order || a.id.localeCompare(b.id))
    .slice(0, RECENT_CAP)
    .map(({ id, at }) => ({ id, at: at || 0 }));
}

export function domainPct(row) {
  const total = Number(row?.total) || 0;
  if (!total) return null;
  const correct = Number(row?.correct) || 0;
  return (100 * correct) / total;
}

/** Lowest percent. Ties prefer the domain with more questions, then the smaller id. */
export function weakestDomain(domains) {
  const rows = (domains || []).filter((d) => d && d.id && Number(d.total) > 0);
  if (!rows.length) return null;
  let best = rows[0];
  for (const row of rows.slice(1)) {
    const dp = domainPct(row);
    const bp = domainPct(best);
    if (dp < bp - 1e-9) best = row;
    else if (Math.abs(dp - bp) <= 1e-9) {
      const more = (row.total || 0) - (best.total || 0);
      if (more > 0 || (more === 0 && String(row.id) < String(best.id))) best = row;
    }
  }
  const pct = domainPct(best);
  return {
    id: best.id,
    label: best.label || best.id,
    correct: best.correct || 0,
    total: best.total || 0,
    pct: Math.round(pct),
  };
}

export function aggregateDomains(attempts) {
  const map = new Map();
  for (const attempt of attempts || []) {
    for (const domain of attempt?.domains || []) {
      if (!domain?.id || !(Number(domain.total) > 0)) continue;
      const cur = map.get(domain.id) || {
        id: domain.id,
        label: domain.label || domain.id,
        correct: 0,
        total: 0,
      };
      cur.correct += Number(domain.correct) || 0;
      cur.total += Number(domain.total) || 0;
      if (domain.label) cur.label = domain.label;
      map.set(domain.id, cur);
    }
  }
  return [...map.values()].map((d) => ({
    ...d,
    pct: d.total ? Math.round((100 * d.correct) / d.total) : 0,
  }));
}

export function attemptsForVersion(history, examVersion) {
  const ver = examVersion === "701" ? "701" : "801";
  return sanitizeHistory(history).filter((a) => a.examVersion === ver);
}

export function weakestDomainFromHistory(history, examVersion) {
  return weakestDomain(aggregateDomains(attemptsForVersion(history, examVersion)));
}

export function historySummary(history, examVersion) {
  const attempts = attemptsForVersion(history, examVersion);
  if (!attempts.length) return null;
  let best = attempts[0];
  let sum = 0;
  for (const attempt of attempts) {
    sum += attempt.pct;
    if (attempt.pct > best.pct || (attempt.pct === best.pct && String(attempt.date) > String(best.date))) {
      best = attempt;
    }
  }
  return {
    count: attempts.length,
    latest: attempts[0],
    best,
    average: Math.round(sum / attempts.length),
    weakest: weakestDomain(aggregateDomains(attempts)),
    attempts,
  };
}

function stampScope(store, examVersion) {
  const base = store.settings?.scope || {
    branchIds: [],
    sectionIds: [],
    domainIds: [],
    mode: "flashcards",
  };
  store.settings = store.settings || {};
  store.settings.scope = sanitizeScope({ ...base, examVersion: examVersion === "701" ? "701" : "801" });
  return store;
}

export function buildProgressBundle({ srs, mockHistory, bookmarks, recent, notes, pbq, prefs, exportedAt } = {}) {
  const normPrefs = normalizePrefs(prefs);
  const store = stampScope(sanitizeStore(srs), normPrefs.examVersion);
  const when = typeof exportedAt === "string" && exportedAt.trim() ? exportedAt : new Date().toISOString();
  return {
    version: PROGRESS_VERSION,
    exportedAt: when,
    srs: store,
    mockHistory: sanitizeHistory(mockHistory),
    bookmarks: sanitizeBookmarks(bookmarks),
    recent: sanitizeRecent(recent)
      .sort((a, b) => (b.at || 0) - (a.at || 0) || a.id.localeCompare(b.id))
      .slice(0, RECENT_CAP),
    notes: sanitizeNotes(notes),
    pbq: sanitizePbqProgress(pbq),
    prefs: normPrefs,
  };
}

export function coerceToBundle(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw progressError("malformed");
  const legacy = !hasOwn(raw, "version") && raw.cards && typeof raw.cards === "object";
  const versioned = raw.version === PROGRESS_VERSION && ["srs", "mockHistory", "bookmarks", "recent", "prefs", "notes", "pbq"].some((k) => hasOwn(raw, k));
  if (!legacy && !versioned) throw progressError("malformed");
  if (raw.version != null && raw.version !== PROGRESS_VERSION && !legacy) throw progressError("malformed");
  const prefs = sanitizePrefs(legacy ? {} : raw.prefs);
  const srs = sanitizeStore(legacy ? raw : raw.srs);
  return {
    version: PROGRESS_VERSION,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : new Date().toISOString(),
    srs,
    mockHistory: legacy ? [] : sanitizeHistory(raw.mockHistory),
    bookmarks: legacy ? [] : sanitizeBookmarks(raw.bookmarks),
    recent: legacy ? [] : sanitizeRecent(raw.recent),
    notes: legacy ? {} : sanitizeNotes(raw.notes),
    pbq: legacy || !hasOwn(raw, "pbq") ? {} : sanitizePbqProgress(raw.pbq),
    prefs,
    has: {
      srs: legacy || hasOwn(raw, "srs"),
      mockHistory: !legacy && hasOwn(raw, "mockHistory"),
      bookmarks: !legacy && hasOwn(raw, "bookmarks"),
      recent: !legacy && hasOwn(raw, "recent"),
      notes: !legacy && hasOwn(raw, "notes"),
      pbq: !legacy && hasOwn(raw, "pbq"),
      prefs: !legacy && hasOwn(raw, "prefs"),
    },
    legacy: Boolean(legacy),
  };
}

export function mergeProgress(localBundle, incomingRaw, { replace = false } = {}) {
  const local = buildProgressBundle(localBundle || {});
  const incoming = incomingRaw?.has && incomingRaw?.srs ? incomingRaw : coerceToBundle(incomingRaw);
  const prefs = { ...normalizePrefs(local.prefs) };
  if (incoming.prefs.theme) prefs.theme = incoming.prefs.theme;
  if (incoming.prefs.viewMode) prefs.viewMode = incoming.prefs.viewMode;
  if (typeof incoming.prefs.autoFold === "boolean") prefs.autoFold = incoming.prefs.autoFold;
  if (incoming.prefs.examVersion) prefs.examVersion = incoming.prefs.examVersion;
  const notes = incoming.has?.notes === false
    ? local.notes
    : (replace ? incoming.notes : mergeNotes(local.notes, incoming.notes));
  // A file written before PBQs existed has no `pbq` field. Leave the local map alone.
  const pbq = incoming.has?.pbq
    ? (replace ? incoming.pbq : mergePbqProgress(local.pbq, incoming.pbq))
    : local.pbq;

  if (replace) {
    return buildProgressBundle({
      exportedAt: new Date().toISOString(),
      srs: incoming.has?.srs === false ? local.srs : incoming.srs,
      mockHistory: incoming.has?.mockHistory ? incoming.mockHistory : local.mockHistory,
      bookmarks: incoming.has?.bookmarks ? incoming.bookmarks : local.bookmarks,
      recent: incoming.has?.recent ? incoming.recent : local.recent,
      notes,
      pbq,
      prefs,
    });
  }

  return buildProgressBundle({
    exportedAt: new Date().toISOString(),
    srs: mergeSrsStores(local.srs, incoming.srs),
    mockHistory: mergeHistory(local.mockHistory, incoming.mockHistory),
    bookmarks: mergeBookmarks(local.bookmarks, incoming.bookmarks),
    recent: mergeRecent(local.recent, incoming.recent),
    notes,
    pbq,
    prefs,
  });
}

export function isEncryptedEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.alg === "AES-GCM" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    !hasOwn(value, "srs") &&
    !hasOwn(value, "cards")
  );
}

export async function encryptProgress(key, bundle) {
  const safe = buildProgressBundle(bundle);
  return encryptJson(key, safe, PROGRESS_AAD);
}

export async function decryptProgress(key, envelope) {
  return decryptJson(key, envelope, PROGRESS_AAD);
}

export async function readProgressPayload(text, key) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw progressError("malformed");
  }
  if (isEncryptedEnvelope(value)) {
    if (!key) throw progressError("locked");
    let plain;
    try {
      plain = await decryptProgress(key, value);
    } catch {
      throw progressError("decrypt");
    }
    return coerceToBundle(plain);
  }
  return coerceToBundle(value);
}

export function readPrefs(storage, srs) {
  const store = srs || loadStore(storage);
  const theme = storage?.getItem?.(THEME_KEY);
  const viewMode = storage?.getItem?.(VIEW_MODE_KEY);
  const auto = storage?.getItem?.(AUTOFOLD_KEY);
  return normalizePrefs({
    theme: theme === "dark" || theme === "light" ? theme : undefined,
    viewMode: viewMode === "outline" || viewMode === "map" ? viewMode : undefined,
    autoFold: auto == null ? undefined : !(auto === "0" || auto === "false" || auto === "off"),
    examVersion: store?.settings?.scope?.examVersion,
  });
}

export function collectProgress(storage, { srs, theme, examVersion } = {}) {
  const store = srs || loadStore(storage);
  const prefs = readPrefs(storage, store);
  if (theme === "dark" || theme === "light") prefs.theme = theme;
  if (examVersion === "701" || examVersion === "801") prefs.examVersion = examVersion;
  return buildProgressBundle({
    srs: store,
    mockHistory: loadMockHistory(storage),
    bookmarks: loadBookmarks(storage),
    recent: loadRecent(storage),
    notes: loadNotes(storage),
    pbq: loadPbqProgress(storage),
    prefs,
  });
}

export function writeProgress(storage, bundle) {
  const safe = buildProgressBundle(bundle);
  if (!storage) return safe;
  saveStore(safe.srs, storage);
  storage.setItem(MOCK_HISTORY_KEY, JSON.stringify(safe.mockHistory));
  storage.setItem(BOOKMARKS_KEY, JSON.stringify(safe.bookmarks));
  storage.setItem(RECENT_KEY, JSON.stringify(safe.recent));
  saveNotes(safe.notes, storage);
  savePbqProgress(safe.pbq, storage);
  if (safe.prefs.theme) storage.setItem(THEME_KEY, safe.prefs.theme);
  if (safe.prefs.viewMode) storage.setItem(VIEW_MODE_KEY, safe.prefs.viewMode);
  storage.setItem(AUTOFOLD_KEY, safe.prefs.autoFold ? "1" : "0");
  return safe;
}

export function loadBookmarks(storage) {
  return sanitizeBookmarks(readJson(storage, BOOKMARKS_KEY));
}

export function loadRecent(storage) {
  return sanitizeRecent(readJson(storage, RECENT_KEY))
    .sort((a, b) => (b.at || 0) - (a.at || 0) || a.id.localeCompare(b.id));
}

export function loadMockHistory(storage) {
  return sanitizeHistory(readJson(storage, MOCK_HISTORY_KEY));
}

export function saveMockHistory(history, storage) {
  const safe = sanitizeHistory(history);
  storage?.setItem?.(MOCK_HISTORY_KEY, JSON.stringify(safe));
  return safe;
}

export function appendMockAttempt(history, attempt) {
  const clean = sanitizeAttempt(attempt);
  if (!clean) return sanitizeHistory(history);
  return mergeHistory(history, [clean]);
}

export function pushRecent(storage, id, now = Date.now()) {
  const clean = cleanId(id);
  const cur = loadRecent(storage);
  if (!clean) return cur;
  const next = [{ id: clean, at: now }, ...cur.filter((item) => item.id !== clean)].slice(0, RECENT_CAP);
  storage?.setItem?.(RECENT_KEY, JSON.stringify(next));
  return next;
}

export function toggleBookmark(storage, id) {
  const clean = cleanId(id);
  const cur = loadBookmarks(storage);
  if (!clean) return cur;
  const next = cur.includes(clean) ? cur.filter((item) => item !== clean) : [...cur, clean].slice(0, BOOKMARK_CAP);
  storage?.setItem?.(BOOKMARKS_KEY, JSON.stringify(next));
  return next;
}

export function isBookmarked(storage, id) {
  const clean = cleanId(id);
  if (!clean) return false;
  return loadBookmarks(storage).includes(clean);
}

export function makeAttemptId(now = Date.now()) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `m-${now.toString(36)}-${rand}`;
}

function shuffleInPlace(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = list[i];
    list[i] = list[j];
    list[j] = swap;
  }
  return list;
}

/** Draw practice cards in proportion to Security+ domain weights. */
export function pickMockQuestions(cards, domains, length, rng = Math.random) {
  const want = clampInt(length, 0, 500, 0);
  const list = (domains || []).filter((d) => d && cleanId(d.id, 80));
  if (!want || !list.length) return [];
  const pools = new Map(list.map((d) => [d.id, []]));
  for (const card of cards || []) {
    if (card?.domainId && pools.has(card.domainId)) pools.get(card.domainId).push(card);
  }
  for (const pool of pools.values()) shuffleInPlace(pool, rng);
  const weights = list.map((d) => Math.max(0, Number(d.weight) || 0));
  const weightSum = weights.reduce((sum, n) => sum + n, 0);
  const portions = weightSum
    ? list.map((_, i) => (want * weights[i]) / weightSum)
    : list.map(() => want / list.length);
  const take = portions.map((n) => Math.floor(n));
  let left = want - take.reduce((sum, n) => sum + n, 0);
  const fracOrder = portions
    .map((n, i) => ({ i, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const row of fracOrder) {
    if (left <= 0) break;
    take[row.i] += 1;
    left -= 1;
  }
  const used = take.map((n, i) => Math.min(n, pools.get(list[i].id).length));
  let spare = want - used.reduce((sum, n) => sum + n, 0);
  const order = list.map((_, i) => i).sort((a, b) => weights[b] - weights[a] || a - b);
  let guard = 0;
  while (spare > 0 && guard < want) {
    let moved = false;
    for (const i of order) {
      if (spare <= 0) break;
      if (used[i] < pools.get(list[i].id).length) {
        used[i] += 1;
        spare -= 1;
        moved = true;
      }
    }
    if (!moved) break;
    guard += 1;
  }
  const picked = [];
  list.forEach((d, i) => {
    const pool = pools.get(d.id);
    for (const card of pool.slice(0, used[i])) {
      picked.push({ ...card, domainLabel: d.label || d.id });
    }
  });
  return shuffleInPlace(picked, rng);
}
