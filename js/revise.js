/**
 * Revision / quiz UI. Card text stays in memory after unlock.
 * Scheduling writes only ids and SM-2 fields to localStorage.
 */
import { escapeHtml, renderNotes } from "./notes.js";
import { wrapPanelAbbrs } from "./abbr.js";
import { collectCards, domainsForVersion, SY0_VERSIONS } from "./cards.js";
import {
  loadStore,
  saveStore,
  review,
  statsForCards,
  buildQueue,
  remainingNewToday,
  introducedTodayCount,
  getNewPerDay,
  setNewPerDay,
  markIntroduced,
  resetProgress,
  exportProgress,
  mergeImport,
  sanitizeScope,
} from "./schedule.js";

let hooks = null;
let store = null;
let view = "hub";
let scope = { branchIds: [], sectionIds: [], domainIds: [], mode: "flashcards", examVersion: "801" };
let queue = [];
let cursor = 0;
let revealed = false;
let session = null;
let bound = false;

export function initRevise(nextHooks) {
  hooks = nextHooks;
  if (bound || !hooks?.els?.revise) return;
  bound = true;
  const root = hooks.els.revise;
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  document.addEventListener("keydown", onKey);
}

export function showRevise() {
  if (!hooks) return;
  store = loadStore();
  restoreScope();
  if (view !== "study" && view !== "summary") view = "hub";
  const el = hooks.els.revise;
  el.hidden = false;
  document.body.classList.add("revise-open");
  hooks.els.reviseBtn?.classList.add("active");
  hooks.els.reviseBtn?.setAttribute("aria-current", "page");
  render();
}

export function hideRevise() {
  if (!hooks) return;
  if (hooks.els.revise) {
    hooks.els.revise.innerHTML = "";
    hooks.els.revise.hidden = true;
  }
  document.body.classList.remove("revise-open");
  hooks.els.reviseBtn?.classList.remove("active");
  hooks.els.reviseBtn?.removeAttribute("aria-current");
}

/** Drop in-memory card text (call when locking the vault). */
export function getReviseSnapshot() {
  return {
    view,
    cursor,
    revealed,
    scope: { branchIds: [...(scope.branchIds || [])], sectionIds: [...(scope.sectionIds || [])], domainIds: [...(scope.domainIds || [])], mode: scope.mode, examVersion: scope.examVersion === "701" ? "701" : "801" },
  };
}

export function restoreRevise(snap) {
  if (!snap) return;
  if (snap.scope) scope = { ...scope, ...snap.scope };
  view = snap.view || view;
  cursor = Number.isFinite(snap.cursor) ? snap.cursor : cursor;
  revealed = !!snap.revealed;
  render();
}

export function clearReviseSession() {
  view = "hub";
  queue = [];
  session = null;
  revealed = false;
  cursor = 0;
  hideRevise();
}

export function isReviseVisible() {
  return Boolean(hooks?.els?.revise) && !hooks.els.revise.hidden;
}

function appState() {
  return hooks.getState();
}

function restoreScope() {
  const saved = store?.settings?.scope;
  const st = appState();
  if (saved && (saved.branchIds?.length || saved.mode)) {
    scope = {
      branchIds: [...(saved.branchIds || [])],
      sectionIds: [...(saved.sectionIds || [])],
      domainIds: [...(saved.domainIds || [])],
      mode: saved.mode === "practice" || saved.mode === "keypoints" ? saved.mode : "flashcards",
      examVersion: saved.examVersion === "701" ? "701" : "801",
    };
    // Drop ids that no longer exist
    const known = new Set((st.subjects || []).map((s) => s.rootId));
    scope.branchIds = scope.branchIds.filter((id) => known.has(id));
  }
  if (!scope.branchIds.length) {
    const current = st.subjects?.find((s) => s.slug === st.slug);
    const fallback = current || st.subjects?.find((s) => s.slug === "cybersecurity") || st.subjects?.[0];
    if (fallback) scope.branchIds = [fallback.rootId];
  }
}

function persistScope() {
  if (!store) return;
  store.settings.scope = sanitizeScope(scope);
  saveStore(store);
}

function currentCatalog() {
  const st = appState();
  return collectCards(st.index, st.subjects, scope);
}

function sectionOptions() {
  const st = appState();
  const rows = [];
  for (const sub of st.subjects || []) {
    if (!scope.branchIds.includes(sub.rootId)) continue;
    const kids = st.index.children.get(sub.rootId) || [];
    for (const id of kids) {
      const node = st.index.byId.get(id);
      if (!node) continue;
      rows.push({ id, title: node.title, branchId: sub.rootId, branchTitle: sub.title });
    }
  }
  return rows;
}

