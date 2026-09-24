# v2svg 设计系统（固定风格 · fewshot）

> 目的：让同一套图在不同文档里**长得一样**，并让 IR 一次写对、少走返工。
> 本文是**约定**，不是新机制——所有约束都用既有 IR 字段表达。

---

## 1. 语义配色：先定「域」，再映射 role

颜色是**语义**，不是装饰。先想清楚图里有几个「域」，再把每个域映射到固定 role：

| 业务域 | role | 色系 | 典型节点 |
|:---|:---|:---|:---|
| 数据域 / 可查询实体 | `interaction` | 蓝 | User / Order / Article |
| 规则域 / 编排 / 状态 | `control` | 紫 | Router / Workflow / Policy |
| 能力域 / 组件 / 外部系统 | `capability` | 绿 | Search / MQ / ObjectStorage |
| 约束 / 拦截 / 失败路径 | `warn` | 橙红 | RateLimit / Guard / 降级出口 |
| 中性说明 | `neutral` | 灰 | 日志 / 缓存 / 工具类 |

**一条图内同一语义只用一种 role**，不要「这个实体用蓝、那个实体用绿」。
分组框（`groups[].role`）取该域的主色；节点 role 与所属域一致。

### 1.1 色阶：浅填充 + 深描边 + 更深文字

每个 role 是一把**同一色相的三档梯子**（`lib/theme.mjs` 的 `TOKENS`）：

| 用途 | 取色 | 例子（control 紫） |
|:---|:---|:---|
| 节点填充 | 50 级极浅（亮色） | `#fdf4ff` |
| **节点描边** | **600 级深色** | `#7e22ce` |
| 文字（若用 role 色） | 600 级深色 | `#7e22ce` |

> ⚠️ **节点描边必须取 600 级**。历史上的描边是 400–500 级饱和色（如 `#a855f7`），
> 实测「描边 vs 画布 `#f8fafc`」对比度只有 **2.18–3.78**，卡片轮廓立不起来、放大后发飘。
> 亮色下 5 个 role 的节点描边**直接复用其 600 级文字色**（不新增色值），实测对比度：
>
> | role | 描边 | vs 画布 |
> |:---|:---|---:|
> | control | `#7e22ce` | 6.67 |
> | capability | `#166534` | 6.81 |
> | interaction | `#1e40af` | 8.34 |
> | warn | `#b91c1c` | 6.18 |
> | neutral | `#334155` | 9.90 |
>
> 暗色节点描边沿用原有暗色 role stroke，不动。

**组框（容器）走另一档**：`frames[].role` 会被渲染成 `class="frame frame-{role}"`，
但**最外层容器用「最浅填充 + 浅描边」，只有内层节点才用 600 级强调色**。

- **填充** = 该 role 的 `fill` 向 `panel`（亮色 `#ffffff`，即 `--panel`）混 **50%**；
  混色在生成 CSS 变量处用代码算出（`theme.mjs` 的 `frameFill()`），不手写 5 个新 hex。
  亮色实测值：control `#fbf7fe` / capability `#f4fcf8` / interaction `#f4f8fe` /
  warn `#fbf6f7` / neutral `#fcfdfe`。
  暗色 = 该 role 暗色 `fill` 降到 **alpha 0.10** 的半透明域色（低于节点的 0.16–0.18）。
- **描边** = **沿用 `.frame` 原有的 `--panel-border`（浅色）**，不新造 token、不用 600 级。

> ⚠️ **为什么组框描边不能用 600 级**：v2svg 约定「**节点 role 与所属域一致**」，
> 所以节点常与它所在的带同 role。若带与节点的描边都用 600 级、填充又都接近白色，
> 节点在自己的带里就**几乎看不出来**（实测 order-system / ci-pipeline / sync-async-compare
> 都属于这种同 role 嵌套）。向 `panel` 混色（而非向画布混）保证带头**恒比同 role 节点填充亮**
> —— `panel` 是亮度上界，任何 role 下节点都在带内可见；向画布混会在 `neutral`
> （其 `fill` 恰等于画布色）上退化成「带 = 节点 = 页面」三色同值。

护栏：`tests/invariants.test.mjs` 有两条**「不等于」断言**（不是感知阈值断言，只保证值不塌缩）：
对每个 role、明暗两套，`frameFill(role) !== role.fill`（带 ≠ 同域节点）且
`frameFill(role) !== canvas`（带 ≠ 页面）。「同 role 的带填充与节点填充肉眼可分」由
headless 浏览器实测佐证（§2.3）。

---

## 2. 文案规范（信息密度靠文案，不靠堆节点）

