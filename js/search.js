/**
 * In-memory full-text index for unlocked topics.
 * Built once after the branches decrypt, then patched when My notes change.
 * The index holds titles, personal notes (`kc-notes-v1`), and body text
 * (summary, original wording, tidy, expanded, key points, and key terms).
 * It is never written to disk.
 */

const FILTERS = new Set(["all", "note", "bookmark", "due"]);

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Short or ALL-CAPS queries must match a whole token, not a substring of a longer word. */
export function isAcronymAwareQuery(raw) {
  const t = String(raw || "").trim();
  if (t.length < 2) return false;
  if (/^[A-Z0-9][A-Z0-9/+\-]{1,11}$/.test(t) && /[A-Z]/.test(t)) return true;
  if (t.length <= 4 && /^[A-Za-z][A-Za-z0-9]*$/.test(t)) return true;
  return false;
}

function makeFinder(q, acronym) {
  if (!acronym) return (hay) => (hay ? hay.indexOf(q) : -1);
  const re = new RegExp("(?:^|[^a-z0-9])" + escapeReg(q) + "(?![a-z0-9])", "i");
  return (hay) => {
    if (!hay) return -1;
    const m = re.exec(hay);
    if (!m) return -1;
    return m.index + (m[0].length - q.length);
  };
}

function addPart(parts, text) {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (!s.trim()) return;
  parts.push({ text: s, lower: s.toLowerCase() });
}

function bodyParts(node) {
  const parts = [];
  addPart(parts, node?.summary);
  addPart(parts, node?.text);
  addPart(parts, node?.tidy);
  addPart(parts, node?.expanded);
  if (Array.isArray(node?.keyPoints) && node.keyPoints.length) {
    addPart(parts, node.keyPoints.map((item) => String(item ?? "")).join("\n"));
  }
  if (Array.isArray(node?.keyTerms) && node.keyTerms.length) {
    addPart(parts, node.keyTerms.map((item) => `${item?.term || ""} ${item?.def || ""}`).join("\n"));
  }
  const docs = Array.isArray(node?.docs) ? node.docs.join(" ") : "";
  const tags = Array.isArray(node?.tags) ? node.tags.join(" ") : "";
  addPart(parts, [docs, tags].filter(Boolean).join(" "));
  return parts;
}

function recordFor(id, node, noteRec) {
  const title = String(node?.title || "");
  const note = typeof noteRec?.text === "string" ? noteRec.text : "";
  const parts = bodyParts(node);
  const at = Number(noteRec?.updatedAt);
  return {
    id,
    title,
    titleLower: title.toLowerCase(),
    note,
    noteLower: note.toLowerCase(),
    hasNote: Boolean(note.trim()),
    noteUpdatedAt: note.trim() && Number.isFinite(at) ? at : 0,
    parts,
    bodyLower: parts.map((part) => part.lower).join("\n"),
  };
}

/** `{ byId, order }` from the compendium index, plus the `kc-notes-v1` map. */
export function createSearchIndex(index, notes = {}) {
  const byId = new Map();
  const order = [];
  const ids = Array.isArray(index?.order) ? index.order : [];
  const nodes = index?.byId;
  if (!nodes || typeof nodes.get !== "function") return { byId, order };
  const noteMap = notes && typeof notes === "object" ? notes : {};
  for (const rawId of ids) {
    const id = String(rawId);
    const node = nodes.get(rawId) || nodes.get(id);
    if (!node) continue;
    byId.set(id, recordFor(id, node, noteMap[id]));
    order.push(id);
  }
  return { byId, order };
}

/** Replace one topic's personal note without rebuilding the body text. */
export function patchSearchNote(searchIndex, id, noteText, updatedAt = 0) {
  const rec = searchIndex?.byId?.get(String(id || ""));
  if (!rec) return searchIndex;
  const note = typeof noteText === "string" ? noteText : String(noteText ?? "");
  rec.note = note;
  rec.noteLower = note.toLowerCase();
  rec.hasNote = Boolean(note.trim());
  const at = Number(updatedAt);
  rec.noteUpdatedAt = rec.hasNote && Number.isFinite(at) ? at : 0;
  return searchIndex;
}

function clipSnippet(raw, idx, len, radius) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(raw.length, idx + len + radius);
  return {
    before: (start > 0 ? "…" : "") + raw.slice(start, idx),
    match: raw.slice(idx, idx + len),
    after: raw.slice(idx + len, end) + (end < raw.length ? "…" : ""),
  };
}

