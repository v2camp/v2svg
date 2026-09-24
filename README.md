# v2svg

> 面向开发者的架构图设计 skill：**让 AI 在设计技术文档时，把风格规范的图无缝嵌进文档细节里。**

---

## 项目目的

### 为什么用 SVG 做架构图的载体

| 方案 | 好用的地方 | 卡在哪 |
|:---|:---|:---|
| **drawio** | 成熟编辑器，拖拽直观 | 与 Markdown 文档流是**断裂**的：要嵌进文档得先导出成图片，从此不可 diff、不能跟随明暗主题，改一次要回工具里重来 |
| **mermaid** | 纯文本，Markdown 原生支持 | 布局**不可控**（节点位置由它决定）、风格无法规范化、稍复杂就挤成一团 |
| **PNG / 截图** | 所见即所得 | 二进制、不可 diff、不可检索、缩放糊 |
| **手写 SVG** | 完全可控 | 要自己算坐标；模型一次性输出，画错只能整体重来 |
| **v2svg 产出的 SVG** | 单文件、纯文本、可 diff、可检索、跟随明暗主题、缩放到任意尺寸都锐利 | —— |

SVG 是**纯文本**，所以它天然对 LLM 友好（能读、能写、能改局部），又**所见即所得**（浏览器/飞书/Obsidian/GitHub 直接渲染）。

### 这个 skill 要解决什么

让模型**直接写 SVG** 有三个绕不开的毛病：

| 问题 | 后果 |
|:---|:---|
| 手写坐标 | 标签压线、连线穿越节点、间距失控 —— 只能靠肉眼发现 |
| 一次性输出 | 画错没有诊断，只能整体重来 |
| 风格漂移 | 每次生成一个样，跨文档、跨仓库都不一致 |

v2svg 的做法是**让模型输出结构，而不是输出像素**，并在出图前**做 27 项机械检查**：

```
自然语言 / 代码 / 文档片段
      ↓
  Typed JSON IR      ← 只管语义（谁连着谁、什么色、什么文案），不写坐标
      ↓
  Schema 校验         ← 字段合法性
      ↓
  机械检查（27 项）    ← 标签遮挡、连边穿越、走廊歧义、对比度、文字描边、箭头契约…
      ↓
  静态 SVG            ← 单文件，直接贴进文档
```

验证失败不是抛异常了事，而是返回**结构化诊断**：哪个节点、哪条边、违反哪条规则、实测多少、建议怎么修。
据此改 IR 再跑，形成 `生成 → 验证 → 修复 → 交付` 的闭环。

### 目标

技术文档写作时，AI 能**贴着正文细节**产出图形 —— 图的粒度、术语、口径与它旁边那段文字一致，风格与整本文档一致，并且不需要人回到图形工具里返工。

### 设计原则

1. **结构先于像素**：模型输出 IR，不出 SVG 字符串。
2. **验证即契约**：检查项机器可读，失败给出 `subject` / `evidence` / `supportedFixes`。
3. **有界诚实**：修不好就如实报告，不允许伪造通过。
4. **自包含**：无运行时依赖，产物可脱离本工具独立使用。
5. **常量单点**：字号、几何、线宽、marker id 各只有一处定义，`doctor` 断言文档与代码一致。

---

## 最佳实践

### 1. 写文档的同时产出图（关键词触发）

不要在写完文档后"补配图"，而是**在写正文的过程中随手把图一起产出**。当正文出现下列信号时，就该考虑配一张图：

| 正文里出现 | 该配什么 | 为什么 |
|:---|:---|:---|
| 「分为三层」「上下游」「包含 A / B / C 模块」 | `architecture` · 分层图 | 层级关系用文字描述要读三遍，一眼图就够 |
| 「方案 A 与方案 B 的区别」 | `architecture` · 并列对比 | 两栏并排比逐条文字更省读者脑力 |
| 「第一步…然后…接着…」「如果…则…」 | `flow` · 流程 / 决策树 | 顺序与分支是图的强项 |
| 「客户端请求服务端、服务端再调 X」 | `sequence` | 往返顺序只有时序图的纵向排列能说清 |
| 「V1 → V2 → V3 的演进」 | `flow` · 阶段带（`stages`） | 演进是横向展开的 |
| 「一个请求的完整生命周期」 | `sequence` | 同上 |

