/**
 * Runtime master glossary. Built after decrypt from section glossaries,
 * keyTerms and the in-memory acronym map. Never shipped as a plaintext file.
 */
import { canonicalAbbrKey, listAbbrKeys, abbrSenses } from "./abbr.js";
import { wrapPanelAbbrs } from "./abbr.js";

let catalog = { entries: [], bySlug: new Map(), size: 0 };
let hooks = null;
let filterTimer = 0;
let io = null;

export function glossarySlug(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "term";
}

export function glossaryHash(slug, branch) {
  const s = glossarySlug(slug);
  const b = String(branch || "").trim();
  if (s && b) return `#/glossary/${encodeURIComponent(s)}/${encodeURIComponent(b)}`;
  if (s) return `#/glossary/${encodeURIComponent(s)}`;
  return "#/glossary";
}

export function glossaryStats() {
  return { size: catalog.size, letters: new Set(catalog.entries.map((e) => e.letter)).size };
}

export function getGlossaryEntry(slug) {
  return catalog.bySlug.get(glossarySlug(slug)) || null;
}

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function letterOf(s) {
  const ch = String(s || "").trim();
  for (const c of ch) {
    if (/[A-Za-z]/.test(c)) return c.toUpperCase();
    if (/[0-9]/.test(c)) return "#";
  }
  return "#";
}

function senseKey(def, expand) {
  return `${norm(expand).toLowerCase()}|${norm(def).toLowerCase().slice(0, 160)}`;
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

function extractLinks(text) {
  const links = [];
  const seen = new Set();
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+|#([^)\s]+))\)/g;
  for (const m of String(text || "").matchAll(re)) {
    let id = m[3] || "";
    if (!id && m[2]) {
      const hash = String(m[2]).split("#")[1] || "";
      id = hash.replace(/^\/?(?:[a-z0-9-]+\/)*/, "").split("/").pop() || "";
      if (id.includes("=")) id = "";
    }
    id = decodeSafe(id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    links.push({ id, title: m[1] });
  }
  return links;
}

function decodeSafe(s) {
  try { return decodeURIComponent(String(s || "").trim()); } catch { return String(s || "").trim(); }
}

function cleanDef(text) {
  let d = norm(text);
  d = d.replace(/\s*See\s+\[[^\]]+\]\([^)]+\)\.?/gi, "");
  d = d.replace(/\s*See\s+\[[^\]]+\]\([^)]+\)\.?/gi, "");
  return d.replace(/\s+/g, " ").replace(/[.;\s]+$/, "").trim();
}

const ACR_IN_TERM = /(?:^|\s)\(?((?:Wi-Fi(?:\s*6E|\s*6|\s*7|\s*5|\s*4)?|OAuth(?:\s*2\.0)?|DDoS|ATT&CK|IPv[46]|802\.\d{1,2}[A-Za-z]{0,3}|CSMA\/C[AD]|TACACS\+|SHA-?\d{1,3}|[A-Z][A-Z0-9+]{1,10}|[A-Z]{2,8}\/[A-Z]{2,6}|[A-Z]{2,8}-[A-Z0-9]{1,8}))\)?(?:\s*$)/;

function parseTerm(term) {
  const t = norm(term);
  if (!t) return { title: "", acr: "", phrase: "" };
  let m = t.match(/^(.+?)\s+\(([^\)]+)\)\s*$/);
  if (m) {
    const inside = m[2].trim();
    const phrase = m[1].trim();
    const key = canonicalAbbrKey(inside);
    if (key && key.length <= 16 && !/\s/.test(inside)) {
      return { title: inside, acr: key, phrase };
    }
    const key2 = canonicalAbbrKey(phrase);
    if (key2 && /^[A-Z0-9].*$/.test(phrase) && phrase.length <= 20 && !/\s/.test(phrase.replace(/[.\-\/+\s]/g, ""))) {
      return { title: phrase, acr: key2, phrase: inside };
    }
  }
  const bare = t.match(/^(Wi-Fi(?:\s*6E|\s*6|\s*7|\s*5|\s*4)?|OAuth(?:\s*2\.0)?|DDoS|ATT&CK|IPv[46]|802\.\d{1,2}[A-Za-z]{0,3}|CSMA\/C[AD]|[A-Z][A-Z0-9+]{1,12}|[A-Z]{2,8}\/[A-Z]{2,6})$/);
  if (bare) return { title: bare[1], acr: canonicalAbbrKey(bare[1]), phrase: "" };
  return { title: t, acr: "", phrase: "" };
}

