/**
 * In-memory acronym map and accessible tooltips.
 * Built after decrypt from glossaries and keyTerms. Never shipped as plaintext data.
 */

const GENERIC = new Set([
  "ID", "IT", "OR", "AN", "BE", "DO", "IF", "NO", "OK", "SO", "TO", "US", "UK",
  "EU", "AM", "PM", "TV", "HR", "CEO", "CFO", "CTO", "THE", "AND", "FOR", "NOT",
]);

const ACR_IN_TERM = /\b([A-Z][A-Z0-9]{1,7})(?:s)?\b/g;

let index = {
  /** @type {Map<string, {expand: string, branch: string, src: string}[]>} */
  byAcr: new Map(),
  /** @type {RegExp|null} */
  re: null,
};

function normExpand(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function uniqueExpands(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const e = normExpand(row.expand);
    if (!e) continue;
    const k = e.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function stripSelfRef(acr, expand) {
  let e = normExpand(expand);
  if (!e) return "";
  const key = acr.toUpperCase();
  const trail = e.match(new RegExp("^(.*?)\\s*\\(" + key + "\\)\\s*$", "i"));
  if (trail && trail[1].trim()) e = trail[1].trim();
  const lead = e.match(new RegExp("^" + key + "\\s*\\((.+)\\)\\s*$", "i"));
  if (lead) e = lead[1].trim();
  e = e.replace(new RegExp("^" + key + "\\s+[—–-]\\s+", "i"), "");
  e = e.replace(/[.;]+$/, "").trim();
  return e;
}

function isPhrase(e) {
  // A good expansion is a short name or noun phrase, not a leftover sentence.
  if (!e || e.length < 4 || e.length > 110) return false;
  if (/^[a-z]/.test(e) && e.length > 40) return false;
  if (/^(how |the idea |see |this |it is |for example)/i.test(e)) return false;
  return true;
}

function senseKey(e) {
  return e
    .toLowerCase()
    .replace(/-based\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:the|a|an|based)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickBest(acr, phrases) {
  const cleaned = [];
  const seen = new Set();
  for (const raw of phrases) {
    const e = stripSelfRef(acr, raw);
    if (!isPhrase(e)) continue;
    const k = senseKey(e);
    if (!k || k === acr.toLowerCase() || seen.has(k)) continue;
    seen.add(k);
    cleaned.push(e);
  }
  if (!cleaned.length) return [];
  // Merge near-duplicates: if one phrase contains another, keep the shorter clear name
  // unless they look like genuinely different senses (share few words).
  const kept = [];
  const sorted = [...cleaned].sort((a, b) => a.length - b.length);
  for (const p of sorted) {
    const pk = senseKey(p);
    const contained = kept.some((k) => {
      const kk = senseKey(k);
      return kk.includes(pk) || pk.includes(kk);
    });
    if (contained) continue;
    kept.push(p);
  }
  // If a formal title-case name exists, drop informal usage notes.
  const formal = kept.filter((e) => /^[A-Z]/.test(e) && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(e) && !/\b(?:is|are|then)\b/.test(e));
  const pool = formal.length ? formal : kept;
  const long = pool.filter((e) => e.split(/\s+/).length >= 3);
  return long.length ? long : pool;
}

function harvestFromTerm(term, def, branch, src) {
  const t = String(term || "").trim();
  if (!t) return;
  const add = (acr, expand, prefer) => {
    const key = String(acr || "").toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,7}$/.test(key) || GENERIC.has(key)) return;
    const ex = stripSelfRef(key, expand);
    if (!isPhrase(ex) || ex.toUpperCase() === key) return;
    const list = index.byAcr.get(key) || [];
    list.push({ expand: ex, branch: branch || "", src: src || "", prefer: !!prefer });
    index.byAcr.set(key, list);
  };

  // "Intrusion Detection System (IDS)" or "IDS (Intrusion Detection System)", even with a trailing word such as "address".
  for (const m of t.matchAll(/([A-Za-z][A-Za-z0-9 +\/\-]{1,80}?)\s+\(([A-Z][A-Z0-9]{1,7}(?:\s*\/\s*[A-Z][A-Z0-9]{1,7})*)\)/g)) {
    const phrase = m[1].trim();
    if (phrase && !/^[A-Z][A-Z0-9]{1,7}$/.test(phrase)) {
      if (!m[2].includes("/")) add(m[2].trim(), phrase, true);
    }
  }
  for (const m of t.matchAll(/(?:^|[^A-Za-z0-9/])([A-Z][A-Z0-9]{1,7})\s+\(([^)]+)\)/g)) {
    const inside = m[2].trim();
    if (inside && !/^[A-Z][A-Z0-9/ ]{1,40}$/.test(inside)) add(m[1], inside, true);
  }
  // Bare "CISSP", "HPA axis": use the official name at the start of the definition.
  const bare = t.match(/^([A-Z][A-Z0-9]{1,7})(?:\s+axis|\s+address)?$/i);
  if (bare) {
    let d = normExpand(def);
    const named = d.match(/^([A-Z][^—–.(]{2,90}?)(?:\s+[—–-]\s+|\s+\(|\.\s|$)/);
    d = named ? named[1].trim() : d.split(/(?<=\.)\s/)[0];
    add(bare[1], d, src === "glossary");
  }
  // "PCI DSS" / "Payment Card Industry Data Security Standards (PCI DSS)"
  for (const m of t.matchAll(/\(([A-Z][A-Z0-9]{1,7})(?:\s+[A-Z][A-Z0-9]{1,7})+\)/g)) {
    const phrase = t.replace(m[0], "").replace(/[()]/g, "").trim();
    if (phrase) add(m[1], phrase, true);
  }
  const compound = t.match(/^([A-Z][A-Z0-9]{1,7})\s+[A-Z][A-Z0-9]/);
  if (compound && !t.includes("(")) {
    let d = normExpand(def);
    const named = d.match(/^([A-Z][^—–.(]{2,90}?)(?:\s+[—–-]\s+|\s+\(|\.\s|$)/);
    if (named) add(compound[1], named[1].trim(), src === "glossary");
    else add(compound[1], t, true);
  }
}

function isGlossNode(node) {
  const tags = node?.tags || [];
  const title = node?.title || "";
  const id = node?.id || "";
  return tags.includes("glossary") || id.endsWith("-gloss") || /\bglossary\b/i.test(title);
}

function glossTerms(expanded) {
  const e = String(expanded || "");
  const head = e.split(/^###\s+(Exam tips|Exam point|Exam clue|Memory aids|Practice)\s*$/im)[0] || e;
  const out = [];
  for (const m of head.matchAll(/^\*\*(.+?)\.\*\*\s+(.*)$/gm)) out.push([m[1], m[2]]);
  for (const m of head.matchAll(/^[-*]\s+\*\*(.+?)\*\*\s*[:.—–-]?\s+(.*)$/gm)) out.push([m[1], m[2]]);
  return out;
}

function compile() {
  const keys = [...index.byAcr.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (!keys.length) {
    index.re = null;
    return;
  }
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  index.re = new RegExp(`(?<![A-Za-z0-9/])(${alt})s?(?![A-Za-z0-9/])`, "g");
}

/**
 * Build the acronym map from the decrypted index.
 * @param {{ byId: Map<string, any> }} nodeIndex
 * @param {{ nodeBranch?: Map<string, string>, subjects?: { slug: string, rootId: string }[] }} ctx
 */
export function buildAbbrIndex(nodeIndex, ctx = {}) {
  index = { byAcr: new Map(), re: null };
  const nodeBranch = ctx.nodeBranch;
  const subjects = ctx.subjects || [];
  const branchOf = (id) => {
    const fromMap = nodeBranch?.get?.(id);
    if (fromMap && fromMap !== "tree") return fromMap;
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const sub = subjects.find((s) => s.rootId === cur);
      if (sub) return sub.slug || sub.branchId || "";
      cur = nodeIndex.byId.get(cur)?.parentId;
    }
    return "";
  };

  for (const [id, node] of nodeIndex.byId) {
    const branch = branchOf(id);
    if (isGlossNode(node)) {
      for (const [term, def] of glossTerms(node.expanded)) {
        harvestFromTerm(term, def, branch, "glossary");
      }
    }
    for (const row of node.keyTerms || []) {
      harvestFromTerm(row.term, row.def, branch, "keyTerms");
    }
  }
  compile();
  return { size: index.byAcr.size };
}

export function setAbbrIndex(built) {
  // buildAbbrIndex already stored the map; this exists for a clear call site.
  return built;
}

export function abbrStats() {
  return { size: index.byAcr.size };
}

/**
 * Resolve an expansion for this branch. If two senses exist here, show both.
 * If this branch has none and other branches disagree, skip (return "").
 */
export function resolveAbbr(acr, branch) {
  const key = String(acr || "").toUpperCase();
  const rows = index.byAcr.get(key) || [];
  if (!rows.length) return "";
  const favoured = (list) => {
    const preferred = list.filter((r) => r.prefer);
    const pool = preferred.length ? preferred : list;
    return pickBest(key, pool.map((r) => r.expand));
  };
  const here = favoured(rows.filter((r) => r.branch && r.branch === branch));
  if (here.length === 1) return here[0];
  if (here.length > 1) return here.join(" · ");
  const all = favoured(rows);
  if (all.length === 1) return all[0];
  return ""; // cannot decide — do not guess
}

const SKIP_TAGS = new Set([
  "CODE", "PRE", "A", "KBD", "SAMP", "ABBR", "H1", "H2", "H3", "H4", "H5", "H6",
  "BUTTON", "TEXTAREA", "INPUT", "SCRIPT", "STYLE", "SUMMARY", "DT",
]);

function skipNode(node, root) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== root) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    const cl = el.classList;
    if (cl && (cl.contains("term-run") || cl.contains("key-terms") || cl.contains("jump-bar") || cl.contains("crumbs"))) return true;
    el = el.parentElement;
  }
  return false;
}

function alreadyExpanded(text, end) {
  return /^\s*\(/.test(text.slice(end));
}

/**
 * Wrap the first occurrence of each known acronym in a panel subtree.
 */
export function wrapPanelAbbrs(root, branch) {
  if (!root || !index.re) return 0;
  const seen = new Set();
  for (const el of root.querySelectorAll("abbr.kc-abbr")) {
    const k = (el.getAttribute("data-acr") || el.textContent || "").replace(/s$/, "").toUpperCase();
    if (k) seen.add(k);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (skipNode(node, root)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  let wrapped = 0;
  for (const textNode of targets) {
    const text = textNode.nodeValue;
    index.re.lastIndex = 0;
    let m;
    const pieces = [];
    let last = 0;
    let changed = false;
    while ((m = index.re.exec(text))) {
      const raw = m[1];
      const key = raw.toUpperCase();
      if (seen.has(key)) continue;
      if (alreadyExpanded(text, m.index + m[0].length)) continue;
      const expand = resolveAbbr(key, branch);
      if (!expand) continue;
      seen.add(key);
      changed = true;
      pieces.push(document.createTextNode(text.slice(last, m.index)));
      const abbr = document.createElement("abbr");
      abbr.className = "kc-abbr";
      abbr.setAttribute("tabindex", "0");
      abbr.setAttribute("data-acr", key);
      abbr.setAttribute("data-expand", expand);
      abbr.setAttribute("aria-label", `${m[0]}, ${expand}`);
      abbr.textContent = m[0];
      pieces.push(abbr);
      last = m.index + m[0].length;
      wrapped++;
    }
    if (!changed) continue;
    pieces.push(document.createTextNode(text.slice(last)));
    const parent = textNode.parentNode;
    for (const p of pieces) parent.insertBefore(p, textNode);
    parent.removeChild(textNode);
  }
  return wrapped;
}

function tipEl() {
  let el = document.getElementById("kc-abbr-tip");
  if (!el) {
    el = document.createElement("div");
    el.id = "kc-abbr-tip";
    el.setAttribute("role", "tooltip");
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

let tipOwner = null;
let hideTimer = 0;

function placeTip(anchor, el) {
  const tip = tipEl();
  const r = anchor.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  tip.style.left = "0px";
  tip.style.top = "0px";
  tip.hidden = false;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
  let top = r.bottom + gap;
  if (top + th > window.innerHeight - margin && r.top - gap - th >= margin) {
    top = r.top - gap - th;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - th - margin));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.textContent = el;
}

function showTip(anchor) {
  clearTimeout(hideTimer);
  const expand = anchor.getAttribute("data-expand") || "";
  if (!expand) return;
  tipOwner = anchor;
  const tip = tipEl();
  const id = "kc-abbr-tip";
  anchor.setAttribute("aria-describedby", id);
  placeTip(anchor, expand);
  tip.hidden = false;
}

function hideTip() {
  clearTimeout(hideTimer);
  const tip = tipEl();
  tip.hidden = true;
  if (tipOwner) tipOwner.removeAttribute("aria-describedby");
  tipOwner = null;
}

function hideTipSoon() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideTip, 120);
}

/** Bind once. Hover, focus and tap; Escape and scroll close. */
export function bindAbbrTooltips() {
  if (document.documentElement.dataset.kcAbbrBound === "1") return;
  document.documentElement.dataset.kcAbbrBound = "1";
  tipEl();

  document.addEventListener("pointerover", (e) => {
    const a = e.target.closest?.("abbr.kc-abbr");
    if (a) showTip(a);
  });
  document.addEventListener("pointerout", (e) => {
    const a = e.target.closest?.("abbr.kc-abbr");
    if (!a) return;
    const to = e.relatedTarget;
    if (to && (a.contains(to) || to === tipEl())) return;
    hideTipSoon();
  });
  document.addEventListener("focusin", (e) => {
    const a = e.target.closest?.("abbr.kc-abbr");
    if (a) showTip(a);
  });
  document.addEventListener("focusout", (e) => {
    const a = e.target.closest?.("abbr.kc-abbr");
    if (a && !a.contains(e.relatedTarget)) hideTipSoon();
  });
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("abbr.kc-abbr");
    if (a) {
      e.preventDefault();
      showTip(a);
      return;
    }
    if (tipOwner) hideTip();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tipOwner) {
      hideTip();
    }
  });
  window.addEventListener("scroll", () => { if (tipOwner) hideTip(); }, true);
  window.addEventListener("resize", () => { if (tipOwner) hideTip(); });
}