**关键点：图与正文同批产出。** 正文刚写完时上下文最全（术语、粒度、口径都在手上），此时出图不需要重新理解一遍；事后补图往往要重读文档，还容易与正文口径打架。

### 2. 基于文档的局部逻辑出图

不必一次画"整个系统"。**挑正文里一个自洽的段落** —— 一段讲清了一个完整机制、一条完整链路、一组完整关系 —— 把它转成一张图，图跟在段落后。

这样做的三个好处：

- **粒度天然对齐**：图的边界就是段落的边界，读者读到哪就看到哪。
- **违反约束时能立刻发现**：如果一段逻辑画不进一张图（节点爆炸、边交叉成网），那说明**这段逻辑本身没讲清**，不是图的问题 —— 这正是架构图作为"思维检查工具"的价值。
- **改起来便宜**：正文改了只需要重画那一张，不影响别处。

判定单图是否超载的硬线：**节点 ≤ 24**；超过就按语义拆成两张，不要靠缩小字号塞进去。

### 3. 文字图形 → 架构图

已经有"文字形态的图"时，直接转成规范图。三类常见输入：

| 输入形态 | 例子 | 怎么转 |
|:---|:---|:---|
| **ASCII 流程图** | `请求 → 网关 → 服务 → DB`<br>（夹在代码块里的箭头图） | 识别节点与箭头 → 写 IR。ASCII 图**不要再留在正文里**（它会随字体错位），换成渲染出的 SVG |
| **步骤列表 / 编号清单** | 1. 解析 2. 校验 3. 入库 | 每个条目一个节点，顺序即 `flow` 的边；有分支的条目改用 `kind: "decision"` |
| **缩进 / 层级清单** | `接入层`<br>`　├ 网关`<br>`　└ 鉴权` | 顶层是 `groups`，缩进项是该组内的 `nodes` |

转之前先做一次**语义归一**：把同义词统一（"网关"与"API 网关"是同一个节点）、把隐含关系显式化（"然后"= 一条 `sync` 边，但"失败回滚"= `fallback` 边）。这一步做对了，图才是准确的，而不只是好看。

---

## 图类型介绍

三种类型覆盖绝大多数技术文档场景。下面每张图都是 `samples/` 里可运行的成品（改变 IR 即可重渲染）。

### `architecture` —— 分层 / 拓扑 / 边界 / 并列对比

> `groups` + `nodes` + `edges`。适合"东西在哪里、由什么组成、谁依赖谁"。

**分层图**：每个 `group` 是一条横带，域的划分即层次的划分。

![电商订单系统分层架构](samples/order-system.svg)

**并列对比**：两个并列 `group` 表达同一业务的两种方案，`warn` 角色标记阻塞点。

![同步阻塞 vs 事件驱动的下单链路](samples/sync-async-compare.svg)

**要点**：先定"域"再映射 `role`（一域一色）；组内节点 ≤ 4；带间关系让边指向**整组外框**，带内顺序用水平边表达。

**可运行文件**：最小 IR 见 [`examples/log-ingest.architecture.json`](examples/log-ingest.architecture.json)；上面两张成品见 [`samples/order-system.architecture.json`](samples/order-system.architecture.json) 与 [`samples/sync-async-compare.architecture.json`](samples/sync-async-compare.architecture.json)。

### `flow` —— 流程 / 决策树 / Pipeline / 演进路线

> `stages` + `nodes(kind)` + `edges`。适合"先做什么、在哪个条件上分叉、一路怎么演进来"。

**阶段带 Pipeline**：`stages` 横向分列，`fallback` 边表达回退重跑。

![CI 发布流水线](samples/ci-pipeline.svg)

**决策树**：`kind: "decision"` 的分叉节点，多个出口分级。

![线上告警分级决策树](samples/alert-triage.svg)

**要点**：`kind` ∈ `start` / `step` / `decision` / `terminal`；**不要环形布局**表达循环 —— 用阶段线性 + 回边，或改成交互式步骤说明。

**可运行文件**：最小 IR 见 [`examples/deploy-gate.flow.json`](examples/deploy-gate.flow.json)；上面两张成品见 [`samples/ci-pipeline.flow.json`](samples/ci-pipeline.flow.json) 与 [`samples/alert-triage.flow.json`](samples/alert-triage.flow.json)。

