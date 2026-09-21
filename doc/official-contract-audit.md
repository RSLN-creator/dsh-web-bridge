# 官方契约审计（0.16.38）

> 用户要求：「将代码都对齐官方-做 renderer-v2 契约检查，以及别的我没注意到的官方有的要求/
> 代码质量对齐，文档写明记录，尽量不必要修改，然后合适现在代码结构--保持现在所有内容
> 实现不变」。
>
> 本文件记录**逐条核对结果与依据**。基准是本机实装的
> `@deepseek-ai/dsh@0.1.6-alpha.2`（`C:\Users\rsyhn\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）
> 与 `reference/deepseek-harness` 源码/文档。

## 0. 关于「renderer-v2」这个名字（如实结论）

在本机三处全树检索 `renderer-v2` / `rendererV2` / `renderer_v2`：

| 检索范围 | 命中 |
| --- | --- |
| `@deepseek-ai/dsh@0.1.6-alpha.2` 整棵已装包树（含 client 全家） | 0 |
| `reference/deepseek-harness` 的 `docs/` 与 `packages/` | 0 |
| 本仓库 `doc/` | 0 |

检索到的相近名字只有三类，**都不是** renderer-v2：

- `@deepseek-ai/dsh-client-ui-renderer` —— React 插槽渲染器本体（见它的 README：
  「the only package that binds bare observables through `useSyncExternalStore`」）。
- `dsh-session-format-v1-to-v2` / `v2-to-v3` —— **会话日志格式**的迁移边，与 UI 无关。
- `DshClientManifest` / 启动图的 `version: 3` —— 客户端模块图协议里的源映射版本。

结论：**本机不存在名为 renderer-v2 的契约**。用户已确认按「官方 client 插件契约」执行，
即下面第 1–8 条。这里如实记录，不臆造该名词，也不把某个东西改名成它。

## 1. `dsh.client` 声明（package.json）

| 项 | 要求（依据） | 现状 | 结论 |
| --- | --- | --- | --- |
| `platform` | 必须是 `'web'`（`docs/subsystems/client-modules.md` 第 77 行） | `'web'` | 合规 |
| `inject` | 可选的激活边；声明即「等这些服务就绪」 | `['slots','settingsScope','sidebarRightTabs','sidebarRight']` | 合规 |
| `external` | 基座（React / Cordis / 静态 UI 库）之外的精确模块请求 | 未声明 | 合规（只用基座 + primitives） |
| `exports['./client']` | 必须导出构建好的 bundle | `./lib/client.cjs` | 合规 |

## 2. 客户端 bundle 形状（懒 CJS）

要求（client-modules README.zh.md「惰性 CJS 模型」「插件动态组合」）：bundle 只
`window.__ModuleLoader__.load({id, factory})` 注册 factory，**模块副作用在 factory 闭包内**、
物化时才跑；不得同步 `require` 另一个相对 `client*.js` 产物。

现状：`lib/client.cjs` 是**单文件** bundle，`require` 只取 `react` / `react-dom/client` /
`@deepseek-ai/dsh-client-ui-primitives`（全是平台种子），无相对请求、无异步 chunk。**合规**。

## 3. 插槽契约（用 cordis_inspect 实读，不是推断）

| 槽 | 实读结果 | 本仓库用法 | 结论 |
| --- | --- | --- | --- |
| `settings.section` | `kind: list`，**`scope: root`** | 注册 `{id:'webcode', order:110, label}`，会话身份经官方 standard prop `useSessions` 取 | 合规（这正是 0.15.3 修掉的那个 bug） |
| `conversation.composer.dock` | `kind: list`，`scope: session`，owner 是 `conversation.composer.bar` | 注册 `{id:'webcode-wait', order:20}`，与官方 `lc/stats`（order 0）同排 | 合规 |
| `sidebar.panellist` | `kind: list`，`scope: root`；契约原文「Each list id addresses the matching main panel」 | 侧栏行 id 与 `main` 座位的 key **逐字相同**（`webcode-tasks-panel`） | 合规 |
| `main` | `kind: keyed`，官方默认占用 `conversation` | 用自有 key，不遮蔽对话 | 合规 |
| `sidebar.right.pane.tab` / `.title` | keyed，按定义 id 派发 | 三个 kind 各自注册正文/标题 | 合规 |
| `sidebar.right.tab.menu.item` | 契约原文「Entries decide their own visibility from the tab they are given」 | 菜单项按 `owner.tab.kind` 过滤，非网页标签返回 `null` | 合规 |

## 4. 主题 token

要求：只使用主题里**确实存在**的 `--dsw-*` token；缺 token 时不许臆造。

现状：本文件所有颜色/边框/背景都写成 `var(--dsw-*, <fallback>)` 形式。

本轮核对时对 `--dsw-alias-label-caption` 起过一次疑：`Theme.listTokens`（Client Inspect
Provider 实读）**没有列出**这个名字，于是先按「不存在」处理。随后去官方包里查证，结论反过来：

```
@deepseek-ai/dsh-client-ui-sidebar-terminal/lib/client.js
  .zjup-W_description{color:var(--dsw-alias-label-caption); …}
