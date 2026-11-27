/**
 * Revision / quiz UI. Card text stays in memory after unlock.
 * Scheduling writes only ids and SM-2 fields to localStorage.
 */
import { escapeHtml, renderNotes, sanitizeDiagramSvg } from "./notes.js";
import { wrapPanelAbbrs } from "./abbr.js";
import { allocateMockQuestions, collectCards, domainsForVersion, MOCK_EXAMS, SY0_VERSIONS } from "./cards.js";
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
  sanitizeScope,
  isDue,
} from "./schedule.js";
import {
  PASS_PCT,
  appendMockAttempt,
  historySummary,
  loadMockHistory,
  makeAttemptId,
  saveMockHistory,
  weakestDomain,
} from "./progress.js";
import {
  clearPbqCache,
  formatPbqScore,
  gradePbq,
  loadPbqPack,
  loadPbqProgress,
  recordPbqAttempt,
  scenarioMatches,
  shuffledOrder,
} from "./pbq.js";

const EXAM_VER_KEY = "kc-sy0-version-v1";
const CARD_MODES = ["flashcards", "practice", "keypoints"];

let hooks = null;
let store = null;
let view = "hub";
let scope = { branchIds: [], sectionIds: [], domainIds: [], mode: "flashcards", examVersion: "801" };
let queue = [];
let cursor = 0;
let revealed = false;
let session = null;
let bound = false;
let mock = null;
let mockTimer = 0;
let historyExpanded = false;
let hubTab = "study";
let pbqPack = null;
let pbqLoading = false;
let pbqEpoch = 0;
let pbqRun = null;

const PBQ_TYPE_LABEL = {
  order: "Order",
  match: "Match",
  triage: "Triage",
  select: "Select",
  config: "Config",
};

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

export function showRevise({ keepScope = false } = {}) {
  if (!hooks) return;
  store = loadStore();
  if (!keepScope) restoreScope();
  const sticky = view === "study" || view === "summary" || view === "mock" || view === "mock-summary" || view === "mock-review" || view === "pbq";
  if (!sticky) view = "hub";
  const el = hooks.els.revise;
  el.hidden = false;
  document.body.classList.add("revise-open");
  hooks.els.reviseBtn?.classList.add("active");
  hooks.els.reviseBtn?.setAttribute("aria-current", "page");
  render();
}

export function hideRevise() {
  if (!hooks) return;
  stopMockTimer();
  if (hooks.els.revise) {
    hooks.els.revise.innerHTML = "";
    hooks.els.revise.hidden = true;
  }
  document.body.classList.remove("revise-open");
  hooks.els.reviseBtn?.classList.remove("active");
  hooks.els.reviseBtn?.removeAttribute("aria-current");
  hooks.onDueChange?.();
}

/** Drop in-memory card text (call when locking the vault). */
export function getReviseSnapshot() {
  return {
    view,
    cursor,
    revealed,
    hubTab: hubTab === "pbq" ? "pbq" : "study",
    scope: { branchIds: [...(scope.branchIds || [])], sectionIds: [...(scope.sectionIds || [])], domainIds: [...(scope.domainIds || [])], mode: scope.mode, examVersion: scope.examVersion === "701" ? "701" : "801" },
  };
}

export function restoreRevise(snap) {
  if (!snap) return;
  if (snap.scope) scope = { ...scope, ...snap.scope };
  if (snap.hubTab === "pbq" || snap.hubTab === "study") hubTab = snap.hubTab;
  view = snap.view || view;
  cursor = Number.isFinite(snap.cursor) ? snap.cursor : cursor;
  revealed = !!snap.revealed;
  render();
}

export function getReviseStore() {
  return store || loadStore();
}

export function currentExamVersion() {
  return readExamVersion();
}

export function applyImportedExamVersion(ver) {
  writeExamVersion(ver === "701" ? "701" : "801");
}

/** Reload scheduling after a progress import and return to the Revise hub. */
export function reloadReviseFromStorage() {
  store = loadStore();
  if (!hooks || !isReviseVisible()) return;
  restoreScope();
  stopMockTimer();
  mock = null;
  view = "hub";
  queue = [];
  session = null;
  revealed = false;
  cursor = 0;
  render();
}

export function clearReviseSession() {
  stopMockTimer();
  mock = null;
  view = "hub";
  hubTab = "study";
  queue = [];
  session = null;
  revealed = false;
  cursor = 0;
  pbqEpoch += 1;
  pbqPack = null;
  pbqLoading = false;
  pbqRun = null;
  clearPbqCache();
  hideRevise();
}

/**
 * Open Revise already filtered to a subject or a branch inside it.
 * `dueOnly` starts a session of cards that are due across the compendium.
 */
export function openReviseForScope({ branchId, sectionId, dueOnly = false } = {}) {
  if (!hooks) return;
  store = loadStore();
  restoreScope();
  if (branchId) {
    scope.branchIds = [branchId];
    scope.sectionIds = sectionId ? [sectionId] : [];
    scope.domainIds = [];
    persistScope();
  }
  stopMockTimer();
  mock = null;
  hubTab = "study";
  if (dueOnly) {
    startDueSession();
    return;
  }
  view = "hub";
  revealed = false;
  queue = [];
  session = null;
  cursor = 0;
  render();
}

/** How many loaded cards are due today, across every branch and card kind. */
export function getDueCount(now = Date.now()) {
  if (!hooks?.getState) return 0;
  const st = hooks.getState();
  if (!st?.index) return 0;
  const saved = loadStore();
  let n = 0;
  for (const card of everyCard(st)) {
    if (isDue(saved.cards?.[card.id], now)) n += 1;
  }
  return n;
}

export function isReviseVisible() {
  return Boolean(hooks?.els?.revise) && !hooks.els.revise.hidden;
}

/** Ask before discarding an in-progress mock. Returns false if the user cancels. */
export function prepareToLeaveRevise() {
  return confirmLeaveMock();
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
      examVersion: readExamVersion(),
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
  scope.examVersion = readExamVersion();
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
  if (view === "mock" && mock && Date.now() >= mock.endsAt) {
    finishMock("time");
    return;
  }
  if (view === "pbq" && !currentPbq()) {
    view = "hub";
    hubTab = "pbq";
  }
  if (view === "study") el.innerHTML = renderStudy();
  else if (view === "summary") el.innerHTML = renderSummary();
  else if (view === "mock") el.innerHTML = renderMock();
  else if (view === "mock-summary") el.innerHTML = renderMockSummary();
  else if (view === "mock-review") el.innerHTML = renderMockReview();
  else if (view === "pbq") el.innerHTML = renderPbq();
  else el.innerHTML = renderHub();
  if (view === "pbq") {
    wrapPanelAbbrs(el.querySelector(".rev-study-body") || el, "cybersecurity");
  } else if (view === "study") {
    const card = queue[cursor];
    wrapPanelAbbrs(el.querySelector(".rev-study-body") || el, card?.branchSlug || "");
  } else if (view === "mock" || view === "mock-review") {
    const item = view === "mock" ? mock?.items?.[mock.cursor] : null;
    wrapPanelAbbrs(el.querySelector(".rev-study-body") || el, item?.card?.branchSlug || "");
  }
  if (view === "mock") ensureMockTimer();
  else stopMockTimer();
}