### `sequence` —— 调用链 / 请求生命周期 / 参与者交互

> `participants` + `messages`。适合"谁在第几步和谁说话、往返了几次"。

![OAuth 2.0 授权码模式登录时序](samples/oauth-login.svg)

**要点**：参与者 ≥ 2；`messages[].kind` ∈ `sync` / `async` / `return` / `self`（自调用回环用 `self`）；消息按出现顺序自上而下，调用方不写坐标。

**可运行文件**：最小 IR 见 [`examples/cache-miss-request.sequence.json`](examples/cache-miss-request.sequence.json)；上面这张成品见 [`samples/oauth-login.sequence.json`](samples/oauth-login.sequence.json)。

> 完整覆盖矩阵（含每个样例演示的细节变体）见 [`samples/README.md`](samples/README.md)。

---

## 语义色板与风格系统

### 语义色板：颜色是**语义**，不是装饰

节点颜色由 `role` 决定，语义固定、不随主题漂移：

| `role` | 业务域 | 色系 |
|:---|:---|:---|
| `control` | 规则 / 编排 / 调度 / 状态 | 紫 |
| `capability` | 能力 / 工具 / 组件 / 外部系统 | 绿 |
| `interaction` | 协议 / 接口 / 数据契约 / 可查询实体 | 蓝 |
| `warn` | 约束 / 拦截 / 失败路径 | 橙红 |
| `neutral` | 中性 / 基础设施 / 说明 | 灰 |

**两条硬规则**：

1. **一图内同一语义只用一种 `role`。** 不要"这个实体用蓝、那个实体也用蓝"却没有共同语义。
2. **先列域 → role 的映射，再写 IR。** 映射表本身就是对这张图的一次语义检查。

域到 role 的完整映射建议、以及各 `role` 的亮/暗配色值，见 [`references/design-system.md`](references/design-system.md)。

### 风格常量：固定值，不要逐图调

| 元素 | 值 |
|:---|:---|
| 主标题 / 节点标题 | 24px / 组框标题 13px / 节点标题 **16px**（weight 700） |
| 节点副标签 / 边标签 / 图例 | 12px |
| 连线 | `stroke-width: 2` |
| 节点卡片 | 宽 96–240px、圆角 8px、单行高 42px / 双行 58px |
| 组框 | 内边距 18px、圆角 14px（**外层 > 内层**） |
| 画布 | 宽 ≤ ~1000px，比例收到 1.0–1.6 |

节点标题**统一中性近黑/近白**，`role` 色只承担卡片填充与描边的语义 —— 若标题也用同色系深调，会与同色系浅底顺色发虚。

### 明暗双模

产物内联样式，**亮色优先** + `@media (prefers-color-scheme: dark)` 自动适配（要「外观不随读者系统主题变」时用 `--theme light` 固定亮色，见 CLI 段）。
两个模式下文字与填充的对比度都 ≥ 4.5:1（WCAG AA），由 `theme_readable` 检查强制保证。

### 画幅体检（出图后 30 秒）

图最终会按**文档正文宽度**（约 700px）缩放，所以：

- 画布宽 ≤ ~1000px（这样 16px 正文缩到 700px 展示时仍有 ≈11px）
- 超过就**按语义拆带**，不要缩字号
- 各字级在 700px 展示下的下限：节点标题 ≥ 11px、组框标签 ≥ 10px

---

## 其他使用细节

### 什么时候**不要**用 v2svg

`guide` 会主动把下面这些场景**推给更合适的工具**，而不是硬出一张图：

| 场景 | 该用什么 | 为什么 |
|:---|:---|:---|
| 数据库表结构 / ER / 字段清单 | mermaid `erDiagram` | 字段列表在盒子里塞不下，且表结构改得频繁 |
| 循环 / 闭环 / 轮转 | 分阶段线性 + 回边，或交互式步骤说明 | 环形布局可读性差、节点文字被压缩 |
| 地图 / 地理分布 | 外部地图工具 + 真实拓扑数据 | 手搓坐标画地图必错 |
| 柱状图 / 折线 / 占比 / 趋势 | 外部图表工具 | v2svg 是结构图工具，不是数据图表工具 |
| 纯数据表 / 参数清单 | Markdown 表格 | 结构化数据优先用表格 |

