// 自动布局模块：纯计算、确定可重复，不写任何字符串。
// 按 ir.type 分派到 layoutArchitecture / layoutFlow / layoutSequence，
// 统一返回 LayoutResult（含带 cx/cy 的 boxes，供 geometry.mjs 碰撞函数使用）。
import { collectLabelRouteClearance, segmentIntersectsRect } from './geometry.mjs';
import { ROLE_KEYS } from './theme.mjs';
import { estimateTextWidth, maxLineWidth, wrapTextDetailed } from './text-metrics.mjs';
import {
  BOX, EDGE_LABEL, FRAME, LEGEND, CANVAS, SEQUENCE, STAGE,
  BACK_CHANNEL_GAP, STUB, TYPE_SCALE,
} from './typography.mjs';

// 文字度量统一从 text-metrics.mjs 出，禁止在本模块再复刻一份系数。
export { estimateTextWidth, wrapText, isCjkChar } from './text-metrics.mjs';

// ---- 常量（全部取自 typography.mjs，此处只做本地别名，便于阅读）----
const MARGIN = CANVAS.margin;
const TITLE_H = CANVAS.titleHeight;
const GAP = BOX.gap;
const BOX_PAD_X = BOX.padX;
const NODE_FONT = TYPE_SCALE.nodeTitle.px;
const SUB_FONT = TYPE_SCALE.nodeSub.px;
const ROW_GAP = BOX.rowGap;
const FRAME_PAD = FRAME.pad;
// 标签净空阈值：与放置器、检查器共用 EDGE_LABEL.clearance（= 标签矩形高），
// 三者必须相等，否则放置器会选出「刚好 0.5px 不达标」的位置，导致 label_route_clearance 误报。
const LABEL_FONT = TYPE_SCALE.edgeLabel.px;
const LABEL_H = EDGE_LABEL.rectHeight;
const LABEL_PAD = EDGE_LABEL.rectPadX;
const LABEL_MIN_CLEAR = EDGE_LABEL.clearance;
// 回边外侧绕行通道与最左 box 左缘的间距。
const CHANNEL_GAP = BACK_CHANNEL_GAP;
// 阶段带（stages）列间距：横向演进图里相邻档位之间的边是水平段，
// 间距必须大于 2*STUB 才能留出足够长的内部段（route_rhythm 要求 interior >= 16px）。
const STAGE_COL_GAP = STAGE.colGap;

// 图例中角色的中文名。
export const ROLE_LABELS = {
  control: '控制',
  capability: '能力',
  interaction: '交互',
  warn: '告警',
  neutral: '中性',
};

// 盒内文字行宽上限（= 最大盒宽 − 左右内边距）；超过即折行。
const MAX_CONTENT_W = BOX.maxWidth - 2 * BOX_PAD_X;
// 每行行高（必须与 render.mjs 的 renderBoxes 一致）。
const LINE_H = BOX.lineHeight;

function boxSize(node) {
  const labelWrap = wrapTextDetailed(node.label || '', NODE_FONT, MAX_CONTENT_W);
  const subWrap = node.sublabel ? wrapTextDetailed(node.sublabel, SUB_FONT, MAX_CONTENT_W) : { lines: [], truncated: false };
  const labelLines = labelWrap.lines;
  const subLines = subWrap.lines;
  const labelW = maxLineWidth(labelLines, NODE_FONT);
  const subW = maxLineWidth(subLines, SUB_FONT);
  const w = Math.min(BOX.maxWidth, Math.max(BOX.minWidth, Math.max(labelW, subW) + 2 * BOX_PAD_X));
  const rows = Math.max(1, labelLines.length + subLines.length);
  const h = rows <= 1 ? BOX.heightSingle : BOX.heightDouble + (rows - 2) * LINE_H;
  return {
    width: Math.round(w),
    height: h,
    labelLines,
    subLines,
    // 折行截断标记：由 checks/composition.mjs 的 text_not_truncated 断言。
    truncated: labelWrap.truncated || subWrap.truncated,
  };
}

function makeBox(node, x, y) {
  const sz = boxSize(node);
  return {
    id: node.id,
    x: Math.round(x),
    y: Math.round(y),
    width: sz.width,
    height: sz.height,
    cx: Math.round(x + sz.width / 2),
    cy: Math.round(y + sz.height / 2),
    role: node.role,
    label: node.label,
    sublabel: node.sublabel || null,
    kind: node.kind || null,
    labelLines: sz.labelLines,
    subLines: sz.subLines,
    truncated: sz.truncated,
  };
}

// 取某 side 上的锚点坐标。
function anchor(box, side) {
  switch (side) {
    case 'left': return [box.x, box.cy];
    case 'right': return [box.x + box.width, box.cy];
    case 'top': return [box.cx, box.y];
    case 'bottom': return [box.cx, box.y + box.height];
    default: return [box.x + box.width, box.cy];
  }
}

function outward(side) {
  return side === 'left' ? [-1, 0] : side === 'right' ? [1, 0] : side === 'top' ? [0, -1] : [0, 1];
}

// 折线化简：去掉重复点与共线中间点，避免产生零长/极短段。
// 当两端位于同一轴线上时，right→left 或 bottom→top 的路由会退化成一条直线，
// 此时化简为两点——既满足端点垂直约束，也不会留下 0px 的中间段。
function simplifyPolyline(pts, eps = 0.75) {
  if (!Array.isArray(pts) || pts.length < 2) return pts;
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > eps || Math.abs(last[1] - p[1]) > eps) dedup.push(p);
  }
  const res = [];
  for (let i = 0; i < dedup.length; i += 1) {
    const prev = res[res.length - 1];
    const cur = dedup[i];
    const next = dedup[i + 1];
    if (prev && next) {
      const collinearX =
        Math.abs(prev[0] - cur[0]) <= eps && Math.abs(cur[0] - next[0]) <= eps;
      const collinearY =
        Math.abs(prev[1] - cur[1]) <= eps && Math.abs(cur[1] - next[1]) <= eps;
      if (collinearX || collinearY) continue;
    }
    res.push(cur);
  }
  return res.length >= 2 ? res : [dedup[0], dedup[dedup.length - 1]];
}

