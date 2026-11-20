import {
  DEFAULT_ITERATIONS,
  EDITS_AAD,
  b64ToBytes,
  decryptJson,
  decryptUtf8,
  deriveKey,
  encryptUtf8,
  exportRawKey,
  importRawKey,
} from "./crypto.js";
import { layoutMap, assignSides } from "./layout.js";
import {
  ancestorIds,
  buildIndex,
  diffNode,
  docLabel,
  editCount,
  emptyEdits,
  idsPassingDocFilter,
  materialize,
  normalizeEdits,
  normalizeNode,
  orphanIds,
  safeUrl,
  searchBlob,
  subtreeIds,
  wouldCycle,
} from "./model.js";
import { escapeHtml, renderNotes } from "./notes.js";

const PALETTE = [
  "#1a73e8",
  "#188038",
  "#e37400",
  "#9334e6",
  "#d01884",
  "#007b83",
  "#c5221f",
  "#7b1fa2",
  "#0d904f",
  "#b06000",
  "#3949ab",
  "#00838f",
  "#ad1457",
  "#558b2f",
];

const KEY_STORE = "kc-unlock-v1";
const LOCK_FLAG = "kc-locked";
const DATA_BASE = new URL("../data/", import.meta.url);

const $ = (id) => document.getElementById(id);

const els = {
  gate: $("gate"),
  gateForm: $("gate-form"),
  passphrase: $("passphrase"),
  remember: $("remember"),
  gateError: $("gate-error"),
  gateStatus: $("gate-status"),
  gateDemo: $("gate-demo"),
  savedRow: $("saved-row"),
  continueBtn: $("continue-saved"),
  forgetBtn: $("forget-saved"),
  app: $("app"),
  brand: $("brand"),
  count: $("count"),
  search: $("search"),
  matchLabel: $("match-label"),
  docFilter: $("doc-filter"),
  editsBtn: $("edits-btn"),
  editsMenu: $("edits-menu"),
  lockBtn: $("lock-btn"),
  viewport: $("viewport"),
  world: $("world"),
  edges: $("edges"),
  nodes: $("nodes"),
  panel: $("panel"),
  zoomLabel: $("zoom-label"),
  hint: $("hint"),
  modal: $("modal"),
  toast: $("toast"),
};

const state = {
  indexFile: null,
  key: null,
  saltB64: "",
  iterations: DEFAULT_ITERATIONS,
  baseNodes: [],
  edits: emptyEdits(),
  index: null,
  blobs: new Map(),
  baseById: new Map(),
  sides: new Map(),
  colors: new Map(),
  expanded: new Set(),
  selected: null,
  editing: false,
  depthOpen: false,
  query: "",
  hits: [],
  hitCursor: 0,
  doc: "",
  filter: null,
  hitAncestors: new Set(),
  cam: { x: 40, y: 40, k: 1 },
  userMoved: false,
  positions: new Map(),
};

const nodeButtons = new Map();
let toastTimer = 0;
let searchTimer = 0;
let measureCtx = null;

function measureOf(id) {
  const node = state.index.byId.get(id);
  const root = id === state.index.rootId;
  const kids = visibleKids(id);
  const badge = !root && kids.length > 0;
  const font = root
    ? '600 18px "Liberation Serif", Georgia, serif'
    : '600 14px "Liberation Sans", "Segoe UI", sans-serif';
  let textW = [...(node?.title || "")].length * (root ? 9 : 7.4);
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  measureCtx.font = font;
  textW = measureCtx.measureText(node?.title || "").width;
  const chrome = (root ? 40 : 42) + (badge ? 40 : 0);
  const max = root ? 380 : 260;
  const min = root ? 168 : 108;
  return {
    w: Math.round(Math.min(max, Math.max(min, textW + chrome))),
    h: root ? 54 : 40,
  };
}

function visibleKids(id) {
  const kids = state.index.children.get(id) || [];
  if (!state.filter) return kids;
  return kids.filter((kid) => state.filter.has(kid));
}

function passes(id) {
  if (!state.filter) return true;
  return state.filter.has(id);
}

function rebuildDerived() {
  const nodes = materialize(state.baseNodes, state.edits);
  state.index = buildIndex(nodes);
  state.baseById = new Map(state.baseNodes.map((n) => [String(n.id), normalizeNode(n)]));
  state.blobs = new Map();
  for (const [id, node] of state.index.byId) state.blobs.set(id, searchBlob(node));
  state.sides = assignSides(state.index.rootId, state.index.children);
  state.colors = new Map();
  const level1 = state.index.children.get(state.index.rootId) || [];
  level1.forEach((id, i) => state.colors.set(id, PALETTE[i % PALETTE.length]));
  if (state.selected && !state.index.byId.has(state.selected)) {
    state.selected = null;
    state.editing = false;
  }
  const alive = state.index.byId;
  for (const id of [...state.expanded]) if (!alive.has(id)) state.expanded.delete(id);
  state.filter = idsPassingDocFilter(state.index, state.doc);
  fillDocFilter();
}

function branchColor(id) {
  if (!state.index || id === state.index.rootId) return "#1f2a2e";
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (state.colors.has(cur)) return state.colors.get(cur);
    cur = state.index.byId.get(cur)?.parentId;
  }
  return PALETTE[0];
}

function editedIds() {
  const ids = new Set(state.edits.added.map((n) => n.id));
  for (const id of Object.keys(state.edits.changed)) ids.add(id);
  return ids;
}

