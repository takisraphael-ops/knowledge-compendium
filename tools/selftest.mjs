#!/usr/bin/env node
// Checks crypto round-trip, note rendering, the edit model, layout, and merge_edits.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { decryptJson, deriveKey, encryptJson, randomBytes } from "../js/crypto.js";
import { buildBacklinkIndex, extractOutgoingIds } from "../js/backlinks.js";
import {
  BOOKMARKS_KEY,
  MOCK_HISTORY_KEY,
  NOTES_KEY,
  PASS_PCT,
  appendMockAttempt,
  buildProgressBundle,
  collectProgress,
  encryptProgress,
  mergeHistory,
  mergeNotes,
  mergeProgress,
  pickMockQuestions,
  preferSrsCard,
  readProgressPayload,
  sanitizeNotes,
  upsertNote,
  weakestDomain,
  weakestDomainFromHistory,
  writeProgress,
} from "../js/progress.js";
import { boxesOverlap, layoutMap, assignSides, assignSidesRight } from "../js/layout.js";
import {
  buildIndex,
  editCount,
  emptyEdits,
  idsPassingDocFilter,
  materialize,
  normalizeEdits,
  normalizeNode,
  searchBlob,
  subtreeIds,
  wouldCycle,
} from "../js/model.js";
import { renderNotes, renderKeyTerms, renderKeyPoints } from "../js/notes.js";
import { parseHash } from "../js/route.js";
import { allocateMockQuestions, domainsForVersion } from "../js/cards.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failed = 0;
function check(name, cond) {
  if (!cond) {
    failed += 1;
    console.error("FAIL", name);
  } else {
    console.log("ok", name);
  }
}

const html = renderNotes(
  "Intro line\n@@ Oven log\n### Heat\n- steam the pot\n1. Wait\n2.✓ Bake\n| Stage | Time |\n| --- | --- |\n| Hot | 20 |\n@@ Tide book\nRising water."
);
check("source block", html.includes('class="src-block"') && html.includes("Oven log") && html.includes("Tide book"));
check("heading bullet table", html.includes("<h3>") && html.includes("<ul>") && html.includes("<ol>") && html.includes("<th>Stage</th>"));
check("escapes html", !renderNotes("<script>").includes("<script>"));
check("code url not autolinked", renderNotes("See `https://api.example.com/v1`").includes("<code>https://api.example.com/v1</code>"));
check("SY0-801 and SY0-701 domains", domainsForVersion("801")[1].label.includes("Attacks (24%)") && domainsForVersion("701")[1].label.includes("Mitigations (22%)"));

function plenty(domains, n = 1000) {
  const avail = {};
  for (const d of domains) avail[d.id] = n;
  return avail;
}
function drawnOf(domains, total, available) {
  return allocateMockQuestions(domains, total, available).map((row) => row.drawn);
}
function weightSum(domains) {
  return domains.reduce((sum, d) => sum + d.weight, 0);
}
const sy801 = domainsForVersion("801");
const sy701 = domainsForVersion("701");
const full801 = drawnOf(sy801, 90, plenty(sy801));
const full701 = drawnOf(sy701, 90, plenty(sy701));
check("SY0-801 full mock weights", full801.join() === "14,22,17,24,13" && full801.reduce((a, b) => a + b, 0) === 90);
check("SY0-701 full mock weights", full701.join() === "11,20,16,25,18" && full701.reduce((a, b) => a + b, 0) === 90);
check("SY0-801 and SY0-701 proportions differ", full801.join() !== full701.join());
check("quick and half mocks follow each blueprint",
  drawnOf(sy801, 25, plenty(sy801)).join() === "4,6,5,7,3"
  && drawnOf(sy701, 25, plenty(sy701)).join() === "3,6,4,7,5"
  && drawnOf(sy801, 45, plenty(sy801)).join() === "7,11,9,12,6"
  && drawnOf(sy701, 45, plenty(sy701)).join() === "5,10,8,13,9");
for (const [label, domains, total, got] of [
  ["801/90", sy801, 90, full801],
  ["701/90", sy701, 90, full701],
  ["801/25", sy801, 25, drawnOf(sy801, 25, plenty(sy801))],
  ["701/45", sy701, 45, drawnOf(sy701, 45, plenty(sy701))],
]) {
  const sum = weightSum(domains);
  const close = got.every((n, i) => Math.abs(n - Math.round((total * domains[i].weight) / sum)) <= 1);
  check(`mock share within one seat (${label})`, close);
}
const scarce = { "sy0-d1": 100, "sy0-d2": 100, "sy0-d3": 100, "sy0-d4": 2, "sy0-d5": 100 };
const capped = allocateMockQuestions(sy801, 25, scarce);
check("mock caps a short domain and redistributes",
  capped.map((row) => row.drawn).join() === "5,8,6,2,4"
  && capped.every((row) => row.drawn <= row.available)
  && capped.reduce((sum, row) => sum + row.drawn, 0) === 25);
