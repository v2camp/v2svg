// 静态 SVG 渲染模块：从 IR 经 layout 生成单文件 SVG。
// 约束（§2.5）：内联 <style>、亮色优先、零 JS、无 <foreignObject>、无外部字体、
// 含 <title>/<desc>、箭头 marker 在 <defs>、节点用 class 上色、文本 XML 转义。
//
// 本模块**不持有任何字号/间距/marker id 的本地常量**：全部从 typography.mjs 与 markers.mjs 引用。
// 历史上这里自持过一份文字宽度系数与一套 marker id，与 layout/checks 各写一份，
// 结果 11px vs 12px 的估算差让边标签遮罩长期比文字窄 —— 故本文件内不得再出现裸数值。

import { layout } from './layout.mjs';
import { estimateTextWidth } from './text-metrics.mjs';
import { styleBlock } from './theme.mjs';
import {
  TYPE_SCALE, BOX, EDGE_LABEL, EDGE_MASK_HEIGHT, FRAME, LEGEND, CANVAS,
} from './typography.mjs';
import { MARKER_GEOMETRY, MARKER_SHAPES, ARROW_MARKER_IDS, edgeStyleFor } from './markers.mjs';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function polylinePath(points) {
  return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${round(x)} ${round(y)}`).join(' ');
}

function round(v) {
  return Math.round(v * 100) / 100;
}

// defs 里的 marker：id 与几何全部由 markers.mjs 的契约决定，
// 且遍历的是 ARROW_MARKER_IDS 本体 —— 保证「定义的集合」与「契约允许的集合」恒等。
function renderDefs() {
  const g = MARKER_GEOMETRY;
  const parts = ['<defs>'];
  for (const id of ARROW_MARKER_IDS) {
    const shape = MARKER_SHAPES[id];
    if (!shape) continue;
    parts.push(
      `<marker id="${id}" viewBox="${g.viewBox}" markerWidth="${g.markerWidth}" markerHeight="${g.markerHeight}"`
      + ` refX="${g.refX}" refY="${g.refY}" orient="${g.orient}" markerUnits="${g.markerUnits}">`
      + `<path class="${shape.cls}" d="${shape.d}"/></marker>`
    );
  }
  parts.push('</defs>');
  return parts.join('');
}

function renderFrames(frames) {
  return frames.map((f) => {
    const label = f.label
      ? `<text class="frame-label" x="${round(f.x + FRAME.labelInsetX)}" y="${round(f.y + FRAME.labelInsetY)}">${esc(f.label)}</text>`
      : '';
    // 组框着域色：layout 已把域 role 带进 f.role，样式由 .frame-{role} 决定。
    return `<g><rect class="frame frame-${f.role || 'neutral'}" x="${f.x}" y="${f.y}" width="${f.width}" height="${f.height}" rx="${FRAME.radius}"/>${label}</g>`;
  }).join('');
}

function renderEdges(edges) {
  // 生命线先画（在底层），其余边后画。
  const life = [];
  const others = [];
  for (const e of edges) {
    if (e.kind === 'lifeline') life.push(e);
    else others.push(e);
  }
  const parts = [];
  for (const e of life) {
    parts.push(`<path class="lifeline" d="${polylinePath(e.points)}"/>`);
  }
  for (const e of others) {
    const st = edgeStyleFor(e.kind);
    const marker = st.marker ? ` marker-end="url(#${st.marker})"` : '';
    const cls = st.dashed ? 'edge edge-dashed' : 'edge';
    parts.push(`<path class="${cls}" d="${polylinePath(e.points)}"${marker}/>`);
    if (e.label && e.labelAt) {
      // 标签背景遮罩：用画布底色盖住下方的连线，保证标签文字清晰可读。
      // 宽度用与 layout / composition 完全相同的估算函数与字号（历史上这里是 11px，比判定用的 12px 窄）。
      const lw = estimateTextWidth(e.label, TYPE_SCALE.edgeLabel.px) + EDGE_LABEL.maskPadX;
      const mx = round(e.labelAt[0] - lw / 2);
      const my = round(e.labelAt[1] - EDGE_MASK_HEIGHT / 2);
      parts.push(`<rect class="edge-label-bg" x="${mx}" y="${my}" width="${round(lw)}" height="${EDGE_MASK_HEIGHT}" rx="${EDGE_LABEL.maskRadius}"/>`);
      // 文字垂直锚点 = labelAt：`.edge-label` 的 `dominant-baseline: central` 已负责居中，
      // 此处不得再叠加偏移（历史上 +3px 让文字稳定探出遮罩下沿）。
      parts.push(`<text class="edge-label" x="${round(e.labelAt[0])}" y="${round(e.labelAt[1] + EDGE_LABEL.baselineOffset)}" text-anchor="middle">${esc(e.label)}</text>`);
    }
  }
  return parts.join('');
}

function renderBoxes(boxes) {
  return boxes.map((b) => {
    // 多行：label 各行在上、sublabel 各行在下，整体围绕 cy 等分行（行距取自 BOX.lineHeight）。
    const rows = [];
    for (const t of b.labelLines || [b.label]) rows.push({ cls: 'n-label', t });
    for (const t of b.subLines || []) rows.push({ cls: 'n-sub', t });
    const R = rows.length;
    const texts = rows
      .map((r, i) => {
        const y = Math.round(b.cy + (i - (R - 1) / 2) * BOX.lineHeight);
        return `<text class="${r.cls}" x="${b.cx}" y="${y}" text-anchor="middle">${esc(r.t)}</text>`;
      })
      .join('');
    return `<g class="role-${b.role}"><rect class="node" x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="${BOX.radius}"/>${texts}</g>`;
  }).join('');
}

function renderLegend(legend) {
  if (!legend) return '';
  const sw = LEGEND.swatch;
  const lh = LEGEND.rowHeight;
  const parts = [];
  parts.push(`<g class="legend"><rect class="legend-box" x="${legend.x}" y="${legend.y}" width="${legend.width}" height="${legend.height}" rx="6"/>`);
  const cols = legend.cols || 1;
  const colW = legend.colW || LEGEND.defaultColWidth;
  const colGap = legend.colGap || LEGEND.colGap;
  legend.entries.forEach((en, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const ex = legend.x + LEGEND.insetX + col * (colW + colGap);
    const ry = legend.y + LEGEND.insetTop + row * lh;
    parts.push(`<rect class="role-${en.role}" x="${ex}" y="${ry - 9}" width="${sw}" height="${sw}" rx="3"/>`);
    parts.push(`<text class="legend-label" x="${ex + sw + 8}" y="${ry}" text-anchor="start">${esc(en.label)}</text>`);
  });
  parts.push('</g>');
  return parts.join('');
}

// 主入口：返回完整 <svg>…</svg> 字符串。
// 标题与图注都是**居中**绘制的，宽度不参与布局的边界计算 —— 若它们比内容更宽，
// 就会被画出画布之外。这里把两者的宽度纳入画布宽；变宽后把内容整体右移，
// 使内容中线与标题/图注中线对齐（否则内容左贴、文字居中，看起来是错位的）。
function fitCanvasToCenteredText(lr, titleText, captionText) {
  const need = Math.ceil(Math.max(
    estimateTextWidth(titleText, TYPE_SCALE.title.px),
    captionText ? estimateTextWidth(captionText, TYPE_SCALE.caption.px) : 0,
  ) + 2 * CANVAS.margin);
  if (need <= lr.width) return lr.width;
  const dx = Math.round((need - lr.width) / 2);
  const moveX = (o) => { o.x += dx; if (typeof o.cx === 'number') o.cx += dx; };
  for (const b of lr.boxes) moveX(b);
  for (const f of lr.frames) moveX(f);
  for (const e of lr.edges) {
    e.points = e.points.map(([x, y]) => [x + dx, y]);
    if (e.labelAt) e.labelAt = [e.labelAt[0] + dx, e.labelAt[1]];
  }
  if (lr.legend) moveX(lr.legend);
  return need;
}

export function renderSvg(ir, opts = {}) {
  const lr = layout(ir);
  const title = (ir.meta && ir.meta.title) || 'diagram';
  const caption = ir.meta && ir.meta.caption ? String(ir.meta.caption).trim() : '';
  const desc = caption || title;
  const W = fitCanvasToCenteredText(lr, title, caption);
  // caption 若存在则同时可视化输出在底部（原生 desc 只在无障碍读取时可见）——
  // 底部图注条：图号 + 口径就近可读。
  const CAPTION_H = caption ? CANVAS.captionHeight : 0;
  const H = lr.height + CAPTION_H;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,sans-serif">`,
    `<title>${esc(title)}</title>`,
    `<desc>${esc(desc)}</desc>`,
    `<style>${styleBlock(opts.theme)}</style>`,
    // 标签背景遮罩样式：复用主题里的画布底色变量（明暗两模式自动切换）。
    `<style>.edge-label-bg{fill:var(--canvas);stroke:none;}</style>`,
    renderDefs(),
    // 标题居中（不参与布局计算，绘制在内容之上）
    `<text class="title" x="${round(W / 2)}" y="${CANVAS.titleBaseline}" text-anchor="middle">${esc(title)}</text>`,
    // 绘制顺序：frames → edges → boxes → legend
    renderFrames(lr.frames),
    renderEdges(lr.edges),
    renderBoxes(lr.boxes),
    renderLegend(lr.legend),
    caption ? `<text class="caption" x="${round(W / 2)}" y="${H - CANVAS.captionBottomInset}" text-anchor="middle">${esc(caption)}</text>` : '',
    '</svg>',
  ].join('');

  return svg;
}
