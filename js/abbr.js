/**
 * In-memory acronym map and accessible tooltips.
 * Built after decrypt from glossaries and keyTerms. Never shipped as plaintext data.
 */

const GENERIC = new Set([
  "ID", "IT", "OR", "AN", "BE", "DO", "IF", "NO", "OK", "SO", "TO", "US", "UK",
  "EU", "AM", "PM", "TV", "HR", "CEO", "CFO", "CTO", "THE", "AND", "FOR", "NOT",
]);

/**
 * Units and product / exam family codes. Harvested or not, these are not
 * wrapped as acronyms. Genuine initialisms such as SKU are not listed here.
 */
const UNIT_OR_PRODUCT = new Set([
  "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB",
  "KIB", "MIB", "GIB", "TIB", "PIB",
  "BIT", "KBIT",
  "HZ", "KHZ", "MHZ", "GHZ", "THZ",
  "BPS", "KBPS", "MBPS", "GBPS", "TBPS",
  "DB", "DBM", "DBI", "DBA", "DBW", "DBUV",
  "RPM", "FPS", "DPI", "PPI", "SPI",
  "MAH", "WH", "KWH", "VA", "KVA",
  // Ampere-hour is normally written "Ah". Uppercase "AH" is Authentication
  // Header; wrapping is case-sensitive so "Ah" / "mAh" stay unwrapped.
  "NM", "MM", "CM", "KM", "KG", "MG",
  "MS", "NS", "PS",
  "SY0", "XK0", "PT0", "PK0", "CS0", "N10", "N10-009",
  "220-1201", "220-1202", "220-1101", "220-1102",
  "H100", "H200", "B200", "A100", "A10",
  "RTX", "GTX",
  "II", "III", "IV", "VI", "VII", "VIII", "IX",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XIX", "XX", "XXI",
]);

/**
 * Conventional short expansions used when harvest yields a sentence rather
 * than the official name. Applied only to the in-memory map — never shipped
 * as a plaintext glossary file.
 */
const OFFICIAL_EXPAND = {
  RSA: "Rivest–Shamir–Adleman",
  AH: "Authentication Header",
  TPID: "Tag Protocol Identifier",
  VID: "VLAN Identifier",
};

/** Token as it appears in a term title (paren or bare). */
const ACR_TOKEN = String.raw`(?:Wi-Fi(?:\s*6E|\s*6|\s*7|\s*5|\s*4)?|WiFi(?:\s*6E|\s*6|\s*7|\s*5|\s*4)?|OAuth(?:\s*2\.0)?|DDoS|ATT&CK|SD-WAN|WS-Federation|LLDP-MED|VT-x|IPv[46]|802\.\d{1,2}[A-Za-z]{0,3}|CSMA\/C[AD]|TACACS\+|SHA-?\d{1,3}|MD5|3DES|NVMe|QoS|PoE|IPsec|IPSec|PCIe|PCI-E|[A-Z][A-Z0-9]{1,8}\+?|[A-Z]{2,8}\/[A-Z]{2,6}|[A-Z]{2,8}-[A-Z0-9]{1,8})`;

