# v2svg 制图规范（详版）

面向 Agent 的制图规范：IR 字段完整说明、`role` 三域语义、三种类型布局规则、创作不变量、修复优先级。

> 所有路径用 `import.meta.url` 解析，CLI 支持任意 cwd 调用。坐标**一律由布局器生成**，IR 中禁止出现 `x`/`y`/`pos`。

---

## 1. IR 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|:---|:---|:---:|:---|
| `schema_version` | `1` | ✓ | 常量，当前固定为 `1` |
| `type` | `"architecture"\|"flow"\|"sequence"` | ✓ | 图类型，**必须**与命令 `<type>` 一致 |
| `meta.title` | string | ✓ | 主标题 |
| `meta.caption` | string | 推荐 | 图题，形如 `图 X-N · 标题`（showcase 的 `caption_present` 校验此格式） |
| `meta.locale` | `"zh-CN"` | — | 语言标记 |
| `meta.viewBox` | `[number, number]` | — | 画布尺寸，默认 `[800, 500]` |

JSON Schema 是唯一契约源（`schemas/*.schema.json`），`lib/schema.mjs` 是数据驱动的子集校验器。

---

## 2. `role` 三域语义

`role` 是 IR 的**语义核心**（不是组件类型）。五值：

| `role` | 含义 | 亮色 fill / stroke / text | 暗色 fill / stroke / text |
|:---|:---|:---|:---|
| `control` | 编排 / 调度 / 状态 | `#fdf4ff` / `#c084fc` / `#7e22ce` | `rgba(168,85,247,.18)` / `#c084fc` / `#e9d5ff` |
| `capability` | 工具 / 算子 / 外部系统 | `#f0fdf4` / `#4ade80` / `#166534` | `rgba(74,222,128,.16)` / `#4ade80` / `#bbf7d0` |
| `interaction` | 协议 / 接口 / 数据契约 | `#eff6ff` / `#60a5fa` / `#1e40af` | `rgba(96,165,250,.16)` / `#60a5fa` / `#dbeafe` |
| `warn` | 警告 / 失败 / 拦截 | `#fef2f2` / `#ef4444` / `#b91c1c` | `rgba(239,68,68,.16)` / `#f87171` / `#fecaca` |
| `neutral` | 中性 / 说明 | `#f8fafc` / `#94a3b8` / `#475569` | `rgba(148,163,184,.14)` / `#94a3b8` / `#cbd5e1` |

- 画布亮 `#f8fafc` / 暗 `#0f172a`；正文亮 `#0f172a` / 暗 `#e2e8f0`；辅助文字亮 `#64748b` / 暗 `#94a3b8`；箭头亮 `#94a3b8` / 暗 `#64748b`。
- **对比度约束**：正文/节点文字与底色在明、暗两模式下均 **≥ 4.5:1**（`theme_readable` 检查）。

选用指南：
- 一个节点只承担一种主语义 → 选最贴切的 `role`，不要因为配色好看乱用。
- 颜色即信息：读者按紫/绿/蓝/红/灰快速区分「控制 / 能力 / 交互 / 警告 / 中性」。

---

## 3. 三种类型的 IR 结构

### 3.1 architecture

```
groups?: [{ id, label, role }]            # 层/边界/并列分组，role 决定分组边框色
nodes:   [{ id, label, role, sublabel?, group? }]
edges?:  [{ from, to, label?, kind? }]
```

- `group` 引用 `groups[].id`，节点落入对应分组框。
- 对比图：用多个 `groups` 并列表达对照（如「旧方案 vs 新方案」）。

### 3.2 flow

```
stages?: [{ id, label, role? }]           # 阶段带（演进路线用）
nodes:   [{ id, label, role, sublabel?, kind: "start"|"step"|"decision"|"terminal", stage? }]
edges?:  [{ from, to, label?, kind? }]
```

- `node.kind`：
  - `start` 起点（圆角/椭圆）
  - `step` 普通步骤
  - `decision` 决策（菱形，必有 ≥2 出边，建议带「是/否」标签）
  - `terminal` 终点
- 演进路线：用 `stages` + `node.stage` 表达时间/版本推进。

### 3.3 sequence

```
participants: [{ id, label, role }]
messages:     [{ from, to, label, kind: "sync"|"async"|"return"|"self" }]
```

- 无坐标：参与者纵向生命线由布局器生成，消息沿生命线走正交路由。
- `message.kind`：`self` 为自调用（回环）。

### 3.4 通用枚举

- `edge.kind`：`sync` | `async` | `data` | `fallback` | `return`
  - `data` 数据流向、`fallback` 降级/重试、`return` 返回、`async` 异步、`sync` 同步调用。

---

## 4. 布局规则（自动，禁止手写坐标）

| 类型 | 布局策略 |
|:---|:---|
| architecture | 见下方「architecture 分带规则」；`edges` 走正交路由（先出框、再走主干通道、再入框） |
| flow | 主干纵向单链；`decision` 分支向两侧展开；`stages` 作为顶部阶段带；**无 `stages` 时每层一行、每行独立居中**，回边（Kahn 拓扑序识别）走左侧外侧通道 |
| sequence | 参与者等距横向排布，生命线贯穿；消息按出现顺序自上而下 |