function renderHub() {
  if (hubTab === "pbq") return renderPbqHub();
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
        <p class="rev-kicker">Flashcards, key points, practice questions, and performance-based scenarios.</p>
      </div>
    </div>
    <div class="rev-body">
      ${revTabs()}
      <div id="rev-tab-panel" role="tabpanel" aria-labelledby="rev-tab-study">
      <section class="rev-card-block">
        <h2>What to study</h2>
        <div class="rev-fieldset">
          <div class="rev-legend">Branches</div>
          <div class="rev-checks">${branchBoxes}</div>
        </div>
        ${sectionHtml}
        ${extraSectionNote()}
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

      ${renderMockLauncher(showDomains)}

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

      <section class="rev-card-block" id="rev-progress-sync">
        <h2>Progress sync</h2>
        <p class="rev-fine">Move scheduling, mock history, bookmarks, recent topics, personal notes, PBQ scores, and display preferences between devices. The compendium’s topic text is not included. Export is encrypted with this compendium’s passphrase unless you choose plain JSON.</p>
        <div class="rev-data-row rev-sync-row">
          <button type="button" class="tool" data-act="export">Export progress</button>
          <button type="button" class="tool" data-act="export-plain">Plain JSON</button>
          <button type="button" class="tool" data-act="import">Import progress</button>
          <button type="button" class="tool danger" data-act="reset">Reset scheduling</button>
        </div>
      </section>
      </div>
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
  if (session?.dueOnly) return "Due today";
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
          ${!session?.dueOnly && leftover ? `<button type="button" class="tool" data-act="start">Study ${leftover} more due</button>` : ""}
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
    if (!confirmLeaveMock()) return;
    hooks.leaveRevise?.();
  } else if (act === "to-hub") {
    if (!confirmLeaveMock()) return;
    stopMockTimer();
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
    hooks.exportStudyProgress?.({ plain: false });
  } else if (act === "export-plain") {
    hooks.exportStudyProgress?.({ plain: true });
  } else if (act === "import") {
    hooks.promptImportProgress?.();
  } else if (act === "drill") {
    startDrill(btn.dataset.domain, btn.dataset.exam);
  } else if (act === "clear-history") {
    clearMockHistory();
  } else if (act === "history-more") {
    historyExpanded = true;
    render();
  } else if (act === "history-less") {
    historyExpanded = false;
    render();
  } else if (act === "reset") {
    doReset();
  } else if (act === "mock-start") {
    startMock(btn.dataset.len);
  } else if (act === "mock-flag") {
    toggleMockFlag();
  } else if (act === "mock-reveal") {
    revealMock();
  } else if (act === "mock-grade") {
    gradeMock(btn.dataset.grade);
  } else if (act === "mock-prev") {
    stepMock(-1);
  } else if (act === "mock-next") {
    stepMock(1);
  } else if (act === "mock-end") {
    finishMock("user");
  } else if (act === "mock-review") {
    view = "mock-review";
    render();
    hooks.els.revise.scrollTop = 0;
  } else if (act === "mock-summary") {
    view = "mock-summary";
    render();
    hooks.els.revise.scrollTop = 0;
  } else if (act === "clear-section") {
    scope.sectionIds = scope.sectionIds.filter((id) => id !== btn.dataset.id);
    persistScope();
    render();
  } else if (act === "hub-tab") {
    if (!confirmLeaveMock()) return;
    stopMockTimer();
    mock = null;
    hubTab = btn.dataset.tab === "pbq" ? "pbq" : "study";
    view = "hub";
    revealed = false;
    render();
  } else if (act === "pbq-open") {
    openPbq(btn.dataset.id);
  } else if (act === "pbq-up" || act === "pbq-down") {
    movePbqItem(btn.dataset.id, act === "pbq-up" ? -1 : 1);
  } else if (act === "pbq-check") {
    checkPbq();
  } else if (act === "pbq-retry") {
    retryPbq();
  } else if (act === "pbq-next") {
    nextPbq();
  } else if (act === "pbq-back") {
    view = "hub";
    hubTab = "pbq";
    render();
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
    writeExamVersion(t.value === "701" ? "701" : "801");
    persistScope();
    render();
  } else if (t.dataset.act === "mode") {
    scope.mode = t.value === "practice" || t.value === "keypoints" ? t.value : "flashcards";
    persistScope();
    render();
  } else if (t.dataset.act === "pbq-pick") {
    if (!pbqRun || pbqRun.grade) return;
    pbqRun.picks[t.dataset.item] = t.value;
  } else if (t.dataset.act === "pbq-toggle") {
    if (!pbqRun || pbqRun.grade) return;
    const set = new Set(pbqRun.selected);
    if (t.checked) set.add(t.value);
    else set.delete(t.value);
    pbqRun.selected = [...set];
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
    hooks.onDueChange?.();
    return;
  }
  markCurrentIntroduced();
  render();
  hooks.els.revise.scrollTop = 0;
}

