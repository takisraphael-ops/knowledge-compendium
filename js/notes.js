export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
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
  if (/^exam tips?$/i.test(t)) return "exam";
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

function renderBlocks(lines) {
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
      const kind = studyCalloutKind(heading[2]);
      if (kind) {
        const { inner, next } = collectUntilHeading(lines, i + 1, heading[1].length);
        html.push(wrapStudyCallout(kind, renderBlocks(inner)));
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

function renderSection(section) {
  const inner = renderBlocks(section.lines);
  if (!section.label) return inner;
  return `<section class="src-block"><div class="src-label">${inline(section.label)}</div>${inner}</section>`;
}

/** Render compendium note text: @@ source blocks, headings, bullets, tables. */
export function renderNotes(text) {
  const lines = String(text || "").replace(/\u200b/g, "").replace(/\r\n/g, "\n").split("\n");
  const sections = [{ label: "", lines: [] }];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, "");
    const mark = line.match(/^\s*@@\s*(.*)$/);
    if (mark) sections.push({ label: mark[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections.map(renderSection).join("");
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
  return body ? renderNotes(body) : "";
}

/** Expanded explanation only (shown under More depth). */
export function renderExpanded(node) {
  if (node.expanded && String(node.expanded).trim()) {
    return `<section class="expanded-block"><div class="expanded-label">${escapeHtml(EXPANDED_LABEL)}</div>${renderNotes(node.expanded)}</section>`;
  }
  return "";
}

/** Back-compat: depth box is now the expanded explanation only. */
export function renderDepth(node) {
  return renderExpanded(node);
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
    const body = usable ? renderNotesHighlighted(lines, marks) : renderNotes(sec.text);
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
