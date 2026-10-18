// 组合质量检查（12 项）：把本项目的 LayoutResult 适配成 geometry.mjs 各 collector 期望的入参形状后调用。
//
// 适配层说明：
//   - geometry 的 collector 期望 routedRelations 形如
//     { relation:{from,to,id?}, points:[[x,y],...], relationIndex }；
//     而我们的 LayoutResult.edges 是 { id, from, to, points, label, labelAt, kind, fromSide, toSide }。
//     因此统一包一层 buildRoutes()。
//   - 框/容器（frames）是 { x,y,width,height,... }，可直接传给 collectBorderRuns。
//
// 复用情况（见报告）：
//   isFinitePoint / rectsOverlap / segmentIntersectsRect / collectLabelRouteClearance /
//   routeHonorsEndpointSides / collectAmbiguousCorridors / collectBorderRuns /
//   collectRouteRhythmIssues 均直接复用 geometry.mjs。
//
// profile 仅影响 CLI 层跑哪些文档集成专项，组合检查两档完全一致，故此处固定全跑。

import {
  isFinitePoint,
  rectsOverlap,
  segmentIntersectsRect,
  collectLabelRouteClearance,
  routeHonorsEndpointSides,
  collectAmbiguousCorridors,
  collectBorderRuns,
  collectRouteRhythmIssues,
} from '../geometry.mjs';

// 允许 import layout.mjs / text-metrics.mjs（计划明确授权），
// 用于复用与渲染器**同一份**的文字宽度估算与排版常量。
import { estimateTextWidth } from '../text-metrics.mjs';
import { EDGE_LABEL, TYPE_SCALE } from '../typography.mjs';

const LABEL_FONT = TYPE_SCALE.edgeLabel.px;   // 边标签字号，与 theme.mjs 的 .edge-label 同源
const LABEL_HEIGHT = EDGE_LABEL.rectHeight;   // 边标签矩形高（= 净空阈值）
const LABEL_PAD = EDGE_LABEL.rectPadX;        // 标签矩形左右留白

// 把 LayoutResult 的 edges 包成 geometry collector 期望的 routedRelations。
function buildRoutes(edges) {
  return edges.map((e, i) => ({
    relation: { id: e.id, from: e.from, to: e.to, label: e.label },
    points: e.points,
    relationIndex: i,
  }));
}

// 生成边标签矩形（用于 label_route_clearance）。
// 说明：LayoutResult 不含标签尺寸，这里用与渲染器一致的估算得到标签宽高，
// 以 labelAt 为锚点生成矩形；阈值在下文单独取「标签短轴高度」并注释说明。
function buildLabelRect(edge) {
  const w = estimateTextWidth(edge.label || '', LABEL_FONT) + LABEL_PAD;
  const [lx, ly] = edge.labelAt || [0, 0];
  return {
    x: lx - w / 2,
    y: ly - LABEL_HEIGHT / 2,
    width: w,
    height: LABEL_HEIGHT,
  };
}

// 把若干盒子（box/frame）伪装成「路由」，使 collectLabelRouteClearance 一并检查标签与盒子的净空。
function boxRoutes(boxes) {
  return boxes.map((b, i) => {
    const id = `box:${b.id}`;
    return {
      relation: { id, from: id, to: id },
      // 闭环矩形周长（四条边），segmentRectClearance 会求标签矩形到每条边的距离。
      points: [
        [b.x, b.y],
        [b.x + b.width, b.y],
        [b.x + b.width, b.y + b.height],
        [b.x, b.y + b.height],
        [b.x, b.y],
      ],
      relationIndex: i,
    };
  });
}

const round = (n) => Math.round(n * 10) / 10;

// ============ 1. finite_svg ============
function checkFiniteSvg(lr) {
  const bad = [];
  const scan = (nums, where) => {
    nums.forEach((v, i) => { if (!Number.isFinite(v)) bad.push(`${where}[${i}]=${v}`); });
  };
  for (const b of lr.boxes || []) scan([b.x, b.y, b.width, b.height, b.cx, b.cy], `box ${b.id}`);
  for (const f of lr.frames || []) scan([f.x, f.y, f.width, f.height], `frame ${f.id}`);
  for (const e of lr.edges || []) (e.points || []).forEach((p, i) => scan([p[0], p[1]], `edge ${e.id} 点${i}`));
  if (lr.legend) scan([lr.legend.x, lr.legend.y, lr.legend.width, lr.legend.height], 'legend');
  const ok = bad.length === 0;
  return { name: 'finite_svg', ok, details: ok ? ['所有坐标均为有限数（无 NaN/Infinity）'] : bad };
}

