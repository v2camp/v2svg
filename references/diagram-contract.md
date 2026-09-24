# v2svg 诊断与回执契约

Diagnostic 对象、Check 对象、27 项检查逐项说明、退出码表、回执 JSON schema。

---

## 1. Diagnostic 对象

schema 层（`validateSchema`）产出的诊断。携带 `subject` / `evidence` / `supportedFixes`，使 Agent 能**定点修复**。

```json
{
  "code": "layout/label-route-clearance",
  "severity": "error",
  "message": "标签 \"Document\" 与连线 edge-3 净空不足 15px（实测 2px）",
  "subject": { "type": "edge", "id": "edge-3", "pointer": "/edges/3" },
  "evidence": { "measured": 2, "threshold": 15 },
  "supportedFixes": ["将标签上移 6px", "缩短标签文案为 \"Doc\""]
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `code` | string | 诊断码，形如 `schema/required` / `layout/error` / `cli/type-mismatch` |
| `severity` | `"error"\|"warning"` | 严重度；当前 schema 校验均为 `error` |
| `message` | string | 人类可读中文说明 |
| `subject` | object | 定位信息：`pointer`（JSON Pointer）+ 最近的 `id` / `label` |
| `evidence` | object | 量化证据（实测值、阈值等），便于程序消费 |
| `supportedFixes` | string[] | 定点修复建议（可空数组） |

---

## 2. Check 对象

构图 / 文档集成检查产出。

```json
{ "name": "label_route_clearance", "ok": true, "details": ["全部 9 个标签与任何边/盒子净空 ≥ 14px"] }
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `name` | string | 检查项名（见 §3 枚举） |
| `ok` | boolean | 是否通过 |
| `details` | string[] | 通过时的正向说明，或失败时的逐条问题清单 |

> 跳过项（无上下文）必须 `ok:true` 且 `details[0]` 写明「跳过：<原因>」，**不允许静默通过**。

---

## 3. 27 项检查逐项说明

构图 12 项（8 项复用自研几何内核 `lib/geometry.mjs`，4 项为自研不变量）+ 文档集成专项 15 项。

> 名清单的**唯一出处**是 `COMPOSITION_CHECK_NAMES` / `DOCUMENT_CHECK_NAMES` / `STANDARD_DOCUMENT_CHECK_NAMES`
> （分别在两个 checks 模块里导出）。`svg doctor` 会断言本节各项数与代码一致。

### 3.1 构图 12 项

| 名称 | 检查什么 | 失败意味着 | 典型修法 |
|:---|:---|:---|:---|
| `finite_svg` | 所有坐标均为有限数（无 NaN/Infinity） | 布局器算出非有限坐标，通常 IR 缺字段 | 补 IR 必填字段 |
| `entity_coverage` | IR 声明的**每个节点/参与者**与**每条边/消息**都出现在产物里 | **静默丢弃**：`flow` 的 stages 模式下 `stage` 不匹配的节点不渲染；三种类型下端点不存在的边/消息被跳过 —— 图看着完整、拓扑却是错的，而既有检查都看不见（它们检查的正是丢弃之后的集合） | 核对 `node.stage` 是否匹配 `stages[].id`；核对边/消息两端 id 是否存在 |
| `node_overlap` | 节点两两不相交（gap≥8px） | 节点太挤/分组过密 | 拆组、减节点、拆图（≤24） |
| `node_text_in_box` | 每个 box 的文字锚点 (cx,cy) 落在盒内 | 坐标变换漏改 cx/cy → 色块与文字分离（画布会出现空色块） | 回查 layout 的坐标变换，须同时平移 cx/cy |
| `text_not_truncated` | 没有文案被折行上限截断成 `…` | 文案超 2 行上限，**信息被吃掉** | 缩短 label/sublabel，或拆成两个节点；不要调大盒宽绕过（240 是有意上限） |
| `relationship_crossings` | 边不穿越无关节点框 | 路由穿过无关节点 | 改边起止、加分组、调布局 |
| `label_route_clearance` | 边标签与任何边/盒子净空 ≥ 阈值（`EDGE_LABEL.clearance`，当前 15px） | 标签压线/压框 | 缩短标签、减冗余边 |
| `orthogonal_arrows` | 边首尾段垂直于其 fromSide/toSide | 箭头未正交 | 交由布局器修正；排查非法 kind |
| `relationship_corridors` | 无两条边共用无法区分的重叠走廊（overlap≥8px） | 两条边并行难分 | 改路由、删其一 |
| `container_border_runs` | 无边贴容器边框长距离平行走 | 边贴框伪装边界 | 改路由离开边框 |
| `route_rhythm` | 边转折节奏合理（无 <16px / <8px 过短段） | 路由抖动 | 删冗余边、加分组 |
| `legend_clearance` | 图例不压任何 box/容器（gap≥8px） | 图例压节点 | 减节点或调 viewBox |

