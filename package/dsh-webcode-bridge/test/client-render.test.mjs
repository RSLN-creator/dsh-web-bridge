// client-render.test.mjs — 右栏组件渲染护栏（问题②：面板全白）。
//
// 背景：0.11.0 把「独立窗口」状态从「开着的站点 id（字符串/null）」改成多站点聚合
// 对象（`winOpen[siteId]?.open`），初始 useState 也换成了 {}，但 winState() 里
// `setWinOpen(openSite)` 仍塞字符串/null。于是没有独立窗口（null）时，渲染执行
// `null['deepseek']` 抛 TypeError，整块右栏 React 树崩掉 → 面板点开全是空白。
//
// 这个测试用最小 React 运行时真跑一遍 client.cjs 注册的 pane 组件，并**等异步
// setState 落地后重渲染**。踩过的坑：不等 tick 的话状态永远是初始 {}，旧代码也
// 「跑得过」——那样的护栏是空转的，证明不了任何事。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(here, '../lib/client.cjs');

/**
 * 读 client.cjs 的源码文本，用于**静态样式断言**（去臃肿那两条）。
 * 渲染树里读不到 CSS 值，而 CSS 值恰恰是最容易被「顺手调一下」改回去的。
 */
const bridgeSrcFrom = (rel) => readFileSync(path.resolve(here, '../lib/', rel), 'utf8');

/**
 * 渲染组件时喂进去的 props，形状与官方槽 `inject` 的产物一致。
 *
 * 0.15.0 起任务板面板需要当前会话 id（花名册的 subagentCatalog 是会话级投影，
 * 见 lib/roster.js 的 projectSubAgents；0.19.x 起设置页已不再消费它）。这里用固定
 * 的假 id 而不是 null：`null` 会让花名册走「no-session-id」降级分支，任务板那条
 * 「读不到时必须给原因」的用例专门覆盖它。
 */
const SESSION_PROPS = { sessionId: 'session-render-test' };

/** 在当前进程里加载 client.cjs 并跑若干渲染周期，返回每次渲染捕获的异常。 */
async function renderPane({ payloads, which = 'pane', sites = [], roster = null, primitiveOmit = [], waitStats = null, openMenu = false, tabParams = undefined, noTabActions = false, settingsTab = '', sessionProps = SESSION_PROPS, iconNaming = 'legacy' } = {}) {
  // 0.16.38：设置页按作用域切成「全局页 / 站点页」。站点的账户、模型、提示词三张卡
  // 只在站点页渲染，护栏必须能直接渲染站点页才谈得上验证它们——否则只能断言
  // 「全局页看不见」，那证明不了站点页是对的。`initialSettingsTab` 是给这个用的
  // 初值入口，真机缺省仍是全局页（''）。
  const scopedProps = settingsTab ? { ...sessionProps, initialSettingsTab: settingsTab } : sessionProps;
  const saved = { window: global.window, document: global.document, fetch: global.fetch, setInterval: global.setInterval, clearInterval: global.clearInterval };
  const realSetTimeout = global.setTimeout;
  let captured = null;
  // 0.15.12：`sidebar.right.pane.tab` 是 **keyed** 座位，本轮起有三个 kind
  // （网页 / Team / 任务板）各注册一个正文。旧 harness 只留「最后一个注册的」，
  // 于是新增两个标签页会把网页正文挤掉——那不是产品缺陷，是桩建模失真。
  // 按 key 收全，再按用途取。
  const PaneComponents = new Map();
  /** 已注册的标签页定义（kind → definition），用于断言三个 kind 各自成立。 */
  const TabDefinitions = new Map();
  // 0.16.0：左栏入口（sidebar.panellist）与中央列 main 座位。前者是 list 座位，
  // 后者的 key 必须与前者 id 逐字相同——两半各收一处，便于断言「成对」。
  const PanelEntries = [];
  const MainKeys = [];
  // 0.16.18：main 是 **keyed** 座位，按 key 派发。只收 key 已经不够——任务板正文
  // 现在只从这里取（右栏那份 `sidebar.right.pane.tab` 注册已按用户要求删除），
  // 因此组件本身也要留一份，否则 which:'tasks' 无座位可渲染。
  const MainComponents = new Map();
  // 0.19.0：`conversation.view` 槽位注册的视图定义（按 id）。用于断言「并列多会话
  // 真的挂在中央对话区」，而不是只断言源码里存在这个组件。
  const ViewComponents = new Map();
  let SettingsComponent = null;
  // 0.15.11：输入框底下的等待药丸也必须被真的渲染到。此前没有任何用例捕获
  // `conversation.composer.dock` 的组件，于是「药丸长什么样、点了会怎样」
  // 这整条路径在测试里是空白——护栏再密也拦不住它回归。
  let DockComponent = null;
  const MenuItems = [];
  // 0.19.51：收下每个 menu.item 注册的 id，用于断言「带 id 且互不相同」。
  const MenuItemIds = [];
  const effectDisposers = [];
  // 0.16.35：站点目录点一行会调 `ctx.sidebarRight.openTab(kind, { params })`，
  // 这是「一个站点一个标签」的**唯一**动作。必须收下每一次调用，否则「点站点到底
  // 开了什么」在护栏里完全没有证据（只能测出目录渲染得像不像）。
  const openTabCalls = [];
  // 0.16.39：目录页改用本标签自己的 `tab.actions.openTab(…, { replaceTab: true })`
  //（官方 guide 的同一条路径）。这是「选站点**替代**本标签页」的唯一动作，
  // 与上一条分开收集——两条路径的断言不同，混在一起会看不出走的是哪条。
  const inPlaceOpenCalls = [];
  let windowHits = 0;
  // 每次 setInterval 的周期（ms）。药丸的轮询节奏由它在途与否决定，见 0.16.24 用例。
  const intervalDelays = [];
  let current = payloads[0];

  let states = [], cursor = 0, effectSlots = [], effectSlotCursor = 0, pendingEffects = [];
  // ── 组件级 hook 作用域（2026-09-15） ────────────────────────────────────────
  // 真实 React 的 hook 状态挂在**组件实例**上，不是全局扁平下标。旧实现用
  // 「整棵树共用一个 cursor」模拟，只有在每个组件的 hook **数量与顺序**都
  // 恒定、且组件出现顺序不变时才等价。
  //
  // 一旦某个组件多一个 useState（本轮 SiteAccounts 为「选中账户」新增了
  // picked），它之后所有组件的 hook 下标就整体后移，于是嵌套的 PromptPanel
  // 会从**别人**的槽位读到值——实测表现是 `variants.find is not a function`
  // （PromptPanel 的 variants 拿到了一个字符串/对象）。那是护栏自己的建模
  // 失真，不是产品缺陷；但它会让正确的实现被误判为崩溃。
  //
  // 修法：按「正在渲染哪个组件」分段计数（ownerStack 栈顶即当前 owner），
  // 状态槽的键 = 组件身份 + 该组件内的 hook 序号。组件内部顺序仍必须稳定
  //（这正是 React 的 hooks 规则），但**其他组件**增删 hook 不再影响它。
  const ownerStack = [];
  let anonOwner = 0;
  const ownerKey = () => (ownerStack.length ? ownerStack[ownerStack.length - 1].id
    : 'root#' + (ownerStack.rootSeq = (ownerStack.rootSeq || 0)));
  const renderWithScope = (fn, identity) => {
    const frame = { id: identity + '#' + (typeof fn === 'function' ? (fn.name || 'anon') : 'x'), n: 0, e: 0 };
    ownerStack.push(frame);
    try { return fn(); } finally { ownerStack.pop(); }
  };
  const React = {
    // createElement 必须与真 React 同形：真 React 会把**可变子节点**也放进
    // `props.children`（单子给单值、多子给数组），而不仅是挂在返回节点的 children 上。
    //
    // 0.16.37 修的一处假绿：此前只写 `(type, props, ...children) => ({type, props, children})`，
    // 于是 `props.children` 永远是 undefined。真机上 `primitives.Button` 是从
    // **props.children** 取内容的（组件签名 `({variant, children, ...rest})`），
    // 于是官方原语包着的图标与文字在桩里被整块丢掉——页面照常渲染、errors 为空，
    // 断言却报「找不到那一行文字」。这是「桩的建模失真会把整类 bug 盖住」的又一例
    //（本文件上方 primitiveOmit 注释里记着同一教训的 0.16.21 版本）。
    createElement: (type, props, ...children) => {
      const merged = children.length === 0 ? props
        : { ...(props || {}), children: children.length === 1 ? children[0] : children };
      return { type, props: merged, children };
    },
    useState: (init) => {
      const frame = ownerStack[ownerStack.length - 1];
      // `i` 是**该组件内**的序号；无 owner 帧时回落到旧的全局 cursor（顶层调用）。
      const i = frame ? frame.id + '::' + (frame.n++) : 'g::' + (cursor++);
      if (!(i in states)) states[i] = init;
      return [states[i], (v) => { states[i] = typeof v === 'function' ? v(states[i]) : v; }];
    },
    useEffect: (fn, deps) => {
      const frame = ownerStack[ownerStack.length - 1];
      const i = frame ? frame.id + '::e' + (frame.e++) : 'ge::' + (effectSlotCursor++);
      const prev = effectSlots[i];
      const changed = !prev || (deps && (!prev.deps || deps.some((d, k) => d !== prev.deps[k])));
      if (changed) { effectSlots[i] = { fn, deps }; pendingEffects.push(fn); }
      else effectSlots[i] = prev || { fn, deps };
    },
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
  };
  const mockRequire = (id) => {
    if (id === 'react') return React;
    if (id === 'react-dom/client') return { createRoot: () => ({ render() {} }) };
    // 0.16.39：createPortal **重新被使用**——但用途与 0.16.18 删掉的那次不同。
    //
    // 那次是拿 portal 去塞官方统计行（标记已消失，那条路是 bug 源）；这次是给
    // 我们自己的等待统计弹层用：官方 stat-dialog 同样 portal 到 body，弹层必须
    // 逃出右栏面板的 `transform` + `overflow:hidden` 才能「左边缘对齐药丸 + 视口
    // 夹紧」。桩把它**内联返回**（而不是真挂到 document.body），于是展开态的
    // 内容仍然能在渲染树里被断言到。
    if (id === 'react-dom') return { createPortal: (node) => node };
    // 官方 primitives 桩（0.16.23 起按真实契约补齐）：client.cjs 还解构了
    // IconChevronDownOutline14 / FishLogo / FISH_LOGO_PATH / FISH_LOGO_VIEWBOX /
    // useDismissOnOutsidePointer（站点图标与选择框，0.16.23 接手网页会话半成品时
    // 加入）。桩按真机 0.1.6-alpha.2 的导出形状给**可渲染**的替身——FISH_LOGO_VIEWBOX
    // 用官方真实值，路径给一条合法占位 d（断言不依赖形状细节，只依赖渲染不崩）。
    // primitiveOmit：模拟旧版 primitives 缺导出（每个缺位导出必须被 client.cjs 的
    // 防御回退接住——「降级不是崩溃」，0.16.21 事故的回归钉子）。
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      const stub = {
        IconCodeOutline16: () => null,
        IconQueueOutline14: () => null,
        IconChevronDownOutline14: () => null,
        // 0.16.37：官方 `Button` 原语。站点目录的胶囊两半（主区 + 右侧触发器）都用它，
        // 与官方「新建终端」同源。桩必须把它渲染成**可点的 button 节点**并透传
        // className / onClick —— 否则「点目录一行会开标签」那条行为断言会静默失效
        //（找不到节点 → buttons 为空 → 断言在别处炸，或者更糟：静默通过）。
        Button: ({ variant, size, icon, className, children, ...rest }) =>
          ({ type: 'ButtonStub', props: { variant, className, ...rest }, children: children === undefined ? [] : [children] }),
        FishLogo: () => null,
        // 0.16.33：官方 Menu 原语。桩按**真实契约**给（Menu.d.ts）：
        //   · 首参是 props 对象（含 open/anchor/items/onSelect/onClose）；
        //   · 返回一个可渲染元素，把 anchor 原样放在里面——触发按钮必须能被找到；
        //   · open 时把 items 逐行画出来，`submenu` 作为嵌套节点保留下来。
        // 桩必须照契约给形状而不是「能过就行」：旧桩只给两个图标时，新解构的
        // 五个导出全是 undefined，渲染期抛错变白屏——那次 0.16.21 事故的教训是
        // **桩的建模失真会把整类 bug 盖住**（见本文件上方 primitiveOmit 注释）。
        // 这里把 items 的 id/submenu 结构暴露出来，菜单的层级才能被断言。
        // 0.16.34：桩必须**真渲染**菜单行。此前它只把 items 原样挂成 props，于是
        // 「菜单打开后长什么样」在护栏里是空白的——而 0.16.34 恰恰把站点选择整个
        // 收进了这个菜单（横向标签条已删）。渲染不到行，这一整块就等于没有护栏：
        // 站点名丢失、状态点丢失、行宽塌掉，一条都测不出来。
        //
        // 渲染范围**只到 menu row**，与真机的可见层级一致：
        //   · anchor（触发按钮）永远渲染——它是锚点，不在 items 里；
        //   · items 仅在 open 时渲染，真机同理（关着的时候列表不画）；
        //   · 子菜单**不在这里渲染**：真机靠 hover/focus 展开，桩拿不到这两个事件，
        //     假装展开只会让断言依赖桩的想象。账户行的护栏走源码静态检查
        //     （见 ★ 二级站点菜单 用例），不在渲染树里伪造。
        Menu: ({ open, anchor, items, onSelect, onClose }) => ({
          type: 'MenuStub', props: { open, items, onSelect, onClose },
          children: [
            anchor,
            ...((open || openMenu) ? (items || []).map(it => ({
              type: 'MenuStubRow', props: { id: it.id, submenu: it.submenu },
              // 前导图标必须一起渲染：菜单行的图标挂点带着「官方矢量 / 文字标记」
              // 的档位说明（title），丢掉 icon 等于把那段说明从树里抹掉。
              // 标题行（type:'label'）的文字在 text 上，普通行在 label 上。
              children: [it.icon, it.label !== undefined ? it.label : it.text],
            })) : []),
          ],
        }),
        FISH_LOGO_PATH: '<path d="M11.58 17.04C6.5 16.6 1 12.6 1 8.5 1 3.8 5.6 0 11.6 0c5.4 0 10 3 11.2 7.2L14 6l-2.4 11z" fill="currentColor"/>',
        FISH_LOGO_VIEWBOX: { width: 23.16, height: 17.04 },
        useDismissOnOutsidePointer: () => {},
        // 0.16.39：官方弹层定位钩子。桩返回一个固定坐标（而不是 null）：
        //   · 返回 null → client.cjs 走内联回落分支，**左对齐那条路根本没被测到**；
        //   · 返回坐标 → 面板带上 left/top 样式，护栏才能断言「坐标来自官方钩子」。
        // 坐标值本身由官方实现决定（这里不重复它的算法），只钉「有没有用它」。
        useAnchoredPosition: () => ({ left: 100, top: 200 }),
        // 0.16.39：工具条图标（官方线框图标族）。桩统一给一个可渲染的空组件——
        // 断言看的是「用的是官方图标组件」而不是字形字符，只要它们可渲染即可。
        IconRefreshOutline14: () => null,
        IconRightUpOutline16: () => null,
        IconFullscreenOutline16: () => null,
        IconPanelLeftOutline16: () => null,
      };
      // 0.19.2：**图标导出改名**这条真机事故的桩开关。
      //
      // DSH 0.1.7-alpha.2 起，primitives 的图标名不再带像素后缀
      //（`IconQueueOutline14` → `IconQueueOutlineRegular`，同族还有 `…Medium`）。
      // 桩若永远只给旧名，「客户端按旧名取到 undefined → 渲染期 h(undefined) 抛错
      // → 整块 UI 静默消失」这条路径在护栏里就是空白的——而它正是用户报的
      // 「底部发送等待时间没了」。
      //
      // `iconNaming: 'current'` 把旧名整批换成新名（**不留旧名**），模拟真机 0.1.7：
      // 客户端必须靠自己的多代名字查找活下来，而不是靠桩的宽容。
      if (iconNaming === 'current') {
        for (const legacy of Object.keys(stub)) {
          const renamed = legacy.replace(/Outline(14|16)$/, 'OutlineRegular');
          if (renamed !== legacy) { stub[renamed] = stub[legacy]; delete stub[legacy]; }
        }
      }
      for (const k of primitiveOmit) delete stub[k];
      return stub;
    }
    throw new Error('unexpected require: ' + id);
  };

  try {
    global.window = { __ModuleLoader__: { load: (def) => { captured = def; } } };
    global.document = { createElement: () => ({ textContent: '', remove() {} }), head: { appendChild() {} }, body: {}, querySelector: () => null, addEventListener() {}, removeEventListener() {} };
    global.MutationObserver = class { observe() {} disconnect() {} };
    // 组件的轮询计时器：不 stub 会拖住事件循环。0.16.24 起还要**记下周期**——
    // 「在途等待时 1 秒一问」是需求的一半（10 秒一问的话数字 10 秒才动一格）。
    global.setInterval = (_fn, ms) => { intervalDelays.push(ms); return {}; };
    global.clearInterval = () => {};
    global.fetch = async (url) => {
      const u = String(url);
      let body = { ok: true };
      if (u.includes('/__webcode/window')) { windowHits++; body = current; }
      else if (u.includes('/__webcode/status')) {
        body = { ok: true, relay: { running: true, consent: true, consentPersistent: true, metrics: { timing: 'measured', firstTokenMs: 500, thinkingMs: 100, responseMs: 2000, responseTps: 20, durationMs: 3000, sendWaitMs: 15000, rateLimitRetries: 1 } }, driver: { sites, selectedModel: 'deepseek:deepseek' }, build: { hash: 'x', version: 'test' },
          // 0.15.0 花名册：子代理与 Team 两段由服务端真实投影（lib/roster.js）。
          // 缺省 null 而不是 []，是为了让「没有该字段」与「确实为空」在测试里可区分。
          // teamError / subAgentsError 一并支持：面板要能把「确实没有」与
          // 「读不到」分开说，这条路径必须有夹具覆盖。
          // 0.15.4 追加：`members`（官方 TeamView 的词，team 的同值别名）与
          // `tasks`（团队级任务板）、`tasksError`。四个分区都要能被夹具驱动。
          ...(roster ? {
            subAgents: roster.subAgents || [],
            team: roster.team || roster.members || [],
            members: roster.members || roster.team || [],
            tasks: roster.tasks || [],
            // 0.15.12：图诊断（就绪集/阻塞点/关键路径/结构问题）由服务端
            // lib/task-graph.js 算好后经 /status 透出。缺省 null 而不是造一个
            // 空图——「图算不出来」与「图是空的」在面板上说法不同。
            graph: roster.graph ?? null,
            subAgentsError: roster.subAgentsError ?? null,
            teamError: roster.teamError ?? null,
            tasksError: roster.tasksError ?? null,
            // 0.19.x：来源标注也必须能被夹具驱动。此前这个响应体从不带
            // `teamSource` / `tasksSource`，于是任务板里那一行
            // `sourceText(data?.teamSource)` 在**所有**渲染用例里恒不执行——
            // 「服务端算、前端读」这一跳只有源码正则护栏，测不出「字段没送到」。
            // 缺省 null 而不是编一个值，保持「没有该字段」与「字段为空」可区分。
            teamSource: roster.teamSource ?? null,
            tasksSource: roster.tasksSource ?? null,
          } : {}) };
      }
      else if (u.includes('/__webcode/settings')) body = { ok: true, extraPrompt: '', sendGapMs: 10000, thinkMode: 'auto', subAgentMode: 'own', subAgentSite: 'follow' };
      else if (u.includes('/__webcode/prompt-variants')) {
        // 0.14.0：设置页默认显示首轮提示词。变体必须真的带 text，否则「默认显示」
        // 只会渲染一个空 <pre>，与折叠起来没有区别。
        // 0.16.25：载荷追加 `sites`——UI 改为「按网站逐行」，每行的 text 是**该站点
        // 实际会用的协议**的模板（服务端按站点现算）。夹具照真实形状给两份，
        // 其中 deepseek 与 glm 用不同协议，才能验证「每行取的是自己那一支」。
        body = {
          ok: true, toolsSource: 'session',
          active: { variantId: 'glm', siteId: 'glm', model: 'glm:glm-5.3', tools: ['read', 'pwsh'], at: '2026-09-13T00:00:00.000Z' },
          variants: [
            { id: 'default', label: '标签形状（<tool_call> 标签）', note: 'n1', text: 'DEFAULT-PROMPT-TEXT', trainNote: 'tn1', siteIds: null, excludes: ['glm', 'deepseek'] },
            { id: 'glm', label: 'GLM 代码块（```json 代码块）', note: 'n2', text: 'GLM-PROMPT-TEXT', trainNote: 'tn2', siteIds: ['glm'], excludes: [] },
            { id: 'official', label: 'DeepSeek 官方模板（原生工具调用格式）', note: 'n3', text: 'OFFICIAL-PROMPT-TEXT', trainNote: 'tn3', siteIds: ['deepseek'], excludes: [] },
          ],
          sites: [
            { siteId: 'deepseek', siteName: 'DeepSeek 网页版', variantId: 'official', variantLabel: 'DeepSeek 官方模板（原生工具调用格式）', text: 'OFFICIAL-PROMPT-TEXT', file: '/tmp/webcode/prompts/deepseek.md' },
            { siteId: 'glm', siteName: '智谱清言 (GLM)', variantId: 'glm', variantLabel: 'GLM 代码块（```json 代码块）', text: 'GLM-PROMPT-TEXT', file: '/tmp/webcode/prompts/glm.md' },
          ],
        };
      }
      else if (u.includes('/__webcode/models')) body = { ok: true, models: [{ id: 'deepseek:deepseek', name: 'deepseek/deepseek', siteId: 'deepseek', thinking: true }] };
      else if (u.includes('/__webcode/connect')) body = { ok: true, loggedIn: true };
      // 0.15.11：等待药丸的数据面。服务端已把文案与明细算好（label / detailRows），
      // 客户端只负责渲染——夹具照真实载荷形状给，含本会话与累计两类行。
      // 0.16.24：`waitStats` 可整体替换该载荷（在途等待用例要带 live/now/liveValue），
      // 缺省仍给 0.15.11 那份「已结算」夹具。文案与 wait-stats.js 的单位口径一致
      //（0.16.39 起秒级用中文「秒」）——夹具必须照真实服务端输出给，否则护栏是假绿。
      else if (u.includes('/__webcode/wait-stats')) body = waitStats || {
        ok: true,
        total: { totalWaitMs: 20000, totalDurationMs: 60000, turns: 9, waitedTurns: 4, rateLimitRetries: 1, updatedAt: 1789000000000 },
        session: { totalWaitMs: 3000, totalDurationMs: 7000, turns: 2, waitedTurns: 1, rateLimitRetries: 0, updatedAt: 1789000000000 },
        rows: [{ label: '累计等待发送', value: '20 秒' }],
        line: '本次会话等待发送 3 秒',
        label: '3 秒 · 等待占比 30%',
        sessionValue: '3 秒',
        // 0.19.34：无在途时投影就等于账本本身，服务端照此输出——夹具必须逐字忠实，
        // 否则「标题那个数从哪来」在护栏里是假的。
        projectedValue: '3 秒',
        detailRows: [
          { label: '本次会话等待发送', value: '3 秒' },
          { label: '本次会话占比', value: '30%' },
          { label: '累计等待发送', value: '20 秒' },
          { label: '平均会话等待时长占比', value: '25%' },
        ],
      };
      // 必须是**忠实**的 Response：真实 client.cjs 走 response.text() +
      // response.headers.get('content-type') 解析（见 lib/client.cjs 的 request()）。
      // 旧 mock 只给 json()，于是 text() 抛错被吞、headers 为 undefined——
      // **所有** 数据路径都静默失败，而断言只看「不抛错」，护栏等于空转。
      // 这里补齐 text/headers/status，让数据真的到达组件。
      const text = JSON.stringify(body);
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
        text: async () => text,
        json: async () => body,
      };
    };
    if (!global.AbortSignal) global.AbortSignal = {};
    if (!global.AbortSignal.timeout) global.AbortSignal.timeout = () => undefined;

    // 同一进程里第二次 renderPane 会命中 require 缓存，client.cjs 顶层的
    // __ModuleLoader__.load 不再执行、captured 永远是 null——每个用例必须
    // 从干净模块状态开始。
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve(CLIENT)];
    req(CLIENT);
    assert.ok(captured, 'client.cjs 未调用 window.__ModuleLoader__.load');
    const mod = captured.factory(mockRequire, { exports: {} });
    mod.apply({
      // DSH 的规范生命周期：disposer 交给 ctx.effect 统一回收。这里桩成
      // 「立刻执行并把返回的注销函数存起来」，与宿主行为等价（apply 期间注册、
      // 卸载时注销）。
      effect: (fn) => { const off = fn(); if (typeof off === 'function') effectDisposers.push(off); return () => {}; },
      slots: {
        inject: (_n, fn) => fn(),
        register: (def, Comp) => {
          // 0.19.51：桩必须校验 list 座位的必填字段。
          //
          // 为什么：本插件的 `sidebar.right.tab.menu.item` 注册曾长期缺 `id`，
          // 而该座位在官方是 **list** 型，`SlotCore.register` 对 list 硬性要求
          // `options.id`（真实报错：`list slot "…" requires options.id`）。
          // 旧桩「无脑 push」放行了这个形状 ⇒ 两项菜单在真机从未出现、
          // 全量单测却全绿——判据在测试桩的能力边界上逃逸了。
          // 判据不必复刻整张 SlotMap：只校验本插件注册的**已知 list 座位**
          // 必带 id（keyed 座位必须带 key），够抓住这一族回归且不会假红。
          if (def?.name === 'sidebar.right.tab.menu.item' && !def.id) {
            throw new Error('list slot "sidebar.right.tab.menu.item" requires options.id（真实 SlotCore 会拒绝：0.19.51 前的两项菜单就是这么静默消失的）');
          }
          if (def?.name === 'main' && !def.key) {
            throw new Error('keyed slot "main" requires options.key');
          }
          if (def?.name === 'sidebar.right.pane.tab') PaneComponents.set(def.key, Comp);
          if (def?.name === 'settings.section') SettingsComponent = Comp;
          if (def?.name === 'sidebar.right.tab.menu.item') { MenuItems.push(Comp); MenuItemIds.push(def.id); }
          if (def?.name === 'conversation.composer.dock') DockComponent = Comp;
          // 0.15.12/0.16.0：左栏入口与中央列 main 座位。list 座位带 id（= main key）；
          // main 是 keyed 座位，按 key 派发。两者分别收下，用于断言成对且同名。
          if (def?.name === 'sidebar.panellist') PanelEntries.push({ id: def.id, order: def.order, label: def.label, Comp });
          if (def?.name === 'main') { MainKeys.push(def.key); MainComponents.set(def.key, Comp); }
          // 0.19.0：中央对话区的并列多会话视图。槽位注册的是**带 id 的视图定义**
          // （`conversation.view`），必须按 id 收下——「组件写对了但没注册到槽」
          // 在本插件里等于「用户点不到」，那正是这条要防的形态。
          if (def?.name === 'conversation.view' && def.id) ViewComponents.set(def.id, def);
          return () => {};
        },
      },
      // 标签页类型注册：收下定义，便于断言「各 kind 都存在且都是 page type」。
      sidebarRightTabs: { register: (def) => { if (def?.kind) TabDefinitions.set(def.kind, def); return () => {}; } },
      // 0.16.35：站点目录用 `openTab` 为选中站点开一个独立标签。桩必须真的记下
      //（kind + params），否则「点站点会发生什么」在护栏里没有任何证据。
      sidebarRight: {
        toggleExpanded() {},
        openTab(kind, options) { openTabCalls.push({ kind, params: (options && options.params) || null }); },
      },
      get: () => null,
    });
    assert.ok(PaneComponents.size > 0, 'sidebar.right.pane.tab 正文从未注册');
    assert.ok(SettingsComponent, 'settings.section 从未注册');

    const flush = () => new Promise((r) => realSetTimeout(r, 0));
    // 深度实例化：函数组件要**递归**展开——只展开顶层的话，嵌套的子组件
    // （如 PromptSection → PromptPanel）的 hooks 根本不会注册，它们的 useEffect
    // 也就永远不跑，测试会「跑得过」但什么也没证明（这正是 0.13.0 那条
    // 「护栏必须证明自己不是空转」的教训）。
    const instantiate = (el) => {
      if (Array.isArray(el)) return el.map(instantiate);
      if (el === null || el === undefined || typeof el !== 'object') return el;
      // 函数组件：**在一个组件作用域里**调用它（ownerStack 决定 hook 状态槽的
      // 归属，见上面 ownerKey 的注释），并继续展开它的返回值。
      // 作用域用「组件函数身份」区分同一个组件的多次调用。
      if (typeof el.type === 'function') {
        const fn = el.type;
        const identity = fn.name || 'anon';
        return instantiate(renderWithScope(() => fn(el.props), identity));
      }
      // 普通节点：必须递归进 children。
      //
      // 旧实现到这里就 `return el` 了，于是**整棵树只有根组件跑过一次**：根是
      // <section>，不是函数组件，递归当场终止——嵌套组件（PromptSection →
      // PromptPanel）的 useState/useEffect 从未注册，它们的请求也就从未发出。
      // 表现是护栏「跑得过」却什么都没验证（0.14.0 修首轮提示词默认显示时暴露：
      // 数据路径全通、只有嵌套面板停在「加载中」）。
      //
      // 这里**必须** `map(instantiate)` 而不是「只摊平、留待外层递归」：那样写会
      // 让本节点被外层再 instantiate 一次，而它仍不是函数组件 → 无限自套。
      return { ...el, children: (el.children || []).map(instantiate) };
    };
    const errors = [];
    /** which → 座位 key。标签页正文、中央列 main 面板、设置页、等待药丸各一条路径。 */
    // 0.16.35：右栏现在有**两个** kind——目录页（`dsh-webcode-bridge`）与站点网页
    //（`dsh-webcode-bridge/site`，一个站点一个标签）。
    //
    // 默认 `pane` 仍然指向**站点网页**：本文件绝大多数用例断言的是网页面板（工具条、
    // iframe、窗口状态、站点标签条），把默认值改成目录页会让它们集体变成「在测目录」
    // 而自己不知道。目录页用显式的 `which: 'catalog'`。
    const PANE_KEYS = {
      pane: 'dsh-webcode-bridge/site',
      site: 'dsh-webcode-bridge/site',
      catalog: 'dsh-webcode-bridge',
      // 0.19.0：`team: 'dsh-webcode-bridge/team'` 已随官方花名册 Team 面板一并删除。
    };
    // 0.16.18：任务板正文不再挂在 `sidebar.right.pane.tab` 上（右栏那份注册已按
    // 用户要求删除），它现在只由左栏 `sidebar.panellist` 行 + 同名 `main` 座位提供。
    // 因此 `which: 'tasks'` 去 MainComponents 取，而不是 PaneComponents。
    const TASKS_PANEL_ID = 'webcode-tasks-panel';
    const Target = which === 'settings' ? SettingsComponent
      : which === 'dock' ? DockComponent
        : which === 'tasks' ? MainComponents.get(TASKS_PANEL_ID)
          : PaneComponents.get(PANE_KEYS[which] || PANE_KEYS.pane);
    if (which === 'dock') assert.ok(DockComponent, 'conversation.composer.dock 从未注册');
    if (which === 'tasks') {
      assert.ok(Target, '未注册 main 座位 ' + TASKS_PANEL_ID
        + '（已注册：' + [...MainComponents.keys()].join(', ') + '）——任务板必须由左栏入口 + main 成对提供');
    } else {
      assert.ok(Target, '未注册座位 ' + which + '（已注册：' + [...PaneComponents.keys()].join(', ') + '）');
    }
    // 0.15.0：设置页的官方槽 inject 曾喂进**当前会话 id**（花名册的
    // subagentCatalog 是会话级投影，服务端要用它去 sessions.get(sessionId)）。
    // 旧 harness 直接 `Target()` 调，等于模拟了一个「inject 什么都没给」的宿主；
    // 这里改成把真实的 props 形状传进去，并把「拿不到会话身份」单独做成一个
    // 用例（见「任务板：读不到时必须给原因」那条），两种宿主行为都被覆盖。
    let tree = null;
    // 组件每次渲染都会调 useState(false) 重建菜单的开合状态，因此「打开菜单」必须
    // 是**渲染前**的常量条件，不能在渲染后翻转：桩是同步无状态的，翻转不会带来
    // 第二次渲染。openMenu 因此是 renderPane 的入参（mockRequire 直接闭包捕获它），
    // 与真机里的「用户先点了站点按钮」等价——差别只是这个点击发生在渲染之前。
    for (const p of payloads) {
      current = p;
      // 保留组件状态跨 pass 演进（异步 setState 需要在下一 pass 被读到），
      // 但在切换 payload 时清空——不同 payload 是不同场景，状态必须从头来。
      states = {}; effectSlots = {};
      for (let pass = 0; pass < 8; pass++) {
        cursor = 0; effectSlotCursor = 0; pendingEffects = [];
        // tabParams（0.16.35）：站点标签的正文从**自己的** navigation.params 读 siteId。
        // 桩按官方 TabHookContext 的契约把 `useTabInfo` 作为框架注入交给组件，
        // 与真机同形（官方 Browser 面板就是这么读 `tab.navigation.params?.url`）。
        // 0.16.39：目录页改用**本标签自己的**动作做「替代本标签页」（官方 guide 的
        // `replaceTab: true`）。桩把它记下来，否则这条官方语义在护栏里没有任何证据。
        // `noTabActions` 用来构造「宿主没给 actions」的旧环境，专测降级分支。
        const tabInfoStub = () => ({
          tab: {
            navigation: { params: tabParams, address: '', revision: 1 },
            ...(noTabActions ? {} : {
              actions: {
                openTab: (kind, options) => inPlaceOpenCalls.push({
                  kind,
                  replaceTab: Boolean(options && options.replaceTab),
                  params: (options && options.params) || null,
                }),
              },
            }),
          },
        });
        const paneProps = (tabParams === undefined && which !== 'catalog' && !noTabActions)
          ? scopedProps
          : { ...scopedProps, useTabInfo: tabInfoStub };
        try { tree = instantiate(Target(paneProps)); } catch (e) { errors.push(e); break; }
        for (const fn of pendingEffects) { try { fn(); } catch (e) { errors.push(e); } }
        await flush(); await flush(); await flush(); await flush();   // ← 异步 setState 必须在这里落地
      }
    }
    return {
      errors, windowHits, tree, menuItems: MenuItems, effectDisposers, openTabCalls, inPlaceOpenCalls,
      // 0.19.51：menu.item 注册时带的 id（真实 SlotCore 对 list 座位必填）。
      menuItemIds: MenuItemIds,
      tabDefinitions: TabDefinitions, paneKeys: [...PaneComponents.keys()],
      // 0.16.0：左栏入口与中央列 main 座位的登记结果。两个都返回，用例才能断言
      // 「成对且同名」——只看一半会放过「侧栏行存在但点了报未注册」那类缺陷。
      panelEntries: PanelEntries, mainKeys: MainKeys,
      // 0.19.0：conversation.view 槽位注册的视图定义（按 id）。用例据此断言
      // 「并列多会话真的挂在中央对话区」，而不是只断言源码里存在这个组件。
      viewDefinitions: ViewComponents,
      // 0.16.24：药丸 setInterval 的周期序列（静止 10000 / 在途 1000）。
      intervalDelays,
    };
  } finally {
    global.window = saved.window; global.document = saved.document;
    global.fetch = saved.fetch; global.setInterval = saved.setInterval; global.clearInterval = saved.clearInterval;
  }
}