const tiny = plenty(sy801, 2);
const short = allocateMockQuestions(sy801, 90, tiny);
check("mock draws only what exists",
  short.every((row) => row.drawn === 2)
  && short.reduce((sum, row) => sum + row.drawn, 0) === 10);
const emptyDomain = { "sy0-d1": 80, "sy0-d2": 0, "sy0-d3": 80, "sy0-d4": 80, "sy0-d5": 80 };
const skipped = allocateMockQuestions(sy701, 25, emptyDomain);
check("mock gives nothing to an empty domain",
  skipped.find((row) => row.id === "sy0-d2").drawn === 0
  && skipped.every((row) => row.drawn <= row.available)
  && skipped.reduce((sum, row) => sum + row.drawn, 0) === 25);
check("malformed legacy hash safe", parseHash("#%E0%A4%A", { index: buildIndex([{ id: "root", title: "Root", parentId: null }]), subjects: [] }).mode === "overview");

const base = [
  { id: "root", title: "Root", parentId: null, summary: "", text: "", docs: [], tags: [] },
  { id: "a", title: "A", parentId: "root", summary: "old", text: "body", docs: ["OV"], tags: [] },
  { id: "b", title: "B", parentId: "a", summary: "", text: "", docs: [], tags: ["glossary"] },
];
const edits = normalizeEdits({
  added: [{ id: "n1", title: "New", parentId: "a", summary: "", text: "fresh", docs: [], tags: [] }],
  changed: { a: { summary: "new", parentId: "root" } },
  deleted: ["b"],
});
let nodes = materialize(base, edits);
let index = buildIndex(nodes);
check("edit apply", index.byId.get("a").summary === "new" && index.byId.has("n1") && !index.byId.has("b"));
check("cycle", wouldCycle(index, "a", "n1") === true && wouldCycle(index, "n1", "root") === false);
check("subtree", subtreeIds(index, "a").sort().join() === ["a", "n1"].sort().join());
const keep = idsPassingDocFilter(index, "OV");
check("doc filter", keep.has("a") && keep.has("root") && !keep.has("n1"));
check("edit count", editCount(edits) === 3 && editCount(emptyEdits()) === 0);

const withTerms = normalizeNode({
  id: "kt", title: "Key terms test", parentId: "root",
  keyTerms: [
    { term: "MFA (multi-factor authentication)", def: "Two different factor types.", link: "c48" },
    { term: "  ", def: "skip" },
    { def: "no term" },
  ],
});
check("keyTerms kept", Array.isArray(withTerms.keyTerms) && withTerms.keyTerms.length === 1 && withTerms.keyTerms[0].link === "c48");
check("keyTerms dropped when empty", !("keyTerms" in normalizeNode({ id: "x", title: "X" })));
const ktBlob = searchBlob(withTerms);
check("searchBlob includes keyTerms", ktBlob.includes("multi-factor authentication") && ktBlob.includes("two different factor types"));
const ktHtml = renderKeyTerms(withTerms);
check("renderKeyTerms block", ktHtml.includes("key-terms") && ktHtml.includes("open") && ktHtml.includes("c48") && ktHtml.includes("Two different factor types."));
check("renderKeyTerms empty", renderKeyTerms({ id: "z" }) === "");

const withPoints = normalizeNode({
  id: "kp", title: "Key points test", parentId: "root",
  keyPoints: ["AES uses 128-bit blocks.", "  ", "3DES is not for new encryption."],
  keyPointsFromOwner: true,
});
check("keyPoints kept", Array.isArray(withPoints.keyPoints) && withPoints.keyPoints.length === 2 && withPoints.keyPointsFromOwner === true);
check("keyPoints dropped when empty", !("keyPoints" in normalizeNode({ id: "x", title: "X" })));
check("searchBlob includes keyPoints", searchBlob(withPoints).includes("128-bit blocks"));
const kpHtml = renderKeyPoints(withPoints);
check("renderKeyPoints block", kpHtml.includes("panel-key-points") && kpHtml.includes("AES uses 128-bit blocks.") && kpHtml.includes("Drawn from the Key Points table"));
check("renderKeyPoints empty", renderKeyPoints({ id: "z" }) === "");