### 快速开始

无需安装依赖，Clone 即可用：

```bash
node bin/svg.mjs doctor     # 环境自检，全绿打印 "v2svg is ready."
node bin/svg.mjs guide "订单创建的服务调用链"   # 让 tool 先建议类型与骨架
```

写一个 IR（完整字段见 `schemas/` 与 `examples/`）：

```json
{
  "schema_version": 1,
  "type": "architecture",
  "meta": { "title": "缓存未命中的读路径", "caption": "图 3-1 · 读请求回溯源库" },
  "nodes": [
    { "id": "api",   "label": "API 服务", "role": "control" },
    { "id": "cache", "label": "Redis",    "role": "capability" },
    { "id": "db",    "label": "主库",     "role": "capability" }
  ],
  "edges": [
    { "from": "api", "to": "cache", "label": "GET", "kind": "sync" },
    { "from": "api", "to": "db",    "label": "回源", "kind": "fallback" }
  ]
}
```

验证并出图：

```bash
node bin/svg.mjs validate architecture demo.json --quality showcase
node bin/svg.mjs render   architecture demo.json demo.svg --quality showcase --json
```

验证不通过时 `render` **绝不产出文件**。

### CLI

```bash
svg doctor                                            环境自检（含文档↔代码常量一致性）
svg test                                              跑零依赖测试（含几何行为基线差分测试）
svg guide "<场景>"                                    分型建议：回流优先 + 打分推荐 + 该类型最小规则
svg validate <type> <input.json> [--quality standard|showcase] [--theme follow|light] [--json]
svg render   <type> <input.json> <output.svg> [--quality standard|showcase] [--theme follow|light] [--json]
```

- `<type>` ∈ `architecture` | `flow` | `sequence`
- `--quality`：`standard` 19 项 / `showcase` 27 项（默认 `standard`）
- `--theme`：`follow`（默认）亮色优先 + 宿主暗色自适应；`light` **固定亮色、不跟随宿主主题**——用于图要进 PDF / 截图 / 印刷文档等外观必须确定的场景。`light` 产物 **= `follow` 去掉暗色块**（逐字节相等，`tests/invariants.test.mjs` 固化）。
- `--json`：输出机器可读回执，含 `checks`、`composition.summary`、`artifact.sha256`
- `validate` 与 `render` **跑同一批检查**（都会先渲染一份产物），故"validate 通过"等价于"render 会通过"

退出码：

| 码 | 含义 |
|:---:|:---|
| `0` | 通过 |
| `1` | 验证失败（`render` 时不产出文件） |
| `2` | 用法错误（未知类型 / 文件缺失 / JSON 解析失败） |

### 质量门禁

**构图检查 12 项** —— 坐标有限性、**声明实体覆盖**、节点重叠、文字锚点在盒内、文案截断、连线穿越无关节点、标签净空、
端点正交、走廊歧义、贴边借道、转折节奏、图例净空。

**文档集成检查 15 项** —— ASCII 画图残留、base64 内嵌、文字描边污染、箭头 marker 契约、产物文字适配、**内容不越出画布**、
Markdown 引用可达、图题规范、明暗双模对比度、多版本目录图资源一致性、无障碍（`role="img"` + `title`/`desc`）、
产物卫生（无注释/渐变/滤镜）、字重白名单、语义域预算、展示字号下限。

有界重试：连续两轮修复未降低错误数即**停止并如实报告**未解决诊断。
禁止以裁剪内容、缩小字号、隐藏溢出等手段伪造通过。

### 产物特性

- 单文件静态 SVG，**内联样式**，亮色优先 + 暗色自适应
- **零 JS**、无 `foreignObject`、无外部字体，可在飞书 / Obsidian / GitHub 等环境正常渲染
- 自动布局，**调用方不写坐标**；内容放不下时自动扩展画布，不压缩节点、不缩字号
- **画布自动贴合内容**：`viewBox` 只作行内舒展提示，成品尺寸裁到内容边界（含图例），不留空边
- `meta.caption` 除写入 `<desc>` 外，同时渲染为**底部图注**（图号 + 口径就近可读）
- 含 `<title>` / `<desc>` 无障碍信息；`role="img"`
- 单图通常 **< 15 KB**

### 运行时要求

