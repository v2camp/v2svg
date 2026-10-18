// 结构性不变量测试：把「两处必须相等 / 集合必须闭合」这类约束固化成断言。
//
// 这些不变量一旦破了，表现都是**静默**的：检查全过、图看着不对。例如
//   - 放置器净空阈值 ≠ 检查器阈值 → 批量误报或漏报；
//   - marker id 在 defs 与 edgeStyle 两处各写一份 → 箭头静默消失；
//   - theme 的字号 ≠ typography 的常量 → 盒宽估算与实际渲染错位。
// 每一项都在这里用「读实际导出值」而不是「读副本」的方式断言，故不可能互相包庇。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TYPE_SCALE, BOX, EDGE_LABEL, EDGE_MASK_HEIGHT, FRAME } from '../lib/typography.mjs';
import { STROKE } from '../lib/typography.mjs';
import { ARROW_MARKER_IDS, MARKER_SHAPES, EDGE_STYLE, collectUrlRefs, collectIds } from '../lib/markers.mjs';
import { ROLE_KEYS, TOKENS, frameFill, styleBlock } from '../lib/theme.mjs';
import { renderSvg } from '../lib/render.mjs';
import { layout } from '../lib/layout.mjs';
import { runCompositionChecks, COMPOSITION_CHECK_NAMES } from '../lib/checks/composition.mjs';
import { runDocumentChecks, DOCUMENT_CHECK_NAMES, STANDARD_DOCUMENT_CHECK_NAMES } from '../lib/checks/document.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.join(HERE, '..', 'samples');
const readSample = (f) => JSON.parse(readFileSync(path.join(SAMPLES, f), 'utf8'));

