#!/usr/bin/env node
// v2svg CLI 入口 —— 把 IR JSON 渲染为可嵌入文档的静态 SVG，并做机械验证。
//
// 设计铁律：
//   - 所有路径用 import.meta.url 相对解析，支持任意 cwd 调用；
//   - 运行时零 npm 依赖；
//   - 自包含：不依赖任何外部 skill，IR 语义不耦合具体业务领域。
//
// 退出码：0 通过 / 1 验证失败 / 2 用法错误。

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import {
  TYPE_RULES, recommendType, rerouteFor, ambiguityHint,
} from './guide-routing.mjs';

// ---- 路径解析（仅依赖 import.meta.url，与 cwd 无关）----
const BIN_URL = import.meta.url;
const SKILL_ROOT = path.dirname(path.dirname(fileURLToPath(BIN_URL)));
const SCHEMAS_DIR = path.join(SKILL_ROOT, 'schemas');
const LIB_DIR = path.join(SKILL_ROOT, 'lib');
const EXAMPLES_DIR = path.join(SKILL_ROOT, 'examples');
// 自研核心模块：doctor 断言其存在且导出面完整。
// 净室重写（2026-09-12）后 lib/ 下不再有 vendored 代码——见 THIRD_PARTY_NOTICES.md。
const CORE_FILES = ['geometry.mjs'];
// 几何模块的对外导出面必须恰好是这些（多一个少一个都说明契约被动过）。
const GEOMETRY_EXPORTS = ['isFinitePoint', 'rectsOverlap', 'segmentIntersectsRect', 'routeHonorsEndpointSides',
  'collectLabelRouteClearance', 'collectAmbiguousCorridors', 'collectBorderRuns', 'collectRouteRhythmIssues'];
// 已被净室重写淘汰的 vendored 文件：断言它们**不存在**，防止被误加回来。
const REMOVED_VENDOR_FILES = ['diagnostics.mjs'];

const importFrom = (rel) => import(new URL(rel, BIN_URL).href);

const TYPES = new Set(['architecture', 'flow', 'sequence']);

// ---- 通用错误 ----
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'usage';
  }
}

// =====================================================================
// 参数解析
// =====================================================================
function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--quality') {
      const v = args[i + 1];
      if (!v) throw new UsageError('--quality 需要一个值（standard|showcase）');
      flags.quality = v;
      i += 1;
    } else if (a.startsWith('--quality=')) {
      flags.quality = a.slice('--quality='.length);
    } else if (a === '--variant-pair') {
      const v = args[i + 1];
      if (!v) throw new UsageError('--variant-pair 需要一个对比根目录路径');
      flags.variantPair = v;
      i += 1;
    } else if (a.startsWith('--variant-pair=')) {
      flags.variantPair = a.slice('--variant-pair='.length);
    } else if (a === '--theme') {
      const v = args[i + 1];
      if (!v) throw new UsageError('--theme 需要一个值（follow|light）');
      flags.theme = v;
      i += 1;
    } else if (a.startsWith('--theme=')) {
      flags.theme = a.slice('--theme='.length);
    } else if (a.startsWith('--')) {
      throw new UsageError(`未知选项：${a}`);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function resolveQuality(raw) {
  const q = raw || 'standard';
  if (q !== 'standard' && q !== 'showcase') {
    throw new UsageError(`--quality 仅支持 standard|showcase，实际为「${q}」`);
  }
  return q;
}

// 'follow'（默认）= :root 亮色 + prefers-color-scheme 暗色自适应，跟随宿主主题。
// 'light' = 固定亮色，**不跟随宿主主题**；用于「图必须与读者主题无关」的嵌入场景
//   （如文档/印刷物配图、要进 PDF/截图流转的图）。
function resolveTheme(raw) {
  const t = raw || 'follow';
  if (t !== 'follow' && t !== 'light') {
    throw new UsageError(`--theme 仅支持 follow|light，实际为「${t}」`);
  }
  return t;
}

// =====================================================================
// 输入读取
// =====================================================================
function readInput(inputPath) {
  if (!existsSync(inputPath)) {
    throw new UsageError(`找不到输入文件：${inputPath}`);
  }
  let text;
  try {
    text = readFileSync(inputPath, 'utf8');
  } catch (e) {
    throw new UsageError(`无法读取输入文件：${inputPath}（${e.message}）`);
  }
  let ir;
  try {
    ir = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`输入不是合法 JSON：${inputPath}\n${e.message}`);
  }
  return ir;
}

