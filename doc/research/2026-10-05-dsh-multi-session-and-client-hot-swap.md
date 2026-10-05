# DSH 0.2.0-rc.2「多会话」的真实实现 + 客户端插件热换契约（2026-10-05 真机取证）

**这份解决什么问题**：用户问「现在的多会话如何真实实现」，并报「还是不行」。
本文是**只读实读官方 0.2.0-rc.2 代码 + 真页面探针**的结论，分两层：
① 官方布局/会话契约到底允许什么（多会话能不能同屏）；② 我们插件的「并发会话」面板
落在契约的哪一条上，以及本轮抓到的两个真根因。

权威源：`D:/2_Download_Main/4_DeepSeek Harness_code/resources/app.asar`（内部前缀
`dsh/node_modules/@deepseek-ai/`，版本 `0.2.0-rc.2`）。仓库内 `reference/deepseek-harness`
是 **0.1.7-alpha.2（2026-09-22）** 的旧 checkout，只能作方位参考，**不作为结论依据**。

---

## 0. 结论摘要

1. **官方没有「同时显示 N 条会话」的一等机制**：中央区 `main` 是 **keyed 槽、一次只渲染一个 key**，
   `conversation` 是保留 key，面板与单个会话**互斥**；任何官方导航
   （`openSession` / `openWorkspace` / `clearMain`）末行都是 `ctx.layout.selectPanel(null)`。
2. **官方支持的等价构造**（`ui-subagent` 的侧栏会话、`ui-sidebar-right` 的右栏会话都用它）：
   注册一个 `main` 面板 → 面板**声明一个 session 作用域子槽** → 每列
   `ctx.sessions.retain(id, { source })` 拿**引用对象** → `<SessionProvider session={ref}>`
   包住 `renderSlot(自有子槽)` → 占用者用
   `renderFactorySlot('conversation.content', { variant:'embedded', … })` 渲染**官方会话体**。
3. **本轮「还是不行」有两个独立根因，且都不在契约层，而在我们的接线层**：
   `ctx.layout` 没进 `inject`（未声明即**抛错**）、`warn` 声明在 `apply()` 里
   （面板组件定义在 `apply()` 之外 ⇒ `ReferenceError`）。两者都在渲染/提交期抛 ⇒ 官方
   `SlotErrorBoundary` 渲染成空 div ⇒ 用户看到「面板一片空白」。详见 §7。

---

## 1. 官方的布局契约：为什么「多会话同屏」不是一等公民

| 事实 | 出处（asar 内路径:行） | 含义 |
| --- | --- | --- |
| root 槽只有 5 个：`sidebar`(single)、`main`(**keyed**)、`rightbar`(single)、`shell.overlay`(list)、`shell.leading`(single) | `dsh-client-ui-layout/lib/client.js:601-625` | 第三方能进主区的只有 `main` 一个 key |
| `main` 的渲染点：`renderSlot("main", {}, { entryKey: usePanelInfo(i => i.activePanelId) ?? "conversation" })` | `dsh-client-ui-layout/lib/client.js:117-118` | **一次一个 key**；没选面板就回 `conversation` |
| `conversation` 是 ui-conversation 的保留 key | `dsh-client-ui-conversation/lib/client.js:18436-18438` | 面板与「单个会话」互斥 |
| `selectPanel(id)`：未注册 id 抛错且不改选择；`null` 回 Conversation | `dsh-client-ui-layout/lib/client.js:461-466` | 选中状态是全局单值 |
| `panelInfo` 是**裸 observable**：`{ getSnapshot(): {activePanelId}, subscribe(listener) }`；`subscribe` 是整 store 订阅 | `dsh-client-ui-layout/lib/client.js:595-599`、`:388` | 插件能观察「面板被切走」，但拿不到「是谁切的」 |
| 官方导航互斥：`replaceMain(target, signal, panel)` 末行 `if (panel === "reveal") ctx.layout.selectPanel(null)`；`clearMain()` 同 | `dsh-client-ui-workspace/lib/client.js:971-994`、`:964-970` | **任何官方导航都会关掉面板**（这正是用户报的「一点就跳回单个会话」） |
| 官方 UI 承认这个互斥面：面板活跃时右栏轨道隐藏、窗口标题不跟随会话 | `dsh-client-ui-sidebar-right/lib/client.js:5874`、`dsh-client-ui-layout/lib/client.js:57-58` | 同屏 N 会话不是「没做」，是布局模型里没有这个位置 |

