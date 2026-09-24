---
name: v2svg
description: This skill should be used when the user asks to create, redraw, or validate a professional diagram — architecture, system topology, flowchart, pipeline, sequence diagram, decision tree, state flow, or comparison (架构图 / 拓扑图 / 流程图 / 时序图 / 决策树). Accepts IR JSON, Markdown, or plain prose as input and renders one self-contained static SVG with automatic layout, light/dark theming, zero JavaScript, and 27 mechanical checks. Also converts Mermaid or prose into static SVG. Not for raster images or freeform artwork.
agent_created: true
---

# v2svg —— IR JSON → 静态 SVG 渲染 + 机械验证

把「结构化图描述（IR JSON）」渲染为**可嵌入文档的静态 SVG**，并对构图质量做 27 项机械检查，产出机器可读回执。自动布局、零 JS、亮色优先 + `prefers-color-scheme: dark`（可用 `--theme light` 固定亮色、不跟随宿主主题）、单图通常 < 15 KB。

**本技能自包含**：只认 IR JSON，不依赖任何外部 skill 或业务语义。

## 快速创作路径

1. **选类型**：按下方「类型路由表」确定 `architecture` / `flow` / `sequence`。
2. **读约定 + schema + example**：先读 `references/design-system.md`（域→role 配色、文案模板、fewshot）；再对照 `schemas/<type>.schema.json` 与 `examples/<type>.json`；成品级参考（含已渲染 SVG、覆盖全部类型与变体）见 `samples/`。
3. **写 IR**：只填语义（`role` / `label` / `edges`），**禁止手写坐标**——坐标由 `lib/layout.mjs` 自动布局。
4. **validate**：`svg validate <type> <ir.json> --quality showcase`。
5. **按诊断修**：回执里的 `diagnostics[].supportedFixes` 是定点修复建议，逐条改 IR，**不要为了让检查通过而裁剪语义**。
6. **render**：全部通过后 `svg render <type> <ir.json> <out.svg> --quality showcase` 才产出文件。

## 类型路由表

| 类型 | 适用场景 | 关键结构 |
|:---|:---|:---|
| `architecture` | 分层图、边界图、组件图、**并列对比图** | `groups` + `nodes` + `edges` |
| `flow` | Pipeline、流程图、**决策树**、**演进路线** | `stages` + `nodes(kind)` + `edges` |
| `sequence` | 时序、请求生命周期、调用链 | `participants` + `messages` |

> 对比图 = architecture 的分组变体；演进路线 = flow 的阶段（`stages`）变体。二者不单独立类型。

## 创作不变量（硬性）

1. **一条清晰主路径**：读者一眼能跟出主干，辅助信息不得喧宾夺主。
2. **节点 ≤ 24**：超过 24 个节点必须拆分为多张图，禁止塞进单图。
3. **边标签是语义数据**：`edge.label` 描述调用/数据类型，**不能随便删**——删标签等于删信息。
4. **先删低价值边再加路由控制**：拥挤时优先删冗余边，再用布局/分组疏解，而非裁剪语义。
5. **不为通过检查而改语义**：检查失败是信号，不是目标。

## 有界重试规则

- 连续**两轮**修复后错误数未降低 → **停止**，并在回执/报告中**如实列出未解决诊断**。
- 禁止以以下手段伪造通过：
  - 裁剪信息（删节点/删边/删标签）；
  - `overflow:hidden` 或任何隐藏溢出；
  - 缩小字号规避净空/对比度检查。

## 明确禁止

- ❌ 用裁剪内容、缩小字号、`overflow:hidden` 伪造检查通过。
- ❌ 在验证失败时产出 SVG 文件（`render` 验证不过绝不写盘）。
- ❌ 未经 `svg test` 通过就改动 `lib/geometry.mjs`：它的行为由 1278 条冻结基线锁定，改完必须全过；
  也不得重跑 `tests/tools/` 下的基线生成脚本（会把判据换成实现自己的输出）。
- ❌ 在 IR 里手写坐标（`pos`/`x`/`y` 等由布局器生成）。
- ❌ 依赖任何外部 skill 文件，或让 IR 语义耦合某个具体业务领域。
- ❌ 引入任何 npm 依赖。

## CLI 用法

```bash
svg doctor                                              # 环境自检（含文档↔代码常量一致性），全绿打印 "v2svg is ready."
svg test                                                # 跑 tests/*.test.mjs（零依赖，改度量/常量后必跑）
svg guide "<场景>"                                      # 分型路由：先判「是否该回流（别用本管线）」并给替代方案，再按命中词打分推荐类型（并列时报歧义），并附该类型最小必读规则与最简 IR 骨架
svg validate <type> <input.json> [--quality standard|showcase] [--theme follow|light] [--json]
svg render   <type> <input.json> <output.svg> [--quality standard|showcase] [--theme follow|light] [--json]
```