/** 把渲染树里所有可见文本拼起来（树已由 instantiate 展开为纯节点）。 */
function treeText(el) {
  if (el === null || el === undefined || el === false || el === true) return '';
  if (typeof el === 'string' || typeof el === 'number') return String(el);
  if (Array.isArray(el)) return el.map(treeText).join(' ');
  if (typeof el.type === 'function') return treeText(el.type(el.props));
  return (el.children || []).map(treeText).join(' ');
}

/**
 * 收集渲染树里所有节点的指定属性值。
 *
 * 0.14.5 起右栏把「登录态」从可见文案改成 8px 色点（见 client.cjs 的 statusDot），
 * 状态词只存在于 title/aria-label。护栏因此需要能读到属性——只读可见文本的话，
 * 「美化把状态信息弄丢」这类回归会完全测不出来（点还在、话没了）。
 */
function treeAttrs(el, names, out = []) {
  if (el === null || el === undefined || typeof el !== 'object') return out;
  if (Array.isArray(el)) { for (const c of el) treeAttrs(c, names, out); return out; }
  if (typeof el.type === 'function') return treeAttrs(el.type(el.props), names, out);
  const props = el.props || {};
  for (const n of names) {
    const v = props[n];
    if (typeof v === 'string' && v) out.push(v);
  }
  for (const c of (el.children || [])) treeAttrs(c, names, out);
  return out;
}

const emptyWindows = { ok: true, siteId: 'deepseek', window: { open: false, headed: false }, windows: {} };
const oneWindow = { ok: true, siteId: 'deepseek', window: { open: true }, windows: { deepseek: { open: true } } };
const otherSiteWindow = { ok: true, siteId: 'deepseek', window: { open: true }, windows: { glm: { open: true } } };

test('右栏：没有独立窗口时渲染不得抛错（回归：面板全白）', async () => {
  const { errors, windowHits } = await renderPane({ payloads: [emptyWindows] });
  // 旧实现在这里报 TypeError: Cannot read properties of null (reading 'deepseek')
  assert.deepEqual(errors, [], 'windows={} 时渲染抛错：' + errors.map(e => e.message).join('; '));
  // 同时证明 effect 真跑了——否则状态停在初始 {}，这个断言是空转的
  assert.ok(windowHits > 0, '组件没有轮询 /__webcode/window，渲染未真正发生');
});

test('右栏：窗口状态切换（无窗 ↔ 有窗 ↔ 他站有窗）全程稳定', async () => {
  const { errors } = await renderPane({ payloads: [emptyWindows, oneWindow, otherSiteWindow, emptyWindows] });
  assert.deepEqual(errors, [], '状态切换时渲染抛错：' + errors.map(e => e.message).join('; '));
});

test('设置面板：发送间隔行与「发送前等待」统计条渲染不抛错', async () => {
  // Settings 依赖 status/settings/models 三个接口；status 里带 sendWaitMs>0 +
  // rateLimitRetries 的 metrics，证明新增的等待条与限流重试文案走的是真实渲染路径。
  const { errors } = await renderPane({ payloads: [emptyWindows], which: 'settings' });
  assert.deepEqual(errors, [], '设置面板渲染抛错：' + errors.map(e => e.message).join('; '));
});

// ------------------------------------------------------------------ 0.14.0

test('设置面板：首轮提示词默认就显示，且**按网站逐行**列出', async () => {
  // 用户原话（0.14.0）：「设置界面提示词应该默认就显示，首轮提示词又不会变？有多的
  // 适配就可选择框选择列出」。旧实现折叠在 <details> 里，不点开页面上一个字都没有。
  //
  // 用户原话（0.16.25）：「改为以网站为导向列出，每行一个网站，然后后面选择框
  // 选择已有协议中的一个」。因此这里断言的是**逐站点行**与每行自己的协议文本，
  // 而不是「下拉里列出了几个协议」——后者在按协议列时也成立，测不出本次改动。
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], which: 'settings' });
  assert.deepEqual(errors, [], '设置面板渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  // 两个站点各一行，且各自显示**自己实际会用的协议**的模板全文。
  // （deepseek 走官方模板、glm 走代码块——若 UI 拿同一份文本填所有行，这里会红。）
  assert.ok(text.includes('DeepSeek 网页版'), '未按网站列出 deepseek 行');
  assert.ok(text.includes('智谱清言 (GLM)'), '未按网站列出 glm 行');
  // 0.19.31（用户 2026-09-27）：「所有界面的查看提示词里面的『查看完整模板』改为不是
  // 展开而是直接打开默认的程序打开文件」—— 模板正文不再渲染进界面，改由路径 +
  // 「查看」按钮打开文件。因此这里不再断言两段模板全文，改钉**每行各自的路径**
  //（若 UI 拿同一份路径填所有行，这条照样会红——它测的是「逐站点行」这件事本身）。
  assert.ok(text.includes('deepseek.md'), 'deepseek 行未渲染它自己的提示词文件路径');
  assert.ok(text.includes('glm.md'), 'glm 行未渲染它自己的提示词文件路径');
  // 「实际使用」标注必须在（用户要能分辨「预览」与「生效」）。
  assert.ok(/实际使用：/.test(text), '每行必须标出该网站实际在用的协议');
  // 协议名要能在行内读到（0.16.38 去掉了「预览下拉」——它从来只能预览，用户
  // 真正要的是「这个站点用哪一支 + 它的提示词文件在哪」）。
  assert.ok(text.includes('DeepSeek 官方模板'), '未标出 deepseek 实际使用的协议');
  assert.ok(text.includes('GLM 代码块'), '未标出 glm 实际使用的协议');
  // 全局指令仍是可编辑的
  assert.ok(text.includes('保存全局指令'), '全局指令编辑区未默认渲染');
});

test('★ 0.16.38 设置页作用域：全局页与站点页各只有自己那一半卡片', async () => {
  // 用户原话：「将全局界面设置『账户与登录管理』『首轮提示词』入口删除……然后模型
  // 每个网站例如『deepseek』标签页 —— 请你将『正在运行（子代理 / Team）』『模型管理』
  // 『提示词投递』『会话与子代理』一样界面表面删除 —— 两者逻辑上单独适配全局和单独
  // 站点！你却全都有放置，请你按照我的要求删除对应 UI」。
  //
  // 这条钉子把「哪张卡属于哪一页」变成可执行的：全局页不得出现账户/站点提示词，
  // 站点页不得出现那五张全局卡。
  const global = await renderPane({ payloads: [emptyWindows], which: 'settings' });
  assert.deepEqual(global.errors, [], '全局页渲染抛错：' + global.errors.map(e => e.message).join('; '));
  const gt = treeText(global.tree);
  assert.ok(!gt.includes('的账户与登录'), '全局页不该有站点账户卡');
  assert.ok(!gt.includes('的首轮提示词'), '全局页不该有站点提示词卡');
  assert.ok(!gt.includes('的模型'), '全局页不该有站点模型卡');
  // 0.19.x：「正在运行（子代理 / Team）」卡已按用户要求删除，故不在 keep 列表里；
  // 它的「不得复活」由下面「文案精简」用例的反向断言钉住。
  // 0.19.59：「连接」整卡也按用户要求删除（见下一条反向断言），故同样不在 keep 列表里。
  for (const keep of ['提示词投递', '速度与等待', '会话与子代理', '全局指令', '发送间隔（全局）']) {
    assert.ok(gt.includes(keep), '全局页缺少卡片：' + keep);
  }
  // 「连接」卡删除的三样东西逐一反向断言：运行读数（中继已连接）、重复入口
  //（主线落点 + 去配置 X）、以及那个恒开的开关（启用网页自动化）。
  for (const gone of ['中继已连接', '启用网页自动化', '去配置 ']) {
    assert.ok(!gt.includes(gone), '「连接」卡又回来了（出现：' + gone + '）');
  }
  const site = await renderPane({ payloads: [emptyWindows], which: 'settings', settingsTab: 'deepseek', sites: [
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true },
  ] });
  assert.deepEqual(site.errors, [], '站点页渲染抛错：' + site.errors.map(e => e.message).join('; '));
  const st = treeText(site.tree);
  assert.ok(st.includes('DeepSeek 的账户与登录'), '站点页缺少该站点的账户卡');
  assert.ok(st.includes('DeepSeek 的首轮提示词'), '站点页缺少该站点的提示词卡');
  assert.ok(st.includes('DeepSeek 的模型'), '站点页缺少该站点的模型卡');
  for (const gone of ['正在运行（子代理 / Team）', '提示词投递', '会话与子代理', '全局指令', '发送间隔（全局）']) {
    assert.ok(!st.includes(gone), '站点页不该出现全局卡片：' + gone);
  }

  // 全局指令编辑区**只能有一个**（0.16.38 自查发现并修掉的缺陷）：拆分卡片时
  // 「全局指令」卡与 PromptSection 同时渲染了 GlobalPrompt，同一设置在界面上出现
  // 两个输入框——改一个另一个不知道，保存后互相覆盖。数量断言才是这条的判据：
  // 「存在」在有两个的时候同样为真。
  const count = (s, sub) => s.split(sub).length - 1;
  assert.equal(count(gt, '保存全局指令'), 1, '全局页的全局指令编辑区必须**恰好一个**');
  assert.equal(count(st, '保存全局指令'), 0, '站点页不得出现全局指令编辑区');
  // 站点提示词卡（文件 + 本网站指令）只属于站点页。
  assert.equal(count(st, '提示词文件'), 1, '站点页必须恰好有一个提示词文件行');
  assert.equal(count(gt, '提示词文件'), 0, '全局页不得出现站点提示词文件行');
  // 站点页的模型下拉在目录**未加载**时必须是「加载中」，不得是空下拉
  //（空数组是真值，ModelSelect 的 `if (!models)` 兜不住它——那会看起来像
  // 「这个站点没有模型」，而真相是「还没读到」）。此处目录已加载，故只钉
  //「该站点那一支必须在」这一半。
  assert.ok(st.includes('本网站默认模型'), '站点页缺少本网站默认模型行');
});

test('★ 0.19.x 设置页文案：解释性长句与开发者自用读数不得回潮', async () => {
  // 用户原话：「需要参考官方解释长短以及功能安排 UI」——一行标签 + 一行状态/动作，
  // 解释留文档不留界面。这条把本轮删掉的句子钉成反向断言（删掉即回潮）。
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], which: 'settings' });
  assert.deepEqual(errors, [], '全局页渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  const src = bridgeSrcFrom('client.cjs');
  // 5.1 整卡删除（含因此成死代码的组件）。
  assert.ok(!text.includes('正在运行（子代理 / Team）'), '设置页又出现「正在运行（子代理 / Team）」卡');
  assert.ok(!/function AgentRoster/.test(src), 'AgentRoster 组件不该复活（唯一的卡已删）');
  // 5.2 限流退避的机制说明不再占用设置页。
  assert.ok(!/自动退避重试/.test(text), '限流退避解释回潮了：' + text.slice(0, 400));
  // 5.3 附件探针（开发者自用工具）与真机事故叙述不得出现在用户设置界面。
  assert.ok(!/附件探针/.test(text), '设置页又出现「附件探针」');
  assert.ok(!/最近一次实际投递/.test(text), '设置页又出现「最近一次实际投递」');
  assert.ok(!/41\.7 万字符/.test(text), '设置页又出现真机事故叙述');
  assert.ok(!/runAttachProbe|probeBusy/.test(src), '探针的客户端接线应随卡片一并删除');
  // 5.4 「连接」整卡**已删除**（0.19.59，用户原话：「……都不显示，就是去除那一框，
  // 内部都是默认全开启」）。旧断言钉的是「卡还在、但要写短状态」——卡本身没了，
  // 于是判据改成**反向**：那三样东西（运行读数 / 重复入口 / 恒开的勾选框）都不得复活。
  assert.ok(!/中继已连接/.test(text), '「连接」卡的网页服务行复活了');
  assert.ok(!/启用网页自动化/.test(text), '「启用网页自动化」勾选框复活了（开关恒开、界面不得再有入口）');
  assert.ok(!/已永久保存到本机/.test(text), '连接卡又写了一整句解释');
  // 勾选框的**接线**也必须一并消失：留着 `action('consent', …)` 或那个 checkbox
  // 就是「界面上没有这个开关，代码里却还在改它」——那正是本项目记过的「静默行为」形状。
  // 判据写成**代码形状**而不是某句文案：文案在注释里被引用是正常的，
  // 用文案去断言会把注释一起误伤（本文件上方记过「判据范围过宽」的教训）。
  assert.ok(!/action\('consent'/.test(src), 'consent 动作的客户端接线应随勾选框一并删除');
  assert.ok(!/type: 'checkbox', checked: consent/.test(src), '恒开开关的勾选框接线不得残留');
  // 5.9 开发者向的内部机制描述不出现在界面上。
  assert.ok(!/回落链/.test(text), '设置页又写了「回落链」这类内部机制');
  // 5.9 等待口径那句长解释（「发送间隔补满 + 限流退避重试…同源同口径」）压成一句。
  assert.ok(!/发送间隔补满/.test(text), '等待口径的长解释回潮了：' + text.slice(0, 400));
  // 界面文案不得出现字面 `**`（它是 markdown 记号，渲染出来就是两个星号）。
  assert.ok(!/\*\*/.test(text), '设置页可见文案里出现了字面 ** —— 那是 markdown 记号，用户看到的是星号');
  // 5.7 全局指令说明只出现一次（用户报「重复！」）。
  const count = (s, sub) => s.split(sub).length - 1;
  assert.equal(count(text, '追加一段 [全局指令] 注入每个新网页会话的首条消息。'), 1,
    '全局指令说明重复出现');
  // 5.8 首轮提示词只读卡的信息面不因美化而丢。
  // 0.19.31（用户 2026-09-27）：「查看完整模板」不再原地展开，改为打开默认程序，
  // 按钮改名「查看」且放在路径右边 —— 因此模板正文**本来就不该**再出现在界面上
  //（它只在文件里，那是唯一正本）；这里改钉「路径 + 查看按钮」这一对新信息面。
  for (const keep of ['DeepSeek 网页版', '实际使用：', '本会话工具：', '查看']) {
    assert.ok(text.includes(keep), '首轮提示词卡丢了信息：' + keep);
  }
  assert.ok(!/查看完整模板/.test(text),
    '「查看完整模板」必须消失 —— 用户要求改为直接打开文件、按钮改名「查看」');
  // 判据只看 PromptPanel（全局页那张卡）的函数体：站点页那张卡仍保留
  // 「查看该站点此刻的只读模板」的 <details>（用户只要求全局页那处改为打开文件），
  // 因此按整文件断言会误伤它 —— 这是本仓库反复记过的「判据范围过宽」
  const pAt = src.indexOf('function PromptPanel(');
  assert.ok(pAt > 0, '找不到 PromptPanel（改名则本护栏失效，需同步）');
  const pBody = src.slice(pAt, src.indexOf('\n    function ', pAt + 10));
  assert.ok(!/hwb-site-prompt-details/.test(pBody),
    '全局页的提示词行不得再有原地展开的 <details>（用户要求改为打开默认程序）');
  assert.ok(!/row\.text/.test(pBody),
    '全局页不得再渲染模板正文 —— 它只在文件里（那是唯一正本）');
});

/**
 * 控件不得探出卡片（0.19.7）。
 *
 * 用户原话（2026-09-24）：「输入框超出卡片框！」。根因是**盒子模型**：设置页的
 * `.hwb-model-select` / `.hwb-prompt-input` 与任务板弹窗的 `.hwb-input` / `.hwb-select`
 * 当时都没有 `box-sizing:border-box`，于是 `width:100%` / `max-width:340px` 是**内容盒**
 * 宽度，加上左右 padding 与边框就比容器宽二十来像素；`.hwb-card` 又没有 `overflow:hidden`，
 * 看起来就是输入框从卡片边框里探出来。
 *
 * 判据写成「规则文本里必须同时出现那两条声明」而不是截图比对：这是纯 CSS 事实，
 * 可机检；且**反向验证**很直接——删掉 `box-sizing` 这条用例立刻变红。
 */
test('★ 0.19.7 设置页控件不得探出卡片：控件规则必须带 box-sizing:border-box', () => {
  const src = bridgeSrcFrom('client.cjs');
  // 逐条按**源码顺序**检查，并允许「基础规则定了盒子模型、后续规则只覆盖别的属性」
  // 这种正常写法（级联里同一个元素两条规则是合规的）。
  const rules = [...src.matchAll(/"(\.hwb-(?:model-select|prompt-input|input|select|textarea)[^"]*)\{([^}]*)\}"/g)];
  assert.ok(rules.length >= 3, '控件 CSS 规则解析失败（只找到 ' + rules.length + ' 条）——先修本测试的解析');
  let sawBoxSizing = false;
  let sawMaxWidth = false;
  let base = null;
  for (const rule of rules) {
    if (/box-sizing:border-box/.test(rule[2])) { sawBoxSizing = true; if (!base) base = rule; }
    if (/max-width:(?:100%|\d)/.test(rule[2])) sawMaxWidth = true;
  }
  assert.ok(sawBoxSizing,
    '控件的 CSS 里没有 box-sizing:border-box —— width:100%/max-width 会按内容盒算并探出卡片');
  assert.ok(sawMaxWidth,
    '控件的 CSS 里没有 max-width —— 窄面板下会打穿卡片边框');
  // 每一条声明了 width:100% 的控件规则，仍必须能落在一个已声明 border-box 的规则上；
  // 这里用「同一选择器组」判据把最常见的那种回归（有人把基础规则删掉）钉住。
  assert.ok(base, '缺少带 box-sizing 的基础控件规则');
  for (const sel of ['.hwb-model-select', '.hwb-prompt-input']) {
    assert.ok(base[1].includes(sel),
      '基础规则 ' + base[1] + ' 必须覆盖 ' + sel + '（否则该控件又按内容盒算）');
  }
  // 标题行的项目链接（用户要求：设置界面顶部加 GitHub 连接）。
  assert.match(src, /className: 'hwb-settings-head'/, '设置页标题行容器不见了（GitHub 链接挂在它里面）');
  assert.match(src, /href: 'https:\/\/github\.com\/[^']+'/, '设置页顶部缺少 GitHub 项目链接');
  assert.match(src, /\.hwb-repo-link\{/, '缺少项目链接的样式规则');
});

