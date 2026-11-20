export const DOC_NAMES = {
  CS: "Computer Security",
  CT: "CompTIA notes",
  GC: "Google Cybersecurity Certificate",
  CY: "Cyberstudy notebook",
  NM: "cybersecurity-nomenclature-additions",
  GG: "GCC glossary",
  G1: "GCC Course 1 glossary",
  CR: "Computing Research",
  HW: "Hardware",
  BI: "Biology",
  RS: "Research",
  MA: "Mathematics (image notes, transcribed)",
  ME: "Added in the compendium",
  OV: "Oven log",
  TB: "Tide book",
};

const CORE = ["id", "title", "parentId", "summary", "text", "expanded", "docs", "tags"];

export function docLabel(code) {
  return DOC_NAMES[code] || code;
}

export function emptyEdits() {
  return { v: 1, added: [], changed: {}, deleted: [] };
}

export function normalizeNode(raw) {
  const n = raw && typeof raw === "object" ? raw : {};
  const node = {
    id: String(n.id ?? ""),
    title: String(n.title ?? "Untitled"),
    parentId: n.parentId == null || n.parentId === "" ? null : String(n.parentId),
    summary: String(n.summary ?? ""),
    text: String(n.text ?? ""),
    expanded: String(n.expanded ?? ""),
    docs: Array.isArray(n.docs) ? n.docs.map(String) : [],
    tags: Array.isArray(n.tags) ? n.tags.map(String) : [],
  };
  if (n.link) node.link = String(n.link);
  if (n.linkLabel) node.linkLabel = String(n.linkLabel);
  return node;
}

export function normalizeEdits(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const added = [];
  if (Array.isArray(src.added)) {
    for (const item of src.added) {
      const n = normalizeNode(item);
      if (n.id) added.push(n);
    }
  }
  const changed = {};
  if (src.changed && typeof src.changed === "object" && !Array.isArray(src.changed)) {
    for (const [id, patch] of Object.entries(src.changed)) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) continue;
      const clean = {};
      for (const [k, v] of Object.entries(patch)) {
        if (k === "docs" || k === "tags") clean[k] = Array.isArray(v) ? v.map(String) : [];
        else if (k === "parentId") clean[k] = v == null || v === "" ? null : String(v);
        else if (CORE.includes(k) || k === "link" || k === "linkLabel") clean[k] = v == null ? "" : String(v);
      }
      if (Object.keys(clean).length) changed[String(id)] = clean;
    }
  }
  const deleted = Array.isArray(src.deleted) ? [...new Set(src.deleted.map(String))] : [];
  return { v: 1, added, changed, deleted };
}

export function editCount(edits) {
  if (!edits) return 0;
  return edits.added.length + Object.keys(edits.changed).length + edits.deleted.length;
}

export function materialize(baseNodes, edits) {
  const byId = new Map();
  const baseOrder = [];
  const baseIds = new Set();
  for (const raw of baseNodes || []) {
    const n = normalizeNode(raw);
    if (!n.id) continue;
    if (byId.has(n.id)) Object.assign(byId.get(n.id), n);
    else {
      byId.set(n.id, n);
      baseOrder.push(n.id);
    }
    baseIds.add(n.id);
  }
  const addedIds = [];
  for (const raw of edits?.added || []) {
    const n = normalizeNode(raw);
    if (!n.id) continue;
    if (byId.has(n.id)) Object.assign(byId.get(n.id), n);
    else {
      byId.set(n.id, n);
      addedIds.push(n.id);
    }
  }
  for (const [id, patch] of Object.entries(edits?.changed || {})) {
    const n = byId.get(id);
    if (!n) continue;
    for (const [k, v] of Object.entries(patch)) {
      if (k === "docs" || k === "tags") n[k] = Array.isArray(v) ? v.slice() : [];
      else n[k] = v;
    }
  }
  const dead = new Set(edits?.deleted || []);
  let grew = true;
  const all = () => byId.values();
  while (grew) {
    grew = false;
    for (const n of all()) {
      if (!dead.has(n.id) && n.parentId && dead.has(n.parentId)) {
        dead.add(n.id);
        grew = true;
      }
    }
  }
  const nodes = [];
  for (const id of baseOrder) if (!dead.has(id)) nodes.push(byId.get(id));
  for (const id of addedIds) if (!baseIds.has(id) && !dead.has(id) && byId.has(id)) nodes.push(byId.get(id));
  return nodes;
}

export function buildIndex(nodes) {
  const byId = new Map();
  const order = [];
  for (const raw of nodes) {
    const n = normalizeNode(raw);
    if (!n.id) continue;
    if (byId.has(n.id)) Object.assign(byId.get(n.id), n);
    else {
      byId.set(n.id, n);
      order.push(n.id);
    }
  }
  const children = new Map();
  for (const id of order) {
    const parentId = byId.get(id).parentId;
    if (!parentId) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(id);
  }
  let rootId = order.find((id) => byId.get(id).parentId == null) || order[0] || null;
  if (byId.has("root")) rootId = "root";
  return { byId, children, order, rootId };
}

export function ancestorIds(index, id) {
  const out = [];
  const seen = new Set();
  let cur = index.byId.get(id)?.parentId;
  while (cur && index.byId.has(cur) && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = index.byId.get(cur).parentId;
  }
  return out;
}

export function subtreeIds(index, id) {
  const out = [];
  const stack = [id];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const child of index.children.get(cur) || []) stack.push(child);
  }
  return out;
}

export function wouldCycle(index, id, newParent) {
  if (!newParent) return false;
  if (newParent === id) return true;
  const seen = new Set();
  let cur = newParent;
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = index.byId.get(cur)?.parentId;
  }
  return false;
}

export function orphanIds(index) {
  const out = [];
  for (const id of index.order) {
    if (id === index.rootId) continue;
    const parentId = index.byId.get(id).parentId;
    if (!parentId || !index.byId.has(parentId)) out.push(id);
  }
  return out;
}

/** Ids to keep when a source filter is on: the node or a descendant carries that doc. Root is always kept. */
export function idsPassingDocFilter(index, doc) {
  if (!doc) return null;
  const keep = new Set();
  const walk = (id) => {
    const node = index.byId.get(id);
    if (!node) return false;
    let ok = (node.docs || []).includes(doc);
    for (const child of index.children.get(id) || []) {
      if (walk(child)) ok = true;
    }
    if (ok) keep.add(id);
    return ok;
  };
  if (index.rootId) {
    walk(index.rootId);
    keep.add(index.rootId);
  }
  return keep;
}

export function searchBlob(node) {
  return [node.title, node.summary, node.text, node.expanded || "", ...(node.docs || []), ...(node.tags || [])]
    .join("\n")
    .toLowerCase();
}

export function safeUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url), "https://example.invalid");
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    /* ignore */
  }
  return "";
}

export function listsEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Patch fields that differ from the base node. Empty object if nothing changed. */
export function diffNode(base, next) {
  const patch = {};
  for (const key of ["title", "summary", "text", "expanded", "parentId", "link", "linkLabel"]) {
    const bv = base?.[key] ?? (key === "parentId" ? null : "");
    const nv = next?.[key] ?? (key === "parentId" ? null : "");
    if (bv !== nv) patch[key] = next?.[key] ?? (key === "parentId" ? null : "");
  }
  if (!listsEqual(base?.docs || [], next?.docs || [])) patch.docs = (next?.docs || []).slice();
  if (!listsEqual(base?.tags || [], next?.tags || [])) patch.tags = (next?.tags || []).slice();
  return patch;
}