const withRelated = normalizeNode({ id: "rel", title: "Related", relatedIds: ["c2", "c2", "  ", 12, { id: "nope" }] });
check("relatedIds kept", Array.isArray(withRelated.relatedIds) && withRelated.relatedIds.join() === "c2,12");
check("relatedIds dropped when empty", !("relatedIds" in normalizeNode({ id: "x", title: "X", relatedIds: [] })));
const relatedNodes = materialize(
  [{ id: "rel", title: "Related", parentId: null, relatedIds: ["c2"] }],
  emptyEdits()
);
check("materialize keeps relatedIds", relatedNodes[0].relatedIds.join() === "c2");

const linkNodes = [
  { id: "root", title: "Root", parentId: null, summary: "", expanded: "" },
  { id: "c362", title: "Packet filter", parentId: "root", summary: "See #/networking/c48.", expanded: "Also `c1` and `c362`." },
  { id: "c48", title: "Firewall", parentId: "root", summary: "", expanded: "Pairs with `#/cybersecurity/c362` and `c362` again.", relatedIds: ["c362", "missing", "c362"] },
  { id: "c1", title: "Overview leaf", parentId: "root", summary: "Mention `nope` and c362 in prose.", expanded: "", text: "Ignore `#/networking/c48` and `c362`.", tidy: "`c48`" },
  { id: "networking", title: "Not the branch slot", parentId: "root", summary: "", expanded: "Route `#/networking/c48` must not treat the branch as a node." },
];
const knownLinkIds = new Set(linkNodes.map((n) => n.id));
check(
  "outgoing refs from related ids, hashes, and ticks",
  extractOutgoingIds(linkNodes[2], knownLinkIds).join() === "c362"
);
check(
  "hash and tick refs skip self, unknowns, and prose",
  extractOutgoingIds(linkNodes[1], knownLinkIds).join() === "c48,c1"
);
check("summary hash is a ref", extractOutgoingIds(linkNodes[4], knownLinkIds).join() === "c48");
check("text and tidy are not scanned", extractOutgoingIds(linkNodes[3], knownLinkIds).join() === "");
check(
  "nested hash keeps later segments only",
  extractOutgoingIds({ id: "other", expanded: "Open #/cybersecurity/c1/c362.", summary: "" }, knownLinkIds).join() === "c1,c362"
);
const linkIndex = buildBacklinkIndex(linkNodes, (node) => (
  node.id === "c48"
    ? { branchId: "cybersecurity", branchTitle: "Cybersecurity" }
    : { branchId: "networking", branchTitle: "Networking" }
));
const packetRefs = linkIndex.get("c362");
check(
  "reverse index lists each referrer once",
  packetRefs.length === 1 && packetRefs[0].id === "c48"
);
check(
  "reverse index keeps title and branch",
  packetRefs[0].title === "Firewall" && packetRefs[0].branchId === "cybersecurity" && packetRefs[0].branchTitle === "Cybersecurity"
);
check("unreferenced node is absent", !linkIndex.has("missing") && !linkIndex.has("root"));
const firewallRefs = linkIndex.get("c48");
check(
  "cross-subject referrers are indexed",
  firewallRefs.map((r) => r.id).join() === "c362,networking" && firewallRefs.every((r) => r.branchTitle === "Networking")
);

function chain(n, prefix) {
  const nodes = [{ id: "root", title: "Root", parentId: null }];
  const children = new Map([["root", []]]);
  for (let i = 0; i < 40; i++) {
    const id = `${prefix}${i}`;
    nodes.push({ id, title: `Branch ${i} with a reasonably long label`, parentId: "root" });
    children.get("root").push(id);
    children.set(id, []);
    for (let d = 0; d < 30; d++) {
      const cid = `${id}-${d}`;
      nodes.push({ id: cid, title: `Child ${d} of branch ${i}`, parentId: id });
      children.get(id).push(cid);
    }
  }
  return { nodes, children };
}
const big = chain();
const bigIndex = buildIndex(big.nodes);
const sides = assignSides(bigIndex.rootId, bigIndex.children);
const rightKids = bigIndex.children.get(bigIndex.rootId) || [];
const rightSides = assignSidesRight(bigIndex.rootId, bigIndex.children);
check(
  "assignSidesRight",
  rightKids.length > 0 && rightSides.size === rightKids.length && rightKids.every((id) => rightSides.get(id) === 1)
);
const colors = new Map();
const t0 = performance.now();
const positions = layoutMap({
  rootId: "root",
  children: bigIndex.children,
  measure: (id) => ({ w: Math.min(240, 80 + (bigIndex.byId.get(id).title.length % 40) * 3), h: id === "root" ? 54 : 40 }),
  isOpen: () => true,
  kidsOf: (id) => bigIndex.children.get(id) || [],
  sides,
  colors,
});
const ms = performance.now() - t0;
check(`layout ${positions.size} nodes in ${ms.toFixed(0)}ms`, positions.size === big.nodes.length && ms < 250);
let overlaps = 0;
const list = [...positions.values()];
for (let i = 0; i < list.length; i++) {
  for (let j = i + 1; j < list.length; j++) if (boxesOverlap(list[i], list[j])) overlaps += 1;
}
check("no overlaps", overlaps === 0);