/**
 * 提示词模板那条路径读数不得探出卡片（0.19.31）。
 *
 * 用户原话（2026-09-27）：「…的一行显示路径的，就是提示词模板那里，他的框都超出来了」。
 *
 * 根因与上面 0.19.7 那条**逐字相同**，只是这次落在另一条规则上：
 * `.hwb-site-prompt-path` 是 `display:block;width:100%`，而 `.hwb-filepath`
 * 当时没有 `box-sizing:border-box` ⇒ `width:100%` 按**内容盒**算，再加左右各 8px
 * padding 就比 `.hwb-site-prompt` 卡片的内容盒宽 16px；卡片没有 `overflow:hidden`，
 * 于是路径框从卡片右缘探出。
 *
 * 为什么单独一条、不并进上面那条：上面按选择器枚举**控件族**（model-select /
 * prompt-input / input / select / textarea），而路径读数是**只读读数**、刻意不进输入框
 * 样式族；塞进那个列表会让两条判据的语义互相污染。反向验证很直接：删掉
 * `box-sizing:border-box`，本条立刻变红。
 */
test('★ 0.19.31 提示词路径读数不得探出卡片（同一个盒子模型缺陷不得复发）', () => {
  const src = bridgeSrcFrom('client.cjs');

  // ① 基础读数规则必须定死盒子模型。
  const base = src.match(/"(\.hwb-filepath)\{([^}]*)\}"/);
  assert.ok(base, '找不到 .hwb-filepath 规则（改类名则本护栏失效，需同步）');
  assert.match(base[2], /box-sizing:border-box/,
    '.hwb-filepath 缺 box-sizing:border-box —— padding 会让它比容器宽 16px 并探出卡片');

  // ② 撑满一行的那条必须同时封顶，不得只靠 `width:100%` 单撑。
  const path = src.match(/"(\.hwb-site-prompt-path)\{([^}]*)\}"/);
  assert.ok(path, '找不到 .hwb-site-prompt-path 规则');
  assert.match(path[2], /width:100%/, '路径读数应当撑满所在卡片一行');
  assert.match(path[2], /max-width:100%/,
    '.hwb-site-prompt-path 必须有 max-width:100% 兜底 —— 只写 width:100% 时一旦盒子模型被改回内容盒就会探出卡片');
});

/**
 * 站点提示词卡：模板正文与增量再教学必须是**同一种框**，且两框有间隔（0.19.31）。
 *
 * 用户原话（2026-09-27）：「各个站点的：『查看该站点此刻的只读模板 / 实际使用：DeepSeek
 * 官方模板（原生工具调用格式）』区域，让增量也通过上面一样的框展示，然后两框注意间隔」。
 *
 * 判据分两半，因为这两个事实在不同层：
 *   · 「都用一样的框」是**结构**事实——两块正文都得是 `<pre>`，样式才会同时落在
 *     `.hwb-import pre` 那条规则上（同一条规则 = 逐项相同，不靠两处手抄）；
 *   · 「两框有间隔」是**CSS** 事实——`.hwb-site-prompt-frames` 的 `gap`，渲染树里读不到。
 * 上一版增量只是一行 `.hwb-hint`（没有框），所以这一条的反向验证很直接：
 * 把第二块改回 `<p className="hwb-hint">` 或删掉 gap，本用例立刻变红。
 */
test('★ 0.19.31 站点提示词卡：模板与增量轮再教学同框展示，且两框有间隔', async () => {
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'settings', settingsTab: 'deepseek',
    sites: [{ siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true }],
  });
  assert.deepEqual(errors, [], '站点页渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  // 两段正文都真的渲染到了（夹具：deepseek 走 official，trainNote = 'tn3'）。
  assert.ok(text.includes('实际使用：DeepSeek 官方模板（原生工具调用格式）'),
    '模板框缺「实际使用」读数：' + text.slice(0, 400));
  assert.ok(text.includes('OFFICIAL-PROMPT-TEXT'), '模板框缺模板正文');
  assert.ok(text.includes('增量轮再教学'), '增量框不见了（用户要求它也用框展示）');
  assert.ok(text.includes('tn3'), '增量框缺该站点自己那一支的再教学正文');

  // 结构：两块正文都必须是 <pre> —— 否则「一样的框」就不成立。
  const src = bridgeSrcFrom('client.cjs');
  const at = src.indexOf('function SitePromptCard(');
  assert.ok(at > 0, '找不到 SitePromptCard（改名则本护栏失效，需同步）');
  const body = src.slice(at, src.indexOf('\n    function ', at + 10));
  const pres = [...body.matchAll(/h\('pre'/g)];
  assert.equal(pres.length, 2,
    '只读模板与增量再教学必须各有一个 <pre> 框（当前 ' + pres.length + ' 个）');
  assert.match(body, /hwb-site-prompt-frames/,
    '两框必须装在同一个容器里 —— 间隔由容器的 gap 给，不靠相邻元素 margin 的巧合');

  // CSS：容器真的声明了 gap，且框内标题行不得再加自己的 margin-top（会与 gap 叠加）。
  const frames = src.match(/"(\.hwb-site-prompt-frames)\{([^}]*)\}/);
  assert.ok(frames, '找不到 .hwb-site-prompt-frames 规则');
  assert.match(frames[2], /gap:8px/, '.hwb-site-prompt-frames 必须显式给 8px 间隔');
  assert.match(src, /"\.hwb-prompt-frame>\.hwb-hint\{margin:0\}"/,
    '框内标题行必须清零 margin-top —— 否则它与容器 gap 叠加，两框间距就不是 8px 了');
});

test('★ 0.16.35 站点目录：从上往下列出全部站点，且不显示登录态', async () => {
  // 用户原话：「文件夹，新建终端，浏览器，这几个是怎么排列？从上往下！我希望是点击
  // web bridg 后能够实现，一样的 deepseek，智谱，等这样排列」「登录态不要看」。
  //
  // 两条都钉在这里：① 十个站点**全部**按 SITE_NAMES 的顺序从上往下出现；
  // ② 登录态词（已登录/未登录/待检查）**不得**出现在目录的可见文本里——这是本轮
  // 的明确要求，不是遗漏。它仍存在于设置页「账户与登录管理」与右栏工具条状态点。
  // 夹具里的 `siteName`/`displayName` 一律用**网站原名**（2026-10-03 统一后的形态）：
  // `DeepSeek`（原 `DeepSeek 网页版`）、`GLM`（原 `智谱清言 (GLM)`）、
  // `Qwen`（原 `通义千问`）、`Doubao`（原 `豆包`）。
  const ten = [
    { siteId: 'deepseek', siteName: 'DeepSeek', initialized: true, loggedIn: true },
    { siteId: 'glm', siteName: 'GLM', initialized: false, loggedIn: true, loggedInCached: true, loginBasis: 'probe-fallback' },
    { siteId: 'chatgpt', siteName: 'ChatGPT', initialized: false, loggedIn: null, loginBasis: 'stale' },
    { siteId: 'kimi', siteName: 'Kimi', initialized: false, loggedIn: false },
    { siteId: 'qwen', siteName: 'Qwen', initialized: false, loggedIn: null },
    { siteId: 'doubao', siteName: 'Doubao', initialized: false, loggedIn: false },
    { siteId: 'grok', siteName: 'Grok', initialized: false, loggedIn: null },
    { siteId: 'claude', siteName: 'Claude', initialized: false, loggedIn: null },
    { siteId: 'gemini', siteName: 'Gemini', initialized: false, loggedIn: null },
    { siteId: 'zai', siteName: 'Z.ai', initialized: false, loggedIn: true, loggedInCached: true },
  ];
  const empty = await renderPane({ payloads: [emptyWindows], which: 'catalog' });
  assert.deepEqual(empty.errors, [], '空站点表渲染抛错：' + empty.errors.map(e => e.message).join('; '));
  const full = await renderPane({ payloads: [emptyWindows], sites: ten, which: 'catalog' });
  assert.deepEqual(full.errors, [], '十站点表渲染抛错：' + full.errors.map(e => e.message).join('; '));
  const text = treeText(full.tree);
  for (const n of ['DeepSeek', 'GLM', 'Kimi', 'Doubao', 'Z.ai']) {
    assert.ok(text.includes(n), '站点目录缺少 ' + n);
  }
  // 登录态不显示（用户明确要求）。
  for (const s of ['已登录', '未登录', '待检查']) {
    assert.ok(!text.includes(s), '站点目录里不该出现登录态「' + s + '」——用户要求「登录态不要看」');
  }
  // 但图标挂点必须在。
  const html = JSON.stringify(full.tree);
  assert.ok(html.includes('hwb-catalog-ico'), '站点目录行缺少图标挂点');
  // 0.19.35（用户原话）：「右侧鼠标悬浮在矢量图时候会有的说明去除显示」。
  // 这条**反转**了 0.16.36 的方向：此前要求档位说明必须出现在 title 里，现在要求
  // 悬浮不弹说明。判据按「这个挂点上没有 title」写，而不是删掉整条用例——
  // 删掉就等于「以后再挂回来也没人知道」。
  const glyphTitles = treeAttrs(full.tree, ['title'])
    .filter(t => typeof t === 'string' && /矢量|图标|来源|鲸鱼|lobehub|simple-icons/.test(t));
  assert.deepEqual(glyphTitles, [], '矢量图挂点上不得再有悬浮说明，实得：' + glyphTitles.join(' | '));
});

/**
 * 0.16.35：点目录里的一行 = 为该站点**新开一个独立标签**。
 *
 * 这是「一行并列显示不同网址栏目」的实现路径：`kind` 必须声明 `multiple: true`
 *（否则同名标签会被去重成同一个），并且开标签时要把 `siteId` 放进 params——
 * 站点标签的正文正是从自己的 params 读身份（见下一条用例）。
 *
 * 用桩收下的 `openTab` 调用做**行为**断言，而不是查源码里有没有那行字符串：
 * 前者能证明「点了真的会开标签、开的是哪个站点」，后者只能证明有人写过这句话。
 */
test('★ 0.16.35 站点目录：点一行会为该站点开标签，并带上 siteId', async () => {
  // 0.16.39 收尾：解构必须带上 inPlaceOpenCalls——下方断言从 openTabCalls 改到它，
  // 少了这一列会 ReferenceError（gate 只在夹具里收下 inPlaceOpenCalls 却没在断言侧解构）。
  const { errors, tree, openTabCalls, inPlaceOpenCalls, tabDefinitions } = await renderPane({ payloads: [emptyWindows], which: 'catalog' });
  assert.deepEqual(errors, [], '站点目录渲染抛错：' + errors.map(e => e.message).join('; '));
  const def = tabDefinitions.get('webcode-site');
  assert.ok(def, '未注册站点网页标签类型 webcode-site');
  assert.equal(def.multiple, true, '站点标签类型必须 multiple:true —— 否则多个站点会挤成一个标签');
  // 找到目录里「GLM」那一行的按钮并点它（真实调用链，不是直接调函数）。
  // ⚠ 2026-10-03：站点显示名已统一成**网站原名**（`智谱清言` → `GLM`），
  // 因此这里找行的字面量随之改为 `GLM`。判据本身（点一行 → 为该站点开标签）
  // 一个字都没动——改的是它要匹配的显示名。参照站仍取 GLM：它排第 2，能顺带
  // 证明「不是只有第一行可点」。
  const buttons = [];
  const collect = (el) => {
    if (!el || typeof el !== 'object') return;
    if (Array.isArray(el)) { el.forEach(collect); return; }
    if (el.props && el.props.className && /hwb-site-main/.test(String(el.props.className)) && typeof el.props.onClick === 'function') {
      buttons.push(el);
    }
    (el.children || []).forEach(collect);
  };
  collect(tree);
  assert.ok(buttons.length >= 10, '站点目录行不足（实际 ' + buttons.length + '）');
  const glmRow = buttons.find(b => treeText(b).includes('GLM'));
  assert.ok(glmRow, '目录里找不到「GLM」行');
  glmRow.props.onClick();
  // 0.16.39：目录页改走**本标签自己的**动作（官方 guide 的做法），因此这条断言
  // 从「ctx.sidebarRight.openTab 被调用」改成「tab.actions.openTab 被调用，且带
  // replaceTab:true」——后者才是「选站点**替代**本标签页」的可执行证据。
  assert.equal(inPlaceOpenCalls.length, 1, '点站点行没有走本标签的 openTab');
  assert.equal(inPlaceOpenCalls[0].kind, 'webcode-site', '开标签用错了 kind：' + inPlaceOpenCalls[0].kind);
  assert.equal(inPlaceOpenCalls[0].params && inPlaceOpenCalls[0].params.siteId, 'glm',
    'openTab 没有带上 siteId —— 新标签不知道自己是哪个站点');
  assert.equal(inPlaceOpenCalls[0].replaceTab, true,
    '必须带 replaceTab:true —— 否则目录标签会被保留（用户报的「新开/保留 web」）');
  // 旧路径**不得**同时被调用：两条路一起走会开出两条标签。
  assert.equal(openTabCalls.length, 0, '走了本标签动作时不得再调 ctx.sidebarRight.openTab');
});

/**
 * 0.16.39：拿不到本标签动作时必须**降级**成旧行为，而不是什么都不做。
 *
 * 官方 `tab.actions` 只在标签被宿主正式挂载时才存在（旧版右栏 / 精简桩没有）。
 * 这一条钉住「降级不是崩溃」：那种环境下点站点仍然会开标签，只是目录不会被顶掉。
 */
test('★ 0.16.39 站点目录：拿不到本标签动作时降级为 ctx.sidebarRight.openTab', async () => {
  // 这里刻意**不**走 catalog 的默认桩（which:'catalog' 会给 actions），改从 pane
  // 座位取目录组件——pane 座位的 useTabInfo 桩没有 actions 字段。
  const { errors, tree, openTabCalls, inPlaceOpenCalls } = await renderPane({
    payloads: [emptyWindows], which: 'catalog', noTabActions: true,
  });
  assert.deepEqual(errors, [], '降级路径渲染抛错：' + errors.map(e => e.message).join('; '));
  const buttons = [];
  const collect = (el) => {
    if (!el || typeof el !== 'object') return;
    if (Array.isArray(el)) { el.forEach(collect); return; }
    if (el.props && el.props.className && /hwb-site-main/.test(String(el.props.className)) && typeof el.props.onClick === 'function') buttons.push(el);
    (el.children || []).forEach(collect);
  };
  collect(tree);
  const glmRow = buttons.find(b => treeText(b).includes('GLM'));
  assert.ok(glmRow, '降级路径下目录里找不到「GLM」行');
  glmRow.props.onClick();
  assert.equal(inPlaceOpenCalls.length, 0, '没有 actions 时不该调 tab.actions.openTab');
  assert.equal(openTabCalls.length, 1, '降级路径必须仍然开标签（否则点了没反应）');
  assert.equal(openTabCalls[0].params && openTabCalls[0].params.siteId, 'glm');
});

/**
 * 0.16.35：站点标签的正文从**自己的** navigation.params 读站点。
 *
 * 官方 Browser 面板就是这么读 `tab.navigation.params?.url` 的
 *（dsh-client-ui-sidebar-browser/lib/client.js:251）。不这么做就只能靠「最后一个
 * 挂载的面板」猜站点——那正是「两个标签互相改对方」的根因。
 */
test('★ 0.16.35 站点标签：正文与标题都从本标签的 navigation.params 取 siteId', async () => {
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'site', tabParams: { siteId: 'kimi', slot: '' },
  });
  assert.deepEqual(errors, [], '站点标签正文渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(text.includes('Kimi'), '站点标签正文没有切到 params 指定的站点');
  assert.ok(!text.includes('DeepSeek 网页版'), '站点标签仍停在默认站点 —— params 没被用起来');
  // 标题（标签芯片上的字）走**同一个**来源函数。
  //
  // 断言方式是「两处共用 siteTabParams」，而不是分别检查各写一遍 navigation/siteId：
  // 后者在源码里写两遍也会通过，而那正是「标题写着 Kimi、正文却是 DeepSeek」的成因。
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(/sidebar\.right\.pane\.tab\.title/.test(src), '未注册站点标签标题座位');
  assert.ok(/const siteTabParams = \(props\) =>/.test(src), 'siteTabParams 读取函数不存在');
  const reader = src.indexOf('const siteTabParams');
  const readerBody = src.slice(reader, reader + 700);
  assert.ok(/navigation/.test(readerBody) && /siteId/.test(readerBody),
    'siteTabParams 没有从 navigation.params 取 siteId');
  const titleBody = src.slice(src.indexOf('const SiteTabTitle'), src.indexOf('const SiteTabTitle') + 400);
  assert.ok(/siteTabParams\(props\)/.test(titleBody),
    'SiteTabTitle 没有复用 siteTabParams —— 标题与正文会各读一份、迟早漂移');
  const convBody = src.slice(src.indexOf('const SiteTabBody'), src.indexOf('const SiteTabBody') + 500);
  assert.ok(/siteTabParams\(props\)/.test(convBody),
    'SiteTabBody 没有复用 siteTabParams');
  // 槽也必须传下去（否则「选账户2」等于没选）。
  assert.ok(/slot/.test(convBody), 'SiteTabBody 没有把 slot 传给面板');
});

test('右栏：注册全部走 ctx.effect，并把「刷新 / 独立窗口」挂进标签动作菜单', async () => {
  // 0.14.0 的 DSH 规范化：注册不再是「注册完把 disposer 塞进数组」，而是交给
  // ctx.effect（宿主统一回收，热重载不会留下重复注册——tab-registry 明确把
  // 「重复 id」判为 wiring mistake）。动作入口也按官方 slot 挂到标签菜单上。
  const { errors, menuItems, effectDisposers, menuItemIds } = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(errors, [], '渲染抛错：' + errors.map(e => e.message).join('; '));
  assert.ok(effectDisposers.length >= 4, '注册未被 ctx.effect 接管（disposer 数：' + effectDisposers.length + '）');
  // 菜单项：刷新 + 独立窗口，各一个
  assert.equal(menuItems.length, 2, '标签动作菜单项应有两个，实际 ' + menuItems.length);
  // 0.19.51：list 座位的注册选项必须带 id，且两项互不相同（真实 SlotCore 对
  // list 座位硬性要求 id；同 id 二次注册也会被拒）。
  assert.deepEqual(new Set(menuItemIds).size, 2, '两个菜单项必须各带互不相同的 id，实得：' + menuItemIds.join(', '));
  assert.ok(menuItemIds.every((x) => typeof x === 'string' && x.length > 0), '菜单项 id 必须是非空字符串');
  // 菜单项必须能安全渲染，并如实说明作用于哪个站点。
  //
  // 0.15.12：菜单项现在**只对网页标签页显示**（官方契约原文：「Entries decide
  // their own visibility from the tab they are given」）。owner 必须带 tab——
  // 旧用例只给 dismiss，等于模拟了一个「没有 tab 的菜单」，那在新契约下应当
  // 返回 null（隐藏），因此这里按真实 owner 形状喂进去。
  for (const Item of menuItems) {
    // 非网页标签页：必须隐藏（返回 null）。夹具用 `webcode-tasks`（0.16.18 起
    // 已不存在的任务板 kind）——它代表的正是「本插件自己注册的**非网页**面板」；
    // 0.19.0 起右栏还有 `webcode-team` 也属于这一类，但那个 kind 已随官方花名册
    // 面板删除，用已删的 kind 做夹具等于在测一个不存在的场景。
    assert.equal(Item({ dismiss: () => {}, tab: { kind: 'webcode-tasks' } }), null,
      '菜单项在非网页标签页上也渲染了——点下去会作用到别的面板');
    let el;
    assert.doesNotThrow(() => { el = Item({ dismiss: () => {}, tab: { kind: 'webcode-bridge' } }); });
    const t = treeText(el);
    assert.ok(t.length > 0, '菜单项没有可见文案');
    assert.match(t, /刷新网页|切换独立窗口/);
  }
});

/**
 * ★ 0.19.51 反向验证：桩对 list 座位缺 `id` 必须拒绝。
 *
 * 为什么要有这条：0.19.50 及以前，两处 menu.item 注册都不带 `id`，而真实
 * SlotCore 对 list 座位硬性要求它 ⇒ 真机上两项菜单**从未出现过**，旧桩却
 * 放行了那个形状、全量单测全绿。桩升级之后，必须先证明「升级后的桩真能红」
 * ——否则它只是一条新的、永远绿的摆设（本仓库 §9.3 的纪律：护栏先红后绿）。
 *
 * 做法：直接以 0.19.50 的**缺陷形状**（无 id）调桩里的 register，
 * 断言它抛出与真实 SlotCore 同族的报错。真实宿主的报错原文是
 * `list slot "sidebar.right.tab.menu.item" requires options.id`。
 */
test('★ 0.19.51 反向验证：menu.item 缺 id 时桩必须拒绝（真实 SlotCore 会抛）', async () => {
  // 桩藏在 renderPane 内部，这里用同一条判据独立复刻一次调用形状，
  // 并同时用**真实 SlotCore** 钉住宿主侧行为（装了 dsh 才跑，找不到就跳过并说明）。
  const fsMod = await import('node:fs');
  const os = await import('node:os');
  const slotsDir = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
    '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-slots', 'lib');
  if (fsMod.existsSync(path.join(slotsDir, 'index.js'))) {
    const { SlotCore } = await import('file://' + path.join(slotsDir, 'index.js').replace(/\\/g, '/'));
    const core = new SlotCore();
    core.registerFactory(
      { name: 'probe.parent', scope: 'session',
        children: { 'probe.list': { kind: 'list', scope: 'session' } } },
      () => null,
    );
    assert.throws(
      () => core.register({ name: 'probe.list' }, () => null),
      /requires options\.id/,
      '真实 SlotCore 不再拒绝缺 id 的 list 注册——官方语义变了，需同步本插件的桩与注册',
    );
    assert.doesNotThrow(() => core.register({ name: 'probe.list', id: 'probe-x' }, () => null),
      '带 id 的合法注册被真实 SlotCore 拒绝——探针形状写错了');
  } else {
    console.log('skip（本机未装 dsh，跳过真实 SlotCore 侧的反向验证）');
  }
});

// 0.19.57：品牌形象换 Iconoir `bridge-3d`（用户指定：作者 Luca Burgio，MIT，
// https://github.com/iconoir-icons/iconoir）。历史教训是 0.19.39 自绘了一个与
// 插件管理页形象对不上的形状（用户判为「绘制错误」），0.19.56 又自绘了第二次，
// **0.19.57 我拿到用户的图却没照图改**（自选蓝青渐变，而用户的稿子是黑色 + 旋转
// 90°）——第三次。因此这里把「品牌几何 = 官方逐字路径 + 定稿的旋转与配色」
// 一并钉死：三条路径的 `d` 与 iconoir `icons/regular/bridge-3d.svg` 完全一致，
// 配色与旋转必须等于用户 appicon-forge 稿子的 `iconRotation:90` /
// `iconColor:#000000ff` / `iconShadow:#65b3fcff`，自改任一项即红。
// 反向验证：改桥体路径一个数字、改旋转角、改配色 ⇒ 各红一次（已做）。
test('★ 0.19.58 品牌图标：Iconoir bridge-3d 官方几何 + 用户定稿的旋转 90°/黑色/浅蓝副影', () => {
  const src = bridgeSrcFrom('client.cjs');
  // 官方 bridge-3d regular 的三条路径（逐字；取件 2026-10-03，unpkg iconoir）。
  assert.ok(src.includes("'M18 4L21 4'"), '右上短竖线不是官方路径（自改了坐标？）');
  assert.ok(src.includes("'M10 20C10 20 16.5 17.5 12 12C7.5 6.5 14 4 14 4'"),
    'S 形桥体不是官方路径（自改了坐标？）');
  assert.ok(src.includes("'M3 20H6'"), '左下短竖线不是官方路径（自改了坐标？）');
  // 官方刻度：24 viewBox / stroke 1.5（官方 bridge-3d 的 stroke-width）。
  assert.ok(src.includes("viewBox: '0 0 24 24'"), '品牌图标必须用官方 24 viewBox');
  assert.match(src, /function DwbMarkColor\(props\)[\s\S]{0,600}sw = 1\.5/,
    '品牌图标的线宽必须用官方 1.5（官方 bridge-3d 刻度）');
  // 两个端点圆点（官方的实心小圆）也必须在。
  assert.ok(src.includes('cx: 10, cy: 20, r: 1') && src.includes('cx: 14, cy: 4, r: 1'),
    'bridge-3d 的两个端点圆点丢了');
  // 旧形象（0.19.56 的拱桥 / 0.19.39 的浅拱）不得复活。
  assert.ok(!src.includes('M5 12.33C5 7.33 19 7.33 19 12.33'), '0.19.56 的旧拱桥路径复活了');
  assert.ok(!src.includes("'M2.5 12.4c0-3.9"), '0.19.39 的旧浅拱路径复活了');
  // 彩色版与线稿必须同构：DwbMark 直接转发 DwbMarkColor（monochrome），不是第二份坐标。
  assert.match(src, /function DwbMark\(props\)\s*\{\s*return DwbMarkColor\(\{\s*\.\.\.props,\s*monochrome: true\s*\}\);\s*\}/,
    'DwbMark 必须直接转发 DwbMarkColor（两份坐标会漂移）');
  // ---- 定稿的旋转与配色（用户 appicon-forge 稿，2026-10-03）----
  // 旋转 90°：必须写在**内层 g** 上（写在外层 svg 会让盒子跟着转、撑歪 flex 行高）。
  assert.ok(src.includes("transform: 'rotate(90 12 12)'"),
    '品牌图标必须按用户稿旋转 90°（iconRotation: 90）');
  // 彩色位本体为黑、副影为浅蓝（iconColor #000000ff / iconShadow #65b3fcff）。
  assert.ok(src.includes("art('#65b3fc')"), '副影必须是用户稿的浅蓝 #65b3fc');
  assert.ok(src.includes("art(mono ? 'currentColor' : '#000000')"),
    '彩色位本体必须是用户稿的黑色 #000000（不是自选配色）');
  // 0.19.57 那次自选的蓝青渐变不得复活（用户明确否定：稿子是黑 + 蓝副影）。
  assert.ok(!src.includes('#7CB7FF') && !src.includes('#45D9E7'),
    '0.19.57 自选的蓝青渐变复活了——定稿是黑色本体 + 浅蓝副影');
  assert.ok(!src.includes('url(#dwb-s)'), '0.19.57 的品牌渐变引用复活了');
  // icon.svg 必须是同一套：白底圆角 77 + #D1D1D1 描边 + 黑色 + 旋转 90°。
  const icon = readFileSync(path.resolve(here, '../icon.svg'), 'utf8');
  assert.ok(icon.includes('rotate(90 512 512)'), 'icon.svg 必须按用户稿旋转 90°');
  assert.ok(icon.includes('rx="77"'), 'icon.svg 圆角必须是用户稿的 77');
  assert.ok(icon.includes('stroke="#D1D1D1"'), 'icon.svg 描边必须是用户稿的 #D1D1D1');
  assert.ok(icon.includes('fill="#ffffff"'), 'icon.svg 底色必须是用户稿的纯白');
  assert.ok(icon.includes('#65b3fc'), 'icon.svg 副影必须是用户稿的 #65b3fc');
  assert.ok(!icon.includes('#7CB7FF') && !icon.includes('#45D9E7'),
    'icon.svg 里 0.19.57 的蓝青渐变复活了');
  // 许可：MIT 要求保留作者与许可声明。
  assert.match(icon, /Luca Burgio/, 'icon.svg 必须保留 Iconoir 作者声明（MIT）');
  assert.match(icon, /MIT/, 'icon.svg 必须保留 MIT 许可声明');
});