// =====================================================================
// 验证 + 渲染 编排
// =====================================================================
async function loadLib() {
  const [{ validateSchema }, { layout }, { renderSvg }, { runCompositionChecks, COMPOSITION_CHECK_NAMES },
    { runDocumentChecks, DOCUMENT_CHECK_NAMES, STANDARD_DOCUMENT_CHECK_NAMES }, { TYPE_SCALE, STROKE }] = await Promise.all([
    importFrom('../lib/schema.mjs'),
    importFrom('../lib/layout.mjs'),
    importFrom('../lib/render.mjs'),
    importFrom('../lib/checks/composition.mjs'),
    importFrom('../lib/checks/document.mjs'),
    importFrom('../lib/typography.mjs'),
  ]);
  return {
    validateSchema, layout, renderSvg, runCompositionChecks, COMPOSITION_CHECK_NAMES,
    runDocumentChecks, DOCUMENT_CHECK_NAMES, STANDARD_DOCUMENT_CHECK_NAMES, TYPE_SCALE, STROKE,
  };
}

// 跑「全部检查」：schema → layout → 构图项 → 按档位选文档集成专项。
// 入参 svgPath：validate / render 都会传已渲染的 SVG（见 finishValidate 与 cmdRender），
// 故产物级检查（no_ascii / no_base64 / text_no_stroke / marker_contract / svg_text_fits）两档语义一致。
// 返回 { schemaOk, diagnostics, checks, layoutOk }
async function runPipeline({ ir, type, svgPath, profile, variantPair = null }) {
  const { validateSchema, layout, runCompositionChecks, runDocumentChecks, STANDARD_DOCUMENT_CHECK_NAMES } = await loadLib();
  const STANDARD_DOCUMENT = new Set(STANDARD_DOCUMENT_CHECK_NAMES);

  // 1) schema
  const schemaRes = validateSchema(ir);
  if (!schemaRes.ok) {
    return { schemaOk: false, diagnostics: schemaRes.diagnostics, checks: [], layoutOk: false };
  }

  // 2) layout（包裹异常，防止渲染器崩溃冒泡为未捕获错误）
  let layoutResult;
  try {
    layoutResult = layout(ir);
  } catch (e) {
    return {
      schemaOk: true,
      layoutOk: false,
      diagnostics: [{
        code: 'layout/error', severity: 'error',
        message: `布局失败：${e.message}`, subject: {}, evidence: {}, supportedFixes: [],
      }],
      checks: [],
    };
  }

  // 3) 9 项构图
  const composition = runCompositionChecks(ir, layoutResult, profile);

  // 4) 6 项文档集成专项 → 按档位筛选
  const docAll = runDocumentChecks({
    ir, svgPath, docDir: null,
    options: { compareDir: variantPair },
  });
  const doc = profile === 'showcase'
    ? docAll
    : docAll.filter((c) => STANDARD_DOCUMENT.has(c.name));

  return {
    schemaOk: true, layoutOk: true, diagnostics: [],
    checks: [...composition, ...doc],
  };
}

function summarize(checks) {
  const failed = checks.filter((c) => !c.ok).length;
  return { total: checks.length, passed: checks.length - failed, failed };
}

