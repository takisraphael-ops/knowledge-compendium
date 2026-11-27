/**
 * Cert-agnostic exam readiness.
 * Objective scores come from SRS cards on nodeIds and PBQ scores on pbqIds.
 * Domain scores blend those objectives with matching mock accuracy, when a
 * mock history exists. The exam score weights each domain by its lens weight.
 */
import { isDue, isMastered, isNew } from "./schedule.js";

export const DRILL_LIMIT = 10;
export const DRILL_MS = 5 * 60 * 1000;
export const MOCK_BLEND = 0.25;

const CARD_POINTS = {
  unseen: 0,
  learning: 55,
  lapsed: 30,
  mature: 100,
};

const TIER_LABEL = {
  unstarted: "Unstarted",
  "needs-work": "Needs work",
  building: "Building",
  ready: "Ready",
};

export function tierLabel(tier) {
  return TIER_LABEL[tier] || TIER_LABEL.unstarted;
}

/** Unstarted until any signal exists. Then <50 needs work, 50–79 building, ≥80 ready. */
export function tierFor(readiness, started) {
  if (!started || readiness == null || !Number.isFinite(readiness)) return "unstarted";
  if (readiness < 50) return "needs-work";
  if (readiness < 80) return "building";
  return "ready";
}

/** Map a Security+ lens id or exam string onto the mock-history version code. */
export function lensExamVersion(lens) {
  const tokens = [lens?.exam, lens?.id].map((s) => String(s || "").toUpperCase().replace(/\s+/g, ""));
  for (const token of tokens) {
    if (token === "SY0-701" || token === "SY0701" || token === "701") return "701";
    if (token === "SY0-801" || token === "SY0801" || token === "801") return "801";
  }
  return "";
}

export function selectLens(lenses, examVersion) {
  const list = Array.isArray(lenses) ? lenses : [];
  const ver = examVersion === "701" ? "701" : examVersion === "801" ? "801" : "";
  if (!ver) return null;
  return list.find((lens) => lensExamVersion(lens) === ver) || null;
}

/** Ids that should share one mock-history bucket. Non-numeric ids stay themselves. */
export function domainMatchKeys(domainId) {
  const id = String(domainId ?? "").trim();
  const keys = new Set();
  if (id) keys.add(id);
  let n = "";
  let m = id.match(/^([1-5])(?:\.0)?$/);
  if (m) n = m[1];
  m = id.match(/^(?:sy0-)?d([1-5])$/i);
  if (m) n = m[1];
  m = id.match(/^domain\s*([1-5])(?:\.0)?$/i);
  if (m) n = m[1];
  if (n) {
    keys.add(`${n}.0`);
    keys.add(n);
    keys.add(`d${n}`);
    keys.add(`sy0-d${n}`);
  }
  return keys;
}

export function classifyCard(rec) {
  if (isNew(rec)) return "unseen";
  if (isMastered(rec)) return "mature";
  if (rec?.lastGrade === "again" || ((rec?.lapses || 0) > 0 && rec?.lastGrade !== "good" && rec?.lastGrade !== "easy")) {
    return "lapsed";
  }
  return "learning";
}

/** Roll up every card on a topic. A missing record counts as unseen. */
export function statusForNode(recs, now = Date.now()) {
  const list = Array.isArray(recs) ? recs : [];
  if (!list.length) return { status: "unseen", due: 0 };
  const kinds = [];
  let due = 0;
  for (const rec of list) {
    kinds.push(classifyCard(rec));
    if (isDue(rec, now)) due += 1;
  }
  let status = "unseen";
  if (due) status = "due";
  else if (kinds.includes("lapsed")) status = "lapsed";
  else if (kinds.includes("learning") || (kinds.includes("mature") && kinds.includes("unseen"))) status = "learning";
  else if (kinds.every((kind) => kind === "mature")) status = "mature";
  return { status, due };
}

function pbqSignal(rec) {
  const total = Number(rec?.total);
  if (!rec || !Number.isFinite(total) || total <= 0) return null;
  const best = Number(rec.bestScore);
  if (!Number.isFinite(best)) return null;
  const attempts = Number(rec.attempts);
  return {
    pct: Math.max(0, Math.min(100, (100 * best) / total)),
    started: attempts > 0 || best > 0,
  };
}

function roundPct(n) {
  return Math.round(n);
}

