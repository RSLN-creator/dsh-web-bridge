# 官方品牌图标资源调研（第三步 · 只讨论，未实施）

> 这份文档回答用户第三步的三个问题：**点击 Web Bridge 后先进一个一级选择框、再打开对应站点网址**能不能做、**能不能在一个 Web Bridge 下多开不同网址**、以及**网址图标如何用各站官方矢量透明底图标**。
>
> 本轮**没有**为第三步改任何代码（用户明确要求「第三步只讨论先别做」）。本文只记录调研结论与可直接落地的依据。

---

## 1. 站点清单

站点表来自 `lib/providers.js` 的声明与 `lib/client.cjs` 的 `SITE_NAMES`（两者必须一致，下面是逐字核对的结果）。

| site id | 显示名 | 主页 origin |
| --- | --- | --- |
| `deepseek` | DeepSeek 网页版 | https://chat.deepseek.com |
| `glm` | 智谱清言 (GLM) | https://chatglm.cn |
| `chatgpt` | ChatGPT 网页版 | https://chatgpt.com |
| `kimi` | Kimi (月之暗面) | https://www.kimi.com |
| `qwen` | 通义千问 (Qwen) | https://chat.qwen.ai |
| `doubao` | 豆包 | https://www.doubao.com |
| `grok` | Grok (xAI) | https://grok.com |
| `claude` | Claude (Anthropic) | https://claude.ai |
| `zai` | Z.ai | https://chat.z.ai |
| `gemini` | Gemini (Google) | https://gemini.google.com |

---

## 2. 本地已有资源（最权威，且已在磁盘上）

### 2.1 DeepSeek 官方鲸鱼 —— **已在依赖里，无需外部下载**

这是本次调研最重要的发现：**Harness 自己的官方 primitives 包就带着官方鲸鱼矢量路径**。

| 项 | 值 |
| --- | --- |
| 文件 | `@deepseek-ai/dsh-client-ui-primitives/lib/index.js`（本机约 2811–2833 行） |
| 导出 | `FISH_LOGO_PATH`、`FISH_LOGO_VIEWBOX`、`FishLogo` 组件 |
| viewBox | `23.16 × 17.04`（原生比例，宽高比 1.359） |
| 形态 | 单条 `<path>` 的填充路径，**矢量、透明底** |
| 消费者先例 | `@deepseek-ai/dsh-client-ui-brand-official/lib/client.js:15` 用它填 `sidebar.brand.mark` |

也就是说 DeepSeek 这一项可以同时满足「官方」「矢量」「透明底」三条硬要求，而且**零新增依赖、零新增资产文件**：

```js
const { FishLogo, FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } = require('@deepseek-ai/dsh-client-ui-primitives');
// 用法一：直接用组件（官方就是这么用的）
FishLogo({ size: 20 })
// 用法二：自己组 svg 时取路径（官方注释明说该常量「exported for consumers that compose their own svg」）
```

> 这条也是「官方优先」的最佳解：它不是第三方图标库复刻，而是 DeepSeek 自家产品线（DSH）随包发布的官方资产。

### 2.2 官方另有一套「站点标记」机制，但是第三方图集

| 项 | 值 |
| --- | --- |
| 文件 | `@deepseek-ai/dsh-client-ui-primitives/lib/types/SiteGlyph.d.ts` |
| 导出 | `siteGlyph({ href, size, className })` |
| 来源 | 该文件顶部注释原文：图集是 **`simple-icons` artwork set（CC0-1.0）**，按包依赖钉版本；每个标记取链接的 `currentColor`，而不是品牌固有色 |
| 能力边界 | 只认**绝对 http(s) URL 的主机名**；未知站点返回 `undefined` |

它的定位是「外链前导图标」，不是品牌墙。若采用它，色彩会随主题走（不是品牌色），且本机 `node_modules` 下**没有**找到 `simple-icons` 目录（它被打进 primitives 的产物里），因此**不能**把它当成「拿各站官方 SVG 文件」的渠道。

### 2.3 仓库内其它 svg

`reference/webcode/bridge-browser/public/icons/` 下有 `icon.svg` 与 `icon16/32/48/128.png`，那是**参考仓库自己的扩展图标**（WebCode 的桥接标识），与任何一个被镜像站点的品牌无关，**不能**当作站点图标使用。