// 在临时 SVG 上执行 fn —— validate 与 render 都走这里，保证「两档跑的是同一批检查」。
// 历史行为：validate 不渲染，于是 no_ascii / no_base64 / text_no_stroke 在 validate 时被跳过，
// 「validate 通过」并不等于「render 会通过」。现在两者都在真实产物上判定。
async function withRenderedSvg(ir, fn, theme = 'follow') {
  const { renderSvg } = await loadLib();
  let svg;
  try {
    svg = renderSvg(ir, { theme });
  } catch (e) {
    return fn(null, [{
      code: 'render/error', severity: 'error', message: `渲染失败：${e.message}`,
      subject: {}, evidence: {}, supportedFixes: [],
    }]);
  }
  const tmp = path.join(os.tmpdir(), `v2svg-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.svg`);
  writeFileSync(tmp, svg, 'utf8');
  try {
    return await fn(tmp, null);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function buildReceipt({ command, type, input, output, profile, checks, diagnostics, artifact }) {
  const summary = summarize(checks);
  const ok = diagnostics.length === 0 && summary.failed === 0;
  const receipt = {
    schemaVersion: 1,
    ok,
    command,
    type,
    input,
    output: output ?? null,
    checks,
    composition: {
      profile,
      status: ok ? 'pass' : 'fail',
      summary,
    },
  };
  if (diagnostics.length) receipt.diagnostics = diagnostics;
  if (artifact) receipt.artifact = artifact;
  return receipt;
}

function cliErrorReceipt(command, type, message, code) {
  return {
    schemaVersion: 1,
    ok: false,
    command,
    type: type ?? null,
    input: null,
    output: null,
    checks: [],
    composition: { profile: null, status: 'fail', summary: { total: 0, passed: 0, failed: 0 } },
    diagnostics: [{
      code, severity: 'error', message, subject: {}, evidence: {}, supportedFixes: [],
    }],
  };
}

// =====================================================================
// 人类可读输出
// =====================================================================
function printChecksHuman(checks, prefix) {
  const width = Math.max(...checks.map((c) => c.name.length), 4);
  for (const c of checks) {
    const tag = c.ok ? '[ok]' : '[fail]';
    const detail = c.details && c.details.length ? c.details[0] : (c.ok ? '通过' : '未通过');
    console.log(`  ${tag} ${c.name.padEnd(width)}  ${detail}`);
    for (let i = 1; i < (c.details || []).length; i += 1) {
      console.log(`  ${' '.repeat(6)}${' '.repeat(width)}  ${c.details[i]}`);
    }
  }
}

function printHumanSummary(command, type, profile, checks, diagnostics, artifact, output) {
  if (diagnostics.length) {
    console.log(`\n✗ 架构校验失败（${diagnostics.length} 项诊断）：`);
    for (const d of diagnostics) {
      console.log(`  [${d.severity}] ${d.code}  ${d.message}`);
      if (d.supportedFixes && d.supportedFixes.length) {
        console.log(`    建议：${d.supportedFixes.join('；')}`);
      }
    }
    return;
  }
  const s = summarize(checks);
  const head = command === 'render' ? `渲染校验（${profile}）` : `校验结果（${profile}）`;
  console.log(`\n${head}：共 ${s.total} 项，通过 ${s.passed}，失败 ${s.failed}`);
  printChecksHuman(checks);
  if (s.failed === 0) {
    console.log('\n✓ 验证通过');
    if (artifact) {
      console.log(`  产物：${output}`);
      console.log(`  体积：${artifact.bytes} 字节`);
      console.log(`  sha256：${artifact.sha256}`);
    }
  } else {
    console.log('\n✗ 验证未通过，未产出文件');
  }
}

// =====================================================================
// 命令：validate
// =====================================================================
async function cmdValidate(args, command) {
  const { positional, flags } = parseArgs(args);
  const type = positional[0];
  const input = positional[1];
  if (!type || !input) {
    throw new UsageError('用法：svg validate <type> <input.json> [--quality standard|showcase] [--theme follow|light] [--variant-pair <dir>] [--json]');
  }
  if (!TYPES.has(type)) {
    throw new UsageError(`未知的图类型「${type}」\n支持：architecture / flow / sequence`);
  }
  const profile = resolveQuality(flags.quality);
  const ir = readInput(input);

  // 命令指定的类型需与 IR 内 type 一致（schema 以 IR.type 为准）
  if (ir && ir.type && ir.type !== type) {
    return finishValidate(command, type, input, profile, flags.json, {
      schemaOk: false,
      diagnostics: [{
        code: 'cli/type-mismatch', severity: 'error',
        message: `命令指定的类型「${type}」与 IR 中 type「${ir.type}」不一致`,
        subject: { pointer: '/type' }, evidence: { arg: type, irType: ir.type },
        supportedFixes: [`将命令类型改为 ${ir.type}，或把 IR.type 改为 ${type}`],
      }],
      checks: [],
    });
  }

  const result = await withRenderedSvg(ir, (tmp, renderDiags) => {
    if (renderDiags) return { schemaOk: true, layoutOk: false, diagnostics: renderDiags, checks: [] };
    return runPipeline({ ir, type, svgPath: tmp, profile, variantPair: flags.variantPair ?? null });
  }, resolveTheme(flags.theme));
  return finishValidate(command, type, input, profile, flags.json, result);
}

function finishValidate(command, type, input, profile, json, result) {
  const { schemaOk, diagnostics, checks } = result;
  if (json) {
    const receipt = buildReceipt({ command, type, input, output: null, profile, checks, diagnostics });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    return schemaOk && summarize(checks).failed === 0 ? 0 : 1;
  }
  printHumanSummary(command, type, profile, checks, diagnostics, null, null);
  return schemaOk && summarize(checks).failed === 0 ? 0 : 1;
}

// =====================================================================
// 命令：render
// =====================================================================
async function cmdRender(args) {
  const command = 'render';
  const { positional, flags } = parseArgs(args);
  const type = positional[0];
  const input = positional[1];
  const output = positional[2];
  if (!type || !input || !output) {
    throw new UsageError('用法：svg render <type> <input.json> <output.svg> [--quality standard|showcase] [--theme follow|light] [--variant-pair <dir>] [--json]');
  }
  if (!TYPES.has(type)) {
    throw new UsageError(`未知的图类型「${type}」\n支持：architecture / flow / sequence`);
  }
  const profile = resolveQuality(flags.quality);
  const ir = readInput(input);

  if (ir && ir.type && ir.type !== type) {
    const diag = [{
      code: 'cli/type-mismatch', severity: 'error',
      message: `命令指定的类型「${type}」与 IR 中 type「${ir.type}」不一致`,
      subject: { pointer: '/type' }, evidence: { arg: type, irType: ir.type },
      supportedFixes: [`将命令类型改为 ${ir.type}，或把 IR.type 改为 ${type}`],
    }];
    if (flags.json) {
      process.stdout.write(JSON.stringify(cliErrorReceipt(command, type, diag[0].message, 'cli/type-mismatch'), null, 2) + '\n');
    } else {
      console.log(`✗ ${diag[0].message}`);
    }
    return 2;
  }

  // 1) schema + layout + 9 构图（不依赖 SVG 文件）
  const { renderSvg } = await loadLib();
  const pre = await runPipeline({ ir, type, svgPath: null, profile, variantPair: flags.variantPair ?? null });
  if (!pre.schemaOk || !pre.layoutOk) {
    if (flags.json) {
      process.stdout.write(JSON.stringify(
        buildReceipt({ command, type, input, output, profile, checks: pre.checks, diagnostics: pre.diagnostics }),
        null, 2) + '\n');
    } else {
      printHumanSummary(command, type, profile, pre.checks, pre.diagnostics, null, output);
    }
    return 1;
  }

  // 2) 渲染到内存并写入临时文件，供 no_ascii / no_base64 检查
  let svg;
  try {
    svg = renderSvg(ir, { theme: resolveTheme(flags.theme) });
  } catch (e) {
    const diag = [{
      code: 'render/error', severity: 'error', message: `渲染失败：${e.message}`,
      subject: {}, evidence: {}, supportedFixes: [],
    }];
    if (flags.json) {
      process.stdout.write(JSON.stringify(
        buildReceipt({ command, type, input, output, profile, checks: [], diagnostics: diag }), null, 2) + '\n');
    } else {
      console.log(`✗ 渲染失败：${e.message}`);
    }
    return 1;
  }

  const tmp = path.join(os.tmpdir(), `v2svg-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.svg`);
  writeFileSync(tmp, svg, 'utf8');

  // 3) 完整跑全部检查（含针对实际 SVG 的 no_ascii / no_base64）
  const full = await runPipeline({ ir, type, svgPath: tmp, profile, variantPair: flags.variantPair ?? null });
  const s = summarize(full.checks);

  if (s.failed === 0) {
    // 验证通过才写最终产物
    writeFileSync(output, svg, 'utf8');
    const buf = Buffer.from(svg, 'utf8');
    const artifact = {
      bytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
    };
    rmSync(tmp, { force: true });
    if (flags.json) {
      process.stdout.write(JSON.stringify(
        buildReceipt({ command, type, input, output, profile, checks: full.checks, diagnostics: [], artifact }),
        null, 2) + '\n');
    } else {
      printHumanSummary(command, type, profile, full.checks, [], artifact, output);
    }
    return 0;
  }

  // 验证失败：绝不产出，清理临时文件
  rmSync(tmp, { force: true });
  if (flags.json) {
    process.stdout.write(JSON.stringify(
      buildReceipt({ command, type, input, output, profile, checks: full.checks, diagnostics: full.diagnostics }),
      null, 2) + '\n');
  } else {
    printHumanSummary(command, type, profile, full.checks, full.diagnostics, null, output);
  }
  return 1;
}

// =====================================================================
// 命令：guide（分型路由）
// =====================================================================
// 判据（负向回流表 / 正向打分 / 类型规则子集）都在 `bin/guide-routing.mjs`，
// 独立成模块以便 tests/guide-routing.test.mjs 直接 import 而不触发本 CLI 的 top-level await。
const SKELETONS = {
  architecture: `{
  "schema_version": 1,
  "type": "architecture",
  "meta": { "title": "示例架构图", "caption": "图 1-1 · 一句话说明", "locale": "zh-CN", "viewBox": [800, 500] },
  "groups": [{ "id": "g1", "label": "层一", "role": "interaction" }],
  "nodes": [
    { "id": "a", "label": "组件A", "role": "capability", "group": "g1" },
    { "id": "b", "label": "组件B", "role": "control", "group": "g1" }
  ],
  "edges": [{ "from": "a", "to": "b", "label": "调用", "kind": "sync" }]
}`,
  flow: `{
  "schema_version": 1,
  "type": "flow",
  "meta": { "title": "示例流程图", "caption": "图 1-2 · 一句话说明", "locale": "zh-CN", "viewBox": [800, 500] },
  "nodes": [
    { "id": "s", "label": "开始", "role": "neutral", "kind": "start" },
    { "id": "step", "label": "处理", "role": "capability", "kind": "step" },
    { "id": "d", "label": "判断", "role": "control", "kind": "decision" },
    { "id": "t", "label": "结束", "role": "neutral", "kind": "terminal" }
  ],
  "edges": [
    { "from": "s", "to": "step", "kind": "sync" },
    { "from": "step", "to": "d", "kind": "sync" },
    { "from": "d", "to": "t", "label": "是", "kind": "sync" }
  ]
}`,
  sequence: `{
  "schema_version": 1,
  "type": "sequence",
  "meta": { "title": "示例时序图", "caption": "图 1-3 · 一句话说明", "locale": "zh-CN", "viewBox": [800, 500] },
  "participants": [
    { "id": "p1", "label": "客户端", "role": "interaction" },
    { "id": "p2", "label": "服务端", "role": "control" }
  ],
  "messages": [{ "from": "p1", "to": "p2", "label": "请求", "kind": "sync" }]
}`,
};

const REASON = {
  architecture: '涉及分层 / 组件 / 边界 / 对比关系，用架构图最清晰',
  flow: '涉及步骤 / 管道 / 决策 / 状态流转，用流程图描述执行顺序',
  sequence: '涉及时序 / 调用链 / 请求生命周期，用时序图呈现参与者交互',
};

function cmdGuide(args) {
  const scene = args.join(' ').trim();
  if (!scene) {
    throw new UsageError('用法：svg guide "<场景描述>"');
  }

  // 1) 负向优先：命中回流表就不硬推荐图类型。
  const reroute = rerouteFor(scene);
  if (reroute.rule) {
    console.log('建议不要用本管线（回流）');
    console.log(`回流到：${reroute.rule.target}`);
    console.log(`理由：${reroute.rule.reason}`);
    console.log(`替代方案：${reroute.rule.alternative}`);
    if (reroute.matched.length > 1) {
      console.log(`另命中回流场景：${reroute.matched.slice(1).map((r) => r.target).join('；')}`);
    }
    return 0;
  }

  // 2) 正向：打分制推荐
  const rec = recommendType(scene);

  // 并列时**不给「推荐」**：既然判定不了唯一类型，再报一个类型名就与「无法唯一判定」自相矛盾，
  // 也会诱导调用方直接用那个。改为把全部并列项连同各自的理由/命中词/规则/骨架一次给全，
  // 由调用方按判断依据二选一。
  if (rec.ambiguous) {
    console.log(`无法唯一判定：以下 ${rec.winners.length} 个类型并列最高分（各 ${rec.scores[rec.winners[0]]} 分）`);
    for (const t of rec.winners) {
      console.log(`  - ${t}：${REASON[t]}；命中关键词 ${rec.matched[t].join('、')}`);
    }
    console.log(`二选一的判断依据：${ambiguityHint(rec.winners)}`);
    for (const t of rec.winners) {
      const rules = TYPE_RULES[t];
      console.log(`\n【${t}】最小必读规则（${rules.length} 条）：`);
      rules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
      console.log(`【${t}】最简 IR 骨架：`);
      console.log(SKELETONS[t]);
    }
    console.log('\n请按上面的判断依据二选一，再取该类型的骨架开工。');
    return 0;
  }

  console.log(`推荐图类型：${rec.type}`);
  console.log(`理由：${REASON[rec.type]}`);
  if (rec.fallback) {
    console.log('命中关键词：（无）——未命中任何场景关键词，按兜底规则给 architecture');
  } else {
    console.log(`命中关键词：${rec.matched[rec.type].join('、')}`);
  }

  const rules = TYPE_RULES[rec.type];
  console.log(`\n该类型最小必读规则（${rules.length} 条）：`);
  rules.forEach((r, i) => console.log(`  ${i + 1}. ${r}`));
  console.log('\n最简 IR 骨架：');
  console.log(SKELETONS[rec.type]);
  return 0;
}

// =====================================================================
// 命令：test（跑 tests/*.test.mjs）
// =====================================================================
// 只跑零依赖的纯计算测试；需要 headless 浏览器的工具命名为 *.tool.mjs，不在此列（见 SKILL.md）。
async function cmdTest(args) {
  const json = args.includes('--json');
  const dir = path.join(SKILL_ROOT, 'tests');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort(); }
  catch { throw new UsageError('找不到 tests 目录'); }
  if (!files.length) throw new UsageError('tests 目录下没有 *.test.mjs');

  let passed = 0;
  const failed = [];
  const results = [];
  for (const f of files) {
    const mod = await importFrom(`../tests/${f}`);
    const list = mod.cases || [];
    if (!list.length) failed.push({ file: f, name: '(无 cases 导出)', message: '测试文件必须导出 cases 数组' });
    for (const c of list) {
      const label = `${f} :: ${c.name}`;
      try {
        const msg = c.run();
        passed += 1;
        results.push({ file: f, name: c.name, ok: true, message: msg || 'ok' });
      } catch (e) {
        failed.push({ file: f, name: c.name, message: e.message });
        results.push({ file: f, name: c.name, ok: false, message: e.message });
      }
      void label;
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ passed, failed: failed.length, results }, null, 2) + '\n');
  } else {
    let cur = '';
    for (const r of results) {
      if (r.file !== cur) { cur = r.file; console.log(`\n${cur}`); }
      console.log(`  [${r.ok ? 'ok' : 'fail'}] ${r.name}  ${r.message}`);
    }
    console.log(`\n共 ${passed + failed.length} 项：通过 ${passed}，失败 ${failed.length}`);
  }
  return failed.length === 0 ? 0 : 1;
}