function draw() {
  const rootId = state.index.rootId;
  state.positions = layoutMap({
    rootId,
    children: state.index.children,
    measure: measureOf,
    isOpen: (id) => id === rootId || state.expanded.has(id),
    kidsOf: visibleKids,
    sides: state.sides,
    colors: state.colors,
  });
  drawEdges();
  drawNodes();
  const shown = state.positions.size;
  const total = state.index.byId.size;
  els.count.textContent = state.doc || state.query ? `${shown} shown · ${total} topics` : `${total} topics`;
  const n = editCount(state.edits);
  els.editsBtn.textContent = n ? `Edits ${n}` : "Edits";
  els.editsBtn.classList.toggle("has-edits", n > 0);
  els.panel.classList.toggle("open", Boolean(state.selected));
  document.body.classList.toggle("panel-open", Boolean(state.selected));
}

function drawEdges() {
  const paths = [];
  for (const pos of state.positions.values()) {
    if (!pos.parentId) continue;
    const parent = state.positions.get(pos.parentId);
    if (!parent) continue;
    const a = edgePoint(parent, pos.x, pos.y);
    const b = edgePoint(pos, parent.x, parent.y);
    const dx = b.x - a.x;
    const c1 = a.x + dx * 0.55;
    const c2 = b.x - dx * 0.55;
    paths.push(
      `<path d="M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${c1.toFixed(1)} ${a.y.toFixed(1)}, ${c2.toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}" stroke="${pos.color}" />`
    );
  }
  let minX = -400;
  let minY = -400;
  let maxX = 400;
  let maxY = 400;
  for (const p of state.positions.values()) {
    minX = Math.min(minX, p.x - p.w / 2 - 80);
    maxX = Math.max(maxX, p.x + p.w / 2 + 80);
    minY = Math.min(minY, p.y - p.h / 2 - 80);
    maxY = Math.max(maxY, p.y + p.h / 2 + 80);
  }
  const svg = els.edges;
  svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  svg.style.left = `${minX}px`;
  svg.style.top = `${minY}px`;
  svg.style.width = `${maxX - minX}px`;
  svg.style.height = `${maxY - minY}px`;
  svg.innerHTML = paths.join("");
}

function edgePoint(node, tx, ty) {
  const dx = tx - node.x;
  const dy = ty - node.y;
  const a = node.w / 2 + 1;
  const b = node.h / 2 + 1;
  const len = Math.hypot(dx / a, dy / b) || 1;
  return { x: node.x + dx / len, y: node.y + dy / len };
}

function highlightTitle(title, query) {
  const safe = escapeHtml(title);
  if (!query || query.length < 2) return safe;
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}

function drawNodes() {
  const seen = new Set();
  const hits = new Set(state.hits);
  const current = state.hits[state.hitCursor];
  const touched = editedIds();
  for (const [id, pos] of state.positions) {
    seen.add(id);
    let btn = nodeButtons.get(id);
    const fresh = !btn;
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "node";
      btn.dataset.id = id;
      nodeButtons.set(id, btn);
      els.nodes.appendChild(btn);
    }
    const node = state.index.byId.get(id);
    const root = id === state.index.rootId;
    const kids = visibleKids(id);
    const open = state.expanded.has(id);
    btn.classList.toggle("root", root);
    btn.classList.toggle("selected", id === state.selected);
    btn.classList.toggle("match", hits.has(id));
    btn.classList.toggle("current", id === current);
    btn.classList.toggle("edited", touched.has(id));
    btn.classList.toggle("dim", state.query.length >= 2 && !hits.has(id) && !state.hitAncestors.has(id));
    btn.style.left = `${pos.x}px`;
    btn.style.top = `${pos.y}px`;
    btn.style.width = `${pos.w}px`;
    btn.style.height = `${pos.h}px`;
    btn.style.setProperty("--c", pos.color);
    btn.setAttribute("aria-pressed", id === state.selected ? "true" : "false");
    btn.title = node.title;
    const badge = !root && kids.length
      ? `<span class="badge">${open ? "–" : `+${kids.length}`}</span>`
      : "";
    const dot = root ? "" : `<span class="dot" aria-hidden="true"></span>`;
    const html = `${dot}<span class="label">${highlightTitle(node.title, state.query)}</span>${badge}`;
    if (btn.dataset.html !== html) {
      btn.innerHTML = html;
      btn.dataset.html = html;
    }
    if (fresh) btn.classList.add("enter");
  }
  for (const [id, btn] of nodeButtons) {
    if (!seen.has(id)) {
      btn.remove();
      nodeButtons.delete(id);
    }
  }
}


function applyCam() {
  els.world.style.transform = `translate(${state.cam.x}px, ${state.cam.y}px) scale(${state.cam.k})`;
  els.zoomLabel.textContent = `${Math.round(state.cam.k * 100)}%`;
}

function zoomAt(sx, sy, nextK) {
  const k = clamp(nextK, 0.08, 2.4);
  const wx = (sx - state.cam.x) / state.cam.k;
  const wy = (sy - state.cam.y) / state.cam.k;
  state.cam.k = k;
  state.cam.x = sx - wx * k;
  state.cam.y = sy - wy * k;
  applyCam();
}

function fit(idSet) {
  const rect = els.viewport.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const [id, p] of state.positions) {
    if (idSet && !idSet.has(id)) continue;
    any = true;
    minX = Math.min(minX, p.x - p.w / 2);
    maxX = Math.max(maxX, p.x + p.w / 2);
    minY = Math.min(minY, p.y - p.h / 2);
    maxY = Math.max(maxY, p.y + p.h / 2);
  }
  if (!any) return;
  const padL = 28;
  const padR = 28;
  const padT = 24;
  const padB = 96;
  const bw = Math.max(40, maxX - minX);
  const bh = Math.max(40, maxY - minY);
  const k = clamp(Math.min((rect.width - padL - padR) / bw, (rect.height - padT - padB) / bh), 0.08, 1.15);
  state.cam.k = k;
  state.cam.x = padL + (rect.width - padL - padR - bw * k) / 2 - minX * k;
  state.cam.y = padT + (rect.height - padT - padB - bh * k) / 2 - minY * k;
  applyCam();
}