// ============ 2. entity_coverage ============
// 「IR 里声明了、产物里却没有」是**静默**的 —— 实测到的形态：
//   - flow + stages 模式：节点靠 `n.stage === st.id` 归列，`stage` 缺失或值不存在时
//     该节点不在任何列里，**直接不渲染**（architecture 则会把未分组节点塞进附加带，不丢）；
//   - 三种类型的布局都用 `if (!fb || !tb) continue;` 跳过端点不存在的边/消息，
//     **边/消息被静默丢弃** —— 图看上去完整，拓扑却是错的。
// 而所有既有检查都看不见：它们检查的正是「已经被丢弃之后」的集合。
// 本检查把 IR 的声明与 LayoutResult 的实际产出对账。
//
// 只报「真丢弃」。*空容器*（声明了 group/stage 但无节点引用）不算丢弃 —— 它的框仍被渲染，
// 故只在通过时作为附注列出。
function checkEntityCoverage(ir, lr) {
  const declaredNodes = (ir?.nodes || ir?.participants || []).map((n) => n.id);
  const declaredEdges = [
    ...(ir?.edges || []).map((e) => ({ from: e.from, to: e.to, kind: 'edge', label: e.label })),
    ...(ir?.messages || []).map((m) => ({ from: m.from, to: m.to, kind: 'message', label: m.label })),
  ];

  // 产出的盒子 / 边（生命线不是「声明的边」，排除）
  const boxIds = new Set((lr.boxes || []).map((b) => b.id));
  const edgeCount = new Map();
  for (const e of lr.edges || []) {
    if (e.kind === 'lifeline') continue;
    const k = `${e.from}->${e.to}`;
    edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
  }

  const fails = [];
  for (const id of declaredNodes) {
    if (!boxIds.has(id)) {
      fails.push(`节点/参与者 ${id} 声明了但未出现在产物里`
        + (ir?.stages?.length ? `（flow 的 stages 模式下，node.stage 必须匹配某个 stages[].id）` : ''));
    }
  }
  const need = new Map();
  for (const e of declaredEdges) {
    const k = `${e.from}->${e.to}`;
    need.set(k, (need.get(k) || 0) + 1);
  }
  for (const [k, n] of need) {
    const got = edgeCount.get(k) || 0;
    if (got < n) {
      const [from, to] = k.split('->');
      fails.push(`边/消息 ${from} → ${to} 声明了 ${n} 条但产物里只有 ${got} 条（端点 id 是否存在？）`);
    }
  }

  if (fails.length) return { name: 'entity_coverage', ok: false, details: fails };

  // 通过时附注空容器（不算失败，但值得一眼看到）
  const notes = [];
  const referenced = new Set();
  for (const n of [...(ir?.nodes || []), ...(ir?.participants || [])]) {
    if (n.group) referenced.add(n.group);
    if (n.stage) referenced.add(n.stage);
  }
  for (const g of [...(ir?.groups || []), ...(ir?.stages || [])]) {
    if (!referenced.has(g.id)) notes.push(`附注：group/stage「${g.label || g.id}」没有任何节点，框内会是空的`);
  }
  return {
    name: 'entity_coverage',
    ok: true,
    details: [
      `IR 声明的 ${declaredNodes.length} 个节点/参与者与 ${declaredEdges.length} 条边/消息均已渲染`,
      ...notes,
    ],
  };
}

// ============ 3. node_overlap ============
function checkNodeOverlap(lr) {
  const boxes = lr.boxes || [];
  const hits = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (rectsOverlap(boxes[i], boxes[j], 8)) {
        hits.push(`box ${boxes[i].id} 与 box ${boxes[j].id} 重叠（间距 < 8px）`);
      }
    }
  }
  const ok = hits.length === 0;
  return { name: 'node_overlap', ok, details: ok ? [`${boxes.length} 个 box 两两不相交（gap≥8px）`] : hits };
}