function cyberSelected() {
  const st = appState();
  return (st.subjects || []).some((s) => s.slug === "cybersecurity" && scope.branchIds.includes(s.rootId));
}

function render() {
  const el = hooks.els.revise;
  if (!el || el.hidden) return;
  if (view === "study") el.innerHTML = renderStudy();
  else if (view === "summary") el.innerHTML = renderSummary();
  else el.innerHTML = renderHub();
  if (view === "study") {
    const card = queue[cursor];
    wrapPanelAbbrs(el.querySelector(".rev-study-body") || el, card?.branchSlug || "");
  }
}

function renderHub() {
  store = store || loadStore();
  const st = appState();
  const { cards, failures } = currentCatalog();
  const stats = statsForCards(store, cards);
  const remain = remainingNewToday(store);
  const intro = introducedTodayCount(store);
  const cap = getNewPerDay(store);
  const queueLen = buildQueue(store, cards).length;
  const branches = st.subjects || [];
  const sections = sectionOptions();
  const showDomains = cyberSelected();

  const branchBoxes = branches.map((s) => {
    const on = scope.branchIds.includes(s.rootId);
    return `<label class="rev-check">
      <input type="checkbox" data-act="branch" value="${escapeHtml(s.rootId)}" ${on ? "checked" : ""}>
      <span>${escapeHtml(s.title)}</span>
    </label>`;
  }).join("");

  let sectionHtml = "";
  if (sections.length) {
    let lastBranch = "";
    const bits = [];
    for (const sec of sections) {
      if (sec.branchId !== lastBranch) {
        lastBranch = sec.branchId;
        bits.push(`<div class="rev-sec-label">${escapeHtml(sec.branchTitle)}</div>`);
      }
      const on = scope.sectionIds.includes(sec.id);
      bits.push(`<label class="rev-check">
        <input type="checkbox" data-act="section" value="${escapeHtml(sec.id)}" ${on ? "checked" : ""}>
        <span>${escapeHtml(sec.title)}</span>
      </label>`);
    }
    sectionHtml = `<div class="rev-fieldset">
      <div class="rev-legend">Sections <span class="rev-hint">(optional — none means the whole branch)</span></div>
      <div class="rev-checks rev-checks-sections">${bits.join("")}</div>
    </div>`;
  }

  let domainHtml = "";
  if (showDomains) {
    const ver = scope.examVersion === "701" ? "701" : "801";
    const activeDomains = domainsForVersion(ver);
    const verBtns = Object.entries(SY0_VERSIONS).map(([k, v]) => `
      <label class="rev-ver ${ver === k ? "on" : ""}">
        <input type="radio" name="rev-exam-ver" data-act="exam-ver" value="${k}" ${ver === k ? "checked" : ""}>
        <span>${escapeHtml(v.label)}</span>
      </label>`).join("");
    const boxes = activeDomains.map((d) => {
      const on = scope.domainIds.includes(d.id);
      return `<label class="rev-check">
        <input type="checkbox" data-act="domain" value="${escapeHtml(d.id)}" ${on ? "checked" : ""}>
        <span>${escapeHtml(d.label)}</span>
      </label>`;
    }).join("");
    domainHtml = `<div class="rev-fieldset">
      <div class="rev-legend">Security+ domains <span class="rev-ver-switch" role="radiogroup" aria-label="Security+ exam version">${verBtns}</span> <span class="rev-hint">(optional study grouping of Cyber sections with official exam weights)</span></div>
      <div class="rev-checks">${boxes}</div>
    </div>`;
  }

  const startLabel = queueLen ? `Start session · ${queueLen} card${queueLen === 1 ? "" : "s"}` : "Nothing due right now";
  const failNote = failures.length
    ? `<p class="rev-warn">${failures.length} practice page${failures.length === 1 ? "" : "s"} could not be parsed and were skipped.</p>`
    : "";

  return `<div class="rev-page">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="leave" aria-label="Back to the map">Back</button>
      <div class="rev-top-title">
        <h1>Revise</h1>
        <p class="rev-kicker">Flashcards, key points and practice questions, reviewed on this device only.</p>
      </div>
    </div>
    <div class="rev-body">
      <section class="rev-card-block">
        <h2>What to study</h2>
        <div class="rev-fieldset">
          <div class="rev-legend">Branches</div>
          <div class="rev-checks">${branchBoxes}</div>
        </div>
        ${sectionHtml}
        ${domainHtml}
        <div class="rev-fieldset">
          <div class="rev-legend">Mode</div>
          <div class="rev-modes" role="radiogroup" aria-label="Revision mode">
            <label class="rev-mode ${scope.mode === "flashcards" ? "on" : ""}">
              <input type="radio" name="rev-mode" data-act="mode" value="flashcards" ${scope.mode === "flashcards" ? "checked" : ""}>
              <strong>Flashcards</strong>
              <span>Key terms and glossary terms. Term on the front, definition on the back.</span>
            </label>
            <label class="rev-mode ${scope.mode === "keypoints" ? "on" : ""}">
              <input type="radio" name="rev-mode" data-act="mode" value="keypoints" ${scope.mode === "keypoints" ? "checked" : ""}>
              <strong>Key points</strong>
              <span>The short revision box from each leaf. Topic on the front, the points on the back.</span>
            </label>
            <label class="rev-mode ${scope.mode === "practice" ? "on" : ""}">
              <input type="radio" name="rev-mode" data-act="mode" value="practice" ${scope.mode === "practice" ? "checked" : ""}>
              <strong>Practice questions</strong>
              <span>The existing questions from each topic’s Practice block.</span>
            </label>
          </div>
        </div>
      </section>

      <section class="rev-card-block rev-session-start">
        <h2>This scope</h2>
        <dl class="rev-stats">
          <div><dt>Cards</dt><dd>${stats.total}</dd></div>
          <div><dt>Due today</dt><dd>${stats.due}</dd></div>
          <div><dt>New left today</dt><dd>${remain} <span class="rev-hint">of ${cap}</span></dd></div>
          <div><dt>Seen</dt><dd>${stats.seen}</dd></div>
          <div><dt>Mastered</dt><dd>${stats.mastered}</dd></div>
        </dl>
        ${failNote}
        <p class="rev-fine">New cards already introduced today: ${intro}. The daily new-card limit is shared across every scope. Mastered means last rated Good or Easy with an interval of at least 21 days.</p>
        <div class="rev-start-row">
          <label class="rev-new-limit">New cards per day
            <input id="rev-new-per-day" type="number" min="0" max="200" step="1" value="${cap}" data-act="new-per-day">
          </label>
          <button type="button" class="solid rev-start" data-act="start" ${queueLen ? "" : "disabled"}>${escapeHtml(startLabel)}</button>
        </div>
      </section>

      ${renderProgressBlocks(st, cards, stats)}

      <section class="rev-card-block">
        <h2>Progress on this device</h2>
        <p class="rev-fine">Scheduling data stays in this browser. Card wording is never written here — only card ids and review dates.</p>
        <div class="rev-data-row">
          <button type="button" class="tool" data-act="export">Export progress</button>
          <button type="button" class="tool" data-act="import">Import progress</button>
          <button type="button" class="tool danger" data-act="reset">Reset progress</button>
        </div>
        <input id="rev-import-file" type="file" accept="application/json,.json" hidden>
      </section>
    </div>
  </div>`;
}

