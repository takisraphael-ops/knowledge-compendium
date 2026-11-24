/**
 * Build revision cards from unlocked nodes. Parsers are pure and DOM-free.
 * Card text lives only in memory — never write front/back to storage.
 */
import { splitExpanded } from "./notes.js";
import { subjectOfNode, isUnder } from "./route.js";

const STUDY_START = /^(?:#{1,6}\s+)?(?:Exam tips|Exam point|Exam clue|Memory aids|Practice)\s*$/i;

/** Official-style Security+ domain groups of existing top-level cyber sections.
 *  These are a front-end study grouping, not tags stored in the notes. */
export const SY0_DOMAINS = [
  { id: "sy0-d1", label: "1. General Security Concepts", sectionIds: ["c90", "c185", "c12e"] },
  { id: "sy0-d2", label: "2. Threats, Vulnerabilities, and Attacks", sectionIds: ["cd1"] },
  { id: "sy0-d3", label: "3. Security Architecture", sectionIds: ["c248", "c1ff"] },
  { id: "sy0-d4", label: "4. Security Operations", sectionIds: ["c1", "c1bb"] },
  { id: "sy0-d5", label: "5. Security Program Management and Oversight", sectionIds: ["c28d"] },
];

const DOMAIN_BY_SECTION = new Map();
for (const d of SY0_DOMAINS) {
  for (const id of d.sectionIds) DOMAIN_BY_SECTION.set(id, d.id);
}

export function slugTerm(term) {
  const s = String(term || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return s || "term";
}

function splitPractice(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const isAnswers = (line) => /^(?:#{1,6}\s+)?\*{0,2}Answers\*{0,2}\s*$/i.test(line.trim());
  const isSeeAlso = (line) => /^(?:\*\*)?See also:/i.test(line.trim());
  const idx = lines.findIndex(isAnswers);
  if (idx < 0) return { questions: body, answers: "", after: "" };
  const questions = lines.slice(0, idx).join("\n");
  const rest = lines.slice(idx + 1);
  const see = rest.findIndex(isSeeAlso);
  if (see < 0) return { questions, answers: rest.join("\n"), after: "" };
  return { questions, answers: rest.slice(0, see).join("\n"), after: rest.slice(see).join("\n") };
}

export function parseNumberedItems(text) {
  const src = String(text || "").replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  const hits = [];
  const re = /^(\d+)\.\s+/gm;
  let m;
  while ((m = re.exec(src))) {
    hits.push({ n: Number(m[1]), body: m.index + m[0].length, start: m.index });
  }
  const items = [];
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : src.length;
    const t = src.slice(hits[i].body, end).trim();
    if (t) items.push({ n: hits[i].n, text: t });
  }
  return items;
}

export function hasPracticeHeading(text) {
  return /^###\s+Practice\s*$/m.test(String(text || ""));
}

/** Parse Practice Q&A pairs from a node's expanded note. */
export function parsePracticePairs(expanded) {
  const src = String(expanded || "").replace(/\r\n/g, "\n");
  const hasHeading = hasPracticeHeading(src);
  const { practice } = splitExpanded(src);
  if (!String(practice || "").trim()) {
    return {
      ok: !hasHeading,
      items: [],
      reason: hasHeading ? "empty-practice" : null,
      hasHeading,
    };
  }
  const { questions, answers } = splitPractice(practice);
  if (!String(answers || "").trim()) {
    return { ok: false, items: [], reason: "no-answers", hasHeading: true };
  }
  const qs = parseNumberedItems(questions);
  const as = parseNumberedItems(answers);
  if (!qs.length) {
    return { ok: false, items: [], reason: "no-numbered-questions", hasHeading: true };
  }
  const byN = new Map(as.map((a) => [a.n, a.text]));
  const items = [];
  const missing = [];
  for (const q of qs) {
    if (!byN.has(q.n)) missing.push(q.n);
    else items.push({ n: q.n, q: q.text, a: byN.get(q.n) });
  }
  const extra = as.filter((a) => !qs.some((q) => q.n === a.n)).map((a) => a.n);
  const reason = missing.length
    ? `unmatched-answers:${missing.join(",")}`
    : extra.length
      ? `extra-answers:${extra.join(",")}`
      : null;
  return { ok: items.length > 0 && missing.length === 0, items, reason, missing, extra, hasHeading: true };
}

function cleanDef(def) {
  return String(def || "")
    .replace(/\s*See\s+\[[^\]]+\]\([^)]+\)\.?\s*$/i, "")
    .trim();
}