function ensureVisible(id) {
  const p = state.positions.get(id);
  if (!p) return;
  const rect = els.viewport.getBoundingClientRect();
  const sx = state.cam.x + p.x * state.cam.k;
  const sy = state.cam.y + p.y * state.cam.k;
  const m = 48;
  if (sx < m || sy < m || sx > rect.width - m || sy > rect.height - m) {
    state.cam.x = rect.width / 2 - p.x * state.cam.k;
    state.cam.y = rect.height / 2 - p.y * state.cam.k;
    applyCam();
  }
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function select(id, { toggle = false } = {}) {
  if (!state.index.byId.has(id)) return;
  state.selected = id;
  state.editing = false;
  state.depthOpen = false;
  for (const a of ancestorIds(state.index, id)) state.expanded.add(a);
  const kids = visibleKids(id);
  if (toggle && kids.length && id !== state.index.rootId) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
  }
  els.hint.hidden = true;
  draw();
  renderPanel();
  revealBranch(id);
  const hash = `#${encodeURIComponent(id)}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function revealBranch(id) {
  const extra = [];
  if (state.positions.has(id)) extra.push(id);
  if (state.expanded.has(id)) {
    for (const kid of visibleKids(id)) if (state.positions.has(kid)) extra.push(kid);
  }
  const rect = els.viewport.getBoundingClientRect();
  if (rect.width < 20 || !extra.length) return;
  const outside = (nid) => {
    const p = state.positions.get(nid);
    const sx = state.cam.x + p.x * state.cam.k;
    const sy = state.cam.y + p.y * state.cam.k;
    const hw = (p.w / 2) * state.cam.k + 16;
    const hh = (p.h / 2) * state.cam.k + 16;
    return sx - hw < 0 || sy - hh < 0 || sx + hw > rect.width || sy + hh > rect.height;
  };
  if (!extra.some(outside)) return;
  // Keep whatever is already on screen, and pull the new pills into that same view.
  let minX = (0 - state.cam.x) / state.cam.k;
  let minY = (0 - state.cam.y) / state.cam.k;
  let maxX = (rect.width - state.cam.x) / state.cam.k;
  let maxY = (rect.height - state.cam.y) / state.cam.k;
  for (const nid of extra) {
    const p = state.positions.get(nid);
    minX = Math.min(minX, p.x - p.w / 2 - 28);
    maxX = Math.max(maxX, p.x + p.w / 2 + 28);
    minY = Math.min(minY, p.y - p.h / 2 - 28);
    maxY = Math.max(maxY, p.y + p.h / 2 + 28);
  }
  const pad = 32;
  const bw = Math.max(40, maxX - minX);
  const bh = Math.max(40, maxY - minY);
  state.cam.k = clamp(Math.min((rect.width - pad) / bw, (rect.height - pad) / bh, state.cam.k), 0.12, 1.15);
  state.cam.x = (rect.width - (minX + maxX) * state.cam.k) / 2;
  state.cam.y = (rect.height - (minY + maxY) * state.cam.k) / 2;
  applyCam();
}

function expandAll() {
  for (const [id, kids] of state.index.children) {
    if ((state.filter ? kids.filter((k) => state.filter.has(k)) : kids).length) state.expanded.add(id);
  }
  if (state.index.rootId) state.expanded.add(state.index.rootId);
  draw();
  state.userMoved = false;
  fit();
}

function collapseAll() {
  state.expanded = new Set();
  draw();
  state.userMoved = false;
  fit();
}

function expandSubtree(id) {
  const walk = (cur) => {
    const kids = visibleKids(cur);
    if (!kids.length) return;
    state.expanded.add(cur);
    for (const kid of kids) walk(kid);
  };
  walk(id);
  draw();
}

function runSearch(options = {}) {
  const q = state.query.trim().toLowerCase();
  state.hits = [];
  state.hitAncestors = new Set();
  if (q.length >= 2) {
    for (const id of state.index.order) {
      if (state.filter && !state.filter.has(id) && id !== state.index.rootId) continue;
      const blob = state.blobs.get(id) || "";
      if (blob.includes(q)) state.hits.push(id);
    }
    for (const id of state.hits) {
      for (const a of ancestorIds(state.index, id)) {
        state.expanded.add(a);
        state.hitAncestors.add(a);
      }
    }
  }
  state.hitCursor = 0;
  if (state.hits.length && options.focus !== false) {
    state.selected = state.hits[0];
    state.editing = false;
    state.depthOpen = false;
  }
  draw();
  const n = state.hits.length;
  els.matchLabel.textContent = q.length < 2 ? "" : n ? `1 / ${n}` : "No matches";
  if (n && options.focus !== false) {
    if (state.cam.k < 0.72) state.cam.k = 0.72;
    const id = state.hits[0];
    const p = state.positions.get(id);
    if (p) {
      const rect = els.viewport.getBoundingClientRect();
      state.cam.x = rect.width / 2 - p.x * state.cam.k;
      state.cam.y = rect.height / 2 - p.y * state.cam.k;
      applyCam();
    }
    markCurrentHit();
    renderPanel();
  }
}

function markCurrentHit() {
  const id = state.hits[state.hitCursor];
  if (!id) return;
  els.matchLabel.textContent = `${state.hitCursor + 1} / ${state.hits.length}`;
  for (const btn of nodeButtons.values()) btn.classList.toggle("current", btn.dataset.id === id);
  ensureVisible(id);
}

function stepHit(dir) {
  if (!state.hits.length) return;
  state.hitCursor = (state.hitCursor + dir + state.hits.length) % state.hits.length;
  const id = state.hits[state.hitCursor];
  select(id, { toggle: false });
  markCurrentHit();
}

function fillDocFilter() {
  const prev = state.doc;
  const counts = new Map();
  for (const node of state.index.byId.values()) {
    for (const doc of node.docs || []) counts.set(doc, (counts.get(doc) || 0) + 1);
  }
  const known = Object.keys(DOC_ORDER);
  const codes = [...counts.keys()].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a.localeCompare(b);
  });
  const options = [`<option value="">All sources</option>`];
  for (const code of codes) {
    options.push(
      `<option value="${escapeHtml(code)}">${escapeHtml(docLabel(code))} (${counts.get(code)})</option>`
    );
  }
  els.docFilter.innerHTML = options.join("");
  if ([...counts.keys()].includes(prev) || prev === "") els.docFilter.value = prev;
  else {
    state.doc = "";
    state.filter = null;
  }
}

const DOC_ORDER = {
  CS: 1, CT: 1, GC: 1, CY: 1, NM: 1, GG: 1, G1: 1, ME: 1, OV: 1, TB: 1,
};

function renderPanel() {
  const id = state.selected;
  if (!id || !state.index.byId.has(id)) {
    const root = state.index.byId.get(state.index.rootId);
    els.panel.innerHTML = `
      <div class="empty-panel">
        <p class="eyebrow">Knowledge compendium</p>
        <h1>${escapeHtml(root?.title || "Compendium")}</h1>
        <p>${escapeHtml(root?.summary || "Select a topic on the map.")}</p>
        <p class="muted">${state.index.byId.size} topics. Click a branch to open it. Scroll to zoom, drag to move.</p>
      </div>`;
    return;
  }
  const node = state.index.byId.get(id);
  const crumbs = [...ancestorIds(state.index, id)].reverse();
  const crumbHtml = crumbs
    .map((cid) => `<button type="button" data-act="open" data-id="${escapeHtml(cid)}">${escapeHtml(state.index.byId.get(cid).title)}</button>`)
    .join(`<span class="sep">/</span>`);
  const kidLinks = (state.index.children.get(id) || [])
    .map((kid) => {
      const child = state.index.byId.get(kid);
      const hidden = state.filter && !state.filter.has(kid);
      if (hidden) return "";
      return `<button type="button" class="subtopic" data-act="open" data-id="${escapeHtml(kid)}"><span class="dot" style="--c:${branchColor(kid)}"></span>${escapeHtml(child.title)}</button>`;
    })
    .join("");
  const docs = (node.docs || [])
    .map((d) => `<button type="button" class="chip" data-act="filter-doc" data-doc="${escapeHtml(d)}">${escapeHtml(docLabel(d))}</button>`)
    .join("");
  const tags = (node.tags || []).map((t) => `<span class="chip quiet">${escapeHtml(t)}</span>`).join("");
  const url = safeUrl(node.link);
  const link = url
    ? `<p class="outlink"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(node.linkLabel || url)}</a></p>`
    : "";
  const hiddenNote = state.filter && !state.filter.has(id) && id !== state.index.rootId
    ? `<p class="banner">Hidden by the current source filter.</p>`
    : "";
  const orphan = !node.parentId && id !== state.index.rootId || (node.parentId && !state.index.byId.has(node.parentId));
  const orphanNote = orphan ? `<p class="banner">This topic is not on the map because its parent is missing.</p>` : "";

  if (state.editing) {
    els.panel.innerHTML = `
      <div class="panel-top">
        <div class="panel-bar"><button type="button" class="textish" data-act="cancel-edit">Cancel</button><span>Edit topic</span><button type="button" class="textish strong" data-act="save">Save</button></div>
      </div>
      <label class="field">Title<input id="f-title" value="${escapeHtml(node.title)}"></label>
      <label class="field">Summary<textarea id="f-summary" rows="3">${escapeHtml(node.summary)}</textarea></label>
      <label class="field">Notes<textarea id="f-text" rows="12">${escapeHtml(node.text)}</textarea></label>
      <p class="hint-text">Lines that start with @@ name a source. ### is a heading, “- ” is a bullet, and “| a | b |” is a table.</p>
      <label class="field">Sources <span class="hint-text">codes, comma separated</span><input id="f-docs" value="${escapeHtml((node.docs || []).join(", "))}"></label>
      <label class="field">Tags<input id="f-tags" value="${escapeHtml((node.tags || []).join(", "))}"></label>
      <div class="row-actions"><button type="button" class="solid" data-act="save">Save on this device</button></div>`;
    return;
  }

  const more = node.text
    ? `<button type="button" class="depth-btn" data-act="depth" aria-expanded="${state.depthOpen ? "true" : "false"}">${state.depthOpen ? "Hide depth" : "More depth"}</button>
       <div id="depth-body" class="notes" ${state.depthOpen ? "" : "hidden"}></div>`
    : "";

  els.panel.innerHTML = `
    <div class="panel-top" style="--c:${branchColor(id)}">
      <div class="panel-bar">
        <button type="button" class="icon-btn" data-act="close-panel" aria-label="Close">×</button>
        <div class="crumbs">${crumbHtml}</div>
      </div>
      <h1>${escapeHtml(node.title)}</h1>
    </div>
    ${hiddenNote}${orphanNote}
    ${node.summary ? `<p class="summary">${escapeHtml(node.summary)}</p>` : ""}
    ${link}
    ${docs || tags ? `<div class="chips">${docs}${tags}</div>` : ""}
    ${more}
    ${kidLinks ? `<h2 class="subhead">Subtopics</h2><div class="subtopics">${kidLinks}</div>` : ""}
    <div class="row-actions">
      <button type="button" data-act="edit">Edit</button>
      <button type="button" data-act="add">Add subtopic</button>
      ${id === state.index.rootId ? "" : `<button type="button" data-act="move">Move</button><button type="button" class="danger" data-act="delete">Delete</button>`}
    </div>`;

  if (state.depthOpen && node.text) {
    const box = $("depth-body");
    if (box) box.innerHTML = renderNotes(node.text);
  }
}

function readList(value) {
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function saveForm() {
  const id = state.selected;
  const node = state.index.byId.get(id);
  if (!node) return;
  const next = {
    ...node,
    title: $("f-title").value.trim() || "Untitled",
    summary: $("f-summary").value.trim(),
    text: $("f-text").value,
    docs: readList($("f-docs").value),
    tags: readList($("f-tags").value),
  };
  commitNode(next);
  state.editing = false;
  toast("Saved on this device");
  refresh();
}

function commitNode(next) {
  const added = state.edits.added.find((n) => n.id === next.id);
  if (added || !state.baseById.has(next.id)) {
    const full = normalizeNode(next);
    state.edits.added = state.edits.added.filter((n) => n.id !== next.id);
    state.edits.added.push(full);
    delete state.edits.changed[next.id];
  } else {
    const patch = diffNode(state.baseById.get(next.id), next);
    if (Object.keys(patch).length) state.edits.changed[next.id] = patch;
    else delete state.edits.changed[next.id];
  }
  persistEdits();
}

function addSubtopic() {
  const parentId = state.selected;
  if (!parentId) return;
  const id = newId();
  const node = normalizeNode({
    id,
    title: "New topic",
    parentId,
    summary: "",
    text: "",
    docs: [],
    tags: [],
  });
  state.edits.added.push(node);
  persistEdits();
  state.expanded.add(parentId);
  state.selected = id;
  state.editing = true;
  state.depthOpen = false;
  toast("Subtopic added on this device");
  refresh();
  const title = $("f-title");
  if (title) {
    title.focus();
    title.select();
  }
}

function newId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return `e${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function deleteSelected() {
  const id = state.selected;
  if (!id || id === state.index.rootId) return;
  const count = subtreeIds(state.index, id).length;
  openModal(`
    <h2>Delete topic</h2>
    <p>Delete <strong>${escapeHtml(state.index.byId.get(id).title)}</strong>${count > 1 ? ` and ${count - 1} subtopic${count > 2 ? "s" : ""}` : ""}? This stays in the edit layer until you merge it into the master notes.</p>
    <div class="row-actions">
      <button type="button" data-act="modal-close">Cancel</button>
      <button type="button" class="danger solid" data-act="confirm-delete">Delete</button>
    </div>`);
}

function confirmDelete() {
  const id = state.selected;
  const drop = new Set(subtreeIds(state.index, id));
  state.edits.added = state.edits.added.filter((n) => !drop.has(n.id));
  for (const dead of drop) delete state.edits.changed[dead];
  for (const dead of drop) {
    if (state.baseById.has(dead) && !state.edits.deleted.includes(dead)) state.edits.deleted.push(dead);
  }
  persistEdits();
  state.selected = state.index.byId.get(id)?.parentId || state.index.rootId;
  state.editing = false;
  closeModal();
  toast("Deleted on this device");
  refresh();
}

function openMove() {
  const id = state.selected;
  openModal(`
    <h2>Move “${escapeHtml(state.index.byId.get(id).title)}”</h2>
    <input id="move-q" placeholder="Search for the new parent" autocomplete="off">
    <div id="move-results" class="move-results"></div>
    <div class="row-actions"><button type="button" data-act="modal-close">Cancel</button></div>`);
  const input = $("move-q");
  input.addEventListener("input", () => renderMoveResults(input.value));
  renderMoveResults("");
  input.focus();
}

function renderMoveResults(query) {
  const box = $("move-results");
  if (!box) return;
  const id = state.selected;
  const banned = new Set(subtreeIds(state.index, id));
  const q = query.trim().toLowerCase();
  const rows = [];
  for (const nid of state.index.order) {
    if (banned.has(nid)) continue;
    const node = state.index.byId.get(nid);
    if (q && !node.title.toLowerCase().includes(q)) continue;
    const trail = [...ancestorIds(state.index, nid)].reverse().map((a) => state.index.byId.get(a).title).join(" / ");
    rows.push(`<button type="button" data-act="move-to" data-id="${escapeHtml(nid)}"><strong>${escapeHtml(node.title)}</strong><span>${escapeHtml(trail)}</span></button>`);
    if (rows.length >= 40) break;
  }
  box.innerHTML = rows.join("") || `<p class="muted">No topics match.</p>`;
}

function moveTo(parentId) {
  const id = state.selected;
  if (wouldCycle(state.index, id, parentId)) {
    toast("That would put the topic inside itself");
    return;
  }
  const node = { ...state.index.byId.get(id), parentId };
  commitNode(node);
  closeModal();
  toast("Moved on this device");
  refresh();
  ensureVisible(id);
}

function persistEdits() {
  if (!state.key) return;
  if (state.editsUnreadable) {
    toast("Older edits on this device could not be unlocked. Discard them before saving new ones.");
    return;
  }
  const run = async () => {
    if (editCount(state.edits) === 0) {
      localStorage.removeItem(editsKey());
      return;
    }
    const payload = await encryptUtf8(state.key, JSON.stringify(state.edits), EDITS_AAD);
    localStorage.setItem(editsKey(), JSON.stringify(payload));
  };
  run().catch((err) => {
    console.error(err);
    toast("Could not save edits on this device");
  });
}

function editsKey() {
  return `kc-edits-v1:${state.saltB64.slice(0, 12)}`;
}

async function loadEdits() {
  const raw = localStorage.getItem(editsKey());
  state.edits = emptyEdits();
  if (!raw) return;
  try {
    const payload = JSON.parse(raw);
    const text = await decryptUtf8(state.key, payload, EDITS_AAD);
    state.edits = normalizeEdits(JSON.parse(text));
  } catch {
    toast("Edits saved on this device could not be unlocked and were left as they are");
    state.editsUnreadable = raw;
  }
}

function exportEdits() {
  const body = {
    v: 1,
    exportedAt: new Date().toISOString(),
    added: state.edits.added,
    changed: state.edits.changed,
    deleted: state.edits.deleted,
  };
  const json = JSON.stringify(body, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = URL.createObjectURL(blob);
  a.download = `compendium-edits-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  navigator.clipboard?.writeText(json).then(
    () => toast("Edits downloaded and copied. The file is plaintext."),
    () => toast("Edits downloaded. Clipboard was not available.")
  );
  els.editsMenu.hidden = true;
}

function openImport() {
  els.editsMenu.hidden = true;
  openModal(`
    <h2>Import edits</h2>
    <p class="muted">Replaces the edit layer on this device. The file never leaves the browser.</p>
    <input id="import-file" type="file" accept="application/json,.json">
    <textarea id="import-text" rows="8" placeholder="Or paste the exported JSON"></textarea>
    <div class="row-actions">
      <button type="button" data-act="modal-close">Cancel</button>
      <button type="button" class="solid" data-act="confirm-import">Import</button>
    </div>`);
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    $("import-text").value = await file.text();
  });
}

function confirmImport() {
  const text = $("import-text")?.value?.trim();
  if (!text) {
    toast("Paste an edits file first");
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    toast("That is not JSON");
    return;
  }
  if (!parsed || typeof parsed !== "object" || (!parsed.added && !parsed.changed && !parsed.deleted)) {
    toast("That file does not look like exported edits");
    return;
  }
  state.edits = normalizeEdits(parsed);
  state.editsUnreadable = null;
  persistEdits();
  closeModal();
  toast("Edits imported");
  refresh();
}

function discardEdits() {
  els.editsMenu.hidden = true;
  openModal(`
    <h2>Discard edits</h2>
    <p>Remove every edit stored on this device? Topics you have not merged go back to the encrypted notes.</p>
    <div class="row-actions">
      <button type="button" data-act="modal-close">Cancel</button>
      <button type="button" class="danger solid" data-act="confirm-discard">Discard</button>
    </div>`);
}

async function confirmDiscard() {
  state.edits = emptyEdits();
  state.editsUnreadable = null;
  localStorage.removeItem(editsKey());
  closeModal();
  toast("Edits discarded");
  refresh();
}

function refresh() {
  rebuildDerived();
  if (state.query.trim().length >= 2) runSearch({ focus: false });
  else {
    state.hits = [];
    draw();
  }
  renderPanel();
}

function openModal(html) {
  els.modal.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true">${html}</div>`;
  els.modal.hidden = false;
}

function closeModal() {
  els.modal.hidden = true;
  els.modal.innerHTML = "";
}

function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3400);
}

function onPanelClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || !els.panel.contains(btn)) return;
  const act = btn.dataset.act;
  if (act === "open") select(btn.dataset.id, { toggle: true });
  else if (act === "close-panel") {
    state.selected = null;
    state.editing = false;
    history.replaceState(null, "", location.pathname + location.search);
    draw();
    renderPanel();
  } else if (act === "depth") {
    state.depthOpen = !state.depthOpen;
    const box = $("depth-body");
    const node = state.index.byId.get(state.selected);
    if (state.depthOpen && box && node && !box.dataset.ready) {
      box.innerHTML = renderNotes(node.text);
      box.dataset.ready = "1";
    }
    if (box) box.hidden = !state.depthOpen;
    btn.setAttribute("aria-expanded", state.depthOpen ? "true" : "false");
    btn.textContent = state.depthOpen ? "Hide depth" : "More depth";
  } else if (act === "edit") {
    state.editing = true;
    renderPanel();
  } else if (act === "cancel-edit") {
    state.editing = false;
    renderPanel();
  } else if (act === "save") saveForm();
  else if (act === "add") addSubtopic();
  else if (act === "move") openMove();
  else if (act === "delete") deleteSelected();
  else if (act === "filter-doc") {
    state.doc = btn.dataset.doc;
    state.filter = idsPassingDocFilter(state.index, state.doc);
    els.docFilter.value = state.doc;
    draw();
    if (state.query.trim().length >= 2) runSearch({ focus: false });
  }
}