// 正交折线：首尾段与 side 垂直，中间仅走水平/垂直段。
export function routeOrthogonal(fromBox, toBox, fromSide, toSide, stub = STUB) {
  const s = anchor(fromBox, fromSide);
  const e = anchor(toBox, toSide);
  const sv = outward(fromSide);
  const tv = outward(toSide);
  const ss = [s[0] + sv[0] * stub, s[1] + sv[1] * stub];
  const ts = [e[0] + tv[0] * stub, e[1] + tv[1] * stub];
  let mids = [];
  if (sv[1] !== 0 && tv[1] !== 0) {
    const my = (ss[1] + ts[1]) / 2;
    mids = [[ss[0], my], [ts[0], my]];
  } else if (sv[0] !== 0 && tv[0] !== 0) {
    const mx = (ss[0] + ts[0]) / 2;
    mids = [[mx, ss[1]], [mx, ts[1]]];
  } else {
    mids = [[ts[0], ss[1]]];
  }
  return simplifyPolyline([s, ss, ...mids, ts, e]);
}

// 取折线中间段的中点作为边标签初始位置。
function midPoint(pts) {
  if (pts.length < 2) return [0, 0];
  const mid = Math.floor((pts.length - 1) / 2);
  const a = pts[mid];
  const b = pts[mid + 1] || pts[mid];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// 基于相对位置推断正交路由的进出 side。
function relativeSides(fb, tb) {
  const dx = tb.cx - fb.cx;
  const dy = tb.cy - fb.cy;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
  }
  return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
}

// 最长有效线段的方向，用于决定标签偏移法线（水平段则上下偏移，垂直段则左右偏移）。
function dominantSegment(pts) {
  let best = null;
  let bestLen = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    if (len < 0.001) continue;
    if (len > bestLen) { bestLen = len; best = [a, b]; }
  }
  if (!best) return { horizontal: true };
  return { horizontal: Math.abs(best[1][1] - best[0][1]) <= 0.001 };
}

// 由标签锚点反推标签矩形（与 checks/composition.mjs 的 buildLabelRect 同口径）。
function labelRect(at, text) {
  const w = estimateTextWidth(text, LABEL_FONT) + LABEL_PAD;
  return { x: at[0] - w / 2, y: at[1] - LABEL_H / 2, width: w, height: LABEL_H };
}

// 标签放置：沿所在边法线方向尝试不同偏移，用 geometry 的 collectLabelRouteClearance
// 校验与所有 box / 其它边的净空是否达标（阈值 LABEL_MIN_CLEAR）。双向、递增幅度直到通过，
// 确保标签不压线、不压盒，且留在画布内。
function placeLabels(edges, boxes, width, height) {
  if (!edges.length) return;
  const routes = edges.map((e, i) => ({
    relation: { id: e.id, from: e.from, to: e.to, label: e.label },
    points: e.points,
    relationIndex: i,
  }));
  const boxRoutes = boxes.map((b, i) => ({
    relation: { id: 'box:' + b.id, from: 'box:' + b.id, to: 'box:' + b.id },
    points: [
      [b.x, b.y],
      [b.x + b.width, b.y],
      [b.x + b.width, b.y + b.height],
      [b.x, b.y + b.height],
      [b.x, b.y],
    ],
    relationIndex: edges.length + i,
  }));
  const allRoutes = [...routes, ...boxRoutes];
  // 候选偏移：同时沿“法线轴”（垂直于主线段）与“沿线轴”（平行于主线段）双向尝试。
  // 法线偏移用于让标签离开连线本身；沿线偏移用于把标签平移到两条生命线/边走廊之间，
  // 从而避开被连线穿过的列。幅度取密集序列，确保能命中狭窄的净空窗口。
  const mags = [];
  for (let m = 14; m <= 140; m += 2) mags.push(m);
  for (const e of edges) {
    if (!e.label) { e.labelAt = e.labelAt || null; continue; }
    const idx = routes.findIndex((r) => r.relation.id === e.id);
    const base = midPoint(e.points);
    const seg = dominantSegment(e.points);
    const perp = seg.horizontal ? [0, 1] : [1, 0];
    const along = seg.horizontal ? [1, 0] : [0, 1];
    let chosen = null;
    for (const mag of mags) {
      const cands = [
        [base[0] + perp[0] * mag, base[1] + perp[1] * mag],
        [base[0] - perp[0] * mag, base[1] - perp[1] * mag],
        [base[0] + along[0] * mag, base[1] + along[1] * mag],
        [base[0] - along[0] * mag, base[1] - along[1] * mag],
      ];
      for (const cand of cands) {
        const rect = labelRect(cand, e.label);
        if (rect.x < 2 || rect.x + rect.width > width - 2 || rect.y < 2 || rect.y + rect.height > height - 2) continue;
        const hits = collectLabelRouteClearance({
          labels: [{
            label: e.label,
            relationIndex: idx,
            relation: { id: e.id, from: e.from, to: e.to, label: e.label },
            rect,
          }],
          routedRelations: allRoutes,
          threshold: LABEL_MIN_CLEAR,
        });
        if (!hits.length) { chosen = cand; break; }
      }
      if (chosen) break;
    }
    if (!chosen) chosen = base;
    e.labelAt = [Math.round(chosen[0]), Math.round(chosen[1])];
  }
}

