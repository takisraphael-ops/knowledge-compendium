export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const SITE = "https://takisraphael-ops.github.io/knowledge-compendium";

let termLinker = null;

/** Optional lookup: term string -> node id, used when rendering Term: definition runs. */
export function setTermLinker(fn) {
  termLinker = typeof fn === "function" ? fn : null;
}


function mapTextOutsideProtectedTags(html, fn) {
  const parts = String(html).split(/(<[^>]+>)/);
  let depth = 0;
  const protect = /^(?:code|pre|a|kbd|samp)$/i;
  return parts.map((p) => {
    const open = p.match(/^<([a-zA-Z0-9]+)\b/);
    const close = p.match(/^<\/([a-zA-Z0-9]+)>/);
    if (open && protect.test(open[1])) depth++;
    const out = p.startsWith("<") || depth > 0 ? p : fn(p);
    if (close && protect.test(close[1]) && depth) depth--;
    return out;
  }).join("");
}

function italicize(s) {
  // *emphasis* only. Opening/closing marks must not sit against a letter or
  // digit, so 3*4 + 5*6 is left alone. Underscore _emphasis_ is not supported:
  // it would mangle snake_case, file names and similar identifiers.
  return s.replace(/(?<![A-Za-z0-9\\])\*(?![\s*])([^*\n]*?[^\s*])\*(?![A-Za-z0-9])/g, "<em>$1</em>");
}

function inline(s) {
  let t = escapeHtml(s);
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  t = t.replace(/(?<!href=")https?:\/\/[^\s<]+/g, (m) => {
    const trail = m.match(/[),.;:]+$/)?.[0] || "";
    const core = trail ? m.slice(0, -trail.length) : m;
    return `<a href="${core}" target="_blank" rel="noopener noreferrer">${core}</a>${trail}`;
  });
  t = mapTextOutsideProtectedTags(t, italicize);
  return t;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/\s/g, "")));
}

function pad(row, n) {
  const out = row.slice();
  while (out.length < n) out.push("");
  return out;
}

function renderTable(rows) {
  const filtered = rows.filter((r) => !isSeparator(r));
  if (!filtered.length) return "";
  const cols = Math.max(...filtered.map((r) => r.length));
  const head = filtered.length > 1 ? filtered[0] : null;
  const body = head ? filtered.slice(1) : filtered;
  const cells = (row, tag) => pad(row, cols).map((c) => `<${tag}>${inline(c)}</${tag}>`).join("");
  const headHtml = head ? `<thead><tr>${cells(head, "th")}</tr></thead>` : "";
  const bodyHtml = `<tbody>${body.map((r) => `<tr>${cells(r, "td")}</tr>`).join("")}</tbody>`;
  return `<div class="table-wrap"><table>${headHtml}${bodyHtml}</table></div>`;
}



const TERM_SKIP = new Set([
  "note", "notes", "for example", "e.g.", "e.g", "i.e.", "i.e",
  "see also", "warning", "tip", "hint", "remember", "important", "caution",
  "source", "update",
  "please note", "nb", "n.b.", "ps", "p.s.", "important note", "trap",
]);

const TERM_START_SKIP = new Set([
  "this", "the", "a", "an", "these", "those", "there", "it", "if", "when",
  "what", "how", "why", "for", "and", "or", "but", "in", "on", "at", "to",
  "of", "its", "their", "your", "our", "we", "you", "they", "please", "also",
  "here",
]);

const FUNCTION_WORDS = new Set([
  "and", "or", "of", "the", "for", "to", "in", "on", "a", "an", "vs", "vs.",
  "by", "as", "at", "with", "from", "into", "via", "also", "simply",
]);

const TRAILING_HEADS = new Set([
  "linux", "windows", "java", "macos", "android",
]);

// A single word in a term: letters (optional trademark), or a numeric token
// such as 802.11 / 800-53. Periods are not allowed in letter-words so
// "CSR. Hierarchy" cannot be one term.
const TERM_WORD = "(?:[A-Za-z][A-Za-z0-9+_'’/-]*[™®©]*|[0-9]+(?:\\.[0-9]+)+|[0-9]+[A-Za-z0-9+_'’/-]*)";
const TERM_BODY = TERM_WORD
  + "(?:[ \\t]+" + TERM_WORD + "|,[ \\t]+" + TERM_WORD + "|[ \\t]/[ \\t]+" + TERM_WORD + "|\\s*\\([^\\)]{1,90}\\))*"
  + "[ ™®©]*";

