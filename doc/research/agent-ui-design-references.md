# UI 设计语言参考：Apple HIG / Fluent 2 / Harness 官方 token（2026-09-14）

**为什么这个文件存在**：用户要求「设置界面和 tab 界面进行参考苹果/windows 官方 UI/harness 官方设计语音——做到简洁高效美观，而不是现在的臃肿」。

本文件把三方设计语言的**可执行约束**抽出来，作为 `lib/client.cjs` 与 `lib/settings-page.js` 改造的依据。

> 口径：Apple / Fluent 条目来自官方文档（给链接）；Harness token 来自**本机已装包的实测提取**（命令见 §3）。

抓取时间：2026-09-14。

---

## 1. Apple HIG：可执行约束

来源：[Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[Layout](https://developer.apple.com/design/human-interface-guidelines/layout)。

| 官方原文（要点） | 落成本项目的具体约束 |
| --- | --- |
| 「In general, show **no more than two levels of hierarchy** in a sidebar.」 | 设置页最多两层：分组 → 行。**删除卡片内嵌卡片**。 |
| 「If you need to include two levels... use **succinct, descriptive labels**... omit unnecessary words.」 | 行标签收紧到 96px（现 128px）；「账户与登录管理」→「账户」等。 |
| 「**Avoid putting critical information or actions at the bottom** of a sidebar.」 | 构建指纹、诊断类信息**下移或折叠**，不放首屏底部作关键项。 |
| 「**Group related items**... use negative space, container shapes, or separator lines.」 | 分组优先用间距；**删除 `.hwb-row` 的 border-bottom**。 |
| 「Use **progressive disclosure** to make layouts cleaner... reduce how much content to initially display.」 | 设置页 7 卡 → 4 组，其中 2 组默认折叠。 |
| 「**Order content by relative importance**... most important items near the top and leading side.」 | 账户（最常动）在最上；提示词全文（最少动）收进「高级」。 |
| 「Make sure any sidebar icon colors you choose **serve a clear purpose**.」 | 状态色只用于状态；**颜色不得是唯一信息载体**（必须有 title/aria-label）。 |
| 「**Align objects centrally and align text left.**」 | 头像/色点垂直居中，文字左对齐。 |

---

## 2. Fluent 2：间距阶梯（照抄全表）

来源：[Fluent 2 Layout](https://fluent2.microsoft.design/layout)。

官方原文：「The base unit is **four pixels**」「The global spacing ramp is multi-platform」

| Token | 值 (px) |
| --- | --- |
| sizeNone | 0 |
| size20 | 2 |
| size40 | 4 |
| size60 | 6 |
| size80 | 8 |
| size100 | 10 |
| size120 | 12 |
| size160 | 16 |
| size200 | 20 |
| size240 | 24 |
| size280 | 28 |
| size320 | 32 |
| size360 | 36 |
| size400 | 40 |
| size480 | 48 |
| size520 | 52 |
| size560 | 56 |

关键原文两条（直接决定改造方向）：

1. 「Space is used to denote groups of associated information. Used correctly, spacing creates logical sections of content on a page **without having to use lines** or other graphical elements as a divider.」
   → **删线，用间距**。
2. 「when creating lists, **adjust spacers to left align text and center align icons**」
   → 图标/头像垂直居中，文字左对齐，**不机械套同一 spacer**。

断点（用于窄面板判断）：small 320–479 / medium 480–639 / large 640–1023 / x-large 1024–1365。

---

## 3. Harness 官方 token（实测提取）

**提取方式**（可复核）：扫描已装 `dsh-client-ui-theme` 包内所有 `*.js` / `*.d.ts`，正则 `--dsw-alias-[a-z0-9-]+` 去重。

```powershell
$base = 'C:\Users\rsyhn\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
$t = Join-Path $base 'dsh-client-ui-theme'
Get-ChildItem $t -Recurse -File -Include *.js,*.d.ts |
  Select-String -Pattern '\-\-dsw-alias-[a-z0-9-]+' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Sort-Object -Unique
```

### 3.1 本项目允许使用的 token 清单

**背景**
- `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1`、`--dsw-alias-bg-layer-2`、`--dsw-alias-bg-layer-3`
- `--dsw-alias-bg-overlay`、`--dsw-alias-bg-mask-1`、`--dsw-alias-bg-mask-2`、`--dsw-alias-bg-mask-3`
- `--dsw-alias-bg-skeleton`、`--dsw-alias-bg-multi-select`

**边框**
- `--dsw-alias-border-l1`、`--dsw-alias-border-l2`、`--dsw-alias-border-l3`、`--dsw-alias-border-l4`
- `--dsw-alias-border-inverted`、`--dsw-alias-border-inverted2`

**文字**
- `--dsw-alias-label-primary`、`--dsw-alias-label-secondary`、`--dsw-alias-label-tertiary`、`--dsw-alias-label-caption`、`--dsw-alias-label-dimmed`

**状态**
- `--dsw-alias-state-success-primary`
- `--dsw-alias-state-error-primary`

**交互**
- `--dsw-alias-interactive-bg-hover`、`--dsw-alias-interactive-bg-active`
- `--dsw-alias-button-primary-fill`、`--dsw-alias-button-primary-hover`、`--dsw-alias-button-primary-dimmed`
- `--dsw-alias-button-ghost-active-fill`、`--dsw-alias-button-ghost-active-border`
- `--dsw-alias-button-tool-bar-fill`、`--dsw-alias-button-tool-bar-hover`
- `--dsw-alias-button-elevated-fill`、`--dsw-alias-button-floating-fill`、`--dsw-alias-button-floating-hover`
- `--dsw-alias-button-contrast-fill`、`--dsw-alias-button-info-fill`、`--dsw-alias-button-info-hover`

**品牌**
- `--dsw-alias-brand-primary`、`--dsw-alias-brand-text`

### 3.2 硬约束

1. **不新增任何硬编码色值**。所有颜色从上面清单取，且必须带 fallback（`var(--token, #fallback)`）——因为 token 由宿主注入，独立运行（standalone relay）时可能不存在。
2. **不新增 token 名**。要用新语义时先确认官方包里有；没有就用最接近的现有 token，不自己造一个 `--dsw-alias-xxx`。
3. 现有 CSS 已经在用这批 token（0.14.5 起），改造是**收敛**而非引入新体系。

---

## 4. 三方如何合成一套具体数值

| 项 | 取值 | 依据 |
| --- | --- | --- |
| 基础间距 | 4px | Fluent 基础单位 |
| 行垂直内边距 | 8px | 4 的倍数；从现 12px 收紧 |
| 行间距（分组内） | 8px | 4 的倍数 |
| 分区间距 | 16px | Fluent size160 |
| 卡片圆角 | 12px | 从现 16px 收紧（Apple「简洁」取向） |
| 控件高度（行内按钮） | 28px | 现实测值，保持（Apple 最小触达） |
| 图标按钮 | 28×28 | 同上 |
| 账户头像 | 28×28 圆 | 与图标按钮同尺寸，视觉对齐 |
| 标签列宽 | 96px | Apple「omit unnecessary words」 |
| 状态点 | 8px | 现实测值，保持 |
| 站点 pill 高 | 24px | 从 26px 收紧 |

---

## 4.5 外部 agent 面板 / 任务板参考（形态依据，非样式来源）

样式只从 §1–§3 取；下面这几条提供的是**信息架构**依据。

### Claude Code 的 teammate 面板（[官方文档](https://code.claude.com/docs/en/agent-teams)）

逐字事实，直接影响本项目的 team 面板设计：

- 「**Up and down arrows**: select a teammate；**Enter**: open the selected teammate's transcript and message it directly；**Escape**: clear the selection」
- 「an idle teammate's row **stays in the panel while any teammate or subagent is still working**」
- 「Once every agent in the panel is idle, idle rows **hide after 30 seconds** and reappear on the teammate's next turn; the teammate **stays running and addressable while hidden**」
- 「When more than three teammates are idle at once, the rows beyond the first three **collapse into a single row** that counts the collapsed teammates, such as `2 idle agents`」
- 「Working teammates, **failed teammates**, and the teammate you're viewing **always keep their own rows**」

对本项目的含义（**本报推断**）：

1. **工作/失败/正在查看的行永不隐藏**——隐藏规则只作用于 idle。这是「不能让用户找不到正在跑的东西」的具体化。
2. **idle 折叠是计数行**，不是消失——与 Apple「渐进披露」同向。
3. `Enter` 进入某个 teammate 的 transcript ⇒ 面板需要「选中态」概念，不是纯列表。

### 子代理与 Team 的分离（这是用户明确要求的那条）

官方文档的对比表（§1.2 已引）给出的**结构性差异**：

- 子代理：结果**回报给调用方** → 在 UI 上应当**从属于发起它的会话**（缩进层级）。
- Team：成员**互相发消息**、共享任务板 → 在 UI 上应当**平级**（同一层级的一行）。

→ 本项目右栏 team 标签页内部因此分两个区，且子代理区**缩进在本会话之下**，Team 区**平级**。

### `agent-teams-ai`（[GitHub](https://github.com/777genius/agent-teams-ai)，2.1k star）

外部项目（**未 clone 到 `reference/`**，故不进 `reference-projects.md`）。提供的信息架构参考：

- 「You just watch the **kanban board** and give high-level commands」——用户角色是「看板 + 高层指令」。
- 仓库结构含 `agent-teams-controller`、`mcp-server`、`packages/agent-graph`，并有 `TeamListView` / `ActivityItem` / `DashboardView` 组件（commit message 可证）。
- 其任务板语义与官方一致：**依赖转换**、**blocked 任务不可执行/完成**、**完成通知**。

对本项目的含义：本项目的 team 面板第一版**只读**，但任务板要显示**依赖与 blocked 状态**，否则用户看不出「为什么这个任务没动」。

---

## 5. 不做什么

- **不引入第三方 UI 库**（Vuetify / MUI 等）——本项目是单文件 `client.cjs` bundle，引入库会让产物膨胀数倍。
- **不做主题自研**——宿主主题 token 已经覆盖亮/暗两套，自研必然与宿主打架。
- **不改键盘漫游**（`onTabKey`）——那是既有可访问性成果，属于「不要为了美观丢掉信息」的反面。
- **不用颜色作为唯一状态载体**——这是本轮新增头像时最容易犯的错，测试里用反向断言钉住。

---

本文件是调研记录，**不是运行链路的一部分**；改删本文件不影响任何行为。
