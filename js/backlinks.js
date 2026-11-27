/**
 * In-memory reverse index of topic references.
 * A node points at another topic through `relatedIds`, a hash route
 * `#/<branch>/<nodeId>`, or a backticked id that matches a loaded node.
 * The index is rebuilt after decrypt (and after local edits) and is never written to disk.
 */

function asId(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return "";
}

function decodeSegment(raw) {
  let s = String(raw || "");
  try { s = decodeURIComponent(s); } catch { /* keep the raw segment */ }
  return s.replace(/[),.;:!?]+$/g, "").trim();
}

/** Node ids this topic points at, in first-seen order, excluding itself and unknown ids. */
export function extractOutgoingIds(node, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const self = asId(node?.id);
  const out = [];
  const seen = new Set();
  const add = (value) => {
    const id = asId(value);
    if (!id || id === self || seen.has(id) || !known.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  if (Array.isArray(node?.relatedIds)) {
    for (const id of node.relatedIds) add(id);
  }

  const text = `${node?.expanded ?? ""}\n${node?.summary ?? ""}`;
  const hashRe = /#\/([^/\s#?`'")\]]+)((?:\/[^/\s#?`'")\]]+)+)/g;
  let match;
  while ((match = hashRe.exec(text))) {
    const segments = match[2].split("/").filter(Boolean);
    for (const segment of segments) add(decodeSegment(segment));
  }
  const tickRe = /`([^`\n]+)`/g;
  while ((match = tickRe.exec(text))) add(match[1]);
  return out;
}

/**
 * targetNodeId -> Array<{ id, title, branchId, branchTitle }>
 * `branchOf(node)` supplies the referencing node's subject.
 */
export function buildBacklinkIndex(nodes, branchOf) {
  const list = Array.isArray(nodes) ? nodes : [];
  const known = new Set();
  for (const node of list) {
    const id = asId(node?.id);
    if (id) known.add(id);
  }
  const index = new Map();
  const seenPair = new Set();
  for (const node of list) {
    const id = asId(node?.id);
    if (!id) continue;
    const meta = typeof branchOf === "function" ? (branchOf(node) || {}) : {};
    const entry = {
      id,
      title: String(node.title || id),
      branchId: meta.branchId != null ? String(meta.branchId) : "",
      branchTitle: meta.branchTitle != null ? String(meta.branchTitle) : "",
    };
    for (const target of extractOutgoingIds(node, known)) {
      const pair = `${target}\0${id}`;
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
      let bucket = index.get(target);
      if (!bucket) {
        bucket = [];
        index.set(target, bucket);
      }
      bucket.push(entry);
    }
  }
  return index;
}