**architecture 分带规则**（决定边的走向，写 IR 前先想清楚）：

- **有 `groups`**：每个 group 是一条横向「带」，按 `groups` **声明顺序自上而下**堆叠；组内节点按 `nodes` 声明顺序自左至右。**未分组的节点会被收进最后一条附加带**——要让入口/出口落在正确位置，给它们也显式建 group 并排对顺序。
- **无 `groups`**：全部节点进**单条带**并按 √n 网格排布（`cols = ceil(√n)`）。跨格子的边极易穿越中间盒子，节点超过 4 个时优先显式分组。
- **带内连接默认水平直连**：同一带（同一横排）内相邻节点之间画「右缘中点 → 左缘中点」的直箭头；仅当两点之间还夹着同带其它盒子时才回退为绕顶折线。因此**带内 = 左右、带间 = 上下**，两套链路不混（层级：先外部后内部）。
- **带间连接可指向「整组外框」**：`edges[].from`/`to` 除节点 id 外，也可写 `groups[].id`——此时锚定到该组**外框**（源组底心 → 目标组顶心，居中直下），契合「上一层整体 → 下一层整体」的顺序流；组内顺序由带内水平边表达。**扇出/扇入**（一对多、多对一且目标各异）仍写节点 id，不要用整组端点。

**列心漂移规律**（`route_rhythm` 微段/`label_route_clearance` 差之毫厘的根因）：

「上层 → 下层」边的中段横移量 = 两端节点**列心之差**。而一行的列心由该行**整体居中**决定，所以**改某节点自身宽度不会移动它的列心**——列心差只取决于**同行其余节点**的宽度差。并列行（如三路并联）中间节点的偏移 = `(左节点宽 − 右节点宽) / 2`。

要消掉 < 16px 的抖动段，二选一：把同行另一侧节点标签宽度调成**同构（差为 0）**，或让差值 **≥ 32px**（偏移 ≥ 16px）。用 `estimateTextWidth()` 先算盒宽再定文案，不要靠肉眼试。

布局器保证：
- 节点两两间距 ≥ 8px（`node_overlap`）；
- 边首尾段垂直于端点 `fromSide/toSide`（`orthogonal_arrows`）；
- 标签与任何边/盒子净空 ≥ 14px（`label_route_clearance`）。

---

## 5. 创作不变量

1. 一条清晰主路径。
2. 节点 ≤ 24，超限必须拆图。
3. 边标签是语义数据，不能随便删。
4. 先删低价值边，再上分组/布局疏解。
5. 不为通过检查而改语义。

## 6. 修复优先级（先动什么后动什么）

检查项失败时，**按以下顺序**定点修复，避免在错误层级反复横跳：

1. **schema 层**（`validateSchema` 诊断）：先修 JSON 结构/字段类型/枚举/必填——这是根因，结构错后面全错。
2. **构图 12 项**（按影响面从大到小）：
   1. `finite_svg` —— 出现 NaN/Infinity，通常是 IR 缺字段导致布局器算崩。
   2. `entity_coverage` —— IR 声明的节点/边未出现在产物里（静默丢弃）→ 核对 `node.stage` 与边端点 id。
   3. `node_overlap` —— 节点太多/分组太挤 → 拆组、减节点、或拆图。
   3b. `node_text_in_box` —— 文字锚点跑出盒子（色块空、文字错位）→ 回查 layout 里所有坐标变换是否同步处理了 `cx/cy`。
   3c. `text_not_truncated` —— 文案被截断成 `…` → 改文案或拆节点，不要调大盒宽。
   4. `relationship_crossings` —— 边穿越无关节点 → 改边起止、加分组、调布局。
   5. `label_route_clearance` —— 标签太挤 → 缩短标签文案 / 调整（靠布局器，必要时减边）。
   6. `orthogonal_arrows` / `relationship_corridors` / `container_border_runs` / `route_rhythm` —— 路由质量问题，优先通过删冗余边、加分组解决。
   7. `legend_clearance` —— 图例压节点 → 布局器自动避让，异常时减节点或调 `viewBox`。
3. **文档集成专项**（常见修复项，完整清单见 `diagram-contract.md` §3.2）：
   - `no_ascii` / `no_base64` —— 产物层，渲染器已保证零残留；若触发说明渲染器被改，回查 `lib/render.mjs`。
   - `text_no_stroke` —— 文字被 role 色描边污染（字发蓝/发紫/发糊）→ 回查 `lib/theme.mjs` 是否保留 `text { stroke: none; }`。
   - `ref_reachable` —— 文档目录相对引用缺失，补图或改 Markdown 引用。
   - `caption_present` —— 补 `meta.caption` 为 `图 X-N · 标题` 格式。
   - `theme_readable` —— 对比度不足，回查 `role` 选用与 `lib/theme.mjs` token。
   - `variant_parity` —— 仅 `--variant-pair` 启用，多版本目录图数量/文件名对齐。

> 每轮修复后重跑 `validate --quality showcase`，记录失败数；连续两轮未降低 → 停止并如实报告（见 SKILL.md 有界重试）。