/** Term lists that start a line with **Term.** or - **Term**: def */
export function parseGlossaryTermList(expanded) {
  const src = String(expanded || "").replace(/\r\n/g, "\n");
  const lines = [];
  for (const raw of src.split("\n")) {
    if (STUDY_START.test(raw.trim().replace(/^###\s+/, "### "))) {
      // splitExpanded already cuts study layers; still stop if a raw heading slips through
      if (/^#{1,6}\s+(Exam tips|Exam point|Exam clue|Memory aids|Practice)\s*$/i.test(raw.trim())) break;
    }
    lines.push(raw);
  }
  const body = splitExpanded(src).lead || lines.join("\n");
  const items = [];
  const seen = new Set();
  const patterns = [
    /^(?:[-*]|•)\s+\*\*(.+?)\*\*\s*[:.—–-]*\s+(\S.*)$/,
    /^\*\*(.+?)\*\*\s*[:.—–-]*\s+(\S.*)$/,
  ];
  for (const raw of String(body).split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s+/.test(line)) continue;
    let m = null;
    for (const re of patterns) {
      m = line.match(re);
      if (m) break;
    }
    if (!m) continue;
    const term = m[1].replace(/[.:]+$/g, "").trim();
    const def = cleanDef(m[2]);
    if (!term || !def) continue;
    const slug = slugTerm(term);
    if (seen.has(slug)) continue;
    seen.add(slug);
    items.push({ term, def, slug });
  }
  return items;
}

export function termsFromKeyTerms(node) {
  const out = [];
  const seen = new Set();
  for (const row of node?.keyTerms || []) {
    const term = String(row?.term || "").trim();
    const def = cleanDef(row?.def || "");
    if (!term || !def) continue;
    let slug = slugTerm(term);
    if (seen.has(slug)) {
      let i = 2;
      while (seen.has(`${slug}-${i}`)) i += 1;
      slug = `${slug}-${i}`;
    }
    seen.add(slug);
    out.push({ term, def, slug });
  }
  return out;
}

function isGlossaryNode(node) {
  const tags = node?.tags || [];
  const title = String(node?.title || "");
  return tags.includes("glossary") || /glossary/i.test(title);
}

/** Flashcard faces: keyTerms plus glossary lists, de-duplicated per node. */
export function collectTermsForNode(node) {
  const fromKeys = termsFromKeyTerms(node);
  const seen = new Set(fromKeys.map((t) => t.slug));
  const seenNorm = new Set(fromKeys.map((t) => slugTerm(t.term)));
  const out = fromKeys.map((t) => ({ ...t, source: "keyTerms" }));
  if (isGlossaryNode(node)) {
    for (const t of parseGlossaryTermList(node.expanded || "")) {
      if (seenNorm.has(t.slug) || seen.has(t.slug)) continue;
      seen.add(t.slug);
      seenNorm.add(t.slug);
      out.push({ ...t, source: "glossary" });
    }
  }
  return out;
}

export function practiceCardId(nodeId, n) {
  return `q:${nodeId}:${n}`;
}

export function termCardId(nodeId, slug) {
  return `t:${nodeId}:${slug}`;
}

function topSectionId(index, subjects, nodeId, branchRootId) {
  if (!index || !nodeId) return null;
  const root = branchRootId || subjectOfNode(index, subjects, nodeId)?.rootId;
  if (!root) return null;
  if (nodeId === root) return root;
  let cur = nodeId;
  const visited = new Set();
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const node = index.byId.get(cur);
    const parent = node?.parentId;
    if (!parent || parent === root) return cur;
    if (parent === index.rootId) return cur;
    cur = parent;
  }
  return nodeId;
}

export function domainIdForSection(sectionId) {
  return DOMAIN_BY_SECTION.get(sectionId) || null;
}

export function walkScopedNodes(index, subjects, { branchIds = [], sectionIds = [], domainIds = [] } = {}) {
  if (!index) return [];
  const wantBranches = new Set(branchIds.filter(Boolean));
  const wantSections = new Set(sectionIds.filter(Boolean));
  const wantDomains = new Set(domainIds.filter(Boolean));
  const useDomains = wantDomains.size > 0;
  const useSections = wantSections.size > 0;
  const out = [];
  const ids = index.order || [...(index.byId?.keys?.() || [])];
  for (const nid of ids) {
    const node = index.byId.get(nid);
    if (!node?.id || node.id === index.rootId) continue;
    const subject = subjectOfNode(index, subjects, node.id);
    if (!subject) continue;
    if (wantBranches.size && !wantBranches.has(subject.rootId)) continue;
    const sectionId = topSectionId(index, subjects, node.id, subject.rootId);
    if (useSections && !wantSections.has(sectionId) && !wantSections.has(node.id) &&
        ![...wantSections].some((sid) => isUnder(index, sid, node.id) || sid === node.id)) {
      continue;
    }
    const domainId = domainIdForSection(sectionId);
    if (useDomains && !wantDomains.has(domainId)) continue;
    out.push({ node, subject, sectionId, domainId });
  }
  return out;
}

/**
 * Build in-memory cards for a scope and mode.
 * mode: "practice" | "flashcards"
 */
export function collectCards(index, subjects, scope) {
  const mode = scope?.mode === "practice" ? "practice" : "flashcards";
  const cards = [];
  const failures = [];
  for (const row of walkScopedNodes(index, subjects, scope)) {
    const { node, subject, sectionId, domainId } = row;
    if (mode === "practice") {
      const parsed = parsePracticePairs(node.expanded || "");
      if (parsed.hasHeading && !parsed.ok) {
        failures.push({ nodeId: node.id, title: node.title, reason: parsed.reason, mode });
      }
      for (const item of parsed.items) {
        cards.push({
          id: practiceCardId(node.id, item.n),
          kind: "q",
          nodeId: node.id,
          n: item.n,
          branchId: subject.rootId,
          branchSlug: subject.slug,
          branchTitle: subject.title,
          sectionId,
          domainId,
          title: node.title,
          front: item.q,
          back: item.a,
        });
      }
    } else {
      for (const t of collectTermsForNode(node)) {
        cards.push({
          id: termCardId(node.id, t.slug),
          kind: "t",
          nodeId: node.id,
          slug: t.slug,
          branchId: subject.rootId,
          branchSlug: subject.slug,
          branchTitle: subject.title,
          sectionId,
          domainId,
          title: node.title,
          front: t.term,
          back: t.def,
          source: t.source,
        });
      }
    }
  }
  return { cards, failures, mode };
}

/** Unit-test helper: parse every node's Practice block in a branch JSON. */
export function auditPracticeBranch(branchName, nodes) {
  const pages = [];
  const failures = [];
  let pairs = 0;
  for (const node of nodes || []) {
    const has = hasPracticeHeading(node.expanded || "");
    if (!has) continue;
    const parsed = parsePracticePairs(node.expanded || "");
    pages.push({ id: node.id, title: node.title, count: parsed.items.length, reason: parsed.reason });
    pairs += parsed.items.length;
    if (!parsed.ok) failures.push({ branch: branchName, id: node.id, title: node.title, reason: parsed.reason });
  }
  return { branch: branchName, practicePages: pages.length, pairs, failures, pages };
}
