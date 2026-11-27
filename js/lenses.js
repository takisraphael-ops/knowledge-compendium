/**
 * Exam lenses. The sidecar is decrypted on demand from data/lenses.enc.json
 * and kept in memory for the unlock session. A missing file or a bad envelope
 * becomes an empty pack so flashcards, mocks, and PBQs keep running.
 */
import { decryptJson } from "./crypto.js";

export const LENSES_FILE = "lenses.enc.json";
export const LENSES_AAD = "lenses";

const ID_RE = /^[a-zA-Z0-9:_./-]+$/;
const DATA_BASE = new URL("../data/", import.meta.url);

let cached = null;
let pending = null;
let generation = 0;

function emptyPack(missing = false) {
  return { version: 1, lenses: [], missing: Boolean(missing) };
}

export function clearLensesCache() {
  generation += 1;
  cached = null;
  pending = null;
}

/**
 * Fetch and decrypt the lens sidecar once per unlock session.
 * A 404, a bad envelope, or the wrong additional authenticated data
 * becomes an empty pack. Nothing is written to the console.
 */
export async function loadLenses(key, deps = {}) {
  if (cached) return cached;
  if (pending) return pending;
  const gen = generation;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const decrypt = deps.decrypt || decryptJson;
  pending = (async () => {
    try {
      if (!key || typeof fetchImpl !== "function") return emptyPack(true);
      const res = await fetchImpl(new URL(LENSES_FILE, DATA_BASE), { cache: "no-cache" });
      if (!res || !res.ok) return emptyPack(true);
      let payload;
      try {
        payload = await res.json();
      } catch {
        return emptyPack(true);
      }
      if (!payload || typeof payload !== "object") return emptyPack(true);
      const data = await decrypt(key, payload, LENSES_AAD);
      return normalizeLenses(data);
    } catch {
      return emptyPack(true);
    }
  })().then((pack) => {
    if (gen === generation) cached = pack;
    if (gen === generation) pending = null;
    return pack;
  });
  return pending;
}

function asId(v, max = 120) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) v = String(v);
  if (typeof v !== "string") return "";
  const s = v.trim();
  if (!s || s.length > max || !ID_RE.test(s)) return "";
  return s;
}

function cleanLabel(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return fallback;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return fallback;
  return s.length > 240 ? s.slice(0, 240) : s;
}

function cleanExam(v) {
  if (typeof v !== "string") return "";
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > 80 ? s.slice(0, 80) : s;
}

/** Official weights are percent points. A fraction below 1 is scaled up (0.16 → 16). */
export function normalizeWeight(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n < 1) return Math.round(n * 1000) / 10;
  return Math.round(n * 10) / 10;
}

function idList(raw, max) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const id = asId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeObjective(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asId(raw.id, 80);
  if (!id) return null;
  return {
    id,
    title: cleanLabel(raw.title, id),
    nodeIds: idList(raw.nodeIds, 2000),
    pbqIds: idList(raw.pbqIds, 500),
  };
}

function normalizeDomain(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asId(raw.id, 80);
  if (!id) return null;
  const objectives = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.objectives) ? raw.objectives : []) {
    const objective = normalizeObjective(item);
    if (!objective || seen.has(objective.id)) continue;
    seen.add(objective.id);
    objectives.push(objective);
  }
  return {
    id,
    title: cleanLabel(raw.title, id),
    weight: normalizeWeight(raw.weight),
    objectives,
  };
}

function normalizeLens(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asId(raw.id, 80);
  if (!id) return null;
  const domains = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.domains) ? raw.domains : []) {
    const domain = normalizeDomain(item);
    if (!domain || seen.has(domain.id)) continue;
    seen.add(domain.id);
    domains.push(domain);
  }
  const lens = {
    id,
    title: cleanLabel(raw.title, id),
    domains,
  };
  const exam = cleanExam(raw.exam);
  if (exam) lens.exam = exam;
  return lens;
}

/** Accept `{ version, lenses: [...] }`. Unknown extras are dropped. */
export function normalizeLenses(raw) {
  const pack = emptyPack(false);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return pack;
  const list = Array.isArray(raw.lenses) ? raw.lenses : [];
  const seen = new Set();
  for (const item of list) {
    const lens = normalizeLens(item);
    if (!lens || seen.has(lens.id)) continue;
    seen.add(lens.id);
    pack.lenses.push(lens);
  }
  return pack;
}