**结论**：谁都不能在 `main` 里同时挂两个 key。想要「多列各自一条真会话」，只能**一个面板内部
自己排 N 列**——这正是本插件的做法。

## 2. 官方支持的构造：面板内渲染「任意一条真会话」

判据（都在产代码里，不是文档承诺）：

| 步骤 | 官方范例 | 契约点 |
| --- | --- | --- |
| 拿真会话引用 | `sessions.retain(address, { source: "sidebarChat", signal })` | `dsh-client-ui-subagent/lib/client.js:751-754`；`retain` 定义在 `dsh-api-session-controller/lib/client.js:3194-3207` |
| 显式绑定会话作用域 | `<SessionProvider session={reference}>{renderSlot("sidebar.chat.conversation", {})}</SessionProvider>` | `dsh-client-ui-subagent/lib/client.js:795-798` |
| 声明 session 作用域子槽 | `children: { "sidebar.chat.conversation": { kind:"single", scope:"session" } }` | 同上 `:819-827` |
| 渲染官方会话体 | `renderFactorySlot("conversation.content", { variant:"embedded", … }, { slots: { views: FixedChatConversationView } })` | 同上 `:775-787`（`views` 槽内再 `renderSlot("conversation.session", { view:"chat" })`） |
| Factory 的声明 | `scope:"session-maybe"`、`slots:{ views:{scope:"session"}, widthControls:{scope:"root"} }`、`children:{ "conversation.session": … }` | `dsh-client-ui-conversation/lib/client.js:18150-18187` |
| 声明校验的差异 | `renderSlot` 会校验「本条目是否声明了这个子槽」（`SlotOwnershipError`）；`renderFactorySlot` **不校验调用方声明** | `dsh-client-ui-renderer/lib/client.js:329-333`、`:306-318` |
| 关键前提 | `SessionProvider` / `renderSlot` **只在「条目声明了非 root 子槽」时才发给条目** | `dsh-client-ui-renderer/lib/client.js:717-739` |

⚠ 两条容易踩的边界：
- **不套自己的 `SessionProvider`** ⇒ 渲染的是**当前会话**（不是你要的那条）：binding 只在显式
  `session` prop 时切换（`dsh-client-ui-renderer/lib/client.js:690-694`）。
- **递归渲染**：在 `conversation.content` 的子树里再渲染同名 factory 会当场抛
  `recursive render of factory 'conversation.content'`（`dsh-client-ui-renderer/lib/client.js:1049`）
  —— 这就是「并发面板必须搬出会话、只能挂在 `main` 面板上」的技术原因。
- `create({ workspaceId })` 与 `create({})` 的差别是**用户可见的**：没绑工作区的会话会渲染
  「虚线选择工作区」卡，点它就走 `openWorkspace → replaceMain → selectPanel(null)`
  ⇒ 面板被换掉。

## 3. 我们插件的映射（现状，0.19.63）

- 左栏入口：`ctx.slots.inject('sidebar.panellist', … register({ name:'sidebar.panellist', id:'webcode-concurrent-panel', label:()=>'并发会话' }))`。
  官方 shell 自己画行（Tooltip / 折叠 / 选中态），点它走 `ctx.layout.selectPanel(id)`。
- 中央面板：`ctx.slots.register({ name:'main', key:'webcode-concurrent-panel', children:{ 'webcode-concurrent.column': { kind:'single', scope:'session' } } }, …)`
  （keyed + 声明 session 子槽 ⇒ 拿到 `SessionProvider` / `renderSlot` / 标准 hooks）。
- 每列：`sessions.create({workspaceId})` → `sessions.retain(id,{source:'webcodeConcurrent'})` →
  `<SessionProvider session={ref}>{renderSlot('webcode-concurrent.column', { hwbView })}</SessionProvider>`
  → `ConcurrentColumn` 里 `renderFactorySlot('conversation.content', { variant:'embedded', phase, hero }, { slots:{ views } })`。
