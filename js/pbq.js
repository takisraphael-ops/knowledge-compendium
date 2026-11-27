/**
 * Performance-based questions (PBQs).
 * The pack is decrypted on demand from data/pbqs.enc.json and kept in memory
 * for the unlock session. Progress stores only ids and scores.
 */
import { decryptJson } from "./crypto.js";

export const PBQ_STORAGE_KEY = "kc-pbq-v1";
export const PBQ_FILE = "pbqs.enc.json";
export const PBQ_AAD = "pbqs";
export const PBQ_TYPES = ["order", "match", "triage", "select", "config"];

const ID_RE = /^[a-zA-Z0-9:_./-]+$/;
const DATA_BASE = new URL("../data/", import.meta.url);

let cached = null;
let pending = null;
let generation = 0;

function emptyPack(missing = false) {
  return { version: 1, scenarios: [], missing: Boolean(missing) };
}

export function clearPbqCache() {
  generation += 1;
  cached = null;
  pending = null;
}

/**
 * Fetch and decrypt the PBQ pack once per unlock session.
 * A missing file, a 404, or a bad envelope becomes an empty pack.
 * Nothing is written to the console: flashcards and mocks keep running.
 */
export async function loadPbqPack(key, deps = {}) {
  if (cached) return cached;
  if (pending) return pending;
  const gen = generation;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const decrypt = deps.decrypt || decryptJson;
  pending = (async () => {
    try {
      if (!key || typeof fetchImpl !== "function") return emptyPack(true);
      const res = await fetchImpl(new URL(PBQ_FILE, DATA_BASE), { cache: "no-cache" });
      if (!res || !res.ok) return emptyPack(true);
      let payload;
      try {
        payload = await res.json();
      } catch {
        return emptyPack(true);
      }
      if (!payload || typeof payload !== "object") return emptyPack(true);
      const data = await decrypt(key, payload, PBQ_AAD);
      return normalizePbqPack(data);
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
  return s.length > 500 ? s.slice(0, 500) : s;
}

function clampInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function examCode(v) {
  const s = String(v ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (s === "801" || s === "SY0-801" || s === "SY0801") return "SY0-801";
  if (s === "701" || s === "SY0-701" || s === "SY0701") return "SY0-701";
  return "";
}

export function normalizeExams(raw) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const code = examCode(item);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Canonical Security+ domain code: "1.0" … "5.0". */
export function normalizeDomain(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  let m = s.match(/^(?:domain\s*)?([1-5])(?:\.0)?(?:\b|[^0-9])/i);
  if (m) return `${m[1]}.0`;
  m = s.match(/sy0-d([1-5])\b/i);
  if (m) return `${m[1]}.0`;
  m = s.match(/^d([1-5])$/i);
  if (m) return `${m[1]}.0`;
  return "";
}

export function domainCodeFromFilterId(id) {
  const s = String(id ?? "").trim();
  const fromSy = s.match(/sy0-d([1-5])\b/i);
  if (fromSy) return `${fromSy[1]}.0`;
  return normalizeDomain(s);
}

function normalizeChoices(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const choice = normalizeChoice(item);
    if (!choice || seen.has(choice.id)) continue;
    seen.add(choice.id);
    out.push(choice);
  }
  return out;
}

function normalizeChoice(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asId(raw.id, 80);
  if (!id) return null;
  const choice = { id, label: cleanLabel(raw.label, id) };
  if (Array.isArray(raw.options)) {
    const options = normalizeChoices(raw.options);
    if (options.length) choice.options = options;
  }
  return choice;
}

function answerMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw;
}

function normalizeOrder(raw) {
  const items = normalizeChoices(raw.items);
  if (!items.length) return null;
  const known = new Set(items.map((item) => item.id));
  const answer = [];
  const seen = new Set();
  for (const id of Array.isArray(raw.answer) ? raw.answer : []) {
    const clean = asId(id, 80);
    if (!clean || !known.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    answer.push(clean);
  }
  if (answer.length !== items.length) return null;
  return { items, answer };
}

function normalizeMatch(raw) {
  const items = normalizeChoices(Array.isArray(raw.items) && raw.items.length ? raw.items : raw.prompts);
  const options = normalizeChoices(raw.options);
  if (!items.length || !options.length) return null;
  const optIds = new Set(options.map((opt) => opt.id));
  const src = answerMap(raw.answer);
  const answer = {};
  for (const item of items) {
    const chosen = asId(src[item.id], 80);
    if (!chosen || !optIds.has(chosen)) return null;
    answer[item.id] = chosen;
  }
  return { items, options, answer };
}

function normalizeSelect(raw) {
  const options = normalizeChoices(raw.options);
  if (!options.length) return null;
  const known = new Set(options.map((opt) => opt.id));
  const answer = [];
  const seen = new Set();
  for (const id of Array.isArray(raw.answer) ? raw.answer : []) {
    const clean = asId(id, 80);
    if (!clean || !known.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    answer.push(clean);
  }
  if (!answer.length) return null;
  return { options, answer };
}

function normalizeConfig(raw) {
  const shared = normalizeChoices(raw.options);
  const items = [];
  for (const row of Array.isArray(raw.items) ? raw.items : []) {
    const base = normalizeChoice(row);
    if (!base) continue;
    const own = Array.isArray(row?.options) ? normalizeChoices(row.options) : [];
    const options = own.length ? own : shared;
    if (!options.length) continue;
    items.push({ id: base.id, label: base.label, options });
  }
  if (!items.length) return null;
  const src = answerMap(raw.answer);
  const answer = {};
  for (const item of items) {
    const chosen = asId(src[item.id], 80);
    if (!item.options.some((opt) => opt.id === chosen)) return null;
    answer[item.id] = chosen;
  }
  return { items, options: shared, answer };
}

function normalizePayload(type, raw) {
  if (type === "order") return normalizeOrder(raw);
  if (type === "match") return normalizeMatch(raw);
  if (type === "triage" || type === "select") return normalizeSelect(raw);
  if (type === "config") return normalizeConfig(raw);
  return null;
}

function normalizeRelated(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const id of raw) {
    const clean = asId(id);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= 24) break;
  }
  return out;
}

function clipText(v, max) {
  if (typeof v !== "string") return "";
  return v.length > max ? v.slice(0, max) : v;
}

export function normalizeScenario(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = asId(raw.id);
  if (!id) return null;
  const type = String(raw.type || "").trim().toLowerCase();
  if (!PBQ_TYPES.includes(type)) return null;
  const payload = normalizePayload(type, raw);
  if (!payload) return null;
  const examsRaw = Array.isArray(raw.exams) && raw.exams.length ? raw.exams : raw.exam ?? raw.exams;
  const prompt = typeof raw.prompt === "string" ? raw.prompt : typeof raw.scenario === "string" ? raw.scenario : "";
  return {
    id,
    title: cleanLabel(raw.title, id),
    exams: normalizeExams(examsRaw),
    domain: normalizeDomain(raw.domain),
    type,
    prompt: clipText(prompt, 20000),
    svg: clipText(typeof raw.svg === "string" ? raw.svg : "", 200000),
    relatedNodeIds: normalizeRelated(raw.relatedNodeIds),
    explanation: clipText(typeof raw.explanation === "string" ? raw.explanation : "", 20000),
    ...payload,
  };
}

/** Accept `{ scenarios: [...] }` and the `{ pbqs: [...] }` alias. */
export function normalizePbqPack(raw) {
  const pack = emptyPack(false);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return pack;
  const list = Array.isArray(raw.scenarios) ? raw.scenarios : Array.isArray(raw.pbqs) ? raw.pbqs : [];
  const seen = new Set();
  for (const item of list) {
    const scenario = normalizeScenario(item);
    if (!scenario || seen.has(scenario.id)) continue;
    seen.add(scenario.id);
    pack.scenarios.push(scenario);
  }
  return pack;
}

export function scenarioMatches(scenario, { examVersion = "801", domainIds = [] } = {}) {
  if (!scenario) return false;
  const code = examVersion === "701" ? "SY0-701" : "SY0-801";
  if (scenario.exams?.length && !scenario.exams.includes(code)) return false;
  const wanted = [];
  const seen = new Set();
  for (const id of domainIds || []) {
    const domain = domainCodeFromFilterId(id);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    wanted.push(domain);
  }
  if (!wanted.length) return true;
  return wanted.includes(scenario.domain);
}

function finishGrade(score, total, items) {
  const safeTotal = Math.max(0, total);
  const safeScore = Math.max(0, Math.min(score, safeTotal));
  const pct = safeTotal ? Math.round((100 * safeScore) / safeTotal) : 0;
  return {
    score: safeScore,
    total: safeTotal,
    pct,
    exact: safeTotal > 0 && safeScore === safeTotal,
    items,
  };
}

function gradeOrder(scenario, response) {
  const got = Array.isArray(response) ? response.map((id) => asId(id, 80)) : [];
  const items = scenario.answer.map((expected, index) => {
    const given = got[index] || "";
    const correct = given === expected;
    return { id: given || expected, index, correct, expected, given, missed: !correct };
  });
  const score = items.filter((item) => item.correct).length;
  return finishGrade(score, items.length, items);
}

function gradeMap(scenario, response) {
  const got = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  const items = (scenario.items || []).map((row) => {
    const expected = scenario.answer[row.id] || "";
    const given = asId(got[row.id], 80);
    const correct = Boolean(expected) && given === expected;
    return { id: row.id, correct, expected, given, missed: !correct };
  });
  const score = items.filter((item) => item.correct).length;
  return finishGrade(score, items.length, items);
}

/**
 * Multi-select. The denominator is the number of correct options ("Select N").
 * Each extra selection costs one point, so choosing every option cannot score full marks.
 */
function gradeSelect(scenario, response) {
  const selected = new Set((Array.isArray(response) ? response : []).map((id) => asId(id, 80)).filter(Boolean));
  const answer = new Set(scenario.answer);
  const items = (scenario.options || []).map((opt) => {
    const should = answer.has(opt.id);
    const on = selected.has(opt.id);
    return {
      id: opt.id,
      correct: should === on,
      expected: should,
      given: on,
      hit: should && on,
      missed: should && !on,
      extra: on && !should,
    };
  });
  const hits = items.filter((item) => item.hit).length;
  const extras = items.filter((item) => item.extra).length;
  return finishGrade(Math.max(0, hits - extras), scenario.answer.length, items);
}

export function gradePbq(scenario, response) {
  if (!scenario || typeof scenario !== "object") return finishGrade(0, 0, []);
  if (scenario.type === "order") return gradeOrder(scenario, response);
  if (scenario.type === "match" || scenario.type === "config") return gradeMap(scenario, response);
  if (scenario.type === "triage" || scenario.type === "select") return gradeSelect(scenario, response);
  return finishGrade(0, 0, []);
}

export function formatPbqScore(score, total) {
  const s = Math.max(0, Math.round(Number(score) || 0));
  const t = Math.max(0, Math.round(Number(total) || 0));
  const pct = t ? Math.round((100 * s) / t) : 0;
  return `${s}/${t} (${pct}%)`;
}

/** A practice order that is not already the answer key. */
export function shuffledOrder(items, answer, rng = Math.random) {
  const order = (items || []).map((item) => item.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  const key = answer || [];
  if (order.length > 1 && order.every((id, i) => id === key[i])) {
    const swap = order[0];
    order[0] = order[1];
    order[1] = swap;
  }
  return order;
}

export function sanitizePbqProgress(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const [id, rec] of Object.entries(src)) {
    const clean = asId(id);
    if (!clean || !rec || typeof rec !== "object") continue;
    const total = clampInt(rec.total, 1, 500, 0);
    if (!total) continue;
    const bestScore = clampInt(rec.bestScore, 0, total, 0);
    const attempts = clampInt(rec.attempts, 0, 100000, 0);
    const lastAt = Number(rec.lastAt);
    out[clean] = {
      bestScore,
      total,
      attempts,
      lastAt: Number.isFinite(lastAt) && lastAt > 0 ? lastAt : 0,
      passed: Boolean(rec.passed) || bestScore === total,
    };
  }
  return out;
}

export function mergePbqRecord(current, incoming) {
  if (!current) return incoming || null;
  if (!incoming) return current;
  const scoreA = current.bestScore || 0;
  const scoreB = incoming.bestScore || 0;
  const primary = scoreB > scoreA
    ? incoming
    : scoreA > scoreB
      ? current
      : (incoming.lastAt || 0) >= (current.lastAt || 0) ? incoming : current;
  return {
    bestScore: Math.max(scoreA, scoreB),
    total: primary.total,
    attempts: Math.max(current.attempts || 0, incoming.attempts || 0),
    lastAt: Math.max(current.lastAt || 0, incoming.lastAt || 0),
    passed: Boolean(current.passed || incoming.passed),
  };
}

export function mergePbqProgress(current, incoming) {
  const cur = sanitizePbqProgress(current);
  const inc = sanitizePbqProgress(incoming);
  const out = { ...cur };
  for (const [id, rec] of Object.entries(inc)) {
    out[id] = mergePbqRecord(out[id], rec);
  }
  return out;
}

export function loadPbqProgress(storage) {
  if (!storage) return {};
  try {
    const raw = storage.getItem(PBQ_STORAGE_KEY);
    if (!raw) return {};
    return sanitizePbqProgress(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function savePbqProgress(progress, storage) {
  const safe = sanitizePbqProgress(progress);
  if (storage) {
    if (Object.keys(safe).length) storage.setItem(PBQ_STORAGE_KEY, JSON.stringify(safe));
    else storage.removeItem?.(PBQ_STORAGE_KEY);
  }
  return safe;
}

export function recordPbqAttempt(storage, id, grade, now = Date.now()) {
  const clean = asId(id);
  const all = loadPbqProgress(storage);
  if (!clean || !grade || !(Number(grade.total) > 0)) return all;
  const total = clampInt(grade.total, 1, 500, 0);
  if (!total) return all;
  const score = clampInt(grade.score, 0, total, 0);
  const prev = all[clean];
  const passed = Boolean(prev?.passed) || Boolean(grade.exact) || score === total;
  const betterIsNew = !prev || score >= (prev.bestScore || 0);
  all[clean] = {
    bestScore: Math.max(prev?.bestScore || 0, score),
    total: betterIsNew ? total : prev.total,
    attempts: (prev?.attempts || 0) + 1,
    lastAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    passed,
  };
  return savePbqProgress(all, storage);
}