// =====================================================================
// 命令：doctor（环境自检）
// =====================================================================
async function check(label, fn) {
  try {
    const msg = await fn();
    return { label, ok: true, msg: msg || 'ok' };
  } catch (e) {
    return { label, ok: false, msg: e.message };
  }
}

// =====================================================================
// 文档常量 ↔ 代码常量 一致性（doctor 专项）
// =====================================================================
//
// 由来：同类系统的真实事故是「指南是实现的**手工拷贝**」——文件头写着「如需升级请同步修改
// 另一份并重新拷贝此文件」，于是两份必然漂移，而所有面向产物的检查都查不出来。
// v2svg 里已经发生过同类漂移：口径写成 `standard` 14 项（实际 13）、`showcase 须 15/15`
// （实际 17）、`label_route_clearance` 阈值写成 14px（实际 15）。
//
// 本项把「文档里的数值」变成可断言的契约：任何一侧改动而忘记同步，doctor 立刻变红。
// 若文档被有意改写，必须同步更新下面的锚点表 —— 找不到锚点按失败处理，不允许静默跳过。

const REFS_DIR = path.join(SKILL_ROOT, 'references');

function readSkillFile(rel) {
  const p = path.join(SKILL_ROOT, rel);
  if (!existsSync(p)) throw new Error(`文件不存在：${rel}`);
  return readFileSync(p, 'utf8');
}

