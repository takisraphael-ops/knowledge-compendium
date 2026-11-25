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
  const raw = String(key || "").trim();
  let s = raw.toLowerCase().replace(/&/g, "-");
  s = s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  if (s) return s;
  const hex = [...raw].map((c) => c.codePointAt(0).toString(16)).join("-");
  return hex ? `sym-${hex}` : "term";
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

export function listGlossaryEntries() {
  return catalog.entries;
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

function looksLikeAcronym(s) {
  const raw = String(s || "").trim();
  if (!raw || /\s/.test(raw)) return false;
  if (/[^\x00-\x7F]/.test(raw)) return false;
  if (/^\/\?$/.test(raw) || /^\/[A-Za-z0-9?]+$/.test(raw)) return true;
  if (/[a-z]/.test(raw) && !/^(Wi-Fi(?:\s*6E|\s*6|\s*7|\s*5|\s*4)?|OAuth(?:\s*2\.0)?|IPv[46]|DDoS|eSIM|iSCSI|IaaS|PaaS|SaaS|PoE|QoS|IPsec|NVMe|PCIe|x86(?:-64)?)$/i.test(raw) && !/^802\./.test(raw)) {
    return false;
  }
  const key = canonicalAbbrKey(raw);
  if (!key) return false;
  if (/^[A-Z][A-Z0-9+]{1,12}$/.test(key)) return true;
  if (/^[A-Z]{2,8}\/[A-Z]{2,6}$/.test(key)) return true;
  if (/^802\.\d{1,2}[A-Z]{0,3}$/.test(key)) return true;
  if (/^IPV[46]$/.test(key) || /^WIFI(?:-6E|-6|-7|-5|-4)?$/.test(key)) return true;
  if (/^SHA-\d{1,3}$/.test(key) || key === "3DES" || key === "ATT&CK") return true;
  if (/^[A-Z]{2,8}-[A-Z0-9]{1,12}$/.test(key)) return true;
  if (key === "PCIE" || key === "NVME" || key === "IPSEC" || key === "OAUTH" || key === "OAUTH-2" || key === "DDOS") return true;
  return false;
}

function looksLikeExpansion(acr, phrase) {
  const p = norm(phrase);
  if (!p) return false;
  if (/^[a-z]{1,12}$/.test(p)) return false; // qualifiers such as "role", "type"
  const initials = p.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]).join("");
  const key = (canonicalAbbrKey(acr) || String(acr || "")).toUpperCase();
  if (initials && key && initials.toUpperCase() === key) return true;
  if (/^\/\?$/.test(acr) && /command help/i.test(p)) return true;
  if (p.length >= 10 && /[A-Z]/.test(p)) return true;
  return false;
}

function parseTerm(term) {
  const t = norm(term);
  if (!t) return { title: "", acr: "", phrase: "", aliases: [] };
  let m = t.match(/^(.+?)\s+\(([^\)]+)\)\s*$/);
  if (m) {
    const inside = m[2].trim();
    const phrase = m[1].trim();
    if (looksLikeAcronym(inside) && !/\s/.test(inside)) {
      const aliases = [];
      if (phrase) aliases.push(phrase);
      return { title: inside, acr: canonicalAbbrKey(inside) || inside, phrase, aliases };
    }
    if (looksLikeAcronym(phrase) && phrase.length <= 24 && !/\s/.test(phrase.replace(/[.\-\/+\s]/g, ""))) {
      const expand = looksLikeExpansion(phrase, inside) ? inside : "";
      const aliases = [];
      if (expand) aliases.push(expand);
      return { title: phrase, acr: canonicalAbbrKey(phrase) || phrase, phrase: expand, aliases };
    }
    // Annotation in parens (CJK original, translation, etc.): keep the Latin or main phrase as the title.
    const aliases = [];
    if (inside && inside !== phrase) aliases.push(inside);
    return { title: phrase, acr: looksLikeAcronym(phrase) ? (canonicalAbbrKey(phrase) || "") : "", phrase: inside, aliases };
  }
  const bare = t.match(/^(Wi-Fi(?:\s*6E|\s*6|\s*7|\s*5|\s*4)?|OAuth(?:\s*2\.0)?|DDoS|ATT&CK|IPv[46]|802\.\d{1,2}[A-Za-z]{0,3}|CSMA\/C[AD]|[A-Z][A-Z0-9+]{1,12}|[A-Z]{2,8}\/[A-Z]{2,6}|\/\?)$/);
  if (bare) return { title: bare[1], acr: looksLikeAcronym(bare[1]) ? (canonicalAbbrKey(bare[1]) || bare[1]) : "", phrase: "", aliases: [] };
  return { title: t, acr: "", phrase: "", aliases: [] };
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