### 3.2 文档集成专项 15 项

| 名称 | 检查什么 | 失败意味着 | 典型修法 |
|:---|:---|:---|:---|
| `no_ascii` | SVG 无 Box-drawing / ASCII 流程箭头残留 | 渲染了 ASCII 图 | 回查 `lib/render.mjs`（不应发生） |
| `no_base64` | SVG 无 `data:image/` 内嵌 | 内嵌了 base64 图片 | 改为外部相对引用 |
| `text_no_stroke` | 内联样式含 `text { stroke: none; }`，且无 `<text>` 带非 none 描边 | 文字被分组 role 色描边污染（发蓝/发紫/发糊），对比度类检查查不出 | 检查 `lib/theme.mjs` 的 baseCss 是否保留该规则 |
| `marker_contract` | 箭头 marker 三向闭合：`url(#x)` 引用都有定义、defs 里没有契约外的 marker、契约里的 marker 全部被定义 | 任一侧改名即**静默失效**（Chrome 对不可达引用不报错，只是不画箭头） | 改 `lib/markers.mjs` 的 `ARROW_MARKER_IDS` / `MARKER_SHAPES` / `EDGE_STYLE`，勿在别处硬编码 id |
| `svg_text_fits` | **产物级**：盒内文案估算宽 ≤ 盒可用内宽；遮罩宽高足以覆盖文案；且渲染字号 = `TYPE_SCALE` | 跨模块常量错位（如 theme 改了字号、render 用了另一个字号算遮罩 / 多算了偏移） | 对齐 `lib/typography.mjs` 与 `lib/theme.mjs`；再跑 `tests/verify-rendered-svg.tool.mjs` 复核 |
| `ref_reachable` | Markdown 的相对图片引用（`./` 或 `../`，svg/png/jpg/gif/webp）均存在 | 引用缺失 | 补图或修 Markdown 引用 |
| `caption_present` | `meta.caption` 形如 `图 X-N · 标题` 且图号不重复 | 图题缺失/格式错/图号重复 | 补 `meta.caption`；跨文件去重 |
| `theme_readable` | 用到的 role 在明/暗两套 token 下文字对比度 ≥ 4.5:1 | 配色对比度不足 | 回查 `role` 选用与 token |
| `variant_parity` | 多版本目录的 `images/*.svg` 文件名集合一致（仅 `--variant-pair` 启用） | 版本间图不对齐 | 对齐各版本图文件 |
| `content_within_canvas` | 所有 `rect` / `text` 都落在画布（root viewBox）之内 | **内容被画出画布**：画布宽只按「几何元素 + 边标签锚点」算，标题/图注这类**居中文字**的宽度完全不参与，最宽的边标签贴边时也会被切 —— 而此前没有任何检查测「元素是否在画布内」 | 修渲染/布局：画布边界必须计入**文本自身尺寸**（`lib/render.mjs` 的 `fitCanvasToCenteredText` / `lib/layout.mjs` 的标签矩形累加） |
| `svg_a11y` | 根 `<svg>` 具 `role="img"`，且 `<title>` / `<desc>` 是根元素的**首两个子元素** | 读屏软件只看到无标题图形（文档平台图片可访问性丢失） | 检查 `lib/render.mjs` 根标签那一行与首两子元素顺序 |
| `svg_hygiene` | 产物无 `<!--` 注释 / `linearGradient`·`radialGradient` / `<filter>` / `drop-shadow`·`blur` | 引入了扁平静态风格之外的装饰（注释残留、渐变、滤镜） | 移除对应元素；改样式时勿加渐变/阴影 |
| `weight_whitelist` | 产物实际声明的 `font-weight` 全部 ∈ 白名单 `{400, 700}` | 出现第三档字重，视觉层级漂移 | 回查 `lib/theme.mjs` 的 CSS 生成，只允许 400 / 700 |
| `role_budget` | 图中用到的 role 集合 ≤ 3；超过则 `meta.roleBudget` 须有 ≥ 8 字理由且 `roles` 清单覆盖全部实际 role | 语义域膨胀（配色失去区分度）；或声明与实际漂移（漏列 role） | 补 `meta.roleBudget`（reason + 显式 roles），或按下限收敛 role |
| `min_font_size` | **产物级**：节点标题（16px）与组框标签（13px）按 700px 展示时分别 ≥ 11px / ≥ 10px（画布宽上限 = 700 × 字号 / 下限） | 画布过宽，缩到正文宽后文字不可读 | 按语义拆带收窄画布，**不是缩字号** |