const TERM_ANCHORED = new RegExp("^(?:" + TERM_BODY + ")$");

function isSkipTerm(label) {
  const raw = String(label || "").trim().replace(/[.:]+$/, "");
  if (!raw) return true;
  if (raw.length > 120) return true;
  const lower = raw.toLowerCase();
  if (TERM_SKIP.has(lower)) return true;
  const words = raw.split(/\s+/);
  if (words.length > 14) return true;
  if (words.length >= 8 && !/\([^)]+\)/.test(raw)) return true;
  if (words.length >= 5 && !/\([^)]+\)/.test(raw) && /\b(is|are|was|were|pull|pulls|means|includes|requires|gather|gathers)\b/i.test(raw)) return true;
  const first = words[0].toLowerCase().replace(/[.,:]+$/, "");
  if (TERM_START_SKIP.has(first) && words.length >= 3) return true;
  return false;
}

function firstWordOk(label, atStartOfText) {
  const first = String(label || "").trim().split(/\s+/)[0] || "";
  if (/^[A-Z]/.test(first)) return true;
  if (atStartOfText && /^[a-z][a-z0-9+._-]*$/.test(first) && !/\s/.test(label.trim())) return true;
  return false;
}

function tokenizeTerm(label) {
  const out = [];
  const re = /\([^)]+\)|[A-Za-z0-9+_'’./-]+[™®©]*|,/g;
  let m;
  while ((m = re.exec(String(label || "")))) out.push(m[0]);
  return out;
}