// ------------------------------------------------------------------ 0.14.8

test('★ 站点图标与一级选择框（0.16.23 接手网页会话半成品）：图标/档位说明/首屏选择框都要渲染出来', async () => {
  const ten = [
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', initialized: true, loggedIn: true },
    { siteId: 'glm', siteName: '智谱清言 (GLM)', initialized: false, loggedIn: true },
  ];
  const full = await renderPane({ payloads: [emptyWindows], sites: ten });
  assert.deepEqual(full.errors, [], '站点图标渲染抛错：' + full.errors.map(e => e.message).join('; '));
  // 档位表语义：DeepSeek 是官方鲸鱼矢量（official 档），GLM 如实标注「未找到」——
  // 不许把第三方图集冒充官方（doc/brand-icons-research.md 的结论）。
  //
  // 0.16.36：档位说明（「官方矢量 / 文字标记」）现在挂在**站点目录行**与**首屏网格**
  // 的图标挂点上。站点网页标签的正文只显示当前这一个站点，没有目录可解释，
  // 因此这条断言改在目录页上跑——钉的是**信息不能丢**（用户要能分辨真实品牌矢量
  // 与占位文字标记），不是某一个 DOM 位置。
  const catalog = await renderPane({ payloads: [emptyWindows], sites: ten, which: 'catalog' });
  assert.deepEqual(catalog.errors, [], '站点目录渲染抛错：' + catalog.errors.map(e => e.message).join('; '));
  // 0.19.35：档位说明**不再上界面**（用户要求去悬浮提示），但「图标从哪来」这件事
  // 必须有地方可核对——它改在源码层核验：`SITE_ICON_TIER` 的 `why` 逐条仍在。
  // 这条同时是「不得因为去掉提示就把来源记录一起删掉」的钉子。
  const tierSrc = bridgeSrcFrom('client.cjs');
  assert.ok(/const SITE_ICON_TIER = \{/.test(tierSrc), '档位/来源表被删了——去掉悬浮提示不等于删掉来源记录');
  assert.ok(tierSrc.includes('官方鲸鱼矢量'), 'DeepSeek 的来源记录丢了');
  assert.ok(tierSrc.includes('lobehub'), 'GLM/Z.ai/豆包的来源记录丢了');
  assert.ok(!/siteIconWhy\s*\(/.test(tierSrc.replace(/const siteIconWhy[\s\S]{0,40}/, '')),
    'siteIconWhy 已被删除（悬浮说明的唯一来源），不得复活');
  // 图标挂点：工具条站点图标（.hwb-glyph）与目录行图标（.hwb-catalog-ico）各一处。
  const html = JSON.stringify(catalog.tree);
  // 0.19.35：GLM 换成了**智谱清言应用标**（qingyan.svg）——旧断言钉的是 chatglm.svg
  // 那条路径（底层 GLM 模型的标），正是用户报的「矢量图错误」。
  assert.ok(/M6\.075 10\.494C7\.6 9\.446/.test(html), 'GLM 的智谱清言矢量没被渲染（仍是 chatglm 那条？）');
  assert.ok(/M12\.105 2L9\.927/.test(html), 'Z.ai 的品牌矢量没被渲染（仍是文字标记？）');
  // 0.19.35：豆包换成豆包自己的标（doubao.svg 三条路径，含两条浅色层）。
  assert.ok(/M5\.31 15\.756c\.172-3\.75/.test(html), '豆包的品牌矢量没被渲染（仍是 bytedance 那条？）');
  assert.ok(html.includes('hwb-catalog-ico'), '站点目录行缺少图标挂点');
  assert.ok(!html.includes('hwb-menu-glyph'), '已删除的站点菜单挂点又出现了');
  assert.ok(!html.includes('hwb-tab-glyph'), '已删除的横向站点标签挂点又出现了');
  // 0.16.36：取回的**真实品牌矢量**必须真的画出来——断言 svg path 的 d 属性用了
  // simple-icons 的那一条，而不是仍走文字标记（这是「把官方图上网找来」的验收点）。
  assert.ok(/M22\.2819 9\.8211/.test(html), 'ChatGPT 的 simple-icons 路径没被渲染（仍在用文字标记？）');
});

test('★ 站点图标：旧版 primitives 缺导出时必须降级而不是白屏（0.16.21 事故回归钉子）', async () => {
  // 0.16.21 误打包的半成品里，对 primitives 的新增导出**无回退解构**，而测试桩
  // 只给了两个图标——FishLogo/FISH_LOGO_VIEWBOX/IconChevronDownOutline14/
  // useDismissOnOutsidePointer 全是 undefined，渲染期 h(undefined/读 .height) 抛
  // TypeError，6 条渲染测试全崩。修复 = 防御回退解构（client.cjs）；本条钉住：
  // 把新增导出**全部抽走**（模拟 < 0.1.6 的旧版 primitives），渲染必须照样成立。
  const { errors } = await renderPane({
    payloads: [emptyWindows],
    sites: [{ siteId: 'deepseek', siteName: 'DeepSeek 网页版', initialized: true, loggedIn: true }],
    primitiveOmit: ['IconChevronDownOutline14', 'FishLogo', 'FISH_LOGO_PATH', 'FISH_LOGO_VIEWBOX', 'useDismissOnOutsidePointer'],
  });
  assert.deepEqual(errors, [], '缺导出时渲染抛错（回退缺失，会白屏）：' + errors.map(e => e.message).join('; '));
});

test('右栏账户头像：圆框按真实读数分三态，且颜色不是唯一状态载体', async () => {
  // 用户原话：「账户栏目已登录的账户有头像一样的（就是适应大小的圆框账户，
  // 点击选择后是对应账户，外层有浅绿色正常状态显示，浅红色就是会话没了）」。
  //
  // 这一条同时钉住调研里点名「最容易犯的错」的那条约束
  //（doc/research/agent-ui-design-references.md:180）：**不用颜色作为唯一状态载体**。
  // 所以断言分两半：类名（视觉）与 title/aria-label（可读文本）都要到位。
  // 0.16.38：账户卡只在**站点页**渲染，且只列**该站点**的账户行（`onlySiteId`）。
  // 因此三个状态必须落在同一个站点的三个槽上——这恰好也是真机形态：同一站点
  // 多账户时，每个槽各有自己的登录态与会话失效读数。
  const sites = [
    // 正常：已登录且从未丢过网页会话
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true, sessionLostCount: 0 },
    // 会话没了：登录态还在，但网页会话丢过 —— 这是「浅红」的**唯一**合法依据
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek#2', slot: '2', displayName: 'DeepSeek 网页版 (账户2)', initialized: true, loggedIn: true, sessionLostCount: 3, lastSessionLost: { reason: 'no-stored-session', siteId: 'deepseek' } },
    // 待检查：没有可信读数
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek#3', slot: '3', displayName: 'DeepSeek 网页版 (账户3)', initialized: false, loggedIn: null },
  ];
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], sites, which: 'settings', settingsTab: 'deepseek' });
  assert.deepEqual(errors, [], '账户头像渲染抛错：' + errors.map(e => e.message).join('; '));

  // 头像存在且是圆框：断言类名（视觉契约）
  const classes = treeAttrs(tree, ['className']).join(' ');
  assert.match(classes, /hwb-avatar/, '没有渲染账户头像元素');
  assert.match(classes, /hwb-avatar ok/, '已登录账户未标为 ok（浅绿正常态）');
  assert.match(classes, /hwb-avatar dead/, '丢过会话的账户未标为 dead（浅红「会话没了」态）');
  assert.match(classes, /hwb-avatar idle/, '无可信读数的账户未标为 idle');

  // 【核心】颜色不是唯一载体：三个账户的状态都必须能在 title/aria-label 里读到
  const labels = treeAttrs(tree, ['aria-label', 'title']).join(' | ');
  assert.ok(labels.includes('正常'), '「正常」态未出现在 aria-label/title：' + labels.slice(0, 300));
  assert.ok(labels.includes('会话已失效'), '「会话没了」态未出现在 aria-label/title（颜色成了唯一载体）：' + labels.slice(0, 300));
  assert.ok(labels.includes('待检查'), '「待检查」态未出现在 aria-label/title：' + labels.slice(0, 300));

  // 会话丢失次数要如实出现在可读文本里（用 loggedIn 冒充会话失效是错的：
  // 两者会同时为真——GLM 那一行 loggedIn=true 且 sessionLostCount=3）
  assert.ok(labels.includes('3'), '会话失效次数未如实透出：' + labels.slice(0, 300));
});

test('右栏账户头像：per-slot 会话丢失读数缺失时退化为 idle，不得凭 loggedIn 猜', async () => {
  // 后向兼容：旧后端（≤0.14.7）的 sites 行**没有** sessionLostCount 字段。
  // 缺字段时必须退化成 idle（待检查），而不是把 undefined > 0 当 false 升绿，
  // 也不是编一个「会话失效」的红色——两者都是造假状态。
  const old = [{ siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true }];
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], sites: old, which: 'settings', settingsTab: 'deepseek' });
  assert.deepEqual(errors, [], '旧后端行渲染抛错：' + errors.map(e => e.message).join('; '));
  const classes = treeAttrs(tree, ['className']).join(' ');
  assert.match(classes, /hwb-avatar ok/, '缺 sessionLostCount 时已登录账户应仍是 ok（正常）');
  assert.ok(!/hwb-avatar dead/.test(classes), '缺 sessionLostCount 时不得编造「会话没了」的红态');
});

// ------------------------------------------------ 花名册（设置页那份已删，0.19.x）
//
// 设置页的「正在运行（子代理 / Team）」卡已按用户要求整卡删除（原话「为什么设置
// 界面需要？？？」），构成它的组件 AgentRoster 随之删除。这里原先的六条用例
//（空态口径 / 有成员时两区标题与状态词 / 「读不到」≠「确实没有」/ 部分分区读不到 /
// Team 任务板 / 同源失败去重）验证的对象已不存在，故随对象一并删除。它们要保住的
// 判据没有丢：
//   · 「读不到 ≠ 确实没有」与 Team 任务板 → 任务板面板那几条（which: 'tasks'）；
//   · teamSource/tasksSource 三段接线 → 见下方 0.19.0 一致性用例。
// 「不得复活」由「设置页作用域」与「文案精简」两条用例里的反向断言钉住。

// ------------------------------------------------------------------ 0.14.9 去臃肿

test('★ 等待药丸：真的渲染出短读数，且默认不展开明细', async () => {
  // 这条必须走真实组件（不再只是扫源码）：此前 dock 组件从未被捕获，
  // 「药丸到底渲染出什么」在测试里是空白。
  const { errors, tree } = await renderPane({ which: 'dock', payloads: [{}] });
  assert.deepEqual(errors, [], '药丸渲染抛错');
  const text = treeText(tree);
  assert.match(text, /3 秒 · 等待占比 30%/, '药丸必须显示服务端算好的短读数');
  // 默认收起：明细只在点击后才出现——「默认没有，点击能出现」是用户的要求。
  assert.ok(!/累计等待发送/.test(text), '明细默认不应展开');
  assert.ok(!/本会话尚无等待记录/.test(text), '不该显示空态文案');
});

// --------------------------------------------------------- 0.16.24 在途等待计时

// 需求（用户原话）：「能做到等待发送实际显示和官方一样开始就计时增长，不要等过了
// 再变一下子从 n 秒到 m 秒？」这条链路跨三处，缺一处就退回旧观感：
//   index.js  在等待**开始**时发布 live（而不是等账本结算）
//   web-control.js 把 live + now 透给药丸
//   client.cjs 在途时把轮询提到 1 秒（否则 10 秒才动一格）
// 前两处由 wait-stats 单测与服务端夹具钉住，这里钉住「客户端确实照它渲染与加速」。

/** 在途等待的服务端载荷（字段照 /__webcode/wait-stats 真实输出给）。 */
const liveWaitPayload = {
  ok: true,
  total: { totalWaitMs: 20000, totalDurationMs: 60000, turns: 9, waitedTurns: 4, rateLimitRetries: 1, updatedAt: 1789000000000 },
  // 本会话账本里已有 12 秒历史等待：在途读数必须**盖过**它，否则用户看到的
  // 仍是一个不动的数（这正是旧观感）。
  session: { totalWaitMs: 12000, totalDurationMs: 48000, turns: 2, waitedTurns: 1, rateLimitRetries: 0, updatedAt: 1789000000000 },
  live: { startedAt: 1789000000000, endsAt: 1789000010000, baseMs: 0, kind: 'gap' },
  now: 1789000003000,
  rows: [{ label: '累计等待发送', value: '20 秒' }],
  label: '3 秒 · 等待占比 6%',
  sessionValue: '12 秒',
  // 0.19.34：面板标题右侧读的是账本 12 秒 + 在途 3 秒 = 15 秒（与药丸的投影同源）。
  projectedValue: '15 秒',
  detailRows: [
    { label: '本次会话等待发送', value: '12 秒' },
    { label: '本次会话占比', value: '20%' },
    { label: '累计等待发送', value: '20 秒' },
    { label: '平均会话等待时长占比', value: '25%' },
  ],
};

test('★ 等待药丸：在途读数盖过账本累计（显示正在涨的那个数）', async () => {
  const { errors, tree } = await renderPane({ which: 'dock', payloads: [{}], waitStats: liveWaitPayload });
  assert.deepEqual(errors, [], '在途药丸渲染抛错');
  const text = treeText(tree);
  assert.match(text, /3 秒 · 等待占比 6%/, '在途时必须显示现算的短读数');
  // 账本里的 12 秒不得到药丸上——两个数同时出现等于没修。
  assert.ok(!/12 秒 · 等待占比/.test(text), '在途时药丸不得回落到账本累计值');
});

test('★ 等待药丸：在途时轮询提到 1 秒（10 秒一问等于没在动）', async () => {
  // 这条是需求里最容易漏掉的一半：服务端算得再勤，客户端 10 秒才问一次，
  // 数字仍然是「一下子跳」。两者必须成对。
  const live = await renderPane({ which: 'dock', payloads: [{}], waitStats: liveWaitPayload });
  assert.deepEqual(live.errors, []);
  assert.ok(live.intervalDelays.includes(1000), '在途等待时轮询周期必须是 1000ms（实得：' + live.intervalDelays.join(',') + '）');
  // 静止（无 live）时保持 10 秒，不要把本地回环请求变成每秒一次。
  const idle = await renderPane({ which: 'dock', payloads: [{}] });
  assert.ok(idle.intervalDelays.includes(10000), '静止时必须保持 10000ms 轮询');
  assert.ok(!idle.intervalDelays.includes(1000), '静止时不该每秒轮询');
});

test('★ 0.19.34 等待面板：在途读数上标题，且「正在等待发送」行不得复活', async () => {
  // 用户原话：「移除突然出现的：正在等待发送 Ns，改为实时更新面板顶部『等待发送统计』」。
  //
  // 展开态的内容由本条源码护栏 + wait-stats 单测覆盖（同 0.15.11 的既有做法：
  // 本 harness 的 setState 不触发重渲染，点开态无法在渲染树里直接观察）。
  const src = bridgeSrcFrom('client.cjs');
  // 标题右侧读的必须是**投影**（账本 + 在途），不是只读账本的 sessionValue——
  // 后者在途期间不动，正是用户看到的「面板顶部的数不实时更新」。
  assert.ok(/data\?\.projectedValue/.test(src), '面板标题右侧必须渲染 projectedValue（在途期间逐秒前进）');
  assert.ok(!/data\?\.liveValue/.test(src), 'liveValue 已由 projectedValue 取代，不得复活');
  // 判据盯**渲染表达式**而不是整份源码：那句文案在注释里出现是正常的（本仓库注释密度极高，
  // 且注释要解释「为什么删掉它」）——扫整份源码只会把注释当成缺陷。
  assert.ok(!/h\('dt', null, '正在等待发送'\)/.test(src), '「正在等待发送 N 秒」那一行必须移除（用户明确要求）');
  assert.ok(!/hwb-waitpanel-row live/.test(src), '在途那一行的专用 class 必须一并消失');
  // 空态判定要把投影算进去：在途但账本还空时（首次等待）不能落到
  // 「本会话尚无等待记录」——那正是「首次等待整枚药丸不渲染」的同族缺陷。
  assert.ok(/\(data\?\.projectedValue \|\| rows\.length\)/.test(src), '空态判定必须包含 projectedValue');
});