function topSectionId(index, subjects, nodeId) {
  if (!index || !nodeId) return null;
  const subject = (subjects || []).find((s) => {
    if (nodeId === s.rootId) return true;
    let cur = index.byId.get(nodeId)?.parentId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      if (cur === s.rootId) return true;
      seen.add(cur);
      cur = index.byId.get(cur)?.parentId;
    }
    return false;
  });
  const root = subject?.rootId;
  if (!root || nodeId === root) return root || nodeId;
  let cur = nodeId;
  const visited = new Set();
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const parent = index.byId.get(cur)?.parentId;
    if (!parent || parent === root || parent === index.rootId) return cur;
    cur = parent;
  }
  return nodeId;
}

function branchOf(id, ctx, index) {
  const fromMap = ctx.nodeBranch?.get?.(id);
  if (fromMap && fromMap !== "tree") return fromMap;
  const subjects = ctx.subjects || [];
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const sub = subjects.find((s) => s.rootId === cur);
    if (sub) return sub.slug || "";
    cur = index.byId.get(cur)?.parentId;
  }
  return "";
}

function branchTitle(slug, subjects) {
  return (subjects || []).find((s) => s.slug === slug)?.title || slug || "";
}

function upsertEntry(title, acr) {
  const display = acr ? (prettyAcr(acr, title) || title) : title;
  const slug = glossarySlug(acr || title);
  let entry = catalog.bySlug.get(slug);
  if (!entry) {
    entry = {
      slug,
      title: display,
      acr: acr || "",
      also: [],
      letter: letterOf(display),
      senses: [],
    };
    catalog.bySlug.set(slug, entry);
    catalog.entries.push(entry);
  } else if (display && display !== entry.title) {
    const alt = display;
    if (alt && !entry.also.includes(alt) && alt.toLowerCase() !== entry.title.toLowerCase()) {
      entry.also.push(alt);
    }
  }
  if (title && title !== entry.title && !entry.also.includes(title)) {
    const short = title.length < 80;
    if (short && title.toLowerCase() !== entry.title.toLowerCase()) entry.also.push(title);
  }
  return entry;
}

function prettyAcr(key, fallback) {
  if (!key) return fallback || "";
  if (key === "IPV4") return "IPv4";
  if (key === "IPV6") return "IPv6";
  if (key === "WIFI") return "Wi-Fi";
  if (key === "WIFI-6") return "Wi-Fi 6";
  if (key === "WIFI-6E") return "Wi-Fi 6E";
  if (key === "WIFI-7") return "Wi-Fi 7";
  if (key === "WIFI-5") return "Wi-Fi 5";
  if (key === "WIFI-4") return "Wi-Fi 4";
  if (key === "QOS") return "QoS";
  if (key === "POE") return "PoE";
  if (key === "IPSEC") return "IPsec";
  if (key === "NVME") return "NVMe";
  if (key === "PCIE") return "PCIe";
  if (key === "OAUTH") return "OAuth";
  if (key === "OAUTH-2") return "OAuth 2.0";
  if (key === "DDOS") return "DDoS";
  if (key === "ATT&CK") return "ATT&CK";
  return fallback && /[a-z]/.test(fallback) ? fallback : key;
}

function addSense(entry, {
  branch, branchTitle: bTitle, sectionId, sectionTitle, expand, def,
  topics, glossaries,
}) {
  const expandN = norm(expand);
  const defN = cleanDef(def);
  if (!expandN && !defN) return;
  const key = senseKey(defN, expandN);
  let sense = entry.senses.find((s) => s.branch === branch && senseKey(s.def, s.expand) === key);
  if (!sense) {
    // Same branch, same expand, merge into existing
    sense = entry.senses.find((s) => s.branch === branch && s.expand && expandN && s.expand.toLowerCase() === expandN.toLowerCase());
  }
  if (!sense) {
    sense = {
      branch: branch || "",
      branchTitle: bTitle || branch || "",
      sectionId: sectionId || "",
      sectionTitle: sectionTitle || "",
      expand: expandN,
      def: defN,
      topics: [],
      glossaries: [],
    };
    entry.senses.push(sense);
  } else {
    if (defN && defN.length > (sense.def || "").length) sense.def = defN;
    if (expandN && !sense.expand) sense.expand = expandN;
    if (sectionTitle && !sense.sectionTitle) {
      sense.sectionId = sectionId || sense.sectionId;
      sense.sectionTitle = sectionTitle;
    }
  }
  const addRef = (list, ref) => {
    if (!ref?.id) return;
    if (list.some((x) => x.id === ref.id)) return;
    list.push({ id: ref.id, title: ref.title || ref.id });
  };
  for (const t of topics || []) addRef(sense.topics, t);
  for (const g of glossaries || []) addRef(sense.glossaries, g);
}