```

官方的「新建终端」胶囊说明行用的就是它——本仓库站点目录正是照那张胶囊抄的。因此：

- `Theme.listTokens` **不是** token 的全集（它列的是主题需要 light/dark 双写的那一批），
  不能拿它当「token 存在性」的唯一判据；
- 代码保持原样（`--dsw-alias-label-caption` 带上 `--dsw-alias-label-tertiary` 作二级回落），
  **不改**。

这条本身就是本文件存在的意义：一处「按 Provider 列表判定 token 不存在」的推断，若直接落到
代码上就是一次无谓的破坏性改动。

## 5. 可访问性与「颜色不是唯一载体」

| 要求 | 依据 | 现状 |
| --- | --- | --- |
| 状态必须「词 + 色」同时出现 | `doc/research/agent-ui-design-references.md` §1 | 状态词与色点成对渲染（账户头像、花名册、站点目录） |
| 药丸的 aria 契约 | 官方 `StatsPills` 用 `aria-haspopup="dialog"` + `aria-expanded` | 本仓库等待药丸逐字相同 |
| 关闭语义（Esc + 点外部） | 官方 `useDismissOnOutsidePointer` | 等价实现（本组件是独立 dock 条目、拿不到官方 state） |
| 图标按钮的可访问名 | 官方按钮惯例 | 每个图标按钮都带 `aria-label` + `title` |

## 6. primitives 解构必须带回退

依据：0.16.21 真机事故（无回退解构 + 测试桩缺导出 → 6 条渲染测试全崩、面板白屏）。

现状：`FishLogo` / `FISH_LOGO_PATH` / `FISH_LOGO_VIEWBOX` / `useDismissOnOutsidePointer` /
`Button` / `Menu` / `IconChevronDownOutline14` **全部**带回退（`|| (() => null)` 等）。**合规**。

## 7. 本地闸门（scripts/）

`node scripts/ci-local.mjs` 串起：注释闸门（`lint-comments`）、台账闸门（`check-ledger`，
版本与测试文件数两格）、仓库卫生（`check-repo-hygiene`：编码无 BOM + doc 索引无死链 +
engines 版本相容）、提交信息自检、reference 索引（`gen-reference-index --check`）、
生成物卫生（`artifacts-check`）、全量 `node --test`。

本轮全量结果见 `doc/progress.md` 的 0.16.38 段。

## 8. 与官方「改动最小」原则的对账

本轮**没有**改动的部分（用户明确要求「保持现在所有内容实现不变」）：

- 账号/登录底层与 `{siteId, slot}` 入参形状；
- 协议解析（`normalizeOfficialToolCalls` 与锚点扣留）；
- 右栏 iframe 镜像、独立窗口、站点探活；
- 任务板与 Team 面板的全部注册与数据面。