| 位置 | 写法 | 例子 |
|:---|:---|:---|
| 节点 `label` | **英文名 + 中文名**（技术图可只留英文） | `Article 文章` |
| 节点 `sublabel` | **规模 / 角色 / 关键属性**，≤ 18 字 | `3 千篇 · 锚点` |
| 边 `label` | **关系名 · 一句话说明**（说明可省，关系名不省） | `APPLIES_TO · scope=文章 指向文章` |
| `meta.title` | 图名，**不带序号** | `内容平台数据模型` |
| `meta.caption` | `图 X-N · 图名（口径/用途）`——**会渲染在底部** | `图 5-2 · …（6 类节点 · 7 类关系边）` |

底线：**删标签 = 删信息**。`label` 是语义数据，不是注释。

### 2.1 字级与线宽（固定值，不要逐图调）

**唯一出处是 `lib/typography.mjs` 的 `TYPE_SCALE` / `STROKE`**，本表是它的可读副本。
`svg doctor` 会断言本表与代码常量一致——改任意一边而忘记同步，doctor 立刻变红。

| 元素 | 字号 / 字重 |
|:---|:---|
| 主标题 | 24px，weight 700 |
| **节点标题** | **16px，weight 700**（近黑 `--text`，不用 role 同色——会同色系顺色发虚） |
| 节点副标签 | 12px |
| 边标签 | 12px |
| 组框标签 | 13px，weight 700 |
| 图例 | 12px |
| 连线 | `stroke-width: 2` |

> 💡 **改字号只需改一处**：`lib/typography.mjs` 的 `TYPE_SCALE`。
> 因 `theme.mjs`（CSS）、`layout.mjs`（盒宽/盒高估算）、`checks/composition.mjs`（标签矩形）、
> `render.mjs`（绘制）**全部从该表取值**，不再各自硬编码。
> 改完跑 `node bin/svg.mjs test` + `node bin/svg.mjs doctor`，
> 再跑一次渲染级校验（见 2.3）。

---

## 2.2 字宽标定：盒宽是**估算**出来的，不是量出来的

布局器在放盒子之前就要知道文字有多宽，所以宽度必须**估算**。估算的系数是实测标定的，
不是猜的：

| 字符类别 | 系数（em） | 实测区间 |
|:---|---:|:---|
| CJK 表意文字 / 全角标点 | **0.99** | 0.952–0.993 |
| `0`–`9` | 0.62 | 0.586–0.651 |
| `A`–`Z` | 0.68 | 0.656–0.710 |
| `a`–`z` | 0.54 | 0.510–0.573 |
| ASCII 标点 | 0.44 | 0.387–0.473 |
| 空格 | 0.26 | 0.211–0.281 |
| 其它 | 0.55 | — |

**实测口径**：headless Chromium + `getComputedTextLength()`，`system-ui` 字体族，
按 v2svg 实际用到的字号/字重逐类取样（脚本：`tests/calibrate-text-metrics.tool.mjs`）。
在 7 个真实文案样本上，本表**最大绝对误差 4.8%**；改之前的单一「CJK 1.0 / 其余 0.55」
为 10.6%。

> ⚠️ 已测且**不要再试**：在分类系数之上再叠一个「字重放大系数（700/400）」，
> 会把混合文本的误差从 4.8% 放大到 9.4%。分类系数已吸收字重的平均效应，勿重复补偿。

**盒宽公式**（`lib/layout.mjs` 的 `boxSize`）：

```
可用内宽 = BOX.maxWidth − 2 × BOX.padX          # 240 − 28 = 212
折行阈值 = 可用内宽
盒宽     = clamp(max(各行估算宽) + 2 × BOX.padX, BOX.minWidth, BOX.maxWidth)
盒高     = 行数 ≤ 1 ? BOX.heightSingle : BOX.heightDouble + (行数 − 2) × BOX.lineHeight
```

**系统性地消掉了「宽度溢出」这一类问题**：因为折行判定与盒宽推导用的是同一个估算函数与
同一套常量，文字不可能因为估算而被挤到盒外（只有估算本身失准时才会，见 2.3 的兜底）。

### 2.3 渲染级验证（改了度量/排版/渲染后必做）

内建检查全部基于**估算值**，无法证伪估算本身。真正的裁判是浏览器：

```bash
# 需可解析 playwright：把含 playwright 的 node_modules 交给 NODE_PATH（或已安装在依赖树中）
NODE_PATH=/path/to/node_modules \
node tests/verify-rendered-svg.tool.mjs          # 不给参数则校验 samples/*.svg
```

它用真实 `getBBox()` 比对「盒内文字 vs 盒矩形」「边标签 bbox vs 背景遮罩」，
容差默认 0（必须完全在框内）。**2026-09-12 首次接入时实测出 34 处越界**，
修复后为 0 —— 这两类缺陷此前在所有检查项里都是不可见的：