/** Short window around the first match. `match` keeps the original casing. */
export function snippetAround(text, query, { acronym = false, radius = 48 } = {}) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  const q = String(query || "").trim();
  if (!raw || q.length < 1) return null;
  const ql = q.toLowerCase();
  const idx = makeFinder(ql, acronym)(raw.toLowerCase());
  if (idx < 0) return null;
  const slice = raw.slice(idx, idx + q.length);
  if (slice.toLowerCase() === ql) return clipSnippet(raw, idx, q.length, radius);
  const m = new RegExp(escapeReg(q), "i").exec(raw);
  if (!m) return null;
  return clipSnippet(raw, m.index, m[0].length, radius);
}

function titleRank(titleLower, q, find) {
  if (!titleLower) return -1;
  if (titleLower === q) return 0;
  const idx = find(titleLower);
  if (idx < 0) return -1;
  if (idx === 0) return 1;
  return 2;
}

function firstBodyText(rec, find) {
  if (!rec.bodyLower || find(rec.bodyLower) < 0) return "";
  for (const part of rec.parts) {
    if (find(part.lower) >= 0) return part.text;
  }
  return "";
}

function asSet(value) {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  return new Set(value);
}

function passesFilter(rec, filter, bookmarks, dueIds) {
  if (filter === "note") return rec.hasNote;
  if (filter === "bookmark") return bookmarks.has(rec.id);
  if (filter === "due") return dueIds.has(rec.id);
  return true;
}

/**
 * Ranked hits. Titles outrank personal notes, which outrank body text.
 * An empty query with filter `note`, `bookmark`, or `due` lists those topics.
 * Filter `all` with a query shorter than 2 characters returns nothing.
 *
 * @returns {{id: string, rank: number, field: string, snippet: {before: string, match: string, after: string}|null, noteMatch: boolean}[]}
 */
export function searchTopics(searchIndex, {
  query = "",
  filter = "all",
  bookmarks = null,
  dueIds = null,
  docKeep = null,
} = {}) {
  const order = searchIndex?.order || [];
  const byId = searchIndex?.byId;
  if (!byId || !order.length) return [];
  const active = FILTERS.has(filter) ? filter : "all";
  const raw = String(query || "").trim();
  const q = raw.toLowerCase();
  const textSearch = q.length >= 2;
  if (!textSearch && active === "all") return [];
  const bookmarkSet = asSet(bookmarks);
  const dueSet = asSet(dueIds);
  const acronym = textSearch ? isAcronymAwareQuery(raw) : false;
  const find = textSearch ? makeFinder(q, acronym) : null;
  const orderIndex = new Map(order.map((id, i) => [id, i]));
  const hits = [];

  for (const id of order) {
    if (docKeep && !docKeep.has(id)) continue;
    const rec = byId.get(id);
    if (!rec || !passesFilter(rec, active, bookmarkSet, dueSet)) continue;
    if (!textSearch) {
      hits.push({
        id,
        rank: 5,
        field: "browse",
        snippet: null,
        noteMatch: false,
        noteUpdatedAt: rec.noteUpdatedAt || 0,
      });
      continue;
    }
    const tRank = titleRank(rec.titleLower, q, find);
    const noteHit = Boolean(rec.noteLower) && find(rec.noteLower) >= 0;
    let bodyText = "";
    if (tRank < 0 && !noteHit) {
      bodyText = firstBodyText(rec, find);
      if (!bodyText) continue;
    }
    let rank = 4;
    let field = "body";
    if (tRank >= 0) {
      rank = tRank;
      field = "title";
    } else if (noteHit) {
      rank = 3;
      field = "note";
    }
    let snippet = null;
    if (noteHit) snippet = snippetAround(rec.note, raw, { acronym });
    else if (bodyText) snippet = snippetAround(bodyText, raw, { acronym });
    hits.push({ id, rank, field, snippet, noteMatch: noteHit });
  }

  if (!textSearch) {
    if (active === "note") {
      hits.sort((a, b) => (b.noteUpdatedAt || 0) - (a.noteUpdatedAt || 0) || orderIndex.get(a.id) - orderIndex.get(b.id));
    } else if (active === "bookmark") {
      const pos = new Map();
      let i = 0;
      for (const id of bookmarkSet) {
        if (!pos.has(id)) pos.set(id, i++);
      }
      hits.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    }
    return hits;
  }

  hits.sort((a, b) => a.rank - b.rank || orderIndex.get(a.id) - orderIndex.get(b.id));
  return hits;
}

/** Card ids are `q:<nodeId>:<n>`, `t:<nodeId>:<slug>`, or `k:<nodeId>`. */
export function nodeIdFromCardId(cardId) {
  const s = String(cardId || "");
  const kind = s.charAt(0);
  if ((kind !== "q" && kind !== "t" && kind !== "k") || s.charAt(1) !== ":") return "";
  const rest = s.slice(2);
  if (!rest) return "";
  if (kind === "k") return rest;
  const cut = rest.lastIndexOf(":");
  if (cut <= 0) return "";
  return rest.slice(0, cut);
}