// ============ 6. relationship_crossings ============
function checkRelationshipCrossings(lr) {
  const edges = lr.edges || [];
  const boxes = lr.boxes || [];
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const hits = [];
  for (const e of edges) {
    const fb = boxById.get(e.from);
    const tb = boxById.get(e.to);
    const pts = e.points || [];
    for (let s = 0; s < pts.length - 1; s += 1) {
      const seg = { start: pts[s], end: pts[s + 1] };
      for (const b of boxes) {
        if (fb && b.id === fb.id) continue; // 排除起点的所属 box
        if (tb && b.id === tb.id) continue; // 排除终点的所属 box
        if (segmentIntersectsRect(seg, b, 0)) {
          hits.push(`edge ${e.id} 第 ${s} 段穿越无关 box ${b.id}`);
          break;
        }
      }
    }
  }
  const ok = hits.length === 0;
  return { name: 'relationship_crossings', ok, details: ok ? ['所有边均不穿越无关节点框'] : hits };
}

// ============ 7. label_route_clearance ============
function checkLabelRouteClearance(lr) {
  const edges = lr.edges || [];
  const boxes = lr.boxes || [];
  // 仅对带 label 且 labelAt 已定位的边构造标签。
  const labels = [];
  const edgeRoutes = [];
  edges.forEach((e, i) => {
    edgeRoutes.push({ relation: { id: e.id, from: e.from, to: e.to, label: e.label }, points: e.points, relationIndex: i });
    if (e.label && e.labelAt) {
      labels.push({
        label: e.label,
        relationIndex: i,
        relation: { id: e.id, from: e.from, to: e.to, label: e.label },
        rect: buildLabelRect(e),
      });
    }
  });
  // 阈值说明：若按「净空 > 标签自身宽度」取阈值，时序图这类纵向密集排布会全部被否决
  // （相邻消息行仅 44px，而标签宽度常 >100px）。故改取标签的**短轴高度**为净空阈值，
  // 既保证标签不与其它边/盒子重叠，又不至于误杀密集图。若需更严格可上调。
  // 该阈值必须与放置器（lib/layout.mjs）用的 EDGE_LABEL.clearance 一致，见 lib/typography.mjs。
  const threshold = Math.max(8, LABEL_HEIGHT);
  const routedRelations = [...edgeRoutes, ...boxRoutes(boxes)];
  const hits = collectLabelRouteClearance({ labels, routedRelations, threshold });
  const details = hits.map((h) => {
    const other = h.otherRelation?.id || h.otherRelationIndex;
    return `label「${h.label?.label || ''}」(edge ${h.labelRelationIndex}) 与 ${other} 净空 ${round(h.clearance)}px < 阈值 ${threshold}px`;
  });
  const ok = hits.length === 0;
  return {
    name: 'label_route_clearance',
    ok,
    details: ok ? [`全部 ${labels.length} 个标签与任何边/盒子净空 ≥ ${threshold}px`] : details,
  };
}

// ============ 8. orthogonal_arrows ============
function checkOrthogonalArrows(lr) {
  const edges = lr.edges || [];
  const hits = [];
  for (const e of edges) {
    // 生命线为结构性辅助线，其 fromSide/toSide 并非方向契约，跳过。
    if (e.kind === 'lifeline') continue;
    if (!e.fromSide || !e.toSide) continue; // 未显式指定则无法校验
    if (!routeHonorsEndpointSides(e.points, e.fromSide, e.toSide)) {
      hits.push(`edge ${e.id} 首尾段未垂直于 fromSide=${e.fromSide}/toSide=${e.toSide}`);
    }
  }
  const ok = hits.length === 0;
  return { name: 'orthogonal_arrows', ok, details: ok ? ['所有边首尾段垂直于其 fromSide/toSide'] : hits };
}

// ============ 9. relationship_corridors ============
function checkRelationshipCorridors(lr) {
  const edges = lr.edges || [];
  const routed = buildRoutes(edges);
  const hits = collectAmbiguousCorridors({ routedRelations: routed, minOverlapPx: 8 });
  const details = hits.map((h) => {
    const l = `${h.left.relation.from}->${h.left.relation.to}`;
    const r = `${h.right.relation.from}->${h.right.relation.to}`;
    return `edge ${l} 与 ${r} 共用 ${round(h.overlapLength)}px 重叠走廊`;
  });
  const ok = hits.length === 0;
  return { name: 'relationship_corridors', ok, details: ok ? ['不存在两条边共用无法区分的重叠走廊'] : details };
}