// 从 markdown 表格里取一行中所有数值，用于比对字级表。
// 行形如：`| **节点标题** | **16px，weight 700**（近黑 ...） |`
function tableRow(text, label) {
  const re = new RegExp(`^\\|\\s*\\**${label}\\**\\s*\\|([^|]*)\\|`, 'm');
  const m = text.match(re);
  return m ? m[1] : null;
}

function expectNum(problems, where, got, want) {
  if (got == null) {
    problems.push(`${where}：未找到可断言的数值（若为有意改写文档，请同步更新 doctor 的锚点表）`);
  } else if (got !== want) {
    problems.push(`${where}：文档写 ${got}，代码实际 ${want}`);
  }
}

async function checkDocsConsistency() {
  const { COMPOSITION_CHECK_NAMES, DOCUMENT_CHECK_NAMES, STANDARD_DOCUMENT_CHECK_NAMES, TYPE_SCALE, STROKE } = await loadLib();
  const compN = COMPOSITION_CHECK_NAMES.length;
  const docN = DOCUMENT_CHECK_NAMES.length;
  const stdDocN = STANDARD_DOCUMENT_CHECK_NAMES.length;
  const totalN = compN + docN;
  const standardN = compN + stdDocN;

  const design = readSkillFile('references/design-system.md');
  const contract = readSkillFile('references/diagram-contract.md');
  const skill = readSkillFile('SKILL.md');
  const readme = readSkillFile('README.md');

  const problems = [];
  const num = (s, re) => { const m = s.match(re); return m ? Number(m[1]) : null; };

  // ---- 1) design-system.md 的字级 / 线宽表 ↔ TYPE_SCALE / STROKE ----
  const fontRow = (label) => {
    const cell = tableRow(design, label);
    if (cell == null) return [null, null];
    const px = num(cell, /(\d+(?:\.\d+)?)\s*px/);
    const weight = num(cell, /weight\s*(\d+)/);
    return [px, weight];
  };
  const fontChecks = [
    ['主标题', 'title'],
    ['节点标题', 'nodeTitle'],
    ['节点副标签', 'nodeSub'],
    ['边标签', 'edgeLabel'],
    ['组框标签', 'frameLabel'],
    ['图例', 'legend'],
  ];
  for (const [label, key] of fontChecks) {
    const [px, weight] = fontRow(label);
    expectNum(problems, `design-system.md「${label}」字号`, px, TYPE_SCALE[key].px);
    if (weight != null) expectNum(problems, `design-system.md「${label}」字重`, weight, TYPE_SCALE[key].weight);
  }
  {
    const cell = tableRow(design, '连线');
    const sw = cell == null ? null : Number((cell.match(/stroke-width:\s*(\d+(?:\.\d+)?)/) || [])[1]);
    expectNum(problems, 'design-system.md「连线」线宽', Number.isNaN(sw) ? null : sw, STROKE.edge);
  }
  {
    const m = design.match(/(\d+)\s*px\s*，weight\s*(\d+)[^\n]*节点标题/);
    if (m) expectNum(problems, 'design-system.md 节点标题字重', Number(m[2]), TYPE_SCALE.nodeTitle.weight);
  }

  // ---- 2) diagram-contract.md 的项数 ↔ 实际检查项 ----
  expectNum(problems, 'diagram-contract.md §3 标题项数', num(contract, /##\s*3\.\s*(\d+)\s*项检查逐项说明/), totalN);
  expectNum(problems, 'diagram-contract.md §3.1 构图项数', num(contract, /##\s*3\.1\s*构图\s*(\d+)\s*项/), compN);
  expectNum(problems, 'diagram-contract.md §3.2 文档专项项数', num(contract, /###\s*3\.2\s*文档集成专项\s*(\d+)\s*项/), docN);
  expectNum(problems, 'diagram-contract.md §3.3 standard 项数', num(contract, /`standard`：[\s\S]{0,200}?=\s*\*\*(\d+)\s*项\*\*/), standardN);
  expectNum(problems, 'diagram-contract.md §3.3 showcase 项数', num(contract, /`showcase`：(\d+)\s*项\*\*全过\*\*/), totalN);

  // ---- 3) SKILL.md 的口径 ↔ 实际检查项 ----
  expectNum(problems, 'SKILL.md「做 N 项机械检查」', num(skill, /做\s*(\d+)\s*项机械检查/), totalN);
  expectNum(problems, 'SKILL.md「standard = N 项」', num(skill, /`standard`\s*=\s*(\d+)\s*项/), standardN);
  expectNum(problems, 'SKILL.md「showcase = N 项全过」', num(skill, /`showcase`\s*=\s*(\d+)\s*项全过/), totalN);
  {
    const m = skill.match(/showcase\s*须\s*`(\d+)\/(\d+)`/);
    if (!m) problems.push('SKILL.md：未找到「showcase 须 `N/N`」锚点');
    else {
      expectNum(problems, 'SKILL.md「showcase 须 N/N」分子', Number(m[1]), totalN);
      expectNum(problems, 'SKILL.md「showcase 须 N/N」分母', Number(m[2]), totalN);
    }
  }

  // ---- 4) README.md 的档位口径 ----
  {
    const m = readme.match(/`standard`\s*(\d+)\s*项\s*\/\s*`showcase`\s*(\d+)\s*项/);
    if (!m) problems.push('README.md：未找到「`standard` N 项 / `showcase` N 项」锚点');
    else {
      expectNum(problems, 'README.md standard 项数', Number(m[1]), standardN);
      expectNum(problems, 'README.md showcase 项数', Number(m[2]), totalN);
    }
  }
  expectNum(problems, 'README.md「做 N 项机械检查」', num(readme, /做\s*(\d+)\s*项机械检查/), totalN);
  // 「构图检查 N 项」「文档集成检查 N 项」是README 的两张分项清单，此前未被断言覆盖，
  // 已实际漂移过；这里分别与 COMPOSITION_CHECK_NAMES / DOCUMENT_CHECK_NAMES 比对锁死。
  expectNum(problems, 'README.md「构图检查 N 项」', num(readme, /\*\*构图检查\s*(\d+)\s*项\*\*/), compN);
  expectNum(problems, 'README.md「文档集成检查 N 项」', num(readme, /\*\*文档集成检查\s*(\d+)\s*项\*\*/), docN);

  if (problems.length) throw new Error(problems.join('；'));
  return `字级/线宽 7 项、档位项数 6 处、README 口径 5 处均与代码一致（构图 ${compN} + 文档 ${docN}；standard ${standardN} / showcase ${totalN}）`;
}

async function cmdDoctor() {
  const items = [];

  // 1) Node 版本
  items.push(check('Node ≥ 18', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 18) throw new Error(`当前 ${process.versions.node}，需 ≥ 18`);
    return `v${process.versions.node}`;
  }));

  // 2) schemas 四文件存在且可解析
  const schemaFiles = ['common.schema.json', 'architecture.schema.json', 'flow.schema.json', 'sequence.schema.json'];
  for (const f of schemaFiles) {
    items.push(check(`schemas/${f}`, () => {
      const p = path.join(SCHEMAS_DIR, f);
      if (!existsSync(p)) throw new Error('文件不存在');
      const t = readFileSync(p, 'utf8');
      JSON.parse(t);
      return '存在且可解析';
    }));
  }

  // 3) examples 至少 1 个
  items.push(check('examples/ ≥ 1', () => {
    let list;
    try { list = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')); }
    catch (e) { throw new Error(`无法读取 examples 目录：${e.message}`); }
    if (list.length < 1) throw new Error('examples 目录为空');
    return `${list.length} 个样例`;
  }));

  // 4) lib 各模块可 import
  const libModules = [
    '../lib/theme.mjs', '../lib/typography.mjs', '../lib/text-metrics.mjs', '../lib/markers.mjs',
    '../lib/layout.mjs', '../lib/render.mjs', '../lib/schema.mjs',
    '../lib/checks/composition.mjs', '../lib/checks/document.mjs',
    '../lib/geometry.mjs',
  ];
  for (const m of libModules) {
    items.push(check(`import ${m}`, async () => {
      const mod = await importFrom(m);
      if (!mod || typeof mod !== 'object') throw new Error('导出为空');
      return `导出 ${Object.keys(mod).length} 项`;
    }));
  }

  // 5) 自研核心文件存在，且几何模块的导出面与契约一致
  for (const f of CORE_FILES) {
    items.push(check(`lib/${f}`, () => {
      const p = path.join(LIB_DIR, f);
      if (!existsSync(p)) throw new Error('文件不存在');
      return '存在';
    }));
  }
  items.push(check('lib/geometry.mjs 导出面', async () => {
    const mod = await importFrom('../lib/geometry.mjs');
    const got = Object.keys(mod).filter((k) => typeof mod[k] === 'function').sort();
    const want = [...GEOMETRY_EXPORTS].sort();
    const missing = want.filter((k) => !got.includes(k));
    const extra = got.filter((k) => !want.includes(k));
    if (missing.length || extra.length) {
      throw new Error(`导出面与契约不符：缺少 [${missing.join(', ')}]；多出 [${extra.join(', ')}]`);
    }
    return `${got.length} 个导出，与契约一致`;
  }));
  items.push(check('已淘汰的 vendored 文件不存在', () => {
    const still = REMOVED_VENDOR_FILES.filter((f) => existsSync(path.join(LIB_DIR, f)));
    if (still.length) throw new Error(`这些文件应已被净室重写淘汰，却仍然存在：${still.join(', ')}`);
    return `已确认 ${REMOVED_VENDOR_FILES.join(', ')} 均不存在`;
  }));
  items.push(check('几何行为基线存在', () => {
    const dir = path.join(SKILL_ROOT, 'tests', 'fixtures');
    const files = ['geometry-corpus.json', 'geometry-golden.json'];
    for (const f of files) if (!existsSync(path.join(dir, f))) throw new Error(`缺少 ${f}`);
    return '语料与 golden 齐备';
  }));

  // 6) 文档常量 ↔ 代码常量
  items.push(check('docs 常量 ↔ 代码常量', checkDocsConsistency));

  // 7) tests/ 存在
  items.push(check('tests/ ≥ 1', () => {
    const dir = path.join(SKILL_ROOT, 'tests');
    let list;
    try { list = readdirSync(dir).filter((f) => f.endsWith('.mjs')); }
    catch { throw new Error('tests 目录不存在'); }
    if (list.length < 1) throw new Error('tests 目录为空');
    return `${list.length} 个测试文件`;
  }));

  // 8) samples/ 与 samples/README 覆盖矩阵一致
  items.push(check('samples/ 覆盖矩阵', () => {
    const dir = path.join(SKILL_ROOT, 'samples');
    let jsons;
    try { jsons = readdirSync(dir).filter((f) => f.endsWith('.json')); }
    catch (e) { throw new Error(`无法读取 samples 目录：${e.message}`); }
    if (jsons.length < 1) throw new Error('samples 目录为空');
    let readme;
    try { readme = readFileSync(path.join(dir, 'README.md'), 'utf8'); }
    catch { throw new Error('samples/README.md 不存在'); }
    const missing = jsons
      .map((f) => f.split('.')[0])
      .filter((stem) => !readme.includes('`' + stem + '`'));
    if (missing.length) throw new Error(`samples/README 覆盖矩阵缺少：${missing.join(', ')}`);
    return `${jsons.length} 个样例，覆盖矩阵齐全`;
  }));

  const results = await Promise.all(items);

  let allOk = true;
  for (const r of results) {
    if (!r.ok) allOk = false;
    console.log(`  [${r.ok ? 'ok' : 'fail'}] ${r.label}  ${r.msg}`);
  }
  console.log('');
  if (allOk) {
    console.log('v2svg is ready.');
    return 0;
  }
  console.log('v2svg 自检未通过，请修复上述 [fail] 项。');
  return 1;
}

// =====================================================================
// 入口分发
// =====================================================================
function printUsage() {
  console.log(`v2svg —— 把 IR JSON 渲染为可嵌入文档的静态 SVG 并做机械验证

用法：
  svg doctor                                            环境自检（含文档↔代码常量一致性）
  svg test   [--json]                                   跑 tests/*.test.mjs（零依赖）
  svg guide "<场景>"                                    分型路由：回流优先 + 打分推荐
  svg validate <type> <input.json> [--quality standard|showcase] [--theme follow|light] [--variant-pair <dir>] [--json]
  svg render   <type> <input.json> <output.svg> [--quality standard|showcase] [--theme follow|light] [--variant-pair <dir>] [--json]

类型：architecture | flow | sequence
主题：--theme follow（默认，亮色优先 + 宿主暗色自适应）| light（固定亮色，不跟随宿主主题）
退出码：0 通过 / 1 验证失败 / 2 用法错误`);
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    printUsage();
    return cmd ? 0 : 2;
  }

  try {
    switch (cmd) {
      case 'doctor': return await cmdDoctor();
      case 'test': return await cmdTest(rest);
      case 'guide': return cmdGuide(rest);
      case 'validate': return await cmdValidate(rest, 'validate');
      case 'render': return await cmdRender(rest);
      default:
        throw new UsageError(`未知命令：「${cmd}」`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      if (rest.includes('--json') || process.argv.includes('--json')) {
        const typeArg = rest.find((a) => TYPES.has(a));
        process.stdout.write(JSON.stringify(cliErrorReceipt(cmd, typeArg, e.message, 'cli/usage'), null, 2) + '\n');
      } else {
        console.error(`用法错误：${e.message}`);
      }
      return 2;
    }
    // 未预期错误：友好中文 + 退出码 2
    const msg = `内部错误：${e.message}`;
    if (rest.includes('--json')) {
      process.stdout.write(JSON.stringify(cliErrorReceipt(cmd, null, msg, 'cli/internal'), null, 2) + '\n');
    } else {
      console.error(msg);
    }
    return 2;
  }
}

const code = await main();
process.exitCode = code;