| 曾经的缺陷 | 现象 | 根因 |
|:---|:---|:---|
| 边标签遮罩宽不足 | 遮罩比文字窄 ~8%，连线从字缝透出 | `render.mjs` 自持一份系数且按 **11px** 估算，而 layout/checks 按 12px |
| 文字探出遮罩下沿 | 稳定漏出 3.5px | `.edge-label` 已有 `dominant-baseline: central`，渲染侧却仍额外 `+3px` |

---

## 2.4 文案与折行的其余约定

> ⚠️ **文本必须 `stroke: none`（已由 `text { stroke: none; }` 兜底）**：
> role 的描边定义在分组 `<g class="role-*">` 上，而 **SVG 中 `g` 的 `stroke` 会被子元素继承**。
> 文字类若只覆盖 `fill` 不覆盖 `stroke`，近黑字就会被套上 role 色 1px 描边——
> 观感是「文字发蓝/发紫、发糊、发虚」，且**所有检查项都查不出来**（`theme_readable` 只看 fill 对比度）。
> 另注：节点卡片描边取 600 级深色、而组框走「浅填充 + 浅描边」的另一档，色阶与组框着域色的规则见 §1.1。

> 📐 **超长文案自动折行**（盒宽上限 240 → 行宽上限 212，**每段最多 2 行**）：
> 节点标题/副标签超过行宽上限时折行（`lib/text-metrics.mjs` 的 `wrapTextDetailed`）：**贪心填满容器宽**
> （不提前折，否则会多占一行高度）；CJK 逐字断、拉丁按空格断、单个超长词硬断；
> **超过 2 行即截断、末行加 `…`**。盒高按行数计：1 行 42、2 行 58、每多 1 行 +18（`BOX.lineHeight`）。
> **同组卡片等高**：组内取最大行数的高度逐卡统一——卡片整齐，且共享同一 `cy`
> （否则带内水平直连边会因行高不一出现 <16px 竖段，触发 `route_rhythm`）。
> 🚫 **截断会被 `text_not_truncated` 拦下**：截断 = 信息丢失，与「删标签 = 删信息」的底线冲突。
> 正确修法是**改文案或拆节点**，不是调大盒宽（240 上限是有意为之）。
> 排查同类问题的正确姿势：用 Playwright 读 `getComputedStyle(el).fill` **和 `.stroke`**，别只看 fill。

---

## 3. 布局三原则

1. **一图一主干**：读者 3 秒能跟出主路径；辅助信息不抢戏。
2. **分组即分层**：`groups` 每个 group 是一条横带（自上而下）；**未分组节点会被塞进最后一条附加带**——要控制流向，就显式给入口/出口建 group。
3. **画布自动贴合**：`viewBox` 只是「行内舒展宽度提示」，成品画布会自动裁到内容边界（含图例）。**不要靠调大 viewBox 制造留白**。

节点数 > 4 就分组；单图 ≤ 24 节点；分组内节点 ≤ 4 个。

### 3.1 画幅体检（出图后必做，30 秒）

**判据**：图最终会按「文档正文宽度」缩放（飞书 / Obsidian / Markdown 约 **700px**）。
因此不写死「画布 ≤ 1000px」，而是**按字级定展示字号下限**：

| 字级 | 字号 | 700px 展示下限 | 是否入断言 |
|:---|:---:|:---:|:---|
| 节点标题（`.n-label`） | 16px | ≥ 11px | ✅ `min_font_size` |
| 组框标签（`.frame-label`） | 13px | ≥ 10px | ✅ `min_font_size` |
| 副标签 / 边标签（`.n-sub` / `.edge-label`） | 12px | ≥ 9px | ❌ 仅记录现状取舍 |

**画布宽上限 = 700 × 字号 / 下限**：节点标题 → ≤ 1018px；组框标签 → ≤ 910px。
即 `画布宽度` 一旦超过约 **1000px**，节点标题的展示字号就会跌破 11px。
（副标签 / 边标签 12px 按此折算在现网最宽 880px 下仅 9.5~10.7px —— 这是长期存在的现状取舍，
故 `min_font_size` **不为它们设断言**，只在 details 里正向记录。）

#### 适用边界（关键：**字号下限是硬判据，比例不是**）

| 判据 | 适用类型 | 性质 |
|:---|:---|:---|
| **展示字号 ≥ 下限**（上表） | **全部类型** | **硬判据** —— `min_font_size` 断言它 |
| 画布宽 ≤ ~1000px | 全部类型 | 由上一条派生（节点标题 16px × 700/下限 = 1018px） |
| **比例收敛到 1.0 ~ 1.6** | **仅常规分层图**（多横带 architecture / stages 分列 flow） | **软判据** —— 无断言，是"图被撑坏了"的信号 |

**哪些类型不必套比例**（实测 `samples/` 5 张里 3 张在此列，均属正常，不是缺陷）：