function onModalClick(e) {
  if (e.target === els.modal) {
    closeModal();
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "modal-close") closeModal();
  else if (act === "confirm-delete") confirmDelete();
  else if (act === "confirm-discard") confirmDiscard();
  else if (act === "confirm-import") confirmImport();
  else if (act === "move-to") moveTo(btn.dataset.id);
}

function wireCamera() {
  const active = new Map();
  let gesture = null;
  let lastTap = { id: null, t: 0 };

  els.viewport.addEventListener("pointerdown", (e) => {
    if (e.button != null && e.button !== 0) return;
    const node = e.target.closest?.(".node");
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size === 1) {
      gesture = {
        type: "pan",
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        camx: state.cam.x,
        camy: state.cam.y,
        moved: false,
        nodeId: node?.dataset.id || null,
      };
    }
  });
  els.viewport.addEventListener("pointermove", (e) => {
    if (!active.has(e.pointerId)) return;
    active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (active.size >= 2) {
      const pts = [...active.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const rect = els.viewport.getBoundingClientRect();
      const mid = {
        x: (pts[0].x + pts[1].x) / 2 - rect.left,
        y: (pts[0].y + pts[1].y) / 2 - rect.top,
      };
      if (!gesture || gesture.type !== "pinch") {
        gesture = { type: "pinch", dist, cam: { ...state.cam }, mid };
      }
      const k = clamp(gesture.cam.k * (dist / gesture.dist), 0.08, 2.4);
      const wx = (gesture.mid.x - gesture.cam.x) / gesture.cam.k;
      const wy = (gesture.mid.y - gesture.cam.y) / gesture.cam.k;
      state.cam.k = k;
      state.cam.x = mid.x - wx * k;
      state.cam.y = mid.y - wy * k;
      state.userMoved = true;
      applyCam();
      return;
    }
    if (!gesture || gesture.type !== "pan" || gesture.id !== e.pointerId) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) > 5) {
      gesture.moved = true;
      els.viewport.setPointerCapture(e.pointerId);
    }
    if (gesture.moved) {
      state.cam.x = gesture.camx + dx;
      state.cam.y = gesture.camy + dy;
      state.userMoved = true;
      applyCam();
    }
  });
  const end = (e) => {
    const g = gesture;
    active.delete(e.pointerId);
    if (g?.type === "pan" && g.id === e.pointerId && !g.moved && g.nodeId && active.size === 0) {
      const now = performance.now();
      if (lastTap.id === g.nodeId && now - lastTap.t < 350) {
        expandSubtree(g.nodeId);
        ensureVisible(g.nodeId);
        lastTap = { id: null, t: 0 };
      } else {
        lastTap = { id: g.nodeId, t: now };
        select(g.nodeId, { toggle: true });
      }
    }
    if (active.size === 0) gesture = null;
  };
  els.viewport.addEventListener("pointerup", end);
  els.viewport.addEventListener("pointercancel", end);
  els.nodes.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const btn = e.target.closest(".node");
    if (!btn) return;
    e.preventDefault();
    select(btn.dataset.id, { toggle: true });
  });

  els.viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = els.viewport.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-dy * 0.0016);
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, state.cam.k * factor);
      state.userMoved = true;
    },
    { passive: false }
  );
}