function onKey(e) {
  if (!isReviseVisible()) return;
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return;
  if (view === "mock") {
    onMockKey(e);
    return;
  }
  if (view !== "study") return;
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

function doReset() {
  const ok = window.confirm("Reset all revision progress on this device? This cannot be undone unless you have an export.");
  if (!ok) return;
  resetProgress(store);
  saveStore(store);
  view = "hub";
  session = null;
  queue = [];
  render();
  hooks.onDueChange?.();
  hooks.toast?.("Revision progress has been cleared.");
}

function readExamVersion() {
  try {
    const v = localStorage.getItem(EXAM_VER_KEY);
    if (v === "701" || v === "801") return v;
  } catch { /* ignore */ }
  return "801";
}

function writeExamVersion(ver) {
  scope.examVersion = ver === "701" ? "701" : "801";
  try { localStorage.setItem(EXAM_VER_KEY, scope.examVersion); } catch { /* ignore */ }
}

function cyberSubject() {
  return (appState().subjects || []).find((s) => s.slug === "cybersecurity") || null;
}

function everyCard(st = appState()) {
  if (!st?.index) return [];
  const out = [];
  for (const mode of CARD_MODES) {
    const { cards } = collectCards(st.index, st.subjects, {
      branchIds: [],
      sectionIds: [],
      domainIds: [],
      mode,
    });
    out.push(...cards);
  }
  return out;
}

function startDueSession() {
  store = loadStore();
  const saved = store;
  const due = everyCard().filter((card) => isDue(saved.cards?.[card.id]));
  due.sort((a, b) => {
    const da = saved.cards[a.id]?.due || 0;
    const db = saved.cards[b.id]?.due || 0;
    return da - db || a.id.localeCompare(b.id);
  });
  queue = due;
  cursor = 0;
  revealed = false;
  session = { done: [], startedAt: Date.now(), skipped: 0, dueOnly: true };
  if (!queue.length) {
    view = "hub";
    hooks.toast?.("Nothing is due right now.");
    render();
    return;
  }
  view = "study";
  markCurrentIntroduced();
  render();
  if (hooks.els.revise) hooks.els.revise.scrollTop = 0;
}

function extraSectionNote() {
  const known = new Set(sectionOptions().map((s) => s.id));
  const extras = (scope.sectionIds || []).filter((id) => !known.has(id));
  if (!extras.length) return "";
  const st = appState();
  const chips = extras.map((id) => {
    const title = st.index?.byId.get(id)?.title || id;
    return `<button type="button" class="rev-focus-chip" data-act="clear-section" data-id="${escapeHtml(id)}">${escapeHtml(title)} <span aria-hidden="true">×</span></button>`;
  }).join("");
  return `<p class="rev-focus">Limited to ${chips}</p>`;
}

function examVersionControl() {
  const ver = scope.examVersion === "701" ? "701" : "801";
  return Object.entries(SY0_VERSIONS).map(([k, v]) => `
    <label class="rev-ver ${ver === k ? "on" : ""}">
      <input type="radio" name="rev-exam-ver" data-act="exam-ver" value="${k}" ${ver === k ? "checked" : ""}>
      <span>${escapeHtml(v.label)}</span>
    </label>`).join("");
}

function renderMockLauncher(showDomains) {
  const cyber = cyberSubject();
  if (!cyber) return "";
  const ver = scope.examVersion === "701" ? "701" : "801";
  const meta = SY0_VERSIONS[ver] || SY0_VERSIONS["801"];
  const buttons = MOCK_EXAMS.map((exam) => `
    <button type="button" class="rev-mock-len" data-act="mock-start" data-len="${exam.id}">
      <strong>${escapeHtml(exam.label)}</strong>
      <span>${exam.questions} Qs · ${exam.minutes} min</span>
    </button>`).join("");
  const versionLine = showDomains
    ? `<p class="rev-fine">Draws practice questions, then flashcards, in the <strong>${escapeHtml(meta.code)}</strong> domain weights selected above.</p>`
    : `<div class="rev-legend">Exam version <span class="rev-ver-switch" role="radiogroup" aria-label="Security+ exam version">${examVersionControl()}</span></div>
       <p class="rev-fine">Questions are drawn in the official <strong>${escapeHtml(meta.code)}</strong> domain weights. Practice questions are used first, then flashcards if a domain runs short.</p>`;
  return `<section class="rev-card-block rev-mock-launch">
    <h2>Security+ Mock Exam</h2>
    ${versionLine}
    <div class="rev-mock-lengths">${buttons}</div>
    <p class="rev-fine">A mock stays in this session. It does not change your spaced-repetition schedule. Passing line used here: ${PASS_PCT}% (750 out of 900). Finished attempts are saved on this device.</p>
    ${renderMockHistory(ver)}
  </section>`;
}

function shuffleCopy(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function startMock(lengthId) {
  const preset = MOCK_EXAMS.find((exam) => exam.id === lengthId) || MOCK_EXAMS[0];
  const cyber = cyberSubject();
  if (!cyber) {
    hooks.toast?.("Security+ mock exams use the Cybersecurity branch.");
    return;
  }
  const ver = scope.examVersion === "701" ? "701" : "801";
  const domains = domainsForVersion(ver);
  const st = appState();
  const buckets = new Map();
  for (const domain of domains) {
    const filter = { branchIds: [cyber.rootId], sectionIds: [], domainIds: [domain.id] };
    const practice = collectCards(st.index, st.subjects, { ...filter, mode: "practice" }).cards;
    const terms = collectCards(st.index, st.subjects, { ...filter, mode: "flashcards" }).cards;
    buckets.set(domain.id, { practice, terms });
  }
  const available = {};
  for (const domain of domains) {
    const bucket = buckets.get(domain.id);
    available[domain.id] = bucket.practice.length + bucket.terms.length;
  }
  const alloc = allocateMockQuestions(domains, preset.questions, available);
  const items = [];
  for (const row of alloc) {
    const bucket = buckets.get(row.id);
    const fromPractice = Math.min(bucket.practice.length, row.drawn);
    const fromTerms = Math.max(0, row.drawn - fromPractice);
    const chosen = [
      ...shuffleCopy(bucket.practice).slice(0, fromPractice),
      ...shuffleCopy(bucket.terms).slice(0, fromTerms),
    ];
    for (const card of chosen) {
      items.push({
        card,
        domainId: row.id,
        domainLabel: row.label,
        flagged: false,
        revealed: false,
        grade: null,
      });
    }
  }
  if (!items.length) {
    hooks.toast?.("No practice questions or flashcards are available for this exam version.");
    return;
  }
  const ordered = shuffleCopy(items);
  const code = (SY0_VERSIONS[ver] || SY0_VERSIONS["801"]).code;
  const drawn = items.length;
  const mix = alloc.map((row, i) => `${i + 1}:${row.drawn}`).join(" · ");
  const note = (drawn < preset.questions
    ? `Drew ${drawn} of ${preset.questions} — only ${drawn} practice and flashcard items were available.`
    : `Drew ${drawn} questions to the ${code} domain weights.`) + ` By domain: ${mix}.`;
  mock = {
    lengthId: preset.id,
    label: preset.label,
    minutes: preset.minutes,
    requested: preset.questions,
    version: ver,
    code,
    note,
    alloc,
    endsAt: Date.now() + preset.minutes * 60 * 1000,
    items: ordered,
    cursor: 0,
    endedBecause: null,
    historyId: makeAttemptId(),
    startedAt: Date.now(),
    finishedAt: 0,
    saved: false,
  };
  view = "mock";
  render();
  if (hooks.els.revise) hooks.els.revise.scrollTop = 0;
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function stopMockTimer() {
  if (mockTimer) {
    clearInterval(mockTimer);
    mockTimer = 0;
  }
}

function ensureMockTimer() {
  if (mockTimer || view !== "mock" || !mock) return;
  mockTimer = setInterval(tickMockClock, 250);
}

function tickMockClock() {
  if (view !== "mock" || !mock) {
    stopMockTimer();
    return;
  }
  const left = mock.endsAt - Date.now();
  const el = hooks?.els?.revise?.querySelector("[data-mock-clock]");
  if (el) {
    el.textContent = formatClock(left);
    el.classList.toggle("is-low", left <= 60 * 1000);
  }
  if (left <= 0) finishMock("time");
}

function mockItem() {
  return mock?.items?.[mock.cursor] || null;
}

function renderMock() {
  const item = mockItem();
  if (!mock || !item) return renderMockSummary();
  const total = mock.items.length;
  const n = mock.cursor + 1;
  const card = item.card;
  const flagged = mock.items.filter((row) => row.flagged).length;
  const backLabel = card.kind === "k" ? "Key points" : "Answer";
  const back = item.revealed
    ? `<div class="rev-face rev-answer"><div class="rev-face-label">${backLabel}</div>${faceHtml(card.back)}</div>`
    : "";
  const grades = item.revealed
    ? `<div class="rev-mock-grades" role="group" aria-label="Grade this question">
        <button type="button" class="rev-mock-grade got${item.grade === "got" ? " on" : ""}" data-act="mock-grade" data-grade="got">Got it</button>
        <button type="button" class="rev-mock-grade missed${item.grade === "missed" ? " on" : ""}" data-act="mock-grade" data-grade="missed">Missed it</button>
      </div>`
    : `<button type="button" class="solid rev-reveal" data-act="mock-reveal">Show answer</button>`;
  const front = card.kind === "t" || card.kind === "k"
    ? `<h2 class="rev-term">${escapeHtml(card.front)}</h2>`
    : faceHtml(card.front);
  const faceLabel = card.kind === "t" ? "Term" : card.kind === "k" ? "Topic" : "Question";
  return `<div class="rev-page rev-study">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="to-hub">Back</button>
      <div class="rev-top-title">
        <h1>${escapeHtml(mock.code)} mock</h1>
        <p class="rev-kicker">${escapeHtml(mock.label)} · Q ${n} / ${total}</p>
      </div>
      <div class="rev-mock-clock" data-mock-clock role="timer" aria-live="off">${formatClock(mock.endsAt - Date.now())}</div>
    </div>
    <div class="rev-progress-bar" aria-hidden="true"><span style="width:${Math.round(((n - 1) / total) * 100)}%"></span></div>
    <p class="rev-fine">${escapeHtml(mock.note)}</p>
    <div class="rev-body rev-study-body">
      <article class="rev-flash">
        <p class="rev-source">${escapeHtml(item.domainLabel)} · ${escapeHtml(card.title || "")}</p>
        <div class="rev-face rev-front">
          <div class="rev-face-label">${faceLabel}</div>
          ${front}
        </div>
        ${back}
      </article>
      <div class="rev-mock-tools">
        <button type="button" class="rev-flag${item.flagged ? " on" : ""}" data-act="mock-flag" aria-pressed="${item.flagged ? "true" : "false"}">${item.flagged ? "★ Flagged" : "☆ Flag for review"}</button>
        <span class="rev-fine">${flagged ? `${flagged} flagged` : ""}</span>
      </div>
      ${grades}
      <div class="rev-mock-nav">
        <button type="button" class="tool" data-act="mock-prev" ${mock.cursor === 0 ? "disabled" : ""}>Previous</button>
        <button type="button" class="tool" data-act="mock-next" ${mock.cursor >= total - 1 ? "disabled" : ""}>Next</button>
        <button type="button" class="solid" data-act="mock-end">Finish mock</button>
      </div>
      <p class="rev-keys">Space shows the answer. G got it, M missed it, F flags. Arrows move between questions.</p>
    </div>
  </div>`;
}

function mockScore() {
  const items = mock?.items || [];
  const total = items.length;
  const got = items.filter((item) => item.grade === "got").length;
  const missed = items.filter((item) => item.grade === "missed").length;
  const unanswered = items.filter((item) => !item.grade).length;
  const flagged = items.filter((item) => item.flagged).length;
  const pct = total ? Math.round((100 * got) / total) : 0;
  return { total, got, missed, unanswered, flagged, pct, passed: pct >= 83 };
}

function renderMockSummary() {
  if (!mock) return renderHub();
  ensureMockSaved();
  const score = mockScore();
  const weak = weakestDomain(mockDomainStats());
  const verdict = score.total
    ? (score.passed
      ? `${score.pct}% is at or above the 83% line (750 out of 900).`
      : `${score.pct}% is below the 83% line (750 out of 900).`)
    : "No questions were in this mock.";
  const timeBits = [];
  if (mock.endedBecause === "time") timeBits.push("Time ran out.");
  if (score.unanswered) timeBits.push("Unanswered questions count as missed.");
  const timeNote = timeBits.length ? ` ${timeBits.join(" ")}` : "";
  const rows = (mock.alloc || []).map((row) => {
    const group = mock.items.filter((item) => item.domainId === row.id);
    const correct = group.filter((item) => item.grade === "got").length;
    const n = group.length;
    const pct = n ? `${Math.round((100 * correct) / n)}%` : "—";
    return `<tr>
      <th scope="row">${escapeHtml(row.label)}</th>
      <td>${correct}</td>
      <td>${n}</td>
      <td>${pct}</td>
    </tr>`;
  }).join("");
  const reviewN = score.missed + score.unanswered;
  return `<div class="rev-page">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="to-hub">Back</button>
      <div class="rev-top-title">
        <h1>Mock summary</h1>
        <p class="rev-kicker">${escapeHtml(mock.code)} · ${escapeHtml(mock.label)}</p>
      </div>
    </div>
    <div class="rev-body">
      <section class="rev-card-block">
        <p class="rev-summary-hero ${score.passed ? "rev-pass" : "rev-fail"}">${score.pct}%</p>
        <p class="rev-assess">${score.passed ? "Estimated pass." : "Not at the passing line yet."} ${escapeHtml(verdict)}</p>
        <p class="rev-disclaimer">This is a self-check on the questions in this mock, not an official CompTIA score. Security+ is scored from 100 to 900, and 750 is the published passing score, about 83%.${escapeHtml(timeNote)}</p>
        <p class="rev-fine">${escapeHtml(mock.note)}</p>
        <dl class="rev-stats">
          <div><dt>Correct</dt><dd>${score.got}</dd></div>
          <div><dt>Missed</dt><dd>${score.missed}</dd></div>
          <div><dt>Unanswered</dt><dd>${score.unanswered}</dd></div>
          <div><dt>Flagged</dt><dd>${score.flagged}</dd></div>
        </dl>
        <h3 class="rev-sub">By domain</h3>
        <div class="rev-table-wrap">
          <table class="rev-table">
            <thead>
              <tr><th>Domain</th><th>Correct</th><th>Questions</th><th>Score</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="rev-start-row">
          <button type="button" class="solid" data-act="to-hub">Back to options</button>
          ${weak ? `<button type="button" class="solid" data-act="drill" data-domain="${escapeHtml(weak.id)}" data-exam="${mock.version === "701" ? "701" : "801"}">Drill weakest domain</button>` : ""}
          <button type="button" class="tool" data-act="mock-review" ${reviewN ? "" : "disabled"}>Review missed${reviewN ? ` (${reviewN})` : ""}</button>
        </div>
        ${weak ? `<p class="rev-fine">Lowest domain on this mock: ${escapeHtml(weak.label)} (${weak.pct}%).</p>` : ""}
      </section>
    </div>
  </div>`;
}

function renderMockReview() {
  if (!mock) return renderHub();
  const missed = mock.items.filter((item) => item.grade !== "got");
  const blocks = missed.map((item) => {
    const card = item.card;
    const status = item.grade === "missed" ? "Missed" : "Unanswered";
    const front = card.kind === "t" || card.kind === "k"
      ? `<h2 class="rev-term">${escapeHtml(card.front)}</h2>`
      : faceHtml(card.front);
    return `<article class="rev-flash rev-mock-miss">
      <p class="rev-source">${escapeHtml(status)} · ${escapeHtml(item.domainLabel)} · ${escapeHtml(card.title || "")}</p>
      ${front}
      <div class="rev-face rev-answer"><div class="rev-face-label">Answer</div>${faceHtml(card.back)}</div>
      <button type="button" class="rev-open-topic" data-act="open-topic" data-id="${escapeHtml(card.nodeId)}">Open topic</button>
    </article>`;
  }).join("");
  return `<div class="rev-page">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="mock-summary">Summary</button>
      <div class="rev-top-title">
        <h1>Missed items</h1>
        <p class="rev-kicker">${missed.length} question${missed.length === 1 ? "" : "s"} to look through again</p>
      </div>
    </div>
    <div class="rev-body rev-study-body">
      ${blocks || `<p class="rev-fine">Nothing missed.</p>`}
      <div class="rev-start-row">
        <button type="button" class="solid" data-act="mock-summary">Back to summary</button>
      </div>
    </div>
  </div>`;
}

function revealMock() {
  const item = mockItem();
  if (!item || item.revealed) return;
  item.revealed = true;
  render();
}

function gradeMock(grade) {
  const item = mockItem();
  if (!item || !item.revealed) return;
  if (grade !== "got" && grade !== "missed") return;
  item.grade = grade;
  render();
}

function toggleMockFlag() {
  const item = mockItem();
  if (!item) return;
  item.flagged = !item.flagged;
  render();
}

function stepMock(dir) {
  if (!mock?.items?.length) return;
  const next = mock.cursor + dir;
  if (next < 0 || next >= mock.items.length) return;
  mock.cursor = next;
  render();
  if (hooks.els.revise) hooks.els.revise.scrollTop = 0;
}

function finishMock(reason) {
  if (!mock || view === "mock-summary" || view === "mock-review") return;
  stopMockTimer();
  mock.endedBecause = reason === "time" ? "time" : "user";
  if (!mock.finishedAt) mock.finishedAt = Date.now();
  view = "mock-summary";
  render();
  if (hooks.els.revise) hooks.els.revise.scrollTop = 0;
}

function mockDomainStats() {
  return (mock?.alloc || []).map((row) => {
    const group = (mock.items || []).filter((item) => item.domainId === row.id);
    const correct = group.filter((item) => item.grade === "got").length;
    const total = group.length;
    return {
      id: row.id,
      label: row.label,
      correct,
      total,
      pct: total ? Math.round((100 * correct) / total) : 0,
    };
  }).filter((row) => row.total > 0);
}

function ensureMockSaved() {
  if (!mock || mock.saved) return;
  if (!mock.finishedAt) mock.finishedAt = Date.now();
  const score = mockScore();
  const attempt = {
    id: mock.historyId || makeAttemptId(),
    date: new Date(mock.finishedAt).toISOString(),
    examVersion: mock.version === "701" ? "701" : "801",
    length: mock.requested || score.total,
    total: score.total,
    correct: score.got,
    pct: score.pct,
    passed: score.pct >= PASS_PCT,
    durationSec: Math.max(0, Math.round((mock.finishedAt - (mock.startedAt || mock.finishedAt)) / 1000)),
    domains: mockDomainStats(),
  };
  if (!attempt.total) {
    mock.saved = true;
    return;
  }
  try {
    saveMockHistory(appendMockAttempt(loadMockHistory(), attempt));
  } catch {
    return;
  }
  mock.saved = true;
  hooks.onStudyDataChanged?.();
}

function renderMockHistory(ver) {
  const summary = historySummary(loadMockHistory(), ver);
  if (!summary) return "";
  const code = (SY0_VERSIONS[ver] || SY0_VERSIONS["801"]).code;
  const shown = historyExpanded ? summary.attempts : summary.attempts.slice(0, 6);
  const more = summary.attempts.length - shown.length;
  const weakestNote = summary.weakest
    ? `<p class="rev-fine">Weakest domain across these ${escapeHtml(code)} attempts: ${escapeHtml(summary.weakest.label)} (${summary.weakest.pct}%).</p>`
    : "";
  const trend = [...summary.attempts].reverse().slice(-8).map((attempt) => {
    const cls = attempt.passed ? "mock-pass" : "mock-fail";
    return `<span class="mock-trend-score ${cls}">${attempt.pct}%</span>`;
  }).join("");
  return `<div class="mock-history">
    <h3 class="rev-sub">Mock history</h3>
    <dl class="rev-stats mock-stats">
      <div><dt>Latest</dt><dd>${summary.latest.pct}%</dd></div>
      <div><dt>Best</dt><dd>${summary.best.pct}%</dd></div>
      <div><dt>Average</dt><dd>${summary.average}%</dd></div>
      <div><dt>Attempts</dt><dd>${summary.count}</dd></div>
    </dl>
    <p class="mock-trend" aria-label="Recent scores, oldest to newest">${trend}</p>
    ${weakestNote}
    <div class="rev-data-row">
      ${summary.weakest ? `<button type="button" class="solid" data-act="drill" data-domain="${escapeHtml(summary.weakest.id)}" data-exam="${ver}">Drill weakest domain</button>` : ""}
      ${more > 0 ? `<button type="button" class="tool" data-act="history-more">Show all ${summary.count}</button>` : ""}
      ${historyExpanded && summary.attempts.length > 6 ? `<button type="button" class="tool" data-act="history-less">Show recent</button>` : ""}
      <button type="button" class="tool danger" data-act="clear-history">Clear history</button>
    </div>
    <div class="mock-attempts">${shown.map(renderMockAttempt).join("")}</div>
  </div>`;
}

function renderMockAttempt(attempt) {
  const code = (SY0_VERSIONS[attempt.examVersion] || SY0_VERSIONS["801"]).code;
  const mark = attempt.passed
    ? `<span class="mock-pill mock-pass">Pass</span>`
    : `<span class="mock-pill mock-fail">Below pass</span>`;
  const domains = (attempt.domains || []).map((d) => `<li><span>${escapeHtml(d.label)}</span><span>${d.correct}/${d.total} (${d.pct}%)</span></li>`).join("");
  return `<details class="mock-attempt">
    <summary>
      <span class="mock-when">${escapeHtml(formatWhen(attempt.date))}</span>
      <span class="mock-badge">${escapeHtml(code)}</span>
      <span class="mock-score">${attempt.correct}/${attempt.total} (${attempt.pct}%)</span>
      ${mark}
    </summary>
    <p class="rev-fine">${formatDuration(attempt.durationSec)} · ${attempt.length} requested</p>
    ${domains ? `<ul class="mock-domains">${domains}</ul>` : ""}
  </details>`;
}

function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  try {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m <= 0) return `${r}s`;
  return `${m}m ${String(r).padStart(2, "0")}s`;
}

function startDrill(domainId, examVersion) {
  const id = String(domainId || "");
  if (!id) return;
  if (view === "mock") {
    if (!confirmLeaveMock()) return;
  }
  stopMockTimer();
  mock = null;
  if (examVersion) writeExamVersion(examVersion);
  const cyber = cyberSubject();
  scope.mode = "practice";
  scope.sectionIds = [];
  scope.domainIds = [id];
  if (cyber) scope.branchIds = [cyber.rootId];
  persistScope();
  store = loadStore();
  const { cards } = currentCatalog();
  let next = buildQueue(store, cards);
  if (!next.length) next = shuffleCopy(cards).slice(0, 20);
  if (!next.length) {
    view = "hub";
    hooks.toast?.("No practice questions in that domain yet.");
    render();
    return;
  }
  queue = next;
  cursor = 0;
  revealed = false;
  session = { done: [], startedAt: Date.now(), drill: true };
  view = "study";
  markCurrentIntroduced();
  render();
  if (hooks.els.revise) hooks.els.revise.scrollTop = 0;
}

function clearMockHistory() {
  const ok = window.confirm("Clear all mock exam history on this device? This cannot be undone.");
  if (!ok) return;
  saveMockHistory([]);
  historyExpanded = false;
  hooks.onStudyDataChanged?.();
  if (view !== "hub") view = "hub";
  render();
  hooks.toast?.("Mock exam history cleared.");
}

function confirmLeaveMock() {
  if (view !== "mock" || !mock) return true;
  const ok = window.confirm("Leave this mock exam? Answers in this session will be discarded.");
  if (!ok) return false;
  stopMockTimer();
  mock = null;
  view = "hub";
  return true;
}

function revTabs() {
  const study = hubTab !== "pbq";
  return `<div class="rev-tabs" role="tablist" aria-label="Revise">
    <button type="button" class="rev-tab ${study ? "on" : ""}" role="tab" id="rev-tab-study" aria-selected="${study ? "true" : "false"}" aria-controls="rev-tab-panel" data-act="hub-tab" data-tab="study">Study</button>
    <button type="button" class="rev-tab ${study ? "" : "on"}" role="tab" id="rev-tab-pbq" aria-selected="${study ? "false" : "true"}" aria-controls="rev-tab-panel" data-act="hub-tab" data-tab="pbq">PBQs</button>
  </div>`;
}

function domainFilterHtml() {
  const ver = scope.examVersion === "701" ? "701" : "801";
  const boxes = domainsForVersion(ver).map((d) => {
    const on = scope.domainIds.includes(d.id);
    return `<label class="rev-check">
      <input type="checkbox" data-act="domain" value="${escapeHtml(d.id)}" ${on ? "checked" : ""}>
      <span>${escapeHtml(d.label)}</span>
    </label>`;
  }).join("");
  return `<div class="rev-fieldset">
    <div class="rev-legend">Security+ domains <span class="rev-ver-switch" role="radiogroup" aria-label="Security+ exam version">${examVersionControl()}</span> <span class="rev-hint">(optional — none means every domain)</span></div>
    <div class="rev-checks">${boxes}</div>
  </div>`;
}

function renderPbqHub() {
  if (!pbqPack && !pbqLoading) {
    pbqLoading = true;
    void finishPbqLoad();
  }
  const ver = scope.examVersion === "701" ? "SY0-701" : "SY0-801";
  let body;
  if (!pbqPack) {
    body = `<section class="rev-card-block" aria-busy="true">
      <h2>Performance-based questions</h2>
      <p class="pbq-empty" role="status">Loading scenarios…</p>
    </section>`;
  } else if (!pbqPack.scenarios.length) {
    body = `<section class="rev-card-block">
      <h2>Performance-based questions</h2>
      ${domainFilterHtml()}
      <p class="pbq-empty" role="status">No PBQ scenarios are available yet.</p>
    </section>`;
  } else {
    const list = filteredPbqs();
    const progress = loadPbqProgress(safeStorage());
    const rows = list.map((scenario) => pbqPickRow(scenario, progress[scenario.id])).join("");
    const listHtml = rows
      ? `<div class="pbq-list">${rows}</div>`
      : `<p class="pbq-empty" role="status">No PBQs match this exam and domain filter.</p>`;
    body = `<section class="rev-card-block">
      <h2>Performance-based questions</h2>
      <p class="rev-fine">${list.length} scenario${list.length === 1 ? "" : "s"} for ${escapeHtml(ver)}. Scores stay on this device and travel with progress sync.</p>
      ${domainFilterHtml()}
      ${listHtml}
    </section>`;
  }
  return `<div class="rev-page">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="leave" aria-label="Back to the map">Back</button>
      <div class="rev-top-title">
        <h1>Revise</h1>
        <p class="rev-kicker">Order, match, triage, and configuration scenarios for the active Security+ exam.</p>
      </div>
    </div>
    <div class="rev-body">
      ${revTabs()}
      <div id="rev-tab-panel" role="tabpanel" aria-labelledby="rev-tab-pbq">${body}</div>
    </div>
  </div>`;
}

function pbqPickRow(scenario, rec) {
  const status = pbqStatusText(rec);
  const passed = Boolean(rec?.passed);
  return `<button type="button" class="pbq-pick ${passed ? "is-passed" : ""}" data-act="pbq-open" data-id="${escapeHtml(scenario.id)}">
    <span class="pbq-pick-title">${escapeHtml(scenario.title)}</span>
    <span class="pbq-badges">
      ${scenario.domain ? `<span class="pbq-badge">${escapeHtml(scenario.domain)}</span>` : ""}
      <span class="pbq-badge pbq-badge-type">${escapeHtml(PBQ_TYPE_LABEL[scenario.type] || scenario.type)}</span>
    </span>
    <span class="pbq-status">${escapeHtml(status)}</span>
  </button>`;
}

function pbqStatusText(rec) {
  if (!rec || !(rec.attempts > 0)) return "Not tried";
  const score = formatPbqScore(rec.bestScore, rec.total);
  const tries = `${rec.attempts} attempt${rec.attempts === 1 ? "" : "s"}`;
  if (rec.passed) return `Passed · ${score} · ${tries}`;
  return `Best ${score} · ${tries}`;
}

function filteredPbqs() {
  const ver = scope.examVersion === "701" ? "701" : "801";
  return (pbqPack?.scenarios || []).filter((scenario) => scenarioMatches(scenario, {
    examVersion: ver,
    domainIds: scope.domainIds,
  }));
}

function currentPbq() {
  if (!pbqRun || !pbqPack) return null;
  return pbqPack.scenarios.find((scenario) => scenario.id === pbqRun.id) || null;
}

function safeStorage() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

async function finishPbqLoad() {
  const epoch = pbqEpoch;
  let pack;
  try {
    pack = await loadPbqPack(appState()?.key);
  } catch {
    pack = { version: 1, scenarios: [], missing: true };
  }
  if (epoch !== pbqEpoch) return;
  pbqPack = pack;
  pbqLoading = false;
  if (isReviseVisible() && ((view === "hub" && hubTab === "pbq") || view === "pbq")) render();
}

function freshPbqRun(scenario) {
  return {
    id: scenario.id,
    order: scenario.type === "order" ? shuffledOrder(scenario.items, scenario.answer) : [],
    picks: {},
    selected: [],
    grade: null,
  };
}

function openPbq(id) {
  const scenario = (pbqPack?.scenarios || []).find((item) => item.id === id);
  if (!scenario) return;
  pbqRun = freshPbqRun(scenario);
  view = "pbq";
  render();
  if (hooks.els.revise) hooks.els.revise.scrollTop = 0;
}

function movePbqItem(id, dir) {
  if (!pbqRun || pbqRun.grade || !id) return;
  const order = pbqRun.order || [];
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  const next = order.slice();
  const swap = next[i];
  next[i] = next[j];
  next[j] = swap;
  pbqRun.order = next;
  render();
  const act = dir < 0 ? "pbq-up" : "pbq-down";
  const btn = hooks.els.revise?.querySelector(`[data-act="${act}"][data-id="${CSS.escape(id)}"]`);
  if (btn && !btn.disabled) btn.focus();
  else hooks.els.revise?.querySelector(`[data-act="${dir < 0 ? "pbq-down" : "pbq-up"}"][data-id="${CSS.escape(id)}"]`)?.focus();
}

function responseForPbq(scenario, run) {
  if (scenario.type === "order") return run.order || [];
  if (scenario.type === "match" || scenario.type === "config") return run.picks || {};
  return run.selected || [];
}

function checkPbq() {
  const scenario = currentPbq();
  if (!scenario || !pbqRun || pbqRun.grade) return;
  const grade = gradePbq(scenario, responseForPbq(scenario, pbqRun));
  pbqRun.grade = grade;
  try {
    recordPbqAttempt(safeStorage(), scenario.id, grade);
  } catch { /* private mode */ }
  render();
  hooks.els.revise?.querySelector(".pbq-score")?.focus?.();
}

function retryPbq() {
  const scenario = currentPbq();
  if (!scenario) return;
  pbqRun = freshPbqRun(scenario);
  render();
  if (hooks.els.revise) hooks.els.revise.scrollTop = 0;
}

function nextPbq() {
  const list = filteredPbqs();
  if (!list.length) {
    view = "hub";
    hubTab = "pbq";
    render();
    return;
  }
  const index = list.findIndex((scenario) => scenario.id === pbqRun?.id);
  const next = list[(index + 1) % list.length];
  if (!next || next.id === pbqRun?.id) {
    hooks.toast?.("This is the only PBQ in the current filter.");
    pbqRun = freshPbqRun(next || currentPbq());
    render();
    return;
  }
  openPbq(next.id);
}

function renderPbq() {
  const scenario = currentPbq();
  if (!scenario || !pbqRun) return "";
  const graded = Boolean(pbqRun.grade);
  const score = graded ? formatPbqScore(pbqRun.grade.score, pbqRun.grade.total) : "";
  const controls = scenario.type === "order"
    ? renderPbqOrder(scenario)
    : scenario.type === "match"
      ? renderPbqMatch(scenario)
      : scenario.type === "config"
        ? renderPbqConfig(scenario)
        : renderPbqSelect(scenario);
  const svg = pbqSvgHtml(scenario.svg);
  const explanation = graded && scenario.explanation
    ? `<section class="pbq-explain"><h2>Explanation</h2>${faceHtml(scenario.explanation)}</section>`
    : "";
  const related = graded ? renderPbqRelated(scenario) : "";
  const actions = graded
    ? `<div class="rev-pbq-actions">
        <button type="button" class="tool" data-act="pbq-retry">Try again</button>
        <button type="button" class="solid" data-act="pbq-next">Next PBQ</button>
      </div>`
    : `<div class="rev-pbq-actions">
        <button type="button" class="solid" data-act="pbq-check">Check answer</button>
      </div>`;
  const scoreHtml = graded
    ? `<p class="pbq-score ${pbqRun.grade.exact ? "is-exact" : "is-partial"}" role="status" tabindex="-1">${escapeHtml(score)}</p>`
    : "";
  return `<div class="rev-page rev-study">
    <div class="rev-top">
      <button type="button" class="rev-back" data-act="pbq-back" aria-label="Back to PBQ list">Back</button>
      <div class="rev-top-title">
        <h1>${escapeHtml(scenario.title)}</h1>
        <p class="rev-kicker">${escapeHtml(pbqKicker(scenario))}</p>
      </div>
    </div>
    <div class="rev-body rev-study-body">
      <article class="rev-flash pbq-card">
        <div class="pbq-badges pbq-card-badges">
          ${scenario.domain ? `<span class="pbq-badge">${escapeHtml(scenario.domain)}</span>` : ""}
          <span class="pbq-badge pbq-badge-type">${escapeHtml(PBQ_TYPE_LABEL[scenario.type] || scenario.type)}</span>
        </div>
        ${scenario.prompt ? `<div class="rev-prose pbq-prompt">${faceHtml(scenario.prompt)}</div>` : ""}
        ${svg}
        ${selectHint(scenario)}
        ${controls}
        ${scoreHtml}
        ${explanation}
        ${related}
      </article>
      ${actions}
    </div>
  </div>`;
}

function pbqKicker(scenario) {
  const ver = scope.examVersion === "701" ? "SY0-701" : "SY0-801";
  const bits = [ver, PBQ_TYPE_LABEL[scenario.type] || scenario.type];
  if (scenario.domain) bits.splice(1, 0, `Domain ${scenario.domain}`);
  return bits.join(" · ");
}

function selectHint(scenario) {
  if (scenario.type !== "triage" && scenario.type !== "select") return "";
  const n = scenario.answer?.length || 0;
  if (!n) return "";
  return `<p class="pbq-hint">Select ${n}</p>`;
}

function pbqSvgHtml(svg) {
  const clean = sanitizeDiagramSvg(svg);
  if (!clean) return "";
  return `<figure class="kc-diagram pbq-diagram"><div class="kc-diagram-scroll">${clean}</div></figure>`;
}

function choiceLabel(list, id) {
  const found = (list || []).find((item) => item.id === id);
  return found?.label || id || "";
}

function renderPbqOrder(scenario) {
  const grade = pbqRun.grade;
  const rows = (pbqRun.order || []).map((id, index) => {
    const row = grade?.items?.[index];
    const missed = Boolean(row && !row.correct);
    const cls = !grade ? "" : row?.correct ? "is-correct" : "is-missed";
    const expected = missed ? choiceLabel(scenario.items, row.expected) : "";
    const label = choiceLabel(scenario.items, id);
    const pos = index + 1;
    const upOff = index === 0 || grade;
    const downOff = index === (pbqRun.order.length - 1) || grade;
    return `<li class="pbq-item ${cls}">
      <span class="pbq-pos" aria-hidden="true">${pos}</span>
      <span class="pbq-label">${escapeHtml(label)}</span>
      ${grade ? `<span class="pbq-mark">${row?.correct ? "Correct" : "Missed"}</span>` : ""}
      <span class="pbq-moves">
        <button type="button" data-act="pbq-up" data-id="${escapeHtml(id)}" aria-label="Move ${escapeHtml(label)} up from position ${pos}" ${upOff ? "disabled" : ""}>Move up</button>
        <button type="button" data-act="pbq-down" data-id="${escapeHtml(id)}" aria-label="Move ${escapeHtml(label)} down from position ${pos}" ${downOff ? "disabled" : ""}>Move down</button>
      </span>
      ${missed ? `<p class="pbq-expected">Right answer: ${escapeHtml(expected)}</p>` : ""}
    </li>`;
  }).join("");
  return `<ol class="pbq-order" aria-label="Reorder these items">${rows}</ol>`;
}

function renderPbqMatch(scenario) {
  const grade = pbqRun.grade;
  const rows = (scenario.items || []).map((item) => {
    const row = grade?.items?.find((entry) => entry.id === item.id);
    const missed = Boolean(row && !row.correct);
    const cls = !grade ? "" : row?.correct ? "is-correct" : "is-missed";
    const expected = missed ? choiceLabel(scenario.options, row.expected) : "";
    return `<div class="pbq-row ${cls}">
      <label class="pbq-row-label" for="pbq-pick-${escapeHtml(item.id)}">${escapeHtml(item.label)}</label>
      ${pbqSelect(`pbq-pick-${item.id}`, item.id, scenario.options, pbqRun.picks?.[item.id] || "", gradedDisabled())}
      ${grade ? `<span class="pbq-mark">${row?.correct ? "Correct" : "Missed"}</span>` : ""}
      ${missed ? `<p class="pbq-expected">Right answer: ${escapeHtml(expected)}</p>` : ""}
    </div>`;
  }).join("");
  return `<div class="pbq-match">${rows}</div>`;
}

function renderPbqConfig(scenario) {
  const grade = pbqRun.grade;
  const rows = (scenario.items || []).map((item) => {
    const row = grade?.items?.find((entry) => entry.id === item.id);
    const missed = Boolean(row && !row.correct);
    const cls = !grade ? "" : row?.correct ? "is-correct" : "is-missed";
    const expected = missed ? choiceLabel(item.options, row.expected) : "";
    return `<div class="pbq-row ${cls}">
      <label class="pbq-row-label" for="pbq-pick-${escapeHtml(item.id)}">${escapeHtml(item.label)}</label>
      ${pbqSelect(`pbq-pick-${item.id}`, item.id, item.options, pbqRun.picks?.[item.id] || "", gradedDisabled())}
      ${grade ? `<span class="pbq-mark">${row?.correct ? "Correct" : "Missed"}</span>` : ""}
      ${missed ? `<p class="pbq-expected">Right answer: ${escapeHtml(expected)}</p>` : ""}
    </div>`;
  }).join("");
  return `<div class="pbq-config">${rows}</div>`;
}

function renderPbqSelect(scenario) {
  const grade = pbqRun.grade;
  const selected = new Set(pbqRun.selected || []);
  const rows = (scenario.options || []).map((opt) => {
    const row = grade?.items?.find((entry) => entry.id === opt.id);
    let cls = "";
    let mark = "";
    let expected = "";
    if (row?.hit) {
      cls = "is-correct";
      mark = "Correct";
    } else if (row?.missed) {
      cls = "is-missed";
      mark = "Missed";
      expected = "Right answer";
    } else if (row?.extra) {
      cls = "is-extra";
      mark = "Not part of the answer";
    }
    const on = selected.has(opt.id);
    return `<label class="pbq-option ${cls}">
      <input type="checkbox" data-act="pbq-toggle" value="${escapeHtml(opt.id)}" ${on ? "checked" : ""} ${grade ? "disabled" : ""}>
      <span class="pbq-label">${escapeHtml(opt.label)}</span>
      ${mark ? `<span class="pbq-mark">${escapeHtml(mark)}</span>` : ""}
      ${expected ? `<span class="pbq-expected">${escapeHtml(expected)}</span>` : ""}
    </label>`;
  }).join("");
  return `<div class="pbq-select-list" role="group" aria-label="Select the answers">${rows}</div>`;
}

function gradedDisabled() {
  return pbqRun?.grade ? "disabled" : "";
}

function pbqSelect(fieldId, itemId, options, value, disabled) {
  const opts = [`<option value="">Choose…</option>`].concat((options || []).map((opt) => {
    const on = opt.id === value ? "selected" : "";
    return `<option value="${escapeHtml(opt.id)}" ${on}>${escapeHtml(opt.label)}</option>`;
  }));
  return `<select class="pbq-select" id="${escapeHtml(fieldId)}" data-act="pbq-pick" data-item="${escapeHtml(itemId)}" ${disabled}>${opts.join("")}</select>`;
}

function renderPbqRelated(scenario) {
  const ids = scenario.relatedNodeIds || [];
  if (!ids.length) return "";
  const index = appState()?.index;
  const chips = ids.map((id) => {
    const title = index?.byId?.get(id)?.title || id;
    if (!index?.byId?.has(id)) {
      return `<span class="pbq-chip is-missing">${escapeHtml(title)}</span>`;
    }
    return `<button type="button" class="pbq-chip" data-act="open-topic" data-id="${escapeHtml(id)}">${escapeHtml(title)}</button>`;
  }).join("");
  return `<section class="pbq-related"><h2>Related topics</h2><div class="pbq-chips">${chips}</div></section>`;
}

function onMockKey(e) {
  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    const item = mockItem();
    if (item && !item.revealed) revealMock();
    return;
  }
  if (e.key === "f" || e.key === "F") {
    e.preventDefault();
    toggleMockFlag();
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    stepMock(1);
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    stepMock(-1);
    return;
  }
  const item = mockItem();
  if (!item?.revealed) return;
  if (e.key === "g" || e.key === "G") {
    e.preventDefault();
    gradeMock("got");
  } else if (e.key === "m" || e.key === "M") {
    e.preventDefault();
    gradeMock("missed");
  }
}