let index = {
  /** @type {Map<string, {expand: string, branch: string, src: string}[]>} */
  byAcr: new Map(),
  /** @type {RegExp|null} */
  re: null,
  /** @type {Map<string, string>} */
  surfaceToKey: new Map(),
  /** @type {Map<string, Set<string>>} */
  extraSurfaces: new Map(),
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

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Canonical map key for a surface form.
 * CIDR→CIDR, IPv4→IPV4, QoS→QOS, Wi-Fi 6E→WIFI-6E, 802.1X→802.1X,
 * CSMA/CA→CSMA/CA, TACACS+→TACACS+, SHA-256→SHA-256, NVMe→NVME.
 */
export function canonicalAbbrKey(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  const wifi = raw.match(/^wi-?fi(?:\s*(6e|6|7|5|4))?$/i);
  if (wifi) return wifi[1] ? `WIFI-${wifi[1].toUpperCase()}` : "WIFI";
  const oauth = raw.match(/^oauth(?:\s*2(?:\.0)?)?$/i);
  if (oauth) return /2/.test(raw) ? "OAUTH-2" : "OAUTH";
  if (/^ddos$/i.test(raw)) return "DDOS";
  if (/^att&ck$/i.test(raw)) return "ATT&CK";
  if (/^sd-wan$/i.test(raw)) return "SD-WAN";
  if (/^ws-federation$/i.test(raw)) return "WS-FEDERATION";
  if (/^lldp-med$/i.test(raw)) return "LLDP-MED";
  if (/^vt-x$/i.test(raw)) return "VT-X";
  const ipv = raw.match(/^ipv([46])$/i);
  if (ipv) return `IPV${ipv[1]}`;
  const ieee = raw.match(/^(802\.\d{1,2}[A-Za-z]{0,3})$/i);
  if (ieee) return ieee[1].toUpperCase();
  const sha = raw.match(/^(SHA)-?(\d{1,3})$/i);
  if (sha) return `SHA-${sha[2]}`;
  if (/^pci-?e$/i.test(raw)) return "PCIE";
  if (/^ipsec$/i.test(raw)) return "IPSEC";
  if (/^nvme$/i.test(raw)) return "NVME";
  return raw.toUpperCase();
}

function allowedKey(key) {
  if (!key || GENERIC.has(key) || UNIT_OR_PRODUCT.has(key)) return false;
  if (/^[A-Z][A-Z0-9]{1,8}$/.test(key)) return true;
  if (/^[A-Z][A-Z0-9]{1,8}\+$/.test(key)) return true;
  if (/^[A-Z]{2,8}\/[A-Z]{2,4}$/.test(key)) return true;
  if (/^802\.\d{1,2}[A-Z]{0,3}$/.test(key)) return true;
  if (/^IPV[46]$/.test(key)) return true;
  if (/^WIFI(?:-6E|-6|-7|-5|-4)?$/.test(key)) return true;
  if (/^SHA-\d{1,3}$/.test(key)) return true;
  if (key === "3DES") return true;
  if (key === "ATT&CK") return true;
  if (/^[A-Z]{2,8}-[A-Z0-9]{1,12}$/.test(key)) return true;
  if (key === "WS-FEDERATION") return true;
  if (/^[A-Z]{2,8}\/[A-Z]{2,6}$/.test(key)) return true;
  if (key === "PCIE" || key === "NVME" || key === "IPSEC") return true;
  return false;
}

function surfacesFor(key) {
  const set = new Set();
  const extras = index.extraSurfaces?.get(key);
  if (extras) {
    for (const s of extras) {
      // Ampere-hour is written Ah; only the all-caps Authentication Header surface wraps.
      if (key === "AH" && s !== "AH") continue;
      set.add(s);
    }
  }
  if (key === "OAUTH") {
    set.add("OAuth"); set.add("OAUTH");
  } else if (key === "OAUTH-2") {
    set.add("OAuth 2.0"); set.add("OAuth2"); set.add("OAUTH 2.0");
  } else if (key === "DDOS") {
    set.add("DDoS"); set.add("DDOS");
  } else if (key === "ATT&CK") {
    set.add("ATT&CK");
  } else if (key === "SD-WAN") {
    set.add("SD-WAN");
  } else if (key === "WS-FEDERATION") {
    set.add("WS-Federation"); set.add("WS-FEDERATION");
  } else if (key === "LLDP-MED") {
    set.add("LLDP-MED");
  } else if (key === "VT-X") {
    set.add("VT-x"); set.add("VT-X");
  } else if (key === "ISCSI") {
    set.add("iSCSI"); set.add("ISCSI");
  } else if (key === "ESIM") {
    set.add("eSIM"); set.add("ESIM");
  } else if (key === "IAAS") {
    set.add("IaaS"); set.add("IAAS");
  } else if (key === "PAAS") {
    set.add("PaaS"); set.add("PAAS");
  } else if (key === "SAAS") {
    set.add("SaaS"); set.add("SAAS");
  } else if (key === "WIFI") {
    set.add("Wi-Fi"); set.add("WiFi"); set.add("WIFI");
  } else if (key === "WIFI-6") {
    set.add("Wi-Fi 6"); set.add("WiFi 6");
  } else if (key === "WIFI-6E") {
    set.add("Wi-Fi 6E"); set.add("WiFi 6E");
  } else if (key === "WIFI-7") {
    set.add("Wi-Fi 7"); set.add("WiFi 7");
  } else if (key === "WIFI-5") {
    set.add("Wi-Fi 5"); set.add("WiFi 5");
  } else if (key === "WIFI-4") {
    set.add("Wi-Fi 4"); set.add("WiFi 4");
  } else if (key === "IPV4") {
    set.add("IPv4"); set.add("IPV4");
  } else if (key === "IPV6") {
    set.add("IPv6"); set.add("IPV6");
  } else if (key === "QOS") {
    set.add("QoS"); set.add("QOS");
  } else if (key === "POE") {
    set.add("PoE"); set.add("POE");
  } else if (key === "IPSEC") {
    set.add("IPsec"); set.add("IPSec"); set.add("IPSEC");
  } else if (key === "NVME") {
    set.add("NVMe"); set.add("NVME");
  } else if (key === "AH") {
    set.add("AH");
  } else if (key === "PCIE") {
    set.add("PCIe"); set.add("PCI-E"); set.add("PCIE");
  } else if (key === "802.1X") {
    set.add("802.1X"); set.add("802.1x");
  } else if (/^802\.\d+[A-Z]+$/.test(key)) {
    set.add(key);
    set.add(key.replace(/[A-Z]+$/, (s) => s.toLowerCase()));
  } else if (key.startsWith("SHA-")) {
    set.add(key);
    set.add(key.replace("-", ""));
  } else {
    set.add(key);
  }
  return [...set];
}

function stripSelfRef(acr, expand) {
  let e = normExpand(expand);
  if (!e) return "";
  const key = canonicalAbbrKey(acr) || String(acr).toUpperCase();
  const surfaces = [key, acr, ...surfacesFor(key)].map(escapeRe);
  const alt = [...new Set(surfaces)].join("|");
  const trail = e.match(new RegExp(`^(.*?)\\s*\\((?:${alt})\\)\\s*$`, "i"));
  if (trail && trail[1].trim()) e = trail[1].trim();
  const lead = e.match(new RegExp(`^(?:${alt})\\s+\\((.+)\\)\\s*$`, "i"));
  if (lead) e = lead[1].trim();
  e = e.replace(new RegExp(`^(?:${alt})\\s+[—–-]\\s+`, "i"), "");
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
    if (!k || k === canonicalAbbrKey(acr).toLowerCase() || k === String(acr).toLowerCase() || seen.has(k)) continue;
    seen.add(k);
    cleaned.push(e);
  }
  if (!cleaned.length) return [];
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
  // Prefer a conventional initialism expansion (Rivest–Shamir–Adleman for RSA)
  // over a harvested sentence that happens to start with a capital letter.
  const initial = kept.filter((e) => looksLikeExpansion(acr, e));
  const formal = kept.filter((e) => /^[A-Z]/.test(e) && /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(e) && !/\b(?:is|are|then)\b/.test(e));
  const pool = initial.length ? initial : formal.length ? formal : kept;
  const long = pool.filter((e) => e.split(/\s+/).length >= 3);
  return long.length ? long : pool;
}

