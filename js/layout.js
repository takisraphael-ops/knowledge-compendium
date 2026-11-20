// Left/right mind map. The root sits in the centre. Each top-level branch
// keeps a stable side (so expanding it does not make it jump) and grows
// outward. Siblings stack vertically, which stays readable for long titles
// and for branches with dozens of children. Only the ids `isOpen` reveals
// are measured, so a closed branch is a single pill.

export const H_GAP = 72;
export const V_GAP = 14;
export const BRANCH_GAP = 46;

export function assignSides(rootId, children) {
  const kids = children.get(rootId) || [];
  const weight = (id) => {
    let n = 1;
    for (const child of children.get(id) || []) n += weight(child);
    return n;
  };
  const ranked = kids
    .map((id, index) => ({ id, index, w: weight(id) }))
    .sort((a, b) => b.w - a.w || a.index - b.index);
  const load = { 1: 0, [-1]: 0 };
  const side = new Map();
  for (const item of ranked) {
    const s = load[1] <= load[-1] ? 1 : -1;
    side.set(item.id, s);
    load[s] += item.w;
  }
  return side;
}

function layoutSubtree(id, measure, isOpen, kidsOf, stack) {
  if (stack.has(id) || stack.size > 40) {
    const box = measure(id);
    return { id, w: box.w, h: box.h, height: box.h, children: [] };
  }
  const next = new Set(stack);
  next.add(id);
  const box = measure(id);
  const kids = isOpen(id) ? kidsOf(id) : [];
  const children = kids.map((kid) => layoutSubtree(kid, measure, isOpen, kidsOf, next));
  let stackH = 0;
  if (children.length) {
    stackH = children.reduce((sum, child) => sum + child.height, 0) + V_GAP * (children.length - 1);
    let y = -stackH / 2;
    for (const child of children) {
      child.cy = y + child.height / 2;
      y += child.height + V_GAP;
    }
  }
  return { id, w: box.w, h: box.h, height: Math.max(box.h, stackH), children };
}

function place(node, x, y, sign, depth, color, parentId, positions) {
  positions.set(node.id, {
    id: node.id,
    x,
    y,
    w: node.w,
    h: node.h,
    depth,
    color,
    parentId,
    sign,
  });
  for (const child of node.children) {
    const cx = x + sign * (node.w / 2 + H_GAP + child.w / 2);
    const cy = y + child.cy;
    place(child, cx, cy, sign, depth + 1, color, node.id, positions);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.rootId
 * @param {Map<string, string[]>} opts.children
 * @param {(id: string) => {w: number, h: number}} opts.measure
 * @param {(id: string) => boolean} opts.isOpen
 * @param {(id: string) => string[]} opts.kidsOf visible children in order
 * @param {Map<string, number>} opts.sides level-1 id -> 1 (right) or -1 (left)
 * @param {Map<string, string>} opts.colors level-1 id -> css color
 */
export function layoutMap(opts) {
  const { rootId, measure, isOpen, kidsOf, sides, colors } = opts;
  const positions = new Map();
  if (!rootId) return positions;
  const rootBox = measure(rootId);
  positions.set(rootId, {
    id: rootId,
    x: 0,
    y: 0,
    w: rootBox.w,
    h: rootBox.h,
    depth: 0,
    color: "#1f2a2e",
    parentId: null,
    sign: 0,
  });

  const level1 = kidsOf(rootId);
  const groups = { 1: [], [-1]: [] };
  for (const id of level1) {
    const sign = sides.get(id) || 1;
    const tree = layoutSubtree(id, measure, isOpen, kidsOf, new Set([rootId]));
    (groups[sign] || groups[1]).push(tree);
  }

  for (const sign of [1, -1]) {
    const trees = groups[sign];
    if (!trees.length) continue;
    const total = trees.reduce((sum, tree) => sum + tree.height, 0) + BRANCH_GAP * (trees.length - 1);
    let y = -total / 2;
    for (const tree of trees) {
      const cy = y + tree.height / 2;
      const x = sign * (rootBox.w / 2 + H_GAP + tree.w / 2);
      place(tree, x, cy, sign, 1, colors.get(tree.id) || "#1a73e8", rootId, positions);
      y += tree.height + BRANCH_GAP;
    }
  }
  return positions;
}

export function boxesOverlap(a, b, gap = 4) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;
}
