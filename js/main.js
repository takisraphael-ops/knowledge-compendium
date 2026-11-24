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
import { layoutMap, assignSides, assignSidesEven } from "./layout.js";
import {
  formatHash,
  parseHash,
  subjectOfNode,
  isUnder,
  sortSubjects,
  slugifyTitle,
} from "./route.js";
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
import { escapeHtml, renderDepth, renderFullNotes, renderYourNotes, renderKeyTerms, renderStudyLayers, renderLead, hasOriginalToggle, setTermLinker, YOUR_NOTES_LABEL, SHOW_ORIGINAL, SHOW_TIDIED, FULL_NOTES_LABEL } from "./notes.js";
import { initRevise, showRevise, hideRevise, isReviseVisible, clearReviseSession } from "./revise.js";

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
  breadcrumb: $("map-breadcrumb"),
  subjectSwitch: $("subject-switch"),
  count: $("count"),
  search: $("search"),
  matchLabel: $("match-label"),
  docFilter: $("doc-filter"),
  editsBtn: $("edits-btn"),
  editsMenu: $("edits-menu"),
  lockBtn: $("lock-btn"),
  reviseBtn: $("revise-btn"),
  revise: $("revise"),
  viewport: $("viewport"),
  world: $("world"),
  edges: $("edges"),
  nodes: $("nodes"),
  panel: $("panel"),
  panelResizer: $("panel-resizer"),
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
  fullNotesOpen: false,
  showOriginal: false,
  sections: {},
  query: "",
  hits: [],
  hitCursor: 0,
  doc: "",
  filter: null,
  hitAncestors: new Set(),
  cam: { x: 40, y: 40, k: 1 },
  userMoved: false,
  positions: new Map(),
  mode: "overview",
  slug: null,
  focusId: null,
  subjects: [],
  nodeBranch: new Map(),
  viewSides: new Map(),
  redirects: {},
};

const nodeButtons = new Map();
let toastTimer = 0;
let searchTimer = 0;
let measureCtx = null;
let routeApplying = false;

function layoutRoot() {
  if (!state.index) return null;
  if (state.mode === "subject" && state.focusId && state.index.byId.has(state.focusId)) {
    return state.focusId;
  }
  return state.index.rootId;
}

function subjectBySlug(slug) {
  return state.subjects.find((s) => s.slug === slug) || null;
}

function sidesForCurrentView(rootId) {
  const id = rootId || layoutRoot() || state.index.rootId;
  if (state.mode === "overview") return assignSidesEven(id, state.index.children);
  return assignSides(id, state.index.children);
}

function topicCountLabel(n) {
  const count = Number(n) || 0;
  return count === 1 ? "1 topic" : `${count} topics`;
}

function subjectCountFor(id) {
  const found = state.subjects.find((s) => s.rootId === id);
  if (found) return found.count;
  return state.index ? subtreeIds(state.index, id).length : 0;
}

function currentRoute() {
  const subject = subjectBySlug(state.slug);
  return {
    mode: state.mode,
    slug: state.slug,
    focusId: state.focusId,
    selectedId: state.selected,
    subjectRootId: subject?.rootId || null,
  };
}

function normalizeHash(hash) {
  if (!hash || hash === "#") return "#/";
  return hash;
}

function writeRoute({ push = false } = {}) {
  if (routeApplying || !state.index) return;
  const hash = formatHash(currentRoute());
  if (normalizeHash(location.hash) === normalizeHash(hash)) return;
  if (push) history.pushState(null, "", hash);
  else history.replaceState(null, "", hash);
}

function buildSubjects() {
  if (!state.index) {
    state.subjects = [];
    return;
  }
  const rootId = state.index.rootId;
  const kids = state.index.children.get(rootId) || [];
  const list = [];
  const used = new Set();
  for (const id of kids) {
    const node = state.index.byId.get(id);
    const branchId = state.nodeBranch.get(id);
    let slug = branchId && branchId !== "tree" ? branchId : slugifyTitle(node?.title);
    if (used.has(slug)) slug = `${slug}-${id}`;
    used.add(slug);
    list.push({
      slug,
      rootId: id,
      title: node?.title || slug,
      count: subtreeIds(state.index, id).length,
      branchId: branchId || null,
    });
  }
  state.subjects = sortSubjects(list);
}

function measureOf(id) {
  const node = state.index.byId.get(id);
  const root = id === layoutRoot();
  const overviewSubject = state.mode === "overview" && id !== state.index.rootId;
  const kids = visibleKids(id);
  const badge = !root && !overviewSubject && kids.length > 0;
  const font = root
    ? '600 18px "Liberation Serif", Georgia, serif'
    : '600 14px "Liberation Sans", "Segoe UI", sans-serif';
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  measureCtx.font = font;
  const textW = measureCtx.measureText(node?.title || "").width;
  if (overviewSubject) {
    const countLabel = topicCountLabel(subjectCountFor(id));
    measureCtx.font = '600 12px "Liberation Sans", "Segoe UI", sans-serif';
    const countW = measureCtx.measureText(countLabel).width;
    return {
      w: Math.round(Math.min(320, Math.max(168, Math.max(textW, countW) + 56))),
      h: 72,
    };
  }
  const chrome = (root ? 40 : 42) + (badge ? 40 : 0);
  const max = root ? 380 : 260;
  const min = root ? 168 : 108;
  return {
    w: Math.round(Math.min(max, Math.max(min, textW + chrome))),
    h: root ? 54 : 40,
  };
}