// flow 分层：用 Kahn 拓扑序识别反馈边（回边），再仅用前向边做最长路径分层，
// 避免 retry 环把目标节点层级无限抬高。
function computeLayers(nodes, edges) {
  const idSet = new Set(nodes.map((n) => n.id));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to)) adj.get(e.from).push(e.to);
  }
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to)) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const order = [];
  const q = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (q.length) {
    const u = q.shift();
    order.push(u);
    for (const v of adj.get(u)) {
      indeg.set(v, indeg.get(v) - 1);
      if (indeg.get(v) === 0) q.push(v);
    }
  }
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);
  const pos = new Map(order.map((id, i) => [id, i]));
  const back = new Set();
  const key = (f, t) => f + ' ' + t;
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to) && pos.get(e.to) < pos.get(e.from)) {
      back.add(key(e.from, e.to));
    }
  }
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const fwd = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (idSet.has(e.from) && idSet.has(e.to) && !back.has(key(e.from, e.to))) {
      fwd.get(e.from).push(e.to);
    }
  }
  for (const u of order) {
    for (const v of fwd.get(u)) layer.set(v, Math.max(layer.get(v), layer.get(u) + 1));
  }
  return { layer, back, key };
}

// 回边外侧绕行通道：从源左侧出、沿最左 box 之外的专用竖通道上/下行、再从左进入目标。
// 通道 x 取最左 box 左缘再左移 CHANNEL_GAP，天然落在所有 box 左侧，不穿越任何无关 box。
function routeBackEdge(fb, tb, boxes) {
  let minLeft = Infinity;
  for (const b of boxes) minLeft = Math.min(minLeft, b.x);
  const side = 'left';
  const aOut = anchor(fb, side);
  const aIn = anchor(tb, side);
  const chX = Math.max(2, minLeft - CHANNEL_GAP);
  return [aOut, [chX, aOut[1]], [chX, aIn[1]], aIn];
}

// 横排回边外侧绕行通道：从源底部出、沿所有 box 之下的专用横通道左移、再自底部进入目标。
// 通道 y 取最下 box 底缘再下移 CHANNEL_GAP，天然落在所有 box 下方，不穿越任何无关 box。
// 两端齐平布局下，下方行的盒可能被 justify 到回边竖直段上（如实测 shop-14-8-node-dag
// 末行右端盒恰好挡住进入段），故两条竖直段（源下出 / 目标下入）的 x 不再死取盒中心，
// 而是在各自盒底缘宽度内自中心向两侧扫描，取首个「竖线不穿越任何无关盒」的位置；
// 两端落点过近时优先共轴（水平段零长，规范化后仍是干净的下去—回来到访线）。
// 找不到安全位时退回盒中心——由 relationship_crossings 检查暴露，不静默产坏图。
function routeBackEdgeH(fb, tb, boxes) {
  let maxBottom = -Infinity;
  for (const b of boxes) maxBottom = Math.max(maxBottom, b.y + b.height);
  const chY = maxBottom + CHANNEL_GAP;
  const skip = new Set([fb.id, tb.id]);
  const yTop = Math.min(fb.y + fb.height, tb.y + tb.height);
  // 竖线贯穿区间取两段竖直段的并集 [yTop, chY]；水平段在 chY 恒安全，无需检查。
  const clear = (x) => {
    for (const b of boxes) {
      if (skip.has(b.id)) continue;
      if (segmentIntersectsRect({ start: [x, yTop], end: [x, chY] }, b, 0)) return false;
    }
    return true;
  };
  // 盒底缘宽度内的候选 x：内缩 4px 防贴角，自中心向两侧交替外扩（中心优先）。
  const span = (box) => {
    const inset = Math.min(4, box.width / 4);
    return { lo: Math.ceil(box.x + inset), hi: Math.floor(box.x + box.width - inset) };
  };
  const candidates = (box) => {
    const { lo, hi } = span(box);
    const list = [box.cx];
    for (let d = 2; box.cx - d >= lo || box.cx + d <= hi; d += 2) {
      if (box.cx - d >= lo) list.push(box.cx - d);
      if (box.cx + d <= hi) list.push(box.cx + d);
    }
    return list;
  };
  const inSpan = (box, x) => {
    const { lo, hi } = span(box);
    return x >= lo && x <= hi;
  };
  const pick = (box) => candidates(box).find(clear) || box.cx;
  let xOut = pick(fb);
  let xIn = pick(tb);
  // 两端落点相距 <16 且不等：中间水平段会触发 route_rhythm 短 interior，尝试共轴统一。
  if (xOut !== xIn && Math.abs(xOut - xIn) < 16) {
    if (inSpan(tb, xOut)) xIn = xOut;
    else if (inSpan(fb, xIn) && clear(xIn)) xOut = xIn;
  }
  return [
    [xOut, fb.y + fb.height],
    [xOut, chY],
    [xIn, chY],
    [xIn, tb.y + tb.height],
  ];
}