function shortDef(def) {
  const d = normExpand(def);
  if (!d) return "";
  const named = d.match(/^([A-Z][^—–.(:]{2,90}?)(?:\s+[—–-]\s+|\s+\(|:\s|\.\s|$)/);
  if (named && isPhrase(named[1].trim())) return named[1].trim();
  const first = d.split(/(?<=\.)\s/)[0];
  if (isPhrase(first)) return first;
  const clause = d.split(/:\s/)[0];
  if (isPhrase(clause)) return clause;
  return first.length <= 110 ? first : first.slice(0, 110).replace(/\s+\S*$/, "");
}


function wordInitials(phrase) {
  const parts = String(phrase || "").split(/[\s\/]+/).filter(Boolean);
  const inits = [];
  for (const p of parts) {
    const cleaned = p.replace(/[(),.:]/g, "");
    if (!cleaned) continue;
    if (/^[A-Z]{2,8}(?:[+\-][A-Z0-9]+)?$/.test(cleaned)) inits.push(cleaned);
    else if (/[-–—]/.test(cleaned) && /[A-Za-z]/.test(cleaned)) {
      for (const h of cleaned.split(/[-–—]/).filter(Boolean)) {
        if (/^\d+$/.test(h)) inits.push(h);
        else inits.push(h[0].toUpperCase());
      }
    } else if (/^\d+$/.test(cleaned) || /version/i.test(cleaned) && false) {
      inits.push(cleaned);
    } else if (/^v(?:ersion)?$/i.test(cleaned)) {
      inits.push("V");
    } else if (/^\d+[A-Za-z]+$/.test(cleaned)) {
      inits.push(cleaned.toUpperCase());
    } else {
      inits.push(cleaned[0].toUpperCase());
    }
  }
  return inits.join("");
}

function looksLikeExpansion(acr, phrase) {
  const key = canonicalAbbrKey(acr).replace(/[^A-Z0-9]/g, "");
  if (!key || !phrase) return false;
  const full = wordInitials(phrase).replace(/[^A-Z0-9]/g, "");
  if (full === key) return true;
  const skip = /^(OF|THE|AND|A|AN|FOR|IN|ON|TO|OR|WITH|BY|FROM|OVER)$/;
  const parts = String(phrase).split(/[\s\/]+/).filter((w) => w && !skip.test(w.replace(/[(),.:]/g, "").toUpperCase()));
  const skipped = wordInitials(parts.join(" ")).replace(/[^A-Z0-9]/g, "");
  if (skipped === key) return true;
  // Quality of Service: include OF as O
  const withSmall = wordInitials(phrase).replace(/[^A-Z0-9]/g, "");
  if (withSmall === key) return true;
  return false;
}

function harvestFromTerm(term, def, branch, src) {
  const t = String(term || "").trim();
  if (!t) return;
  const add = (acr, expand, prefer) => {
    const key = canonicalAbbrKey(acr);
    if (!allowedKey(key)) return;
    const ex = stripSelfRef(key, expand);
    if (!isPhrase(ex) || canonicalAbbrKey(ex) === key || ex.toUpperCase() === key) return;
    const list = index.byAcr.get(key) || [];
    list.push({ expand: ex, branch: branch || "", src: src || "", prefer: !!prefer });
    index.byAcr.set(key, list);
    const surface = String(acr || "").trim();
    if (surface && surface !== key) {
      const set = index.extraSurfaces.get(key) || new Set();
      set.add(surface);
      index.extraSurfaces.set(key, set);
    }
  };

  const tokenRe = new RegExp(`(${ACR_TOKEN})`, "g");

  // "Intrusion Detection System (IDS)" or "IPv4 (Internet Protocol version 4)".
  const phraseThenAcr = new RegExp(
    "([A-Za-z][A-Za-z0-9 +/,.&'\u2013\u2014\u2019-]{1,100}?)\\s+\\((" + ACR_TOKEN + "(?:\\s*/\\s*" + ACR_TOKEN + ")*)\\)",
    "g"
  );
  for (const m of t.matchAll(phraseThenAcr)) {
    const phrase = m[1].trim();
    const inside = m[2].trim();
    if (/^[A-Z][A-Z0-9]{1,8}$/.test(phrase) && !inside.includes("/")) continue;
    if (!inside.includes("/")) {
      // Glossary titles are curated; keyTerms may use "(ACR)" as a topic tag, so require initials there.
      const lastSeg = phrase.split(/\s\/\s/).pop().trim();
      const trustGloss = src === "glossary" && !/\s\/\s/.test(phrase);
      if (looksLikeExpansion(inside, phrase) || trustGloss) add(inside, phrase, true);
      else if (lastSeg !== phrase && (looksLikeExpansion(inside, lastSeg) || src === "glossary")) add(inside, lastSeg, true);
    } else {
      // Combined keys such as RTO/RPO, IDS/IPS from a glossary title.
      if (src === "glossary") add(inside, phrase, true);
      for (const part of inside.split(/\s*\/\s*/)) {
        if (looksLikeExpansion(part, phrase)) add(part, phrase, false);
      }
    }
  }

  // "IDS (Intrusion Detection System)", "CSMA/CA (Carrier Sense …)".
  const acrThenPhrase = new RegExp(`(?:^|[^A-Za-z0-9/])(${ACR_TOKEN})\\s+\\(([^)]+)\\)`, "g");
  for (const m of t.matchAll(acrThenPhrase)) {
    const inside = m[2].trim();
    if (inside && !/^[A-Z][A-Z0-9/ .]{1,40}$/.test(inside)) add(m[1], inside, true);
  }

  // "OSI model (Open Systems Interconnection)".
  const acrNamePhrase = t.match(new RegExp(
    `^(${ACR_TOKEN})\\s+[A-Za-z][A-Za-z0-9 +/'’.\\-]{0,60}\\s+\\(([^)]+)\\)$`
  ));
  if (acrNamePhrase && (looksLikeExpansion(acrNamePhrase[1], acrNamePhrase[2]) || src === "glossary")) {
    add(acrNamePhrase[1], acrNamePhrase[2], true);
  }

  // Bare "CISSP", "802.1X", "HPA axis": official name at the start of the definition.
  const bare = t.match(new RegExp(`^(${ACR_TOKEN})(?:\\s+axis|\\s+address|\\s+record)?$`, "i"));
  if (bare) {
    add(bare[1], shortDef(def) || def, src === "glossary");
  }

  // "PCI DSS" / "Payment Card Industry Data Security Standards (PCI DSS)"
  for (const m of t.matchAll(/\(([A-Z][A-Z0-9]{1,7})(?:\s+[A-Z][A-Z0-9]{1,7})+\)/g)) {
    const phrase = t.replace(m[0], "").replace(/[()]/g, "").trim();
    if (phrase) add(m[1], phrase, true);
  }

  const compound = t.match(/^([A-Z][A-Z0-9]{1,7})\s+[A-Z][A-Z0-9]/);
  if (compound && !t.includes("(")) {
    const named = shortDef(def);
    if (named && looksLikeExpansion(compound[1], named)) add(compound[1], named, src === "glossary");
  }

  // "802.11 / 802.11a/b/g/n/ac/ax/be"
  if (/^802\.11\s*\/\s*802\.11/.test(t)) {
    add("802.11", "IEEE 802.11 wireless LAN family", true);
  }

  // Combined marketing names: "Wi-Fi 4 / 5 / 6 / 6E / 7".
  if (/^wi-?fi\s*4\s*\/\s*5\s*\/\s*6\s*\/\s*6E\s*\/\s*7$/i.test(t)) {
    add("Wi-Fi", "IEEE 802.11 wireless networking (Wi-Fi Alliance trademark)", true);
    add("Wi-Fi 4", "IEEE 802.11n (Wi-Fi Alliance marketing name)", true);
    add("Wi-Fi 5", "IEEE 802.11ac (Wi-Fi Alliance marketing name)", true);
    add("Wi-Fi 6", "IEEE 802.11ax (Wi-Fi Alliance marketing name)", true);
    add("Wi-Fi 6E", "IEEE 802.11ax in the 6 GHz band (Wi-Fi Alliance marketing name)", true);
    add("Wi-Fi 7", "IEEE 802.11be (Wi-Fi Alliance marketing name)", true);
  }



  // Fallback: any leftover parenthesised or leading token already handled.
  void tokenRe;
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

function applyOfficialExpands() {
  for (const [raw, expand] of Object.entries(OFFICIAL_EXPAND)) {
    const key = canonicalAbbrKey(raw);
    if (!allowedKey(key) || !expand) continue;
    const list = index.byAcr.get(key) || [];
    const wanted = normExpand(expand);
    const branches = new Set(list.map((r) => r.branch || ""));
    if (!branches.size) branches.add("");
    // resolveAbbr prefers a branch-local sense, so the official name must
    // be present on each branch that already has a row, not only globally.
    for (const branch of branches) {
      const already = list.find((r) => normExpand(r.expand) === wanted && (r.branch || "") === branch);
      if (already) already.prefer = true;
      else list.unshift({ expand: wanted, branch, src: "official", prefer: true });
    }
    index.byAcr.set(key, list);
  }
}

function compile() {
  applyOfficialExpands();
  const forms = [];
  index.surfaceToKey = new Map();
  for (const key of index.byAcr.keys()) {
    for (const s of surfacesFor(key)) {
      forms.push(s);
      if (!index.surfaceToKey.has(s)) index.surfaceToKey.set(s, key);
    }
  }
  if (!forms.length) {
    index.re = null;
    return;
  }
  forms.sort((a, b) => b.length - a.length || a.localeCompare(b));
  const alt = forms.map(escapeRe).join("|");
  // Allow sentence punctuation after a token ("AES.") but do not split dotted
  // identifiers such as 802.11 or AES.GCM.
  index.re = new RegExp(`(?<![A-Za-z0-9&])(${alt})s?(?![A-Za-z0-9&\u2080-\u2089])(?!\\.[A-Za-z0-9])`, "g");
}

/**
 * Build the acronym map from the decrypted index.
 * @param {{ byId: Map<string, any> }} nodeIndex
 * @param {{ nodeBranch?: Map<string, string>, subjects?: { slug: string, rootId: string }[] }} ctx
 */
export function buildAbbrIndex(nodeIndex, ctx = {}) {
  index = { byAcr: new Map(), re: null, surfaceToKey: new Map(), extraSurfaces: new Map() };
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
  addEthernetAlias(nodeIndex, branchOf);
  compile();
  return { size: index.byAcr.size };
}

/**
 * If a glossary lists Ethernet, accept the diagram short form "Eth".
 * The expansion is the glossary definition, not the word "Ethernet" itself.
 */
function addEthernetAlias(nodeIndex, branchOf) {
  if (!nodeIndex?.byId) return;
  for (const [id, node] of nodeIndex.byId) {
    if (!isGlossNode(node)) continue;
    const branch = typeof branchOf === "function" ? branchOf(id) : "";
    for (const [term, def] of glossTerms(node.expanded)) {
      if (!/^ethernet\b/i.test(String(term).trim())) continue;
      const key = "ETHERNET";
      if (!allowedKey(key)) continue;
      const ex = shortDef(def);
      if (!isPhrase(ex) || ex.toUpperCase() === key || canonicalAbbrKey(ex) === key) continue;
      const list = index.byAcr.get(key) || [];
      list.push({ expand: ex, branch: branch || "", src: "glossary", prefer: true });
      index.byAcr.set(key, list);
      const set = index.extraSurfaces.get(key) || new Set();
      set.add("Eth");
      index.extraSurfaces.set(key, set);
    }
  }
}

export function hydrateAbbrIndex(payload) {
  index = { byAcr: new Map(), re: null, surfaceToKey: new Map(), extraSurfaces: new Map() };
  for (const [key, rows] of Object.entries(payload?.byAcr || {})) {
    index.byAcr.set(key, rows);
  }
  for (const [key, arr] of Object.entries(payload?.extraSurfaces || {})) {
    index.extraSurfaces.set(key, new Set(arr));
  }
  compile();
  return { size: index.byAcr.size };
}

export function serializeAbbrIndex() {
  return {
    byAcr: Object.fromEntries([...index.byAcr]),
    extraSurfaces: Object.fromEntries([...index.extraSurfaces].map(([k, v]) => [k, [...v]])),
  };
}

export function setAbbrIndex(built) {
  // buildAbbrIndex already stored the map; this exists for a clear call site.
  return built;
}

export function abbrStats() {
  return { size: index.byAcr.size };
}

export function listAbbrKeys() {
  return [...index.byAcr.keys()].sort();
}

export function abbrSkipList() {
  return {
    generic: [...GENERIC].sort(),
    unitsAndProductCodes: [...UNIT_OR_PRODUCT].sort(),
  };
}

/**
 * Resolve an expansion for this branch. If two senses exist here, show both.
 * If this branch has none and other branches disagree, skip (return "").
 */
export function abbrSenses(acr) {
  const key = canonicalAbbrKey(acr);
  return index.byAcr.get(key) || [];
}

let glossaryOpener = null;
export function setGlossaryOpener(fn) {
  glossaryOpener = typeof fn === "function" ? fn : null;
}

export function glossarySlugFor(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "term";
}

export function resolveAbbr(acr, branch) {
  const surface = String(acr || "").trim();
  const key = index.surfaceToKey.get(surface) || canonicalAbbrKey(acr);
  if (!allowedKey(key)) return "";
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
  "SVG", "TITLE", "DESC", "TEXT", "TSPAN", "PATH", "G", "RECT", "LINE",
  "POLYGON", "POLYLINE", "CIRCLE", "ELLIPSE", "MARKER", "DEFS", "USE",
]);

function skipNode(node, root) {
  let el = node.nodeType === 3 ? node.parentElement : node;
  while (el && el !== root) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.closest && el.closest("svg")) return true;
    if (el.isContentEditable) return true;
    const cl = el.classList;
    if (cl && (cl.contains("term-run") || cl.contains("key-terms") || cl.contains("jump-bar") || cl.contains("crumbs"))) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Wrap every occurrence of a known acronym in a subtree.
 * Skips code, links, headings, glossary term lists, and key-term runs.
 */
function glossaryHref(key, branch) {
  const s = glossarySlugFor(key);
  const b = String(branch || "").trim();
  return b ? `#/glossary/${encodeURIComponent(s)}/${encodeURIComponent(b)}` : `#/glossary/${encodeURIComponent(s)}`;
}

/**
 * Case-sensitive surface gate. Uppercase AH is Authentication Header;
 * mixed-case Ah (ampere-hour) must not wrap even if a harvest added it.
 */
function surfacePermitted(surface, key) {
  if (key === "AH") return surface === "AH";
  return true;
}

export function wrapPanelAbbrs(root, branch, opts = {}) {
  if (!root || !index.re) return 0;
  const skip = new Set((opts.skip || []).filter(Boolean).map((s) => String(s).toLowerCase()));
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
      const key = index.surfaceToKey.get(raw) || canonicalAbbrKey(raw);
      const expand = resolveAbbr(key, branch);
      if (!expand) continue;
      if (!surfacePermitted(raw, key)) continue;
      const forms = [raw, m[0], key, expand];
      if (forms.some((f) => f && skip.has(String(f).toLowerCase()))) continue;
      changed = true;
      pieces.push(document.createTextNode(text.slice(last, m.index)));
      const abbr = document.createElement("a");
      abbr.className = "kc-abbr";
      abbr.setAttribute("href", glossaryHref(key, branch));
      abbr.setAttribute("data-acr", key);
      abbr.setAttribute("data-branch", branch || "");
      abbr.setAttribute("data-expand", expand);
      abbr.setAttribute("aria-label", `${m[0]}, ${expand}. Open in the glossary.`);
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
  wrapped += wrapSvgAbbrs(root, branch, skip);
  return wrapped;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function makeSvgAbbr(surface, key, expand, branch) {
  const a = document.createElementNS(SVG_NS, "a");
  a.setAttribute("href", glossaryHref(key, branch));
  a.setAttribute("class", "kc-abbr");
  a.setAttribute("data-acr", key);
  a.setAttribute("data-branch", branch || "");
  a.setAttribute("data-expand", expand);
  a.setAttribute("tabindex", "0");
  a.setAttribute("role", "link");
  a.setAttribute("aria-label", `${surface}, ${expand}. Open in the glossary.`);
  const tspan = document.createElementNS(SVG_NS, "tspan");
  tspan.textContent = surface;
  a.appendChild(tspan);
  return a;
}

/**
 * SVG diagrams only: wrap real acronyms/abbreviations, not ordinary words.
 * All-caps or mixed-case abbreviation tokens that are in the map, plus Eth.
 * Title-case or lowercase words such as Segment, Packet, Frame, Data,
 * Network, or Bits are left alone. Prose wrapping is unchanged.
 */
export function isDiagramAbbrSurface(surface, key, expand) {
  const raw = String(surface || "").trim();
  if (!raw) return false;
  if (/^Eth$/.test(raw)) return true;

  // Typographic abbreviations: TCP/IP, 802.1X, SHA-256, TACACS+, Wi-Fi.
  if (/[0-9]/.test(raw) || /[\/+]/.test(raw) || /[A-Za-z0-9]-[A-Za-z0-9]/.test(raw)) return true;

  // Title Case ordinary words (Segment, Packet, Network). "Eth" already allowed.
  if (/^[A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*$/.test(raw)) return false;
  if (/^[a-z][a-z'’-]*$/.test(raw)) return false;

  // Mixed-case abbreviations that are not Title Case: IPv4, IPsec, eSIM, PoE, QoS.
  if (/[a-z]/.test(raw) && /[A-Z]/.test(raw)) return true;

  const core = /s$/.test(raw) && raw.length > 2 ? raw.slice(0, -1) : raw;
  const rows = index.byAcr.get(key) || [];
  const senses = [expand, ...rows.map((r) => r.expand)].filter(Boolean);
  const asInitialism = senses.some((ex) =>
    looksLikeExpansion(key, ex) || looksLikeExpansion(core, ex) || looksLikeExpansion(raw, ex)
  );

  // ALL-CAPS (optional trailing plural s, e.g. MACs, IPs).
  // Wrap initialisms and official short names (HTTP, even when "Hypertext"
  // does not yield four initials). Leave ordinary words (SEGMENT, FRAME).
  if (/^[A-Z][A-Z0-9]{0,8}$/.test(core) || /^[A-Z][A-Z0-9]{0,8}\+$/.test(core)) {
    if (asInitialism) return true;
    const official = senses.some((ex) => {
      const s = String(ex || "").trim();
      if (/^(the|a|an)\s/i.test(s)) return false;
      const words = s.split(/\s+/).filter(Boolean);
      const caps = words.filter((w) => /^[A-Z]/.test(w)).length;
      return words.length >= 2 && caps >= 2;
    });
    if (official) return true;
    // Single-word official expansions of short acronyms (SYN → Synchronise,
    // ACK → Acknowledgement). Ordinary words whose glossary sense is a
    // sentence starting with The/A/An (SEGMENT, FRAME, NETWORK) stay unwrapped.
    const officialWord = senses.some((ex) => {
      const s = String(ex || "").trim().split(/\s*·\s*/)[0].trim();
      if (/^(the|a|an)\s/i.test(s)) return false;
      const words = s.split(/\s+/).filter(Boolean);
      return words.length === 1 && /^[A-Z]/.test(words[0]) && words[0].length > core.length;
    });
    if (officialWord) return true;
    return false;
  }
  return false;
}

function matchAbbrPieces(text, branch, skip) {
  if (!text || !index.re) return null;
  index.re.lastIndex = 0;
  const pieces = [];
  let last = 0;
  let changed = false;
  let m;
  let count = 0;
  while ((m = index.re.exec(text))) {
    const raw = m[1];
    const key = index.surfaceToKey.get(raw) || canonicalAbbrKey(raw);
    const expand = resolveAbbr(key, branch);
    if (!expand) continue;
    if (!surfacePermitted(raw, key)) continue;
    if (!isDiagramAbbrSurface(m[0], key, expand)) continue;
    // Do not split hyphenated compounds (SYN-SENT, SYN-RECEIVED).
    const prev = m.index > 0 ? text[m.index - 1] : "";
    const nextCh = text[m.index + m[0].length] || "";
    if (/[A-Za-z0-9-]/.test(prev) || /[A-Za-z0-9-]/.test(nextCh)) continue;
    const forms = [raw, m[0], key, expand];
    if (forms.some((f) => f && skip.has(String(f).toLowerCase()))) continue;
    changed = true;
    if (m.index > last) pieces.push({ type: "text", value: text.slice(last, m.index) });
    pieces.push({ type: "abbr", surface: m[0], key, expand });
    last = m.index + m[0].length;
    count++;
  }
  if (!changed) return null;
  if (last < text.length) pieces.push({ type: "text", value: text.slice(last) });
  return { pieces, count };
}

/**
 * Wrap abbreviation tokens in SVG <text> / <tspan> after render.
 * Uses SVG <a> (no handlers in content). Layout is preserved.
 */
function wrapSvgAbbrs(root, branch, skip) {
  if (!root || !index.re || typeof root.querySelectorAll !== "function") return 0;
  const svgs = root.matches?.("svg") ? [root] : [...root.querySelectorAll("svg")];
  let wrapped = 0;
  for (const svg of svgs) {
    const els = [...svg.querySelectorAll("text, tspan")];
    for (const el of els) {
      if (el.closest("a.kc-abbr, title, desc, defs")) continue;
      const direct = [...el.childNodes];
      const onlyText = direct.length === 1 && direct[0].nodeType === 3;
      if (onlyText && el.tagName.toLowerCase() === "text") {
        const found = matchAbbrPieces(direct[0].nodeValue, branch, skip);
        if (!found) continue;
        if (found.pieces.length === 1 && found.pieces[0].type === "abbr") {
          const p = found.pieces[0];
          const a = makeSvgAbbr(p.surface, p.key, p.expand, branch);
          // Keep the original <text> (and its x/y/class) inside the link.
          a.removeChild(a.firstChild);
          el.parentNode.insertBefore(a, el);
          a.appendChild(el);
          wrapped += found.count;
          continue;
        }
      }
      const textNodes = direct.filter((n) => n.nodeType === 3 && n.nodeValue);
      for (const textNode of textNodes) {
        const found = matchAbbrPieces(textNode.nodeValue, branch, skip);
        if (!found) continue;
        const frag = document.createDocumentFragment();
        for (const p of found.pieces) {
          if (p.type === "text") frag.appendChild(document.createTextNode(p.value));
          else frag.appendChild(makeSvgAbbr(p.surface, p.key, p.expand, branch));
        }
        textNode.parentNode.insertBefore(frag, textNode);
        textNode.parentNode.removeChild(textNode);
        wrapped += found.count;
      }
    }
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

function fillTip(anchor, expand) {
  const tip = tipEl();
  tip.innerHTML = "";
  const text = document.createElement("div");
  text.className = "kc-abbr-tip-text";
  text.textContent = expand;
  tip.appendChild(text);
  const href = anchor.getAttribute("href") || glossaryHref(anchor.getAttribute("data-acr"), anchor.getAttribute("data-branch"));
  if (href) {
    const link = document.createElement("a");
    link.className = "kc-abbr-tip-link";
    link.href = href;
    link.textContent = "Glossary →";
    link.setAttribute("data-act", "glossary-from-tip");
    tip.appendChild(link);
  }
}

function placeTip(anchor) {
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
}

function showTip(anchor, { pin = false } = {}) {
  clearTimeout(hideTimer);
  const expand = anchor.getAttribute("data-expand") || "";
  if (!expand) return;
  tipOwner = anchor;
  if (pin) tipPinned = true;
  const tip = tipEl();
  const id = "kc-abbr-tip";
  anchor.setAttribute("aria-describedby", id);
  fillTip(anchor, expand);
  placeTip(anchor);
  tip.hidden = false;
}

function hideTip() {
  clearTimeout(hideTimer);
  const tip = tipEl();
  tip.hidden = true;
  tip.innerHTML = "";
  if (tipOwner) tipOwner.removeAttribute("aria-describedby");
  tipOwner = null;
  tipPinned = false;
  lastTouchOpen = null;
}

function hideTipSoon() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideTip, 280);
}

function closestAbbr(el) {
  return el?.closest?.("a.kc-abbr, abbr.kc-abbr") || null;
}

function openGlossaryFrom(anchor) {
  if (!anchor) return;
  const payload = {
    key: anchor.getAttribute("data-acr") || "",
    branch: anchor.getAttribute("data-branch") || "",
    href: anchor.getAttribute("href") || "",
  };
  if (glossaryOpener) glossaryOpener(payload);
  else if (payload.href) location.hash = payload.href.replace(/^#/, "#");
}

let lastPointerType = "mouse";
let lastTouchOpen = null;
let tipPinned = false;

/** Bind once. Hover, focus and tap; Escape and scroll close. */
export function bindAbbrTooltips() {
  if (document.documentElement.dataset.kcAbbrBound === "1") return;
  document.documentElement.dataset.kcAbbrBound = "1";
  tipEl();

  document.addEventListener("pointerdown", (e) => {
    lastPointerType = e.pointerType || "mouse";
  }, true);

  document.addEventListener("pointerover", (e) => {
    if (e.target.closest?.("#kc-abbr-tip")) {
      clearTimeout(hideTimer);
      return;
    }
    const a = closestAbbr(e.target);
    if (a) showTip(a);
  });
  document.addEventListener("pointerout", (e) => {
    const to = e.relatedTarget;
    if (to && (to.closest?.("#kc-abbr-tip") || closestAbbr(to))) return;
    if (tipPinned) return;
    if (closestAbbr(e.target) || e.target.closest?.("#kc-abbr-tip")) hideTipSoon();
  });
  document.addEventListener("focusin", (e) => {
    const a = closestAbbr(e.target);
    if (a) showTip(a);
  });
  document.addEventListener("focusout", (e) => {
    const a = closestAbbr(e.target);
    if (!a) return;
    const next = e.relatedTarget;
    if (next && (a.contains(next) || next.closest?.("#kc-abbr-tip"))) return;
    hideTipSoon();
  });
  document.addEventListener("click", (e) => {
    const tipLink = e.target.closest?.("#kc-abbr-tip a, .kc-abbr-tip-link");
    if (tipLink) {
      e.preventDefault();
      const from = tipOwner;
      hideTip();
      openGlossaryFrom(from);
      return;
    }
    if (e.target.closest?.("#kc-abbr-tip")) {
      e.preventDefault();
      return;
    }
    const a = closestAbbr(e.target);
    if (a) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
      e.preventDefault();
      e.stopPropagation();
      const pointer = e.pointerType || lastPointerType;
      const isTouch = pointer === "touch" || pointer === "pen";
      if (isTouch && lastTouchOpen !== a) {
        showTip(a, { pin: true });
        lastTouchOpen = a;
        return;
      }
      hideTip();
      openGlossaryFrom(a);
      return;
    }
    if (tipOwner) hideTip();
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tipOwner) {
      hideTip();
    }
  });
  window.addEventListener("scroll", () => { if (tipOwner && !tipPinned) hideTip(); }, true);
  window.addEventListener("resize", () => { if (tipOwner) hideTip(); });
}