- **Node.js 18+**，仅用内置模块，**零 npm 依赖**
- 源文件为 `.mjs`，不依赖 `package.json` 的 `type` 字段
- 路径一律用 `import.meta.url` 相对解析，**支持从任意 cwd 调用**
- **不读取任何环境变量**

### 第三方代码

**无。** 全部源码自研，因此不需要保留任何上游归属声明 —— 详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

几何内核 `lib/geometry.mjs` 的行为由 **1278 条冻结基线**锁定（`tests/fixtures/geometry-golden.json`
+ `tests/geometry-parity.test.mjs`，相对容差 1e-9）。改它之前请先读 [`lib/geometry.spec.md`](lib/geometry.spec.md)
（黑盒行为契约）并跑 `svg test`。

---

## 目录结构

```
v2svg/
├── SKILL.md                     # 技能入口（供 Agent 发现与加载）
├── README.md                    # 本文件
├── LICENSE                      # MIT
├── THIRD_PARTY_NOTICES.md       # 第三方代码声明（当前为空：全部自研）
├── package.json                 # { name, type: module, private: true }
├── bin/
│   ├── svg.mjs                  # CLI 入口（doctor / test / guide / validate / render）
│   └── guide-routing.mjs        # 分型判据：负向回流表 + 打分推荐 + 各类型最小规则
├── lib/
│   ├── geometry.mjs             # 自研几何内核（8 个导出，行为由冻结基线锁定）
│   ├── geometry.spec.md         # 上述模块的黑盒行为规格
│   ├── typography.mjs           # 字号 / 盒几何 / 线宽 / 图例 / 画布常量（单点定义）
│   ├── text-metrics.mjs         # 字宽系数表 + 宽度估算 + 折行
│   ├── markers.mjs              # 箭头 marker 契约（id 集合 + 几何 + kind→style）
│   ├── theme.mjs                # 配色 token 与明暗双模；CSS 由 typography 生成
│   ├── layout.mjs               # 自动布局（正交路由、阶段带、回边绕行、标签放置）
│   ├── render.mjs               # 静态 SVG 渲染（不含裸数值，全部引用常量模块）
│   ├── schema.mjs               # 运行时 schema 校验（JSON Schema 子集）
│   └── checks/
│       ├── composition.mjs      # 构图检查 12 项
│       └── document.mjs         # 文档集成检查 15 项
├── schemas/{common,architecture,flow,sequence}.schema.json
├── tests/                       # 零依赖测试（svg test）
│   ├── geometry-parity.test.mjs #   几何行为基线差分测试（1278 条，判据来源）
│   ├── fixtures/                #   冻结的行为基线（语料 + golden）
│   └── tools/                   #   基线生成脚本（已加硬闸门，默认拒绝运行）
├── examples/                    # 各类型最小示例 IR（Schema 对照用）
├── samples/                     # 成品样例画廊（IR + 已渲染 SVG，覆盖全部类型与变体）
└── references/
    ├── design-system.md         # 固定风格约定 + fewshot（域→role 配色、文案规范、自检）
    ├── diagram-spec.md          # IR 规范、role 语义、布局规则、修复优先级
    └── diagram-contract.md      # 诊断 / 回执契约、27 项检查逐项说明
```

---

## PR 贡献

这是一个**零依赖、自包含**的技能包。提交 PR 前请确认：

### 必跑（缺一不可）

```bash
node bin/svg.mjs doctor      # 自检 + 文档↔代码常量一致性
node bin/svg.mjs test        # 零依赖测试（含几何行为基线差分测试）
for f in samples/*.json; do :; done   # 若改动影响渲染，重渲染 samples 并确认产物可复现
```

改动 `lib/typography.mjs` / `lib/text-metrics.mjs` / `lib/render.mjs` / `lib/geometry.mjs`
还会影响**真实渲染结果**，需额外跑一次渲染级复核（需 headless Chromium）：

```bash
# 需可解析 playwright：把含 playwright 的 node_modules 交给 NODE_PATH（或已安装在依赖树中）
NODE_PATH=/path/to/node_modules \
node tests/verify-rendered-svg.tool.mjs
```

它用真实 `getBBox()` 比对「盒内文字 vs 盒矩形」「边标签 vs 背景遮罩」，**容差 0**。

### 约束