const salt = randomBytes(16);
const key = await deriveKey("correct horse battery", salt, 100000, true);
const secret = { nodes: [{ id: "x", title: "Hidden", text: "@@ Source\n- one" }] };
const blob = await encryptJson(key, secret, "demo");
const back = await decryptJson(key, blob, "demo");
check("round trip", JSON.stringify(back) === JSON.stringify(secret));
let rejected = false;
try {
  const other = await deriveKey("nope", salt, 100000, true);
  await decryptJson(other, blob, "demo");
} catch {
  rejected = true;
}
check("wrong passphrase rejected", rejected);
let swapped = false;
try {
  await decryptJson(key, blob, "other-branch");
} catch {
  swapped = true;
}
check("swapped branch id rejected", swapped);
const packed = await encryptJson(key, secret, "demo", { compress: true });
check("compressed payload flagged", packed.comp === "deflate");
const packedBack = await decryptJson(key, packed, "demo");
check("compressed round trip", JSON.stringify(packedBack) === JSON.stringify(secret));
check("uncompressed payload has no comp flag", blob.comp == null);

const dir = await mkdtemp(join(tmpdir(), "kc-merge-"));
await mkdir(join(dir, "plain"), { recursive: true });
await writeFile(join(dir, "plain", "tree.json"), JSON.stringify({ nodes: [{ id: "root", title: "Root", parentId: null, summary: "", text: "", docs: [], tags: [] }] }));
await writeFile(join(dir, "plain", "galley.json"), JSON.stringify({
  nodes: [
    { id: "g-stew", title: "Stew", parentId: "root", summary: "", text: "", docs: [], tags: [] },
    { id: "g-salt", title: "Salt", parentId: "g-stew", summary: "Old salt note", text: "", docs: [], tags: [] },
    { id: "g-long", title: "Long", parentId: "g-stew", summary: "", text: "", docs: [], tags: [] },
  ],
}));
const sampleEdits = {
  v: 1,
  added: [{ id: "g-new", title: "Ash cakes", parentId: "g-stew", summary: "On the coals.", text: "", docs: [], tags: ["stew"] }],
  changed: { "g-salt": { summary: "Updated salt note" } },
  deleted: ["g-long"],
};
await writeFile(join(dir, "edits.json"), JSON.stringify(sampleEdits));
const merged = spawnSync("python3", ["tools/merge_edits", join(dir, "edits.json"), join(dir, "plain")], { cwd: root, encoding: "utf8" });
check("merge exit", merged.status === 0);
const galley = JSON.parse(await readFile(join(dir, "plain", "galley.json"), "utf8"));
const ids = new Set(galley.nodes.map((n) => n.id));
check(
  "merge result",
  ids.has("g-new") && !ids.has("g-long") && galley.nodes.find((n) => n.id === "g-salt").summary === "Updated salt note"
);
const dry = spawnSync("python3", ["tools/merge_edits", join(dir, "edits.json"), join(dir, "plain"), "--dry-run"], { cwd: root, encoding: "utf8" });
check("merge dry-run", dry.status === 0 && dry.stdout.includes("dry run"));
await rm(dir, { recursive: true, force: true });