function expandKey(s) {
  return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function mergeSenses(senses) {
  const out = [];
  for (const raw of senses || []) {
    if (/^hat /i.test(raw.expand || "")) continue;
    const ek = expandKey(raw.expand);
    const dk = expandKey(raw.def).slice(0, 48);
    const hit = out.find((o) => {
      if ((o.branch || "") !== (raw.branch || "")) return false;
      const oek = expandKey(o.expand);
      if (ek && oek && (ek === oek || ek.includes(oek) || oek.includes(ek))) return true;
      if (!ek && !oek && dk && expandKey(o.def).slice(0, 48) === dk) return true;
      return false;
    });
    if (!hit) {
      out.push({
        ...raw,
        topics: [...(raw.topics || [])],
        glossaries: [...(raw.glossaries || [])],
      });
      continue;
    }
    if ((raw.def || "").length > (hit.def || "").length) hit.def = raw.def;
    if (!(hit.expand || "") && raw.expand) hit.expand = raw.expand;
    if (raw.expand && hit.expand && raw.expand.length < hit.expand.length && expandKey(hit.expand).includes(expandKey(raw.expand))) {
      hit.expand = raw.expand;
    }
    if (raw.sectionTitle && !hit.sectionTitle) {
      hit.sectionId = raw.sectionId;
      hit.sectionTitle = raw.sectionTitle;
    }
    const addRef = (list, ref) => {
      if (!ref?.id || list.some((x) => x.id === ref.id)) return;
      list.push(ref);
    };
    for (const x of raw.topics || []) addRef(hit.topics, x);
    for (const x of raw.glossaries || []) addRef(hit.glossaries, x);
  }
  return out;
}

/**
 * Build the master glossary from the decrypted index and acronym map.
 * Call after buildAbbrIndex.
 */
export function buildGlossary(nodeIndex, ctx = {}) {
  catalog = { entries: [], bySlug: new Map(), size: 0 };
  const subjects = ctx.subjects || [];
  const index = nodeIndex;

  const sectionTitleOf = (id) => {
    const sid = topSectionId(index, subjects, id);
    if (!sid) return { id: "", title: "" };
    const node = index.byId.get(sid);
    return { id: sid, title: node?.title || sid };
  };

  for (const [id, node] of index.byId) {
    const branch = branchOf(id, ctx, index);
    const bTitle = branchTitle(branch, subjects);
    const section = sectionTitleOf(id);

    if (isGlossNode(node)) {
      const glossRef = { id, title: node.title || "Glossary" };
      // Prefer the section as the parent of the glossary
      const parent = node.parentId ? index.byId.get(node.parentId) : null;
      const sec = parent ? { id: parent.id, title: parent.title || parent.id } : section;
      for (const [term, def] of glossTerms(node.expanded)) {
        const parsed = parseTerm(term);
        if (!parsed.title) continue;
        const entry = upsertEntry(parsed.acr ? prettyAcr(parsed.acr, parsed.title) : parsed.title, parsed.acr);
        const expand = parsed.phrase || parsed.acr || "";
        const links = extractLinks(def);
        addSense(entry, {
          branch,
          branchTitle: bTitle,
          sectionId: sec.id,
          sectionTitle: sec.title,
          expand: parsed.phrase || "",
          def,
          topics: links,
          glossaries: [glossRef],
        });
      }
    }

    for (const row of node.keyTerms || []) {
      const parsed = parseTerm(row.term);
      if (!parsed.title) continue;
      const entry = upsertEntry(parsed.acr ? prettyAcr(parsed.acr, parsed.title) : parsed.title, parsed.acr);
      const topicId = row.link || id;
      const topicNode = index.byId.get(topicId);
      addSense(entry, {
        branch,
        branchTitle: bTitle,
        sectionId: section.id,
        sectionTitle: section.title,
        expand: parsed.phrase || "",
        def: row.def || "",
        topics: topicNode ? [{ id: topicId, title: topicNode.title }] : [],
        glossaries: [],
      });
    }
  }

  // Acronym map fills any remaining keys and extra branch senses.
  for (const key of listAbbrKeys()) {
    const slug = glossarySlug(key);
    const entry = catalog.bySlug.get(slug) || upsertEntry(prettyAcr(key, key), key);
    const rows = abbrSenses(key) || [];
    const byBranch = new Map();
    for (const row of rows) {
      const b = row.branch || "";
      if (!byBranch.has(b)) byBranch.set(b, []);
      byBranch.get(b).push(row);
    }
    for (const [b, list] of byBranch) {
      const expands = [...new Set(list.map((r) => norm(r.expand)).filter(Boolean))];
      const already = entry.senses.some((s) => s.branch === b);
      if (already) {
        for (const s of entry.senses.filter((x) => x.branch === b)) {
          if (!s.expand && expands[0]) s.expand = expands[0];
        }
        continue;
      }
      const expand = expands.length <= 2 ? expands.join(" · ") : expands[0];
      if (!expand) continue;
      addSense(entry, {
        branch: b,
        branchTitle: branchTitle(b, subjects),
        sectionId: "",
        sectionTitle: "",
        expand,
        def: "",
        topics: [],
        glossaries: [],
      });
    }
  }

  // Tidy also-known-as, merge duplicate senses, and sort
  for (const e of catalog.entries) {
    e.also = e.also.filter((a) => a && a.toLowerCase() !== e.title.toLowerCase()).slice(0, 6);
    e.senses = mergeSenses(e.senses);
    e.senses.sort((a, b) => (a.branchTitle || a.branch).localeCompare(b.branchTitle || b.branch) || (a.expand || "").localeCompare(b.expand || ""));
  }
  catalog.entries.sort((a, b) => a.letter.localeCompare(b.letter) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  catalog.size = catalog.entries.length;
  return { size: catalog.size };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function haystack(entry) {
  const parts = [entry.title, entry.acr, ...(entry.also || [])];
  for (const s of entry.senses) {
    parts.push(s.expand, s.def, s.branch, s.branchTitle, s.sectionTitle);
    for (const t of s.topics) parts.push(t.title);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function matches(entry, q) {
  if (!q) return true;
  const hay = haystack(entry);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w));
}

function lettersIn(entries) {
  const set = new Set(entries.map((e) => e.letter));
  const out = [];
  if (set.has("#")) out.push("#");
  for (let i = 0; i < 26; i++) {
    const L = String.fromCharCode(65 + i);
    if (set.has(L)) out.push(L);
  }
  return out;
}

function renderSense(entry, sense, { activeBranch } = {}) {
  const isActive = activeBranch && sense.branch === activeBranch;
  const heading = sense.expand && sense.expand.toLowerCase() !== entry.title.toLowerCase()
    ? sense.expand
    : (sense.def ? "" : sense.expand);
  const topics = (sense.topics || []).slice(0, 6);
  const glosses = sense.glossaries || [];
  const topicHtml = topics.map((t) =>
    `<a class="gloss-ref" href="#${escapeHtml(t.id)}" data-act="open-topic" data-id="${escapeHtml(t.id)}">${escapeHtml(t.title)}</a>`
  ).join("");
  const glossHtml = glosses.map((g) =>
    `<a class="gloss-ref" href="#${escapeHtml(g.id)}" data-act="open-topic" data-id="${escapeHtml(g.id)}">${escapeHtml(g.title)}</a>`
  ).join("");
  const where = [sense.branchTitle, sense.sectionTitle].filter(Boolean);
  return `<article class="gloss-sense${isActive ? " is-branch" : ""}" data-branch="${escapeHtml(sense.branch)}" ${isActive ? 'data-active-branch="1"' : ""}>
    <p class="gloss-where">${where.map((w, i) => i === 0 ? `<strong>${escapeHtml(w)}</strong>` : escapeHtml(w)).join(" · ")}</p>
    ${heading ? `<p class="gloss-expand">${escapeHtml(heading)}</p>` : ""}
    ${sense.def ? `<p class="gloss-def">${escapeHtml(sense.def)}</p>` : ""}
    ${topicHtml ? `<p class="gloss-links"><span class="gloss-links-label">Topics</span> ${topicHtml}</p>` : ""}
    ${glossHtml ? `<p class="gloss-links"><span class="gloss-links-label">Section glossary</span> ${glossHtml}</p>` : ""}
  </article>`;
}

function renderEntry(entry, { targetSlug, activeBranch } = {}) {
  const isTarget = targetSlug && entry.slug === targetSlug;
  const also = (entry.also || []).slice(0, 4);
  return `<article class="gloss-entry${isTarget ? " is-target" : ""}" id="gloss-${escapeHtml(entry.slug)}" data-slug="${escapeHtml(entry.slug)}">
    <h3 class="gloss-term">${escapeHtml(entry.title)}</h3>
    ${also.length ? `<p class="gloss-also">${also.map(escapeHtml).join(" · ")}</p>` : ""}
    ${entry.senses.map((s) => renderSense(entry, s, { activeBranch: isTarget ? activeBranch : "" })).join("")}
  </article>`;
}

function groupByLetter(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.letter)) map.set(e.letter, []);
    map.get(e.letter).push(e);
  }
  return map;
}

