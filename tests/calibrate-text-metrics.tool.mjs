// 字宽标定探针 v2：用 headless Chromium 实测各类字符的相对宽度（em），
// 并评估「新分类系数表」与「旧的单一 0.55 系数」相对实测宽度的误差。
//
// 用法：
//   NODE_PATH=/path/to/node_modules \
//   node tests/calibrate-text-metrics.tool.mjs
import { createRequire } from 'node:module';
import { globSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('无法加载 playwright：', e.message); process.exit(2); }

// 各类别的代表字符（空格单独用差量法测）。
const CLASSES = {
  cjk: '数据域可查询实体向量检索',
  'cjk-punct': '，。、；：！？（）【】「」',
  digit: '0123456789',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  punct: '.,:;!?-_/()[]{}\'"+=<>',
};

// v2svg 实际用到的字号/字重组合。
const USED = [
  { name: 'nodeTitle', px: 16, weight: 700 },
  { name: 'nodeSub', px: 12, weight: 400 },
  { name: 'edgeLabel', px: 12, weight: 400 },
  { name: 'legend', px: 12, weight: 400 },
  { name: 'frameLabel', px: 13, weight: 700 },
  { name: 'title', px: 24, weight: 700 },
  { name: 'caption', px: 12, weight: 400 },
];

// 真实文案样本：用来评估估算误差。
const REAL = [
  { name: 'node 英文+中文', text: 'Milvus 向量检索', font: 'nodeTitle' },
  { name: 'node 纯英文', text: 'QualityGate 质量门禁', font: 'nodeTitle' },
  { name: 'node 大写缩写', text: 'PROMOTION 促销规则', font: 'nodeTitle' },
  { name: 'sub 规模', text: '50 个 SKU · 锚点', font: 'nodeSub' },
  { name: 'edge 关系', text: 'APPLIES_TO · scope=SKU', font: 'edgeLabel' },
  { name: 'edge 中文说明', text: '发布 → 消费（异步解耦）', font: 'edgeLabel' },
  { name: 'legend', text: '控制', font: 'legend' },
];

function findChromium() {
  const base = `${process.env.HOME}/Library/Caches/ms-playwright`;
  const dirs = globSync(`${base}/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell`);
  return dirs.length ? dirs.sort().pop() : null;
}

const exe = findChromium();
if (!exe) { console.error('未找到 chromium headless shell。'); process.exit(2); }

const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage();
await page.setContent('<html><body><svg id="s" xmlns="http://www.w3.org/2000/svg" width="6000" height="200"></svg></body></html>');

const data = await page.evaluate(({ CLASSES, USED, REAL }) => {
  const svg = document.getElementById('s');
  const measure = (text, px, weight) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', '10');
    t.setAttribute('y', '60');
    t.setAttribute('font-size', String(px));
    t.setAttribute('font-weight', String(weight));
    t.setAttribute('font-family', 'system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif');
    t.textContent = text;
    svg.appendChild(t);
    const len = t.getComputedTextLength();
    svg.removeChild(t);
    return len;
  };

  const perClass = {};
  for (const combo of USED) {
    perClass[combo.name] = {};
    for (const [cls, chars] of Object.entries(CLASSES)) {
      const n = [...chars].length;
      perClass[combo.name][cls] = measure(chars, combo.px, combo.weight) / n / combo.px;
    }
    // 空格：差量法（尾部空格会被 trim，故用 "a a" − 2×"a"）。
    const a = measure('a', combo.px, combo.weight);
    const aSpaceA = measure('a a', combo.px, combo.weight);
    perClass[combo.name].space = Math.max(0, (aSpaceA - 2 * a) / combo.px);
  }

  const realMeasured = REAL.map((r) => {
    const combo = USED.find((u) => u.name === r.font);
    return { ...r, px: combo.px, weight: combo.weight, actual: measure(r.text, combo.px, combo.weight) };
  });

  // 同字号下的字重放大系数（700 / 400），用于把粗体标题的宽度也估准。
  const boldFactor = {};
  for (const [cls, chars] of Object.entries(CLASSES)) {
    const n = [...chars].length;
    const at400 = measure(chars, 16, 400) / n / 16;
    const at700 = measure(chars, 16, 700) / n / 16;
    boldFactor[cls] = at700 / at400;
  }
  const a400 = measure('a', 16, 400);
  const a700 = measure('a', 16, 700);
  const sp400 = Math.max(0, (measure('a a', 16, 400) - 2 * a400));
  const sp700 = Math.max(0, (measure('a a', 16, 700) - 2 * a700));
  boldFactor.space = sp400 > 0 ? sp700 / sp400 : 1;

  return { perClass, realMeasured, boldFactor };
}, { CLASSES, USED, REAL });

