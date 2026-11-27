/**
 * One-click sync of the encrypted progress bundle to a secret GitHub Gist.
 *
 * The personal access token is encrypted with the session unlock key
 * (AES-GCM, AAD "gist-token") before it is written to localStorage.
 * The plaintext token lives only in memory and is dropped on lock.
 * The gist file is the same kc-progress bundle used by file export.
 * This module never puts the token or `kc-gist-sync-v1` into that bundle.
 */
import { decryptUtf8, encryptUtf8 } from "./crypto.js";
import { escapeHtml } from "./notes.js";
import {
  buildProgressBundle,
  collectProgress,
  encryptProgress,
  mergeProgress,
  readProgressPayload,
  writeProgress,
} from "./progress.js";

export const GIST_SYNC_KEY = "kc-gist-sync-v1";
export const GIST_TOKEN_AAD = "gist-token";
export const GIST_FILENAME = "kc-progress.enc.json";
export const GIST_API = "https://api.github.com/gists";
export const AUTO_SYNC_DELAY_MS = 12_000;

const AUTH_MESSAGE = "GitHub rejected the token. It may be invalid or expired, or it is missing the gist scope. Nothing on this device was changed.";
const NOT_FOUND_MESSAGE = "That gist was not found. Check the id, or leave it blank to create a new secret gist. Nothing on this device was changed.";
const DECRYPT_MESSAGE = "Could not decrypt the cloud copy. It needs the same passphrase that unlocked this compendium. Nothing on this device was changed.";
const OFFLINE_MESSAGE = "You appear to be offline. Nothing on this device was changed.";
const NETWORK_MESSAGE = "Could not reach GitHub. Nothing on this device was changed.";
const LOCKED_MESSAGE = "Unlock the compendium before syncing. Nothing on this device was changed.";
const TOKEN_MESSAGE = "Paste a GitHub token with the gist scope.";
const TOKEN_LOCKED_MESSAGE = "The saved GitHub token could not be unlocked with this passphrase. Paste it again and choose Connect & Sync. Nothing on this device was changed.";

function gistError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.name = "GistSyncError";
  return err;
}

function emptyConfig() {
  return { gistId: "", tokenEnc: null, lastSyncAt: null, autoSync: false };
}

function isTokenEnvelope(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.iv === "string" &&
    value.iv &&
    typeof value.ciphertext === "string" &&
    value.ciphertext &&
    !Object.prototype.hasOwnProperty.call(value, "token")
  );
}

/** Accept a gist id or a gist.github.com URL. Blank is valid. Invalid is `null`. */
export function normalizeGistId(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let id = raw;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host === "gist.github.com" || host.endsWith(".gist.github.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      id = parts[parts.length - 1] || "";
    }
  } catch {
    /* not a URL */
  }
  id = id.replace(/\.git$/i, "").trim();
  if (!/^[a-fA-F0-9]{8,64}$/.test(id)) return null;
  return id.toLowerCase();
}