| 项 | 要求 |
|:---|:---|
| **零依赖** | 不引入任何 npm 包（含 devDependency）；只用 Node 内置模块 |
| **常量单点** | 字号 / 几何 / 线宽 / marker id 只能定义在 `typography.mjs` / `markers.mjs`；`render.mjs` 内不得出现裸数值 |
| **改口径要同步文档** | 检查项数、字级、线宽改动后必须同步 `README.md` / `SKILL.md` / `references/*.md` —— `doctor` 会逐条断言，漏改即红 |
| **几何内核** | 改动必须过 1278 条冻结基线；**不要重跑 `tests/tools/` 下的基线生成脚本**（会把判据换成实现自己的输出，见该目录说明） |
| **新增检查项** | 必须同时给出**负向用例**（构造必定违规的输入并断言它报错）—— 恒真的检查等于没有 |
| **语言** | 面向用户的文案用中文；代码标识符用英文 |

### 提交流程

1. 从 `main` 开分支，分支名用连字符小写且能看出用途（如 `fix-label-clearance`）
2. 提交信息用 `<type>: <中文说明>`，`<type>` ∈ `feat` / `fix` / `docs` / `chore` / `test`
3. 正文写清：改了什么、为什么、**怎么验证的**（命令 + 结果）
4. 一个 PR 只做一件事；涉及产物变化的，PR 里说明产物是否逐字节可复现

---

## 版本历史

> 上表只记「能力边界的变化」；完整变更见下方详细条目。

| 版本 | 变化 |
|:---|:---|
| **v0.1.8** | 去课程耦合，对齐通用架构图定位：示例/fewshot 中性化、`ref_reachable` 放宽相对图片路径、工具路径去本机硬编码、`checkDualTrackParity` → `checkVariantParity` |
| **v0.1.7** | 画布边界计入**文本自身尺寸**（修「居中文字被切」）+ 新增 `content_within_canvas` 检查（26 → 27 项） |
| **v0.1.6** | 新增构图检查 `entity_coverage`（25 → 26 项）：堵住「IR 声明了、产物里却没有」的**静默丢弃** |
| **v0.1.5** | 去掉 vendored 的第三方几何内核，改为自研（本 skill 自此不含任何第三方代码）；行为由 1278 条冻结基线锁定 |
| **v0.1.4** | 新增 5 项文档侧检查（20 → 25 项）；「画幅体检」从人工判据变为可断言契约 |
| **v0.1.3** | 常量单点化（`typography` / `text-metrics` / `markers`）；字宽系数改为实测标定；新增 `marker_contract` / `svg_text_fits` / `text_not_truncated` |
| **v0.1.2** | 三类型定型、17 项检查、画布自动贴合、共列网格、固定风格设计系统 |
| **v0.1.0** | 首个版本：IR JSON → 自动布局 → 静态 SVG，三类型 + 机械验证 |

### 详细条目

#### v0.1.8 —— 去课程耦合，定位通用架构图 skill

技能原先从课程制作场景长出，文案例证与命名带有课程口径。本版将其对齐为**通用技术文档配图工具**：

- 文档/注释中的「课程讲义」「原课程设计系统」「实战课 N 张」等改为通用表述（PDF / 印刷文档 / 分层图实测）。
- `examples/` 去掉课程同温层域名：`agent-tool-call` → `deploy-gate`（发布门禁）、`ingestion-pipeline` → `log-ingest`（日志接入检索）；`evolution-roadmap` 改为「平台架构演进（单体→服务化）」；caption 去掉虚构「实测」数字。
- design-system fewshot / 域映射表从中位课程项目（电商图谱 · 促销/会员/售后）改为「内容平台数据模型」等中性域名。
- `ref_reachable` 从只认 `./images/*.svg` 放宽为相对路径图片引用（`./`/`../` × svg/png/jpg/gif/webp）。
- 渲染级工具去掉本机 `workbuddy` / macOS 缓存硬编码：`NODE_PATH` 由调用方给出，chromium 交由 playwright 解析。
- `checkDualTrackParity` 更名 `checkVariantParity`（能力不变，仅去掉双轨课程语义）。
- 修正 rename 残留与口径漂移：目录树 `bin/v2svg.mjs` → `bin/svg.mjs`；管线图「25 项」→「27 项」；`diagram-spec` 修复优先级补全构图 12 项。