function renderProgressBlocks(st, cards, scopeStats) {
  const byBranch = new Map();
  const bySection = new Map();
  const byDomain = new Map();
  for (const c of cards) {
    if (!byBranch.has(c.branchId)) byBranch.set(c.branchId, []);
    byBranch.get(c.branchId).push(c);
    if (c.sectionId) {
      if (!bySection.has(c.sectionId)) bySection.set(c.sectionId, []);
      bySection.get(c.sectionId).push(c);
    }
    if (c.domainId) {
      if (!byDomain.has(c.domainId)) byDomain.set(c.domainId, []);
      byDomain.get(c.domainId).push(c);
    }
  }

  const branchRows = (st.subjects || []).filter((s) => byBranch.has(s.rootId)).map((s) => {
    const stats = statsForCards(store, byBranch.get(s.rootId));
    return row(s.title, stats);
  });

  const sectionRows = [];
  for (const sub of st.subjects || []) {
    if (!byBranch.has(sub.rootId)) continue;
    const kids = st.index.children.get(sub.rootId) || [];
    for (const id of kids) {
      if (!bySection.has(id)) continue;
      const node = st.index.byId.get(id);
      const stats = statsForCards(store, bySection.get(id));
      sectionRows.push(row(node?.title || id, stats, sub.title));
    }
  }

  const ver = scope.examVersion === "701" ? "701" : "801";
  const verCode = (SY0_VERSIONS[ver] || SY0_VERSIONS["801"]).code;
  const domainRows = domainsForVersion(ver).filter((d) => byDomain.has(d.id)).map((d) => {
    const stats = statsForCards(store, byDomain.get(d.id));
    return row(d.label, stats);
  });

  const scopeReady = readinessPhrase(scopeStats);

  return `<section class="rev-card-block">
    <h2>Readiness</h2>
    <p class="rev-assess">${escapeHtml(scopeReady)}</p>
    <p class="rev-disclaimer">This is a self-assessment, not a predicted exam score. It is the share of cards you have already reviewed whose last rating was Good or Easy.</p>
    ${table("By branch", branchRows)}
    ${sectionRows.length ? table("By section", sectionRows, true) : ""}
    ${domainRows.length ? table(`By Security+ ${verCode} study grouping`, domainRows) : ""}
  </section>`;
}