// 统一收尾：计算画布尺寸、放置标签、生成 legend、保证不重叠。
function finalize({ type, boxes, frames, edges, vb }) {
  let maxX = 0;
  let maxY = 0;
  let minX = Infinity;
  let minY = Infinity;
  const acc = (x, y) => {
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
  };
  for (const r of [...boxes, ...frames]) { acc(r.x, r.y); acc(r.x + r.width, r.y + r.height); }
  for (const e of edges) for (const p of e.points) acc(p[0], p[1]);
  let width = Math.max(vb[0], maxX + MARGIN);
  let height = Math.max(vb[1], maxY + MARGIN);
  // 先按当前边界放置标签，再把标签位置扩进边界。
  // ⚠️ 必须计入**标签矩形**而不是只计锚点：只算锚点会漏掉标签自身宽度的一半，
  // 当最宽的标签恰好贴在最右/最下时会被画到画布之外，而所有检查都看不见。
  placeLabels(edges, boxes, width, height);
  for (const e of edges) {
    if (!e.labelAt) continue;
    const r = labelRect(e.labelAt, e.label || '');
    acc(r.x, r.y);
    acc(r.x + r.width, r.y + r.height);
  }

  // 自动贴合：把内容左上角对齐到 (MARGIN, TITLE_H)，消掉 vb 撑出的空白。
  // vb 因此退化为「行内舒展宽度提示」——不再直接决定成品画布尺寸。
  // 偏移取整，保证原本已取整的坐标不发生亚像素错位。
  // 注意：盒子的 cx/cy（渲染文字用的居中点）必须同步平移，否则色块与文字会分离。
  const dx = Math.round(MARGIN - minX);
  const dy = Math.round(TITLE_H - minY);
  if (dx !== 0 || dy !== 0) {
    for (const r of [...boxes, ...frames]) {
      r.x += dx; r.y += dy;
      if (typeof r.cx === 'number') r.cx += dx;
      if (typeof r.cy === 'number') r.cy += dy;
    }
    for (const e of edges) {
      e.points = e.points.map(([x, y]) => [x + dx, y + dy]);
      if (e.labelAt) e.labelAt = [e.labelAt[0] + dx, e.labelAt[1] + dy];
    }
  }
  const contentRight = maxX + dx;
  const contentBottom = maxY + dy;
  let outW = contentRight + MARGIN;
  let outH = contentBottom + MARGIN;

  // legend：用到的 role >= 2 时生成，紧贴内容右下（右对齐内容右缘、下接内容底缘），
  // 避免固定在画布角落导致与图之间出现大片留白。
  const rolesUsed = new Set(boxes.map((b) => b.role));
  let legend = null;
  if (rolesUsed.size >= 2) {
    const entries = ROLE_KEYS.filter((r) => rolesUsed.has(r)).map((r) => ({ role: r, label: ROLE_LABELS[r] }));
    const sw = LEGEND.swatch;
    const lh = LEGEND.rowHeight;
    const colGap = LEGEND.colGap;
    const n = entries.length;
    // 多列网格：原实现把各条目宽度「累加」当盒子宽、却逐条竖排 → 盒子过宽、右侧大留白。
    // 改为按列排布，目标把行数压到 ≤3：n≥5 → 3 列，n≥3 → 2 列，n≤2 → 单列。
    const cols = n >= 5 ? 3 : n >= 3 ? 2 : 1;
    const rows = Math.ceil(n / cols);
    const colW = Math.max(...entries.map((en) => sw + 8 + estimateTextWidth(en.label, TYPE_SCALE.legend.px) + 10));
    const lw = Math.max(LEGEND.widthPad + cols * colW + (cols - 1) * colGap, LEGEND.minWidth);
    const lhTotal = rows * lh + LEGEND.insetTop;
    const lx = contentRight - lw;
    const ly = contentBottom + LEGEND.gapToContent;
    legend = {
      x: Math.round(lx),
      y: Math.round(ly),
      width: Math.round(lw),
      height: Math.round(lhTotal),
      cols,
      rows,
      colW,
      colGap,
      entries,
    };
    outW = Math.max(outW, lx + lw + MARGIN);
    outH = Math.max(outH, ly + lhTotal + MARGIN);
  }

  return {
    type,
    width: Math.round(outW),
    height: Math.round(outH),
    boxes,
    frames,
    edges,
    legend,
  };
}

