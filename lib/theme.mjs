// 主题模块：配色 token、CSS 自定义属性、明暗切换、WCAG 对比度。
//
// 配色 token：亮色 / 暗色两套，语义固定，改动会影响 theme_readable 检查。
// 画布/正文/辅助/箭头来自同一节；panel、panelBorder、grid 不在表中，
// 选取与表格一致视觉梯度的值（亮色更浅、暗色更深），不影响节点对比度。

import { TYPE_SCALE, STROKE, FRAME, BOX, LEGEND, EDGE_LABEL } from './typography.mjs';

export const ROLE_KEYS = ['control', 'capability', 'interaction', 'warn', 'neutral'];

const f = (k) => `${TYPE_SCALE[k].px}px`;
const fw = (k) => `font-weight: ${TYPE_SCALE[k].weight};`;
const sw = (n) => `stroke-width: ${n};`;
const dash = (arr) => arr.join(' ');

export const TOKENS = {
  light: {
    canvas: '#f8fafc',
    panel: '#ffffff',
    panelBorder: '#e2e8f0',
    text: '#0f172a',
    muted: '#475569',
    arrow: '#94a3b8',
    grid: '#e2e8f0',
    roles: {
      // 描边取 600 级深色（= 该 role 的 text 值，不新增色值）：400–500 级饱和色作描边
      // 时「描边 vs 画布」对比度只有 2.18–3.78，撑不起卡片的轮廓语义。
      control: { fill: '#fdf4ff', stroke: '#7e22ce', text: '#7e22ce' },
      capability: { fill: '#f0fdf4', stroke: '#166534', text: '#166534' },
      interaction: { fill: '#eff6ff', stroke: '#1e40af', text: '#1e40af' },
      warn: { fill: '#fef2f2', stroke: '#b91c1c', text: '#b91c1c' },
      neutral: { fill: '#f8fafc', stroke: '#334155', text: '#334155' },
    },
  },
  dark: {
    canvas: '#0f172a',
    panel: '#1e293b',
    panelBorder: '#334155',
    text: '#e2e8f0',
    muted: '#cbd5e1',
    arrow: '#64748b',
    grid: '#1e293b',
    roles: {
      control: { fill: 'rgba(168,85,247,0.18)', stroke: '#c084fc', text: '#e9d5ff' },
      capability: { fill: 'rgba(74,222,128,0.16)', stroke: '#4ade80', text: '#bbf7d0' },
      interaction: { fill: 'rgba(96,165,250,0.16)', stroke: '#60a5fa', text: '#dbeafe' },
      warn: { fill: 'rgba(239,68,68,0.16)', stroke: '#f87171', text: '#fecaca' },
      neutral: { fill: 'rgba(148,163,184,0.14)', stroke: '#94a3b8', text: '#cbd5e1' },
    },
  },
};

// 取某模式下的完整 token 集合（含 roles 映射）。
export function tokensFor(mode) {
  const t = mode === 'dark' ? TOKENS.dark : TOKENS.light;
  return {
    canvas: t.canvas,
    panel: t.panel,
    panelBorder: t.panelBorder,
    text: t.text,
    muted: t.muted,
    arrow: t.arrow,
    grid: t.grid,
    roles: JSON.parse(JSON.stringify(t.roles)),
  };
}

// ---- 组框（frame）的域色 ----
//
// 组框此前一律是灰白面板（--panel / --panel-border），但 layout 已把域 role 带进
// frames[].role，语义白白丢掉。此处只给组框的**填充**着域色，描边沿用 .frame 的
// --panel-border（浅色）：角色分工是「最外层容器 = 最浅填充 + 浅描边，内层节点才用
// 600 级强调色」。若组框描边也用 600 级，节点在自己的带里反而看不见 —— v2svg 约定
// 「节点 role 与所属域一致」，节点常与所在带同 role，两者描边会撞成同一个色。
//   - 亮色填充：该 role 的 fill 向 panel（#ffffff）混 50%。panel 是亮度上界，故带头
//     恒比同 role 节点填充**亮**，任何 role 下节点都不会融进带里；若向画布混，neutral
//     的 fill（恰等于画布）会退化成「带 = 节点 = 页面」三色同值，节点在带内不可辨。
//   - 暗色填充：沿用半透明域色思路，把该 role 暗色 fill 的 alpha 降到 0.10（低于节点的
//     0.16–0.18，带比节点更暗一层）；不为 5 个域另造实底 hex。
export const FRAME_FILL_MIX = 0.5;
export const FRAME_DARK_ALPHA = 0.1;

export function frameFill(mode, role) {
  const t = mode === 'dark' ? TOKENS.dark : TOKENS.light;
  const rt = t.roles[role];
  if (!rt) return null;
  const fg = parseColor(rt.fill);
  if (mode === 'dark') {
    return `rgba(${fg[0]},${fg[1]},${fg[2]},${FRAME_DARK_ALPHA})`;
  }
  const bg = parseColor(t.panel);
  const mix = (i) => Math.round(fg[i] * FRAME_FILL_MIX + bg[i] * (1 - FRAME_FILL_MIX));
  return rgbHex(mix(0), mix(1), mix(2));
}

function rgbHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// 生成内联 <style> 文本。
//   theme = 'follow'（默认）：:root 亮色 + `prefers-color-scheme: dark` 自适应；宿主暗色时整图转暗。
//   theme = 'light'：只出亮色，**不跟随宿主主题**。
//     用于「图必须与读者主题无关」的嵌入场景（如文档/印刷物配图）——静态图会在 PDF、
//     文档预览、截图里流转，跟随宿主会让同一张图出现两种外观，破坏既有版式的固定配色。
export function styleBlock(theme = 'follow') {
  const lines = [];
  lines.push(':root {');
  lines.push(...varsLines(TOKENS.light, 'light'));
  lines.push('}');
  if (theme !== 'light') {
    lines.push('@media (prefers-color-scheme: dark) {');
    lines.push('  :root {');
    lines.push(...varsLines(TOKENS.dark, 'dark', '  '));
    lines.push('  }');
    lines.push('}');
  }
  lines.push('');
  lines.push(baseCss());
  return lines.join('\n');
}