function paintList(root, { slug, branch, query } = {}) {
  const q = norm(query);
  const matched = q ? catalog.entries.filter((e) => matches(e, q)) : catalog.entries;
  const letters = lettersIn(catalog.entries);
  const present = new Set(matched.map((e) => e.letter));
  const jump = root.querySelector(".gloss-jump");
  if (jump) {
    for (const a of jump.querySelectorAll("[data-letter]")) {
      const L = a.dataset.letter;
      a.classList.toggle("is-empty", !present.has(L));
      a.tabIndex = present.has(L) ? 0 : -1;
    }
  }
  const status = root.querySelector(".gloss-status");
  if (status) {
    if (q) status.textContent = `${matched.length} match${matched.length === 1 ? "" : "es"} for “${q}”`;
    else status.textContent = `${catalog.size} terms`;
  }
  const list = root.querySelector(".gloss-list");
  if (!list) return;
  const grouped = groupByLetter(matched);
  const order = lettersIn(matched);
  if (!matched.length) {
    list.innerHTML = `<p class="gloss-empty">No terms match that filter.</p>`;
    return;
  }
  const eager = Boolean(q) && matched.length <= 400;
  list.innerHTML = order.map((L) => {
    const entries = grouped.get(L) || [];
    const label = L === "#" ? "0–9" : L;
    return `<section class="gloss-letter" id="gloss-letter-${L === "#" ? "num" : L}" data-letter="${L}">
      <h2>${escapeHtml(label)}</h2>
      <div class="gloss-letter-body" data-count="${entries.length}"></div>
    </section>`;
  }).join("");

  const fillLetter = (L) => {
    const section = list.querySelector(`[data-letter="${CSS.escape(L)}"]`);
    const body = section?.querySelector(".gloss-letter-body");
    if (!body || body.dataset.ready === "1") return;
    const entries = grouped.get(L) || [];
    body.innerHTML = entries.map((e) => renderEntry(e, { targetSlug: slug, activeBranch: branch })).join("");
    body.dataset.ready = "1";
    for (const el of body.querySelectorAll(".gloss-def, .gloss-expand")) {
      wrapPanelAbbrs(el, branch || "");
    }
  };
  list._fillLetter = fillLetter;
  list._grouped = grouped;

  const first = order[0];
  const targetLetter = slug ? (catalog.bySlug.get(glossarySlug(slug))?.letter || first) : first;
  if (eager) for (const L of order) fillLetter(L);
  else {
    if (targetLetter) fillLetter(targetLetter);
    if (!slug && first && first !== targetLetter) fillLetter(first);
    if (io) io.disconnect();
    io = new IntersectionObserver((recs) => {
      for (const rec of recs) {
        if (!rec.isIntersecting) continue;
        const L = rec.target.getAttribute("data-letter");
        if (L) fillLetter(L);
      }
    }, { root, rootMargin: "240px 0px" });
    for (const sec of list.querySelectorAll(".gloss-letter")) io.observe(sec);
  }
}