export const cases = [
  {
    name: '边标签：净空阈值与名义矩形高相等且 ≥ 8',
    run() {
      if (EDGE_LABEL.clearance !== EDGE_LABEL.rectHeight) {
        throw new Error(`clearance(${EDGE_LABEL.clearance}) !== rectHeight(${EDGE_LABEL.rectHeight})，会导致净空误报`);
      }
      if (EDGE_LABEL.clearance < 8) throw new Error('clearance 必须 ≥ 8');
      return `clearance = rectHeight = ${EDGE_LABEL.clearance}`;
    },
  },
  {
    name: '边标签：背景遮罩必须高于名义矩形（文字 bbox ≈ 1.25em）',
    run() {
      const textBoxH = TYPE_SCALE.edgeLabel.px * 1.25;
      if (EDGE_MASK_HEIGHT <= EDGE_LABEL.rectHeight) {
        throw new Error(`遮罩高 ${EDGE_MASK_HEIGHT} 未超过名义高 ${EDGE_LABEL.rectHeight}`);
      }
      if (EDGE_MASK_HEIGHT < textBoxH) {
        throw new Error(`遮罩高 ${EDGE_MASK_HEIGHT} < 12px 文字的 bbox 高 ${textBoxH}，会漏出连线`);
      }
      if (EDGE_LABEL.maskPadX < EDGE_LABEL.rectPadX) {
        throw new Error('遮罩左右留白应 ≥ 名义矩形留白（估算宽有实测误差，需要安全边）');
      }
      if (EDGE_LABEL.baselineOffset !== 0) {
        throw new Error('`.edge-label` 已用 dominant-baseline:central 居中，baselineOffset 必须为 0');
      }
      return `遮罩高 ${EDGE_MASK_HEIGHT} > 名义高 ${EDGE_LABEL.rectHeight}，文字盒高 ${textBoxH}`;
    },
  },
  {
    name: '盒几何自洽',
    run() {
      if (!(BOX.maxWidth > BOX.minWidth)) throw new Error('maxWidth 必须 > minWidth');
      if (BOX.maxWidth - 2 * BOX.padX <= 0) throw new Error('可用内宽必须为正');
      if (!(BOX.heightDouble > BOX.heightSingle)) throw new Error('双行盒必须高于单行盒');
      if (BOX.lineHeight <= 0) throw new Error('lineHeight 必须为正');
      return `盒宽 ${BOX.minWidth}–${BOX.maxWidth}，内宽 ${BOX.maxWidth - 2 * BOX.padX}，行高 ${BOX.lineHeight}`;
    },
  },
  {
    name: '圆角梯度：外层组框圆角 > 内层节点圆角',
    run() {
      // 读实际导出值比较，不写死数字：容器比节点更「钝」才有由外到内的层次。
      // 两者相等或反向会在视觉上让组框与节点融成一片（尤其组框已着域色后）。
      if (!(FRAME.radius > BOX.radius)) {
        throw new Error(`FRAME.radius(${FRAME.radius}) 必须 > BOX.radius(${BOX.radius})`);
      }
      return `FRAME.radius ${FRAME.radius} > BOX.radius ${BOX.radius}`;
    },
  },
  {
    name: '组框填充不退化：≠ 同 role 节点填充，且 ≠ 画布',
    run() {
      // 强度说明：这是**「不等于」断言**，不是感知阈值断言。它只保证组框填充没有塌缩成
      // 同一个色值，**不保证**肉眼一定可分辨——可辨识度由 headless 浏览器实测佐证
      // （见 design-system.md §2.3 的渲染级验证）。
      // 背景：v2svg 约定「节点 role 与所属域一致」，节点常与所在带同 role；若两者填充
      // 取值相同（向画布混时 neutral 会这样），节点在自己的带里就看不见了。
      const modes = ['light', 'dark'];
      const bad = [];
      for (const mode of modes) {
        const canvas = TOKENS[mode].canvas;
        for (const r of ROLE_KEYS) {
          const ff = frameFill(mode, r);
          const rf = TOKENS[mode].roles[r].fill;
          if (ff === rf) bad.push(`${mode}/${r}: frameFill(${ff}) === role.fill(${rf})，带与同域节点同色`);
          if (ff === canvas) bad.push(`${mode}/${r}: frameFill(${ff}) === canvas(${canvas})，带与页面同色`);
        }
      }
      if (bad.length) throw new Error(bad.join('；'));
      return `${modes.length} 套 mode × ${ROLE_KEYS.length} 个 role 的 frameFill 均 ≠ role.fill 且 ≠ canvas`;
    },
  },
  {
    name: 'marker 契约：三向闭合（定义集合 = 契约集合 = 被引用集合）',
    run() {
      const referenced = new Set();
      for (const st of Object.values(EDGE_STYLE)) if (st.marker) referenced.add(st.marker);
      for (const id of ARROW_MARKER_IDS) {
        if (!MARKER_SHAPES[id]) throw new Error(`契约声明了 marker ${id}，但 MARKER_SHAPES 没有对应形状`);
        if (!referenced.has(id)) throw new Error(`marker ${id} 定义了却没有任何 EDGE_STYLE 引用（死定义）`);
      }
      for (const id of referenced) {
        if (!ARROW_MARKER_IDS.includes(id)) throw new Error(`EDGE_STYLE 引用了契约外的 marker ${id}`);
      }
      const kinds = Object.keys(EDGE_STYLE);
      for (const k of kinds) {
        if (!EDGE_STYLE[k].marker && k !== 'lifeline') {
          throw new Error(`kind ${k} 无 marker，且不是 lifeline`);
        }
      }
      return `${ARROW_MARKER_IDS.length} 个 marker、${referenced.size} 处引用、${kinds.length} 种 edge kind`;
    },
  },
  {
    name: 'marker 契约：渲染产物里的 defs 与引用双向可达',
    run() {
      const svg = renderSvg(readSample('oauth-login.sequence.json'));
      const ids = new Set(collectIds(svg));
      const refs = collectUrlRefs(svg);
      const dangling = [...new Set(refs.filter((r) => !ids.has(r)))];
      if (dangling.length) throw new Error(`悬空引用：${dangling.join(', ')}`);
      const definedMarkers = [...svg.matchAll(/<marker\b[^>]*\bid\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      const extra = definedMarkers.filter((id) => !ARROW_MARKER_IDS.includes(id));
      if (extra.length) throw new Error(`defs 含契约外 marker：${extra.join(', ')}`);
      const missing = ARROW_MARKER_IDS.filter((id) => !definedMarkers.includes(id));
      if (missing.length) throw new Error(`契约 marker 未定义：${missing.join(', ')}`);
      return `${definedMarkers.length} 个定义、${refs.length} 处引用，双向可达`;
    },
  },
  {
    name: 'theme 的 CSS 字号与 typography 常量一致',
    run() {
      const css = styleBlock();
      const expect = {
        title: TYPE_SCALE.title.px,
        desc: TYPE_SCALE.caption.px,
        caption: TYPE_SCALE.caption.px,
        'frame-label': TYPE_SCALE.frameLabel.px,
        'n-label': TYPE_SCALE.nodeTitle.px,
        'n-sub': TYPE_SCALE.nodeSub.px,
        'edge-label': TYPE_SCALE.edgeLabel.px,
        'legend-label': TYPE_SCALE.legend.px,
      };
      const bad = [];
      for (const [cls, px] of Object.entries(expect)) {
        const m = css.match(new RegExp(`\\.${cls}\\s*\\{[^}]*font-size:\\s*([0-9.]+)px`));
        if (!m) { bad.push(`.${cls} 缺少 font-size 规则`); continue; }
        if (Math.abs(parseFloat(m[1]) - px) > 0.001) bad.push(`.${cls} CSS ${m[1]}px ≠ 常量 ${px}px`);
      }
      // 线宽同样必须同源
      const swEdge = css.match(/\.edge\s*\{[^}]*stroke-width:\s*([0-9.]+)/);
      if (!swEdge || Math.abs(parseFloat(swEdge[1]) - STROKE.edge) > 0.001) bad.push('`.edge` 线宽与 STROKE.edge 不一致');
      if (bad.length) throw new Error(bad.join('；'));
      return `${Object.keys(expect).length} 项字号 + edge 线宽与常量同源`;
    },
  },
  {
    name: '检查项名清单与实际返回的检查一一对应',
    run() {
      const ir = readSample('order-system.architecture.json');
      const comp = runCompositionChecks(ir, layout(ir), 'showcase').map((c) => c.name);
      const doc = runDocumentChecks({ ir, svgPath: null, docDir: null, options: {} }).map((c) => c.name);
      const cmp = (label, got, want) => {
        const g = got.join(',');
        const w = want.join(',');
        if (g !== w) throw new Error(`${label} 名清单与实际不符：实际 [${g}] vs 清单 [${w}]`);
      };
      cmp('构图', comp, COMPOSITION_CHECK_NAMES);
      cmp('文档', doc, DOCUMENT_CHECK_NAMES);
      const docSet = new Set(DOCUMENT_CHECK_NAMES);
      for (const n of STANDARD_DOCUMENT_CHECK_NAMES) {
        if (!docSet.has(n)) throw new Error(`standard 档引用了不存在的文档检查 ${n}`);
      }
      return `构图 ${comp.length} 项、文档 ${doc.length} 项、standard 档 ${STANDARD_DOCUMENT_CHECK_NAMES.length} 项`;
    },
  },
  {
    name: 'portrait_strip：竖向长条拦截、横向/小图/豁免三态放行',
    run() {
      const mk = (n, metaExtra = {}, layoutMode) => ({
        type: 'flow',
        ...(layoutMode ? { layout: layoutMode } : {}),
        meta: { title: 't', ...metaExtra },
        nodes: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `步骤${i}`, role: 'capability' })),
        edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
      });
      const pick = (ir) => runCompositionChecks(ir, layout(ir), 'showcase').find((c) => c.name === 'portrait_strip');
      const tall = pick(mk(5));
      if (tall.ok) throw new Error(`竖向 5 节点链应被拦截：${tall.details.join('；')}`);
      const wide = pick(mk(5, { viewBox: [1000, 720] }, 'horizontal'));
      if (!wide.ok) throw new Error(`横向 5 节点链不应被拦截：${wide.details.join('；')}`);
      const small = pick(mk(3));
      if (!small.ok) throw new Error(`3 节点小图不应被拦截：${small.details.join('；')}`);
      const exempt = pick(mk(5, { allowPortrait: '测试：确需强调纵深层级的竖向场景' }));
      if (!exempt.ok) throw new Error(`已声明 allowPortrait 应放行：${exempt.details.join('；')}`);
      return '拦截 1 · 放行 3（横向 / 小图 / 豁免）';
    },
  },
  {
    name: '横向折行边路由：邻接共享锚高 / 跳格与回边车道 / 非折回跨行车道 / 侧向通道',
    run() {
      const pick = (ir, name) => runCompositionChecks(ir, layout(ir), 'showcase').find((c) => c.name === name);
      const assertOk = (ir, name) => {
        const c = pick(ir, name);
        if (!c.ok) throw new Error(`${name} 应通过：${c.details.join('；')}`);
      };
      const LONG = '这是一段足够长的节点标签文本会折成两行';
      // ① 同行邻接混合盒高：边必须是共享锚高的两点直线（消 <16px 竖向台阶）。
      const adj = {
        type: 'flow', layout: 'horizontal', meta: { title: 't', viewBox: [1000, 720] },
        nodes: [
          { id: 'a', label: '短', role: 'capability' },
          { id: 'b', label: LONG, role: 'capability' },
          { id: 'c', label: '短二', role: 'capability' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
        ],
      };
      const adjLr = layout(adj);
      const ab = adjLr.edges.find((e) => e.from === 'a' && e.to === 'b');
      const aBox = adjLr.boxes.find((b) => b.id === 'a');
      const bBox = adjLr.boxes.find((b) => b.id === 'b');
      if (aBox.height === bBox.height) throw new Error('前置：两盒高度应不同（单行 vs 双行标签）');
      if (ab.points.length !== 2 || ab.points[0][1] !== ab.points[1][1]) {
        throw new Error(`混合盒高邻接边应为水平直线：${JSON.stringify(ab.points)}`);
      }
      assertOk(adj, 'route_rhythm');
      // ② 同行跳格 + 区间重叠双跳格：走行下通道、不穿盒、不共走廊。
      const skip = {
        type: 'flow', layout: 'horizontal', meta: { title: 't', viewBox: [1000, 720] },
        nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: `节点${id}`, role: 'capability' })),
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'd' },
          { from: 'a', to: 'c', label: '跳一' },
          { from: 'b', to: 'd', label: '跳二' },
        ],
      };
      const skipLr = layout(skip);
      const ac = skipLr.edges.find((e) => e.from === 'a' && e.to === 'c');
      if (ac.points.length < 4 || ac.fromSide !== 'bottom' || ac.toSide !== 'bottom') {
        throw new Error(`跳格边应走行下通道（bottom→bottom 四点）：${JSON.stringify(ac.points)}`);
      }
      assertOk(skip, 'relationship_crossings');
      assertOk(skip, 'relationship_corridors');
      assertOk(skip, 'route_rhythm');
      // ③ 跨行下行非折回对：首点必须落在源盒底缘、末点必须落在目标盒顶缘 x 跨度内。
      const xdown = {
        type: 'flow', layout: 'horizontal', meta: { title: 't', viewBox: [620, 720] },
        nodes: [
          { id: 'a', label: '源甲', role: 'capability' },
          { id: 'b', label: '桥乙', role: 'capability' },
          { id: 'c', label: '汇丙', role: 'capability' },
          { id: 'd', label: '终丁', role: 'capability' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'c' },
          { from: 'c', to: 'd' },
          { from: 'a', to: 'd', label: '直达' },
        ],
      };
      const xLr = layout(xdown);
      const ad = xLr.edges.find((e) => e.from === 'a' && e.to === 'd');
      const xa = xLr.boxes.find((b) => b.id === 'a');
      const xd = xLr.boxes.find((b) => b.id === 'd');
      if (xa.y === xd.y) throw new Error('前置：a 与 d 应跨行');
      const first = ad.points[0];
      const last = ad.points[ad.points.length - 1];
      if (first[0] < xa.x || first[0] > xa.x + xa.width || first[1] !== xa.y + xa.height) {
        throw new Error(`非折回跨行边首点应锚源盒底缘：${JSON.stringify(first)} vs ${JSON.stringify(xa)}`);
      }
      if (last[0] < xd.x || last[0] > xd.x + xd.width || last[1] !== xd.y) {
        throw new Error(`非折回跨行边末点应锚目标盒顶缘跨度内：${JSON.stringify(last)} vs ${JSON.stringify(xd)}`);
      }
      assertOk(xdown, 'relationship_crossings');
      assertOk(xdown, 'route_rhythm');
      // ④ 跨行上行回边底侧封死 → 内侧/侧向通道：不穿盒、首末段垂直于声明 side。
      // 注：viewBox 给足 1000 宽 —— 行折叠预算含尾部 H_GAP，长标签边会把 H_GAP 撑大，
      // 窄画布下每行只装 1 盒退化成竖条（已入库图锁定该打包口径，此处不测打包只测路由）。
      const upback = {
        type: 'flow', layout: 'horizontal', meta: { title: 't', viewBox: [1000, 720] },
        nodes: [
          { id: 's', label: '起点', role: 'interaction' },
          { id: 'k', label: '右一宽宽宽宽', role: 'capability' },
          { id: 'g', label: '生成', role: 'capability' },
          { id: 't2', label: '右二宽宽宽宽', role: 'capability' },
          { id: 'v', label: '校验', role: 'control' },
          { id: 't3', label: '右三宽宽宽宽', role: 'capability' },
          { id: 'x', label: '落档宽宽宽', role: 'neutral' },
        ],
        edges: [
          { from: 's', to: 'k' },
          { from: 'k', to: 'g' },
          { from: 'g', to: 't2' },
          { from: 't2', to: 'v' },
          { from: 'v', to: 't3' },
          { from: 't3', to: 'x' },
          { from: 'v', to: 'g', label: 'retry（≤2 次 · 带 reason）' },
        ],
      };
      assertOk(upback, 'relationship_crossings');
      assertOk(upback, 'orthogonal_arrows');
      assertOk(upback, 'label_route_clearance');
      const upLr = layout(upback);
      const vg = upLr.edges.find((e) => e.from === 'v' && e.to === 'g');
      if (vg.points.length < 4) throw new Error(`上行回边应绕通道（≥4 点）：${JSON.stringify(vg.points)}`);
      return '邻接直线 · 跳格车道 · 跨行车道 · 上行回边通道 四类形态各自成立';
    },
  },
  {
    name: 'role 集合闭合：theme 与 layout 图例同源',
    run() {
      const ir = readSample('order-system.architecture.json');
      const lr = layout(ir);
      for (const b of lr.boxes) {
        if (!ROLE_KEYS.includes(b.role)) throw new Error(`box ${b.id} 的 role ${b.role} 不在 ROLE_KEYS 内`);
      }
      if (lr.legend) {
        for (const en of lr.legend.entries) {
          if (!ROLE_KEYS.includes(en.role)) throw new Error(`legend 含未知 role ${en.role}`);
        }
      }
      return `${ROLE_KEYS.length} 个 role 闭合`;
    },
  },
  {
    name: 'theme：light 档不跟随宿主主题，且等于 follow 去掉暗色块的结果',
    run() {
      // 这条不变量是「批量去暗色」改造的正确性依据：
      // 若两者不等，说明 light 档动了亮色块本身，而不只是省掉暗色块 ——
      // 那样批量改造会静默改变配色。
      const follow = styleBlock('follow');
      const def = styleBlock();
      const light = styleBlock('light');
      if (def !== follow) throw new Error('默认档必须等同 follow（向后兼容，不能改默认行为）');
      if (!follow.includes('@media (prefers-color-scheme: dark)')) {
        throw new Error('follow 档必须包含 prefers-color-scheme 暗色块');
      }
      if (light.includes('prefers-color-scheme')) {
        throw new Error('light 档不应包含任何 prefers-color-scheme');
      }
      // 按「整块删除」语义剥离暗色块：从 @media 行起，到其后第一个顶层 `}` 止。
      const lines = follow.split('\n');
      const start = lines.findIndex((l) => l === '@media (prefers-color-scheme: dark) {');
      if (start < 0) throw new Error('找不到暗色块起始行');
      let end = start + 1;
      while (end < lines.length && lines[end] !== '}') end += 1;
      const stripped = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
      if (stripped !== light) {
        throw new Error('follow 去掉暗色块 ≠ light —— 已入库 SVG 将无法用 light 档复现');
      }
      return 'light = follow 去暗色块（逐字节相等）';
    },
  },
];