function addAlias(entry, alias, trusted = false) {
  const a = norm(alias);
  if (!a || a.length > 80) return;
  if (a.toLowerCase() === (entry.title || "").toLowerCase()) return;
  if (entry.acr && a.toLowerCase() === prettyAcr(entry.acr, entry.acr).toLowerCase()) return;
  if (entry.also.some((x) => x.toLowerCase() === a.toLowerCase())) return;
  if (!trusted && !aliasBelongs(entry, a)) return;
  entry.also.push(a);
}

function aliasBelongs(entry, alias) {
  const a = norm(alias);
  if (!a) return false;
  const title = entry.title || "";
  const acr = prettyAcr(entry.acr, entry.acr) || entry.acr || "";
  if (a.toLowerCase() === title.toLowerCase()) return false;
  // Genuine variants: the expansion phrase, a romanisation/original, or a typographic twin.
  if (acr && a.toLowerCase() === acr.toLowerCase()) return false;
  const compact = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const ca = compact(a);
  const ct = compact(title);
  const ck = compact(acr);
  if (ca && (ca === ct || ca === ck)) return true;
  if (title && (title.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(title.toLowerCase()))) {
    if (Math.min(title.length, a.length) >= 2) return true;
  }
  if (acr && (a.toLowerCase().includes(acr.toLowerCase()) || acr.toLowerCase().includes(a.toLowerCase()))) return true;
  const initials = a.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0]).join("").toLowerCase();
  if (ck && initials && initials === ck.toLowerCase()) return true;
  for (const s of entry.senses || []) {
    const ex = s.expand || "";
    if (ex && (ex.toLowerCase() === a.toLowerCase() || ex.toLowerCase().includes(a.toLowerCase()) || a.toLowerCase().includes(ex.toLowerCase()))) return true;
  }
  // CJK / non-Latin original next to a Latin title (Chi / 地), or a symbol form such as /?.
  if (/[^\x00-\x7F]/.test(a) && /[A-Za-z]/.test(title)) return true;
  if (/^\/\?$/.test(a) || /^command help$/i.test(a)) return true;
  return false;
}

