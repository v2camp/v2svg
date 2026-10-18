# samples —— 成品样例画廊

每个样例一对文件：`.json` 为 IR 源（**唯一应修改的文件**），`.svg` 为渲染产物。

> 全部为 `--quality showcase` 档位（**28/28 项全过**），且**逐字节可复现** ——
> 渲染是确定性纯函数，同一份 IR 任何时候重跑都得到同一个文件（见「校验产物」）。

## 量级一览

| 样例 | 类型 · 变体 | 成品尺寸 | 比例 | 体积 | 节点 | 边 |
|:---|:---|:---:|:---:|:---:|:---:|:---:|
| `alert-triage` | flow · **决策树** | 348 × 618 | 0.56 | 8.5 KB | 6 | 5 |
| `ci-pipeline` | flow · **Pipeline（stages）** | 880 × 358 | 2.46 | 8.9 KB | 5 | 5 |
| `oauth-login` | sequence · 请求生命周期 | 786 × 670 | 1.17 | 9.1 KB | 4 | 10 |
| `order-system` | architecture · 分层图 | 648 × 560 | 1.16 | 10.0 KB | 8 | 7 |
| `sync-async-compare` | architecture · **并列对比** | 820 × 443 | 1.85 | 10.4 KB | 9 | 7 |
| **合计** | 3 类型 / 5 变体 | —— | —— | **46.9 KB** | 32 | 34 |

单张平均 **9.4 KB**，远低于 15 KB 的经验上限。

> **关于「比例」**：`references/design-system.md` 的画幅体检目标是 **1.0–1.6**，但它**只适用于常规分层图**
> （`order-system` 那种：几层横带、每带 ≤4 节点）。上表里 `ci-pipeline`（2.46）与 `alert-triage`（0.55）
> 超出该区间 —— **这不是缺陷，是类型本身的形态**：
>
> - `flow` 的 `stages` 是**横向分列**，阶段越多越宽扁；非 stages 是**逐层自上而下**，层越多越高瘦。
> - `architecture` 的并列对比是**两条长横带**，天然宽扁。
>
> 画幅体检给的是「这张图是不是被撑坏了」的信号，**不是所有类型都要满足的硬指标**。
> 真要收窄，手法是**按语义拆带/合带**，不是缩字号。

## 覆盖矩阵（演示要点）

| 样例 | 演示要点 |
|:---|:---|
| `order-system` | `groups` 三层分区、`role` 语义色板、data/sync/async 混合边 |
| `sync-async-compare` | 两个并列 `group` 表达同一业务的两种方案；`warn` 角色标记阻塞点 |
| `ci-pipeline` | 阶段带分列、`decision` 门禁、`fallback` 回边（QualityGate → Build） |
| `alert-triage` | 双层判定、三出口分级；`warn` / `interaction` / `neutral` 终态区分 |
| `oauth-login` | 授权码模式完整时序、`return` 消息类型、跨参与者往返 |

## 怎么用

### 预览

`*.svg` 可直接在浏览器 / 飞书 / Obsidian / GitHub 打开：单文件、内联样式、零 JS、
跟随 `prefers-color-scheme` 自动切换明暗。需要位图时用任意工具转一次即可。

### 改一张图

只改 `.json`，验证通过后再重渲染（`<type>` 取该样例的类型）：

```bash
cd /path/to/v2svg
node bin/svg.mjs validate architecture samples/order-system.architecture.json --quality showcase
node bin/svg.mjs render   architecture samples/order-system.architecture.json samples/order-system.svg --quality showcase
```

**验证不通过时 `render` 不产出文件**。回执会指出是哪条检查、哪个节点/边、实测多少、建议怎么修。

### 校验产物没被改坏

产物既然是确定性生成的，「重渲染后与入库文件逐字节一致」就是最强的回归判据：

```bash
cd /path/to/v2svg
node bin/svg.mjs render architecture samples/order-system.architecture.json /tmp/check.svg --quality showcase
cmp samples/order-system.svg /tmp/check.svg && echo "✅ 逐字节一致"
```

不一致只有两种可能：**你的改动真的影响了渲染**（那就该连产物一起提交），或**产物过期**
（重新渲染并提交）。提交前请查清是哪一种。

## 与 examples/ 的关系

`examples/` 是**最小可读**的 IR 示例（Schema 对照用，不含渲染产物）；`samples/` 是**成品级**样例
（完整语义 + 已渲染 SVG），可直接嵌入文档或作为创作起点复制修改。

创作新图时建议：先照 `examples/<type>.json` 把骨架写对，再参照 `samples/` 里同类变体的写法补语义。

## 布局提示（来自实战）

flow 类型非 stages 模式下，**每行独立居中**。若「上层判定节点 → 下层首个节点」的
边出现 `route_rhythm` 失败（中段横移 < 16px），原因是两行的行宽不同导致列心漂移
（漂移量 = 行内其余节点宽度差的一半）。修复方法：调整**同层另一侧**节点的标签文本
宽度使两行对齐，或拉开到 ≥ 16px。参考 `alert-triage.flow.json` 中 `P0` / `P2`
标签同构（`P0 电话 + 拉群` / `P2 工单 + 邮件`）对齐列心的做法。