// ============ architecture ============
export function layoutArchitecture(ir) {
  const vb = (ir.meta && ir.meta.viewBox) || [800, 500];
  const groups = ir.groups || [];
  const nodes = ir.nodes || [];
  const edges = ir.edges || [];
  const boxById = new Map();
  const bandRects = new Map();

  let bands;
  if (groups.length) {
    bands = groups.map((g) => ({
      id: g.id,
      label: g.label,
      role: g.role,
      nodeIds: nodes.filter((n) => n.group === g.id).map((n) => n.id),
      grid: false,
    }));
    const grouped = new Set(bands.flatMap((b) => b.nodeIds));
    const ungrouped = nodes.filter((n) => !grouped.has(n.id));
    if (ungrouped.length) {
      bands.push({ id: '__ungrouped', label: '', role: 'neutral', nodeIds: ungrouped.map((n) => n.id), grid: false });
    }
  } else {
    bands = [{ id: '__all', label: '', role: 'neutral', nodeIds: nodes.map((n) => n.id), grid: true }];
  }

  const contentW = vb[0] - 2 * MARGIN;
  let y = TITLE_H;

  for (const band of bands) {
    const bNodes = band.nodeIds.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
    if (!bNodes.length) continue;
    const sizes = bNodes.map((n) => boxSize(n));

    if (band.grid) {
      const n = bNodes.length;
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
      const rows = Math.ceil(n / cols);
      const colW = [];
      for (let c = 0; c < cols; c += 1) {
        let m = 0;
        for (let r = 0; r < rows; r += 1) {
          const idx = r * cols + c;
          if (idx < n) m = Math.max(m, sizes[idx].width);
        }
        colW.push(m);
      }
      const rowH = [];
      for (let r = 0; r < rows; r += 1) {
        let m = 0;
        for (let c = 0; c < cols; c += 1) {
          const idx = r * cols + c;
          if (idx < n) m = Math.max(m, sizes[idx].height);
        }
        rowH.push(m);
      }
      const totalW = colW.reduce((a, b) => a + b, 0) + GAP * (cols - 1);
      const startX = MARGIN + Math.max(0, (contentW - totalW) / 2);
      let cy = y;
      for (let r = 0; r < rows; r += 1) {
        let cx = startX;
        for (let c = 0; c < cols; c += 1) {
          const idx = r * cols + c;
          if (idx >= n) break;
          const b = makeBox(bNodes[idx], cx + (colW[c] - sizes[idx].width) / 2, cy);
          b.height = rowH[r];
          b.cy = Math.round(cy + rowH[r] / 2);
          boxById.set(b.id, b);
          cx += colW[c] + GAP;
        }
        cy += rowH[r] + GAP;
      }
      y = cy + ROW_GAP;
      continue;
    }

    const totalW = sizes.reduce((a, s) => a + s.width, 0) + GAP * (bNodes.length - 1);
    const startX = MARGIN + Math.max(0, (contentW - totalW) / 2);
    const bandTop = y;
    const rowH = Math.max(...sizes.map((s) => s.height));
    const boxY = bandTop + FRAME_PAD;
    let cx = startX;
    for (let i = 0; i < bNodes.length; i += 1) {
      // 同组卡片等高：取组内最大行数的高度逐卡统一 —— 卡片整齐，且共享同一 cy
      // （否则带内水平直连边会因行高不一出现 <16px 竖段，触发 route_rhythm）。
      const b = makeBox(bNodes[i], cx, boxY);
      b.height = rowH;
      b.cy = Math.round(boxY + rowH / 2);
      boxById.set(b.id, b);
      cx += sizes[i].width + GAP;
    }
    bandRects.set(band.id, {
      top: bandTop,
      bottom: boxY + rowH + FRAME_PAD,
      left: startX,
      right: startX + totalW,
    });
    y = boxY + rowH + FRAME_PAD + ROW_GAP;
  }

  const frames = [...bandRects.entries()].map(([id, r]) => {
    const band = bands.find((b) => b.id === id);
    return {
      id: 'frame-' + id,
      x: Math.round(r.left - FRAME_PAD),
      y: Math.round(r.top),
      width: Math.round(r.right - r.left + 2 * FRAME_PAD),
      height: Math.round(r.bottom - r.top),
      label: band ? band.label : '',
      role: band ? band.role : 'neutral',
    };
  });

  // 组框对齐 + 卡片均匀分布：所有 band 框统一为最大宽度、以同一中轴居中，
  // 各 band 的节点在该宽度内按等间距重排——避免上下两条背景条长度参差、
  // 且卡片挤在一侧留出大片空白。
  if (frames.length > 1) {
    const centerX =
      (Math.min(...frames.map((f) => f.x)) + Math.max(...frames.map((f) => f.x + f.width))) / 2;
    const maxW = Math.max(...frames.map((f) => f.width));
    for (const f of frames) {
      f.x = Math.round(centerX - maxW / 2);
      f.width = Math.round(maxW);
    }
    // 各 band 节点数相同时改用「共列网格」：用同一套列心摆放，
    // 跨 band 的列严格对齐（指向同列的边是直边，不会出现横移抖动）。
    const nonGrid = bands.filter((b) => !b.grid && b.nodeIds.length);
    const counts = new Set(nonGrid.map((b) => b.nodeIds.length));
    const sharedGrid = counts.size === 1 && nonGrid.length > 1 && [...counts][0] > 1;
    for (const band of nonGrid) {
      const fr = frames.find((f) => f.id === 'frame-' + band.id);
      if (!fr) continue;
      const bs = band.nodeIds.map((id) => boxById.get(id)).filter(Boolean);
      if (!bs.length) continue;
      const innerLeft = fr.x + FRAME_PAD;
      const innerW = fr.width - 2 * FRAME_PAD;
      const n = bs.length;
      let xs = null;
      let cxs = null;
      if (sharedGrid) {
        // 列宽取各 band 同列节点的最大宽度 → 列心对所有 band 唯一，节点按列心居中。
        const colW = [];
        for (let i = 0; i < n; i += 1) {
          colW.push(
            Math.max(
              ...nonGrid.map((bd) => {
                const b = boxById.get(bd.nodeIds[i]);
                return b ? b.width : 0;
              })
            )
          );
        }
        const sumColW = colW.reduce((a, b) => a + b, 0);
        if (sumColW + GAP * (n - 1) <= innerW) {
          const gap = GAP + (innerW - sumColW - GAP * (n - 1)) / Math.max(1, n - 1);
          const centers = [];
          let cur = innerLeft;
          for (let i = 0; i < n; i += 1) {
            centers.push(Math.round(cur + colW[i] / 2));
            cur += colW[i] + gap;
          }
          xs = bs.map((b, i) => Math.round(centers[i] - b.width / 2));
          cxs = centers;
        }
      }
      if (!xs) {
        // 回退：等间距铺满（各 band 内部间距相等）。
        // 单节点 band 必须先定列心再推 x —— 若先取整 x 再加半宽，
        // 宽度为奇数时会多进 0.5px，导致同一中轴上的两个单节点带错开 1px（route_rhythm 微段）。
        if (n === 1) {
          const c1 = Math.round(innerLeft + innerW / 2);
          xs = [Math.round(c1 - bs[0].width / 2)];
          cxs = [c1];
        } else {
          const sumW = bs.reduce((a, b) => a + b.width, 0);
          const gap = Math.max((innerW - sumW) / (n - 1), GAP);
          let x = innerLeft;
          xs = bs.map((b) => {
            const v = Math.round(x);
            x += b.width + gap;
            return v;
          });
        }
      }
      bs.forEach((b, i) => {
        b.x = xs[i];
        b.cx = cxs ? cxs[i] : Math.round(xs[i] + b.width / 2);
      });
    }
  }

  // 「边指向整组」：端点可写 group id —— 锚定到该组外框（frame），用于表达
  // 「上一层整体 → 下一层整体」的带间关系（连接外框、居中直下）。组内顺序由带内水平边表达。
  // 端点不是 group id 时仍按节点处理（向后兼容）。
  const frameByGroup = new Map();
  for (const f of frames) frameByGroup.set(f.id.replace(/^frame-/, ''), f);
  const asRect = (o) => (typeof o.cx === 'number' ? o : { ...o, cx: Math.round(o.x + o.width / 2), cy: Math.round(o.y + o.height / 2) });

  const edgesRes = [];
  for (const e of edges) {
    const fromFrame = frameByGroup.get(e.from);
    const toFrame = frameByGroup.get(e.to);
    const fb = fromFrame ? asRect(fromFrame) : boxById.get(e.from);
    const tb = toFrame ? asRect(toFrame) : boxById.get(e.to);
    if (!fb || !tb) continue;
    let fromSide;
    let toSide;
    const fromBand = !fromFrame && groups.length ? bands.find((b) => b.nodeIds.includes(e.from)) : null;
    const toBand = !toFrame && groups.length ? bands.find((b) => b.nodeIds.includes(e.to)) : null;
    if (fromBand && toBand && fromBand.id === toBand.id) {
      // 同带（同一横排）两节点：优先「直连水平边」（右缘中点 → 左缘中点）。
      // 层级约定：先外部（跨带 = 上下）后内部（带内 = 左右）——带内顺序用水平箭头表达即可，
      // 不应把带内连接也拿去做“上/下绕行”（会把上下与左右两套链路混在一起、观感左偏）。
      // 仅当两节点之间还夹着同带其它盒子时，才回退为绕顶折线（避免穿越盒子）。
      const sameBand = bands.find((b) => b.id === fromBand.id);
      const sameBoxes = (sameBand ? sameBand.nodeIds : [])
        .map((id) => boxById.get(id))
        .filter(Boolean);
      const xLo = Math.min(fb.x + fb.width, tb.x + tb.width);
      const xHi = Math.max(fb.x, tb.x);
      const blocked = sameBoxes.some(
        (b) => b.id !== fb.id && b.id !== tb.id && b.x < xHi && b.x + b.width > xLo
      );
      if (!blocked && Math.abs(tb.cx - fb.cx) > 4) {
        if (tb.cx > fb.cx) { fromSide = 'right'; toSide = 'left'; } else { fromSide = 'left'; toSide = 'right'; }
      } else {
        fromSide = 'top';
        toSide = 'top';
      }
    } else if (!groups.length && !fromFrame && !toFrame) {
      [fromSide, toSide] = relativeSides(fb, tb);
    } else {
      // 跨带（或任一端为整组外框）：源底部 → 目标顶部（居中直下）。
      if (tb.y >= fb.y + fb.height) { fromSide = 'bottom'; toSide = 'top'; } else { fromSide = 'top'; toSide = 'bottom'; }
    }
    const pts = routeOrthogonal(fb, tb, fromSide, toSide, STUB);
    edgesRes.push({
      id: 'e-' + e.from + '-' + e.to,
      from: e.from,
      to: e.to,
      points: pts,
      label: e.label || null,
      labelAt: midPoint(pts),
      kind: e.kind || 'sync',
      fromSide,
      toSide,
    });
  }

  return finalize({ type: 'architecture', boxes: [...boxById.values()], frames, edges: edgesRes, vb });
}