function upsertEntry(title, acr, aliases = []) {
  const acrKey = acr && looksLikeAcronym(acr) ? (canonicalAbbrKey(acr) || acr) : (acr || "");
  const display = acrKey ? (prettyAcr(acrKey, title) || title) : title;
  const slug = glossarySlug(acrKey || title);
  let entry = catalog.bySlug.get(slug);
  if (!entry) {
    entry = {
      slug,
      title: display,
      acr: acrKey || "",
      also: [],
      letter: letterOf(display),
      senses: [],
    };
    catalog.bySlug.set(slug, entry);
    catalog.entries.push(entry);
  }
  for (const al of aliases || []) addAlias(entry, al, true);
  if (title && title !== entry.title) addAlias(entry, title);
  if (display && display !== entry.title) addAlias(entry, display);
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
  if (key === "/?" || key === "SYM-2F-3F") return "/?";
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
      const da = expandKey(raw.def);
      const db = expandKey(o.def);
      if (da && db && (da.slice(0, 40) === db.slice(0, 40) || da.includes(db.slice(0, 48)) || db.includes(da.slice(0, 48)))) return true;
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


function foldTitle(t) {
  return norm(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function isCommandHelpTitle(e) {
  const s = foldTitle(e.title);
  return s === "/?" || e.slug === "sym-2f-3f" || s === "command help" || s === "command help /?";
}

function commandHelpPair(a, b) {
  return isCommandHelpTitle(a) && isCommandHelpTitle(b);
}

function shouldMergeEntries(a, b) {
  if (a === b) return false;
  if (a.slug === b.slug) return true;
  if (foldTitle(a.title) === foldTitle(b.title) && foldTitle(a.title)) return true;
  if (commandHelpPair(a, b)) return true;
  const ap = parseTerm(a.title);
  const bp = parseTerm(b.title);
  if (ap.acr && (glossarySlug(ap.acr) === b.slug || glossarySlug(ap.title) === b.slug)) return true;
  if (bp.acr && (glossarySlug(bp.acr) === a.slug || glossarySlug(bp.title) === a.slug)) return true;
  return false;
}

function absorbEntry(keep, other) {
  if (other.title && other.title !== keep.title) addAlias(keep, other.title);
  for (const al of other.also || []) addAlias(keep, al);
  if (other.acr && !keep.acr) keep.acr = other.acr;
  for (const s of other.senses || []) {
    addSense(keep, {
      branch: s.branch,
      branchTitle: s.branchTitle,
      sectionId: s.sectionId,
      sectionTitle: s.sectionTitle,
      expand: s.expand,
      def: s.def,
      topics: s.topics,
      glossaries: s.glossaries,
    });
  }
}

function preferredEntry(a, b) {
  // Prefer a short acronym or symbol title when the other is a long expansion.
  const aAcr = !!(a.acr || looksLikeAcronym(a.title));
  const bAcr = !!(b.acr || looksLikeAcronym(b.title));
  if (aAcr && !bAcr) return a;
  if (bAcr && !aAcr) return b;
  if ((a.senses || []).length !== (b.senses || []).length) {
    return (a.senses || []).length >= (b.senses || []).length ? a : b;
  }
  return (a.title || "").length <= (b.title || "").length ? a : b;
}

function mergeDuplicateEntries() {
  const buckets = new Map();
  const put = (key, e) => {
    if (!key) return;
    if (!buckets.has(key)) buckets.set(key, new Set());
    buckets.get(key).add(e);
  };
  for (const e of catalog.entries) {
    put("s:" + e.slug, e);
    const ft = foldTitle(e.title);
    if (ft) put("f:" + ft, e);
    if (isCommandHelpTitle(e)) put("cmdhelp", e);
    if (e.acr) put("a:" + glossarySlug(e.acr), e);
    const parsed = parseTerm(e.title);
    if (parsed.acr) put("a:" + glossarySlug(parsed.acr), e);
  }
  for (const set of buckets.values()) {
    const arr = [...set];
    if (arr.length < 2) continue;
    let keep = arr[0];
    for (let i = 1; i < arr.length; i++) {
      const other = arr[i];
      if (keep === other) continue;
      if (catalog.bySlug.get(keep.slug) !== keep) {
        keep = other;
        continue;
      }
      if (catalog.bySlug.get(other.slug) !== other) continue;
      if (!shouldMergeEntries(keep, other)) continue;
      const pref = preferredEntry(keep, other);
      const drop = pref === keep ? other : keep;
      keep = pref;
      absorbEntry(keep, drop);
      catalog.entries = catalog.entries.filter((x) => x !== drop);
      catalog.bySlug.delete(drop.slug);
      catalog.bySlug.set(keep.slug, keep);
    }
  }
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
        const aliases = [...(parsed.aliases || [])];
        if (parsed.phrase) aliases.push(parsed.phrase);
        const entry = upsertEntry(parsed.acr ? prettyAcr(parsed.acr, parsed.title) : parsed.title, parsed.acr, aliases);
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

  mergeDuplicateEntries();

  // Tidy also-known-as, merge duplicate senses, and sort
  for (const e of catalog.entries) {
    e.also = (e.also || []).filter((a) => aliasBelongs(e, a)).slice(0, 6);
    e.senses = mergeSenses(e.senses);
    e.senses.sort((a, b) => (a.branchTitle || a.branch).localeCompare(b.branchTitle || b.branch) || (a.expand || "").localeCompare(b.expand || ""));
  }
  catalog.entries.sort((a, b) => a.letter.localeCompare(b.letter) || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
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
    for (const el of body.querySelectorAll(".gloss-def")) {
      const article = el.closest(".gloss-entry");
      const entry = article ? getGlossaryEntry(article.getAttribute("data-slug") || "") : null;
      const skip = [];
      if (entry) {
        skip.push(entry.title, entry.acr, ...(entry.also || []));
        for (const s of entry.senses || []) if (s.expand) skip.push(s.expand);
      }
      wrapPanelAbbrs(el, branch || "", { skip });
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