function wireChrome() {
  els.panel.addEventListener("click", onPanelClick);
  els.modal.addEventListener("click", onModalClick);
  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(), 140);
  });
  $("match-prev").addEventListener("click", () => stepHit(-1));
  $("match-next").addEventListener("click", () => stepHit(1));
  els.docFilter.addEventListener("change", () => {
    state.doc = els.docFilter.value;
    state.filter = idsPassingDocFilter(state.index, state.doc);
    draw();
    if (state.query.trim().length >= 2) runSearch({ focus: false });
    else fit();
  });
  $("expand-all").addEventListener("click", expandAll);
  $("collapse-all").addEventListener("click", collapseAll);
  $("zoom-in").addEventListener("click", () => {
    const r = els.viewport.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, state.cam.k * 1.15);
  });
  $("zoom-out").addEventListener("click", () => {
    const r = els.viewport.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, state.cam.k / 1.15);
  });
  $("fit").addEventListener("click", () => {
    state.userMoved = false;
    fit();
  });
  els.editsBtn.addEventListener("click", () => {
    const n = editCount(state.edits);
    const orphans = orphanIds(state.index);
    els.editsMenu.innerHTML = `
      <p>${n ? `${n} change${n === 1 ? "" : "s"} on this device` : "No edits on this device yet"}.</p>
      ${state.editsUnreadable ? `<p class="banner">Saved edits could not be decrypted with this passphrase. Discard them to start again.</p>` : ""}
      ${orphans.length ? `<p class="muted">${orphans.length} topic${orphans.length === 1 ? "" : "s"} with a missing parent.</p>` : ""}
      <button type="button" id="export-edits">Export edits</button>
      <button type="button" id="import-edits">Import edits</button>
      <button type="button" id="discard-edits" ${n || state.editsUnreadable ? "" : "disabled"}>Discard edits</button>
      <p class="muted">Export writes plaintext JSON so you can merge it into the master notes. It is not encrypted.</p>`;
    els.editsMenu.hidden = !els.editsMenu.hidden;
    $("export-edits").onclick = exportEdits;
    $("import-edits").onclick = openImport;
    $("discard-edits").onclick = discardEdits;
  });
  document.addEventListener("click", (e) => {
    if (!els.editsMenu.hidden && !e.target.closest("#edits-menu") && e.target !== els.editsBtn) {
      els.editsMenu.hidden = true;
    }
  });
  els.lockBtn.addEventListener("click", lock);
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      els.search.focus();
    } else if (e.key === "Escape") {
      if (!els.modal.hidden) closeModal();
      else if (state.editing) {
        state.editing = false;
        renderPanel();
      } else if (state.selected) {
        state.selected = null;
        draw();
        renderPanel();
      } else if (els.search.value) {
        els.search.value = "";
        state.query = "";
        runSearch({ focus: false });
      }
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && state.editing) {
      saveForm();
    } else if (!typing && e.key === "+" ) {
      const r = els.viewport.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, state.cam.k * 1.15);
    } else if (!typing && e.key === "-" ) {
      const r = els.viewport.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, state.cam.k / 1.15);
    }
  });
  window.addEventListener("resize", () => {
    if (!state.userMoved) fit();
  });
}