function readinessPhrase(stats) {
  if (!stats.reviewed) return "No cards in this scope have been rated yet.";
  const pct = Number.isInteger(stats.readiness) ? String(stats.readiness) : String(stats.readiness);
  return `Self-assessment: ${pct}% of reviewed cards in this scope were last rated Good or Easy (${stats.reviewedGoodEasy} of ${stats.reviewed}).`;
}

function row(label, stats, group) {
  const ready = stats.readiness == null ? "—" : `${formatPct(stats.readiness)}%`;
  const groupCell = group ? `<td class="rev-muted">${escapeHtml(group)}</td>` : "";
  return `<tr>
    ${groupCell}
    <th scope="row">${escapeHtml(label)}</th>
    <td>${stats.total}</td>
    <td>${stats.seen}</td>
    <td>${stats.mastered}</td>
    <td>${stats.due}</td>
    <td>${ready}</td>
  </tr>`;
}

function formatPct(n) {
  if (n == null) return "—";
  return Number.isInteger(n) ? String(n) : String(n);
}

function table(title, rows, grouped = false) {
  if (!rows.length) return "";
  return `<h3 class="rev-sub">${escapeHtml(title)}</h3>
    <div class="rev-table-wrap">
      <table class="rev-table">
        <thead>
          <tr>
            ${grouped ? "<th>Branch</th>" : ""}
            <th>Scope</th>
            <th>Cards</th>
            <th>Seen</th>
            <th>Mastered</th>
            <th>Due</th>
            <th>Self-assess</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>`;
}

function faceHtml(text) {
  const src = String(text || "").trim();
  if (!src) return "";
  try {
    return `<div class="rev-prose">${renderNotes(src)}</div>`;
  } catch {
    return `<div class="rev-prose"><p>${escapeHtml(src)}</p></div>`;
  }
}

function renderStudy() {
  const card = queue[cursor];
  if (!card) return renderSummary();
  const total = queue.length;
  const n = cursor + 1;
  const kind = card.kind === "q" ? "Practice" : card.kind === "k" ? "Key points" : "Flashcard";
  const grade = revealed ? `
    <div class="rev-grades" role="group" aria-label="How well did you know this?">
      <button type="button" class="rev-grade g-again" data-act="grade" data-grade="again"><strong>Again</strong><span>1 · soon</span></button>
      <button type="button" class="rev-grade g-hard" data-act="grade" data-grade="hard"><strong>Hard</strong><span>2 · short step</span></button>
      <button type="button" class="rev-grade g-good" data-act="grade" data-grade="good"><strong>Good</strong><span>3 · on track</span></button>
      <button type="button" class="rev-grade g-easy" data-act="grade" data-grade="easy"><strong>Easy</strong><span>4 · later</span></button>
    </div>` : `<button type="button" class="solid rev-reveal" data-act="reveal">Show answer</button>`;

  const backLabel = card.kind === "k" ? "Key points" : "Answer";
  const back = revealed ? `<div class="rev-face rev-answer"><div class="rev-face-label">${backLabel}</div>${faceHtml(card.back)}</div>` : "";

  return `<div class="rev-page rev-study">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="to-hub" aria-label="Back to revision options">Back</button>
      <div class="rev-top-title">
        <h1>${escapeHtml(kind)}</h1>
        <p class="rev-kicker">${n} of ${total} · ${escapeHtml(scopeLabel())}</p>
      </div>
    </div>
    <div class="rev-progress-bar" aria-hidden="true"><span style="width:${Math.round(((n - 1) / total) * 100)}%"></span></div>
    <div class="rev-body rev-study-body">
      <article class="rev-flash">
        <p class="rev-source">${escapeHtml(card.branchTitle || "")} · ${escapeHtml(card.title || "")}</p>
        <div class="rev-face rev-front">
          <div class="rev-face-label">${card.kind === "t" ? "Term" : card.kind === "k" ? "Topic" : "Question"}</div>
          ${card.kind === "t" || card.kind === "k" ? `<h2 class="rev-term">${escapeHtml(card.front)}</h2>` : faceHtml(card.front)}
        </div>
        ${back}
      </article>
      ${grade}
      <button type="button" class="rev-open-topic" data-act="open-topic" data-id="${escapeHtml(card.nodeId)}">Open topic</button>
      <p class="rev-keys">Keyboard: Space shows the answer, then 1 Again, 2 Hard, 3 Good, 4 Easy.</p>
    </div>
  </div>`;
}