await browser.close();

console.log('# 实测每字符宽度（em，按 v2svg 实际字号/字重）\n');
const names = Object.keys(CLASSES);
console.log(`| 场景 | px/w | ${names.join(' | ')} | space |`);
console.log(`|:---|:---|${names.map(() => '---:').join('|')}|---:|`);
for (const combo of USED) {
  const row = names.map((n) => data.perClass[combo.name][n].toFixed(3));
  console.log(`| ${combo.name} | ${combo.px}/${combo.weight} | ${row.join(' | ')} | ${data.perClass[combo.name].space.toFixed(3)} |`);
}

console.log('\n# 逐类系数（跨场景均值）\n');
const CLASS_RATIO = {};
console.log('| 类别 | 均值 em | 建议系数 |');
console.log('|:---|---:|---:|');
for (const cls of [...names, 'space']) {
  const vals = USED.map((c) => data.perClass[c.name][cls]);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  CLASS_RATIO[cls] = avg;
  console.log(`| ${cls} | ${avg.toFixed(3)} | ${(Math.round(avg * 100) / 100).toFixed(2)} |`);
}

console.log('\n# 字重放大系数（同 16px：700 / 400）\n');
console.log('| 类别 | factor |');
console.log('|:---|---:|');
for (const [cls, f] of Object.entries(data.boldFactor)) {
  console.log(`| ${cls} | ${f.toFixed(3)} |`);
}

// 评估：新表 vs 旧表（CJK 1.0，其余 0.55）相对实测的误差。
console.log('\n# 估算误差对比（相对实测宽度）\n');
console.log('| 样本 | 实测 px | 旧表 | 旧误差 | 新表(仅分类) | 新表(+字重) | 误差 |');
console.log('|:---|---:|---:|---:|---:|---:|---:|');

function classify(ch) {
  const c = ch.codePointAt(0);
  if (c === 0x20) return 'space';
  if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3000 && c <= 0x303f)) return 'cjk';
  if (c >= 0x30 && c <= 0x39) return 'digit';
  if (c >= 0x41 && c <= 0x5a) return 'upper';
  if (c >= 0x61 && c <= 0x7a) return 'lower';
  if (c >= 0x21 && c <= 0x7e) return 'punct';
  return 'other';
}
const NEW = { ...CLASS_RATIO, other: 0.55 };
const BOLD = { ...data.boldFactor, cjk: 1.0, 'cjk-punct': 1.0, other: 1.05 };
let oldMax = 0; let newMax = 0; let boldMax = 0;
for (const r of data.realMeasured) {
  let oldW = 0; let newW = 0; let boldW = 0;
  const isBold = r.weight >= 600;
  for (const ch of r.text) {
    const cls = classify(ch);
    const base = cls === 'cjk' || cls === 'cjk-punct' ? 1.0 : 0.55;
    oldW += r.px * base;
    const ratio = NEW[cls] ?? 0.55;
    newW += r.px * ratio;
    boldW += r.px * ratio * (isBold ? (BOLD[cls] ?? 1.05) : 1);
  }
  const oldErr = (oldW - r.actual) / r.actual;
  const newErr = (newW - r.actual) / r.actual;
  const boldErr = (boldW - r.actual) / r.actual;
  oldMax = Math.max(oldMax, Math.abs(oldErr));
  newMax = Math.max(newMax, Math.abs(newErr));
  boldMax = Math.max(boldMax, Math.abs(boldErr));
  console.log(`| ${r.name} | ${r.actual.toFixed(1)} | ${oldW.toFixed(1)} | ${(oldErr * 100).toFixed(1)}% | ${newW.toFixed(1)} | ${boldW.toFixed(1)} | ${(boldErr * 100).toFixed(1)}% |`);
}
console.log(`\n最大绝对误差：旧表 ${(oldMax * 100).toFixed(1)}% → 仅分类 ${(newMax * 100).toFixed(1)}% → 分类+字重 ${(boldMax * 100).toFixed(1)}%`);