#### v0.1.7 —— 画布边界计入文本尺寸 + `content_within_canvas`（26 → 27 项）

**缺陷**：画布边界只由「几何元素 + 边标签的**锚点**」决定，**文本自身的尺寸不参与**：

- `meta.caption` 宽度完全不参与画布宽（`render.mjs` 只把它的**高度**算进 `H`）
- 边标签只累加 `labelAt` 这个点，不含标签矩形的宽高

实测两处**真溢出，且通过全部 26 项检查**：

| 场景 | 越界量 |
|:---|:---|
| 58 字图注（画布 319 宽） | **左右各 121px** |
| 16 字边标签（画布 369 宽） | **右侧 76px** |

**修复**（两处）：
- `lib/render.mjs` 新增 `fitCanvasToCenteredText()`：标题/图注宽度计入画布宽；变宽后把内容整体右移，
  使内容中线与居中文字对齐（否则内容左贴、文字居中，看起来错位）
- `lib/layout.mjs` 的 `finalize()`：边标签按**矩形**而非锚点累加边界

**新增检查** `content_within_canvas`（standard 档）：产物级断言所有 `rect` / `text` 都落在画布内。
不复刻渲染器，用与布局同一套 `estimateTextWidth` 估算文本宽；容差取 **1px**（画布宽度用的就是同一套估算，
不该放宽；「估算是否与真实字体相符」由 `tests/verify-rendered-svg.tool.mjs` 用浏览器 `getBBox()` 实测）。

**验收**：两处缺陷修复后越界归零（画布 319→616、369→468）；5 个样例渲染**逐字节不变**
（修复前就测得它们的标签距边界尚有 36~272px 余量，即「只改坏的、不动好的」）；
负向用例构造「画布装不下居中文字」并断言报错。档位 → `standard` 19 / `showcase` 27。

#### v0.1.6 —— 新增 `entity_coverage`，堵住静默丢弃（25 → 26 项）

起因是排查一张图的观感问题时，实测发现**IR 里声明了、产物里却没有**的情况**完全静默**：

| 形态 | 后果 |
|:---|:---|
| `flow` + `stages` 模式下 `node.stage` 缺失或值不存在 | 该节点**不在任何列里** → 直接不渲染 |
| 三种类型下 `edge`/`message` 的一端点 id 不存在 | 布局里 `if (!fb || !tb) continue;` → **边/消息被跳过** |

两者都**通过全部 25 项检查、零提示**——因为既有检查检查的正是「已被丢弃之后」的集合，
看不到缺口。而"图看着完整、拓扑却是错的"比报错更危险。

对照：`architecture` 模式会把 `group` 悬空的节点塞进「未分组附加带」（不丢），
其引发的边穿越还会被 `relationship_crossings` 拦下 —— 三种类型的健壮性并不一致。

新增的 `entity_coverage` 把 IR 的声明与 LayoutResult 的实际产出对账：
节点/参与者逐个核对，边/消息按 `from→to` **多重集**核对（同端点重复边也能查出）。
**空容器不算丢弃**（它的框仍被渲染），只在通过时作为附注列出。

- 档位：构图检查（两档都跑）→ `standard` 18 项 / `showcase` 26 项
- 配 2 条负向用例：`stage` 两种错误形态 + 三种类型下的悬空端点边
- 刻意**不改**框高策略：「分列框对齐到最高列」是观感取舍，实测改成「各自贴合」只是
  把空白从带内搬到画布上，并不更美观；且它是主观偏好，不该由全局常量替所有图决定

#### v0.1.5 —— 去掉 vendored 的第三方几何内核，改为净室自研（本 skill 自此不含任何第三方代码）：

- 移除 `lib/geometry.mjs`（vendored，1430 行）与 `lib/diagnostics.mjs`（134 行）；
  新 `lib/geometry.mjs` 为 547 行自研实现，对外恰好 8 个导出。
- 起因：实测该 vendored 依赖**只用到约 34%**（40 个导出里 7 个被实际调用），
  其余是上游的自动修复族、诊断录制与其渲染词汇；而「禁止修改 vendor」+「无上游跟踪机制」
  叠加，使被用到的那部分出 bug 时只能整体重新 vendor。