- `flow` 的 **非 stages** 模式是**逐层自上而下**：层数决定高度，天然高瘦（`alert-triage` 6 节点 5 层 → 0.55）。
- `flow` 的 **stages** 模式是横向分列：阶段越多越宽扁（`ci-pipeline` 4 阶段 → 2.46）。
- `architecture` 的**并列对比**是两条长横带：天然宽扁（`sync-async-compare` → 1.92）。
- `sequence` 由参与者数（宽）与消息数（高）共同决定，与"分层"无关。

这些类型的比例是**内容的函数**，硬套区间只会逼你去裁剪语义。

#### 超限了怎么改（只对分层图）

| 症状 | 处理 |
|:---|:---|
| 画布过宽（节点标题展示 < 11px） | 单带节点 > 4 就按语义拆成两条带（例：调用链按「请求方向 / 回程方向」拆，既收窄又更贴合分层叙事） |
| 画布过高（比例 < 0.8） | 把 1~2 节点的碎带合并（例：把 6 条步骤带合并成 3 条阶段带） |
| 目标 | 比例收敛到 **1.0 ~ 1.6**；节点标题展示字号 ≥ 11px、组框标签 ≥ 10px |

一律**按语义拆带 / 合带**，不缩字号。

实测：8 张分层图按此体检后，比例由 0.42~3.09 收敛到 0.98~1.42，最宽 953px。

---

## 4. fewshot：可直接复制的完整 IR

> 场景：关系型数据模型（实体 + 带说明的关系边 + 域分层 + 底部口径）

```json
{
  "schema_version": 1,
  "type": "architecture",
  "meta": {
    "title": "内容平台数据模型",
    "caption": "图 5-2 · 内容平台数据模型（6 类节点 · 7 类关系边）",
    "locale": "zh-CN",
    "viewBox": [1100, 460]
  },
  "groups": [
    { "id": "data-domain", "label": "数据域 · 可查询实体", "role": "interaction" },
    { "id": "rule-domain", "label": "规则域 · 发布 / 推荐 / 治理", "role": "control" }
  ],
  "nodes": [
    { "id": "author", "label": "Author 作者", "sublabel": "120 位作者", "role": "interaction", "group": "data-domain" },
    { "id": "article", "label": "Article 文章", "sublabel": "3 千篇 · 锚点", "role": "interaction", "group": "data-domain" },
    { "id": "topic", "label": "Topic 专题", "sublabel": "18 个专题", "role": "interaction", "group": "data-domain" },
    { "id": "publish", "label": "PublishPolicy 发布", "sublabel": "6 条策略 · 锚点 · 带 note 边", "role": "control", "group": "rule-domain" },
    { "id": "rank", "label": "RankRule 推荐", "sublabel": "4 条排序 · 锚点", "role": "control", "group": "rule-domain" },
    { "id": "mod", "label": "Moderation 治理", "sublabel": "9 条治理规则", "role": "capability", "group": "rule-domain" }
  ],
  "edges": [
    { "from": "article", "to": "author", "label": "WRITTEN_BY · 文章由作者撰写", "kind": "data" },
    { "from": "article", "to": "topic", "label": "BELONGS_TO · 文章归属专题", "kind": "data" },
    { "from": "publish", "to": "article", "label": "APPLIES_TO · scope=文章 指向文章", "kind": "sync" },
    { "from": "publish", "to": "topic", "label": "OFFSETS · 专题置顶抵扣常规流", "kind": "sync" },
    { "from": "rank", "to": "publish", "label": "ENTITLES · 排序加权", "kind": "sync" },
    { "from": "topic", "to": "mod", "label": "GOVERNED_BY · 专题受治理约束", "kind": "data" }
  ]
}
```

**这张例子为什么这样写**（照抄这几条就能少返工）：

- **先定域再上色**：数据域=蓝（interaction）、规则域=紫（control）、治理规则=绿（capability）——同一个「域」内的节点 role 一致。
- **两个 group 就是两行**：数据域在上、规则域在下；`article → author/topic` 在同带内，`topic → mod` 向下走一带，都不跨行。
- **节点副标签给规模**（`3 千篇 · 锚点`），读者不必回正文找数量。
- **边标签带说明**（`OFFSETS · 专题置顶抵扣常规流`），一条边自解释。
- **口径放 caption**：会渲染成底部图注，替代额外的「说明条」节点。

---

## 5. 出图前自检（6 条，30 秒）

1. 域 → role 的映射列出来了吗？（一域一色）
2. 每个 group 内部节点 ≤ 4？边是否只跨一到两条带？
3. 节点 `label` 是否有中文名？`sublabel` 是否给了规模/角色？
4. 边 `label` 是否带说明？有没有为了排版删过标签？
5. `meta.caption` 是否写成 `图 X-N · 名称（口径）`？
6. **有没有哪条文案被折成 `…`？**（`text_not_truncated` 会拦）——有就改文案或拆节点，别留着。