function visibleKids(id) {
  if (state.mode === "overview" && id !== state.index.rootId) return [];
  const kids = state.index.children.get(id) || [];
  if (!state.filter) return kids;
  return kids.filter((kid) => state.filter.has(kid));
}

function passes(id) {
  if (!state.filter) return true;
  return state.filter.has(id);
}


const LETTER_TITLE_RE = /^(?:glossary|course 1)\s+[–-]/i;

function normTermKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .replace(/[.:]+$/, "")
    .trim();
}

function buildTermLinker(index) {
  const map = new Map();
  const add = (key, id, weight) => {
    const k = normTermKey(key);
    if (!k) return;
    if (k.length < 3 && !/^[a-z0-9]{2,5}$/.test(k)) return;
    if (LETTER_TITLE_RE.test(k)) return;
    const prev = map.get(k);
    if (prev && prev.weight >= weight) return;
    map.set(k, { id, weight });
  };
  for (const [id, node] of index.byId) {
    const title = node?.title || "";
    if (LETTER_TITLE_RE.test(title)) continue;
    add(title, id, 3);
    const m = title.match(/^(.+?)\s+\(([^)]+)\)\s*$/);
    if (m) {
      add(m[1], id, 2);
      const acr = m[2].trim();
      if (/^[A-Za-z0-9][A-Za-z0-9+./-]{1,15}$/.test(acr)) add(acr, id, 2);
    }
  }
  return (term) => {
    const k = normTermKey(term);
    if (!k) return "";
    if (map.has(k)) return map.get(k).id;
    const m = String(term || "").match(/^(.+?)\s+\(([^)]+)\)\s*$/);
    if (m) {
      const k1 = normTermKey(m[1]);
      const k2 = normTermKey(m[2]);
      if (map.has(k1)) return map.get(k1).id;
      if (k2.length >= 2 && map.has(k2)) return map.get(k2).id;
    }
    return "";
  };
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
  buildSubjects();
  const viewRoot = layoutRoot() || state.index.rootId;
  state.viewSides = sidesForCurrentView(viewRoot);
  if (state.selected && !state.index.byId.has(state.selected)) {
    state.selected = null;
    state.editing = false;
  }
  const alive = state.index.byId;
  for (const id of [...state.expanded]) if (!alive.has(id)) state.expanded.delete(id);
  state.filter = idsPassingDocFilter(state.index, state.doc);
  fillDocFilter();
  setTermLinker(state.index ? buildTermLinker(state.index) : null);
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
  const rootId = layoutRoot();
  const sides = state.viewSides && state.viewSides.size ? state.viewSides : state.sides;
  state.positions = layoutMap({
    rootId,
    children: state.index.children,
    measure: measureOf,
    isOpen: (id) => id === rootId || state.expanded.has(id),
    kidsOf: visibleKids,
    sides,
    colors: state.colors,
  });
  drawEdges();
  drawNodes();
  const shown = state.positions.size;
  const allTotal = state.index.byId.size;
  const subject = subjectBySlug(state.slug);
  const focus = state.mode === "subject" ? (state.focusId || subject?.rootId) : null;
  const viewTotal = focus ? subtreeIds(state.index, focus).length : allTotal;
  const subjectN = state.subjects.length;
  if (state.doc || state.query) {
    els.count.textContent = `${shown} shown · ${allTotal} topics`;
  } else if (state.mode === "overview") {
    els.count.textContent = `${subjectN} subjects · ${allTotal} topics`;
  } else if (focus && focus !== subject?.rootId) {
    const title = state.index.byId.get(focus)?.title || "Branch";
    els.count.textContent = `${title} · ${topicCountLabel(viewTotal)}`;
  } else {
    els.count.textContent = topicCountLabel(viewTotal);
  }
  const n = editCount(state.edits);
  els.editsBtn.textContent = n ? `Edits ${n}` : "Edits";
  els.editsBtn.classList.toggle("has-edits", n > 0);
  const panelOpen = Boolean(state.selected);
  els.panel.classList.toggle("open", panelOpen);
  document.body.classList.toggle("panel-open", panelOpen);
  document.body.classList.toggle("overview-mode", state.mode === "overview");
  if (els.panelResizer) els.panelResizer.hidden = !isDesktopPanel() || !panelOpen;
  if (state._panelWasOpen !== panelOpen && !state.userMoved) {
    requestAnimationFrame(() => { if (!state.userMoved) fit(); });
  }
  state._panelWasOpen = panelOpen;
  updateHint();
  renderNav();
}