const catalogPath = join(root, "data", "index.json");
try {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  let hasSample = true;
  try { await readFile(join(root, "sample-data", "tree.json")); } catch { hasSample = false; }
  if (hasSample) {
    const demoKey = await deriveKey("open-sesame", Buffer.from(catalog.kdf.salt, "base64"), catalog.kdf.iterations, true);
    for (const branch of catalog.branches) {
      const payload = JSON.parse(await readFile(join(root, "data", branch.file), "utf8"));
      const plain = await decryptJson(demoKey, payload, branch.id);
      const expected = JSON.parse(await readFile(join(root, "sample-data", `${branch.id}.json`), "utf8"));
      check(`committed ${branch.id} matches sample`, JSON.stringify(plain) === JSON.stringify(expected));
    }
  } else {
    for (const branch of catalog.branches) {
      const payload = JSON.parse(await readFile(join(root, "data", branch.file), "utf8"));
      check(`committed ${branch.id} envelope valid`, payload.v === 1 && payload.alg === "AES-GCM" && typeof payload.iv === "string" && typeof payload.ciphertext === "string");
    }
  }
} catch (err) {
  check(`committed catalog (${err.message})`, false);
}

const privateDir = join(root, "private");
try {
  const cyber = JSON.parse(await readFile(join(privateDir, "cybersecurity.json"), "utf8"));
  const tree = JSON.parse(await readFile(join(privateDir, "tree.json"), "utf8"));
  const all = [...tree.nodes, ...cyber.nodes];
  const priv = buildIndex(all);
  check("private node count", priv.byId.size === tree.nodes.length + cyber.nodes.length);
  const rendered = { blocks: 0, tables: 0 };
  for (const node of cyber.nodes) {
    if (!node.text) continue;
    const out = renderNotes(node.text);
    if (out.includes("src-block")) rendered.blocks += 1;
    if (out.includes("<table>")) rendered.tables += 1;
  }
  check(`private render blocks ${rendered.blocks} tables ${rendered.tables}`, rendered.blocks > 10 && rendered.tables > 10);
  const pSides = assignSides(priv.rootId, priv.children);
  const t1 = performance.now();
  const laid = layoutMap({
    rootId: priv.rootId,
    children: priv.children,
    measure: (id) => ({ w: 180, h: id === priv.rootId ? 54 : 40 }),
    isOpen: () => true,
    kidsOf: (id) => priv.children.get(id) || [],
    sides: pSides,
    colors: new Map(),
  });
  const layoutMs = performance.now() - t1;
  let bad = 0;
  const boxes = [...laid.values()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (boxesOverlap(boxes[i], boxes[j], 1)) bad += 1;
  }
  check(`private layout ${laid.size} in ${layoutMs.toFixed(0)}ms overlaps ${bad}`, laid.size === priv.byId.size && bad === 0 && layoutMs < 400);
} catch {
  console.log("skip private corpus (private/ not present)");
}