export function loadGistConfig(storage) {
  if (!storage) return emptyConfig();
  let raw;
  try {
    raw = JSON.parse(storage.getItem(GIST_SYNC_KEY) || "null");
  } catch {
    return emptyConfig();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyConfig();
  const gistId = typeof raw.gistId === "string" ? normalizeGistId(raw.gistId) : "";
  const lastSyncAt = typeof raw.lastSyncAt === "string" && raw.lastSyncAt.trim() ? raw.lastSyncAt : null;
  return {
    gistId: gistId || "",
    tokenEnc: isTokenEnvelope(raw.tokenEnc)
      ? { v: 1, iv: raw.tokenEnc.iv, ciphertext: raw.tokenEnc.ciphertext }
      : null,
    lastSyncAt,
    autoSync: raw.autoSync === true,
  };
}

/** Persist config. A plaintext `token` field is never written. */
export function saveGistConfig(storage, config) {
  const prev = loadGistConfig(storage);
  const nextGist = config && Object.prototype.hasOwnProperty.call(config, "gistId")
    ? normalizeGistId(config.gistId)
    : prev.gistId;
  const tokenEnc = config && Object.prototype.hasOwnProperty.call(config, "tokenEnc")
    ? (isTokenEnvelope(config.tokenEnc) ? { v: 1, iv: config.tokenEnc.iv, ciphertext: config.tokenEnc.ciphertext } : null)
    : prev.tokenEnc;
  const lastSyncAt = config && Object.prototype.hasOwnProperty.call(config, "lastSyncAt")
    ? (typeof config.lastSyncAt === "string" && config.lastSyncAt.trim() ? config.lastSyncAt : null)
    : prev.lastSyncAt;
  const autoSync = config && Object.prototype.hasOwnProperty.call(config, "autoSync")
    ? config.autoSync === true
    : prev.autoSync;
  const safe = {
    gistId: nextGist || "",
    tokenEnc,
    lastSyncAt,
    autoSync,
  };
  if (!storage) return safe;
  if (!safe.gistId && !safe.tokenEnc && !safe.lastSyncAt && !safe.autoSync) {
    storage.removeItem?.(GIST_SYNC_KEY);
    return emptyConfig();
  }
  storage.setItem(GIST_SYNC_KEY, JSON.stringify(safe));
  return safe;
}

export function clearGistConfig(storage) {
  storage?.removeItem?.(GIST_SYNC_KEY);
  return emptyConfig();
}

export async function encryptGistToken(key, token) {
  const clean = String(token ?? "").trim();
  if (!clean || clean.length > 512 || /[\r\n]/.test(clean)) {
    throw gistError("token", TOKEN_MESSAGE);
  }
  return encryptUtf8(key, clean, GIST_TOKEN_AAD);
}

export async function decryptGistToken(key, tokenEnc) {
  if (!isTokenEnvelope(tokenEnc)) throw gistError("token", TOKEN_MESSAGE);
  try {
    return await decryptUtf8(key, tokenEnc, GIST_TOKEN_AAD);
  } catch {
    throw gistError("token-locked", TOKEN_LOCKED_MESSAGE);
  }
}

function bundleForCloud(bundle) {
  return buildProgressBundle(bundle || {});
}

function sameProgress(a, b) {
  const strip = (bundle) => {
    const copy = buildProgressBundle(bundle || {});
    delete copy.exportedAt;
    return JSON.stringify(copy);
  };
  return strip(a) === strip(b);
}

function isOfflineError(err) {
  if (typeof navigator !== "undefined" && navigator && navigator.onLine === false) return true;
  if (!err) return false;
  if (err.name === "TypeError") return true;
  return /failed to fetch|networkerror|offline|load failed|network request failed/i.test(String(err.message || ""));
}

function githubHeaders(token, hasBody) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "knowledge-compendium",
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

async function github(fetchImpl, token, url, { method = "GET", body } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== "function") throw gistError("offline", OFFLINE_MESSAGE);
  let res;
  try {
    res = await fetchFn(url, {
      method,
      headers: githubHeaders(token, body != null),
      body: body != null ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
    });
  } catch (err) {
    if (err?.code && err?.name === "GistSyncError") throw err;
    throw gistError(isOfflineError(err) ? "offline" : "network", isOfflineError(err) ? OFFLINE_MESSAGE : NETWORK_MESSAGE);
  }
  if (res.status === 401) throw gistError("unauthorized", AUTH_MESSAGE);
  if (res.status === 403) {
    let message = "";
    try {
      message = JSON.parse(await res.text()).message || "";
    } catch {
      message = "";
    }
    if (/rate limit/i.test(message)) {
      throw gistError("network", "GitHub is rate-limiting requests. Nothing on this device was changed.");
    }
    throw gistError("forbidden", AUTH_MESSAGE);
  }
  if (res.status === 404) throw gistError("not-found", NOT_FOUND_MESSAGE);
  if (!res.ok) throw gistError("network", `GitHub returned an error (${res.status}). Nothing on this device was changed.`);
  if (method === "DELETE") return {};
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw gistError("network", "GitHub returned a response that could not be read. Nothing on this device was changed.");
  }
}