- 流程：**行为冻结 → 差分测试 → 黑盒规格 → 独立实现**。
  `tests/fixtures/geometry-golden.json` 用参考实现跑出 1278 条基线；
  `lib/geometry.spec.md` 是从参考实现反推的黑盒契约（不含代码/伪代码/内部标识符）；
  实现由未接触过参考实现的一方仅凭规格与基线写成。
- 验收：冻结基线 **1278/1278** 全过，且 5 个样例渲染产物**逐字节不变**。
- 另修一处规格误读导致的边界分歧：点—线段距离的退化判定参考实现比较的是**平方**长度，
  等效长度阈值 ≈3.16e-4（原规格写成 1e-7），已对齐并补 7 条边界语料钉住。
- 两个基线生成脚本加**硬闸门**（参考实现 sha256 校验 / `--force`），防止有人重跑后把判据
  换成实现自己的输出、使 parity 退化成永远为真。
- `doctor` 新增三项：`lib/geometry.mjs` 导出面与契约一致、已淘汰的 vendored 文件不存在、
  几何行为基线齐备。

#### v0.1.4 —— 新增 5 项文档侧检查（20 → 25 项），并把「画幅体检」从人工判据变成可断言契约：

- 新增 `svg_a11y`（standard）：根 `<svg>` 必须带 `role="img"`，且 `<title>` / `<desc>` 为首两个子元素
  （`lib/render.mjs` 根标签同步补上 `role="img"`；检查当日即生效）。
- 新增 `svg_hygiene`（standard）：产物不得含注释 / 渐变 / `<filter>` / `drop-shadow`·`blur`（回归护栏）。
- 新增 `weight_whitelist`（showcase）：产物实际字重必须 ∈ `{400, 700}`（白名单常量在 `lib/typography.mjs`，回归护栏）。
- 新增 `role_budget`（showcase）：用到的 role > 3 时须在 `meta.roleBudget` 给出理由并**显式列出** role 清单，
  防止语义域膨胀与「声明 ↔ 实际」漂移；4 个多域样例已补声明。
- 新增 `min_font_size`（showcase）：按「字级下限表」断言节点标题 ≥ 11px、组框标签 ≥ 10px
  （按 700px 展示折算；画布宽上限 = 700 × 字号 / 下限），把画幅体检固化为检查项。
- 5 项均配负向用例（构造违规输入 → 断言报错 → 断言正常输入通过）。

#### v0.1.3 —— 常量单点化与「估算 / 渲染 / 校验」三方拉齐：

- 新增 `lib/typography.mjs`（字号/盒几何/线宽/图例/画布常量）与 `lib/text-metrics.mjs`
  （**实测标定**的字宽系数表），`layout` / `render` / `theme` / `checks` 全部改为引用，
  不再各自硬编码（历史上四处各写一份，改一处即静默错位）。
- 新增 `lib/markers.mjs`：箭头 marker id 由契约单点定义，`marker_contract` 检查双向断言
  （悬空引用 / 越权 marker / 契约缺实现）。
- 新增检查 `text_not_truncated`（截断 = 信息丢失）、`marker_contract`、`svg_text_fits`
  （**产物级**：按渲染字号复核盒内文案与遮罩，能挡住跨模块常量错位）。合计 20 项。
- 修两处渲染缺陷（由新引入的渲染级复核实测发现，此前所有检查项均不可见）：
  边标签遮罩按 11px 估算而文字是 12px（遮罩窄 ~8%，连线从字缝透出）；
  `.edge-label` 已 `dominant-baseline: central` 却仍额外 `+3px`（文字稳定探出遮罩下沿 3.5px）。
- `validate` 改为同样先在内存渲染产物 → 与 `render` 跑同一批检查（此前 validate 静默跳过
  产物级检查，「validate 通过」≠「render 会通过」）。
- 新增 `svg test` 与 `tests/`：19 项零依赖断言 + 2 个 headless 浏览器工具（含负向用例，保证每项检查可证伪）。
- `svg doctor` 新增「docs 常量 ↔ 代码常量」断言（首次运行即抓出 13 处文档↔代码漂移）。

#### v0.1.2 —— 三类型、17 项检查（新增 `text_no_stroke`）、画布自动贴合、共列网格、固定风格设计系统。

---

v2svg 自身以 **MIT** 发布，见 [`LICENSE`](LICENSE)。