function updateHint() {
  if (!els.hint) return;
  els.hint.textContent = state.mode === "overview"
    ? "Drag to pan. Pinch or scroll to zoom. Tap a subject to open its map."
    : "Drag to pan. Pinch or scroll to zoom. Tap a topic to open it.";
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
    const root = id === layoutRoot();
    const overviewSubject = state.mode === "overview" && id !== state.index.rootId;
    const kids = visibleKids(id);
    const open = state.expanded.has(id);
    btn.classList.toggle("root", root);
    btn.classList.toggle("overview-subject", overviewSubject);
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
    btn.title = overviewSubject
      ? `${node.title} · ${topicCountLabel(subjectCountFor(id))}`
      : node.title;
    const badge = !root && !overviewSubject && kids.length
      ? `<span class="badge">${open ? "–" : `+${kids.length}`}</span>`
      : "";
    const dot = root ? "" : `<span class="dot" aria-hidden="true"></span>`;
    const label = `<span class="label">${highlightTitle(node.title, state.query)}</span>`;
    const count = overviewSubject
      ? `<span class="topic-count">${escapeHtml(topicCountLabel(subjectCountFor(id)))}</span>`
      : "";
    const html = overviewSubject
      ? `<span class="overview-title">${dot}${label}</span>${count}`
      : `${dot}${label}${badge}`;
    if (btn.dataset.html !== html) {
      btn.innerHTML = html;
      btn.dataset.html = html;
    }
    if (fresh && !overviewSubject) btn.classList.add("enter");
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

function openRevise({ push = true } = {}) {
  if (!state.index) return;
  if (state.mode !== "revise") state.reviseReturn = currentRoute();
  state.mode = "revise";
  writeRoute({ push });
  showRevise();
  renderNav();
}

function leaveRevise() {
  const ret = state.reviseReturn;
  state.reviseReturn = null;
  hideRevise();
  if (ret && ret.mode && ret.mode !== "revise") {
    history.back();
    return;
  }
  openOverview({ push: false, fitMap: true });
}

function applyRoute({ fitMap = false } = {}) {
  if (!state.index) return;
  const parsed = parseHash(location.hash, { index: state.index, subjects: state.subjects, redirects: state.redirects });
  const canonical = formatHash({
    mode: parsed.mode,
    slug: parsed.slug,
    focusId: parsed.focusId,
    selectedId: parsed.selectedId,
    subjectRootId: subjectBySlug(parsed.slug)?.rootId || null,
  });
  if (normalizeHash(location.hash) !== normalizeHash(canonical)) {
    routeApplying = true;
    history.replaceState(null, "", canonical);
    routeApplying = false;
  }
  if (parsed.mode === "revise") {
    state.mode = "revise";
    showRevise();
    renderNav();
    return;
  }
  if (state.mode === "revise" || isReviseVisible()) hideRevise();

  const prevMode = state.mode;
  const prevFocus = state.focusId;
  const prevSlug = state.slug;
  state.mode = parsed.mode;
  state.slug = parsed.slug;
  let focusId = parsed.mode === "overview"
    ? state.index.rootId
    : (parsed.focusId || subjectBySlug(parsed.slug)?.rootId || state.index.rootId);
  const subject = subjectBySlug(state.slug);
  if (state.mode === "subject" && subject && !isUnder(state.index, subject.rootId, focusId)) {
    focusId = subject.rootId;
  }
  state.focusId = focusId;
  let selected = parsed.selectedId && state.index.byId.has(parsed.selectedId) ? parsed.selectedId : null;
  if (selected && state.mode === "subject" && !isUnder(state.index, state.focusId, selected)) {
    state.focusId = subject?.rootId || state.focusId;
    if (!isUnder(state.index, state.focusId, selected)) selected = null;
  }
  state.selected = selected;
  state.editing = false;
  state.depthOpen = false;
  state.fullNotesOpen = false;
  state.showOriginal = false;
  if (state.selected) {
    for (const a of ancestorIds(state.index, state.selected)) state.expanded.add(a);
    els.hint.hidden = true;
  }
  const viewChanged = prevMode !== state.mode || prevFocus !== state.focusId || prevSlug !== state.slug;
  if (viewChanged) {
    state.viewSides = sidesForCurrentView(state.focusId || state.index.rootId);
    state.userMoved = false;
  }
  draw();
  renderPanel();
  const shouldFit = fitMap || viewChanged;
  requestAnimationFrame(() => {
    if (shouldFit) fit();
    if (state.selected) {
      revealBranch(state.selected);
      if (!shouldFit) ensureVisible(state.selected);
    }
  });
}

function openOverview({ push = true, fitMap = true } = {}) {
  if (isReviseVisible()) hideRevise();

  state.mode = "overview";
  state.slug = null;
  state.focusId = state.index.rootId;
  state.selected = null;
  state.editing = false;
  state.depthOpen = false;
  state.fullNotesOpen = false;
  state.showOriginal = false;
  state.viewSides = sidesForCurrentView(state.index.rootId);
  state.userMoved = false;
  writeRoute({ push });
  draw();
  renderPanel();
  if (fitMap) requestAnimationFrame(() => fit());
}

function openSubject(slug, { focusId = null, selectedId = null, push = true, fitMap = true } = {}) {
  if (isReviseVisible()) hideRevise();

  const subject = subjectBySlug(slug);
  if (!subject) {
    openOverview({ push, fitMap });
    return;
  }
  const nextFocus = focusId && isUnder(state.index, subject.rootId, focusId) ? focusId : subject.rootId;
  const viewChanged = state.mode !== "subject" || state.slug !== slug || state.focusId !== nextFocus;
  state.mode = "subject";
  state.slug = slug;
  state.focusId = nextFocus;
  const nextSelected = selectedId && isUnder(state.index, nextFocus, selectedId) ? selectedId : null;
  state.selected = nextSelected;
  state.editing = false;
  state.depthOpen = false;
  state.fullNotesOpen = false;
  state.showOriginal = false;
  if (state.selected) {
    for (const a of ancestorIds(state.index, state.selected)) state.expanded.add(a);
    els.hint.hidden = true;
  }
  if (viewChanged) {
    state.viewSides = sidesForCurrentView(state.focusId);
    state.userMoved = false;
  }
  writeRoute({ push });
  draw();
  renderPanel();
  if (fitMap || viewChanged) {
    requestAnimationFrame(() => {
      fit();
      if (state.selected) revealBranch(state.selected);
    });
  } else if (state.selected) {
    revealBranch(state.selected);
    requestAnimationFrame(() => ensureVisible(state.selected));
  }
}

function openNode(id, { push = true } = {}) {
  if (isReviseVisible()) hideRevise();

  if (!id || !state.index?.byId.has(id)) return;
  if (id === state.index.rootId) {
    openOverview({ push });
    return;
  }
  const subject = subjectOfNode(state.index, state.subjects, id);
  if (!subject) {
    openOverview({ push });
    return;
  }
  const keepFocus = state.mode === "subject" && state.slug === subject.slug && isUnder(state.index, state.focusId, id);
  const focusId = keepFocus ? state.focusId : subject.rootId;
  openSubject(subject.slug, { focusId, selectedId: id, push, fitMap: !keepFocus });
}

function clearSelection({ push = true } = {}) {
  if (!state.selected) return;
  state.selected = null;
  state.editing = false;
  state.depthOpen = false;
  state.fullNotesOpen = false;
  writeRoute({ push });
  draw();
  renderPanel();
}

function select(id, { toggle = false, push = true } = {}) {
  if (!id || !state.index.byId.has(id)) return;
  if (state.mode === "overview" && id !== state.index.rootId) {
    const subject = subjectOfNode(state.index, state.subjects, id);
    if (subject) {
      openSubject(subject.slug, { push });
      return;
    }
  }
  if (state.mode === "subject" && state.focusId && !isUnder(state.index, state.focusId, id)) {
    openNode(id, { push });
    return;
  }
  if (id === state.index.rootId && state.mode === "overview") {
    state.selected = id;
    state.editing = false;
    state.depthOpen = false;
    state.fullNotesOpen = false;
    state.showOriginal = false;
    els.hint.hidden = true;
    writeRoute({ push });
    draw();
    renderPanel();
    return;
  }
  state.selected = id;
  state.editing = false;
  state.depthOpen = false;
  state.fullNotesOpen = false;
  state.showOriginal = false;
  for (const a of ancestorIds(state.index, id)) state.expanded.add(a);
  const kids = visibleKids(id);
  if (toggle && kids.length && id !== layoutRoot()) {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
  }
  els.hint.hidden = true;
  writeRoute({ push });
  draw();
  renderPanel();
  revealBranch(id);
  requestAnimationFrame(() => ensureVisible(id));
}

function renderNav() {
  if (!els.breadcrumb || !state.index) return;
  const crumbs = [];
  crumbs.push({ kind: "home", label: "Home", current: state.mode === "overview" && !state.selected });
  if (state.mode === "revise") {
    crumbs[0].current = false;
    crumbs.push({ kind: "revise", label: "Revise", current: true });
  } else if (state.mode === "subject" && state.slug) {
    const subject = subjectBySlug(state.slug);
    const subjectRoot = subject?.rootId;
    const trailEnd = state.selected || (state.focusId && state.focusId !== subjectRoot ? state.focusId : null);
    const trail = [];
    if (trailEnd && trailEnd !== subjectRoot) {
      const ids = [...ancestorIds(state.index, trailEnd)].reverse();
      for (const id of ids) {
        if (id === state.index.rootId || id === subjectRoot) continue;
        trail.push(id);
      }
      if (state.focusId && state.focusId !== subjectRoot && !trail.includes(state.focusId)) {
        trail.push(state.focusId);
      }
      if (state.selected && state.selected !== subjectRoot && !trail.includes(state.selected)) {
        trail.push(state.selected);
      }
    }
    const subjectCurrent = !trail.length && !state.selected;
    crumbs.push({
      kind: "subject",
      slug: state.slug,
      label: subject?.title || state.slug,
      current: subjectCurrent,
    });
    for (const id of trail) {
      const node = state.index.byId.get(id);
      const isSelected = id === state.selected;
      const isFocus = id === state.focusId && id !== subjectRoot;
      crumbs.push({
        kind: "node",
        id,
        slug: state.slug,
        label: node?.title || id,
        current: isSelected || (isFocus && !state.selected),
        focusable: Boolean((state.index.children.get(id) || []).length) && !isSelected,
      });
    }
  } else if (state.mode === "overview" && state.selected === state.index.rootId) {
    crumbs[0].current = true;
  }
  els.breadcrumb.replaceChildren();
  for (const crumb of crumbs) {
    const li = document.createElement("li");
    if (crumb.current) {
      const span = document.createElement("span");
      span.className = "current";
      span.textContent = crumb.label;
      span.setAttribute("aria-current", "page");
      li.appendChild(span);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = crumb.label;
      if (crumb.kind === "home") btn.dataset.nav = "home";
      else if (crumb.kind === "subject") {
        btn.dataset.nav = "subject";
        btn.dataset.slug = crumb.slug;
      } else {
        btn.dataset.nav = crumb.focusable ? "focus" : "select";
        btn.dataset.id = crumb.id;
        btn.dataset.slug = crumb.slug;
      }
      li.appendChild(btn);
    }
    els.breadcrumb.appendChild(li);
  }

  if (els.subjectSwitch) {
    const options = [`<option value="">Home overview</option>`];
    for (const subject of state.subjects) {
      options.push(
        `<option value="${escapeHtml(subject.slug)}">${escapeHtml(subject.title)} (${subject.count})</option>`
      );
    }
    const html = options.join("");
    if (els.subjectSwitch.dataset.html !== html) {
      els.subjectSwitch.innerHTML = html;
      els.subjectSwitch.dataset.html = html;
    }
    const want = (state.mode === "subject" || state.mode === "revise") && state.slug ? state.slug : "";
    if (els.subjectSwitch.value !== want) els.subjectSwitch.value = want;
  }
  document.title = state.mode === "revise"
    ? "Revise · Knowledge Compendium"
    : state.mode === "subject" && subjectBySlug(state.slug)
    ? `${subjectBySlug(state.slug).title} · Knowledge Compendium`
    : (state.index.byId.get(state.index.rootId)?.title || "Knowledge Compendium");
}

function onBreadcrumbClick(e) {
  const btn = e.target.closest("button[data-nav]");
  if (!btn || !els.breadcrumb.contains(btn)) return;
  const nav = btn.dataset.nav;
  if (nav === "home") openOverview({ push: true });
  else if (nav === "subject") openSubject(btn.dataset.slug, { push: true });
  else if (nav === "focus") openSubject(btn.dataset.slug || state.slug, { focusId: btn.dataset.id, push: true });
  else if (nav === "select") select(btn.dataset.id, { toggle: false, push: true });
}

function onSubjectSwitch(e) {
  const slug = e.target.value;
  if (!slug) openOverview({ push: true });
  else openSubject(slug, { push: true });
}

function sameAppUrl(href) {
  try {
    const url = new URL(href, location.href);
    if (url.origin !== location.origin) return false;
    const norm = (path) => path.replace(/\/index\.html$/i, "/").replace(/\/+$/, "") || "/";
    return norm(url.pathname) === norm(location.pathname);
  } catch {
    return false;
  }
}

function onAppLinkClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = e.target.closest("a[href]");
  if (!link) return;
  if (!sameAppUrl(link.href)) return;
  const url = new URL(link.href, location.href);
  if (!url.hash) return;
  e.preventDefault();
  routeApplying = false;
  const target = normalizeHash(url.hash);
  if (normalizeHash(location.hash) !== target) history.pushState(null, "", target);
  applyRoute({ fitMap: true });
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
  if (state.mode === "overview") return;
  const root = layoutRoot();
  const allowed = root ? new Set(subtreeIds(state.index, root)) : null;
  for (const [id, kids] of state.index.children) {
    if (allowed && !allowed.has(id)) continue;
    if ((state.filter ? kids.filter((k) => state.filter.has(k)) : kids).length) state.expanded.add(id);
  }
  if (root) state.expanded.add(root);
  draw();
  state.userMoved = false;
  fit();
}