- `<type>` ∈ `architecture` | `flow` | `sequence`，且必须与 IR 内 `type` 一致。
- `--quality`：`standard` = 19 项（12 构图 + no_ascii + no_base64 + marker_contract + ref_reachable + svg_a11y + svg_hygiene）；`showcase` = 27 项全过。默认 `standard`。
- `--theme`：`follow` = 亮色优先 + `prefers-color-scheme` 宿主暗色自适应（**默认**，向后兼容）；`light` = **固定亮色、不跟随宿主主题**。图要进 PDF / 截图 / 印刷文档等「外观必须确定、不能随读者系统主题变」的场景用 `light`。`light` 的产物 **= `follow` 去掉暗色块**（逐字节相等，有回归测试固化）。
- `--json`：回执以 JSON 输出（见 `references/diagram-contract.md`）；非 `--json` 为人类可读逐项结果。
- validate 与 render **跑同一批检查**（validate 也先在内存渲染一份产物），故「validate 通过」等价于「render 会通过」。
- 改了字号/盒宽/标定系数后，除 `test` 与 `doctor` 外还要跑一次渲染级复核（见 `references/design-system.md` §2.3）。

### 退出码

`0` 通过 ／ `1` 验证失败（`render` 时不产出文件）／ `2` 用法错误。
完整含义表见 `references/diagram-contract.md`。

## 输出要求（交给调用方）

返回产物时务必包含：

- **产物路径**：`output.svg` 绝对路径；
- **类型**：`type`；
- **验证摘要**：档位 + `passed/total` + 失败项名（showcase 须 `27/27`）；
- **回执**：`--json` 时直接转发回执；非 `--json` 时总结 `ok` 与失败诊断。

## 参考文档

- `references/design-system.md` —— **固定风格约定 + 可复制 fewshot**：域→role 配色映射、字级/线宽表、**字宽标定表与盒宽公式**、渲染级复核命令、文案规范、布局三原则、出图前自检 6 条。**写第一版 IR 前先读它**，能省掉大半返工。
- `references/diagram-spec.md` —— IR 字段完整说明、`role` 三域语义、布局规则（含分带与列心漂移规律）、修复优先级。
- `references/diagram-contract.md` —— Diagnostic / Check / 回执契约、27 项检查逐项说明、档位项数、文档口径断言、退出码表。
- `references/rendered-output-audit.md` —— **批量审计已渲染产物**：本管线产物的识别特征（并集口径，及 `class="node"` 为何是误报源）、IR 中缀清点、等价性比对（逐字节 `cmp` / 文本须拼接后比）、样式代际判定与四条审计纪律。要回答「这批 SVG 里哪些是本管线产物 / IR 是否齐备 / 是否仍一致 / 哪些是旧样式」时读它。

## 代码结构（改代码前先看）

| 文件 | 职责 | 改它的后果 |
|:---|:---|:---|
| `lib/typography.mjs` | **字号 / 盒几何 / 线宽 / 图例 / 画布 / 时序 常量** | 改一处即全局生效；`doctor` 会断言文档与它一致 |
| `lib/text-metrics.mjs` | 字符宽度系数表、宽度估算、折行 | 改系数必过 `tests/text-metrics.test.mjs`，再跑渲染级复核 |
| `lib/markers.mjs` | 箭头 marker 契约（id 集合 + defs 几何 + kind→style） | `marker_contract` 检查双向断言，勿在别处硬编码 id |
| `lib/theme.mjs` | 配色 token、CSS 生成（字号由 `typography.mjs` 注入） | 影响 `theme_readable` 对比度 |
| `lib/layout.mjs` | 自动布局（纯计算） | 坐标改动须同时平移 `cx/cy`（`node_text_in_box` 会拦） |
| `lib/render.mjs` | IR → SVG 字符串 | **不得出现裸数值**，全部引用常量模块 |
| `lib/geometry.mjs` | 自研几何内核（8 个导出） | 可改，但**必须先过 `tests/geometry-parity.test.mjs`**（1278 条冻结基线） |
| `tests/*.test.mjs` | 零依赖断言（`svg test`） | 改上面任一项后必跑 |
| `tests/*.tool.mjs` | 需 headless 浏览器的工具，不属 `svg test` | 改度量/渲染后手动跑 |