// ============ 10. container_border_runs ============
function checkContainerBorderRuns(lr) {
  const edges = lr.edges || [];
  const frames = lr.frames || [];
  const routed = buildRoutes(edges);
  const hits = collectBorderRuns({ routedRelations: routed, frames });
  const details = hits.map((h) => {
    const fLabel = h.frame?.label || h.frame?.id || `#${h.frameIndex}`;
    return `edge ${h.relation?.id} 贴 frame「${fLabel}」的 ${h.side} 边框并行 ${round(h.overlapLength)}px`;
  });
  const ok = hits.length === 0;
  return { name: 'container_border_runs', ok, details: ok ? ['没有边贴着容器边框长距离平行走'] : details };
}

// ============ 11. route_rhythm ============
function checkRouteRhythm(lr) {
  const edges = lr.edges || [];
  const routed = buildRoutes(edges);
  const issues = collectRouteRhythmIssues({ routedRelations: routed, interiorSegmentPx: 16, microSegmentPx: 8 });
  const details = issues.map((iss) => {
    const id = iss.relation?.id || iss.relationIndex;
    return `edge ${id} 第 ${iss.segmentIndex} 段 ${round(iss.length)}px(${iss.position}) < 阈值 ${iss.code === 'composition/micro-segment' ? 8 : 16}px`;
  });
  const ok = issues.length === 0;
  return { name: 'route_rhythm', ok, details: ok ? ['所有边转折节奏合理、无过短段'] : details };
}

// ============ 12. legend_clearance ============
function checkLegendClearance(lr) {
  const legend = lr.legend;
  if (!legend) return { name: 'legend_clearance', ok: true, details: ['无 legend，跳过'] };
  const obstacles = [...(lr.boxes || []), ...(lr.frames || [])];
  const hits = [];
  for (const o of obstacles) {
    if (rectsOverlap(legend, o, 8)) {
      hits.push(`legend 与 ${o.id || o.label || 'frame'} 重叠（间距 < 8px）`);
    }
  }
  const ok = hits.length === 0;
  return { name: 'legend_clearance', ok, details: ok ? ['legend 不与任何 box/容器重叠'] : hits };
}

// ============ 4. node_text_in_box ============
// 防止「色块与文字分离」：盒子的 cx/cy 是渲染文字用的锚点，
// 任何坐标变换（如画布自动贴合的平移）若只改 x/y 而不改 cx/cy，
// 检查集会全部通过、但成品会出现大量空色块。此检查直接锁死该不变量。
function checkNodeTextInBox(lr) {
  const boxes = lr.boxes || [];
  const hits = [];
  for (const b of boxes) {
    const cx = typeof b.cx === 'number' ? b.cx : b.x + b.width / 2;
    const cy = typeof b.cy === 'number' ? b.cy : b.y + b.height / 2;
    const inside =
      cx >= b.x && cx <= b.x + b.width &&
      cy >= b.y && cy <= b.y + b.height &&
      Number.isFinite(cx) && Number.isFinite(cy);
    if (!inside) {
      hits.push(
        `box ${b.id || '?'} 的文字锚点 (${round(cx)}, ${round(cy)}) 不在盒内 ` +
        `[x=${b.x} y=${b.y} w=${b.width} h=${b.height}]`
      );
    }
  }
  const ok = hits.length === 0;
  return {
    name: 'node_text_in_box',
    ok,
    details: ok ? [`${boxes.length} 个 box 的文字锚点均在盒内`] : hits,
  };
}

// ============ 5. text_not_truncated ============
// 折行上限是 2 行，超出即截断并在末行加「…」。截断 = 信息丢失，而 v2svg 的底线是
// 「删标签 = 删信息」—— 这类丢失必须在交付档被拦下，而不是靠肉眼在图里发现省略号。
// 判定依据是布局器给出的 truncated 标记（由 lib/text-metrics.mjs 的 wrapTextDetailed 产出）。
function checkTextNotTruncated(lr) {
  const hits = [];
  for (const b of lr.boxes || []) {
    if (!b.truncated) continue;
    const lines = [...(b.labelLines || []), ...(b.subLines || [])].join(' / ');
    hits.push(`box ${b.id} 文案被截断：${lines}（原始 label「${b.label}」超出 2 行上限）`);
  }
  const ok = hits.length === 0;
  return {
    name: 'text_not_truncated',
    ok,
    details: ok
      ? [`${(lr.boxes || []).length} 个 box 的文案均在 2 行内完整呈现`]
      : [...hits, '修法：缩短 label / sublabel 文案，或拆成两个节点；不要靠调大盒宽绕过（盒宽上限 240 是有意为之）'],
  };
}