- 引用成对释放：移出列 / 面板卸载时 `release()`（`refsRef` 存引用对象，不存 id 字符串）。
- 组信息存浏览器 `localStorage`（面板布局是本浏览器的事实，不是 Host 事实；丢了只重建组、不丢对话）。

## 4. 「面板全空」有两类形状，修法完全不同（真机读数必须同时收）

| 形状 | 机理 | 外部读数 |
| --- | --- | --- |
| **抛错空盒** | 条目渲染抛错 ⇒ 官方 `SlotErrorBoundary` 渲染 `<div data-slot-error>`（**没有任何可见内容**） | console：`slot entry crashed in '<槽>': …`；DOM：`[data-slot-error]` |
| **塌高** | 没抛错，父链某级不给高度 / `overflow:hidden` 裁掉 ⇒ 根节点 rect 高 0 | 无报错；bounding box h=0、父链 rect 逐级可见 |

本仓库 0.19.62 只加了**插件自建边界**，但两层都包在 `ConcurrentPanel` **内部**：
崩溃若发生在「构造 `ConcurrentPanel` 元素之前」（本轮就是），它够不着 ⇒ 依旧空白。
**0.19.63 起把边界上提到条目注册处**，并把 `ctx.<服务>` 读全部纳入 inject 判据。

## 5. 客户端插件热换契约（`@deepseek-ai/dsh-client-hmr`）

- **无条件挂载**：`dsh-web-app/cordis.patch.yml` 的 `- id: client-hmr`（无 `disabled:`），
  注释原文「The client-plugin reload chain, always mounted」。
- 宿主半边每 `pollIntervalMs = 500` ms `statSync` 每个插件的**客户端产物**
  （`artifactBaseline(row.id)` = `{path, mtimeMs, ctimeMs, size}`）；变化即
  `clientModules.rebuilt(id)` → SSE `{"type":"rebuilt","id","rev"}`（路由 `/plugins/events`）。
- 产物路径 = 包 `exports["./client"]` 指向的那个文件（本插件 `./lib/client.cjs`）。
  **内容必须自带 `window.__ModuleLoader__.load({ id, factory })` 信封** —— 宿主不做转换、不包装。
- **产物是按内存快照下发的**：激活时 `readFileSync` 一次；此后只有 rev 变化才重读并重建响应。
  响应带 `cache-control: public, max-age=31536000, immutable`，靠 URL 里的 `&rev=` 破缓存。
- **`/plugins*` 不需要认证**（webserver 的认证闸门只管 `/api` 与首页 index）；
  `/api` 要的是**进程内存里的 launch token**（`dsh-client-connection` 的 WeakMap，
  不是环境变量、不是文件）。
- **宿主半边换不了**：替换已安装的包版本，`dsh-plugin-manager` 直接返回
  `application: "restart-required"`，且没有重启端点/重启命令。

### 5.1 热换的正确姿势（本轮实测）

```powershell
# 只换客户端产物：**原地覆盖**，不要删除、不要改名、不要临时文件 + Move-Item
node -e "require('fs').writeFileSync('C:/Users/<user>/.dsh/profiles/desktop/node_modules/dsh-webcode-bridge/lib/client.cjs', require('fs').readFileSync('<repo>/package/dsh-webcode-bridge/lib/client.cjs'))"
```

- ✅ 正确：原地覆盖 ⇒ 500 ms 内 SSE 推 `rebuilt`，宿主按新 rev 下发**新字节**；
  外部核对 = 读 `/plugins/events` 的图 rev，再 `GET /plugins/??dsh-webcode-bridge/client.js&rev=<rev>`，
  与磁盘逐字节比对（服务端会在末尾追加 75 B 的 `sourceMappingURL` 尾巴）。
- ❌ **反例（本轮真机踩到）**：先用「写临时文件 + `Move-Item -Force` 替换」——删除+改名在轮询器
  眼里留出残缺窗口，`clientModules` 当场拒绝为新内容重建响应：新 rev 与之后所有 rev **一律 404**。
  **恢复**：把旧字节**原地**写回，即恢复 200 且与磁盘逐字节相同（已验证）。