function wordCount(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

function splitLongProse(text, limit = 110) {
  if (wordCount(text) <= limit) return null;
  const sentences = String(text).split(/(?<=[.!?])(?:[ \t]+|\s+)(?=[A-Z“"‘])/);
  if (sentences.length < 2) return null;
  const paras = [];
  let buf = [];
  let wc = 0;
  for (const sentence of sentences) {
    const w = wordCount(sentence);
    if (buf.length && wc + w > 80) {
      paras.push(buf.join(" "));
      buf = [sentence];
      wc = w;
    } else {
      buf.push(sentence);
      wc += w;
    }
  }
  if (buf.length) paras.push(buf.join(" "));
  return paras.length >= 2 ? paras : null;
}

function renderSeeAlso(text) {
  const m = String(text || "").trim().match(/^(?:\*\*)?See also:(?:\*\*)?\s*([\s\S]+)$/i);
  if (!m) return "";
  const rest = m[1].trim();
  if (!rest) return "";
  const parts = [];
  let buf = "";
  let depth = 0;
  for (const ch of rest) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === "·") && depth === 0) {
      const bit = buf.trim().replace(/^[;·,\s]+|[;·,\s]+$/g, "");
      if (bit) parts.push(bit);
      buf = "";
    } else buf += ch;
  }
  const last = buf.trim().replace(/^[;·,\s]+|[;·,\s]+$/g, "");
  if (last) parts.push(last);
  if (parts.length < 2) return "";
  return `<p class="see-also-label">See also</p><ul class="see-also-list">${parts.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`;
}

function renderParagraph(trimmed) {
  const chunks = String(trimmed || "").split(/_{8,}/);
  if (chunks.length > 1) {
    return chunks.map((chunk) => renderParagraph(chunk.trim())).filter(Boolean).join('<hr class="notes-rule" />');
  }
  const see = renderSeeAlso(trimmed);
  if (see) return see;
  const runs = parseTermRuns(trimmed);
  if (runs) return renderTermRuns(runs);
  const paras = splitLongProse(trimmed);
  if (paras) return paras.map((para) => `<p>${inline(para)}</p>`).join("");
  return `<p>${inline(trimmed)}</p>`;
}

function wordKind(tok) {
  if (tok === ",") return "fn";
  if (tok.startsWith("(") && tok.endsWith(")")) return "paren";
  const bare = tok.replace(/[™®©]+$/g, "");
  if (FUNCTION_WORDS.has(bare.toLowerCase())) return "fn";
  if (/^\d/.test(bare)) return "num";
  if (/^[A-Z]{2,6}s?$/.test(bare) || /^[A-Z]{2,}\/[A-Z]{2,}/.test(bare)) return "acr";
  if (/^[A-Z]/.test(bare)) return "title";
  return "lower";
}

function isWellFormedTerm(label) {
  const tokens = tokenizeTerm(label);
  if (!tokens.length) return false;
  let mode = "title";
  let prev = "";
  for (let i = 0; i < tokens.length; i++) {
    const k = wordKind(tokens[i]);
    if (k === "title" && prev === "acr" && i > 0) {
      const rest = tokens.slice(i + 1).filter((t) => wordKind(t) !== "fn");
      const acrTok = tokens[i - 1] || "";
      const twoLetter = /^[A-Z]{2}s?$/.test(acrTok.replace(/[™®©]+$/g, ""));
      if (twoLetter || rest.length === 0) return false;
    }
    if (k === "title" && mode === "sentence") return false;
    if (k === "lower") mode = "sentence";
    if (k !== "fn" && k !== "paren") prev = k;
  }
  const first = tokens[0].replace(/[™®©]+$/g, "").toLowerCase();
  if (TRAILING_HEADS.has(first) && tokens.length >= 2 && wordKind(tokens[1]) === "title") {
    return false;
  }
  return true;
}

function packedBefore(text, index) {
  if (index <= 0) return true;
  if (/^\s+$/.test(text.slice(0, index))) return true;
  const ch = text.slice(Math.max(0, index - 16), index);
  // "image). Tokenisation:" and "device). SMTP:" are common in packed lists.
  if (/\)[.!?;:]?[ \t]$/.test(ch)) return true;
  if (/[A-Za-z0-9)\]}'’”`]["']?[ \t]$/.test(ch)) return true;
  if (/[A-Za-z0-9)'’”`][ \t]$/.test(ch)) return true;
  if (/:[ \t]$/.test(ch)) return true;
  if (/\d+\.[ \t]$/.test(ch)) return true; // 2. Delivery:
  if (/[*`"'”’)][.!?]?[ \t]$/.test(ch)) return true;
  if (/[A-Za-z]{2,}[.!?][ \t]$/.test(ch)) return true;
  return false;
}

function canStartTermAt(text, index, label, alreadyInRun) {
  if (index <= 0) return true;
  if (/^\s+$/.test(text.slice(0, index))) return true;
  if (packedBefore(text, index) && firstWordOk(label, false)) return true;
  const before = text.slice(Math.max(0, index - 12), index);
  if (/[A-Za-z]{2,}[.!?][ \t]$/.test(before) || /\)[.!?][ \t]$/.test(before) || /:[ \t]$/.test(before)) {
    const words = String(label || "").trim().split(/\s+/);
    if (words.length >= 2) return true;
    if (/\([^)]+\)/.test(label)) return true;
    if (/[A-Z]{2,}/.test(label) || /[-/]/.test(label)) return true;
    if (alreadyInRun && words.length === 1 && words[0].length >= 4) return true;
  }
  return false;
}

function backtickTerm(text, colonIndex) {
  const window = text.slice(Math.max(0, colonIndex - 80), colonIndex);
  const m = window.match(/`([A-Za-z][A-Za-z0-9+._/-]*)`$/);
  if (!m) return null;
  const absIdx = colonIndex - m[0].length;
  if (absIdx < 0) return null;
  return { index: absIdx, label: m[1] };
}

/** Longest well-formed term immediately before a ": " at colonIndex. */
function findTermBefore(text, colonIndex) {
  const tick = backtickTerm(text, colonIndex);
  if (tick && packedBefore(text, tick.index)) return tick;
  const windowStart = Math.max(0, colonIndex - 140);
  const window = text.slice(windowStart, colonIndex);
  let best = null;
  for (let s = 0; s < window.length; s++) {
    if (s > 0 && !/[\s,]$/.test(window[s - 1]) && window[s] !== "(") continue;
    const cand = window.slice(s).trim();
    if (!cand || !TERM_ANCHORED.test(cand) || isSkipTerm(cand)) continue;
    if (!isWellFormedTerm(cand)) continue;
    const absIdx = text.lastIndexOf(window.slice(s).replace(/^\s+/, ""), colonIndex - 1);
    if (absIdx < 0) continue;
    if (!firstWordOk(cand, absIdx === 0)) continue;
    if (!canStartTermAt(text, absIdx, cand, true) && absIdx !== 0) continue;
    const prep = text.slice(Math.max(0, absIdx - 8), absIdx);
    if (/\b(?:for|in|with|using|to|by|from|of|via|into|onto)[ \t]$/i.test(prep)) continue;
    if (!best || cand.length >= best.label.length) best = { index: absIdx, label: cand };
  }
  return best;
}

function findAllTermStarts(text) {
  const found = [];
  let from = 0;
  while (from < text.length) {
    const c = text.indexOf(": ", from);
    if (c < 0) break;
    const hit = findTermBefore(text, c);
    if (hit && (found.length === 0 ? (hit.index === 0 || canStartTermAt(text, hit.index, hit.label, false)) : hit.index >= (found[found.length - 1].colon + 2))) {
      found.push({ index: hit.index, label: hit.label, colon: c });
    }
    from = c + 2;
  }
  return found;
}

function peelTail(def) {
  const src = String(def || "");
  const m = src.match(/^([\s\S]*[.!?])[ \t]+([A-Z][\s\S]{15,})$/);
  if (!m) return { def: src, tail: "" };
  const tail = m[2].trim();
  if (/^(And|Or|But|Then|This|That|It|They|These|Those|There|Also|So)\b/.test(tail)) {
    return { def: src, tail: "" };
  }
  if (tail.includes(": ")) return { def: src, tail: "" };
  return { def: m[1].trim(), tail };
}

function isGlossaryStyleDef(def) {
  const d = String(def || "").trim();
  if (/^(?:A|An|The|Software|Security|Unauthorized|Information|Hardware|Data|Malware)\b/.test(d)) return true;
  if (/\b(?:designed|used to|type of|practice of)\b/i.test(d) && d.length < 400) return true;
  return false;
}

const MISSING_COLON = /(?:^|(?<=[a-z0-9)\]'’”"]))\s([A-Z][A-Za-z0-9+_'’/-]*(?:[ \t]+[A-Za-z][a-z]+){0,4})[ \t]+((?:A|An|The)[ \t][\s\S]+)$/;

function splitMissingColons(items) {
  if (!items || items.length < 2) return items;
  const out = [];
  for (const item of items) {
    const m = String(item.def || "").match(MISSING_COLON);
    if (m && firstWordOk(m[1], false) && isWellFormedTerm(m[1])) {
      const head = item.def.slice(0, item.def.lastIndexOf(m[1])).trim();
      if (head) out.push({ term: item.term, def: head });
      out.push({ term: m[1].trim(), def: m[2].trim() });
    } else {
      out.push(item);
    }
  }
  return out;
}

/** Split a packed "Term: definition Term2: definition" paragraph into items. */
function normalizeTermSource(text) {
  return String(text || "")
    .replace(/\)([A-Z])/g, ") $1")
    .replace(/(?<=[A-Za-z]{2})\.([A-Z])/g, ". $1")
    .replace(/\.(\d+)\.\s*/g, ". $1. ")
    .replace(/\?\.\s*/g, "? ")
    .replace(/\.{2,}/g, ". ");
}

export function parseTermRuns(text) {
  const src = normalizeTermSource(text);
  if (!src.includes(": ") && !src.includes("`:")) return null;
  const starts = findAllTermStarts(src);
  if (!starts.length) return null;
  const prefix = src.slice(0, starts[0].index).trim();
  let items = starts.map((st, i) => {
    const defStart = st.colon + 2;
    const defEnd = i + 1 < starts.length ? starts[i + 1].index : src.length;
    return { term: st.label, def: src.slice(defStart, defEnd).trim() };
  });
  items = splitMissingColons(items);
  let tail = "";
  if (items.length) {
    const peeled = peelTail(items[items.length - 1].def);
    items[items.length - 1].def = peeled.def;
    tail = peeled.tail;
  }
  if (items.length >= 2 && termsLookLikeList(items)) return { prefix, items, tail };
  if (items.length === 1 && !prefix && isGlossaryStyleDef(items[0].def)) {
    return { prefix, items, tail };
  }
  return null;
}

function termsLookLikeList(items) {
  if (!items || !items.length) return false;
  // Dense glossary dumps are already well parsed; do not reject long official names.
  if (items.length >= 4) return true;
  const sentencey = /\b(is|are|was|were|deserves|releases|builds|means|includes|requires)\b/i;
  const opener = /^(The|This|A|An|All|It|There|These|Those)\b/;
  return items.every((it) => {
    const words = String(it.term).trim().split(/\s+/);
    if (words.length > 8 && !/\([^)]+\)/.test(it.term)) return false;
    if (opener.test(it.term) && words.length >= 2) return false;
    if (sentencey.test(it.term)) return false;
    return true;
  });
}

export function renderTermRuns(parsed) {
  if (!parsed || !parsed.items || !parsed.items.length) return "";
  const parts = [];
  if (parsed.prefix) parts.push(`<p>${inline(parsed.prefix)}</p>`);
  const rows = parsed.items.map((item) => {
    const id = termLinker ? String(termLinker(item.term) || "").trim().replace(/^#/, "") : "";
    const name = id
      ? `<a class="term-run-link" href="${SITE}/#${escapeHtml(id)}">${inline(item.term)}</a>`
      : `<span class="term-run-name">${inline(item.term)}</span>`;
    return `<div class="term-item"><dt>${name}</dt><dd>${inline(item.def)}</dd></div>`;
  }).join("");
  parts.push(`<dl class="term-run">${rows}</dl>`);
  if (parsed.tail) parts.push(`<p class="term-run-tail">${inline(parsed.tail)}</p>`);
  return parts.join("");
}

function studyCalloutKind(title) {
  const t = String(title || "").replace(/[:.]+$/, "").trim();
  if (/^exam tips?$/i.test(t) || /^exam point$/i.test(t) || /^exam clue$/i.test(t)) return "exam";
  if (/^memory aids?$/i.test(t)) return "memory";
  return "";
}

function wrapStudyCallout(kind, innerHtml) {
  const label = kind === "exam" ? "Exam tips" : "Memory aids";
  const id = kind === "exam" ? "panel-exam-tips" : "panel-memory-aids";
  return `<section id="${id}" class="study-callout study-callout-${kind}"><div class="study-callout-label">${label}</div>${innerHtml}</section>`;
}

function collectUntilHeading(lines, start, level) {
  const inner = [];
  let i = start;
  while (i < lines.length) {
    const t = lines[i].trim();
    const h = t.match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) break;
    inner.push(lines[i]);
    i++;
  }
  return { inner, next: i };
}

function renderBlocks(lines, opts = {}) {
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (/^[_—–-]{8,}$/.test(trimmed)) {
      html.push('<hr class="notes-rule" />');
      i++;
      continue;
    }
    if (opts.studyCallouts !== false && /^\*\*Original wording\b/i.test(trimmed)) {
      const inner = [];
      let j = i + 1;
      while (j < lines.length) {
        const t = lines[j].trim();
        const h = t.match(/^(#{1,6})\s+(.*)$/);
        if (h && (studyCalloutKind(h[2]) || /^practice$/i.test(String(h[2]).replace(/[:.]+$/, "").trim()))) break;
        inner.push(lines[j]);
        j++;
      }
      const summary = inline(trimmed.replace(/^\*\*|\*\*$/g, "").replace(/\*\*/g, ""));
      html.push(`<details class="original-wording"><summary>${summary}</summary>${renderBlocks(inner, opts)}</details>`);
      i = j;
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const kind = opts.studyCallouts === false ? "" : studyCalloutKind(heading[2]);
      if (kind) {
        const { inner, next } = collectUntilHeading(lines, i + 1, heading[1].length);
        html.push(wrapStudyCallout(kind, renderBlocks(inner, opts)));
        i = next;
        continue;
      }
      const tag = heading[1].length >= 4 ? "h4" : "h3";
      html.push(`<${tag}>${inline(heading[2])}</${tag}>`);
      i++;
      continue;
    }
    if (trimmed.startsWith("|")) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      html.push(renderTable(rows));
      continue;
    }
    if (/^[-*•–]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*•–]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•–]\s+/, ""));
        i++;
      }
      html.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    const numbered = /^(?:\d+)\.(?:[✓✔]\s*|\s+)(.*)$/;
    if (numbered.test(trimmed)) {
      const items = [];
      while (i < lines.length && numbered.test(lines[i].trim())) {
        items.push(lines[i].trim().match(numbered)[1]);
        i++;
      }
      html.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ol>`);
      continue;
    }
    html.push(renderParagraph(trimmed));
    i++;
  }
  return html.join("");
}

function renderSection(section, opts = {}) {
  const inner = renderBlocks(section.lines, opts);
  if (!section.label) return inner;
  return `<section class="src-block"><div class="src-label">${inline(section.label)}</div>${inner}</section>`;
}

/** Render compendium note text: @@ source blocks, headings, bullets, tables. */
export function renderNotes(text, opts = {}) {
  const lines = String(text || "").replace(/\u200b/g, "").replace(/\r\n/g, "\n").split("\n");
  const sections = [{ label: "", lines: [] }];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");
    const mark = line.match(/^\s*@@\s*(.*)$/);
    if (mark) sections.push({ label: mark[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections.map((section) => renderSection(section, opts)).join("");
}

export const EXPANDED_LABEL = "Expanded explanation (added by Grokimus)";

export const YOUR_NOTES_LABEL = "Your notes";
export const SHOW_ORIGINAL = "Show original wording";
export const SHOW_TIDIED = "Show tidied version";

/** Prefer the tidied version when present; otherwise the original wording. */
export function displayNotes(node, showOriginal = false) {
  const tidy = String(node?.tidy || "");
  const text = String(node?.text || "");
  if (showOriginal) return text;
  return tidy.trim() ? tidy : text;
}

export function hasOriginalToggle(node) {
  const tidy = String(node?.tidy || "").trim();
  const text = String(node?.text || "").trim();
  return !!(tidy && text && tidy !== text);
}

const KP_OWNER_HEADING = /^(?:#{1,3}\s*)?key\s*points?\s*:?\s*$/i;
const MD_HEADING = /^#{1,3}\s+\S/;

/** Remove an owner "Key Points" table or list from displayed notes so the box is not duplicated. */
export function stripOwnerKeyPointsSection(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let removed = false;
  while (i < lines.length) {
    if (KP_OWNER_HEADING.test(lines[i].trim())) {
      removed = true;
      i += 1;
      let saw = false;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (MD_HEADING.test(t) && !KP_OWNER_HEADING.test(t)) break;
        if (saw && t && !t.startsWith("|") && !/^[-*•–]\s+/.test(t) && !t.startsWith(">")) break;
        if (t) saw = true;
        i += 1;
      }
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

export function renderYourNotes(node, showOriginal = false) {
  let body = displayNotes(node, showOriginal);
  // When the Key points box was derived from the owner's table, do not show that table twice.
  // Original wording (showOriginal) still includes it in full.
  if (!showOriginal && node?.keyPointsFromOwner && body) {
    const stripped = stripOwnerKeyPointsSection(body);
    if (stripped.removed) body = stripped.text;
  }
  // Owner notes keep ordinary headings; official Exam tips / Memory aids live in the study stack.
  return body ? renderNotes(body, { studyCallouts: false }) : "";
}

const STUDY_HEADING_RE = /^###\s+(Exam tips|Exam point|Exam clue|Memory aids|Practice)\s*$/gim;

/** Split a Grokimus expanded note into the teaching lead and study layers. */
export function splitExpanded(text) {
  const src = String(text || "").replace(/\r\n/g, "\n");
  const headings = [];
  const re = new RegExp(STUDY_HEADING_RE.source, "gim");
  let m;
  while ((m = re.exec(src))) {
    headings.push({ name: m[1].toLowerCase(), start: m.index, headEnd: m.index + m[0].length });
  }
  const out = { lead: src, exam: "", memory: "", practice: "" };
  if (!headings.length) return out;
  out.lead = src.slice(0, headings[0].start).replace(/\s+$/, "\n");
  const keyOf = (n) => (n.startsWith("exam") ? "exam" : n.startsWith("memory") ? "memory" : "practice");
  for (let i = 0; i < headings.length; i++) {
    const end = i + 1 < headings.length ? headings[i + 1].start : src.length;
    out[keyOf(headings[i].name)] = src.slice(headings[i].headEnd, end).replace(/^\n+/, "").replace(/\s+$/, "\n");
  }
  return out;
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

function peelSeeAlso(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const isSeeAlso = (line) => /^(?:\*\*)?See also:/i.test(line.trim());
  const see = lines.findIndex(isSeeAlso);
  if (see < 0) return { body: body || "", seeAlso: "" };
  return {
    body: lines.slice(0, see).join("\n").replace(/\s+$/, "\n"),
    seeAlso: lines.slice(see).join("\n"),
  };
}

function renderPractice(body) {
  if (!String(body || "").trim()) return { html: "", seeAlso: "" };
  const { questions, answers, after } = splitPractice(body);
  const qHtml = questions.trim() ? renderNotes(questions) : "";
  const aHtml = answers.trim()
    ? `<details class="practice-answers"><summary>Show answers</summary><div class="practice-answers-body">${renderNotes(answers)}</div></details>`
    : "";
  const html = `<section id="panel-practice" class="study-callout study-callout-practice"><div class="study-callout-label">Practice</div>${qHtml}${aHtml}</section>`;
  return { html, seeAlso: after };
}

/** Teaching lead only (before Exam tips). Used under More depth, or open when there are no owner notes. */
export function renderLead(node) {
  const { lead } = splitExpanded(node?.expanded || "");
  if (!lead.trim()) return "";
  return `<section class="expanded-block"><div class="expanded-label">Further explanation</div>${renderNotes(lead)}</section>`;
}

/** Expanded explanation only (shown under More depth). Study layers are rendered separately, always open. */
export function renderExpanded(node) {
  return renderLead(node);
}

/** Back-compat: depth box is the teaching lead only. */
export function renderDepth(node) {
  return renderLead(node);
}

/** Exam tips, Memory aids and Practice, always visible in the panel flow. */
export function renderStudyLayers(node) {
  const parts = splitExpanded(node?.expanded || "");
  const examPeeled = peelSeeAlso(parts.exam);
  const memPeeled = peelSeeAlso(parts.memory);
  const exam = examPeeled.body.trim() ? wrapStudyCallout("exam", renderNotes(examPeeled.body)) : "";
  const memory = memPeeled.body.trim() ? wrapStudyCallout("memory", renderNotes(memPeeled.body)) : "";
  const prac = renderPractice(parts.practice);
  const seeSrc = [prac.seeAlso, memPeeled.seeAlso, examPeeled.seeAlso].find((s) => String(s || "").trim()) || "";
  const seeHtml = seeSrc.trim() ? renderNotes(seeSrc) : "";
  if (!exam && !memory && !prac.html && !seeHtml) return "";
  return `<div class="study-stack">${exam}${memory}${prac.html}</div>${seeHtml}`;
}

export const FULL_NOTES_LABEL = "Full notes (from your original document)";

function normWs(s) {
  return String(s || "")
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ownHaystack(node, doc) {
  const text = String(node?.text || "");
  if (!text.trim()) return "";
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [{ doc: "", lines: [] }];
  for (const line of parts) {
    const mark = line.match(/^\s*@@\s*(.*)$/);
    if (mark) blocks.push({ doc: mark[1].trim().toLowerCase(), lines: [] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  const wanted = (doc || "").toLowerCase();
  const chosen = [];
  for (const b of blocks) {
    if (!wanted || !b.doc || b.doc.includes(wanted) || wanted.includes(b.doc.slice(0, 12))) {
      chosen.push(b.lines.join("\n"));
    }
  }
  const body = (chosen.length ? chosen : [text]).join("\n");
  return normWs(body).toLowerCase();
}

function shouldHighlightLine(line, hay) {
  const n = normWs(line);
  if (n.length < 32 || !hay) return false;
  return hay.includes(n.slice(0, 80).toLowerCase());
}

/** Render a stored source section, highlighting the topic's own passage when it is only part of the section. */
export function renderFullNotes(sections, node, docLabel) {
  if (!sections || !sections.length) return "";
  return sections.map((sec) => {
    const name = docLabel ? docLabel(sec.doc) : sec.doc;
    const title = sec.title ? ` — ${sec.title}` : "";
    const hay = ownHaystack(node, name || sec.doc);
    const lines = String(sec.text || "").replace(/\r\n/g, "\n").split("\n");
    const marks = new Set();
    if (hay.length >= 32) {
      lines.forEach((ln, i) => { if (shouldHighlightLine(ln, hay)) marks.add(i); });
    }
    const usable = marks.size > 0 && marks.size < Math.max(3, Math.floor(lines.length * 0.8));
    const body = usable ? renderNotesHighlighted(lines, marks) : renderNotes(sec.text, { studyCallouts: false });
    const hint = usable
      ? `<p class="full-notes-hint">Highlighted text is the passage this topic was taken from.</p>`
      : "";
    return `<section class="full-notes-section"><div class="full-notes-doc">${escapeHtml(name || "Source")}${escapeHtml(title)}</div>${hint}${body}</section>`;
  }).join("");
}

function renderNotesHighlighted(lines, marks) {
  return renderBlocksHighlighted(lines, marks);
}

function wrapInline(s, on) {
  const inner = inline(s);
  return on ? `<mark class="own-passage">${inner}</mark>` : inner;
}

function renderBlocksHighlighted(lines, marks) {
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) { i++; continue; }
    if (/^[_—–-]{8,}$/.test(trimmed)) { html.push('<hr class="notes-rule" />'); i++; continue; }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const kind = studyCalloutKind(heading[2]);
      if (kind) {
        const start = i + 1;
        const { inner, next } = collectUntilHeading(lines, start, heading[1].length);
        const shifted = new Set();
        for (const idx of marks) if (idx >= start && idx < next) shifted.add(idx - start);
        html.push(wrapStudyCallout(kind, renderBlocksHighlighted(inner, shifted)));
        i = next;
        continue;
      }
      const tag = heading[1].length >= 4 ? "h4" : "h3";
      html.push(`<${tag}>${inline(heading[2])}</${tag}>`);
      i++;
      continue;
    }
    if (trimmed.startsWith("|")) {
      const rows = [];
      const start = i;
      while (i < lines.length && lines[i].trim().startsWith("|")) { rows.push(lines[i]); i++; }
      const table = renderTable(rows.map((r) => {
        let s = r.trim();
        if (s.startsWith("|")) s = s.slice(1);
        if (s.endsWith("|")) s = s.slice(0, -1);
        return s.split("|").map((c) => c.trim());
      }));
      const on = Array.from({ length: i - start }, (_, k) => marks.has(start + k)).some(Boolean);
      html.push(on ? `<div class="own-passage-block">${table}</div>` : table);
      continue;
    }
    if (/^[-*•–]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*•–]\s+/.test(lines[i].trim())) {
        const on = marks.has(i);
        items.push(`<li>${wrapInline(lines[i].trim().replace(/^[-*•–]\s+/, ""), on)}</li>`);
        i++;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const numbered = /^(?:\d+)\.(?:[✓✔]\s*|\s+)(.*)$/;
    if (numbered.test(trimmed)) {
      const items = [];
      while (i < lines.length && numbered.test(lines[i].trim())) {
        const on = marks.has(i);
        items.push(`<li>${wrapInline(lines[i].trim().match(numbered)[1], on)}</li>`);
        i++;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const blockH = renderParagraph(trimmed);
    html.push(marks.has(i) ? `<div class="own-passage-block">${blockH}</div>` : blockH);
    i++;
  }
  return html.join("");
}

const KEY_TERMS_LABEL = "Key terms";

/** Compact Key terms block. Always rendered in the open panel, never behind More depth. */
export function renderKeyTerms(node) {
  const items = Array.isArray(node?.keyTerms) ? node.keyTerms : [];
  if (!items.length) return "";
  const rows = items.map((item) => {
    const term = escapeHtml(item.term || "");
    const def = escapeHtml(item.def || "");
    const id = String(item.link || "").trim().replace(/^#/, "");
    const name = id
      ? `<a class="key-term-link" href="${SITE}/#${escapeHtml(id)}">${term}</a>`
      : `<span class="key-term-name">${term}</span>`;
    return `<div class="key-term"><dt>${name}</dt><dd>${def}</dd></div>`;
  }).join("");
  const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 700px)").matches;
  const startOpen = items.length <= 4 && !isMobile;
  const label = `${KEY_TERMS_LABEL} (${items.length})`;
  return `<details id="panel-key-terms" class="key-terms"${startOpen ? " open" : ""}>
    <summary class="key-terms-label">${label}</summary>
    <dl class="key-terms-list">${rows}</dl>
  </details>`;
}

/** Always-visible Key points box: 3–5 revision bullets, never behind More depth. */
export function renderKeyPoints(node) {
  const items = Array.isArray(node?.keyPoints) ? node.keyPoints.map((s) => String(s || "").trim()).filter(Boolean) : [];
  if (!items.length) return "";
  const lis = items.map((s) => `<li>${inline(s)}</li>`).join("");
  const note = node?.keyPointsFromOwner
    ? `<p class="key-points-note">Drawn from the Key Points table in your notes on this page.</p>`
    : "";
  return `<section id="panel-key-points" class="study-callout study-callout-keypoints">
    <div class="study-callout-label">Key points</div>
    <ul class="key-points-list">${lis}</ul>
    ${note}
  </section>`;
}