---

## 3. 各站点官方图标候选

> **诚实标注**：本节除 DeepSeek（2.1，已在磁盘上逐字核对）外，其余条目来自网页搜索结果，我**没有**逐个下载并逐字核对 SVG 内容。下表里「官方？」一列按来源域名判定；标「第三方图集」的**不是**品牌方发布的资产。
>
> 更关键的一条结构性事实：**多数站点并不对外发布「透明底纯符号」的官方 SVG**，官方给的多是「带文字的组合标」（wordmark+mark），或干脆只有 PNG/ICO。真正能直接当图标用的透明底 SVG，往往只在第三方图集里有——而那已经违反「官方优先」。

| 站点 | 候选来源 | 官方？ | 形态 | 透明底 | 结论 |
| --- | --- | --- | --- | --- | --- |
| DeepSeek | 本机 `dsh-client-ui-primitives` 的 `FISH_LOGO_PATH` | ✅ **官方**（DSH 自家资产） | SVG 路径 | ✅ | **首选，已具备** |
| DeepSeek | [Wikimedia Commons: DeepSeek logo.svg](https://commons.wikimedia.org/wiki/File:DeepSeek_logo.svg) | ⚠ 社区上传（非官方发布） | SVG | ✅ | 备选 |
| Kimi | [KIMI Brand Guidelines](https://moonshotai.github.io/Branding-Guide/)（官方品牌站，提供 Download SVG） | ✅ 官方 | SVG（含 With/Without Icon 多版） | 需逐个确认 | **官方 SVG 可下载** |
| Kimi | [Kimi Brand Book](https://www.kimi.com/en/resources/kimi-brand)（官方，含 Logo Usage Terms） | ✅ 官方 | SVG | 需确认 | 官方入口 |
| Qwen | [Wikimedia Commons: Qwen Logo.svg](https://commons.wikimedia.org/wiki/File:Qwen_Logo.svg) | ⚠ 社区上传 | SVG | ✅ | 备选 |
| Qwen | [LobeHub Qwen](https://lobehub.com/zh/icons/qwen) | ❌ 第三方图集 | SVG/React | ✅ | 不满足「官方」 |
| 智谱清言 GLM | [LobeHub Qingyan](https://lobehub.com/zh/icons/qingyan) | ❌ 第三方图集 | SVG | ✅ | 需另找官方 |
| 豆包 Doubao | [LobeHub Doubao](https://lobehub.com/icons/doubao) | ❌ 第三方图集 | SVG/PNG | ✅ | 需另找官方 |
| Grok | [x.ai/legal/brand-guidelines](https://x.ai/legal/brand-guidelines) | ✅ 官方（品牌规范页） | 规范页 | — | 有官方规范，资产需按其条款取 |
| Grok | [LobeHub Grok](https://lobehub.com/icons/grok) | ❌ 第三方图集 | SVG | ✅ | 不满足「官方」 |
| Claude | [Wikimedia Commons: Claude AI symbol.svg](https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg) | ⚠ 社区上传 | SVG | ✅ | 备选 |
| Claude | [logo.dev Anthropic](https://www.logo.dev/search/brands/anthropic.com) | ❌ 第三方聚合 + 需 API token | SVG/PNG | ✅ | 不满足「官方」 |
| ChatGPT | 本轮未找到官方图标/媒体资源页 | — | — | — | **缺口** |
| Gemini | 本轮未找到官方图标/媒体资源页 | — | — | — | **缺口** |
| Z.ai | 本轮未单独检索（与 GLM 同源品牌） | — | — | — | 可复用 GLM 结论 |

---

## 4. 结论与建议

### 4.1 分三档处理，不要假装「全都能拿到官方矢量」

**A 档 · 已具备（可直接做，零新增资产）**
- **DeepSeek**：用 primitives 的 `FishLogo` / `FISH_LOGO_PATH`。官方、矢量、透明底、深浅色随 `currentColor`。

**B 档 · 有官方渠道，但需要取回并入库（要一次人工取件）**
- **Kimi**：官方 Brand Guidelines 直接给 SVG 下载。
- **Grok**：官方品牌规范页，按其条款取。
- 建议做法：把这几个官方 SVG 原样落到 `lib/brand/<siteId>.svg`（或内联成路径常量），并在文件头注明**来源 URL + 取件日期 + 许可**。

**C 档 · 本轮没有权威官方源（不得用第三方图集冒充）**
- **ChatGPT、Gemini**：未找到官方图标页。
- **智谱清言、豆包、Qwen、Claude、Z.ai**：目前只找到第三方图集（LobeHub / Wikimedia 社区上传 / logo.dev）。
- 对这一档，建议**不要**硬塞一个「看起来像官方」的图标，而是按本仓库既有的诚实纪律二选一：
  1. 用**站点首字母/文字标记**（与现有 `SiteAccounts` 头像占位同一套做法），并注明「官方矢量图标未找到」；或
  2. 暂缓图标，先做选择框与多开（图标是装饰，选择框与多开是功能）。

> 这一档正是用户「官方优先」这条要求的真实代价：**宁可缺图标，也不要拿第三方复刻当官方**。本仓库的注释纪律（`doc/comment-style.md`）已经把「不造假状态」写成硬约束，图标同样适用。

### 4.2 两个功能问题的可行性（结论：都能做，且不需要新机制）

**① 点击 Web Bridge 后先进一级选择框，再打开对应站点**

可行，但**不建议**把它做成「点击 Web Bridge 标签 → 弹选择框」：右侧栏的标签页是官方 `sidebarRightTabs` 契约下的**常驻视图**，用户点开它就期待看到面板本体；每次都先弹一层会让「回到上次那个站点」变慢。

更贴合官方结构的做法是把选择框放进**面板内部的首屏**（当尚无任何站点连接时渲染一个站点网格），或作为标签页动作菜单里的一项「切换站点…」。这两个位置都在我们已注册的座位里，不新增 shell 层。

**② 一个 Web Bridge 下多开不同网址**

**已经成立，无需新机制**，两条路都现成：
- **面板内切换**：`Conversation` 已经用「每站点一个常驻 iframe + `display` 切换」保活（`lib/client.cjs:1658` 起），切换不重载。
- **真正的「同时看两个」**：官方右侧栏自带**分屏 / 浮动**，代码已经接好——`ctx.sidebarRight.split()` + `openTab(kind, { paneId })`（`lib/client.cjs:2284` 一带），且 Ctrl/⌘+点击站点、中键点击都已绑定 `openSiteInPane`。每个 pane 是**独立的组件实例**，各自的 `siteId` 与 iframe 池互不影响。

因此「多开不同网址」不是待实现功能，而是**已有能力**；这一轮要补的只是「选择框 + 图标」这层外壳。

### 4.3 建议的落地顺序（待用户点头后再做）

1. 先只做**选择框外壳** + DeepSeek 官方鲸鱼（A 档），其余站点用文字标记占位；
2. 再逐个补 B 档官方 SVG（取件时记来源与许可）；
3. C 档在找到官方源之前保持文字标记，并在界面上如实标注「官方矢量图标未找到」。

---

## 5. 参考链接

- DeepSeek 官方鲸鱼（本机资产）：`@deepseek-ai/dsh-client-ui-primitives` → `FISH_LOGO_PATH` / `FishLogo`
- 官方站点标记机制：[`SiteGlyph.d.ts`](file:///C:/Users/rsyhn/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/types/SiteGlyph.d.ts)（simple-icons，CC0-1.0，**非**品牌官方资产）
- [Wikimedia Commons: DeepSeek logo.svg](https://commons.wikimedia.org/wiki/File:DeepSeek_logo.svg)
- [KIMI Brand Guidelines](https://moonshotai.github.io/Branding-Guide/) · [Kimi Brand Book](https://www.kimi.com/en/resources/kimi-brand)
- [Wikimedia Commons: Qwen Logo.svg](https://commons.wikimedia.org/wiki/File:Qwen_Logo.svg)
- [Wikimedia Commons: Claude AI symbol.svg](https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg)
- [x.ai Brand Guidelines](https://x.ai/legal/brand-guidelines)
- [LobeHub 图标库](https://lobehub.com/zh/icons)（第三方，仅列出以便对照，不作为官方源）