function scopeLabel() {
  const st = appState();
  const names = (st.subjects || []).filter((s) => scope.branchIds.includes(s.rootId)).map((s) => s.title);
  const mode = scope.mode === "practice" ? "Practice" : scope.mode === "keypoints" ? "Key points" : "Flashcards";
  if (names.length <= 2) return `${mode} · ${names.join(", ") || "this scope"}`;
  return `${mode} · ${names.length} branches`;
}

function renderSummary() {
  const done = session?.done || [];
  const total = done.length;
  const goodEasy = done.filter((d) => d.grade === "good" || d.grade === "easy").length;
  const pct = total ? Math.round((100 * goodEasy) / total) : 0;
  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const d of done) counts[d.grade] += 1;
  const { cards } = currentCatalog();
  const leftover = buildQueue(store, cards).length;

  return `<div class="rev-page">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="to-hub" aria-label="Back to revision options">Back</button>
      <div class="rev-top-title">
        <h1>Session summary</h1>
        <p class="rev-kicker">${escapeHtml(scopeLabel())}</p>
      </div>
    </div>
    <div class="rev-body">
      <section class="rev-card-block">
        <p class="rev-summary-hero">${total} card${total === 1 ? "" : "s"} reviewed</p>
        <p class="rev-assess">${total ? `You rated ${pct}% Good or Easy (${goodEasy} of ${total}).` : "No cards were rated in this session."}</p>
        <p class="rev-disclaimer">This is a self-assessment of the cards you just rated, not a predicted exam score.</p>
        <dl class="rev-stats">
          <div><dt>Again</dt><dd>${counts.again}</dd></div>
          <div><dt>Hard</dt><dd>${counts.hard}</dd></div>
          <div><dt>Good</dt><dd>${counts.good}</dd></div>
          <div><dt>Easy</dt><dd>${counts.easy}</dd></div>
        </dl>
        <div class="rev-start-row">
          <button type="button" class="solid" data-act="to-hub">Back to options</button>
          ${leftover ? `<button type="button" class="tool" data-act="start">Study ${leftover} more due</button>` : ""}
        </div>
      </section>
    </div>
  </div>`;
}

function onClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || !hooks.els.revise.contains(btn)) return;
  const act = btn.dataset.act;
  if (act === "leave") {
    hooks.leaveRevise?.();
  } else if (act === "to-hub") {
    view = "hub";
    revealed = false;
    render();
  } else if (act === "start") {
    startSession();
  } else if (act === "reveal") {
    reveal();
  } else if (act === "grade") {
    applyGrade(btn.dataset.grade);
  } else if (act === "open-topic") {
    hooks.openNode?.(btn.dataset.id, { push: true });
  } else if (act === "export") {
    doExport();
  } else if (act === "import") {
    hooks.els.revise.querySelector("#rev-import-file")?.click();
  } else if (act === "reset") {
    doReset();
  }
}