function scoreObjectiveAt(objective, cards, records, pbqProgress, now) {
  const nodeIds = new Set(objective.nodeIds || []);
  const seen = new Set();
  const counts = { cards: 0, unseen: 0, learning: 0, lapsed: 0, mature: 0, due: 0 };
  let sum = 0;
  let parts = 0;
  let started = false;
  for (const card of cards || []) {
    if (!card?.id || !nodeIds.has(card.nodeId) || seen.has(card.id)) continue;
    seen.add(card.id);
    const rec = records?.[card.id] || null;
    const kind = classifyCard(rec);
    counts.cards += 1;
    counts[kind] += 1;
    if (kind !== "unseen") started = true;
    if (isDue(rec, now)) counts.due += 1;
    sum += CARD_POINTS[kind];
    parts += 1;
  }
  const pbqIds = objective.pbqIds || [];
  let pbqScored = 0;
  let pbqSum = 0;
  for (const id of pbqIds) {
    const signal = pbqSignal(pbqProgress?.[id]);
    parts += 1;
    if (!signal) continue;
    sum += signal.pct;
    if (signal.started) {
      started = true;
      pbqScored += 1;
      pbqSum += signal.pct;
    }
  }
  const readiness = parts && started ? roundPct(sum / parts) : null;
  return {
    id: objective.id,
    title: objective.title || objective.id,
    nodeIds: [...(objective.nodeIds || [])],
    pbqIds: [...pbqIds],
    readiness,
    tier: tierFor(readiness, started),
    started,
    ...counts,
    pbqCount: pbqIds.length,
    pbqScored,
    pbqPct: pbqScored ? roundPct(pbqSum / pbqScored) : null,
  };
}

function mockAccuracy(history, lens, domainId) {
  const ver = lensExamVersion(lens);
  const keys = ver ? domainMatchKeys(domainId) : new Set([String(domainId)]);
  let correct = 0;
  let total = 0;
  let attempts = 0;
  for (const attempt of Array.isArray(history) ? history : []) {
    if (!attempt || typeof attempt !== "object") continue;
    if (ver && attempt.examVersion !== ver) continue;
    for (const row of attempt.domains || []) {
      if (!row?.id || !keys.has(String(row.id))) continue;
      const rowTotal = Number(row.total) || 0;
      if (rowTotal <= 0) continue;
      correct += Number(row.correct) || 0;
      total += rowTotal;
      attempts += 1;
    }
  }
  if (!total) return null;
  return { pct: (100 * correct) / total, correct, total, attempts };
}

function pickWeakest(domains) {
  if (!domains.length) return null;
  let best = domains[0];
  const score = (d) => (d.readiness == null ? -1 : d.readiness);
  for (const domain of domains.slice(1)) {
    const ds = score(domain);
    const bs = score(best);
    if (ds < bs - 1e-9) best = domain;
    else if (Math.abs(ds - bs) <= 1e-9) {
      const more = (domain.weight || 0) - (best.weight || 0);
      if (more > 0 || (more === 0 && String(domain.id) < String(best.id))) best = domain;
    }
  }
  return {
    id: best.id,
    title: best.title,
    weight: best.weight,
    readiness: best.readiness,
    tier: best.tier,
  };
}

/**
 * Score one lens.
 * `cards` are `{ id, nodeId }`. `records` is the SRS map keyed by card id.
 * `pbqProgress` is the `kc-pbq-v1` map. `mockHistory` is the attempt list.
 */
