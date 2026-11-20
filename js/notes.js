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
  t = t.replace(/https?:\/\/[^\s<]+/g, (m) => {
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