function srsCard(over = {}) {
  return {
    ease: 2.5,
    interval: 1,
    reps: 1,
    lapses: 0,
    due: 10,
    last: 1000,
    lastGrade: "good",
    introducedOn: "2026-01-01",
    ...over,
  };
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function mockAttempt(over = {}) {
  const correct = over.correct ?? 8;
  const total = over.total ?? 10;
  return {
    id: over.id || "m-1",
    date: over.date || "2026-11-01T00:00:00.000Z",
    examVersion: over.examVersion || "801",
    length: over.length || total,
    total,
    correct,
    pct: Math.round((100 * correct) / total),
    passed: Math.round((100 * correct) / total) >= PASS_PCT,
    durationSec: over.durationSec ?? 90,
    domains: over.domains || [
      { id: "sy0-d1", label: "Concepts", correct: 4, total: 5, pct: 80 },
      { id: "sy0-d2", label: "Threats", correct: 1, total: 5, pct: 20 },
    ],
  };
}

const kept = preferSrsCard(
  srsCard({ reps: 2, lapses: 1, last: 9000 }),
  srsCard({ reps: 1, lapses: 0, last: 1000 })
);
check("srs keeps more-reviewed card", kept.reps === 2 && kept.last === 9000);
const newer = preferSrsCard(
  srsCard({ reps: 2, lapses: 1, last: 1000 }),
  srsCard({ reps: 3, lapses: 0, last: 4000, ease: 2.8 })
);
check("srs tie on reviews uses newer last", newer.last === 4000 && newer.ease === 2.8);

const localBundle = buildProgressBundle({
  exportedAt: "2026-11-01T00:00:00.000Z",
  srs: {
    settings: { newPerDay: 20, scope: { branchIds: ["cyber"], sectionIds: [], domainIds: [], mode: "flashcards", examVersion: "801" } },
    cards: {
      "t:c1:alpha": srsCard({ reps: 1, lapses: 0, last: 5000 }),
      "t:c2:local": srsCard({ reps: 3, lapses: 0, last: 3000 }),
    },
  },
  mockHistory: [mockAttempt({ id: "old-mock", date: "2026-10-01T00:00:00.000Z" })],
  bookmarks: ["c1"],
  recent: [{ id: "c1", at: 10 }, { id: "c3", at: 4 }],
  prefs: { theme: "light", viewMode: "map", autoFold: true, examVersion: "801" },
});
const incomingBundle = buildProgressBundle({
  exportedAt: "2026-11-20T00:00:00.000Z",
  srs: {
    settings: { newPerDay: 5, scope: { branchIds: [], sectionIds: [], domainIds: [], mode: "practice", examVersion: "701" } },
    cards: {
      "t:c1:alpha": srsCard({ reps: 4, lapses: 1, last: 1000, ease: 2.8 }),
      "q:c90:1": srsCard({ reps: 2, lapses: 0, last: 2000 }),
    },
  },
  mockHistory: [
    mockAttempt({ id: "old-mock", date: "2026-10-02T00:00:00.000Z", correct: 9 }),
    mockAttempt({ id: "new-mock", date: "2026-11-20T00:00:00.000Z", correct: 9, examVersion: "701" }),
  ],
  bookmarks: ["c2", "c1"],
  recent: [{ id: "c2", at: 50 }, { id: "c1", at: 5 }],
  prefs: { theme: "dark", viewMode: "outline", autoFold: false, examVersion: "701" },
});
const mergedProgress = mergeProgress(localBundle, incomingBundle, { replace: false });
check(
  "merge keeps more-reviewed alpha card",
  mergedProgress.srs.cards["t:c1:alpha"].reps === 4 && mergedProgress.srs.cards["t:c1:alpha"].lapses === 1
);
check("merge keeps local-only card and incoming card", mergedProgress.srs.cards["t:c2:local"].reps === 3 && mergedProgress.srs.cards["q:c90:1"].reps === 2);
check("merge keeps local new-card cap", mergedProgress.srs.settings.newPerDay === 20);
check("merge unions bookmarks in existing order", mergedProgress.bookmarks.join() === "c1,c2");
check("merge recent is newest first", mergedProgress.recent.map((item) => item.id).join() === "c2,c1,c3");
check("merge dedupes mock history by id", mergedProgress.mockHistory.filter((item) => item.id === "old-mock").length === 1);
check("merge keeps the newer copy of a shared attempt", mergedProgress.mockHistory.find((item) => item.id === "old-mock").correct === 9);
check("merge applies incoming prefs", mergedProgress.prefs.theme === "dark" && mergedProgress.prefs.viewMode === "outline" && mergedProgress.prefs.autoFold === false && mergedProgress.prefs.examVersion === "701");
check("merge writes exam version onto the srs scope", mergedProgress.srs.settings.scope.examVersion === "701" && mergedProgress.srs.settings.scope.branchIds.includes("cyber"));

const replaced = mergeProgress(localBundle, incomingBundle, { replace: true });
check("replace drops local-only card", !replaced.srs.cards["t:c2:local"] && replaced.srs.cards["q:c90:1"]);
check("replace takes incoming daily cap", replaced.srs.settings.newPerDay === 5);
check("replace uses incoming bookmarks", replaced.bookmarks.join() === "c2,c1");

const sameStamp = mergeHistory(
  [mockAttempt({ id: "one", date: "2026-11-20T12:00:00.000Z" })],
  [mockAttempt({ id: "two", date: "2026-11-20T12:00:00.000Z", correct: 9 })]
);
check("mock history dedupes identical timestamps", sameStamp.length === 1 && sameStamp[0].id === "two");

const cappedCurrent = [];
const cappedIncoming = [];
for (let i = 0; i < 40; i++) cappedCurrent.push(mockAttempt({ id: `a-${i}`, date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
for (let i = 0; i < 30; i++) cappedIncoming.push(mockAttempt({ id: `b-${i}`, date: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString() }));
const historyCapped = mergeHistory(cappedCurrent, cappedIncoming);
check("mock history caps at 50 newest", historyCapped.length === 50 && historyCapped[0].id === "b-29" && !historyCapped.some((item) => item.id === "a-0"));

const legacy = {
  v: 1,
  exportedAt: "2026-01-01T00:00:00.000Z",
  settings: { newPerDay: 10 },
  cards: { "t:c9:zeta": srsCard({ reps: 8, lapses: 0, last: 9 }) },
};
const legacyMerged = mergeProgress(localBundle, legacy, { replace: false });
check("legacy srs import merges cards and keeps bookmarks", legacyMerged.srs.cards["t:c9:zeta"].reps === 8 && legacyMerged.bookmarks.includes("c1") && legacyMerged.mockHistory.length === 1);

const cleanedNotes = sanitizeNotes({
  "bad id": { text: "x", updatedAt: 1 },
  c1: { text: "  ", updatedAt: 5 },
  c2: { text: "keep", updatedAt: "nope" },
  c3: { text: 12, updatedAt: 3 },
});
check(
  "notes sanitize drops blanks and bad ids",
  cleanedNotes.c2.text === "keep" && cleanedNotes.c2.updatedAt === 0 && !cleanedNotes.c1 && !cleanedNotes.c3 && !cleanedNotes["bad id"]
);
const noteMerged = mergeNotes(
  { c1: { text: "local", updatedAt: 10 }, c2: { text: "newer local", updatedAt: 50 }, c3: { text: "only local", updatedAt: 1 } },
  { c1: { text: "incoming", updatedAt: 20 }, c2: { text: "older", updatedAt: 40 }, c4: { text: "only incoming", updatedAt: 2 }, c5: { text: "   ", updatedAt: 9 } }
);
check("notes newest wins", noteMerged.c1.text === "incoming" && noteMerged.c1.updatedAt === 20);
check("notes older incoming loses", noteMerged.c2.text === "newer local");
check("notes keeps one-sided entries", noteMerged.c3.text === "only local" && noteMerged.c4.text === "only incoming" && !noteMerged.c5);
check("notes tie keeps local", mergeNotes({ c1: { text: "local", updatedAt: 5 } }, { c1: { text: "other", updatedAt: 5 } }).c1.text === "local");

const notesLocalBundle = buildProgressBundle({
  notes: { c1: { text: "local", updatedAt: 10 }, c2: { text: "stay", updatedAt: 3 } },
  bookmarks: ["c1"],
});
const notesIncomingBundle = buildProgressBundle({
  notes: { c1: { text: "remote", updatedAt: 11 }, c9: { text: "added", updatedAt: 4 } },
  bookmarks: ["c9"],
});
const notesMerged = mergeProgress(notesLocalBundle, notesIncomingBundle, { replace: false });
check(
  "progress merge notes newest per node",
  notesMerged.notes.c1.text === "remote" && notesMerged.notes.c2.text === "stay" && notesMerged.notes.c9.text === "added"
);
const notesReplaced = mergeProgress(notesLocalBundle, notesIncomingBundle, { replace: true });
check(
  "progress replace takes incoming notes",
  notesReplaced.notes.c1.text === "remote" && !notesReplaced.notes.c2 && notesReplaced.notes.c9.text === "added"
);
const legacyNotesMerge = mergeProgress(notesLocalBundle, legacy, { replace: false });
const legacyNotesReplace = mergeProgress(notesLocalBundle, legacy, { replace: true });
check(
  "legacy progress file keeps personal notes",
  legacyNotesMerge.notes.c1.text === "local" && legacyNotesMerge.notes.c2.text === "stay" && legacyNotesReplace.notes.c2.text === "stay"
);

const history = [
  mockAttempt({
    id: "a",
    date: "2026-11-01T00:00:00.000Z",
    examVersion: "801",
    correct: 6,
    domains: [
      { id: "sy0-d1", label: "Concepts", correct: 5, total: 5, pct: 100 },
      { id: "sy0-d2", label: "Threats", correct: 1, total: 5, pct: 20 },
    ],
  }),
  mockAttempt({
    id: "b",
    date: "2026-11-02T00:00:00.000Z",
    examVersion: "801",
    correct: 6,
    domains: [
      { id: "sy0-d1", label: "Concepts", correct: 2, total: 5, pct: 40 },
      { id: "sy0-d2", label: "Threats", correct: 4, total: 5, pct: 80 },
    ],
  }),
  mockAttempt({
    id: "c",
    date: "2026-11-03T00:00:00.000Z",
    examVersion: "701",
    correct: 0,
    total: 5,
    domains: [{ id: "sy0-d4", label: "Ops", correct: 0, total: 5, pct: 0 }],
  }),
];
check("weakest domain across 801 attempts", weakestDomainFromHistory(history, "801").id === "sy0-d2");
check("weakest domain respects exam version", weakestDomainFromHistory(history, "701").id === "sy0-d4");
check(
  "weakest domain tie prefers more questions then smaller id",
  weakestDomain([
    { id: "sy0-d5", label: "Prog", correct: 1, total: 2, pct: 50 },
    { id: "sy0-d1", label: "Concepts", correct: 2, total: 4, pct: 50 },
  ]).id === "sy0-d1" &&
  weakestDomain([
    { id: "sy0-d5", label: "Prog", correct: 1, total: 4, pct: 25 },
    { id: "sy0-d3", label: "Arch", correct: 1, total: 4, pct: 25 },
  ]).id === "sy0-d3"
);
const once = appendMockAttempt([], mockAttempt({ id: "once", date: "2026-11-04T00:00:00.000Z" }));
const twice = appendMockAttempt(once, mockAttempt({ id: "once", date: "2026-11-04T00:00:00.000Z" }));
check("append does not duplicate an attempt", twice.length === 1);

const pools = [];
for (const domain of domainsForVersion("801")) {
  for (let i = 0; i < 30; i++) pools.push({ id: `q:${domain.id}:${i}`, domainId: domain.id });
}
const drawn = pickMockQuestions(pools, domainsForVersion("801"), 10, () => 0);
check("mock draw follows the requested length", drawn.length === 10);

const mem = memoryStorage();
writeProgress(mem, localBundle);
check("progress keys", mem.getItem(BOOKMARKS_KEY).includes("c1") && mem.getItem(MOCK_HISTORY_KEY).includes("old-mock"));
const collected = collectProgress(mem);
check("storage round trip", collected.bookmarks.includes("c1") && collected.mockHistory.length === 1 && collected.srs.cards["t:c2:local"].reps === 3);
upsertNote(mem, "c1", "  on device ", 8);
check("note upsert", JSON.parse(mem.getItem(NOTES_KEY)).c1.text === "  on device " && JSON.parse(mem.getItem(NOTES_KEY)).c1.updatedAt === 8);
check("collect reads notes", collectProgress(mem).notes.c1.text === "  on device ");
upsertNote(mem, "c1", "   ", 9);
check("blank note deleted", mem.getItem(NOTES_KEY) == null);

const progressKey = await deriveKey("progress passphrase", randomBytes(16), 1000, true);
const secretBundle = buildProgressBundle({
  exportedAt: "2026-11-27T00:00:00.000Z",
  srs: { cards: { "t:node:secret-token-zxq": srsCard({ reps: 6, lapses: 1, last: 42 }) } },
  mockHistory: [mockAttempt({ id: "enc-1", date: "2026-11-27T00:00:00.000Z" })],
  bookmarks: ["secret-token-zxq"],
  recent: [{ id: "secret-token-zxq", at: 7 }],
  notes: { "secret-token-zxq": { text: "private scratch", updatedAt: 9 } },
  prefs: { theme: "dark", viewMode: "map", autoFold: true, examVersion: "801" },
});
const envelope = await encryptProgress(progressKey, secretBundle);
const envelopeText = JSON.stringify(envelope);
check("encrypted export is an envelope", envelope.alg === "AES-GCM" && !envelopeText.includes("secret-token-zxq") && !envelopeText.includes("private scratch"));
const decrypted = await readProgressPayload(envelopeText, progressKey);
check(
  "encrypted round trip",
  decrypted.srs.cards["t:node:secret-token-zxq"].reps === 6 &&
  decrypted.bookmarks.includes("secret-token-zxq") &&
  decrypted.mockHistory[0].id === "enc-1" &&
  decrypted.notes["secret-token-zxq"].text === "private scratch"
);
const plainRead = await readProgressPayload(JSON.stringify(secretBundle), null);
check("plain json import", plainRead.srs.cards["t:node:secret-token-zxq"].reps === 6 && plainRead.prefs.theme === "dark" && plainRead.notes["secret-token-zxq"].updatedAt === 9);
let badPass = "";
try {
  const otherKey = await deriveKey("wrong passphrase", randomBytes(16), 1000, true);
  await readProgressPayload(envelopeText, otherKey);
} catch (err) {
  badPass = err.code;
}
check("wrong passphrase rejected", badPass === "decrypt");
let badJson = "";
try { await readProgressPayload("{", null); } catch (err) { badJson = err.code; }
check("malformed progress rejected", badJson === "malformed");
let notProgress = "";
try { await readProgressPayload(JSON.stringify({ hello: 1 }), null); } catch (err) { notProgress = err.code; }
check("unrecognised json rejected", notProgress === "malformed");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all checks passed");