async function boot() {
  wireChrome();
  wireCamera();
  let index;
  try {
    const res = await fetch(new URL("index.json", DATA_BASE), { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    index = await res.json();
  } catch (err) {
    els.gateStatus.textContent = "Could not load data/index.json. Serve this folder over HTTP (not as a file).";
    return;
  }
  state.indexFile = index;
  state.saltB64 = index?.kdf?.salt || "";
  state.iterations = index?.kdf?.iterations || DEFAULT_ITERATIONS;
  if (index.demo) els.gateDemo.hidden = false;
  const saved = readSavedKey();
  const locked = sessionStorage.getItem(LOCK_FLAG) === "1";
  if (saved && !locked) {
    els.gateStatus.textContent = "Unlocking saved key…";
    try {
      await unlockWithRaw(saved.key);
      return;
    } catch {
      els.gateStatus.textContent = "";
      els.gateError.textContent = "The saved key did not unlock these files.";
    }
  }
  if (saved) {
    els.savedRow.hidden = false;
    els.remember.checked = true;
  }
  els.passphrase.focus();
}

function readSavedKey() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY_STORE) || "null");
    if (!parsed || parsed.salt !== state.saltB64 || parsed.iterations !== state.iterations) return null;
    if (!parsed.key) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function unlockWithRaw(b64) {
  const key = await importRawKey(b64);
  await openCompendium(key);
}