test('★ 0.19.2：药丸在 primitives 改名后（0.1.7-alpha.2）仍必须渲染出来', async () => {
  // 真机事故：DSH 0.1.7-alpha.2 把 primitives 的图标导出整体改名——
  // `IconQueueOutline14` → `IconQueueOutlineRegular`（同族 `…Medium`）。
  // 等待药丸用的是无兜底解构的那个名字，于是取到 undefined、渲染期
  // `h(undefined)` 抛错，整块 dock 条目消失：用户报的「底部发送等待时间没了」，
  // 而控制台里没有本插件自己的告警。
  //
  // 这条用 iconNaming:'current' 的桩（只有新名、没有旧名）逼客户端走多代查找，
  // 断言药丸**真的渲染出读数**——不是「源码里有兜底」那种转述式断言。
  const { errors, tree } = await renderPane({ which: 'dock', payloads: [{}], iconNaming: 'current' });
  assert.deepEqual(errors, [], 'primitives 改名后药丸渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.match(text, /3 秒 · 等待占比 30%/, 'primitives 改名后药丸必须仍然显示读数（不得整块消失）');
});

test('★ 等待药丸：可点（onClick 存在），且 aria 契约完整', async () => {
  const { errors, tree } = await renderPane({ which: 'dock', payloads: [{}] });
  assert.deepEqual(errors, []);
  // 找到药丸按钮并触发它的 onClick（真实组件树的第一次点击）。
  const buttons = [];
  const collect = (el) => {
    if (el === null || el === undefined || typeof el !== 'object') return;
    if (Array.isArray(el)) { el.forEach(collect); return; }
    if (typeof el.type === 'function') { collect(el.type(el.props)); return; }
    if (el.type === 'button') buttons.push(el);
    (el.children || []).forEach(collect);
  };
  collect(tree);
  assert.ok(buttons.length > 0, '药丸按钮不存在');
  const pill = buttons[0];
  // 「默认没有，点击能出现」：收起态 + 真的挂了 onClick（点击由 React 驱动，
  // 这里能验证的是契约本身——展开态的内容由下一条源码护栏与 wait-stats 单测覆盖）。
  assert.equal(pill.props['aria-expanded'], false, '默认必须是收起的');
  assert.equal(pill.props['aria-haspopup'], 'dialog', '对齐官方统计药丸的 aria 契约');
  assert.equal(typeof pill.props.onClick, 'function', '药丸必须可点（点击才出现明细）');
  // 官方那两枚药丸只给 aria-haspopup/aria-expanded，不挂 role="status"。
  assert.equal(pill.props.role, undefined, '按钮不得挂 role="status"');
  assert.match(String(pill.props['aria-label']), /等待发送/);
});

test('★ 等待药丸：靠官方 dock 行自身的 flex 同栏，且不得有几何 hack', () => {
  // 用户原话：「写死的会被侧面面板挤到重叠的」。0.15.10 用负上边距把本行拽进
  // 官方那一行，官方行一旦换行（右栏把输入区挤窄）两块内容就叠在一起。
  //
  // 0.15.11 改成 portal 进 [data-composer-stats] 行容器，但**那个官方标记在
  // DSH 0.1.6-alpha.2 里已经不存在**（新版 StatsPills 根节点只渲染 className，
  // 整个包 grep 命中 0 处）。于是 portal 分支永不生效，回落的自建整行
  // （width:100%）反而把官方药丸挤到下一行——这就是用户报的「没适配」。
  //
  // 新版正确解：`conversation.composer.dock` 的条目本来就是官方 dock flex 行的
  // 直接子项（ui-conversation 的 InputBar 直接 renderSlot 再渲染 ContextMeter），
  // 所以只要自己是 inline-flex，同栏就自动成立。
  //
  // 这条钉住的是**药丸自己在哪**：必须是官方 dock 行的直接子项、inline-flex、
  // 不写整行宽度、不给负边距。
  //
  // 0.16.39 改动：`createPortal` 不再被这条禁掉。它现在的用途是**弹层**（官方
  // stat-dialog 同样 portal 到 body，为了逃出右栏面板的 transform 包含块），
  // 与 0.16.18 删掉的那条「塞进官方统计行」完全无关；药丸本身仍在本行里，
  // 由下面的规则逐条钉住。
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(!src.includes('useOfficialStatsHost'), '不得保留找官方统计行的旧钩子');
  assert.ok(!/data-composer-stats'\]/.test(src), '不得再按已消失的官方标记去 querySelector');
  assert.ok(!/joinOffset/.test(src), '不得再保留负边距的几何补偿量 joinOffset');
  assert.ok(!/marginTop:\s*-/.test(src), '不得给等待 wrap 写负上边距');
  assert.ok(!/\.hwb-waitwrap\.joined/.test(src), '不得保留 joined 的几何 hack 样式');
  // 必须是内联行内盒：整行 width:100% 正是「药丸独占一行」的成因。
  const wrap = src.slice(src.indexOf('".hwb-waitwrap{'), src.indexOf('".hwb-waitpill{'));
  assert.match(wrap, /display:inline-flex/, '等待 wrap 必须是 inline-flex（官方 dock 行已提供 justify-content:center）');
  // 判据必须写成「独立的 width:100%」：`max-width:100%` 是官方 root 就有的约束，
  // 用 /width:100%/ 去查会把它一起禁掉（0.16.38 需要 max-width 才能被父行约束）。
  assert.ok(!/(?:^|[;{])width:100%/.test(wrap), '不得给等待 wrap 写 width:100%——那会独占官方 dock 行');
  // 0.16.38：wrap 必须**可收缩**。旧值 `flex:none` 明确禁止收缩，于是窄 pane 下
  // 官方药丸在缩、这一枚不动——用户报的「缩小后没适配」在数值层面就是它。
  assert.match(wrap, /flex:0 1 auto/, '等待 wrap 必须可收缩（flex:0 1 auto），否则窄栏下不与官方药丸同步');
  assert.match(wrap, /max-width:100%/, '等待 wrap 需要 max-width:100% 才能被父行约束');
});

test('★ 等待药丸：关闭语义必须与官方一致（Esc + 点外部）', () => {
  // 官方 StatsPills 由 useStatDialog + useDismissOnOutsidePointer 驱动：同一时刻
  // 只有一枚药丸开着，点别处收起。本组件是独立 dock 条目、拿不到那份 state，
  // 因此必须等价实现这两个事件，否则面板会一直挂着不自动收缩。
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(/key === 'Escape'/.test(src), '必须支持 Esc 收起');
  assert.ok(src.includes("'pointerdown'"), '必须监听 pointerdown 以复刻官方的点外部关闭');
  // 0.16.39：判据从「必须写 !root.contains(...)」放宽成「必须同时认 root 与 panel」——
  // 面板 portal 到 body 之后，只用 root 做边界会让点面板内部把它自己关掉；
  // 官方 useDismissOnOutsidePointer 的第四个参数（portal）正是为这件事存在的。
  assert.ok(/root\.contains\(target\)/.test(src), '关闭边界必须包含本组件自身（而不是整行）');
  assert.ok(/panel\.contains\(target\)/.test(src), '面板已 portal 到 body，关闭边界必须把面板自身也算作「内部」');
});

test('★ 等待药丸：字号/行高必须走官方 content-font token，不得写死像素', () => {
  // 官方药丸（ui-chat 的 StatsPills）走 token：root 给字号
  // `--dsh-content-font-size-secondary`（缺省 13px）与行高
  // `--dsh-content-font-delta-secondary` 以 20px 为基，pill 自己只
  // `line-height:inherit` + `padding:1px 8px`。
  //
  // 0.16.38 修正：本仓库此前把行高基写成 24px、并额外给 pill 一条
  // `height:calc(28px + delta)`。两者都不是官方值——同一行里那两枚药丸因此
  // **不等高**，正是用户说的「没适配」。现在逐项等于官方：字号与行高在 wrap 上，
  // pill 不再自己声明高度。
  // 用户在设置里改「内容字号」时，这两个 delta 会让官方所有药丸一起缩放；
  // 写死 13px/24px/28px 的那一枚**不跟着变**——同一行里出现一大一小两枚药丸，
  // 就是「没适配」在数值层面的形态。
  //
  // 为什么用静态样式断言：这是 CSS 值，渲染树的文本里读不到；而它恰恰最容易
  // 被后续「顺手调一下」改回写死值（13px 看着也不丑）。钉住 token = 把适配
  // 结论变成可执行约束。
  const src = bridgeSrcFrom('client.cjs');
  // 取单条规则：CSS 是 `".hwb-x{...}"` 形式，所以规则的右界是 `}"` 而不是 `"}`。
  // 写错会静默变成 `slice(i, -1)`——那会扫到文件结尾（26KB），断言于是横跨几十条
  // 规则。这类断言看起来更严，实际是在别处命中，是**假绿**。
  const ruleAt = (sel) => {
    const i = src.indexOf(sel);
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    assert.ok(end > i, '样式规则 ' + sel + ' 没有终止符' );
    return src.slice(i, end + 2);
  };
  // 字号与行高挂在 wrap 上（与官方 StatsPills 的 root 同形），pill 继承——两处都查。
  const wrap = ruleAt('".hwb-waitwrap{');
  const pill = ruleAt('".hwb-waitpill{');
  assert.match(wrap, /font-size:var\(--dsh-content-font-size-secondary,13px\)/, '药丸字号必须走官方 content-font token');
  assert.match(wrap, /line-height:calc\(20px \+ var\(--dsh-content-font-delta-secondary,0px\)\)/, '药丸行高必须跟随官方 content-font delta（官方以 20px 为基）');
  assert.ok(!/font-size:13px/.test(wrap) && !/font-size:13px/.test(pill), '药丸字号不得写死 13px：用户改内容字号时它不会跟着缩放');
  // 官方 pill **不声明 height**（高度由行高与 padding 决定）。钉住「不得再加回
  // 那条 28px 的 height」——它正是两枚药丸不等高的直接原因。
  assert.ok(!/height:calc\(/.test(pill), 'pill 不得自己声明 height：官方靠 line-height + padding 定高，多一条就会与官方药丸不等高');
});

test('★ 左栏任务板：整列页面排版必须对齐官方 page 契约', () => {
  // 左栏入口切过来的是**整列页面**。官方给整列页面的排版是 ui-plugin-manager 的
  // `X_2TxG_page` / `X_2TxG_pageTitle`：
  //   padding: 28px clamp(24px,4vw,48px) 48px；分节间距 32px
  //   正文列:  width:100%; max-width:960px（居中）
  //   标题:    font-size:20px; font-weight:500; line-height:28px
  // 旧的 15px/24px + padding:16px 20px 是**右栏窄条**那一档的尺度。沿用窄条
  // 尺度会让整列页面像「一条被放大的侧栏」，也压不住下面 13px 的正文。
  const src = bridgeSrcFrom('client.cjs');
  // 同 `ruleAt`：右界必须是 `}"`。写 `"}` 会返回 -1，回落分支于是扫到文件结尾，
  // 断言横跨几十条规则——看着更严，其实是假绿。
  const grab = (sel) => {
    const i = src.indexOf(sel);
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    assert.ok(end > i, '样式规则 ' + sel + ' 没有终止符');
    return src.slice(i, end + 2);
  };
  const main = grab('".hwb-main{');
  assert.match(main, /display:flex/, '整列页面容器应为 flex 列');
  assert.match(main, /gap:32px/, '分节间距应为 32px（官方 page 契约）');
  assert.match(main, /padding:28px clamp\(24px,4vw,48px\) 48px/, '页面内边距应对齐官方 page 契约');
  assert.match(main, /flex:1/, '必须保留 flex:1 占满中央列');
  assert.match(main, /min-height:0/, '必须保留 min-height:0 以便内部滚动');
  assert.match(grab('".hwb-main>*{'), /max-width:960px/, '正文列应为官方 960px 列宽');
  const head = grab('".hwb-main-head{');
  assert.match(head, /font-size:20px/, '页面标题应为 20px（官方 pageTitle），而不是右栏窄条的 15px');
  assert.match(head, /line-height:28px/, '页面标题行高应为 28px');
});

test('去臃肿：设置页密度 token 必须与调研 token 表一致，且不再用线分隔行', async () => {
  // 用户原话：「做到简洁高效美观，而不是现在的臃肿」。
  // 数值依据不是审美偏好，而是 doc/research/agent-ui-design-references.md §4.4
  // 的 token 表（Apple HIG 可执行约束 + Fluent 2 的 4px 阶梯 + 官方包实测值）。
  //
  // 为什么用**静态样式断言**而不是渲染断言：这是 CSS 值，渲染树的文本里读不到；
  // 而它恰恰是最容易被后续「顺手调一下」改回去的东西（16px 看着也「不丑」）。
  // 钉住数值 = 把调研结论变成可执行的约束，而不是一段会被遗忘的文档。
  const src = bridgeSrcFrom('client.cjs');
  // 右界是 `}"`（CSS 写成 `".hwb-x{...}"`）。旧写 `"}` 恒返回 -1，回落分支
  // `slice(i, i+400)` 于是横跨好几条规则——断言在**别的规则**里命中，是假绿。
  const grab = (sel) => {
    const i = src.indexOf(sel);
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    assert.ok(end > i, '样式规则 ' + sel + ' 没有终止符');
    return src.slice(i, end + 2);
  };
  // 卡片圆角：12px（§4.4 明列「从现 16px 收紧」）
  const card = grab('".hwb-card{');
  assert.match(card, /border-radius:12px/, '卡片圆角应为 12px（§4.4），实际：' + card.slice(0, 160));
  assert.ok(!/border-radius:16px/.test(card), '卡片圆角退回 16px（用户报的「臃肿」来源之一）');
  // 标签列宽：96px（Apple「omit unnecessary words」，§4.4 明列）
  const label = grab('".hwb-row-label{');
  assert.match(label, /flex:0 0 96px/, '标签列宽应为 96px（§4.4），实际：' + label.slice(0, 160));
  assert.ok(!/0 0 128px/.test(label), '标签列宽退回 128px');
  // 行内边距：8px（Fluent 4 的倍数，§4.4 明列）
  assert.match(grab('".hwb-row{'), /padding:8px 0/, '行内边距应为 8px（§4.4）');
  // 删线，用间距（Fluent 原文：spacing creates sections without having to use lines）
  assert.ok(!/\.hwb-row\{[^}]*border-bottom/.test(src), '.hwb-row 又画回了分隔线（应用间距）');
  assert.ok(!/\.hwb-site-block\{[^}]*border-bottom/.test(src), '.hwb-site-block 又画回了分隔线');
});

test('去臃肿：气泡状按钮圆角应收紧，不保留 16px 的「药丸」', async () => {
  // 同一条依据（§4.4「卡片圆角 12px」的同一取向）。注意**不能**把状态 pill
  // 一起去掉——那只 pill 是状态载体，属于「不要为了美观丢掉信息」的反面。
  const src = bridgeSrcFrom('client.cjs');
  const i = src.indexOf('".hwb-row button,.hwb-settings button{');
  assert.ok(i > 0, '找不到主按钮样式');
  const rule = src.slice(i, src.indexOf('"}', i));
  const m = /border-radius:(\d+)px/.exec(rule);
  assert.ok(m, '主按钮未声明 border-radius：' + rule.slice(0, 200));
  assert.ok(Number(m[1]) <= 12, '主按钮圆角 ' + m[1] + 'px 仍偏「药丸」，应与收紧后的卡片一致（≤12px）');
});

/**
 * `settings.section` 的会话身份契约（0.15.3 真机缺陷）。
 *
 * 真机：设置页花名册恒回 `subAgentsError: "no-session-id"`，永远读不到成员。
 * 根因是**槽作用域与 inject 参数的错配**：
 *
 *   • `settings.section` 在官方槽目录里是 `scope: "root"`；
 *   • renderer 的 `runInject` 只对**带 binding 的会话级槽**传 `binding.key`，
 *     root 槽只拿到 `actions`；
 *   • 旧写法 `inject: (sessionId) => ({ sessionId })` 于是把那个 actions 对象
 *     当成会话 id 一路送到服务端，服务端解析不出会话，回 no-session-id。
 *
 * 正规入口是 official standard prop **`useSessions`**（官方 ui-settings-general
 * 自己就这么读会话）。这条断言把「不许再用 root 槽的 inject 冒充会话来源」
 * 钉死——它正是本轮修掉的第三个「引用存在、另一端不存在」型缺陷。
 */
test('设置页：会话身份必须经 useSessions 取，不得用 root 槽的 inject 冒充', async () => {
  const src = bridgeSrcFrom('client.cjs');

  // 1) settings.section 的注册块里不得再有 sessionId 形状的 inject。
  const regAt = src.indexOf("ctx.slots.inject('settings.section'");
  assert.ok(regAt > 0, '找不到 settings.section 的注册点');
  const regEnd = src.indexOf('SettingsSection));', regAt);
  assert.ok(regEnd > regAt, 'settings.section 未注册 SettingsSection（会话注入层缺失）');
  const block = src.slice(regAt, regEnd);
  assert.ok(!/inject\s*:/.test(block),
    'root 作用域的 settings.section 又声明了 inject —— 它拿不到会话 id，会把 actions 对象当成 sessionId：\n' + block);

  // 2) 必须真的走官方 useSessions 通道。
  assert.ok(/function SettingsSection\(/.test(src), '缺少 SettingsSection 会话注入层');
  assert.ok(/props\.useSessions|\.useSessions\b/.test(src), '没有使用官方 useSessions standard prop 读取会话');
  assert.ok(/useSessions\(s => \(s && s\.current\)/.test(src), 'useSessions 的取值形态变了（应读 state.current）');
});

// ------------------------------------------------------------------ 0.15.12 / 0.16.18 面板注册

/**
 * 标签页注册的**当前**形态：两个 kind，且都是 page type。
 *
 * 官方契约（tab-registry.d.ts）：省略 `patterns` 的类型是 page type，「is opened by
 * kind」，不做地址识别。团队面板本来就没有「打开某个资源」的语义——若照抄网页那个
 * kind 的写法给它加 patterns，它会去和文件类 kind 抢地址。
 *
 * 0.16.18 起任务板**不再是**右栏标签页（用户要求删掉那份注册）：它与左栏全局面板
 * 指向同一份数据、同一个组件，两个入口只会让用户不知道该看哪个；而右栏是窄条
 * 常驻视图，放不下依赖图。任务板现在只由左栏 `sidebar.panellist` + `main` 提供。
 */
test('★ 标签页：只注册 webcode-bridge（官方花名册 Team 标签页 0.19.0 已删除）', async () => {
  const { errors, paneKeys, tabDefinitions } = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(errors, [], '注册阶段抛错：' + errors.map(e => e.message).join('; '));
  for (const kind of ['webcode-bridge']) {
    assert.ok(tabDefinitions.has(kind), '标签页类型未注册：' + kind + '（已注册：' + [...tabDefinitions.keys()].join(', ') + '）');
    const def = tabDefinitions.get(kind);
    assert.equal(typeof def.title, 'function', kind + ' 的 title 必须是 thunk（语言切换要能重读）');
    assert.equal(def.priority, 'extension', kind + ' 必须声明 extension 优先级');
    assert.ok(Array.isArray(def.guide) && def.guide.length > 0, kind + ' 缺少 guide 入口');
  }
  // 0.16.18：右栏不得再有任务板标签页。反向断言——防止日后「顺手」把那个 kind
  // 加回来，从而把用户明确要求删掉的双入口重新引入。
  assert.ok(!tabDefinitions.has('webcode-tasks'),
    '右栏不得再注册任务板标签页（0.16.18 起任务板只走左栏 sidebar.panellist）');
  // 0.19.0：右栏不得再有 `webcode-team` 标签页。用户 2026-09-22 明确指出那份
  // 「官方 agentTeams 花名册」参考错了——本插件的 Team 是**多条各自独立的真会话并排**
  // （0.19.55 起由左栏「并发会话」行 + 中央 `main` 面板提供），不是右栏的花名册。
  // 这条是反向断言：把它加回来即变红。
  assert.ok(!tabDefinitions.has('webcode-team'),
    '右栏不得再注册 webcode-team 标签页（0.19.0：Team = 中央区并列多会话，不是官方花名册）');
  assert.ok(!paneKeys.includes('dsh-webcode-bridge/team'),
    '官方花名册 Team 面板的正文座位仍挂在 sidebar.right.pane.tab 上——没删干净');
  // 正文各自占一个 keyed 座位，且 key 互不相同（合成一个会让标签条出现同名项）。
  assert.equal(new Set(paneKeys).size, paneKeys.length, 'pane.tab 座位 key 有重复：' + paneKeys.join(', '));
  assert.ok(paneKeys.length >= 1, '面板正文未注册（座位：' + paneKeys.join(', ') + '）');
  assert.ok(!paneKeys.includes('dsh-webcode-bridge/tasks'),
    '任务板正文仍挂在 sidebar.right.pane.tab 上——右栏那份注册没删干净');
  // 0.19.0：删掉 Team 面板**之后**，右栏正文座位应当**恰好剩两个**——站点目录
  // （`dsh-webcode-bridge`）与网页镜像（`dsh-webcode-bridge/site`）。
  //
  // 这条比「不含某个 key」更强：它同时挡住「删过头」（座位少了 → 面板废了）与
  // 「删不干净」（还剩 team/tasks 座位）两种失败。值按**实测**写死，将来的改动者
  // 必须显式面对这条判据并同步更新它，而不是顺手让集合漂移。
  // 0.19.67：新增第三个座位——「并发会话（右栏）」= `webcode-concurrent/rail`，它把并发列
  // 做成**官方右栏页签**（用户：「右侧 tab 功能一并抄上」）。这条判据仍按实测写死：
  // 座位集合再变就必须显式面对它。
  assert.deepEqual([...paneKeys].sort(),
    ['dsh-webcode-bridge', 'dsh-webcode-bridge/site', 'webcode-concurrent/rail'],
    '右栏正文座位集合变了（实测应为目录 + 网页镜像 + 并发会话）：' + paneKeys.join(', '));
  assert.deepEqual([...tabDefinitions.keys()].sort(),
    ['webcode-bridge', 'webcode-concurrent', 'webcode-site'],
    '右栏标签页类型集合变了（实测应为目录 webcode-bridge + 并发会话 webcode-concurrent + 网页镜像 webcode-site）：'
    + [...tabDefinitions.keys()].join(', '));
});

/**
 * 0.19.55：并发会话必须落在**左栏行 + 同名 main 面板**上，而不是会话内的视图页签。
 *
 * 这条与 `test/team-compare.test.mjs` 分工：那边查 `ConcurrentColumns` 的内部实现
 * （真会话 create/retain/release、官方 conversation.content、两个页签），这边查
 * **注册位置**——一个做对了但没注册到 `main` 的组件，用户点不到，等于没做。
 *
 * 为什么从 `conversation.view` 搬走（0.19.55，用户原话见 team-compare 文件头）：
 * 每列现在渲染的是官方自己的会话体，而 `renderFactorySlot` 会检查渲染祖先——在
 * `conversation.content` 的子树里（也就是会话内视图所在的位置）再渲染同名 factory
 * 会当场抛 `recursive render of factory 'conversation.content'`。所以旧那个
 * `webcode-compare-view` 页签**必须**不存在，改由左栏「并发会话」行 + `main` 提供。
 */
test('★ 0.19.55 并发会话：必须由左栏行 + 同名 main 提供，且不得再挂在 conversation.view', async () => {
  const { errors, panelEntries, mainKeys, viewDefinitions } = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(errors, [], '注册阶段抛错：' + errors.map(e => e.message).join('; '));

  // 正面：左栏那一行逐字叫「并发会话」，并且有同名 main 座位。
  const row = panelEntries.find((e) => e.id === 'webcode-concurrent-panel');
  assert.ok(row, 'sidebar.panellist 未注册并发会话入口（已注册：'
    + panelEntries.map((e) => e.id).join(', ') + '）');
  assert.equal(typeof row.label, 'function', 'label 必须是 thunk（语言切换要能重读）');
  assert.equal(row.label(), '并发会话', '左栏那一行必须逐字叫「并发会话」（用户点名的词）');
  assert.ok(mainKeys.includes('webcode-concurrent-panel'),
    'main 座位未注册同名 key（已注册：' + mainKeys.join(', ') + '）——只注册一半，点一下就报错');

  // 反面：会话内那个「并发」页签必须已经删除（技术上也不可能，见上方文档注释）。
  assert.ok(!viewDefinitions.has('webcode-compare-view'),
    'conversation.view 上不得再有并发视图（0.19.55 起它必然抛 recursive render of factory）');
});

/**
 * 0.19.62 真机排障轮：并发面板「一片空白」的**结构免疫**。
 *
 * 真机故障链（两轮都成立）：main 条目里任何一层渲染抛错 → 官方 SlotErrorBoundary
 * 渲染 `<div data-slot-error>`（**空 div**）→ 用户看到「连页签都没有的全空面板」，
 * 控制台报错只有 F12 才看得到。修法两层：
 *   ① 面板自己的 `HwbBoundary` 包住列区与每列正文——崩溃显示**可读错误文本**，
 *      不再整块空白（这是本条用例钉的）；
 *   ② 边界类惰性构建（React.Component 不存在时回退透传）——否则桩上整个
 *      bundle 求值失败，本文件全部用例死在 "Class extends value undefined"
 *     （上一版实锤，见 0.19.62 台账「三之二」）。
 */
test('★ 0.19.62 并发：条目内错误边界必须存在——崩溃显示可读错误而非官方空盒', async () => {
  const src = clientSrcOf();
  // ① 边界存在且惰性：React.Component 缺席时必须回退为透传，而不是让 bundle 求值崩掉。
  assert.match(src, /const HwbBoundary = \(typeof React\.Component === 'function'\)/,
    '边界类必须按 React.Component 是否存在惰性构建（桩上没有 Component）');
  assert.match(src, /\: \(props\) => props\.children;/, '缺席回退必须是透传函数组件');
  // ② 两层挂点：列区整体 + 每列正文。
  assert.match(src, /h\(HwbBoundary, \{ label: '并发会话面板' \},\s*\n\s*h\(ConcurrentColumns/,
    '列区必须包在 HwbBoundary 里（面板逻辑崩溃 ≠ 整块空白）');
  assert.match(src, /h\(HwbBoundary, \{ label: '并发列 ' \+ titleOf\(col\.sessionId\) \}/,
    '每列正文必须各自包一层 HwbBoundary（一列崩溃不拖垮其余列）');
  // ③ 崩溃时的呈现必须可读：有 label、有 message，而不是空 div。
  assert.match(src, /渲染失败：/, '崩溃呈现必须带「渲染失败」说明');
  assert.match(src, /whiteSpace: 'pre-wrap'/, '错误 message 必须可读地换行显示');
  // ④ 与官方边界的分工写清楚（后人改动前先读到）。
  assert.match(src, /空 div/, '必须写明官方空盒机理（后人改前先读到为什么需要自建边界）');
});

/** client-render 侧读 client.cjs 源码（复用本文件既有的 readFileSync 导入）。 */
function clientSrcOf() {
  return readFileSync(path.join(here, '..', 'lib', 'client.cjs'), 'utf8');
}

// 0.19.0 删除：三条「官方花名册 Team 面板」用例（成员角色/状态/模型渲染、inactive
// 显示「可唤醒」、只有 lead 时说明没有派生 teammate）。
//
// 删除理由：它们验证的那个面板**本身已被用户否定**——用户 2026-09-22 明确说
// 「删除参考官方用的team面板，和我设想的team不同，参考错误了」（原话见
// `doc/user-voice-log.md:3670`）。本插件的 Team 是中央区的并列多会话，不是右栏
// 的官方 `agentTeams` 花名册。用例随被验证对象一并删除；「不得复活」由上面两条
// 反向断言（`webcode-team` 标签页 / `dsh-webcode-bridge/team` 座位）钉住。

/**
 * 任务板：四组分区必须都在，且「可开工 / 被阻塞」按**官方 ready** 分流。
 */
test('★ 任务板：可开工与被阻塞必须分开，且阻塞明细要点名上游与它的状态', async () => {
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'tasks',
    roster: {
      team: [],
      tasks: [
        { id: 'a', subject: '跑基线', status: 'in_progress', ownerName: 'lead', blockedBy: [], ready: false },
        { id: 'b', subject: '可以开工的', status: 'pending', blockedBy: [], ready: true },
        { id: 'c', subject: '等基线的', status: 'pending', blockedBy: ['a'], ready: false },
        { id: 'd', subject: '已完成的', status: 'completed', blockedBy: [], ready: false },
      ],
    },
  });
  assert.deepEqual(errors, [], '任务板渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  for (const head of ['可开工', '被阻塞', '进行中', '已完成']) {
    assert.ok(text.includes(head), '缺少分区：' + head + ' —— ' + text.slice(0, 400));
  }
  assert.ok(text.includes('可以开工的'), '就绪任务未渲染：' + text.slice(0, 400));
  assert.ok(text.includes('等基线的'), '被阻塞任务未渲染：' + text.slice(0, 400));
  // 阻塞明细必须点名上游**并带它自己的状态**：否则分不清「正常等待」与
  // 「上游已失败、需要人处理」——那是两个完全不同的动作。
  assert.ok(/等在 跑基线（进行中）/.test(text),
    '阻塞明细未点名上游或没带上游状态：' + text.slice(0, 600));
  // 写范围是 advisory 而不是锁：官方明文，界面必须说清楚。
  assert.ok(/写范围重叠只是提醒而不是锁/.test(text), '未说明写范围是 advisory');
  // 就绪来源必须如实标注（官方值 vs 桥现算）。
  assert.ok(/就绪（ready）取官方算好的判据/.test(text), '未说明就绪判据的来源');
});

/**
 * 任务板：图诊断（阻塞点 / 关键路径 / 结构问题）必须真的渲染。
 *
 * 这是本轮新增的**图级**视角——官方逐行事实里没有这一层。三条都必须到达界面，
 * 否则「为什么整块板没动」这个问题在 UI 上仍然没有答案。
 */
test('★ 任务板：图诊断三件套（阻塞点 / 关键路径 / 环）都必须渲染', async () => {
  const graph = {
    counts: { total: 3, pending: 2, inProgress: 1, completed: 0, ready: 1, blocked: 1, unowned: 0, deleted: 0 },
    nodes: [],
    acyclic: true,
    criticalPath: ['a', 'c'],
    criticalPathLength: 2,
    cycles: [],
    selfLoops: [],
    missingEdges: [],
    blockedOn: [{ id: 'a', subject: '跑基线', status: 'in_progress', ownerName: 'lead', waitingCount: 1 }],
  };
  const tasks = [
    { id: 'a', subject: '跑基线', status: 'in_progress', ownerName: 'lead', blockedBy: [], ready: false },
    { id: 'b', subject: '旁路', status: 'pending', blockedBy: [], ready: true },
    { id: 'c', subject: '收尾', status: 'pending', blockedBy: ['a'], ready: false },
  ];
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'tasks',
    roster: { team: [], tasks, graph },
  });
  assert.deepEqual(errors, [], '图诊断渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/当前阻塞点/.test(text), '缺少「当前阻塞点」分区：' + text.slice(0, 500));
  assert.ok(/卡住 1 项/.test(text), '阻塞点未给出卡住的下游数：' + text.slice(0, 500));
  assert.ok(/关键路径（2 个任务）/.test(text), '缺少关键路径：' + text.slice(0, 500));
  // 关键路径必须用**任务标题**而不是裸 id——裸 id 用户认不出是哪个任务。
  assert.ok(/跑基线 → 收尾/.test(text), '关键路径未渲染成可读标题链：' + text.slice(0, 600));
});

/**
 * 任务板：图结构问题（环 / 自环 / 悬空边）必须红字报出，且说明后果。
 *
 * 带环的图在界面上表现为「一堆永远不 ready 的待办」，看起来像卡死，其实是结构错误。
 * 只说「有环」不够——必须说「环内任务永远不会就绪」。
 */
test('★ 任务板：环 / 自环 / 悬空边必须报出，并说明「永远不会就绪」的后果', async () => {
  const graph = {
    counts: { total: 2, pending: 2, inProgress: 0, completed: 0, ready: 0, blocked: 2, unowned: 2, deleted: 0 },
    nodes: [], acyclic: false, criticalPath: [], criticalPathLength: null,
    cycles: [['a', 'b']], selfLoops: ['c'], missingEdges: [{ from: 'a', to: 'ghost' }],
    blockedOn: [],
  };
  const { errors, tree } = await renderPane({
    payloads: [emptyWindows], which: 'tasks',
    roster: { team: [], tasks: [{ id: 'a', subject: 'A', status: 'pending', blockedBy: ['b'], ready: false }], graph },
  });
  assert.deepEqual(errors, [], '结构问题渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(/图结构问题/.test(text), '缺少图结构问题分区：' + text.slice(0, 500));
  assert.ok(/依赖成环/.test(text), '未报出环：' + text.slice(0, 500));
  assert.ok(/永远不会就绪/.test(text), '未说明环的后果（环内任务永远不会就绪）');
  assert.ok(/自环/.test(text), '未报出自环：' + text.slice(0, 500));
  assert.ok(/悬空依赖/.test(text), '未报出悬空边：' + text.slice(0, 500));
  // 带环时**不得**给出关键路径——无定义的东西不该有值。
  assert.ok(!/关键路径（/.test(text), '带环时仍渲染了关键路径（图上最长路径无定义）');
  assert.ok(/无法计算关键路径与深度/.test(text), '带环时未说明为何没有关键路径');
});

/**
 * 任务板面板的读不到路径：必须说「读不到」+ 原因，不得画成空列表。
 *
 * 0.19.0：本用例原先同时覆盖「Team 面板」，那个面板已删除（见上方删除说明），
 * 故只剩任务板这一半。任务板这半照旧有效且必须保留——「读不到 ≠ 确实没有」
 * 是本项目反复踩过的那类缺陷。
 */
test('★ 任务板：读不到时必须给原因，不得画成「确实没有」', async () => {
  const roster = { team: [], tasks: [], teamError: 'caller-not-live', tasksError: 'caller-not-live' };

  const tasks = await renderPane({ payloads: [emptyWindows], which: 'tasks', roster });
  assert.deepEqual(tasks.errors, [], '任务板读不到时抛错：' + tasks.errors.map(e => e.message).join('; '));
  const taskText = treeText(tasks.tree);
  assert.ok(taskText.includes('caller-not-live'), '任务板未给出原因：' + taskText.slice(0, 400));
  assert.ok(/不代表没有任务/.test(taskText), '任务板未澄清「读不到 ≠ 没有任务」');
});

/**
 * 来源标注必须真的**渲染出来**（0.19.x）。
 *
 * 为什么需要这条：`roster.js` 一直在算 `teamSource` / `tasksSource`，0.19.0 起唯一的
 * 界面消费者是任务板面板。第二轮独立审查抓到过一个形态——服务端算、前端不读，而护栏
 * 只做源码正则（`assert.match(client, /sourceText\(data\?\.teamSource\)/)`），于是
 * 「字段根本没送到组件」这种情况照样全绿：正则匹配的是**代码里有没有这行**，不是
 * 「这行有没有跑」。所以判据必须落在**渲染出的文本**上。
 *
 * 两个值都要覆盖：`disk`（AgentTeams 未提供实时数据）与 `ledger`（桥自有任务台账）——
 * 前者是「没有实时数据」的如实交代，后者是本项目 0.19.0 补过映射的那个键；只测一个
 * 会让另一个的映射缺失重新变成静默空白。
 */
test('★ 任务板：来源标注（teamSource / tasksSource）必须渲染出可读文本', async () => {
  const roster = {
    team: [], tasks: [{ id: 'a', subject: 'A', status: 'pending' }],
    teamSource: 'disk', tasksSource: 'ledger',
  };
  const { errors, tree } = await renderPane({ payloads: [emptyWindows], which: 'tasks', roster });
  assert.deepEqual(errors, [], '带来源标注渲染抛错：' + errors.map(e => e.message).join('; '));
  const text = treeText(tree);
  assert.ok(text.includes('来源：磁盘状态'), 'teamSource=disk 未渲染成可读文本：' + text.slice(0, 400));
  assert.ok(text.includes('来源：桥自有任务台账'), 'tasksSource=ledger 未渲染成可读文本：' + text.slice(0, 400));

  // 反向面：字段缺省时**不得**凭空空渲染一句「来源：」——
  // 那会把「服务端没给来源」写成「来源不明」，是造事实。
  const none = await renderPane({ payloads: [emptyWindows], which: 'tasks', roster: { team: [], tasks: [] } });
  assert.deepEqual(none.errors, [], '无来源标注渲染抛错：' + none.errors.map(e => e.message).join('; '));
  assert.ok(!/来源：/.test(treeText(none.tree)), '服务端没给来源时不该渲染任何来源行');
});

/**
 * 两个新面板不得在浏览器侧重算图论。
 *
 * 图诊断由服务端 `lib/task-graph.js` 算好后经 /status 透出。在浏览器侧再写一份
 * （比如本地按 blockedBy 推 ready）会立刻产生两份真相：面板说「可开工」、服务端
 * 说 ready=false，而用户不知道信哪个——这正是本项目反复踩过的那一族缺陷。
 */
test('★ 新面板：不得在客户端重算就绪/关键路径（图诊断只有一个来源）', async () => {
  const src = bridgeSrcFrom('client.cjs');
  const at = src.indexOf('function TaskBoardPanel');
  assert.ok(at > 0, '找不到 TaskBoardPanel');
  // 取到下一个顶层函数为止，避免把别处的代码算进来。
  const end = src.indexOf('\n    function ', at + 10);
  const body = src.slice(at, end === -1 ? at + 6000 : end);
  assert.ok(!/blockedBy\.every\(/.test(body),
    'TaskBoardPanel 里出现了官方就绪判据的重算 —— 就绪只能取服务端/官方值');
  assert.ok(!/\.depth\s*=/.test(body) && !/topolog/i.test(body),
    'TaskBoardPanel 里出现了图算法 —— 图诊断只能来自服务端 graph 字段');
  assert.ok(/data\.graph|graph\b/.test(body), 'TaskBoardPanel 没有消费服务端的 graph 字段');
});

// ---------------------------------------------------------------- 0.16.0 左栏入口

/**
 * 左栏入口必须**成对**注册：`sidebar.panellist` 的行 + 同名 key 的 `main` 座位。
 *
 * 为什么这条要单独钉住：官方契约原文是「Each list id addresses the matching main
 * panel; the sidebar owns the button」——侧栏行只是指向 main 座位的按钮，点它走
 * shell 的 `selectPanel(id)`，而 layout service 会**校验该 key 是否已注册**
 *（`layout.selectPanel: main panel \"X\" is not registered` 直接抛）。
 * 只注册一半的话，界面看起来正常、点一下就报错——这类「有一半是死的」最难发现。
 * 因此这里同时断言两半都存在，且 id 与 key **逐字相同**（不同名等于没注册 main）。
 */
test('★ 左栏入口：sidebar.panellist 与同名 main 座位必须成对注册', async () => {
  const { errors, panelEntries, mainKeys } = await renderPane({ payloads: [emptyWindows] });
  assert.deepEqual(errors, [], '注册阶段抛错：' + errors.map(e => e.message).join('; '));
  assert.ok(panelEntries.length > 0, 'sidebar.panellist 从未注册（左栏入口不存在）');
  const entry = panelEntries[0];
  assert.ok(entry.id, 'panel 行缺少 id —— 契约要求 list id 即 main 面板 key');
  assert.equal(typeof entry.label, 'function', 'panel 行 label 必须是 thunk（语言切换要能重读）');
  assert.equal(entry.label(), '任务板', 'panel 行的标签不是「任务板」');
  assert.ok(mainKeys.includes(entry.id),
    'main 座位未注册同名 key：' + entry.id + '（已注册：' + mainKeys.join(', ') + '）');
});

/**
 * 左栏入口的图标：只画图标，不得自绘按钮。
 *
 * 官方契约把按钮（含 Tooltip、aria-current、折叠态的 18px 图标、选中高亮）归 shell，
 * 我们只供图标 + 标签。若这里出现 <button> 或 onClick，就是**把 DOM 注入那套
 * 搬回来了**：那会与 shell 的渲染打架（点一下触发两次），且丢掉键盘可达性。
 */
test('★ 左栏入口图标：不得自绘 button（按钮与可访问名归 shell）', async () => {
  const src = bridgeSrcFrom('client.cjs');
  const at = src.indexOf('function TaskBoardPanelIcon');
  assert.ok(at > 0, '找不到 TaskBoardPanelIcon');
  const end = src.indexOf('\n    function ', at + 10);
  const body = src.slice(at, end === -1 ? at + 2000 : end);
  assert.ok(!/'button'/.test(body), 'TaskBoardPanelIcon 自绘了 button —— 按钮必须归 shell');
  assert.ok(!/onClick/.test(body), 'TaskBoardPanelIcon 挂了点击处理 —— 选中动作必须归 shell');
  assert.ok(/props\?\.size|props\.size/.test(body), '图标没有消费 shell 给的 size（折叠态尺寸会错）');
});

test('设置页：useSessions 缺席时优雅降级为 null，不得整块崩掉', async () => {
  const src = bridgeSrcFrom('client.cjs');
  // 回落链必须是 useSessions → props.sessionId → null：测试桩与「会话尚未建立」
  // 都走这条路，且这是**正常情况**而非错误（面板会如实说 no-session-id）。
  // 0.19.2：两条来源都要过 `sessionIdOf` 归一（见该函数的注释）——官方 standard prop
  // 给字符串，而槽 inject 的绑定键在作用域漂移时可能是包装对象；只认字符串就会
  // 静默拿到 null。断言因此钉「归一后的回落链」，而不是「裸值或运算」。
  assert.ok(/return sessionIdOf\(current\) \|\| sessionIdOf\(props\?\.sessionId\);/.test(src),
    'useCurrentSessionId 的回落链变了：应为 sessionIdOf(useSessions) → sessionIdOf(props.sessionId)');
  // 归一函数必须认三种已知形态：字符串 / 带 key 的绑定对象 / 带 sessionId 的对象。
  assert.ok(/typeof value === 'string'/.test(src) && /typeof value\.key === 'string'/.test(src),
    'sessionIdOf 必须同时认字符串与绑定对象形态（否则 wait-stats 拿到对象、label 为空、药丸整行不渲染）');
  // 无条件调用 hook（条件调用会复现 SiteAccounts 那类 hooks 顺序违规）。
  assert.ok(/const useSessions = typeof props\?\.useSessions === 'function' \? props\.useSessions : noSessions;/.test(src),
    'useSessions 的取值被写成条件分支外的形式之外了；必须常量选择后再无条件调用');
});

// ------------------------------------------------- 0.16.33 二级站点菜单 + 站点设置 tab

/**
 * 0.16.35：站点下拉菜单（`SiteMenu`）已删除，且**不得复活**。
 *
 * 它曾用官方 `Menu` 原语画「站点 → 同站点多账户向右展开」，作为工具条那颗站点按钮的
 * 下拉。用户 0.16.35 明确否掉了那颗按钮（「你现在的 deepseek 上面那点击排列多个网点
 * 就不要了」），于是它失去全部调用方。
 *
 * 这条钉子钉两件事：
 *   ① 组件与其 `Menu` 解构都不得残留（死代码会让人以为还有入口）；
 *   ② 它承担过的能力必须在**新**位置仍在：多账户可选 → 站点目录的子行（已由
 *      「站点目录：点一行会为该站点开标签」那条用例行为验证）。
 *
 * 保留下 0.16.33–0.16.34 那个真缺陷的记录（用户报「切换不了了」）：官方
 * `useDismissOnOutsidePointer` 的 rootRef 若不挂在「同时包住触发按钮与列表」的那层，
 * 每次 pointerdown 都会被判成「外面」，列表在 click 前卸载 → onSelect 永不触发。
 */
test('★ 0.16.35：站点下拉菜单 SiteMenu 已删除且不得复活', async () => {
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(!/function SiteMenu\(/.test(src), 'SiteMenu 被复活了 —— 那个工具条下拉已按用户要求删除');
  // 0.16.37：`Menu` **又有了正当使用方**——站点目录胶囊右端的账户展开（官方
  // 「新建终端」同款结构）。因此这条断言从「解构不得残留」改成「解构必须存在」，
  // 把「工具条那颗下拉」（禁止）与「胶囊右端的账户菜单」（要求）分开。
  // 这正是 0.16.37 用户说「每行右边能选账户」的落点。
  assert.ok(/const Menu = primitives\.Menu/.test(src), '官方 Menu 原语未接入 —— 账户展开没有承载');
  assert.ok(/function SiteCatalogBody\(/.test(src), '站点目录组件不存在 —— 站点列表没有落点');
  assert.ok(/\.hwb-site-card\{/.test(src), '站点目录胶囊外壳样式缺失');
});

/**
 * 0.16.35：**横向站点标签条必须在位**（它被删过一次又恢复了，这条钉子两向都钉）。
 *
 * ## 这段历史必须留下，否则第三个人还会再删一次
 *
 * 0.16.34 我按「低频动作不该常驻占版面」删掉了这一行，并写了当时那条反向钉子
 *（「横向站点标签条已删除」）。那是**误判**：用户 0.16.35 要的就是「一行并列显示
 * 不同网址栏目」，指的就是这条。钉子于是掉头——现在它防的是「又被删掉」。
 *
 * 断言分两组：
 *   · 渲染点与三处配套代码**存在**（滚轮横向滚动 effect / onTabKey / siteIds）；
 *   · 标签里**不得**出现登录态（用户：「登录态不要看」）——恢复时唯一的有意改动。
 */
/**
 * 0.16.36：**面板内的横向站点条已删除**（第三次也是最后一次掉头）。
 *
 * ## 这段历史必须完整留下
 *
 * 0.16.34 删（我按「低频动作不该常驻」判断）→ 0.16.35 恢复（我把它读成了「一行并列
 * 显示不同网址栏目」）→ 0.16.36 再删（用户明说「页面内顶部那一行去除……只留下官方
 * 多开一级和 web bridge 并列那行」）。
 *
 * 读对的地方是：**「一行并列」由 DSH 官方右侧栏自己的标签条承担**（Web Bridge /
 * DeepSeek / 智谱清言… 那一行），面板里不该再有一条自己的站点导航。
 *
 * 这条钉子防两件事：
 *   ① 面板内那条渲染点与配套代码（滚轮 effect / onTabKey / siteIds）**不得复活**；
 *   ② 「一行并列」的能力必须仍在——它由 `multiple: true` 的站点标签提供，
 *      已由「站点目录：点一行会为该站点开标签」那条用例行为验证。
 */
test('★ 0.16.36：面板内横向站点条已删除，配套代码不残留', async () => {
  const src = bridgeSrcFrom('client.cjs');
  // 只查**活代码**（带引号的渲染点与样式规则）；注释里会提到这些名字解释为什么删。
  assert.ok(!/'hwb-sitebar'/.test(src), '面板内横向站点条被复活了');
  assert.ok(!/'hwb-site-tab/.test(src), '站点 tab 胶囊被复活了');
  assert.ok(!/"\.hwb-sitebar\{/.test(src), '站点条样式残留（无宿主的死规则）');
  assert.ok(!/"\.hwb-site-tab\{/.test(src), '站点 tab 样式残留');
  assert.ok(!/const onTabKey = \(e\) =>/.test(src), 'onTabKey 残留 —— 它只服务于已删除的标签条');
  // 0.16.38：`tabsRef` 这个名字本身**允许**再出现——设置页的站点 tab 条用它做
  // 滚轮横向滚动。这里钉的是**那个组件**不复活（上面的 class 名与 onTabKey 已覆盖），
  // 而不是钉一个现在有正当用途的标识符。
  // 站点目录在（那是「从上往下」的落点）。
  assert.ok(/function SiteCatalogBody\(/.test(src), '站点目录组件不存在');
  assert.ok(/\.hwb-site-card\{/.test(src), '站点目录胶囊外壳样式缺失');
});

/**
 * 0.16.37：站点目录必须是官方「新建终端」那张**胶囊**，不是左栏的列表行。
 *
 * 用户原话：「让你完全参考『新建终端』做，你现在只是在半路」「将 deepseek 等网站做出
 * 和他一样的胶囊和排版」「每行右边能够选择登录账号（有多个账号的）做的类似『新建终端』
 * 右边点击拉取时候的展开」。
 *
 * 结构对着官方 `TerminalGuide`（右栏「新建终端」就是它）：一张胶囊卡片，左端主区是
 * 一颗 `Button variant:'ghost'`，右端一颗 44px 宽的 chevron `Button` 作为官方 `Menu`
 * 的 anchor。尺寸逐项来自它的 `TerminalGuide.module.css`。
 *
 * 这条钉子钉四件事：
 *  ① 胶囊外壳的几何（24px 圆角 / 半像素描边 / bg-layer-1 底色）；
 *  ② 主区与右端触发器是**两颗独立的**官方 `Button`，各自的几何按官方给；
 *  ③ 账户展开走官方 `Menu` 原语，不是自绘箭头 + 自管展开态；
 *  ④ 上一轮那套左栏 `panelRow` 口径（`.hwb-catalog-row`）**不得复活**——
 *     「只是在半路」指的就是它。
 */
/**
 * ★ 0.19.4 站点目录右侧：**统一**账号下拉（真实头像/昵称 + 「新账号」）。
 *
 * 用户原话：「右侧就是每个选择框右侧现在是登录字样的下拉！！然后是改为类似新建终端框
 * 右侧选择！」「下拉取后显示已登录头像和昵称，以及额外加一行登录选择」「下拉框没那么宽！
 * 文本显示尽量不要有括号补充！精简！新账号这三个字就行了」。
 */
test('★ 0.19.4 站点目录右侧统一成账号下拉：真实头像/昵称 + 新账号，旧「登录」按钮不得复活', async () => {
  const src = bridgeSrcFrom('client.cjs');
  // ① 一种形状：`!multi` 的单按钮分支必须消失（否则单账号站加不了第二个账号）
  assert.ok(!/if \(!multi\)/.test(src), '单账号站点的分支必须消失 —— 每一行都是同一种下拉');
  assert.ok(!/\.hwb-site-login\{/.test(src), '0.19.0 单账号「登录」按钮的 CSS 规则必须删掉（死规则会误导下一个改样式的人）');
  assert.ok(!/className: 'hwb-site-login'/.test(src), '0.19.0 单账号「登录」按钮必须随统一下拉删除');
  // ② 昵称：抓到的真实值优先，抓不到回落槽名
  assert.ok(/const acctName = \(a\) => a\.accountName \|\| a\.displayName/.test(src),
    '昵称必须「真实值 → 回落槽名」，不许只显示槽名');
  // ③ 头像：真实值优先，抓不到回落站点标记（不许留空）
  assert.ok(/const url = a\.avatarUrl \|\| null/.test(src), '头像必须取真实值');
  assert.ok(/hwb-acct-glyph/.test(src), '抓不到头像必须回落站点标记');
  assert.ok(/\.hwb-acct-img\{[^}]*border-radius:50%/.test(src), '头像必须是圆框（与站点标记同列宽）');
  // ④ 底部固定一行「新账号」：**三个字**，且不许有括号补充
  assert.ok(/\{ id: '__new__' \+ sid, label: '新账号'/.test(src), '「新账号」那一行缺失或文案被改长');
  assert.ok(!/登录（打开桥自己的浏览器窗口）/.test(src), '带括号的长文案必须清掉');
  // ⑤ 新增账号只有一个服务端入口（槽位合法性只有 accounts.js 说了算）
  assert.ok(/apiSoft\('account-add'/.test(src), '「新账号」必须调服务端的 account-add，不许面板自己算空槽');
  // ⑥ 打开下拉时顺手刷一次真实身份（手动在网页里登录后，缓存还是空的）
  assert.ok(/refreshIdentities\(accounts\)/.test(src), '打开下拉必须顺手刷新真实昵称/头像');
  // ⑦ 忙碌粒度是**账号**：按站点判会把「同站加第二个账号」静默丢弃
  assert.ok(/const isBusy = \(key\) => busyAccounts\.includes\(key\)/.test(src),
    '开窗的忙碌状态必须按账号判（用户要求「能够同时开多个账号的窗口」）');
  assert.ok(!/busySids/.test(src), '按站点判的旧忙碌状态必须清干净');
});

test('★ 0.19.59 站点目录：多账户卡片以第 1 个账户为主身份，其余叠层（+N），且头像不再与站点标记并排', async () => {
  // 用户 2026-10-03 原话：「豆包和kimi——一个账户的那种展示不错，但是deepseek和z.ai
  // 两个账户的就不行？……展示，可以以第一个按照原来的那样，234你自己怎样适配」。
  //
  // 旧实现（0.19.47）只在**单账户**站点取真实身份当卡片身份，多账户一律回落成
  // 「站点名 + 站点矢量图」——那正是用户看到的「站点之间不同步」。
  const src = bridgeSrcFrom('client.cjs');
  // ① 主身份取值不再只认单账户站点。
  assert.ok(/const primary = accounts\[0\] \|\| null;/.test(src), '卡片主身份必须取第 1 个账户');
  assert.ok(!/accounts\.length === 1 \? accounts\[0\] : null/.test(src),
    '「只在单账户时取真实身份」的旧判据必须消失（它就是站点之间不同步的来源）');
  // ② 叠层存在、绝对定位（不参与排版：账号多少都不改胶囊几何），且上限显式声明。
  assert.ok(/hwb-catalog-stack/.test(src), '多账户缺少叠层挂点');
  assert.ok(/\.hwb-catalog-stack\{[^}]*position:absolute/.test(src),
    '叠层必须绝对定位——否则它会挤动标题，账号多的站点胶囊会变形');
  assert.ok(/const STACK_MAX = 3;/.test(src), '叠层上限必须显式声明（否则「+N」没有阈值）');
  // ③ 主头像必须**盖住**站点标记（绝对定位），而不是并排——并排时抓到头像的站点
  //    会同时画出两个图标，那是「展示方法不一致」的可见来源。
  assert.ok(/\.hwb-catalog-img\{[^}]*position:absolute/.test(src),
    '主头像必须绝对定位在身份盒里（否则头像与矢量标记同时出现）');
  // ④ 行为断言：两个账户的站点 → 卡片标题是**网站原名**（0.19.61 用户指令：
  //    「右侧 tab 菜单显示的是用户名而不是网站名」），第 1 个账户的真实昵称仍在下拉行里，
  //    叠层与说明行都在，两个账户的昵称/头像一个都不丢。
  const two = [
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', slot: 'default', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true, accountName: 'RSYHN', avatarUrl: 'https://cdn.example.test/a.png' },
    { siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek#2', slot: '2', displayName: 'DeepSeek 网页版 (账户2)', initialized: true, loggedIn: true, accountName: '17700000000' },
  ];
  const r = await renderPane({ payloads: [emptyWindows], sites: two, which: 'catalog' });
  assert.deepEqual(r.errors, [], '多账户目录渲染抛错：' + r.errors.map(e => e.message).join('; '));
  const text = treeText(r.tree);
  // 标题恒为网站名：不许再出现「抓得到昵称就显昵称、抓不到就显站点名」那种同列两种语义。
  // 取值走客户端的 `SITE_NAMES`（`siteName(sid)` ⇒ 'DeepSeek'），与服务端行里的
  // `siteName` 字段无关——这正是「网站原名」的唯一来源。
  assert.ok(text.includes('DeepSeek'), '卡片标题必须是网站原名');
  assert.ok(!text.includes('RSYHN'), '卡片标题不得再取真实昵称当站点名（昵称只在下拉行里）');
  assert.ok(text.includes('2 个账号'), '说明行必须给出账户总数（叠层只画缩略图，计数在这里）');
  const html = JSON.stringify(r.tree);
  assert.ok(html.includes('hwb-catalog-stack'), '多账户卡片必须真的渲染叠层节点');
  assert.ok(html.includes('https://cdn.example.test/a.png'), '第 1 个账户的真实头像必须画进卡片');
  assert.ok(html.includes('17700000000'), '第 2 个账户的昵称必须仍在（下拉里各自一行）');
  // 头像必须画在矢量标记**之后**（否则矢量盖住头像 —— 用户 2026-10-04 报的
  // 「头像都没渲染、全是网站矢量」的真根因）。
  assert.ok(src.indexOf("hwb-catalog-img") > src.indexOf("h(SiteGlyph, { sid, size: 26 })"),
    '主头像必须画在矢量标记之后（DOM 顺序决定谁盖住谁）');
});

test('★ 0.19.61 站点目录标题恒为网站名；账号身份不再靠「用户名优先」混排', async () => {
  // 用户 2026-10-04 原话：「右侧 tab 菜单显示的是用户名而不是网站名」「就是没显示网站，
  // 网站错误」「应该显示网站名」。
  const src = bridgeSrcFrom('client.cjs');
  // ① 标题取值里**不得**再出现 accountName —— 抓得到昵称就显昵称会让同一列里
  //    glm 显 RSYHN、deepseek 显站点名（昵称读不到时），同列两种语义。
  assert.ok(!/const title = \(primary && primary\.accountName\)/.test(src),
    '标题不得再取真实昵称（用户明确要求显示网站名）');
  assert.ok(/const title = siteName\(sid\)/.test(src), '标题必须恒取网站原名');
  // ② 昵称没有丢：下拉行仍用它（否则等于把已抓到的事实删掉）。
  assert.ok(/const acctName = \(a\) => a\.accountName \|\| a\.displayName/.test(src),
    '下拉行的昵称仍必须「真实值 → 回落槽名」');
});

test('★ 0.19.61 头像必须画在矢量标记**之后**（否则矢量盖住头像），且三处挂点同口径', async () => {
  // 用户 2026-10-04 原话：「右侧 tab 菜单的头像和设置界面头像是网站矢量，头像是网站
  // 矢量，都没渲染」；追问后确认「只有头像没出来，昵称是对的」。
  //
  // 真根因不是「抓不到头像」（服务端实测 deepseek/glm/kimi/doubao/zai 都回真实
  // avatarUrl）：是**画的顺序与占位错**——`SiteGlyph` 与 `<img>` 都是身份盒的
  // 铺满层，而矢量写在 `<img>` 之后 ⇒ 按 DOM 顺序矢量压在上面，头像永远看不见。
  // 昵称能显示是因为它在另一个文本节点上，与这条层叠无关。
  const src = bridgeSrcFrom('client.cjs');
  // 与文件里其它样式断言同一条取规则纪律：CSS 是 `".hwb-x{...}"` 形式，
  // 右界必须是 `}"`（写成 `"}` 会静默扫到文件结尾，断言横跨几十条规则 = 假绿）。
  const ruleAt = (sel) => {
    const i = src.indexOf('"' + sel + '{');
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    assert.ok(end > i, '样式规则 ' + sel + ' 没有终止符');
    return src.slice(i, end + 2);
  };
  /** 该选择器在源码里出现了几次（重复定义会让后者静默覆盖前者）。 */
  // ① 三处头像挂点：头像绝对定位、底图裁掉 SiteGlyph 的 `size+8` 画布余量。
  assert.match(ruleAt('.hwb-catalog-img'), /position:absolute/, '目录卡片头像必须绝对定位');
  assert.match(ruleAt('.hwb-catalog-ico'), /overflow:hidden/,
    '目录身份盒必须裁掉 SiteGlyph 的 size+8 画布（否则矢量从四角溢出，即用户看到的「边边角角」）');
  assert.match(ruleAt('.hwb-avatar-img'), /position:absolute/,
    '设置页账户头像必须绝对定位（旧实现缺这条 ⇒ img 与矢量并排挤在 28px 圆框里，看起来「没渲染」）');
  assert.match(ruleAt('.hwb-avatar'), /overflow:hidden/, '设置页头像圆框必须裁剪溢出');
  assert.match(ruleAt('.hwb-acct-img'), /position:absolute/, '下拉行头像必须绝对定位');
  // ② 下拉图标是**单个**定位节点（Menu 的 icon 契约收单个节点，数组会被当成两个图标）。
  assert.ok(/className: 'hwb-acct-face'/.test(src), '下拉图标必须包一层定位父元素');
  assert.match(ruleAt('.hwb-acct-face'), /position:relative/, '下拉图标父元素必须建立定位上下文');
  // ③ 行为：渲染树里头像节点与矢量标记同时存在（有头像时头像在最上层、失败时露出标记）。
  const sites = [{
    siteId: 'glm', siteName: 'GLM', accountKey: 'glm', slot: 'default', displayName: 'GLM',
    initialized: true, loggedIn: true, accountName: 'RSYHN', avatarUrl: 'https://cdn.example.test/g.png',
  }];
  const r = await renderPane({ payloads: [emptyWindows], sites, which: 'catalog' });
  assert.deepEqual(r.errors, [], '目录渲染抛错：' + r.errors.map(e => e.message).join('; '));
  const html = JSON.stringify(r.tree);
  assert.ok(html.includes('hwb-catalog-img'), '有真实头像时必须真的画 img');
  assert.ok(html.includes('hwb-catalog-ico'), '矢量标记必须仍在（img 失败时靠它回落）');
  // 矢量标记必须**先**出现（DOM 顺序 = 谁盖住谁；z-index 只兜底）。
  assert.ok(html.indexOf('hwb-catalog-ico') < html.indexOf('hwb-catalog-img'),
    '矢量标记必须画在头像之前（否则矢量压住头像 = 用户报的「头像都没渲染」）');
});

test('★ 0.19.61 站点目录居中：用 auto margin，不得回到 justify-content:center', async () => {
  // 用户 2026-10-04 原话：「右侧 tab，展开时候，窗口够大就没问题，但是缩小窗口就能看到，
  // 顶部置顶了，已经够大时候就已经是偏上了」。
  //
  // 真根因：0.17.0 逐字抄了官方 GuideBody 的 `justify-content:center` + `min-height:100%`
  // + `:after{flex:0 10%}`。那三件在官方 guide 里成立（内容只有一两行，永远装得下），
  // 但站点目录是十行胶囊：窄/矮窗口下内容高于容器 ⇒ 竖直居中把**顶部推到容器外**，
  // 而宿主 `.P3OORG_tabBody` 是 `overflow:hidden` ⇒ 顶部被裁且**无法滚动到达**。
  //
  // `margin:auto` 是唯一两边都成立的写法：有富余时上下等分（= 居中），
  // 空间不足时归零（= 从顶部开始、可滚动、不丢内容）。
  const src = bridgeSrcFrom('client.cjs');
  const ruleAt = (sel) => {
    const i = src.indexOf('"' + sel + '{');
    assert.ok(i > 0, '找不到样式规则：' + sel);
    const end = src.indexOf('}"', i);
    return src.slice(i, end + 2);
  };
  const ruleCount = (sel) => (src.match(new RegExp('"' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{', 'g')) || []).length;
  const catalog = ruleAt('.hwb-catalog');
  assert.equal(ruleCount('.hwb-catalog'), 1, '.hwb-catalog 必须恰好一条规则');
  assert.ok(!/justify-content:center/.test(catalog),
    '不得用 justify-content:center 做竖直居中 —— 内容高于容器时顶部会被裁掉且滚不到');
  assert.match(catalog, /overflow-y:auto/, '矮窗口下必须能滚动到被挤出去的内容');
  assert.match(catalog, /min-height:100%/,
    'min-height:100% 要保留：没有它 flex 容器不撑满，auto margin 没有富余空间可等分');
  assert.equal(ruleCount('.hwb-catalog-list'), 1,
    '.hwb-catalog-list 必须恰好一条规则（重复定义会让垂直 auto 被 margin:0 auto 覆盖）');
  assert.match(ruleAt('.hwb-catalog-list'), /margin:auto/,
    '上下 auto margin 才是居中本体，且空间不足时归零为可滚动');
  assert.ok(!/hwb-catalog:after/.test(src),
    '`:after{flex:0 10%}` 假留白必须删掉 —— 富余不足时它正是把内容推偏的来源');
});

test('★ 0.19.59 账户删除：站点页每个账户行都有「删除」，走服务端 account-remove 且必须两步确认', async () => {
  // 用户 2026-10-03 原话：「每个设置界面的网站分页，每个账户除了『更换账户 检测
  // 导入本机登录态 独立窗口』外增加一个按钮：『删除』作用是：删除这个账户数据」。
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(/apiSoft\('account-remove'/.test(src),
    '「删除」必须调服务端 account-remove——面板自己拼路径/键 = 第二套规则');
  assert.ok(/onClick: \(\) => removeAccount\(s\)/.test(src),
    '「确认删除」必须把**这一行**交给 removeAccount（否则同站点两个账户会互相删错）');
  assert.ok(/const \[confirming, setConfirming\] = React\.useState\(null\)/.test(src),
    '缺少行内二次确认状态');
  assert.ok(/className: 'danger'/.test(src), '破坏性按钮必须与常规动作在样式上有区别（danger）');
  assert.ok(/onClick: \(\) => setConfirming\(s\.accountKey\)/.test(src),
    '第一次点击必须只进入「待确认」态（不直接删）');
  assert.ok(!/window\.confirm\(/.test(src),
    '不得**调用**阻塞式 window.confirm：本文件已记明它会卡住 5s 轮询与在途 fetch 回调');
  assert.ok(/\.hwb-row-actions button\.danger\{/.test(src), 'danger 样式必须落在账户行按钮那一档上');
  // 行为断言：站点页渲染出四个常规动作 + 删除，且不抛错。
  const site = await renderPane({
    payloads: [emptyWindows], which: 'settings', settingsTab: 'deepseek',
    sites: [{ siteId: 'deepseek', siteName: 'DeepSeek 网页版', accountKey: 'deepseek', displayName: 'DeepSeek 网页版', initialized: true, loggedIn: true }],
  });
  assert.deepEqual(site.errors, [], '站点页渲染抛错：' + site.errors.map(e => e.message).join('; '));
  const text = treeText(site.tree);
  for (const b of ['更换账户', '检测', '导入本机登录态', '独立窗口', '删除']) {
    assert.ok(text.includes(b), '账户行缺少按钮：' + b);
  }
});

test('★ 0.16.37 站点目录：官方「新建终端」同款胶囊 + 右侧官方 Menu 账户展开', async () => {
  const src = bridgeSrcFrom('client.cjs');
  // ① 胶囊外壳：逐项对齐官方 TerminalGuide.module.css 的 .entry
  assert.ok(/\.hwb-site-card\{[^}]*border-radius:24px/.test(src), '胶囊外壳不是官方 24px 圆角');
  assert.ok(/\.hwb-site-card\{[^}]*border:\.5px solid/.test(src), '胶囊外壳缺官方那圈半像素描边');
  assert.ok(/\.hwb-site-card\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(src), '胶囊外壳底色不是官方 bg-layer-1');
  // ② 主区 .main 与触发器 .trigger 是两颗官方 Button
  assert.ok(/\.hwb-site-main\{[^}]*min-height:56px/.test(src), '主区高度不是官方的 56px');
  assert.ok(/\.hwb-site-main\{[^}]*padding:14px 20px/.test(src), '主区内边距不是官方的 14px 20px');
  assert.ok(/\.hwb-site-main\{[^}]*border-radius:24px 0 0 24px/.test(src), '主区圆角不是官方的左侧半胶囊');
  assert.ok(/\.hwb-site-trigger\{[^}]*width:44px/.test(src), '右侧触发器不是官方的 44px 宽');
  assert.ok(/\.hwb-site-trigger\{[^}]*align-self:stretch/.test(src), '右侧触发器没有撑满胶囊高度');
  assert.ok(/\.hwb-site-trigger\{[^}]*border-radius:0 24px 24px 0/.test(src), '右侧触发器圆角不是官方的右侧半胶囊');
  // 标题 / 说明两行的字号（官方 15px / 13px）
  assert.ok(/\.hwb-site-title\{[^}]*font-size:15px/.test(src), '标题字号不是官方的 15px');
  assert.ok(/\.hwb-site-desc\{[^}]*font-size:13px/.test(src), '说明行字号不是官方的 13px');
  // ③ 官方原语在位，自绘那套不在
  assert.ok(/const Button = primitives\.Button/.test(src), '没有取官方 Button 原语 —— 胶囊的两半都得是它');
  assert.ok(/const Menu = primitives\.Menu/.test(src), '没有取官方 Menu 原语');
  assert.ok(!/hwb-catalog-expand/.test(src), '自绘展开箭头残留 —— 已由官方 Menu 取代');
  // ④ 旧的左栏行口径不得复活
  assert.ok(!/\.hwb-catalog-row\{/.test(src), '左栏 panelRow 那套行样式残留（「只是在半路」的就是它）');
});
/**
 * 站点 tab 条：形态必须对齐 dsh-market，且**切 tab 只切视图**。
 *
 * 用户要求「点击后能切换设置界面内的 tab 页面，参考 dsh-market 的」。
 * 这里钉住三件事：
 *   ① tab 条与选中态类名存在（下边框高亮那套）；
 *   ② 站点级排队间隔写的是 `sendGapMsBySlot`（后端**既有**的那一档），
 *      不是新造一个设置键；
 *   ③ 有「跟随全局」= 删除该键的路径——「没配」与「配了 0」必须可区分。
 */
test('★ 设置页站点 tab：形态对齐 dsh-market，且排队间隔走后端既有档位', async () => {
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(/\.hwb-settings-tabs\{/.test(src), 'tab 条样式缺失');
  assert.ok(/\.hwb-settings-tab\.on\{/.test(src), 'tab 选中态样式缺失');
  // 0.19.31（用户 2026-09-27 原话）：「不应该是点击后按钮内部底面有个白色底线，
  // 改为官方常见的……切换标签页里面切『全局』那些」。
  //
  // 旧形态是「透明下边框 + 选中时 2px 下划线」，线色取 `--dsw-alias-brand-primary`
  // —— 这支色在**深色主题下接近白**（官方主题：深色 = neutral-bluish-50，
  // 浅色 = neutral-bluish-1000），用户看到的就是「底面一条白色底线」。
  // 现改为浅色胶囊，因此判据必须**成对**：下划线那套不得复活，胶囊那套必须在。
  assert.ok(!/border-bottom:2px solid transparent/.test(src),
    'tab 不得再画下划线 —— 那条线在深色主题下就是用户报的「白色底线」');
  assert.match(src, /\.hwb-settings-tab\{[^}]*border-radius:999px/,
    'tab 必须是胶囊形（用户选定的形态）');
  assert.match(src, /\.hwb-settings-tab\.on\{background:var\(--dsw-alias-interactive-bg-active/,
    '选中态必须是浅色胶囊底（interactive-bg-active），不得回到下划线或 brand 色');
  // hover 与选中必须**分档**：同色会让人把鼠标划过的 tab 当成已选中。
  assert.match(src, /\.hwb-settings-tab:hover\{background:var\(--dsw-alias-interactive-bg-hover/,
    'hover 必须是比选中态浅一档的 interactive-bg-hover —— 两态同色则分不清「划过」与「选中」');
  // 0.19.31（用户 2026-09-27 原话）：「他的按钮底部和一条分割线重合……解决为下移一点」。
  // 成因是 `align-items:flex-end` 让 tab 底边（选中态那 2px 指示线就画在这里）
  // 紧贴容器的 border-bottom（那条 .5px 灰线）。判据：容器必须有 padding-bottom，
  // 把分隔线推离指示线 —— 只删不改（比如把 border-bottom 删掉）不算修好，
  // 那会让整排失去与下方卡片的分隔。
  // 0.19.38（用户 2026-09-27 原话）：「切换设置标签页时候，这一行离分割线的距离
  // 不够，参考官方 dsh 常见的文字和线的分隔做好框与线的距离」——4px → 10px。
  //
  // 为什么不是「把 9px 调大」：官方同类分隔栏（dsh-client-ui-settings-plugins 的
  // `.pbvGtq_tabs` + `.pbvGtq_tab{padding:7px 1px 9px}`）文字底边到线 = 9px，
  // 而本实现是**浅色胶囊**——贴线的是色块不是文字，同一数字下观感近得多。
  // 因此判据按**色块到线**写（10px），并同时钉住：分隔线不得被删（删了就没有
  // 「文字与线的分隔」可言了，那是把问题绕过去而不是修好）。
  assert.match(src, /\.hwb-settings-tabs\{[^}]*padding-bottom:10px[^}]*border-bottom:\.5px solid/,
    'tab 条必须用 padding-bottom:10px 把分隔线推离胶囊底边（色块比文字更重，需要更多呼吸空间）');
  // 滚轮到边不得继续把页面带走（用户第二问）——两条判据成对：
  //   ① 横向 overscroll 必须被 contain 住；
  //   ② 监听里必须按「这条栏真的有可滚内容」拦默认行为，而不是只判「这一下滚动了没有」
  //      （后者在到边时恒为 false，于是滚轮继续冒泡去滚页面 = 用户报的缺陷）。
  assert.match(src, /\.hwb-settings-tabs\{[^}]*overscroll-behavior-x:contain/,
    'tab 条必须 contain 横向 overscroll，否则滚到头会带动外层');
  assert.match(src, /el\.scrollWidth > el\.clientWidth\) e\.preventDefault\(\)/,
    '滚轮到边必须拦默认行为（只判「这一下滚动了没有」在到边时恒假 ⇒ 页面继续下滑）');
  // 站点级间隔必须写 sendGapMsBySlot：这一档 0.14.7 起就在 lib/accounts.js 的
  // 回落链里（槽显式值 → 站点级键 → 全局值），界面只是把它接出来。
  assert.ok(/sendGapMsBySlot: next/.test(src),
    '站点级间隔没有写到 sendGapMsBySlot —— 不要新造设置键');
  assert.ok(/delete next\[siteId\]/.test(src),
    '「跟随全局」必须**删除**该键，而不是写 0（两者语义不同）');
  const at = src.indexOf('async function saveSlotGap(');
  assert.ok(at > 0, 'saveSlotGap 不存在');
  const body = src.slice(at, src.indexOf('async function saveSetting(', at));
  assert.ok(/\{ \.\.\.slotGaps, \[siteId\]:/.test(body),
    'saveSlotGap 没有整对象读改写 —— 只 POST 单个键会让其它站点的覆盖丢失');
});

/**
 * ★ 0.18.0 任务详情页：后台轮询**不得**清掉用户正在编辑的内容。
 *
 * 用户原话（2026-09-22）：「我想要的任务版是人能够手动添加任务的！」
 * 「我用的 gemini 做到 0.17.0 之后的任务，都严重掺水/未实现理想要求」。
 *
 * 这条钉住的正是那次「掺水」的确切形态：
 *
 *   `TaskDetailNotionView` 的同步 effect 原先是 `}, [task]);`，而 `task` 来自
 *   `TaskBoardPanel` 的 `byId` —— 那是**每 5 秒**轮询 `task-ledger` 之后重建的对象，
 *   引用每次都变。于是 effect 每 5 秒跑一次，把用户刚敲进标题/正文/状态/模型的值
 *   静默重置回台账里的旧值。界面看起来一切正常，实际「打字会自己消失」。
 *
 * 判据因此必须落在**稳定标识**上（任务 id / revision），并且用户一旦编辑过，
 * 外部同步就必须让路（dirty 门）。
 */
test('★ 0.18.0 任务详情页：轮询不得覆盖用户正在编辑的字段', () => {
  // 只在**去掉注释的代码**上断言。
  //
  // 为什么必须这么做（本次实测教训）：第一版护栏直接搜 `}, [task]);`，结果被
  // client.cjs 里那段「解释这个缺陷」的注释误触发 —— 注释里引用了旧代码，护栏把
  // 「说明」当成了「缺陷仍在」，报出的失败信息还指向代码，排查方向被完全带偏。
  // 判据要落在代码上；注释讲的是历史。
  //
  // 0.19.0 修的**真缺陷**：原先这里是 `split('\n')`，而本仓库的文件是 CRLF
  //（`\r\n`）。按 `\n` 切分后每行尾部残留 `\r`，`^\s*\/\/.*$` 匹配到 `\r` 时
  // `.*` 退回空串、`$` 对不上行尾，于是**整行注释根本没被去掉**——也就是说这段
  // 「去掉注释」的代码一直在空转，只是恰好因为本条的目标串没出现在注释里而没暴露。
  // 现在按 `\r?\n` 切分，去注释才真的生效（用 `openTab('browser')` 这类确实出现在
  // 注释里的串可以验证）。
  const src = bridgeSrcFrom('client.cjs')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))   // 整行注释
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');                // 块注释

  // ① 同步 effect 不得以整个 task 对象为依赖（那正是每 5 秒重置的成因）。
  assert.ok(!/\}, \[task\]\);/.test(src),
    '任务详情页的同步 effect 不能依赖整个 task 对象 —— 轮询每 5 秒换引用，会把用户输入冲掉');

  // ② 必须用稳定标识（taskId）换任务，用 revision 判外部改动。
  assert.ok(/const taskId = String\(task\?\.id \|\| ''\);/.test(src),
    '必须从 task.id 取稳定标识');
  assert.ok(/\}, \[taskId\]\);/.test(src),
    '换任务必须由 taskId 触发');
  assert.ok(/const taskRevision = Number\(task\?\.revision\) \|\| 0;/.test(src),
    '外部改动必须由 revision 判定');

  // ③ dirty 门必须真的存在且被输入框接上（只声明不接线 = 又一次掺水）。
  assert.ok(/const dirtyRef = React\.useRef\(false\);/.test(src), '缺少 dirty 门');
  assert.ok(/if \(dirtyRef\.current\) return;/.test(src),
    '外部同步没有让路判据 —— 用户正在打字时仍会被覆盖');
  const marks = (src.match(/markDirty\(\);/g) || []).length;
  assert.ok(marks >= 4,
    '标题/状态/模型/正文四个受控输入都必须置 dirty，实际接线点=' + marks);

  // ④ 保存成功后必须解除 dirty，否则之后永远同步不到外部改动。
  const saveAt = src.indexOf('const handleSaveMeta = () => {');
  assert.ok(saveAt > 0, 'handleSaveMeta 不存在');
  const saveBody = src.slice(saveAt, saveAt + 500);
  assert.ok(/dirtyRef\.current = false;/.test(saveBody),
    '保存后必须解除 dirty，否则该任务此后再也同步不到外部改动');
});

// ── 0.19.0 ③：删除 Team 面板后的**全局一致性**（第二轮审查视角）──────────────

/**
 * 删除右栏 Team 面板后，`teamSource` 一度**失去唯一消费者**（第二轮独立审查抓到）。
 *
 * `roster.js:571` 一直在算它、`web-control.js:550` 一直在透出它，而此前只有
 * `TeamPanel` 渲染过它。面板删掉后这条链路就断了——服务端算、前端不读，属于
 * 本项目记过的「只声明不接线」形态（数据层还在产出，用户永远看不到）。
 *
 * 判据要求**三点同时成立**，缺一即变红：① `useRoster` 把它取进来；② 存活的消费者
 *（0.19.x 起只剩任务板面板）渲染它；③ 服务端仍在透出它（不能靠删字段来「消除」
 * 这条判据）。
 *
 * 为什么不干脆删掉服务端那两个字段：`roster.test.mjs:391/400` 把 `teamSource` /
 * `tasksSource` 钉为 `projectRoster` 的公开契约（并以「两个来源都没读到时不得谎报
 * 来源」为断言），删字段会破坏那份契约、也会让「读不到 ≠ 没有」这条说明失去依据。
 * 正确的处置是把断掉的消费端接回来。
 */
test('★ 0.19.0 一致性：teamSource/tasksSource 必须「服务端透出 → 客户端取 → 界面渲染」三段齐全', () => {
  const client = bridgeSrcFrom('client.cjs');

  // ① 客户端必须把它取回来：`useRoster` 整份透传 /status 载荷，消费点在 `data` 上。
  assert.match(client, /function useRoster\(sessionId, intervalMs\)/,
    'useRoster 不存在 —— 花名册载荷没有统一入口');
  assert.match(client, /const \{ data, err \} = useRoster\(sessionId, 5000\)/,
    '任务板面板没有从 useRoster 取载荷 —— 来源标注无从渲染');
  // ② 存活的花名册（0.19.x：设置页那张卡已删，只剩任务板面板）必须真的渲染它
  //    （不是取回来放着）。
  assert.match(client, /sourceText\(data\?\.teamSource\)/,
    '没有界面渲染 teamSource —— 服务端算它、前端不读，链路是断的');
  assert.match(client, /sourceText\(data\?\.tasksSource\)/,
    '没有界面渲染 tasksSource');
  // ③ 服务端两侧都必须在（防止有人用「删字段」来让本条变绿）。
  const roster = bridgeSrcFrom('roster.js');
  const wc = bridgeSrcFrom('web-control.js');
  assert.match(roster, /teamSource:\s*team\.source/, 'roster.js 必须仍在算 teamSource');
  assert.match(wc, /teamSource:\s*r\.teamSource/, 'web-control.js 必须仍在透出 teamSource');
  assert.match(wc, /tasksSource:\s*r\.tasksSource/, 'web-control.js 必须仍在透出 tasksSource');
  // ④ 对账 262 护栏：roster.js 的落库回落分支会发 `source:'ledger'`（桥自有任务台账），
  // 客户端 sourceText 必须为它映射文案——否则路基任务板最常见的来源反而不标出处。
  assert.match(client, /if \(src === 'ledger'\)/,
    'sourceText 未映射 ledger 来源 —— 桥自有任务台账的来源标注缺失（对账 262 ③ 未落地）');
  assert.match(roster, /source: 'ledger'/, 'roster.js 必须仍在算 ledger 来源（若改键需同步客户端）');
});

// ── 0.19.0 ②：任务板 UI 必须统一官方 harness 审美 ───────────────────────────

/**
 * 官方 token 白名单：逐条来自参考实现
 * `reference/dsh-task-board/src/client/board.module.css`（用户指定以它为基准）。
 *
 * 为什么要有**白名单**而不是「不许写十六进制」：只禁十六进制会放过
 * `var(--dsw-alias-label-inverse)` 这种**看起来像官方 token、实际不存在**的写法
 * ——它会静默落到 CSS 回落值，在浅色主题下看不出任何异常，只有换主题才暴露。
 * 这正是本轮 Lead 自己写错过一次的那个坑，因此判据必须能抓住它。
 *
 * ## 0.19.51：白名单改为「装机主题现读 + 手工豁免」，不再纯手抄
 *
 * 这份手抄清单自己就出过假货：`dsw-alias-brand-subtle` 与
 * `dsw-alias-label-quaternary` 被抄了进来，但两者在**整个 DSH 里从未被定义**
 * （2026-09-30 实测：官方主题 403 个 token 里 0 命中；`label-quaternary` 连官方
 * 自己也只有消费没有定义）。桥里 5 处使用因此静默回落到硬编码浅色，深色主题下
 * 不随主题走——白名单把假 token 认证成了真 token，判据对这 5 处**恒假绿**。
 *
 * 所以判据分两层：
 *   · **现读层**（本机装了 dsh 才跑）：把桥用到的每个 token 拿去
 *     `dsh-client-ui-theme/lib/client.js` 里查 `--<token>:` 的定义。查不到即红，
 *     不管白名单怎么写——**主题本身才是真源**。
 *   · **手抄层**（任何环境都跑）：下面这份清单退化为「历史认可集」，
 *     只用来放行「官方在别处以非主题文件定义」的极少数 token。
 */
const OFFICIAL_DSW_TOKENS = new Set([
  'dsw-alias-bg-base', 'dsw-alias-bg-layer-1', 'dsw-alias-bg-layer-2', 'dsw-alias-bg-mask-1',
  'dsw-alias-border-l1', 'dsw-alias-border-l2', 'dsw-alias-border-l3', 'dsw-alias-border-l4',
  'dsw-alias-separator-primary',
  'dsw-alias-label-primary', 'dsw-alias-label-primary-foreground', 'dsw-alias-label-secondary',
  'dsw-alias-label-tertiary', 'dsw-alias-label-caption', 'dsw-alias-label-dimmed',
  'dsw-alias-button-info-fill', 'dsw-alias-button-info-hover',
  'dsw-alias-brand-primary',
  'dsw-alias-interactive-bg-hover', 'dsw-alias-interactive-bg-active',
  'dsw-alias-state-success-primary', 'dsw-alias-state-error-primary',
  'dsw-alias-state-warn-primary', 'dsw-alias-state-warn-secondary',
  'dsw-alias-state-business-primary',
  'dsw-alias-markdown-code-block',
  'dsw-font-family',
  'dsw-elevation-prominent', 'dsw-specific-menu',
  // 输入底与聚焦色：来自参考实现 `.input` / `.input:focus`。
  'dsw-specific-input-major',
  // 0.19.22（并列多会话照抄官方 composer）：官方 composer 卡片的柔和投影。
  // 取证：`dsh-client-ui-theme/lib/client.js:1154` 有定义，
  // `dsh-web-frontend/dist/assets/index-*.css` 与
  // `dsh-client-ui-primitives/lib/SegmentedControl.module.css:31` 都在用，
  // 官方 composer 自己写的是 `box-shadow:var(--dsw-elevation-soft)`
  //（`dsh-client-ui-conversation/lib/client.js` 的 `.uV2eYG_card`）。
  'dsw-elevation-soft',
  // 0.19.29（并列列操作按钮照抄官方 composer 的 `.uV2eYG_add:hover`）：
  // 官方 composer 那个 `+` 圆按钮的 hover 底色就是这一档，因此本插件照抄时
  // 必须用同一个 token，而不是自己编一个近似的。
  // 取证：官方主题的 design-platform.css 第 211 行（浅色）与第 311 行（深色）
  // 各有定义；官方用法见 dsh-client-ui-conversation 里 `.uV2eYG_add` 的 hover 规则。
  'dsw-alias-interactive-bg-hover-solid',
  // 0.19.30（并列 composer 照抄官方那颗 + 圆按钮）：官方 `+` 按钮的**常态底色**
  // 用的就是这一档，而不是我们另挑一个近似色。
  // 取证：官方主题 `ui-theme/src/styles/design-platform.css` 第 256 行（浅色）
  // 与第 356 行（深色）各有定义。
  'dsw-specific-selector',
  // 0.19.31（并列左右切换按钮改为官方胶囊面板同款）：底色用 `--dsw-specific-menu` 的
  // 表面必须同时上 menu 毛玻璃，而 `--dsw-menu-backdrop-filter` 就是官方那一支。
  // 取证：官方主题 `ui-theme/lib/client.js` 的 design-platform 段有
  // `--dsw-menu-backdrop-filter:blur(40px) saturate(150%)`（浅/深各一份）；
  // 官方用法见 `dsh-client-ui-conversation` 的 `.lXshSW_root` 与 `._7yHdaG_panel:before`
  // ——两者都是 `background:var(--dsw-specific-menu)` + `backdrop-filter:var(--dsw-menu-backdrop-filter)`
  // 成对出现（`dsh-client-ui-theme/README.md` 亦记明这一约定）。
  'dsw-menu-backdrop-filter',
]);

test('★ 0.19.0 任务板审美：CSS 只许用官方已有的 dsw token（不得凭直觉编 token 名）', async () => {
  const src = bridgeSrcFrom('client.cjs');
  const used = [...src.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1].slice(2));
  const unknown = [...new Set(used)].filter((t) => !OFFICIAL_DSW_TOKENS.has(t));
  assert.deepEqual(unknown, [],
    '这些 token 不在官方 token 家族里，写出来会静默回落（换主题时暴露）：' + unknown.join(', '));
  // 0.19.51 现读层：本机装了 dsh 时，把**实际用到**的每个 token 拿去官方主题里
  // 查定义。手抄白名单抄错过两次（brand-subtle / label-quaternary 各 5 处使用
  // 因此假绿过），所以最终裁判必须是主题文件本身，而不是这份清单。
  // 找不到主题文件时如实跳过（CI 的 runner 上没有 dsh），不静默装作查过。
  const osMod = await import('node:os');
  const fsMod = await import('node:fs');
  const themeFile = path.join(osMod.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
    '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-theme', 'lib', 'client.js');
  if (!fsMod.existsSync(themeFile)) {
    console.log('skip（本机未装 dsh，token 现读层不可用；手抄层已生效）');
    return;
  }
  const themeCss = fsMod.readFileSync(themeFile, 'utf8');
  const defined = new Set([...themeCss.matchAll(/--(dsw-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const trulyUnknown = [...new Set(used)].filter((t) => !defined.has(t));
  assert.deepEqual(trulyUnknown, [],
    '这些 token 在**已装 dsh 的官方主题里没有定义**（写了必然静默回落）：' + trulyUnknown.join(', '));
});

/**
 * ★ 0.19.36：「查看提示词文件」失败时必须给**短文案**，不得把整段 JSON 当错误显示。
 *
 * 用户实报：`打开失败：HTTP 200 OK：{"ok":false,"code":"PROMPT_FILE_MISSING","file":
 * "C:\\Users\\...\\doubao.md","storeDir":"C:\\Users\\..."}`。
 *
 * 成因是一处**静默的逻辑短路**：`api()` 在 `ok:false` 时直接抛（见 request() 的 failure
 * 判据），于是下面那张 `codes` 映射表**永远走不到**——它本就是为这条路写的。
 * 两个后果同时发生：映射表形同虚设；整段 JSON（含完整路径）成了界面文案。
 *
 * 判据按「这个动作不得再用会抛的 api()」写，而不是断言某句文案——文案会改，
 * 「异常路径不该抢走已知错误码的处理权」才是要钉的东西。
 */
test('★ 0.19.36 打开提示词文件：必须走 apiSoft（否则报码映射表走不到，整段 JSON 当文案）', () => {
  const src = bridgeSrcFrom('client.cjs');
  // 两处调用点（站点页 SitePromptCard / 全局页 PromptPanel）都要走不抛的那条。
  const softCalls = (src.match(/apiSoft\('prompt-file'/g) || []).length;
  assert.equal(softCalls, 2, '两处「查看」都必须用 apiSoft，实得 ' + softCalls + ' 处');
  assert.ok(!/api\('prompt-file'/.test(src), '不得再用会抛的 api() 调 prompt-file（报码映射表会被短路）');
  // 映射表必须真的在（它是给用户看的短文案来源）。
  for (const code of ['PROMPT_FILE_MISSING', 'PROMPT_STORE_OFF', 'OPEN_UNAVAILABLE', 'OPEN_FAILED']) {
    assert.ok(src.includes(code), '缺少错误码 ' + code + ' 的短文案映射');
  }
  // 失败分支不得再把 file 拼进界面文案——完整路径正是撑破元素的那一段。
  assert.ok(!/codes\[[^\]]*\][^)]*\+[^)]*r\.file/.test(src),
    '失败文案不得再拼接完整路径（那一段就是撑破卡片的元凶）');
});

/**
 * ★ 0.19.36：承载报错/长文本的规则必须能换行（用户：「全局检测哪里的报错会突破
 * 所在元素范围的一并修复」）。
 *
 * 这是一个**会复发的盒子模型族缺陷**：本仓库已两次修过同类（`.hwb-model-select`
 * 与 `.hwb-site-prompt-path` 的 `box-sizing`），而这一族在「文字换行」上同样成立——
 * Windows 路径 / JSON / URL 都是**没有可断点**的长串。
 */
test('★ 0.19.36 报错与长文本载体必须带换行保护（没有可断点的长串不得撑破卡片）', () => {
  const src = bridgeSrcFrom('client.cjs');
  // 公共提示/报错载体：`.hwb-hint` 被 80+ 处复用，它必须有。
  assert.match(src, /\.hwb-hint\{[^}]*overflow-wrap:anywhere/,
    '.hwb-hint 是所有行内报错的公共载体，必须有 overflow-wrap:anywhere');
  // 面板内那两段错误正文。
  assert.match(src, /\.hwb-guide p\{[^}]*overflow-wrap:anywhere/,
    '连接失败正文（含 origin 与 HTTP 状态）必须能换行');
  assert.match(src, /\.hwb-form-error\{[^}]*overflow-wrap:anywhere/,
    '表单错误必须能换行');
  // 任务板卡片标题/描述：用户与 AI 写的长标题最常出现在这里。
  assert.match(src, /\.hwb-kcard-title\{[^}]*overflow-wrap:anywhere/,
    '任务卡标题必须能换行');
  assert.match(src, /\.hwb-kcard-desc\{[^}]*overflow-wrap:anywhere/,
    '任务卡描述必须能换行');
  // 独立设置页的同一个载体（settings-page.js 是另一份 HTML，不在 client bundle 里）。
  const page = bridgeSrcFrom('settings-page.js');
  assert.match(page, /\.hint \{[^}]*overflow-wrap: anywhere/,
    '独立设置页的 .hint 同样是报错载体，必须能换行');
});

/**
 * ★ 0.19.37：账户真实昵称/头像必须**四跳齐全**（用户：「尝试拉取账户名称和图像，
 * 替代现在的默认头像和非圆框」）。
 *
 * 这条钉的是**接线**，不是某一跳的实现——本项目最贵的一类返工正是「后端算好了、
 * 中间层丢掉、前端显示默认值」。实测该缺陷当时**三跳断两跳**：
 *   ① browser-driver.status()  透出 accountName/avatarUrl  ← 0.19.4 已有
 *   ② index.js 的 siteStatusRow 两个分支都**没转发**   ← 断（本次修）
 *   ③ client 的字段挑选表也没挑进来                    ← 断（本次修）
 *   ④ 渲染：真实头像优先、抓不到回落站点矢量             ← 断（本次修）
 * 四跳任一断掉，界面都只剩默认头像+槽名，而每一跳单看都「有代码」。
 */
test('★ 0.19.37 账户身份四跳：状态层必须转发，字段挑选不得丢，渲染要有真实头像分支', () => {
  // ① 驱动层（0.19.4 既有）。
  const drv = bridgeSrcFrom('browser-driver.js');
  assert.ok(/accountName:\s*accountIdentity\?\.name/.test(drv), '驱动层必须透出 accountName');
  assert.ok(/avatarUrl:\s*accountIdentity\?\.avatarUrl/.test(drv), '驱动层必须透出 avatarUrl');
  // ② index.js 的 siteStatusRow **两个分支**都要转发（已初始化 / 未初始化）。
  const idx = bridgeSrcFrom('index.js');
  const forwarded = (idx.match(/accountName:\s*s\.accountName/g) || []).length;
  assert.ok(forwarded >= 1, 'index.js 的 siteStatusRow 必须把已初始化驱动的 accountName 转发出去（本次缺陷点）');
  assert.ok(/avatarUrl:\s*s\.avatarUrl/.test(idx), 'index.js 必须转发 avatarUrl');
  const nulled = (idx.match(/accountName:\s*null,\s*avatarUrl:\s*null/g) || []).length;
  assert.ok(nulled >= 1, '未初始化的槽必须如实给 null（不拿槽名冒充昵称）');
  // ③ 客户端字段挑选表不得再丢掉这两个字段（与 sessionLostCount 同型的老坑）。
  const cli = bridgeSrcFrom('client.cjs');
  assert.ok(/accountName:\s*s\.accountName\s*\|\|\s*null/.test(cli),
    'SiteAccounts 的字段挑选表必须带上 accountName（只挑几个字段正是老坑）');
  assert.ok(/avatarUrl:\s*s\.avatarUrl\s*\|\|\s*null/.test(cli), '字段挑选表必须带上 avatarUrl');
  // ④ 渲染：真实头像优先 + 抓不到回落；昵称真实优先 + 回落槽名。
  assert.ok(/s\.avatarUrl\s*$|s\.avatarUrl\s*\?/m.test(cli) || /s\.avatarUrl\s*\.replace|\bs\.avatarUrl\b/.test(cli),
    '渲染必须消费 avatarUrl');
  assert.ok(/hwb-avatar-img/.test(cli), '真实头像的 img 分支必须存在');
  assert.ok(/s\.accountName\s*\|\|\s*s\.displayName/.test(cli),
    '昵称必须真实优先、回落槽名（不得把槽名伪装成真昵称）');
});

/**
 * ★ 0.19.37：站点健康度圆点——三色聚合 + 位置在标题行。
 *
 * 用户原话：「『已登录』占位框改为右上角和『智谱清言 的账户与登录』同行合适位置的
 * 单独绿色圆点状态指示：红就是全部不行了，绿就是全部可以，黄就是有可以有不可以，
 * 只需要通过颜色圆点显示，然后所有网站都需要应用，deepseek 一样」。
 *
 * 判据是**跨该站点全部账户**的聚合，不是单账户那一行——这是「全部/部分/全不行」
 * 三个词的字面含义，也正是它区别于旧「已登录」徽章的地方。
 */
test('★ 0.19.37 站点健康度圆点：三色聚合判据 + 挂在标题行 + 颜色不是唯一载体', () => {
  const src = bridgeSrcFrom('client.cjs');
  // 聚合判据：全绿 / 全红 / 部分黄。
  assert.ok(/const siteHealthOf/.test(src), '必须有站点级聚合函数（单账户那一行不足以回答「全部」）');
  assert.ok(/return 'ok'/.test(src) && /return 'bad'/.test(src) && /return 'warn'/.test(src),
    '三档都要在：ok / bad / warn');
  assert.ok(/hwb-dot\.warn\{background:var\(--dsw-alias-state-warn-primary/.test(src),
    '黄色档必须走官方 warn token（不得凭直觉编 token 名）');
  // 位置：标题行（.hwb-group-row）的右上角。
  assert.ok(/hwb-group-row/.test(src), '标题行必须能两端对齐（圆点在右上角）');
  assert.ok(/siteHealthOf\(settingsTab\)/.test(src), '圆点必须挂在当前站点 tab 的标题行上');
  // 颜色是唯一视觉载体 ⇒ 读屏必须有含义（用户要求只用颜色，但可访问性不能一起丢）。
  assert.ok(/aria-label.*账户状态/.test(src), '圆点必须有 aria-label 说明含义（颜色不是唯一载体）');
  // 旧「已登录」占位框必须消失。
  //
  // 判据盯**渲染表达式与 CSS 规则**，不扫整份源码——这条注释本身就要写出
  // `.hwb-site-state` 这个名字来解释「它被删了」，扫整份源码会把注释当成缺陷
  //（本文件 0.19.34 那条护栏刚踩过同一个坑）。
  assert.ok(!/className:\s*'hwb-site-state/.test(src), '旧的「已登录」占位框渲染点必须移除');
  assert.ok(!/"\.hwb-site-state/.test(src), '旧的「已登录」占位框 CSS 规则必须一并删除（不留死样式）');
});

test('★ 0.19.0 任务板审美：按钮走官方 button-info 语义 token，不得写死颜色或整块 opacity', () => {
  const src = bridgeSrcFrom('client.cjs');

  // 主按钮必须用官方**按钮语义** token（有配套 hover 档），而不是 brand-primary。
  assert.match(src, /\.hwb-btn\.primary\{background:var\(--dsw-alias-button-info-fill/,
    '主按钮底色必须走 --dsw-alias-button-info-fill（官方按钮语义 token）');
  assert.match(src, /\.hwb-btn\.primary:hover:not\(:disabled\)\{background:var\(--dsw-alias-button-info-hover/,
    '主按钮 hover 必须换到官方 button-info-hover，而不是整块调透明度');
  // 字色必须是官方前景 token，不得写死 #fff。
  assert.match(src, /\.hwb-btn\.primary\{[^}]*color:var\(--dsw-alias-label-primary-foreground/,
    '主按钮字色必须走 --dsw-alias-label-primary-foreground，不得写死 #fff');
  assert.match(src, /\.hwb-btn\.danger\{background:var\(--dsw-alias-state-error-primary/,
    '危险按钮必须走 --dsw-alias-state-error-primary，不得写死 #dc2626');
  // 不得再用整块 opacity 做 hover 反馈（会把文字一起调淡）。
  assert.ok(!/\.hwb-btn:hover\{opacity:\.9\}/.test(src),
    '按钮 hover 不得用 opacity:.9 —— 官方只换底色，文字保持全对比');
});

/**
 * ★ 0.19.31：「等待发送统计」浮层不得再「透字」（用户报的「面板错误的透明」）。
 *
 * 成因不是「底色选错了」，而是**官方那对声明只抄了一半**：
 * `--dsw-specific-menu` 本身是半透明的（浅色 `#f8f9fa94`、深色 `#30313680`），官方
 * 每一块用它当底的高层级表面都**同时**上 `backdrop-filter:var(--dsw-menu-backdrop-filter)`
 * 把背后内容糊掉。漏掉后一条，半透明底就等于「直接看见后面的聊天文字」。
 *
 * 因此判据必须**成对**：只测「有 specific-menu」会放过透字，只测「有 backdrop-filter」
 * 会放过底色被换回不透明实底（那就不是官方材质了）。
 *
 * 取证（逐字比对）：官方 `dsh-client-ui-chat/lib/client.js` 的 `css$4`
 *（stat-dialog.module.css 的 `.bRhRbq_panel`）逐项为
 * `background:var(--dsw-specific-menu)` + `backdrop-filter:var(--dsw-menu-backdrop-filter)`
 * + `--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)`；官方
 * `dsh-client-ui-theme/README.md` 亦记明「绘制 --dsw-specific-menu 的高层级表面还会
 * 应用 backdrop-filter:var(--dsw-menu-backdrop-filter)」。
 */
test('★ 0.19.31 等待统计浮层：半透明底必须配官方毛玻璃，不得再透出背后文字', () => {
  const src = bridgeSrcFrom('client.cjs');
  const at = src.indexOf('.hwb-waitpanel{');
  assert.ok(at > 0, '找不到 .hwb-waitpanel 规则（改类名则本护栏失效，需同步）');
  const rule = src.slice(at, src.indexOf('}', at) + 1);

  assert.match(rule, /background:var\(--dsw-specific-menu\)/,
    '浮层底色必须走官方胶囊同款 --dsw-specific-menu（官方 stat-dialog 逐字如此）');
  assert.match(rule, /backdrop-filter:var\(--dsw-menu-backdrop-filter\)/,
    '半透明底必须配官方 menu 毛玻璃 —— 缺这一条就等于「背后聊天文字直接透出来」（用户报的缺陷）');
  assert.match(rule, /--dsw-elevation-stroke-color:var\(--dsw-alias-border-l1\)/,
    '官方高层级表面设 border:0，发丝边由 elevation 描边档画出，这一条不能少');
  // 旧形态：底色带一个「不透明回落值」——回落值本身就把官方材质顶掉了，
  // 而且 `background:var(a,var(b,#fff))` 这种写法让人以为「本来就是不透明的」。
  assert.ok(!/background:var\(--dsw-specific-menu,/.test(rule),
    '底色不得再带不透明回落值 —— 官方材质是「半透明底 + 毛玻璃」，回落值会把毛玻璃顶掉');
});

test('★ 0.19.0 任务板审美：看板列数不得写死（窄面板下必须能收缩）', () => {
  const src = bridgeSrcFrom('client.cjs');
  assert.ok(!/\.hwb-kanban-board\{[^}]*repeat\(5,1fr\)/.test(src),
    '看板写死 repeat(5,1fr)：窄面板下五列一起被压到读不出字，应改为按 minmax 自适应');
  assert.match(src, /\.hwb-kanban-board\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(180px,1fr\)\)/,
    '看板必须按 auto-fit + minmax(180px,1fr) 自适应');
});

/**
 * 0.19.0：任务板不得用 `alert()` 做反馈。
 *
 * 为什么这是一条真判据而不是洁癖：`alert` 是**阻塞式**浏览器模态，弹出期间
 * JS 主线程停住——5 秒轮询的下一拍与所有在途 fetch 回调都被卡住，用户看到的是
 * 「点一下，整个面板僵住」。它也不属于官方 harness 的任何一种反馈形态：
 * 参考实现（`reference/dsh-task-board`）一律用内联 `.formError` 文案。
 */
test('★ 0.19.0 任务板审美：不得用 alert 做反馈（阻塞主线程，非官方形态）', () => {
  // 只在**去掉注释的代码**上断言 —— 与上面「轮询不得覆盖用户输入」同一条纪律：
  // 本文件已经吃过一次亏（护栏被解释缺陷的注释误触发，报出的失败信息指向代码，
  // 排查方向被完全带偏）。这里 `alert` 恰好也只出现在注释里，若不去注释就会
  // 把「解释」当成「仍在用」。注释讲的是历史，判据必须落在代码上。
  const src = bridgeSrcFrom('client.cjs')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))   // 整行注释
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');                // 块注释

  // 只查任务板两个组件体：设置页等其它历史代码不在本次范围内，
  // 把它们一并断言会让这条护栏变成「全文件洁癖」，从而在无关改动上误报。
  for (const fn of ['function TaskBoardPanel', 'function NewTaskModalDialog', 'function TaskDetailNotionView']) {
    const at = src.indexOf(fn);
    assert.ok(at > 0, '找不到 ' + fn);
    const end = src.indexOf('\n    function ', at + 10);
    const body = src.slice(at, end === -1 ? src.length : end);
    assert.ok(!/\balert\(/.test(body),
      fn + ' 里仍有 alert() —— 阻塞主线程且非官方反馈形态，应改用 hwb-notice / hwb-form-error');
  }
  // 正判据：内联反馈必须真的存在且被渲染出来（删掉横幅即变红）。
  assert.match(src, /const \[boardNotice, setBoardNotice\] = React\.useState\(null\)/,
    '缺少任务板级反馈状态 boardNotice');
  assert.match(src, /hwb-notice-text/, 'boardNotice 必须有渲染出口，否则用户看不到任何回执');
  assert.match(src, /hwb-form-error/, '新建弹窗缺少内联校验文案出口');
});

/**
 * 0.19.0：任务详情页的**所有写路径**都必须吃 CAS，且成功判据不得含糊。
 *
 * 两条真缺陷都出在这里，故逐条钉住：
 *
 *   ① `onAddComment` / `onResolveComment` **没传 `expectedRevision`**。服务端
 *      `POST task-comment` / `task-comment-resolve` 的第五个参数就是 CAS
 *      （0.17.3 修「批注 CAS 被静默吞掉」修的正是这条链路），不传等于放弃并发保护：
 *      两人同时对同一条任务批注，后到的覆盖先到的，而**双方都收到成功**。
 *   ② 成功判据原先写成 `if (res && res.ok === false)` —— 它把 `ok` 缺失、`res`
 *      为 `null`、字段名拼错等情形**全部当成成功**，界面报「已保存」而磁盘没动。
 *      现在必须走 `verdictOf`（只有显式 `ok === true` 才算成功）。
 */
test('★ 0.19.0 任务详情页：所有写路径必须吃 CAS，成功判据不得含糊', () => {
  const src = bridgeSrcFrom('client.cjs');

  // ① 四条写路径都必须带 expectedRevision。
  for (const action of ['task-update', 'task-comment', 'task-comment-resolve']) {
    const at = src.indexOf("api('" + action + "'");
    assert.ok(at > 0, '找不到 ' + action + ' 调用');
    // 取该调用到下一个 `)` 收尾的一段（够覆盖对象字面量）。
    const call = src.slice(at, at + 420);
    assert.match(call, /expectedRevision:\s*currentTask\.revision/,
      action + ' 未带 expectedRevision —— 放弃 CAS = 并发写入静默互相覆盖，而双方都收到成功');
  }
  const upd = src.indexOf("api('task-update'");
  assert.match(src.slice(upd, upd + 260), /expectedRevision:\s*currentTask\.revision/,
    'task-update 未带 expectedRevision');

  // ② 不得再有 `res && res.ok === false` 这种「缺 ok 就当成功」的**分散**判据。
  //
  //    两点必须处理对，否则这条护栏是装饰品：
  //      · 先去注释 —— 解释这个缺陷的注释里正好引用了旧写法（本文件的老坑）；
  //      · 豁免 `verdictOf` 自身 —— 它里面**就该**出现 `res.ok === false`，
  //        那是白名单判定的第二支，不是「分散判据」。
  const code = src
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const vAt = code.indexOf('const verdictOf = (res, what) => {');
  assert.ok(vAt > 0, '找不到 verdictOf 定义');
  // 取到该定义之后的下一个顶层 `const ` 为止（把 verdictOf 的函数体整段排除）。
  const afterV = code.indexOf('\n      const ', vAt + 10);
  const outside = code.slice(0, vAt) + (afterV === -1 ? '' : code.slice(afterV));
  assert.ok(!/res\s*&&\s*res\.ok\s*===\s*false/.test(outside),
    '成功判据不得写成 `res && res.ok === false` —— ok 缺失时会被当成成功（假成功）；'
    + '应统一走 verdictOf');

  // ③ 正判据：必须存在一个「只有显式 ok===true 才算成功」的收口函数并被使用。
  assert.match(src, /const verdictOf = \(res, what\) => \{/,
    '缺少 verdictOf 收口 —— 每条写链路各自判 ok 必然漂移');
  assert.match(src, /if \(res && res\.ok === true\) return \{ ok: true, error: '' \};/,
    'verdictOf 必须白名单式判定（只有 ok===true 算成功）');
  // ★ 第三轮对抗审查抓到的**护栏逃逸**：上一版只钉了白名单那一支，于是把
  //   `ok === false` 那一支改成「返回 ok:true」时，**服务端明确拒绝被报成成功**
  //   （正是本条要防的假成功），而护栏全绿。两支都必须钉住，且要钉**返回语义**，
  //   不是只钉字面量存在。
  assert.match(src, /if \(res && res\.ok === false\) return \{ ok: false, error: String\(res\.error \|\| '[^']*'\) \};/,
    'verdictOf 的 ok===false 分支必须如实返回 ok:false 并带出服务端原因 —— '
    + '只钉白名单分支会让「服务端拒绝被报成成功」这条假成功逃过护栏');
  // 缺 ok 字段的响应必须按**未成功**处理（默认拒绝），不得当成成功。
  assert.match(src, /return \{ ok: false, error: what \+ '[^']*' \};/,
    'verdictOf 的兜底分支必须返回 ok:false（响应形状不认识 ⇒ 按未成功处理）');
  const uses = (src.match(/verdictOf\(/g) || []).length;
  assert.ok(uses >= 6,
    'verdictOf 必须被各条写链路真的用上（定义处 + 至少 6 处调用），实际=' + uses);
});

/**
 * ★ 0.19.0：详情页的写操作反馈必须有渲染出口（第三轮对抗审查抓到的真回归）。
 *
 * 把 `alert()` 换成内联横幅时漏了一半：`notify()` 的**全部**调用点都在
 * `TaskDetailNotionView` 的写回调里（保存/删除/批注/解决/按批注派发），而横幅原先
 * 只在看板/列表那一支渲染 —— `TaskBoardPanel` 在 `if (selectedTaskId)` 处就
 * `return h(TaskDetailNotionView, …)` 了，**永远走不到**那个渲染点。
 * 于是用户在详情页做的每一次写（含**被 CAS 拒绝**、**派发失败**）都看不到任何结果。
 * 旧实现用 `alert()` 时不会有这个问题（阻塞弹窗与挂载分支无关），所以这是换成
 * 内联反馈时丢掉的另一半 —— 属于本项目反复记过的「说做了、其实没做」。
 */
test('★ 0.19.0 任务详情页：写操作反馈必须有渲染出口（不得只在看板分支渲染）', () => {
  const src = bridgeSrcFrom('client.cjs');

  // ① 详情页必须**接到**这个状态。
  assert.match(src, /function TaskDetailNotionView\(\{ task, allTasks, notice, onDismissNotice,/,
    'TaskDetailNotionView 必须接收 notice/onDismissNotice —— 否则它的写操作反馈无处可去');
  assert.match(src, /notice: boardNotice,/, 'TaskBoardPanel 必须把 boardNotice 传进详情页');
  assert.match(src, /onDismissNotice: \(\) => setBoardNotice\(null\),/,
    '必须传关闭回调（横幅可关，否则会一直占着版面）');

  // ② 详情页体内必须真的渲染它（不是只接不用）。
  const at = src.indexOf('function TaskDetailNotionView(');
  assert.ok(at > 0, '找不到 TaskDetailNotionView');
  const end = src.indexOf('\n    function ', at + 10);
  const body = src.slice(at, end === -1 ? src.length : end);
  assert.match(body, /notice && h\('div', \{/,
    'TaskDetailNotionView 体内必须渲染 notice 横幅 —— 只接不渲染等于没接');
  assert.match(body, /notice\.kind === 'bad' \? 'bad' : 'ok'/,
    '横幅必须区分成败色档');
  assert.match(body, /onDismissNotice\(\)/,
    '关闭按钮必须真的调用 onDismissNotice');

  // ③ 两处渲染点都要在：看板一处 + 详情页一处（少任何一处就有一半操作看不到反馈）。
  const renders = (src.match(/notice && h\('div', \{/g) || []).length
    + (src.match(/boardNotice && h\('div', \{/g) || []).length;
  assert.ok(renders >= 2,
    '反馈横幅至少要有两个渲染出口（看板 + 详情页），实际=' + renders);
});

/**
 * ★ 0.19.0：按批注派发的**第二步**（`chat` 的真实结果）必须有断言覆盖。
 *
 * 第三轮对抗审查指出这条是**零覆盖**：把「成功/失败分支」整段换成一句无条件的
 * 成功提示，测试仍全绿 —— 而「派发失败被报成成功」正是本项目反复记过的假成功。
 * 派发是**两次**串行调用（`task-implement` 组装 → `chat` 真正投出），两步都要如实报。
 */
test('★ 0.19.0 按批注派发：chat 的真实结果必须决定成败（不得无条件报成功）', () => {
  const src = bridgeSrcFrom('client.cjs');

  // 第一步：组装失败/形状不认识 ⇒ 必须报失败且**不得**继续投递。
  assert.match(src, /const v = verdictOf\(res, '组装实施指令'\);/,
    'task-implement 的结果必须经 verdictOf 判定');
  assert.match(src, /if \(!v\.ok\) \{ notify\('bad', '发起实施失败: ' \+ v\.error\); return null; \}/,
    '组装失败必须报失败并中止（不得继续投递）');

  // 第二步：chat 结果必须经判定后**分派到两个分支**。
  const at = src.indexOf("verdictOf(r2, '派发')");
  assert.ok(at > 0, 'chat 的结果必须经 verdictOf 判定 —— 否则可被换成无条件成功');
  const around = src.slice(at, at + 420);
  assert.match(around, /if \(v2\.ok\) notify\('ok'/,
    'chat 成功才报「已按批注派发」');
  assert.match(around, /else notify\('bad', '派发失败: ' \+ v2\.error\)/,
    'chat 失败必须报「派发失败」并带出真实原因 —— 无条件成功就是假成功');

  // 反向：不得出现「不看结果就报成功」的形态。
  assert.ok(!/api\('chat'[\s\S]{0,200}?\.then\(\(\) => notify\('ok'/ .test(src),
    'api(chat) 之后不得无条件 notify 成功（丢弃结果）');
});

/**
 * Word 范式审批界面的**可核对**判据（用户：参考 office 左正文、右划线编辑评论）。
 *
 * 只断言「有左右两栏」不够——那是最容易被做成的样子货。这里要求三条本质都在：
 * 正文可划词、右侧是独立滚动的页边栏、**已被批注的片段在正文侧留痕**。
 */
test('★ 0.19.0 审批界面：Word 范式三件套（划词 / 页边独立滚动 / 正文侧留痕）', () => {
  const src = bridgeSrcFrom('client.cjs');

  // ① 左正文可划词：textarea 的 onMouseUp 取选区。
  assert.match(src, /const handleDescSelect = \(e\) => \{[\s\S]{0,200}?getSelection\(\)/,
    '正文必须能划词取选区（Word 审阅的前提）');
  assert.match(src, /hwb-review-split/, '缺少左右分栏容器');
  assert.match(src, /hwb-review-margin/, '右侧批注栏（Word 页边）缺失');
  // ② 页边栏独立滚动：CSS 必须给批注列表自己的滚动容器。
  assert.match(src, /\.hwb-review-comments\{[^}]*overflow-y:auto/,
    '右侧批注栏必须独立滚动 —— 否则长批注会把正文一起顶走');
  // 窄屏回落：硬撑两栏会让两栏都窄到不能用。
  assert.match(src, /@media \(max-width:720px\)\{\.hwb-review-split\{grid-template-columns:1fr\}\}/,
    '窄屏必须回落为上下布局');
  // ③ 正文侧留痕：已被批注的引用片段必须列出来（Word 的「已评论文字」标记）。
  assert.match(src, /hwb-review-anchors/, '正文侧缺少「已批注片段」留痕');
  assert.match(src, /const anchorQuotes = comments/, 'anchorQuotes 未定义');
  // 锚点跳转必须用**原始下标**：只要有一条无引用的批注夹在中间，
  // 用过滤后的下标就会点到别的批注上，而界面上完全看不出来。
  assert.match(src, /\.filter\(a => a\.quote\)/,
    '锚点必须自带原始下标后再过滤，否则跳转会错位一格');
  assert.match(src, /anchorQuotes\.map\(\(a\) => h\('button'/,
    '锚点必须按带入下标的对象渲染');
});

/**
 * ★ 0.19.0：站点标签的站点**不得**被「有独立窗口就切过去」改写。
 *
 * 用户原话（2026-09-22）：「质谱清言等网站的登录没问题，但是回点击直接打开
 * deepseek?」
 *
 * 现场：`Conversation` 挂载时无条件执行「把当前站点换成第一个开着独立窗口的站点」。
 * DeepSeek 的窗口是常驻的（`GET window` 实测 `windows.deepseek.open=true`），
 * 于是挂载一个「智谱清言」标签会被 `setSiteId('deepseek')` 顶掉——标签标题写着
 * 智谱清言，正文区却是 DeepSeek。**登录本身一直是好的**（走的是另一个控制面动作）。
 *
 * 这段代码是 0.11.0 单站点时代的遗留；0.16.35 起站点由标签的 `navigation.params`
 * 决定，它就从「合理」变成了「推翻用户明确的选择」。
 *
 * 判据：受控标签（`controlledSite` 非空）**不得**走自动采纳分支；且那个分支整体
 * 必须在 `if (!controlledSite)` 之内——只断言「有这行代码」是不行的，那正是它活到
 * 今天的原因（原护栏只钉了 `GET window` 的形状，没钉它**被用作站点改写**）。
 */
test('★ 0.19.0 站点标签：站点不得被「有独立窗口就切过去」改写（用户报的「点开就变 DeepSeek」）', () => {
  const src = bridgeSrcFrom('client.cjs');
  // ① 自动采纳必须被 `!controlledSite` 守住。
  assert.match(src, /const adoptWindowSite = !controlledSite;/,
    '自动采纳必须由「本标签没有明确站点」决定');
  assert.match(src, /if \(adoptWindowSite\) \{/,
    '必须在分支内才执行采纳——无条件执行就会顶掉用户点开的站点');
  // ② 反向：不得再出现「无条件的 winState().then(... setSiteId(open[0]))」。
  assert.ok(!/winState\(\)\.then\(w => \{ const open = Object\.keys/.test(src),
    '不得恢复无条件的「切到第一个开窗站点」——那正是「点开智谱清言却出了 DeepSeek」的成因');
  // ③ 受控同步仍然要在（站点标签必须跟着自己的 params 走，修 A 不能把 B 拆掉）。
  assert.match(src, /if \(controlledSite && SITE_NAMES\[controlledSite\]\) setSiteId\(controlledSite\);/,
    '受控站点同步必须保留——修掉自动采纳 ≠ 不再认标签自己的站点');
});