export function scoreLens(lens, { cards = [], records = {}, mockHistory = [], pbqProgress = {}, now = Date.now() } = {}) {
  const domains = (lens?.domains || []).map((domain) => {
    const objectives = (domain.objectives || []).map((objective) => scoreObjectiveAt(objective, cards, records, pbqProgress, now));
    let weightSum = 0;
    let acc = 0;
    let anyStarted = false;
    for (const objective of objectives) {
      const n = objective.cards + objective.pbqCount;
      if (!n) continue;
      if (objective.started) anyStarted = true;
      weightSum += n;
      acc += (objective.started ? objective.readiness : 0) * n;
    }
    const study = anyStarted && weightSum ? roundPct(acc / weightSum) : null;
    const mock = mockAccuracy(mockHistory, lens, domain.id);
    let readiness = null;
    let started = false;
    if (study != null && mock) {
      readiness = roundPct(study * (1 - MOCK_BLEND) + mock.pct * MOCK_BLEND);
      started = true;
    } else if (mock) {
      readiness = roundPct(mock.pct);
      started = true;
    } else if (study != null) {
      readiness = study;
      started = true;
    }
    return {
      id: domain.id,
      title: domain.title || domain.id,
      weight: Number(domain.weight) || 0,
      readiness,
      tier: tierFor(readiness, started),
      started,
      study,
      mockPct: mock ? roundPct(mock.pct) : null,
      mockAttempts: mock ? mock.attempts : 0,
      objectives,
    };
  });

  for (const domain of domains) {
    for (const objective of domain.objectives) {
      objective.domainId = domain.id;
      objective.domainWeight = domain.weight;
      objective.domainReadiness = domain.readiness;
    }
  }

  const usable = domains.filter((domain) => domain.weight > 0);
  const equal = usable.length === 0;
  const weightOf = (domain) => (equal ? 1 : domain.weight);
  const pool = equal ? domains : usable;
  const sumW = pool.reduce((sum, domain) => sum + weightOf(domain), 0);
  const anyDomain = domains.some((domain) => domain.started);
  let overallReadiness = null;
  if (anyDomain && sumW) {
    overallReadiness = roundPct(pool.reduce((sum, domain) => sum + (domain.readiness ?? 0) * weightOf(domain), 0) / sumW);
  }
  const objectives = domains.flatMap((domain) => domain.objectives);
  return {
    lensId: lens?.id || "",
    title: lens?.title || lens?.id || "",
    exam: lens?.exam || "",
    overall: {
      readiness: overallReadiness,
      tier: tierFor(overallReadiness, anyDomain),
      started: anyDomain,
    },
    readyCount: objectives.filter((objective) => objective.tier === "ready").length,
    objectiveCount: objectives.length,
    weakest: pickWeakest(domains),
    domains,
  };
}

function impactOf(objective) {
  return (100 - (objective?.readiness ?? 0)) * (objective?.domainWeight || 0);
}

/**
 * Order cards for a short drill.
 * Overdue cards come first, then weak or lapsed cards, then unseen cards.
 * Inside each group, lower-readiness and heavier domains come first.
 * Unseen cards prefer the weakest domain. Mastered cards are left out
 * unless `includeMature` is set.
 */
export function prioritizeDrillCards({ objectives = [], cards = [], records = {}, now = Date.now(), limit = DRILL_LIMIT, includeMature = false } = {}) {
  const byNode = new Map();
  for (const objective of objectives) {
    for (const nodeId of objective?.nodeIds || []) {
      if (!byNode.has(nodeId)) byNode.set(nodeId, objective);
    }
  }
  const ranked = [];
  const seen = new Set();
  for (const card of cards || []) {
    if (!card?.id || seen.has(card.id)) continue;
    const objective = byNode.get(card.nodeId);
    if (!objective) continue;
    seen.add(card.id);
    const rec = records?.[card.id] || null;
    const kind = classifyCard(rec);
    const due = isDue(rec, now);
    let bucket;
    if (due) bucket = 0;
    else if (kind === "lapsed" || kind === "learning") bucket = 1;
    else if (kind === "unseen") bucket = 2;
    else bucket = 3;
    if (bucket === 3 && !includeMature) continue;
    ranked.push({
      card,
      bucket,
      dueAt: Number(rec?.due) || 0,
      lapses: Number(rec?.lapses) || 0,
      id: card.id,
      objective,
    });
  }
  ranked.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    if (a.bucket === 2) {
      const ar = a.objective.domainReadiness == null ? -1 : a.objective.domainReadiness;
      const br = b.objective.domainReadiness == null ? -1 : b.objective.domainReadiness;
      if (ar !== br) return ar - br;
      const aw = a.objective.domainWeight || 0;
      const bw = b.objective.domainWeight || 0;
      if (aw !== bw) return bw - aw;
    } else if (a.bucket < 3) {
      const im = impactOf(b.objective) - impactOf(a.objective);
      if (im) return im;
      if (a.bucket === 0 && a.dueAt !== b.dueAt) return a.dueAt - b.dueAt;
      if (a.bucket === 1 && a.lapses !== b.lapses) return b.lapses - a.lapses;
    }
    return String(a.id).localeCompare(String(b.id));
  });
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  return ranked.slice(0, cap).map((row) => row.card);
}