function fileFromGist(gist) {
  const files = gist?.files && typeof gist.files === "object" ? gist.files : {};
  if (files[GIST_FILENAME]) return files[GIST_FILENAME];
  for (const file of Object.values(files)) {
    if (file?.filename === GIST_FILENAME) return file;
  }
  return null;
}

async function readRemote(file, key) {
  if (!file || file.truncated) {
    throw gistError("truncated", "The cloud copy is too large to read from GitHub. Nothing on this device was changed.");
  }
  if (typeof file.content !== "string" || !file.content.trim()) {
    throw gistError("malformed", "The cloud gist has no progress file. Nothing on this device was changed.");
  }
  try {
    return await readProgressPayload(file.content, key);
  } catch (err) {
    if (err?.code === "decrypt") throw gistError("decrypt", DECRYPT_MESSAGE);
    if (err?.code === "locked") throw gistError("locked", LOCKED_MESSAGE);
    throw gistError("malformed", "The cloud copy is not a valid progress file. Nothing on this device was changed.");
  }
}

function payloadBody(content, { create }) {
  const body = {
    files: { [GIST_FILENAME]: { content } },
  };
  if (create) {
    body.description = "Knowledge Compendium progress (encrypted)";
    body.public = false;
  }
  return body;
}

/**
 * Pull, merge, and push. Local progress is written only after GitHub accepts
 * the encrypted bundle. On 401/403, 404, a wrong passphrase, or a network
 * failure the storage progress keys are left untouched.
 */
