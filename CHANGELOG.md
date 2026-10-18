# 更新日志

## 0.3.0 - 2026-10-18

### 新增：`portrait_strip` 检查——flow 竖向长条机械拦截（构图 12 → 13 项，standard 19 → 20，showcase 27 → 28）

来源：课程文档复盘——竖向长条流程图嵌入竖排文档后两侧留白过大、破坏版面；「瘦高应改横向」此前只是约定，没有机械门禁。

- **`lib/checks/composition.mjs` 新增第 13 项构图检查 `portrait_strip`**：仅 `flow` 类型；成品高宽比 > 1.2 且节点 ≥ 4 时失败，失败文案直接指向修法（改 `layout: "horizontal"`）；豁免走 `meta.allowPortrait` ≥ 8 字理由（与 `roleBudget` 同套声明机制）。阈值 1.2 来自全仓盘点分布：>1.2 的全是主链长条、≤1.05 的为近方形，两类干净分开。决策树等纵向层级语义不在横向折行能力域内（分支会被压成单链、边穿盒），属正当豁免场景——`samples/alert-triage.flow.json` 即改为声明豁免的活的样例。
- **`schemas/common.schema.json`**：`meta.allowPortrait` 字段入契约（string，minLength 8）。
- **文档口径同步**：`diagram-contract.md` §3/§3.1/§3.3、`diagram-spec.md` §6 修复优先级第 8 条、`design-system.md` §3 第 4 条量化判据、`README`/`SKILL`/`samples/README` 项数；`SKILL.md` standard 档顺带补回漏列的 `content_within_canvas`（计数原本就是含它的 19）。
- 验证：`svg test` 50/50（新增四态用例：拦截 / 横向放行 / 小图放行 / 豁免放行）；`svg doctor` 通过；5 个样例 showcase 28/28（alert-triage 走豁免，产物逐字节不变）。

## 0.2.1 - 2026-10-18

### 修复：横排回边竖直段穿越无关盒

- **`lib/layout.mjs` `routeBackEdgeH`**：两端齐平布局把下方行的盒 justify 到回边竖直段上（实测 shop-14-8-node-dag 末行右端盒挡住 retry 进入段，`relationship_crossings` 失败）。回边两条竖直段（源下出 / 目标下入）的 x 从「死取盒中心」改为「在各自盒底缘宽度内自中心向两侧扫描，取首个不穿越任何无关盒的位置」；两端落点相距 <16px 时优先共轴统一，防 `route_rhythm` 短 interior。中心安全时行为与 0.2.0 逐字节一致（零 churn）；找不到安全位退回盒中心，由检查器暴露而非静默产坏图。
- **`references/design-system.md` §3 第 4 条**：补「回边竖直段在盒底缘内自动避让无关盒」的布局保证。
- 验证：`svg test` 49/49、`svg doctor` 通过；shop-14-8-node-dag showcase 27/27；全仓 20 张横向图复渲染，仅该图产物变化、其余 19 张逐字节不变。

## 0.2.0 - 2026-10-18

### 变更：S 型折行横排改为两端齐平布局

- **`lib/layout.mjs` flow/horizontal 分支**：行放置从「相邻行首末盒中心共轴」改为「每行最左盒左缘统一齐平、最右盒右缘统一齐平」；行内间隙在 `H_GAP`（标签净空下限）之上 justify 自适应拉宽；折回边锚点从盒中心改为齐平缘内缩 `min(两端盒宽)/2`，折回边仍保持直竖线。盒宽不同的图两端不再错位。
- **`references/design-system.md` §3**：新增第 4 条布局原则「S 型折行两端齐平」，并明确「不得手调坐标伪造对齐」。
- **版本建账**：补齐 `SKILL.md` frontmatter `version` 与本文件（骨架合规）；`package.json` 同步 0.1.8 → 0.2.0。0.1.x 历史从略，自本条目起记账。
- 验证：`svg test` 49/49、`svg doctor` 通过；3 张真实横向折行图（2 盒行 / 3 盒行 / 单盒行）showcase 27/27 复渲染核对。
