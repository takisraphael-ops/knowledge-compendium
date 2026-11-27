#!/usr/bin/env node
// Checks crypto round-trip, note rendering, the edit model, layout, and merge_edits.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { decryptJson, deriveKey, encryptJson, randomBytes } from "../js/crypto.js";
import { boxesOverlap, layoutMap, assignSides } from "../js/layout.js";
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

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("all checks passed");