function onChange(e) {
  const t = e.target;
  if (!hooks.els.revise.contains(t)) return;
  if (t.dataset.act === "branch") {
    const id = t.value;
    const set = new Set(scope.branchIds);
    if (t.checked) set.add(id);
    else set.delete(id);
    scope.branchIds = [...set];
    // Drop sections that no longer belong
    const allowed = new Set(sectionOptions().map((s) => s.id));
    scope.sectionIds = scope.sectionIds.filter((id) => allowed.has(id));
    if (!cyberSelected()) scope.domainIds = [];
    persistScope();
    render();
  } else if (t.dataset.act === "section") {
    const set = new Set(scope.sectionIds);
    if (t.checked) set.add(t.value);
    else set.delete(t.value);
    scope.sectionIds = [...set];
    persistScope();
    render();
  } else if (t.dataset.act === "domain") {
    const set = new Set(scope.domainIds);
    if (t.checked) set.add(t.value);
    else set.delete(t.value);
    scope.domainIds = [...set];
    persistScope();
    render();
  } else if (t.dataset.act === "exam-ver") {
    scope.examVersion = t.value === "701" ? "701" : "801";
    persistScope();
    render();
  } else if (t.dataset.act === "mode") {
    scope.mode = t.value === "practice" || t.value === "keypoints" ? t.value : "flashcards";
    persistScope();
    render();
  } else if (t.id === "rev-import-file") {
    const file = t.files?.[0];
    t.value = "";
    if (file) doImport(file);
  }
}

function onInput(e) {
  const t = e.target;
  if (t?.dataset.act !== "new-per-day") return;
  const n = setNewPerDay(store, t.value);
  saveStore(store);
  // Don't full-render on every keystroke (would steal focus); just refresh the start button later on change.
  t.addEventListener("change", () => {
    setNewPerDay(store, t.value);
    saveStore(store);
    if (view === "hub") render();
  }, { once: true });
  void n;
}

function startSession() {
  store = loadStore();
  const { cards, failures } = currentCatalog();
  queue = buildQueue(store, cards);
  cursor = 0;
  revealed = false;
  session = { done: [], startedAt: Date.now(), skipped: failures.length };
  if (!queue.length) {
    view = "hub";
    hooks.toast?.("Nothing is due in this scope right now.");
    render();
    return;
  }
  view = "study";
  markCurrentIntroduced();
  render();
  hooks.els.revise.scrollTop = 0;
}

function markCurrentIntroduced() {
  const card = queue[cursor];
  if (!card) return;
  markIntroduced(store, card.id);
  saveStore(store);
}

function reveal() {
  if (view !== "study" || revealed) return;
  revealed = true;
  render();
}

function applyGrade(grade) {
  if (view !== "study" || !revealed) return;
  if (!["again", "hard", "good", "easy"].includes(grade)) return;
  const card = queue[cursor];
  if (!card) return;
  review(store, card.id, grade);
  saveStore(store);
  session.done.push({ id: card.id, grade });
  if (grade === "again") {
    const later = queue.slice(cursor + 1).some((c) => c.id === card.id);
    if (!later) queue.push(card);
  }
  cursor += 1;
  revealed = false;
  if (cursor >= queue.length) {
    view = "summary";
    render();
    hooks.els.revise.scrollTop = 0;
    return;
  }
  markCurrentIntroduced();
  render();
  hooks.els.revise.scrollTop = 0;
}

function onKey(e) {
  if (!isReviseVisible() || view !== "study") return;
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    if (!revealed) reveal();
    return;
  }
  if (!revealed) return;
  if (e.key === "1") { e.preventDefault(); applyGrade("again"); }
  else if (e.key === "2") { e.preventDefault(); applyGrade("hard"); }
  else if (e.key === "3") { e.preventDefault(); applyGrade("good"); }
  else if (e.key === "4") { e.preventDefault(); applyGrade("easy"); }
}

function doExport() {
  const json = exportProgress(store);
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  const day = new Date().toISOString().slice(0, 10);
  a.href = URL.createObjectURL(blob);
  a.download = `kc-revise-progress-${day}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  hooks.toast?.("Progress file downloaded. It contains ids and review dates only, not the card text.");
}

async function doImport(file) {
  try {
    const text = await file.text();
    const replace = window.confirm("Replace your current revision progress with this file? Click Cancel to merge the file into what is already on this device.");
    store = mergeImport(store, text, { replace });
    saveStore(store);
    restoreScope();
    view = "hub";
    render();
    hooks.toast?.(replace ? "Progress replaced from the file." : "Progress merged from the file.");
  } catch (err) {
    hooks.toast?.("That file could not be imported. Use a progress export from this app.");
  }
}

function doReset() {
  const ok = window.confirm("Reset all revision progress on this device? This cannot be undone unless you have an export.");
  if (!ok) return;
  resetProgress(store);
  saveStore(store);
  view = "hub";
  session = null;
  queue = [];
  render();
  hooks.toast?.("Revision progress has been cleared.");
}