function chromeHeight(root) {
  const chrome = root.querySelector(".gloss-chrome");
  return chrome ? Math.ceil(chrome.getBoundingClientRect().height) : 0;
}

function scrollToEntry(root, slug, branch) {
  if (!slug) return;
  const el = root.querySelector(`#gloss-${CSS.escape(glossarySlug(slug))}`);
  if (!el) return;
  el.classList.add("is-target");
  const pad = chromeHeight(root) + 16;
  root.style.scrollPaddingTop = `${pad}px`;
  const go = () => {
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - pad;
    root.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  };
  go();
  requestAnimationFrame(() => requestAnimationFrame(go));
}

export function renderGlossaryView(root, opts = {}) {
  if (!root) return;
  const { slug, branch, returnTo } = opts;
  const backLabel = returnTo?.title ? `Back to ${returnTo.title}` : "Back";
  const backHtml = returnTo
    ? `<button type="button" class="gloss-back" data-act="glossary-back">← ${escapeHtml(backLabel)}</button>`
    : `<button type="button" class="gloss-back" data-act="glossary-home">← Home</button>`;
  const letters = lettersIn(catalog.entries);
  const jump = letters.map((L) => {
    const label = L === "#" ? "0–9" : L;
    const href = L === "#" ? "#gloss-letter-num" : `#gloss-letter-${L}`;
    return `<a class="gloss-jump-link" href="${href}" data-letter="${L}">${escapeHtml(label)}</a>`;
  }).join("");

  root.innerHTML = `<div class="gloss-page">
    <div class="gloss-chrome">
      <div class="gloss-top">
        ${backHtml}
        <div class="gloss-top-title">
          <h1>Glossary</h1>
          <p class="gloss-kicker">Every term and acronym in the compendium, gathered after you unlock. ${catalog.size} entries.</p>
        </div>
      </div>
      <div class="gloss-toolbar">
        <label class="gloss-filter-wrap">
          <span class="visually-hidden">Filter glossary</span>
          <input type="search" class="gloss-filter" placeholder="Filter terms and acronyms" value="${escapeHtml(opts.query || "")}" autocomplete="off" enterkeyhint="search">
        </label>
        <p class="gloss-status" aria-live="polite">${catalog.size} terms</p>
        <nav class="gloss-jump" aria-label="Jump to letter">${jump}</nav>
      </div>
    </div>
    <div class="gloss-list"></div>
  </div>`;

  paintList(root, { slug, branch, query: opts.query || "" });
  bindGlossaryDom(root, opts);
  if (slug) {
    requestAnimationFrame(() => scrollToEntry(root, slug, branch));
  } else if (!opts.query) {
    root.querySelector(".gloss-page")?.scrollTo?.(0, 0);
  }
}