// ============ flow ============
export function layoutFlow(ir) {
  const vb = (ir.meta && ir.meta.viewBox) || [800, 500];
  const nodes = ir.nodes || [];
  const edges = ir.edges || [];
  const stages = ir.stages || [];
  const idSet = new Set(nodes.map((n) => n.id));
  const boxById = new Map();

  // 分层 + 反馈边识别（retry 环）。
  const { layer, back, key } = computeLayers(nodes, edges);
  const maxLayer = Math.max(0, ...nodes.map((n) => layer.get(n.id)));

  let frames = [];
  let edgesRes = [];

  if (stages.length) {
    const contentW = vb[0] - 2 * MARGIN;
    const colGap = STAGE_COL_GAP;
    let colX = MARGIN;
    const stageCols = [];
    for (const st of stages) {
      const stNodes = nodes.filter((n) => n.stage === st.id);
      const sizes = stNodes.map((n) => boxSize(n));
      const w = Math.max(STAGE.minColWidth, Math.max(...sizes.map((s) => s.width), 0));
      stageCols.push({ st, nodes: stNodes, sizes, x: colX, width: w });
      colX += w + colGap;
    }
    let maxColBottom = 0;
    for (const col of stageCols) {
      let cy = TITLE_H + FRAME_PAD;
      for (let i = 0; i < col.nodes.length; i += 1) {
        const b = makeBox(col.nodes[i], col.x + (col.width - col.sizes[i].width) / 2, cy);
        boxById.set(b.id, b);
        cy += col.sizes[i].height + ROW_GAP;
      }
      maxColBottom = Math.max(maxColBottom, cy - ROW_GAP);
    }
    frames = stageCols.map((col) => ({
      id: 'frame-' + col.st.id,
      x: Math.round(col.x),
      y: TITLE_H,
      width: Math.round(col.width),
      height: Math.round(maxColBottom - TITLE_H),
      label: col.st.label,
      role: col.st.role || 'neutral',
    }));
    const colIndexOf = (id) => {
      const n = nodes.find((x) => x.id === id);
      if (!n || !n.stage) return -1;
      return stageCols.findIndex((c) => c.st.id === n.stage);
    };
    for (const e of edges) {
      const fb = boxById.get(e.from);
      const tb = boxById.get(e.to);
      if (!fb || !tb) continue;
      const fi = colIndexOf(e.from);
      const ti = colIndexOf(e.to);
      let fromSide;
      let toSide;
      if (fi === ti || fi < 0 || ti < 0) {
        [fromSide, toSide] = relativeSides(fb, tb);
      } else if (ti > fi) { fromSide = 'right'; toSide = 'left'; } else { fromSide = 'left'; toSide = 'right'; }
      const pts = routeOrthogonal(fb, tb, fromSide, toSide, STUB);
      edgesRes.push({
        id: 'e-' + e.from + '-' + e.to,
        from: e.from,
        to: e.to,
        points: pts,
        label: e.label || null,
        labelAt: midPoint(pts),
        kind: e.kind || 'sync',
        fromSide,
        toSide,
      });
    }
  } else if (ir.layout === 'horizontal') {
    // S 型折行横排：按读序把节点贪心装进「行内可用宽」，行满折回下一行；
    // 行方向第 0 行左→右、第 1 行右→左、交替蛇形前进。折回边是行端两节点的
    // 短垂直共轴连接（干静竖线，无跨行长边）。回边（retry 环）走底侧外侧通道。
    // 画布宽受 min_font 门禁约束（正文按 ~700px 缩放仍须可读），故以 viewBox 宽折算
    // 每行可用宽，折行避免「单行塞太宽」把文字缩到不可读。
    const usableW = Math.max(320, vb[0] - 2 * MARGIN);
    // 行内水平间距：为横向边标签留足净空 = 最大标签宽 + 双侧净空 + 取整缓冲。
    const maxEdgeLabelW = Math.max(0, ...edges.map((e) => (e.label ? estimateTextWidth(e.label, LABEL_FONT) + LABEL_PAD : 0)));
    const H_GAP = Math.max(BOX.gap, Math.min(240, maxEdgeLabelW + 2 * LABEL_MIN_CLEAR + 3));
    // 读序 = 按层升序、层内按 IR 顺序（线性路线图即节点顺序）。
    const order = nodes
      .slice()
      .sort((a, b) => (layer.get(a.id) - layer.get(b.id)) || (nodes.indexOf(a) - nodes.indexOf(b)));
    // 贪心按可用宽折行，返回每行（读序）的 {id,size}。
    const rowOf = new Map();
    const rows = [];
    let cur = [];
    let curW = 0;
    for (const n of order) {
      const w = boxSize(n).width;
      if (cur.length && curW + w + H_GAP > usableW) {
        rows.push(cur);
        cur = [];
        curW = 0;
      }
      cur.push(n);
      curW += w + H_GAP;
    }
    if (cur.length) rows.push(cur);
    // 逐行放置（边缘对齐实验）：所有行的最左盒左缘统一贴 LEFT、最右盒右缘统一贴
    // RIGHT；行内间隙在 ≥H_GAP 前提下按需拉宽（justify），保证两端同时对齐。
    // 折回边不再锚盒中心，而是锚「齐平缘内缩 min(两盒宽)/2」处——两端右缘（或左缘）
    // 已齐平，固定内缩量给出共轴竖线，与中心锚法一样干净。
    const rowSizes = rows.map((row) => row.map((n) => boxSize(n)));
    const rowWs = rowSizes.map((sizes) => sizes.reduce((a, s) => a + s.width + H_GAP, 0) - H_GAP);
    const rowHs = rowSizes.map((sizes) => Math.max(...sizes.map((s) => s.height)));
    const LEFT = MARGIN;
    const RIGHT = MARGIN + Math.max(...rowWs);
    let y = TITLE_H + FRAME_PAD;
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r];
      const sizes = rowSizes[r];
      const ltr = r % 2 === 0;
      const n = row.length;
      const sumW = sizes.reduce((a, s) => a + s.width, 0);
      const gap = n > 1 ? (RIGHT - LEFT - sumW) / (n - 1) : 0;
      let acc = 0; // 已放置宽度累计（含间隙），按行方向从齐平端起算
      for (let i = 0; i < n; i += 1) {
        let x;
        if (n === 1) {
          // 单盒行贴折入侧：偶数行（LTR）折入在左，奇数行（RTL）折入在右。
          x = ltr ? LEFT : RIGHT - sizes[i].width;
        } else if (ltr) {
          x = LEFT + acc;
        } else {
          x = RIGHT - acc - sizes[i].width;
        }
        const b = makeBox(row[i], x, y);
        boxById.set(b.id, b);
        rowOf.set(row[i].id, r);
        acc += sizes[i].width + gap;
      }
      y += rowHs[r] + ROW_GAP;
    }
    // 边路由：同行→水平（随行方向），跨行→垂直（折回），回边→底侧通道。
    for (const e of edges) {
      const fb = boxById.get(e.from);
      const tb = boxById.get(e.to);
      if (!fb || !tb) continue;
      let fromSide;
      let toSide;
      let pts;
      if (back.has(key(e.from, e.to))) {
        fromSide = 'bottom';
        toSide = 'bottom';
        pts = routeBackEdgeH(fb, tb, [...boxById.values()]);
      } else if (rowOf.get(e.from) === rowOf.get(e.to)) {
        // 同行邻接：沿行前进方向水平连线。
        const ltr = (rowOf.get(e.from) % 2) === 0;
        if (ltr) { fromSide = 'right'; toSide = 'left'; } else { fromSide = 'left'; toSide = 'right'; }
        pts = routeOrthogonal(fb, tb, fromSide, toSide, STUB);
      } else if (tb.y >= fb.y) {
        // 折回 / 跨行（下行）：锚点取齐平缘内缩 min(两盒宽)/2 —— 两端盒在该侧已
        // 边缘对齐，固定内缩量给出共轴竖线（与旧中心锚法等价但不受盒宽差影响）。
        fromSide = 'bottom';
        toSide = 'top';
        const fromRow = rowOf.get(e.from);
        const foldRight = (fromRow % 2) === 0;
        const inset = Math.min(fb.width, tb.width) / 2;
        const ax = foldRight ? RIGHT - inset : LEFT + inset;
        pts = [[ax, fb.y + fb.height], [ax, tb.y]];
      } else {
        // 跨行但指向上方（非典型前向流）：退回中心锚正交路由。
        fromSide = 'bottom';
        toSide = 'top';
        pts = routeOrthogonal(fb, tb, fromSide, toSide, STUB);
      }
      edgesRes.push({
        id: 'e-' + e.from + '-' + e.to,
        from: e.from,
        to: e.to,
        points: pts,
        label: e.label || null,
        labelAt: midPoint(pts),
        kind: e.kind || 'sync',
        fromSide,
        toSide,
      });
    }
  } else {
    // 单链分层：每层一行居中；回边走左侧外侧通道，前向边自上而下。
    const contentW = vb[0] - 2 * MARGIN;
    let y = TITLE_H;
    for (let L = 0; L <= maxLayer; L += 1) {
      const layerNodes = nodes.filter((n) => layer.get(n.id) === L);
      if (!layerNodes.length) continue;
      const sizes = layerNodes.map((n) => boxSize(n));
      const totalW = sizes.reduce((a, s) => a + s.width, 0) + GAP * (layerNodes.length - 1);
      const startX = MARGIN + Math.max(0, (contentW - totalW) / 2);
      const boxY = y + FRAME_PAD;
      let cx = startX;
      for (let i = 0; i < layerNodes.length; i += 1) {
        const b = makeBox(layerNodes[i], cx, boxY);
        boxById.set(b.id, b);
        cx += sizes[i].width + GAP;
      }
      y = boxY + Math.max(...sizes.map((s) => s.height)) + ROW_GAP;
    }
    for (const e of edges) {
      const fb = boxById.get(e.from);
      const tb = boxById.get(e.to);
      if (!fb || !tb) continue;
      let fromSide;
      let toSide;
      let pts;
      if (back.has(key(e.from, e.to))) {
        // 回边：外侧绕行通道。
        fromSide = 'left';
        toSide = 'left';
        pts = routeBackEdge(fb, tb, [...boxById.values()]);
      } else {
        const lf = layer.get(e.from);
        const lt = layer.get(e.to);
        if (lt === lf) { [fromSide, toSide] = relativeSides(fb, tb); } else { fromSide = 'bottom'; toSide = 'top'; }
        pts = routeOrthogonal(fb, tb, fromSide, toSide, STUB);
      }
      edgesRes.push({
        id: 'e-' + e.from + '-' + e.to,
        from: e.from,
        to: e.to,
        points: pts,
        label: e.label || null,
        labelAt: midPoint(pts),
        kind: e.kind || 'sync',
        fromSide,
        toSide,
      });
    }
  }

  return finalize({ type: 'flow', boxes: [...boxById.values()], frames, edges: edgesRes, vb });
}

