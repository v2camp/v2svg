// 渲染级文字适配校验（需要 headless Chromium，故不属 `svg test`）：
// 打开渲染好的 SVG，实测每个盒子里 <text> 的 bbox 是否越出盒内区，
// 以及每条边标签的背景遮罩是否真的盖住文字 bbox。
//
// 这是「估算器 vs 真实字体度量」的唯一可信裁判 —— 内建检查用的是估算值，
// 只有浏览器 bbox 才能证伪估算。改动 lib/text-metrics.mjs / lib/typography.mjs
// 或 lib/render.mjs 后**必须**跑一次本工具。
//
// 用法（不给参数时自动校验 samples/*.svg）：
//   NODE_PATH=/path/to/node_modules \
//   node tests/verify-rendered-svg.tool.mjs [<a.svg> ...]
// 环境变量 TOL 可放宽容差（默认 0，即必须完全在盒内）。
// 需可解析 playwright（chromium），浏览器由 playwright 自行解析，不绑定本机缓存路径。
import { createRequire } from 'node:module';
import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('无法加载 playwright：', e.message); process.exit(2); }

const HERE = path.dirname(fileURLToPath(import.meta.url));
let files = process.argv.slice(2);
if (!files.length) files = globSync(path.join(HERE, '..', 'samples', '*.svg')).sort();
if (!files.length) { console.error('用法：node verify-rendered-svg.tool.mjs <a.svg> [...]'); process.exit(2); }

const browser = await chromium.launch();
const page = await browser.newPage();
const TOL = Number(process.env.TOL || 0);

let totalViolations = 0;

for (const file of files) {
  const svg = readFileSync(file, 'utf8');
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  const res = await page.evaluate((tol) => {
    const out = { boxes: [], masks: [], notes: [] };
    // 1) 节点盒：<g class="role-*"> 里的 rect.node 与其同级 <text>
    for (const g of document.querySelectorAll('g[class^="role-"]')) {
      const rect = g.querySelector('rect.node');
      if (!rect) continue;
      const rx = +rect.getAttribute('x');
      const ry = +rect.getAttribute('y');
      const rw = +rect.getAttribute('width');
      const rh = +rect.getAttribute('height');
      for (const t of g.querySelectorAll('text')) {
        const b = t.getBBox();
        const left = b.x - rx;
        const right = (rx + rw) - (b.x + b.width);
        const top = b.y - ry;
        const bottom = (ry + rh) - (b.y + b.height);
        if (left < tol || right < tol || top < tol || bottom < tol) {
          out.boxes.push({
            id: g.querySelector('text')?.textContent || '?',
            text: t.textContent,
            rect: [rx, ry, rw, rh],
            bbox: [+b.x.toFixed(1), +b.y.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)],
            margin: { left: +left.toFixed(2), right: +right.toFixed(2), top: +top.toFixed(2), bottom: +bottom.toFixed(2) },
          });
        }
      }
    }
    // 2) 边标签遮罩 vs 文字 bbox
    for (const bg of document.querySelectorAll('rect.edge-label-bg')) {
      const t = bg.nextElementSibling;
      if (!t || t.tagName.toLowerCase() !== 'text') continue;
      const mx = +bg.getAttribute('x');
      const my = +bg.getAttribute('y');
      const mw = +bg.getAttribute('width');
      const mh = +bg.getAttribute('height');
      const b = t.getBBox();
      const m = {
        left: +(b.x - mx).toFixed(2),
        right: +((mx + mw) - (b.x + b.width)).toFixed(2),
        top: +(b.y - my).toFixed(2),
        bottom: +((my + mh) - (b.y + b.height)).toFixed(2),
      };
      if (m.left < tol || m.right < tol || m.top < tol || m.bottom < tol) {
        out.masks.push({
          text: t.textContent,
          mask: [mx, my, mw, mh],
          bbox: [+b.x.toFixed(1), +b.y.toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1)],
          margin: m,
        });
      }
    }
    return out;
  }, TOL);

  const n = res.boxes.length + res.masks.length;
  totalViolations += n;
  console.log(`\n## ${path.basename(file)}  —  越界 ${n} 处`);
  if (res.boxes.length) {
    console.log('### 节点盒内文字越界');
    console.log('| 文案 | 盒 [x,y,w,h] | 文字 bbox | 左 | 右 | 上 | 下 |');
    console.log('|:---|:---|:---|---:|---:|---:|---:|');
    for (const v of res.boxes.slice(0, 12)) {
      console.log(`| ${v.text} | ${v.rect.join(',')} | ${v.bbox.join(',')} | ${v.margin.left} | ${v.margin.right} | ${v.margin.top} | ${v.margin.bottom} |`);
    }
  }
  if (res.masks.length) {
    console.log('### 边标签遮罩未盖住文字');
    console.log('| 文案 | 遮罩 [x,y,w,h] | 文字 bbox | 左 | 右 | 上 | 下 |');
    console.log('|:---|:---|:---|---:|---:|---:|---:|');
    for (const v of res.masks.slice(0, 12)) {
      console.log(`| ${v.text} | ${v.mask.join(',')} | ${v.bbox.join(',')} | ${v.margin.left} | ${v.margin.right} | ${v.margin.top} | ${v.margin.bottom} |`);
    }
  }
}

await browser.close();
console.log(`\n合计越界：${totalViolations} 处`);
process.exit(totalViolations === 0 ? 0 : 1);
