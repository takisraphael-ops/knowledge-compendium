/** Hash routes for subject-scoped mind maps.
 *
 *   #/                              overview of all subjects
 *   #/<slug>                        that subject's map
 *   #/<slug>/<nodeId>               subject map, node selected
 *   #/<slug>/<focusId>/             map rooted at a sub-branch
 *   #/<slug>/<focusId>/<nodeId>     sub-branch map, node selected
 *   #<nodeId>                       legacy deep link (still honoured)
 *   #/glossary                      master A–Z glossary
 *   #/glossary/<term>               one glossary entry
 *   #/glossary/<term>/<branch>      that entry, branch sense highlighted
 */

export function resolveRedirect(id, redirects) {
  if (!id || !redirects || typeof redirects !== "object") return id;
  const seen = new Set();
  let cur = id;
  while (cur && Object.prototype.hasOwnProperty.call(redirects, cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = redirects[cur];
  }
  return cur;
}

export function slugifyTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "subject";
}

export function preferredSubjectOrder() {
  return ["cybersecurity", "networking", "hardware", "computing"];
}

export function sortSubjects(list) {
  const pref = preferredSubjectOrder();
  const rank = (slug) => {
    const i = pref.indexOf(slug);
    return i === -1 ? 100 + slug.localeCompare("") : i;
  };
  return [...list].sort((a, b) => {
    const d = rank(a.slug) - rank(b.slug);
    return d || a.title.localeCompare(b.title);
  });
}

export function subjectOfNode(index, subjects, id) {
  if (!id || !index?.byId.has(id)) return null;
  if (id === index.rootId) return null;
  const byRoot = new Map(subjects.map((s) => [s.rootId, s]));
  if (byRoot.has(id)) return byRoot.get(id);
  const seen = new Set();
  let cur = index.byId.get(id)?.parentId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (byRoot.has(cur)) return byRoot.get(cur);
    cur = index.byId.get(cur)?.parentId;
  }
  return null;
}

export function isUnder(index, ancestorId, id) {
  if (!ancestorId || !id) return false;
  if (ancestorId === id) return true;
  const seen = new Set();
  let cur = id;
  while (cur && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = index.byId.get(cur)?.parentId;
  }
  return false;
}

export function formatHash({ mode, slug, focusId, selectedId, subjectRootId, glossSlug, glossBranch }) {
  if (mode === "revise") return "#/revise";
  if (mode === "glossary") {
    const term = glossSlug ? encodeURIComponent(glossSlug) : "";
    const br = glossBranch ? encodeURIComponent(glossBranch) : "";
    if (term && br) return `#/glossary/${term}/${br}`;
    if (term) return `#/glossary/${term}`;
    return "#/glossary";
  }
  if (mode === "overview" || !slug) return "#/";
  const focus = focusId && focusId !== subjectRootId ? focusId : null;
  const sel = selectedId && selectedId !== (focus || subjectRootId) ? selectedId : null;
  if (focus && sel) return `#/${encodeURIComponent(slug)}/${encodeURIComponent(focus)}/${encodeURIComponent(sel)}`;
  if (focus) return `#/${encodeURIComponent(slug)}/${encodeURIComponent(focus)}/`;
  if (sel) return `#/${encodeURIComponent(slug)}/${encodeURIComponent(sel)}`;
  return `#/${encodeURIComponent(slug)}`;
}

export function parseHash(hash, { index, subjects, redirects } = {}) {
  const raw = String(hash || "").replace(/^#/, "");
  const bySlug = new Map((subjects || []).map((s) => [s.slug, s]));
  const resolve = (id) => resolveRedirect(id, redirects);

  const asLegacyId = (id) => {
    id = resolve(id);
    if (!index?.byId.has(id)) return { mode: "overview", slug: null, focusId: null, selectedId: null, legacy: true };
    const subject = subjectOfNode(index, subjects, id);
    if (!subject) return { mode: "overview", slug: null, focusId: null, selectedId: id, legacy: true };
    return { mode: "subject", slug: subject.slug, focusId: subject.rootId, selectedId: id, legacy: true };
  };

  if (!raw || raw === "/") {
    return { mode: "overview", slug: null, focusId: null, selectedId: null };
  }

  if (!raw.startsWith("/")) {
    return asLegacyId(decodeURIComponent(raw));
  }

  const trailing = raw.endsWith("/") && raw !== "/";
  const parts = raw.split("/").filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (!parts.length) return { mode: "overview", slug: null, focusId: null, selectedId: null };

  if (parts[0] === "revise") {
    return { mode: "revise", slug: null, focusId: null, selectedId: null, glossSlug: null, glossBranch: null };
  }

  if (parts[0] === "glossary") {
    return {
      mode: "glossary",
      slug: null,
      focusId: null,
      selectedId: null,
      glossSlug: parts[1] || null,
      glossBranch: parts[2] || null,
    };
  }

  const subject = bySlug.get(parts[0]);
  if (!subject) {
    // A lone "/<id>" typo, or an old path.
    if (parts.length === 1 && index?.byId.has(resolve(parts[0]))) return asLegacyId(parts[0]);
    return { mode: "overview", slug: null, focusId: null, selectedId: null };
  }

  if (parts.length === 1) {
    return { mode: "subject", slug: subject.slug, focusId: subject.rootId, selectedId: null };
  }

  if (parts.length === 2 && trailing) {
    const focusCand = resolve(parts[1]);
    const focusId = index?.byId.has(focusCand) ? focusCand : subject.rootId;
    return { mode: "subject", slug: subject.slug, focusId, selectedId: null };
  }

  if (parts.length === 2) {
    const selCand = resolve(parts[1]);
    const selectedId = index?.byId.has(selCand) ? selCand : null;
    return { mode: "subject", slug: subject.slug, focusId: subject.rootId, selectedId };
  }

  const focusCand = resolve(parts[1]);
  const focusId = index?.byId.has(focusCand) ? focusCand : subject.rootId;
  const selCand = parts[2] ? resolve(parts[2]) : null;
  const selectedId = selCand && index?.byId.has(selCand) ? selCand : null;
  return { mode: "subject", slug: subject.slug, focusId, selectedId };
}

export function sameView(a, b) {
  return a.mode === b.mode && a.slug === b.slug && a.focusId === b.focusId && a.selectedId === b.selectedId
    && (a.glossSlug || null) === (b.glossSlug || null)
    && (a.glossBranch || null) === (b.glossBranch || null);
}