// ============ 13. portrait_strip ============
// 竖向长条拦截（仅 flow）：嵌入竖排文档时，高宽比 > PORTRAIT_STRIP_RATIO 的瘦高图
// 会在正文两侧留下大片空白，主链骨架应改 layout:horizontal（S 型折行）。
// 节点 < PORTRAIT_STRIP_MIN_NODES 的小图与近方形图不拦；sequence/stages 等
// 天然纵向类型不拦。确需竖向（如强调纵深层级）须 meta.allowPortrait 声明理由。
const PORTRAIT_STRIP_RATIO = 1.2;
const PORTRAIT_STRIP_MIN_NODES = 4;
function checkPortraitStrip(ir, lr) {
  const name = 'portrait_strip';
  if (ir?.type !== 'flow') {
    return { name, ok: true, details: [`类型 ${ir?.type ?? '?'} 非 flow，不拦`] };
  }
  const w = Number(lr.width) || 0;
  const h = Number(lr.height) || 0;
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes.length : 0;
  const ratio = w > 0 ? h / w : 0;
  if (nodes < PORTRAIT_STRIP_MIN_NODES || ratio <= PORTRAIT_STRIP_RATIO) {
    return { name, ok: true, details: [`高宽比 ${ratio.toFixed(2)}（阈值 ≤ ${PORTRAIT_STRIP_RATIO}）· 节点 ${nodes}（阈值 ≥ ${PORTRAIT_STRIP_MIN_NODES}），不拦`] };
  }
  const ap = ir?.meta?.allowPortrait;
  if (typeof ap === 'string' && ap.trim().length >= 8) {
    return { name, ok: true, details: [`高宽比 ${ratio.toFixed(2)} > ${PORTRAIT_STRIP_RATIO} 且节点 ${nodes} ≥ ${PORTRAIT_STRIP_MIN_NODES}，已声明 meta.allowPortrait 豁免：${ap.trim()}`] };
  }
  return {
    name,
    ok: false,
    details: [`flow 图高宽比 ${ratio.toFixed(2)} > ${PORTRAIT_STRIP_RATIO} 且节点 ${nodes} ≥ ${PORTRAIT_STRIP_MIN_NODES}：竖向长条嵌入竖排文档会在两侧留白，改 layout: "horizontal"（S 型折行，viewBox 宽幅如 [1000,720]）；确需竖向请在 meta.allowPortrait 写明理由（≥8 字符）`],
  };
}

// ============ 入口 ============
export function runCompositionChecks(ir, layoutResult, profile) {
  const lr = layoutResult || {};
  // profile 仅影响 CLI 层；组合检查两档一致，固定跑全部。
  void profile;
  return [
    checkFiniteSvg(lr),
    checkEntityCoverage(ir, lr),
    checkNodeOverlap(lr),
    checkNodeTextInBox(lr),
    checkTextNotTruncated(lr),
    checkRelationshipCrossings(lr),
    checkLabelRouteClearance(lr),
    checkOrthogonalArrows(lr),
    checkRelationshipCorridors(lr),
    checkContainerBorderRuns(lr),
    checkRouteRhythm(lr),
    checkLegendClearance(lr),
    checkPortraitStrip(ir, lr),
  ];
}

// 检查项名清单（供 doctor 与文档口径断言使用，勿在别处再抄一份）。
export const COMPOSITION_CHECK_NAMES = [
  'finite_svg', 'entity_coverage', 'node_overlap', 'node_text_in_box', 'text_not_truncated',
  'relationship_crossings', 'label_route_clearance', 'orthogonal_arrows',
  'relationship_corridors', 'container_border_runs', 'route_rhythm', 'legend_clearance',
  'portrait_strip',
];