export async function syncNow({
  key,
  token,
  storage,
  fetchImpl,
  collect,
  applyBundle,
  now = Date.now(),
  gistId,
  tokenEnc,
} = {}) {
  const fail = (err) => ({
    ok: false,
    code: err?.code || "network",
    message: err?.message || NETWORK_MESSAGE,
  });
  try {
    if (!key) throw gistError("locked", LOCKED_MESSAGE);
    const cleanToken = String(token ?? "").trim();
    if (!cleanToken) throw gistError("token", TOKEN_MESSAGE);
    const readLocal = () => (typeof collect === "function" ? collect() : collectProgress(storage));
    const writeLocal = (bundle) => {
      if (typeof applyBundle === "function") applyBundle(bundle);
      else writeProgress(storage, bundle);
    };
    const cfg = loadGistConfig(storage);
    const target = gistId === undefined ? (cfg.gistId || "") : gistId;
    if (target == null) throw gistError("gist-id", "That gist id doesn’t look valid. Paste the id, or leave the field blank to create one.");

    let remote = null;
    let created = false;
    let id = target;
    if (id) {
      const gist = await github(fetchImpl, cleanToken, `${GIST_API}/${encodeURIComponent(id)}`);
      const file = fileFromGist(gist);
      if (file) remote = await readRemote(file, key);
    }

    const baseline = bundleForCloud(readLocal());
    const fresh = bundleForCloud(readLocal());
    const local = mergeProgress(baseline, fresh);
    const merged = remote ? mergeProgress(local, remote) : local;
    const envelope = await encryptProgress(key, bundleForCloud(merged));
    const content = JSON.stringify(envelope);

    if (!id) {
      const createdGist = await github(fetchImpl, cleanToken, GIST_API, {
        method: "POST",
        body: payloadBody(content, { create: true }),
      });
      if (!createdGist?.id || createdGist.public !== false) {
        if (createdGist?.id && createdGist.public !== false) {
          try {
            await github(fetchImpl, cleanToken, `${GIST_API}/${encodeURIComponent(createdGist.id)}`, { method: "DELETE" });
          } catch {
            /* still refuse to keep a gist that was not secret */
          }
        }
        throw gistError("public", "GitHub did not create a secret gist. Nothing on this device was changed.");
      }
      id = String(createdGist.id);
      created = true;
      saveGistConfig(storage, {
        gistId: normalizeGistId(id) || id,
        tokenEnc: tokenEnc || cfg.tokenEnc,
      });
    } else {
      await github(fetchImpl, cleanToken, `${GIST_API}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: payloadBody(content, { create: false }),
      });
    }

    const latest = bundleForCloud(readLocal());
    const finalBundle = mergeProgress(merged, latest);
    writeLocal(finalBundle);
    const lastSyncAt = new Date(now).toISOString();
    const storedId = normalizeGistId(id) || id;
    saveGistConfig(storage, {
      gistId: storedId,
      tokenEnc: tokenEnc || loadGistConfig(storage).tokenEnc,
      lastSyncAt,
    });
    return {
      ok: true,
      created,
      drifted: !sameProgress(merged, latest),
      gistId: storedId,
      lastSyncAt,
      bundle: finalBundle,
      uploaded: content,
      message: created
        ? "Created a secret gist and synced this device."
        : "Synced. This device and the secret gist now share the merged progress.",
    };
  } catch (err) {
    if (err?.name === "GistSyncError" || err?.code) return fail(err);
    return fail(gistError(isOfflineError(err) ? "offline" : "network", isOfflineError(err) ? OFFLINE_MESSAGE : NETWORK_MESSAGE));
  }
}

function formatSyncTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return String(iso).slice(0, 16).replace("T", " ");
  }
}

export function renderGistSyncSection(view = {}, { heading = true } = {}) {
  const connected = Boolean(view.connected);
  const gistId = typeof view.gistId === "string" ? view.gistId : "";
  const busy = view.phase === "syncing";
  const message = typeof view.message === "string" ? view.message : "";
  const msgClass = view.phase === "error" ? "gist-msg is-err" : view.phase === "synced" ? "gist-msg is-ok" : "gist-msg";
  const when = formatSyncTime(view.lastSyncAt);
  const headingHtml = heading ? `<h3 class="rev-sub">Cloud sync (GitHub Gist)</h3>` : "";
  return `<div class="gist-sync" data-gist-root>
    ${headingHtml}
    <p class="rev-fine">A secret gist stores the same encrypted progress file as Export. The token is encrypted with this unlock before it is saved, and it is never written into that file.</p>
    <label class="field">GitHub token
      <input class="gist-token" type="password" name="kc-gist-token" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="${connected ? "Saved on this device — paste only to replace" : "ghp_…"}" ${busy ? "disabled" : ""}>
    </label>
    <p class="gist-scope">Only the gist scope is needed.</p>
    <label class="field">Existing Gist ID
      <input class="gist-id" type="text" autocomplete="off" spellcheck="false" placeholder="Blank creates a new secret gist" value="${escapeHtml(gistId)}" ${busy ? "disabled" : ""}>
    </label>
    <div class="rev-data-row gist-actions">
      <button type="button" class="solid" data-gist="connect" ${busy ? "disabled" : ""}>Connect &amp; Sync</button>
      <button type="button" class="tool" data-gist="sync" ${connected && !busy ? "" : "disabled"}>Sync now</button>
      <button type="button" class="tool" data-gist="copy" ${gistId ? "" : "disabled"}>Copy Gist ID</button>
      <button type="button" class="tool danger" data-gist="disconnect" ${connected && !busy ? "" : "disabled"}>Disconnect</button>
    </div>
    <label class="check gist-auto"><input type="checkbox" data-gist="auto" ${view.autoSync ? "checked" : ""} ${busy ? "disabled" : ""}> Auto-sync on unlock, and about 12 seconds after study, note, inbox, or PBQ changes</label>
    <p class="${msgClass}" role="status" aria-live="polite">${escapeHtml(message)}</p>
    <p class="rev-fine gist-when">${when ? `Last sync ${escapeHtml(when)}` : ""}</p>
  </div>`;
}

export function createGistSyncController({
  storage,
  fetchImpl,
  getKey,
  collect,
  applyBundle,
  onStatus,
} = {}) {
  let memoryToken = "";
  let phase = "idle";
  let message = "";
  let timer = 0;
  let inflight = null;
  let queued = null;
  let session = 0;

  function emit() {
    onStatus?.(view());
  }

  function view() {
    const cfg = loadGistConfig(storage);
    let shown = phase;
    if (shown === "idle" && cfg.tokenEnc) shown = "synced";
    return {
      connected: Boolean(cfg.tokenEnc),
      gistId: cfg.gistId || "",
      autoSync: cfg.autoSync === true,
      lastSyncAt: cfg.lastSyncAt || null,
      phase: shown,
      message,
    };
  }

  function clearMemoryToken() {
    memoryToken = "";
    session += 1;
    queued = null;
    if (timer) clearTimeout(timer);
    timer = 0;
  }

  async function tokenForSync(typed) {
    const clean = String(typed ?? "").trim();
    if (clean) return clean;
    if (memoryToken) return memoryToken;
    const cfg = loadGistConfig(storage);
    if (!cfg.tokenEnc) return "";
    const key = getKey?.();
    if (!key) throw gistError("locked", LOCKED_MESSAGE);
    memoryToken = await decryptGistToken(key, cfg.tokenEnc);
    return memoryToken;
  }

  async function run(options) {
    const stamp = session;
    const key = getKey?.() || null;
    let token = "";
    let tokenEnc = null;
    try {
      token = await tokenForSync(options.token);
      if (options.token && String(options.token).trim()) {
        if (!key) throw gistError("locked", LOCKED_MESSAGE);
        tokenEnc = await encryptGistToken(key, token);
      }
    } catch (err) {
      phase = "error";
      message = err?.message || TOKEN_MESSAGE;
      emit();
      return { ok: false, code: err?.code || "token", message };
    }
    if (stamp !== session) return { ok: false, code: "locked", message: LOCKED_MESSAGE };
    phase = "syncing";
    message = "Syncing…";
    emit();
    const result = await syncNow({
      key,
      token,
      storage,
      fetchImpl,
      collect,
      applyBundle,
      gistId: options.gistId,
      tokenEnc,
    });
    if (stamp !== session) {
      memoryToken = "";
      return result;
    }
    if (result.ok) {
      memoryToken = token;
      phase = "synced";
      message = result.message;
      if (result.drifted) scheduleFollowUp();
    } else {
      if (options.token && String(options.token).trim()) memoryToken = "";
      phase = "error";
      message = result.message;
    }
    emit();
    return result;
  }

  function scheduleFollowUp() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      enqueueSync().catch(() => {});
    }, AUTO_SYNC_DELAY_MS);
  }

  async function enqueueSync(options = {}) {
    if (inflight) {
      queued = options;
      return inflight;
    }
    inflight = (async () => {
      let result;
      let current = options;
      try {
        do {
          const next = current || {};
          queued = null;
          result = await run(next);
          current = queued;
        } while (current);
        return result;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function connect({ token, gistId } = {}) {
    const parsed = normalizeGistId(gistId);
    if (parsed == null) {
      phase = "error";
      message = "That gist id doesn’t look valid. Paste the id or a gist.github.com link, or leave the field blank.";
      emit();
      return { ok: false, code: "gist-id", message };
    }
    return enqueueSync({ token, gistId: parsed });
  }

  function disconnect() {
    clearMemoryToken();
    clearGistConfig(storage);
    phase = "idle";
    message = "Disconnected on this device. The gist itself was not deleted.";
    emit();
  }

  function setAutoSync(on) {
    saveGistConfig(storage, { autoSync: on === true });
    if (phase !== "error" && phase !== "syncing") {
      message = on ? "Auto-sync is on. It runs after you unlock, and about 12 seconds after a study change." : "Auto-sync is off.";
    }
    emit();
    if (on && loadGistConfig(storage).tokenEnc && getKey?.()) {
      enqueueSync().catch(() => {});
    }
  }

  function scheduleAutoSync() {
    const cfg = loadGistConfig(storage);
    if (!cfg.autoSync || !cfg.tokenEnc || !getKey?.()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      enqueueSync().catch(() => {});
    }, AUTO_SYNC_DELAY_MS);
  }

  async function onUnlock() {
    const cfg = loadGistConfig(storage);
    phase = cfg.tokenEnc ? "synced" : "idle";
    message = "";
    emit();
    if (!cfg.autoSync || !cfg.tokenEnc) return { ok: true, skipped: true };
    return enqueueSync();
  }

  return {
    view,
    connect,
    disconnect,
    syncNow: enqueueSync,
    setAutoSync,
    scheduleAutoSync,
    onUnlock,
    clearMemoryToken,
  };
}