function bindGlossaryDom(root, opts) {
  const input = root.querySelector(".gloss-filter");
  if (input && !input.dataset.bound) {
    input.dataset.bound = "1";
    input.addEventListener("input", () => {
      clearTimeout(filterTimer);
      const q = input.value;
      filterTimer = setTimeout(() => paintList(root, { ...opts, query: q }), 80);
    });
  }
  if (io) {
    io.disconnect();
    io = null;
  }
}

export function initGlossary(nextHooks) {
  hooks = nextHooks;
}

export function showGlossary({ slug, branch, returnTo, query } = {}) {
  if (!hooks?.els?.glossary) return;
  const el = hooks.els.glossary;
  el.hidden = false;
  document.body.classList.add("glossary-open");
  document.querySelector("#app > header")?.removeAttribute("inert");
  hooks.els.glossaryBtn?.classList.add("active");
  hooks.els.glossaryBtn?.setAttribute("aria-current", "page");
  renderGlossaryView(el, { slug, branch, returnTo, query });
  const input = el.querySelector(".gloss-filter");
  if (input && !slug) {
    // Don't steal focus on a deep-linked entry (prevents jump on mobile).
  }
}

export function hideGlossary() {
  if (!hooks?.els?.glossary) return;
  const el = hooks.els.glossary;
  el.innerHTML = "";
  el.hidden = true;
  document.body.classList.remove("glossary-open");
  hooks.els.glossaryBtn?.classList.remove("active");
  hooks.els.glossaryBtn?.removeAttribute("aria-current");
}

export function isGlossaryVisible() {
  return Boolean(hooks?.els?.glossary && !hooks.els.glossary.hidden);
}

export function clearGlossarySession() {
  hideGlossary();
}