// ============ sequence ============
export function layoutSequence(ir) {
  const vb = (ir.meta && ir.meta.viewBox) || [800, 500];
  const participants = ir.participants || [];
  const messages = ir.messages || [];
  const contentW = vb[0] - 2 * MARGIN;
  const n = participants.length;
  let colW = n > 0 ? contentW / n : contentW;
  // 若某条消息标签过宽（宽于列间距），加宽列间距，保证标签可沿消息线平移到两条
  // 生命线之间、与生命线净空达标（否则宽标签必然压在某条生命线上）。
  const maxLW = Math.max(0, ...messages.map((m) => (m.label ? estimateTextWidth(m.label, LABEL_FONT) + LABEL_PAD : 0)));
  const needColW = maxLW + 2 * LABEL_MIN_CLEAR + 8;
  if (colW < needColW) colW = needColW;
  const partX = new Map();
  const boxes = [];
  for (let i = 0; i < n; i += 1) {
    const p = participants[i];
    const sz = boxSize({ label: p.label, role: p.role });
    const cx = MARGIN + colW * (i + 0.5);
    const x = cx - sz.width / 2;
    const y = TITLE_H;
    boxes.push({
      id: p.id,
      x: Math.round(x),
      y,
      width: sz.width,
      height: sz.height,
      cx: Math.round(cx),
      cy: Math.round(y + sz.height / 2),
      role: p.role,
      label: p.label,
      sublabel: null,
      kind: 'participant',
    });
    partX.set(p.id, cx);
  }

  const lifeTop = TITLE_H + SEQUENCE.lifeTopGap;
  const rowGap = SEQUENCE.rowGap;
  const msgTop = lifeTop + SEQUENCE.msgTopGap;
  const edges = [];
  let y = msgTop;

  for (const p of participants) {
    const x = partX.get(p.id);
    edges.push({
      id: 'life-' + p.id,
      from: p.id,
      to: p.id,
      points: [[x, lifeTop], [x, 0]],
      label: null,
      labelAt: null,
      kind: 'lifeline',
      fromSide: 'top',
      toSide: 'bottom',
    });
  }

  for (const m of messages) {
    const fx = partX.get(m.from);
    const tx = partX.get(m.to);
    if (fx == null || tx == null) continue;
    let pts;
    let fromSide;
    let toSide;
    if (m.from === m.to) {
      fromSide = 'right';
      toSide = 'right';
      pts = [
        [fx, y],
        [fx + SEQUENCE.selfLoopWidth, y],
        [fx + SEQUENCE.selfLoopWidth, y + SEQUENCE.selfLoopHeight],
        [fx, y + SEQUENCE.selfLoopHeight],
      ];
    } else {
      if (tx >= fx) { fromSide = 'right'; toSide = 'left'; } else { fromSide = 'left'; toSide = 'right'; }
      pts = routeOrthogonal(
        { x: fx, y, width: 0, height: 0, cx: fx, cy: y },
        { x: tx, y, width: 0, height: 0, cx: tx, cy: y },
        fromSide,
        toSide,
        STUB,
      );
    }
    edges.push({
      id: 'm-' + m.from + '-' + m.to + '-' + edges.length,
      from: m.from,
      to: m.to,
      points: pts,
      label: m.label || null,
      labelAt: midPoint(pts),
      kind: m.kind,
      fromSide,
      toSide,
    });
    y += rowGap;
  }

  const lifeBottom = y + SEQUENCE.lifeBottomPad;
  for (const e of edges) {
    if (e.kind === 'lifeline') {
      const x = e.points[0][0];
      e.points = [[x, lifeTop], [x, lifeBottom]];
    }
  }

  return finalize({ type: 'sequence', boxes, frames: [], edges, vb });
}

// ============ 分派 ============
export function layout(ir) {
  switch (ir && ir.type) {
    case 'architecture': return layoutArchitecture(ir);
    case 'flow': return layoutFlow(ir);
    case 'sequence': return layoutSequence(ir);
    default:
      return layoutArchitecture(ir);
  }
}