async function onPassphrase(event) {
  event.preventDefault();
  const passphrase = els.passphrase.value;
  if (!passphrase) return;
  els.gateError.textContent = "";
  els.gateStatus.textContent = "Deriving a key…";
  els.gateForm.querySelector("button[type=submit]").disabled = true;
  try {
    const key = await deriveKey(passphrase, b64ToBytes(state.saltB64), state.iterations, true);
    els.gateStatus.textContent = "Decrypting notes…";
    await openCompendium(key);
    if (els.remember.checked) {
      localStorage.setItem(
        KEY_STORE,
        JSON.stringify({
          salt: state.saltB64,
          iterations: state.iterations,
          key: await exportRawKey(key),
        })
      );
    } else {
      localStorage.removeItem(KEY_STORE);
    }
    sessionStorage.removeItem(LOCK_FLAG);
    els.passphrase.value = "";
  } catch (err) {
    console.error(err);
    els.gateError.textContent = "That passphrase did not unlock these notes.";
    els.gateStatus.textContent = "";
  } finally {
    const submit = els.gateForm.querySelector("button[type=submit]");
    if (submit) submit.disabled = false;
  }
}

async function openCompendium(key) {
  const branches = state.indexFile.branches || [];
  const nodes = [];
  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    els.gateStatus.textContent = `Decrypting ${i + 1} of ${branches.length}…`;
    const res = await fetch(new URL(branch.file, DATA_BASE), { cache: "no-store" });
    if (!res.ok) throw new Error(`Missing ${branch.file}`);
    const payload = await res.json();
    const data = await decryptJson(key, payload, branch.id);
    const list = Array.isArray(data) ? data : data.nodes;
    if (!Array.isArray(list)) throw new Error(`${branch.file} has no nodes`);
    for (const node of list) nodes.push(node);
  }
  state.key = key;
  state.baseNodes = nodes;
  await loadEdits();
  rebuildDerived();
  const root = state.index.byId.get(state.index.rootId);
  els.brand.textContent = root?.title || "Knowledge Compendium";
  document.title = root?.title || "Knowledge Compendium";
  els.gate.hidden = true;
  els.app.hidden = false;
  draw();
  renderPanel();
  const hashId = decodeURIComponent(location.hash.replace(/^#/, ""));
  requestAnimationFrame(() => {
    fit();
    if (hashId && state.index.byId.has(hashId)) select(hashId, { toggle: false });
  });
}

function lock() {
  state.key = null;
  state.baseNodes = [];
  state.index = null;
  state.selected = null;
  state.editing = false;
  state.expanded = new Set();
  state.positions = new Map();
  nodeButtons.clear();
  els.nodes.innerHTML = "";
  els.edges.innerHTML = "";
  sessionStorage.setItem(LOCK_FLAG, "1");
  els.app.hidden = true;
  els.gate.hidden = false;
  els.gateStatus.textContent = "";
  els.gateError.textContent = "";
  const saved = readSavedKey();
  els.savedRow.hidden = !saved;
  els.passphrase.value = "";
  els.passphrase.focus();
}

els.gateForm.addEventListener("submit", onPassphrase);
els.continueBtn.addEventListener("click", async () => {
  const saved = readSavedKey();
  if (!saved) return;
  els.gateError.textContent = "";
  els.gateStatus.textContent = "Unlocking saved key…";
  try {
    sessionStorage.removeItem(LOCK_FLAG);
    await unlockWithRaw(saved.key);
  } catch (err) {
    console.error(err);
    els.gateError.textContent = "The saved key did not unlock these files.";
    els.gateStatus.textContent = "";
  }
});
els.forgetBtn.addEventListener("click", () => {
  localStorage.removeItem(KEY_STORE);
  els.savedRow.hidden = true;
  els.remember.checked = false;
  toast("Saved unlock removed");
});

boot();