> `ref_reachable` 查的是 **Markdown 里的图片引用**；SVG **内部**的 `url(#id)` 引用可达性由
> `marker_contract` 负责。两者不同，勿混淆。

### 3.3 档位 → 检查项数

- `standard`：12 构图 + `no_ascii` + `no_base64` + `marker_contract` + `ref_reachable` + `svg_a11y` + `svg_hygiene` + `content_within_canvas` = **19 项**
- `showcase`：27 项**全过**

> **validate 与 render 跑的是同一批检查**：validate 也会先在内存里渲染一份产物，
> 故「validate 通过」即等价于「render 会通过」。历史上 validate 不渲染，
> no_ascii / no_base64 / text_no_stroke 在 validate 时被静默跳过，两者语义不一致。

### 3.4 文档口径断言（doctor 专项）

同类系统的真实事故是「设计指南是实现的**手工拷贝**」：文件头写着「如需升级请同步修改另一份
并重新拷贝」，于是两份必然漂移，而所有面向产物的检查都查不出来。v2svg 也出现过同类漂移
（本节曾写 `standard` 14 项而实际 13、`showcase 须 15/15` 而实际 17、阈值写 14px 而实际 15px）。

因此 `svg doctor` 有一项 **「docs 常量 ↔ 代码常量」**，把文档里的数值变成可断言的契约：

| 断言对象 | 与谁比对 |
|:---|:---|
| `design-system.md` §2.1 的 6 项字号 + 字重、连线线宽 | `TYPE_SCALE` / `STROKE` |
| 本文件 §3 / §3.1 / §3.2 / §3.3 的四组项数 | 三个 `*_CHECK_NAMES` 的长度 |
| `SKILL.md` 的「N 项机械检查」「standard = N 项」「showcase = N 项全过」「showcase 须 N/N」 | 同上 |
| `README.md` 的档位口径与「N 项机械检查」 | 同上 |

**找不到锚点按失败处理**（不允许静默跳过）：文档若被有意改写，必须同步更新
`bin/svg.mjs` 里的锚点表。这是有意的摩擦 —— 否则断言会悄悄退化成永真。

---

## 4. 退出码表

| 码 | 触发场景 |
|:---:|:---|
| `0` | doctor 全绿；validate 通过；render 通过并产出文件 |
| `1` | 验证失败：schema 不合法，或检查项有 `ok:false`（render 时**不写盘**） |
| `2` | 用法错误：未知命令、未知 `<type>`、`validateSchema` 之外输入层错误（文件缺失、JSON 解析失败）、`--quality` 非法 |

> `--json` 模式下错误信息也是 JSON：`{ "schemaVersion":1, "ok":false, "diagnostics":[...] }`。

---

## 5. 回执 JSON schema

`--json` 输出结构：

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "render",
  "type": "architecture",
  "input": "/abs/ir.json",
  "output": "/abs/out.svg",
  "checks": [
    { "name": "label_route_clearance", "ok": true, "details": [] }
  ],
  "composition": {
    "profile": "showcase",
    "status": "pass",
    "summary": { "total": 27, "passed": 27, "failed": 0 }
  },
  "artifact": { "bytes": 7809, "sha256": "2b00a5ee..." }
}
```

| 字段 | 类型 | 说明 |
|:---|:---|:---|
| `schemaVersion` | `1` | 回执契约版本 |
| `ok` | boolean | 整体是否通过（无诊断 + 检查全过） |
| `command` | string | `doctor`/`guide`/`validate`/`render`/`unknown` |
| `type` | string | 图类型（或 `null`） |
| `input` | string | 输入 IR 绝对路径 |
| `output` | string\|null | 产物路径；validate 为 `null`，render 失败为 `null` |
| `checks` | Check[] | 本档位跑的全部检查（含跳过项） |
| `composition.profile` | `"standard"\|"showcase"` | 档位 |
| `composition.status` | `"pass"\|"fail"` | 汇总状态 |
| `composition.summary` | `{total,passed,failed}` | 检查计数 |
| `artifact` | `{bytes,sha256}` | 仅 render 成功时存在；sha256 用 `node:crypto` |

错误回执（schema 失败 / 用法错误）：额外带 `diagnostics` 数组，`checks` 为空，`composition.status` 为 `fail`。

```json
{
  "schemaVersion": 1,
  "ok": false,
  "command": "validate",
  "type": "architecture",
  "input": "/abs/bad.json",
  "output": null,
  "checks": [],
  "composition": { "profile": null, "status": "fail", "summary": { "total": 0, "passed": 0, "failed": 0 } },
  "diagnostics": [
    { "code": "cli/usage", "severity": "error",
      "message": "输入不是合法 JSON：/abs/bad.json\n...",
      "subject": {}, "evidence": {}, "supportedFixes": [] }
  ]
}
```