function collapseAll() {
  if (state.mode === "overview") return;
  state.expanded = new Set();
  const root = layoutRoot();
  if (root) state.expanded.add(root);
  draw();
  state.userMoved = false;
  fit();
}

function expandSubtree(id) {
  if (state.mode === "overview" && id !== state.index.rootId) {
    const subject = subjectOfNode(state.index, state.subjects, id);
    if (subject) {
      openSubject(subject.slug, { push: true });
      return;
    }
  }
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
    const rank = (id) => {
      const node = state.index.byId.get(id);
      const title = (node?.title || "").toLowerCase();
      if (title === q) return 0;
      if (title.startsWith(q)) return 1;
      if (title.includes(q)) return 2;
      const summary = (node?.summary || "").toLowerCase();
      if (summary.includes(q)) return 3;
      return 4;
    };
    const orderIndex = new Map(state.index.order.map((id, i) => [id, i]));
    state.hits.sort((a, b) => rank(a) - rank(b) || (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
    for (const id of state.hits) {
      for (const a of ancestorIds(state.index, id)) {
        state.expanded.add(a);
        state.hitAncestors.add(a);
      }
    }
  }
  state.hitCursor = 0;
  const n = state.hits.length;
  els.matchLabel.textContent = q.length < 2 ? "" : n ? `1 / ${n}` : "No matches";
  if (n && options.focus !== false) {
    openNode(state.hits[0], { push: true });
    if (state.cam.k < 0.72) {
      state.cam.k = 0.72;
      applyCam();
    }
    markCurrentHit();
  } else {
    draw();
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


function sectionsOf(node) {
  const ids = node?.sectionIds || [];
  return ids.map((id) => state.sections[id]).filter(Boolean);
}

function fillFullNotes(node) {
  const body = $("full-notes-body");
  if (!body || body.dataset.ready === "1") return;
  body.innerHTML = renderFullNotes(sectionsOf(node), node, docLabel);
  body.dataset.ready = "1";
}


const PHONE_READER = "(max-width: 700px)";

function isPhoneReader() {
  return window.matchMedia(PHONE_READER).matches;
}

function closeMoreMenu() {
  const menu = els.panel?.querySelector(".panel-more-menu");
  const btn = els.panel?.querySelector(".panel-more-btn");
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function toggleMoreMenu(btn) {
  const menu = els.panel?.querySelector(".panel-more-menu");
  if (!menu || !btn) return;
  const open = menu.hidden;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}

function syncPanelStickyHeight() {
  const top = els.panel?.querySelector(".panel-top");
  if (!els.panel) return;
  if (!top) {
    els.panel.style.removeProperty("--panel-sticky-h");
    return;
  }
  els.panel.style.setProperty("--panel-sticky-h", `${Math.ceil(top.getBoundingClientRect().height)}px`);
}

function syncPhoneReaderChrome() {
  const on = isPhoneReader() && Boolean(state.selected) && els.panel?.classList.contains("open");
  document.body.classList.toggle("phone-reader", on);
  const inertTargets = [
    document.querySelector("#app > header"),
    els.viewport,
    ...document.querySelectorAll(".map-controls, #hint"),
  ];
  for (const el of inertTargets) {
    if (!el) continue;
    if (on) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }
}

function jumpBarHtml(items) {
  if (!items.length) return "";
  const buttons = items.map((item) => (
    `<button type="button" class="jump-link" data-act="jump" data-target="${item.id}">${item.label}</button>`
  )).join("");
  return `<nav class="jump-bar" aria-label="On this topic">${buttons}</nav>`;
}

function moreMenuHtml(id) {
  const isRoot = id === state.index.rootId;
  return `<div class="panel-more">
      <button type="button" class="icon-btn panel-more-btn" data-act="toggle-more" aria-expanded="false" aria-haspopup="menu" aria-label="More actions">⋯</button>
      <div class="panel-more-menu" hidden role="menu">
        <button type="button" role="menuitem" data-act="edit">Edit</button>
        <button type="button" role="menuitem" data-act="add">Add subtopic</button>
        ${isRoot ? "" : `<button type="button" role="menuitem" data-act="move">Move</button>
        <button type="button" role="menuitem" class="danger" data-act="delete">Delete</button>`}
      </div>
    </div>`;
}

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
    syncPanelStickyHeight();
    syncPhoneReaderChrome();
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
  const tags = (node.tags || []).filter((t) => t !== "grokimus-added").map((t) => `<span class="chip quiet">${escapeHtml(t)}</span>`).join("");
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
      <div class="panel-body">
      <label class="field">Title<input id="f-title" value="${escapeHtml(node.title)}"></label>
      <label class="field">Summary<textarea id="f-summary" rows="3">${escapeHtml(node.summary)}</textarea></label>
      <label class="field">Your notes <span class="hint-text">tidied version, shown first on the topic</span><textarea id="f-tidy" rows="12">${escapeHtml(node.tidy || node.text || "")}</textarea></label>
      <label class="field">Original wording <span class="hint-text">kept verbatim; one tap away on the topic page</span><textarea id="f-text" rows="8">${escapeHtml(node.text)}</textarea></label>
      <label class="field">Expanded explanation <span class="hint-text">added by Grokimus; yours to edit</span><textarea id="f-expanded" rows="10">${escapeHtml(node.expanded || "")}</textarea></label>
      <p class="hint-text">Lines that start with @@ name a source. ### is a heading, “- ” is a bullet, and “| a | b |” is a table.</p>
      <label class="field">Sources <span class="hint-text">codes, comma separated</span><input id="f-docs" value="${escapeHtml((node.docs || []).join(", "))}"></label>
      <label class="field">Tags<input id="f-tags" value="${escapeHtml((node.tags || []).join(", "))}"></label>
      <div class="row-actions"><button type="button" class="solid" data-act="save">Save on this device</button></div>
      </div>`;
    syncPanelStickyHeight();
    syncPhoneReaderChrome();
    return;
  }

  const ownNotes = String(node.tidy || "").trim() || String(node.text || "").trim();
  const hasExpanded = Boolean(String(node.expanded || "").trim());
  const grokimusAdded = (node.tags || []).includes("grokimus-added");
  const grokBadge = grokimusAdded
    ? `<span class="added-badge">Added by Grokimus</span>`
    : "";
  const canToggle = hasOriginalToggle(node);
  const yourNotes = ownNotes
    ? `<section class="your-notes">
         <div class="your-notes-bar">
           <div class="your-notes-label">${escapeHtml(YOUR_NOTES_LABEL)}</div>
           ${canToggle ? `<button type="button" class="wording-toggle" data-act="wording" aria-pressed="${state.showOriginal ? "true" : "false"}">${state.showOriginal ? escapeHtml(SHOW_TIDIED) : escapeHtml(SHOW_ORIGINAL)}</button>` : ""}
         </div>
         <div id="your-notes-body" class="notes"></div>
       </section>`
    : "";
  // Teaching lead (before Exam tips). If there is no owner text, show it in the open.
  // Exam tips, Memory aids and Practice are always visible, never behind More depth.
  const leadHtml = hasExpanded ? renderLead(node) : "";
  const hasLead = Boolean(leadHtml);
  const expandInOpen = hasLead && !ownNotes;
  const more = hasLead
    ? (expandInOpen
      ? `<div id="depth-body" class="notes grokimus-open"></div>`
      : `<button type="button" class="depth-btn" data-act="depth" aria-expanded="${state.depthOpen ? "true" : "false"}">${state.depthOpen ? "Hide depth" : "More depth"}</button>
       <div id="depth-body" class="notes" ${state.depthOpen ? "" : "hidden"}></div>`)
    : "";
  const studyLayers = renderStudyLayers(node);
  const fullSecs = sectionsOf(node);
  const fullNotes = fullSecs.length
    ? `<details class="full-notes" ${state.fullNotesOpen ? "open" : ""}>
         <summary>${escapeHtml(FULL_NOTES_LABEL)}</summary>
         <div id="full-notes-body" class="full-notes-body notes"></div>
       </details>`
    : "";

  const keyTermsHtml = renderKeyTerms(node);
  const jumpItems = [];
  if (node.summary || ownNotes || hasLead) jumpItems.push({ id: "panel-explanation", label: "Explanation" });
  if (studyLayers.includes("id=\"panel-exam-tips\"")) jumpItems.push({ id: "panel-exam-tips", label: "Exam tips" });
  if (studyLayers.includes("id=\"panel-memory-aids\"")) jumpItems.push({ id: "panel-memory-aids", label: "Memory aids" });
  if (studyLayers.includes("id=\"panel-practice\"")) jumpItems.push({ id: "panel-practice", label: "Practice" });
  if (keyTermsHtml) jumpItems.push({ id: "panel-key-terms", label: "Key terms" });

  els.panel.innerHTML = `
    <div class="panel-top" style="--c:${branchColor(id)}">
      <div class="panel-bar">
        <button type="button" class="panel-back" data-act="close-panel" aria-label="Back to map">
          <span class="panel-back-label">Map</span>
          <span class="panel-back-x" aria-hidden="true">×</span>
        </button>
        <div class="crumbs">${crumbHtml}</div>
        ${moreMenuHtml(id)}
      </div>
      <h1>${escapeHtml(node.title)}${grokBadge}</h1>
      ${jumpBarHtml(jumpItems)}
    </div>
    <div class="panel-body">
    ${hiddenNote}${orphanNote}
    <div id="panel-explanation">
    ${node.summary ? `<p class="summary">${escapeHtml(node.summary)}</p>` : ""}
    ${link}
    ${docs || tags ? `<div class="chips">${docs}${tags}</div>` : ""}
    ${yourNotes}
    ${more}
    </div>
    ${studyLayers}
    ${keyTermsHtml}
    ${fullNotes}
    ${kidLinks ? `<h2 class="subhead">Subtopics</h2><div class="subtopics">${kidLinks}</div>` : ""}
    </div>`;

  const notesBody = $("your-notes-body");
  if (notesBody) notesBody.innerHTML = renderYourNotes(node, state.showOriginal);
  if ((expandInOpen || state.depthOpen) && hasLead) {
    const box = $("depth-body");
    if (box) box.innerHTML = renderDepth(node);
  }
  if (state.fullNotesOpen && fullSecs.length) fillFullNotes(node);
  requestAnimationFrame(() => {
    syncPanelStickyHeight();
    syncPhoneReaderChrome();
  });
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
    tidy: $("f-tidy") ? $("f-tidy").value : node.tidy || "",
    expanded: $("f-expanded") ? $("f-expanded").value : node.expanded || "",
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
    clearSelection({ push: true });
  } else if (act === "toggle-more") {
    e.stopPropagation();
    toggleMoreMenu(btn);
  } else if (act === "jump") {
    const target = document.getElementById(btn.dataset.target);
    if (target && els.panel) {
      const sticky = els.panel.querySelector(".panel-top")?.getBoundingClientRect().height || 0;
      const y = target.getBoundingClientRect().top - els.panel.getBoundingClientRect().top + els.panel.scrollTop - sticky - 8;
      els.panel.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    }
  } else if (act === "wording") {
    state.showOriginal = !state.showOriginal;
    const node = state.index.byId.get(state.selected);
    const box = $("your-notes-body");
    if (box && node) box.innerHTML = renderYourNotes(node, state.showOriginal);
    btn.setAttribute("aria-pressed", state.showOriginal ? "true" : "false");
    btn.textContent = state.showOriginal ? SHOW_TIDIED : SHOW_ORIGINAL;
  } else if (act === "depth") {
    state.depthOpen = !state.depthOpen;
    const box = $("depth-body");
    const node = state.index.byId.get(state.selected);
    if (state.depthOpen && box && node && !box.dataset.ready) {
      box.innerHTML = renderDepth(node);
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


const PANEL_WIDTH_KEY = "kc-panel-width";
const PANEL_DESKTOP = "(min-width: 701px)";

function isDesktopPanel() {
  return window.matchMedia(PANEL_DESKTOP).matches;
}

function panelWidthBounds() {
  const vw = window.innerWidth;
  const min = 360;
  const max = Math.max(min, Math.min(Math.round(vw * 0.75), vw - 280));
  return { min, max };
}

function clampPanelWidth(px) {
  const { min, max } = panelWidthBounds();
  return Math.round(Math.min(max, Math.max(min, px)));
}

function defaultPanelWidth() {
  const vw = window.innerWidth;
  return clampPanelWidth(Math.max(640, vw * 0.54));
}

function applyPanelWidth(px, { persist = false } = {}) {
  const width = clampPanelWidth(px);
  document.documentElement.style.setProperty("--panel-width", `${width}px`);
  if (els.panelResizer) {
    els.panelResizer.hidden = !isDesktopPanel();
    els.panelResizer.setAttribute("aria-valuenow", String(width));
    els.panelResizer.setAttribute("aria-valuemin", String(panelWidthBounds().min));
    els.panelResizer.setAttribute("aria-valuemax", String(panelWidthBounds().max));
  }
  if (persist) {
    try { localStorage.setItem(PANEL_WIDTH_KEY, String(width)); } catch { /* ignore */ }
  }
  return width;
}

function readStoredPanelWidth() {
  try {
    const n = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(n) && n >= 300) return n;
  } catch { /* ignore */ }
  return null;
}

function initPanelWidth() {
  if (!isDesktopPanel()) {
    if (els.panelResizer) els.panelResizer.hidden = true;
    return;
  }
  const stored = readStoredPanelWidth();
  applyPanelWidth(stored ?? defaultPanelWidth(), { persist: false });
}

function wirePanelResize() {
  const handle = els.panelResizer;
  if (!handle) return;
  handle.setAttribute("aria-valuetext", "Notes panel width");
  initPanelWidth();

  let drag = null;
  handle.addEventListener("pointerdown", (e) => {
    if (!isDesktopPanel() || e.button) return;
    const startW = els.panel.getBoundingClientRect().width;
    drag = { x: e.clientX, w: startW, id: e.pointerId };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("panel-resizing");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // Handle is on the left edge: dragging left (smaller clientX) widens the panel.
    applyPanelWidth(drag.w + (drag.x - e.clientX));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const width = applyPanelWidth(els.panel.getBoundingClientRect().width, { persist: true });
    drag = null;
    document.body.classList.remove("panel-resizing");
    if (!state.userMoved) fit();
    void width;
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("keydown", (e) => {
    if (!isDesktopPanel()) return;
    const step = e.shiftKey ? 48 : 16;
    const cur = els.panel.getBoundingClientRect().width;
    let next = cur;
    if (e.key === "ArrowLeft") next = cur + step;
    else if (e.key === "ArrowRight") next = cur - step;
    else if (e.key === "Home") next = panelWidthBounds().max;
    else if (e.key === "End") next = panelWidthBounds().min;
    else return;
    e.preventDefault();
    applyPanelWidth(next, { persist: true });
    if (!state.userMoved) fit();
  });
  window.addEventListener("resize", () => {
    if (!isDesktopPanel()) {
      handle.hidden = true;
      return;
    }
    const stored = readStoredPanelWidth();
    applyPanelWidth(stored ?? (els.panel.getBoundingClientRect().width || defaultPanelWidth()));
  });
}

function wireChrome() {
  initRevise({
    els: { revise: els.revise, reviseBtn: els.reviseBtn },
    getState: () => state,
    openNode,
    leaveRevise,
    toast,
  });
  els.reviseBtn?.addEventListener("click", () => {
    if (state.mode === "revise") leaveRevise();
    else openRevise({ push: true });
  });
  wirePanelResize();
  els.panel.addEventListener("click", onPanelClick);
  els.panel.addEventListener("click", onAppLinkClick);
  document.addEventListener("click", (e) => {
    const wrap = els.panel?.querySelector(".panel-more");
    if (!wrap || wrap.contains(e.target)) return;
    closeMoreMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMoreMenu();
  });
  window.addEventListener("resize", () => {
    syncPanelStickyHeight();
    syncPhoneReaderChrome();
  });
  els.breadcrumb?.addEventListener("click", onBreadcrumbClick);
  els.subjectSwitch?.addEventListener("change", onSubjectSwitch);
  window.addEventListener("popstate", () => {
    if (!state.index) return;
    applyRoute({ fitMap: true });
  });
  els.panel.addEventListener("toggle", (e) => {
    const det = e.target.closest?.("details.full-notes");
    if (!det || !els.panel.contains(det)) return;
    state.fullNotesOpen = det.open;
    if (det.open) {
      const node = state.index.byId.get(state.selected);
      if (node) fillFullNotes(node);
    }
  }, true);
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
        clearSelection({ push: true });
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
  try {
    const redirRes = await fetch(new URL("redirects.json", DATA_BASE), { cache: "no-store" });
    state.redirects = redirRes.ok ? await redirRes.json() : {};
  } catch {
    state.redirects = {};
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
    if (data && !Array.isArray(data) && data.sections && typeof data.sections === "object") {
      Object.assign(state.sections, data.sections);
    }
    for (const node of list) {
      nodes.push(node);
      if (node && node.id != null) state.nodeBranch.set(String(node.id), branch.id);
    }
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
  if (!location.hash || location.hash === "#") {
    history.replaceState(null, "", "#/");
  }
  applyRoute({ fitMap: true });
}

function lock() {
  clearReviseSession();
  state.key = null;
  state.baseNodes = [];
  state.sections = {};
  state.index = null;
  state.selected = null;
  state.editing = false;
  state.expanded = new Set();
  state.positions = new Map();
  state.mode = "overview";
  state.slug = null;
  state.focusId = null;
  state.subjects = [];
  state.nodeBranch = new Map();
  state.viewSides = new Map();
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