- ⚠ 只换客户端时 **`/__webcode/status` 的 `build.version` 不会变**（宿主里仍是旧服务端代码）。
  它**不是**「没生效」的判据；判据是 rev + 按 rev 取回的字节。

## 6. 真页面验证通道（此前被误判为不可能）

`dsh web` 启动横幅就打印**带 token 的 URL**：

```
dsh web: http://127.0.0.1:3087/?token=<base64url>
```

来源：`dsh-web-app/lib/index.js` 的 `announceReady` → `connection.authenticatedUrl(url)`
（`dsh-client-connection/lib/index.js:374-378` 把 token 写进查询串）。
⇒ **只要由我们自己启动这个进程**（`dsh --profile web --host 127.0.0.1 --port <p> --no-open`，
或 npm 全局 `dsh web`），就能拿到 token、开真页面、用 Playwright 驱动。
`GET /?token=…` 会 303 + `Set-Cookie: dsh-auth-…`，之后的 `/api` 调用同源带 cookie 即可。

探针：`package/dsh-webcode-bridge/test-mock/probe-concurrent-live.mjs`
（真页面 → 点「并发会话」→ 建 3 列真会话 → **同时收错误读数与几何读数** → 列内点击后确认不跳走）。

## 7. 本轮两个真根因（都在渲染/提交期抛错）

1. **`ctx.layout` 未进 `inject`** —— cordis 的 reflect 代理对未声明服务读取**直接抛**
   `cannot get property "layout" without inject`（不是给 undefined）。
   0.19.62 把 `layout: ctx.layout` 写进 `main` 条目的**组件函数**。官方 `dsh-client-ui-sidebar`
   的 inject 里有 `"layout"`；我们漏了。
2. **`warn` 声明在 `apply()` 内** —— `ConcurrentPanel` / `createPanelGuard` 定义在 `apply()`
   **之外**（`function apply(ctx)` 从文件后段才起），挂载 effect 的 catch 分支调用 `warn(...)`
   ⇒ `ReferenceError: warn is not defined`。它由**插件自己的 `HwbBoundary`** 打出可读文本
   （`[webcode-bridge] 并发会话面板 render failed: …`），也正是「边界上提」这个改动的价值。

**为什么既有护栏没拦住**：`team-compare` 那批判据全是**源码正则**——正则看不见作用域、
看不见「声明在哪个函数里」。所以 0.19.63 把判据换成**对起来比**：

- 「源码里出现的每个 `ctx.<服务>` 读取，都必须在 inject 列表里」（cordis 自带成员白名单）；
- 「`warn` 必须在 `function apply(ctx)` 之前，且全文件只有一处」。

## 8. 复现命令

```powershell
# ① 起验证台（web profile，与桌面端 profile/浏览器 profile 都分离）
node "C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" `
     --profile web --host 127.0.0.1 --port 3087 --no-open      # 从 stdout 取带 token 的 URL

# ② 真页面判据
node package\dsh-webcode-bridge\test-mock\probe-concurrent-live.mjs "http://127.0.0.1:3087/?token=…"

# ③ 结构化护栏（秒级）
node package\dsh-webcode-bridge\test\team-compare.test.mjs
node package\dsh-webcode-bridge\test\client-render.test.mjs
```

## 9. 未收口与边界（如实记）

- 桌面 profile 的**声明仍钉 0.19.61**，磁盘已是 0.19.63：恢复「声明 == 磁盘」需要**完全退出桌面端**
  后走官方通道安装一次（见 `doc/long-term-issues.md`）。在那之前，任何 pnpm 通道都可能把客户端
  静默换回旧版。
- **宿主半边（`lib/index.js`）不能热换**；本轮修的是客户端，故不需要重启。若今后要改宿主半边，
  必须走「退出应用 → 官方安装 → 重开」。
- 未验证（不声称）：`ui-chat` 的 chat 视图能否多 occurrence 并发挂载、第三方用
  `renderFactorySlot('conversation.content')` 是否属**对外承诺**（机制无校验且有在产范例，
  但 README 只写 “an embedded occurrence can …”）。
- 未做（需用户同意）：全量回归（121 个测试文件）。
