export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
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


function studyCalloutKind(title) {
  const t = String(title || "").replace(/[:.]+$/, "").trim();
  if (/^exam tips?$/i.test(t) || /^exam point$/i.test(t) || /^exam clue$/i.test(t)) return "exam";
  if (/^memory aids?$/i.test(t)) return "memory";
  return "";
}

function wrapStudyCallout(kind, innerHtml) {
  const label = kind === "exam" ? "Exam tips" : "Memory aids";
  return `<section class="study-callout study-callout-${kind}"><div class="study-callout-label">${label}</div>${innerHtml}</section>`;
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
    html.push(`<p>${inline(trimmed)}</p>`);
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

export function renderYourNotes(node, showOriginal = false) {
  const body = displayNotes(node, showOriginal);
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

function renderPractice(body) {
  if (!String(body || "").trim()) return "";
  const { questions, answers, after } = splitPractice(body);
  const qHtml = questions.trim() ? renderNotes(questions) : "";
  const aHtml = answers.trim()
    ? `<details class="practice-answers"><summary>Show answers</summary><div class="practice-answers-body">${renderNotes(answers)}</div></details>`
    : "";
  const afterHtml = after.trim() ? renderNotes(after) : "";
  return `<section class="study-callout study-callout-practice"><div class="study-callout-label">Practice</div>${qHtml}${aHtml}${afterHtml}</section>`;
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
  const exam = parts.exam.trim() ? wrapStudyCallout("exam", renderNotes(parts.exam)) : "";
  const memory = parts.memory.trim() ? wrapStudyCallout("memory", renderNotes(parts.memory)) : "";
  const practice = renderPractice(parts.practice);
  if (!exam && !memory && !practice) return "";
  return `<div class="study-stack">${exam}${memory}${practice}</div>`;
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
    html.push(`<p>${wrapInline(trimmed, marks.has(i))}</p>`);
    i++;
  }
  return html.join("");
}

const KEY_TERMS_LABEL = "Key terms";
const SITE = "https://takisraphael-ops.github.io/knowledge-compendium";

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
  return `<details class="key-terms" open>
    <summary class="key-terms-label">${KEY_TERMS_LABEL}</summary>
    <dl class="key-terms-list">${rows}</dl>
  </details>`;
}