function varsLines(t, mode, indent = '') {
  const out = [];
  out.push(`${indent}--canvas: ${t.canvas};`);
  out.push(`${indent}--panel: ${t.panel};`);
  out.push(`${indent}--panel-border: ${t.panelBorder};`);
  out.push(`${indent}--text: ${t.text};`);
  out.push(`${indent}--muted: ${t.muted};`);
  out.push(`${indent}--arrow: ${t.arrow};`);
  out.push(`${indent}--grid: ${t.grid};`);
  for (const r of ROLE_KEYS) {
    const role = t.roles[r];
    out.push(`${indent}--role-${r}-fill: ${role.fill};`);
    out.push(`${indent}--role-${r}-stroke: ${role.stroke};`);
    out.push(`${indent}--role-${r}-text: ${role.text};`);
    out.push(`${indent}--frame-${r}-fill: ${frameFill(mode, r)};`);
  }
  return out;
}

function baseCss() {
  const roleRules = [];
  for (const r of ROLE_KEYS) {
    // .role-X 直接作用于色块（图例 swatch）；盒子用 .role-X .node 上色。
    // 节点标题统一用中性 --text（近黑/近白）：role 色只承担「卡片填充 + 描边」的语义，
    // 若标题也取 role 同色系深色调，会与同色系浅底形成顺色（发灰、发虚）。
    roleRules.push(`.role-${r} { fill: var(--role-${r}-fill); stroke: var(--role-${r}-stroke); }`);
    roleRules.push(`.role-${r} .node { fill: var(--role-${r}-fill); stroke: var(--role-${r}-stroke); }`);
    // 组框只覆盖 fill，描边沿用 .frame 的 --panel-border（浅色）。
    // 必须排在 `.frame` 之后（同优先级、后者生效）才能覆盖灰白面板填充。
    roleRules.push(`.frame-${r} { fill: var(--frame-${r}-fill); }`);
  }
  return [
    'svg { background: var(--canvas); }',
    // 关键：role 的 stroke 定义在分组 <g class="role-*"> 上，SVG 中 g 的描边会被子元素继承。
    // 文本若不显式置 none，就会被套上 role 色描边（近黑字 + 蓝/紫/绿 1px 描边）——
    // 表现为「字发虚、发蓝、发糊」。此处对所有文本统一关闭描边。
    'text { stroke: none; }',
    `.title { fill: var(--text); font-size: ${f('title')}; ${fw('title')} }`,
    `.desc { fill: var(--muted); font-size: ${f('caption')}; }`,
    `.caption { fill: var(--muted); font-size: ${f('caption')}; }`,
    `.frame { fill: var(--panel); stroke: var(--panel-border); ${sw(STROKE.frame)} }`,
    `.frame-label { fill: var(--text); font-size: ${f('frameLabel')}; ${fw('frameLabel')} }`,
    `.node { ${sw(STROKE.node)} }`,
    `.n-label { fill: var(--text); font-size: ${f('nodeTitle')}; ${fw('nodeTitle')} dominant-baseline: central; }`,
    `.n-sub { fill: var(--muted); font-size: ${f('nodeSub')}; dominant-baseline: central; }`,
    `.edge { fill: none; stroke: var(--arrow); ${sw(STROKE.edge)} }`,
    `.edge-dashed { stroke-dasharray: ${dash(STROKE.edgeDashed)}; }`,
    `.edge-label { fill: var(--muted); font-size: ${f('edgeLabel')}; dominant-baseline: central; }`,
    `.lifeline { fill: none; stroke: var(--arrow); ${sw(STROKE.lifeline)} stroke-dasharray: ${dash(STROKE.lifelineDashed)}; }`,
    `.legend-box { fill: var(--panel); stroke: var(--panel-border); ${sw(STROKE.legendBox)} }`,
    `.legend-label { fill: var(--text); font-size: ${f('legend')}; dominant-baseline: central; }`,
    `.arrow-fill { fill: var(--arrow); }`,
    `.arrow-line { fill: none; stroke: var(--arrow); ${sw(STROKE.arrowPath)} }`,
    ...roleRules,
  ].join('\n');
}

// ---- WCAG 相对亮度对比度 ----

function parseColor(c) {
  if (typeof c !== 'string') return [0, 0, 0, 1];
  c = c.trim();
  if (c[0] === '#') {
    let h = c.slice(1);
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return [r, g, b, 1];
  }
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return [parts[0], parts[1], parts[2], parts[3] === undefined ? 1 : parts[3]];
  }
  return [0, 0, 0, 1];
}

// 将半透明前景按 alpha 与给定背景合成，得到不透明等效色。
function composite(fg, bg) {
  const a = fg[3];
  return [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
}

function relLuminance(r, g, b) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// 返回 1..21 的对比度。任一色为 rgba 时，按其 alpha 与另一色合成后再算。
export function contrastRatio(hexFg, hexBg) {
  let f = parseColor(hexFg);
  let b = parseColor(hexBg);
  if (f[3] < 1) f = composite(f, b);
  else if (b[3] < 1) b = composite(b, f);
  const L1 = relLuminance(f[0], f[1], f[2]);
  const L2 = relLuminance(b[0], b[1], b[2]);
  const lighter = Math.max(L1, L2);
  const darker = Math.min(L1, L2);
  return (lighter + 0.05) / (darker + 0.05);
}
