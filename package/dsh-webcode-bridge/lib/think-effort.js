// think-effort.js — 「思考等级」的**唯一真源**（0.19.48）。
//
// # 这个文件为什么存在
//
// 用户报障原话（2026-09-28）：
//
//   「现在的模型网页端，除了 deepseek 是只有深度思考开关没有思考等级开关，其他网站都有
//     思考等级的分级你没有选择，写好 dsh 这里能主动选择」
//
// DSH 宿主**本来就支持**每模型一套思考等级：provider 适配器的 `resolveModel()` 返回
// `reasoning: { efforts, defaultEffort? }`，选择器就会多出一栏「推理等级」，选中值随
// `GenerateOptions.reasoningEffort` 回到适配器（契约见 `dsh-llm` 的 `LlmResolvedModelInfo`
// 与 `resolveCallWithInfo`）。桥此前**一个字都没做**：`resolveModel` 从不声明 reasoning，
// 于是所有站点在选择器里都是「没有等级可选」——**这不是网页端没有，是桥没接**。
//
// # 这个文件在整条链上的位置
//
//   think-effort.js（本文件：等级清单 + 应用计划 + 判定，纯逻辑）
//        ├── providers.js   站点声明引用它（`efforts` / `effortControl`），不另写一份
//        ├── index.js       resolveModel 把 `reasoningEffortsFor()` 翻译成宿主契约
//        └── browser-driver.js  用 driver 把 `applyEffort()` 的计划落到真实 DOM
//
// # 判据从哪来（真机读数，逐站点可核）
//
// 2026-09-28 用 `test-mock/probe-think-control.mjs` 在**落盘 profile 副本**上实采，
// 证据落 `test-mock/out/think-control-<site>-*.json`：
//
//   · kimi  `<div class="current-model" data-testid="model-select-trigger">` 点开 →
//           `<button data-testid="model-effort-item" class="effort-item">思考强度 进阶</button>`
//           再点 → `<button data-testid="model-effort-option">标准 / 进阶</button>`（checked 在选中项上）
//   · glm   `.think-mode-trigger` 点开（既有 modelPicker 契约）→ 真机 dump
//           （`test-mock/out/model-dropdown-glm-2026-09-13T12-02-46.json`）里那条
//           `think-mode-item has-submenu`：「思考强度 / 极致」→ 子菜单 极致/快速/深度
//   · zai   输入框附近的 `<div data-state="closed">深度思考 最高</div>` 点开 →
//           同级 menu 里 低 / 高 / 最高 三条 + 一个 `role="switch"` 总开关
//   · qwen  `<div class="qwen-thinking-selector">自动</div>` 点开 →
//           `role="menuitem"` 三条：自动 / 思考 / 快速（当前项带 `-item-select` 类）
//   · doubao 模型档（**不是**思考档）：`[data-testid="chat_input_action_model"]` 点开 →
//           `[role="menuitem"]` 两条：「豆包 快速」/「豆包 2.1 Turbo专家」。第二条子树是
//           `<span class="truncate">豆包 2.1 Turbo</span>` + `<span>专家</span>` ——
//           「快速 / 专家」就是**档位徽章**；第一条的徽章文本与模型名同字，故读出来是
//           「豆包 快速」。用户报障原话里的「左下角有模型和思考等级选择」指的正是它，
//           本模块按逐字文本暴露这两个徽章（桥不替网页决定它叫「模型」还是「等级」）。
//
// 未取证的站点（chatgpt / gemini / grok / claude：本机网络 ERR_CONNECTION_CLOSED）
// **一律不声明** efforts。取舍写在这里，因为它是本文件最重要的一个决定：
//
//   声明一个 `effortControl` 却没有可点的控件 ⇒ 每一轮都抛 THINK_EFFORT_UI_CHANGED，
//   站点变得完全不可用；声明一个错误的标签 ⇒ 点错控件（更糟，可能点走模式）。两种代价
//   都远大于「下拉里少一栏」。所以**没读数就不声明**，缺口如实记在
//   `doc/long-term-issues.md`，等有真机读数再补——这与 providers.js 里「未真机校准的
//   站点只给 auto 档」是同一条纪律。
//
// # 绝不静默降级（本仓库三条不可越界约束的思考等级版本）
//
// `applyEffort()` 的返回值只有成功或抛错两种。**没有**「点了但没生效就照常发送」这条分支：
// 用户选了「深度」而网页还停在「快速」，那就是一次静默降级——思考质量变差，而界面上看不
// 出任何异常。抛错（`THINK_EFFORT_UI_CHANGED`）比这诚实：它带站点、目标、可选项、当前读数。

// 错误码真源（2026-10-02）：本文件三处抛点（THINK_EFFORT_UNKNOWN / _UI_CHANGED /
// _UNAVAILABLE）走它，避免码在 harness 边界被归一化成 `UNKNOWN`。
// 见 lib/error-codes.js 文件头与 doc/research/2026-10-02-dsh-official-error-and-repair.md §6。
import { withWebcodeCode } from './error-codes.js';

/** 控件形态。`popup` = 点开弹层再点档位；`toggle` = 单一开关按 aria-pressed 读状态。 */
export const EFFORT_CONTROL_KINDS = Object.freeze(['popup', 'toggle']);

/**
 * 站点 → 思考等级清单 + 控件契约（**唯一真源**）。
 *
 * 每个条目：
 *   · `efforts`        —— 等级清单，`id` 就是网页菜单里的**逐字文本**（驱动按文本点），
 *                         `name` 是 DSH 选择器里显示的名字（现在是逐字相同）。
 *                         `ordinal` 只用于「回读不到具体档位文本」时的兜底判定与排序。
 *   · `defaultEffort`  —— **0.19.52 起逐站声明**（用户指令：「去除没有的 auto 挡位」）。
 *                         值 = 该站点**新开会话页上的默认档**，取证逐条写在各条目里。
 *                         宿主契约（ModelSelect）是「声明了 defaultEffort ⇒ 选择器
 *                         不再显示「Default」行，选模型即携带该档」——不声明时那一行
 *                         就是用户看到的「没有的 auto 挡位」（网页上不存在这档）。
 *                         代价如实记：声明后**每一轮**都会下发并核对档位；站点改版
 *                         让回读失效时，症状从「用户主动选档才报错」变成「每轮
 *                         THINK_EFFORT_UI_CHANGED」——这是用户明确选择的确定性。
 *                         （0.19.48 曾刻意全部不声明，理由是「不替用户定档」；
 *                         2026-09-30 用户指令推翻该决策，改为「选择器只显示网页
 *                         真实存在的档位，默认档 = 站点自己的默认」。）
 *   · `effortControl`  —— 控件契约；缺省表示「本站点不暴露思考等级」。
 *       `triggerText`    打开弹层的控件上必须出现的文本（单个 token）；
 *       `triggerText`   触发控件**固定可见的那一段文本**（z.ai「深度思考」、kimi「快速」、豆包「豆包」）。
 *       `triggerSelectors` 触发控件的 CSS 选择器（有稳定 testid 的站点优先用它）；
 *       `openVia`        触发控件在**别的**弹层里时，先点开这一层（glm 是模型选择器）；
 *       `itemLabel`      触发控件是弹层条目时的条目文本（glm 的「思考强度」）；
 *       `optionSelector` 档位条目的选择器（有 testid 的站点用它，比文本更稳）；
 *       `readback`       回读口径：`effort-text`（触发控件里出现档位文本）或
 *                        `aria-checked`（弹层里被 checked 的那条即当前档）。
 *       `allowEmptyTrigger` 为真时允许「容器上读不到档位文本、只能靠弹层里那条
 *                        `aria-checked`/`data-state` 确认」——豆包是唯一的例子
 *                        （见其条目注释），其余站点**不要**顺手打开这个开关：
 *                        它对「触发控件根本不存在」也是放行的，等于放弃一层校验。
 */
export const THINK_EFFORT = Object.freeze({
  /**
   * Kimi：模型菜单里的一行子菜单（`model-effort-item` → `model-effort-option`）。
   *
   * 为什么触发契约是「两个 token」：真机读数里触发按钮的文本是「快速 进阶」——
   * 「快速」是模型档（当前模型 = 快速），「进阶」才是思考强度。只按 `进阶` 找不到它
   * （它在**菜单里**还有一条同名条目），只按 `快速` 会命中模型行。两个 token 同时出现
   * 才是那一行，这也是 `modelPicker.trigger` 只能按 class 定位的原因。
   */
  kimi: {
    efforts: [
      { id: '标准', name: '标准', ordinal: 1 },
      { id: '进阶', name: '进阶', ordinal: 2 },
    ],
    // 默认档取证（0.19.52）：线上已登录页（2026-09-28 只读 CDP，`.tmp-probe/cdp-verify-fix.mjs`）
    // 触发控件读数是 **`K3 标准`**——K3 是站点旗舰默认模型、`标准` 是它的默认档，且
    // `span.current-effort` 的文本**恰好就是档位本身**（生产判据复算：目标「标准」
    // 判 match）。游客页副本（think-control dump）显示的是「快速」模型的「进阶」——
    // 那是游客默认**模型**的另一套档，不是登录用户的默认，不采信。
    defaultEffort: '标准',
    effortControl: {
      kind: 'popup',
      // ## 0.19.49：`triggerText` 从 `'快速'` 改成 `'K3'`？——**都不是**，改成不声明 + readbackSelector
      //
      // 真机现场（2026-09-28 只读 CDP，线上已登录页，见 `.tmp-probe/cdp-effort-models.json`）：
      //   触发控件 `div.current-model[data-testid="model-select-trigger"]` 的体积文本是
      //   **`K3 标准`** —— `K3` 是**当前模型名**，`标准` 才是思考档。
      //   而模型菜单里可选的模型名是 `K3` / `K2.8 Preview` / `快速` 三条。
      //
      // 旧声明 `triggerText: '快速'` 因此是**把模型名当成了锚点**：
      //   · 只有当用户恰好选「快速」这个模型时，触发文本才是「快速 进阶」⇒ 锚点命中；
      //   · 换成 `K3` 后触发文本是 `K3 标准` ⇒ 锚点不在文本里 ⇒ `FIND_EFFORT_CONTROL`
      //     的 token 匹配池为空 ⇒ 回读 `label:null` ⇒ `no-readback` ⇒
      //     **每一轮都抛 THINK_EFFORT_UI_CHANGED**。用户报障的正是这一条。
      //
      // 修法分两处（判据只写一份，这里只声明事实）：
      //   ① **锚点不再承担定位**：`triggerText` 删掉，改用下方 `triggerSelectors` 的
      //      testid 定位（那个 testid 与模型名无关，是站点给这个控件的稳定身份）；
      //   ② **回读改读真正持有档位的节点**：`readbackSelector` 指向 `span.current-effort`
      //      —— 真机实测它的文本**恰好就是档位**（`标准`），不含模型名，与当前是哪个模型无关。
      //
      // 为什么 `model-name` 不能当回读源：真机里它同时含模型名与档位（`K3 标准`），
      // 仍要剥离；而 `current-effort` 是**唯一**只含档位的节点（CDP 实测 `.current-effort`
      // 的文本是 `标准` 而 `.model-name` 是 `K3 标准`）。
      triggerSelectors: ['[data-testid="model-select-trigger"]'],
      readbackSelector: '.current-effort',
      // 打开模型菜单后**先点这一行**，档位弹层才出现（`model-effort-option`）。
      itemLabel: '思考强度',
      optionSelector: '[data-testid="model-effort-option"]',
      readback: 'effort-text',
    },
  },

  /**
   * GLM：模型弹层里的 `思考强度` 子菜单（真机 dump 的 `has-submenu` 条目）。
   *
   * 为什么 `openVia` 是 modelPicker 的触发选择器字面量：那条 dump 拍到的是**模型选择器
   * 点开之后**的 DOM。换句话说 GLM 的思考档位没有独立入口，必须借模型弹层进去——
   * 这是站点事实，不是实现取巧。触发选择器与 `providers.js` 的 `modelPicker.trigger`
   * 同源（同一个真机 dump），此处用字面量是因为本模块不 import providers.js
   * （providers.js 反过来 import 本模块，反向依赖会成环）。
   */
  glm: {
    efforts: [
      { id: '快速', name: '快速', ordinal: 1 },
      { id: '深度', name: '深度', ordinal: 2 },
      { id: '极致', name: '极致', ordinal: 3 },
    ],
    // 默认档取证（0.19.52）：fresh 页两路读数一致为**极致**——
    //   · think-control dump（2026-09-28，登录副本上的 alltoolsdetail 首开页）：
    //     `.think-label-think` 文本 = 「极致」；
    //   · 0.19.49 只读 CDP（线上已登录页）：触发文本 `GLM-Flash极致`（无缝拼接）。
    // 两处都是「没人动过档位」的页面状态，即站点自己的默认档。
    defaultEffort: '极致',
    effortControl: {
      kind: 'popup',
      // ## 0.19.49：补 `readbackSelector`
      //
      // 真机只读 CDP 实测触发控件 `.think-mode-trigger` 的文本是 **`GLM-Flash极致`** ——
      // 模型名 `GLM-Flash` 与档位 `极致` **无缝拼接**（对比 `GLM-5.3 极致` 是带空格的）。
      // 旧判据走词级 `split(' ')`，切不出 `极致` ⇒ 恒 `unknown` ⇒
      // 每轮抛 THINK_EFFORT_UI_CHANGED（与 kimi 同型的第二处独立缺陷）。
      //
      // 两处一起收口：① 选择器定位（不依赖文本）；② `confirmEffort` 增「以已知档位结尾」
      // 的后缀判据（无分隔符拼接也认）。声明 `readbackSelector` 让回读**只读这个节点**，
      // 不靠「就近 + 最短文本」的启发式。
      triggerSelectors: ['.think-mode-trigger', '.mode-button'],
      readbackSelector: '.think-mode-trigger',
      // ## 0.19.77：补 `optionSelector` —— 缺它时档位根本点不到
      //
      // 真机实证（2026-10-14，`glm` 冷启页，只读探针 + 生产函数复现）：
      //   `applyEffort(page, { siteId:'glm', target:'快速' })`
      //   → 抛 `THINK_EFFORT_UI_CHANGED: 站点 glm 的思考档位子菜单入口「思考强度」不可点`
      //
      // 两层原因，**缺一不可**：
      //   ① 本段原先没有 `optionSelector` ⇒ 计划落到 `click-option`，它用页面侧
      //      `CLICK_EFFORT_OPTION` 的 `CLICKABLE` 白名单找条目。那份白名单要求候选带
      //      `role` / `data-state` 之一；
      //   ② 而 GLM 真机的三条档位是**裸 `<div class="think-mode-item …">`**：
      //      无 `role`、无 `data-state`、无 `aria-checked` ⇒ 候选池 `poolSize = 0`
      //      ⇒ 三个档位全部返回 false。
      //
      // 补上显式 `optionSelector` 后走「选择器优先」分支（不依赖 role/data-state），
      // 与 kimi 的 `[data-testid="model-effort-option"]` 同一形状。
      // 真机逐字读数：子菜单入口是 `<span class="item-think think-mode-item has-submenu …">`
      // （文本「思考强度」），三条档位是 `div.think-mode-item`。
      //
      // ⚠ 不改成放宽 `CLICKABLE` 白名单：那会同时影响所有站点，而 `role`/`data-state`
      // 是其它站点正在依赖的判据。站点差异收口在**本声明层**。
      optionSelector: '.think-mode-item',
      itemLabel: '思考强度',
      readback: 'effort-text',
    },
  },

  /**
   * Z.ai：`深度思考 最高` 那枚 pill 点开后的档位菜单（低 / 高 / 最高）。
   *
   * ⚠ 这里有一处与 z.ai 文档/其它站点不同的地方：菜单里除三档外还有一个
   * `role="switch"` 的**总开关**（真机 `state=checked`）。本模块只动档位、不动总开关——
   * 总开关的语义是「要不要思考」，属于 `thinkMode` / `model.thinking` 那条既有链
   * （`browser-driver.js` 的 syncThinkPill 一族），两条链各管一段，避免互相覆盖。
   * 已知缺口（如实记进 doc/long-term-issues.md）：网页端把思考关掉时，选档位不会把它
   * 打开——桥不替用户猜「关掉是不是误操作」。
   */
  zai: {
    efforts: [
      { id: '低', name: '低', ordinal: 1 },
      { id: '高', name: '高', ordinal: 2 },
      { id: '最高', name: '最高', ordinal: 3 },
    ],
    // 默认档取证（0.19.52）：**最高**——两路读数一致：
    //   · think-control dump（2026-09-28，fresh 落地页）：pill 文本「深度思考 最高」；
    //   · 线上实时只读 CDP（2026-09-30，`.tmp-probe/zai/live-zai-readonly.mjs`）：
    //     pill 文本「深度思考 最高」，同页**零验证码节点可见**（用户报告「人工打开
    //     从未见过验证」的独立复核）。
    defaultEffort: '最高',
    effortControl: {
      kind: 'popup',
      triggerText: '深度思考',
      readback: 'effort-text',
    },
  },

  /**
   * 通义千问：`qwen-thinking-selector` 的下拉三档（自动 / 思考 / 快速）。
   *
   * ⚠ 「快速」是**关思考**那一档（真机菜单原文如此，不是「快一点的思考」）。照逐字文本
   * 暴露，用户看到的名字就是网页上的名字——比桥自造一个「关闭」更不容易误解。
   */
  qwen: {
    efforts: [
      { id: '快速', name: '快速', ordinal: 1 },
      { id: '思考', name: '思考', ordinal: 2 },
      { id: '自动', name: '自动', ordinal: 3 },
    ],
    // 默认档取证（0.19.52）：**自动**——think-control dump（2026-09-28，fresh 页）
    // `.qwen-thinking-selector` 的文本就是「自动」，即站点 fresh 会话的默认档。
    // 注意这里的 irony：qwen 自己的默认档就叫「自动」——用户要去除的「auto」是
    // DSH 侧的「Default」行（桥不声明 defaultEffort 时宿主恒显示的那行），不是
    // qwen 菜单里真实存在的这一档；声明 defaultEffort='自动' 后 Default 行消失，
    // 而网页行为与站点默认逐字一致（零点击，回读恒 match）。
    defaultEffort: '自动',
    effortControl: {
      kind: 'popup',
      // ## 0.19.49：不再声明 `triggerText`（它**就是**档位 id，不是固定前缀）
      //
      // 旧声明 `triggerText: '自动'` 是自相矛盾的：`自动` 既是「控件固定文本」又是**一个档位 id**。
      // `effortFromTriggerLabel('自动','自动')` 剥不出附加部分 ⇒ 返回 null；而 `confirmEffort`
      // 又因为「声明了锚点」把词级兜底关掉 ⇒ 恒 `unknown` ⇒ 每轮抛 THINK_EFFORT_UI_CHANGED。
      // 真机触发文本随档位变化（`.qwen-thinking-selector` 实测 `自动`；切档后是 `思考`），
      // 也就是说它**不是固定前缀**，按锚点语义声明本身就是错的。
      //
      // 现在：定位靠选择器（下面两个），回读靠同一选择器的文本——由 `confirmEffort` 按
      // 「整段文本即档位」这条判据识别（见其 `currentEffort` 的形态②）。
      triggerSelectors: ['.qwen-thinking-selector .qwen-chat-v2-dropdown-menu-trigger', '.qwen-thinking-selector'],
      readbackSelector: '.qwen-thinking-selector',
      readback: 'effort-text',
    },
  },

  /**
   * 豆包：composer 模型下拉里的档位徽章（快速 / 专家）。
   *
   * ## 为什么它算「思考等级」而不是又一层模型
   *
   * 用户原话是「豆包不是只有对话和工作两个模式，左下角有模型和思考等级选择」——他把
   * 那枚下拉读作「模型 + 等级」。真机读数支持这个读法：下拉只有**两条**，而两条的差异
   * 是**同一个模型的档位徽章**（`<span class="truncate">豆包 2.1 Turbo</span>` 后面挂着
   * `<span>专家</span>`），不是两条不同的模型 id。把档位做成模型条目会让「同一模型两条
   * id」进模型表，而把档位做成等级则正落在宿主本来就有的推理等级通道上——后者是本次
   * 改动的全部意义（能主动选）。
   *
   * ## 为什么允许空触发
   *
   * 触发按钮 `[data-testid="chat_input_action_model"]` 的文本是「豆包 2.1 Turbo专家」
   * 这种**模型名 + 徽章**拼接，而档位 id 恰好是它的后缀：`exact` 文本匹配命中不到，
   * 靠「元测试 + 断言」也保不住（下一次改版模型名就变）。因此这里：① 用 testid 定位
   * 触发按钮；② 用**包含**文本点档位条目；③ 回读走弹层里那条 `aria-checked`/`data-state`
   * ——弹层条目上的选中态是站点给的**权威读数**，比从拼接文本里猜后缀可靠。
   *
   * ## 与「对话 / 工作」两个模式的关系
   *
   * 那两个模式仍由 `providers.js` 的 `modelPicker.segmented` 契约承担（`doubao:chat` /
   * `doubao:work`），本条目只管档位。两者互不干扰：模型选择先发生，档位再落。
   */
  doubao: {
    efforts: [
      { id: '快速', name: '快速', ordinal: 1 },
      { id: '专家', name: '专家', ordinal: 2 },
    ],
    // 默认档取证（0.19.52）：**快速**——think-control dump（2026-09-28，fresh 页，
    // 共 4 份一致）：模型下拉触发文本「豆包 快速」（下拉两条 = 「豆包 快速」与
    // 「豆包 2.1 Turbo专家」，徽章即档位）。fresh 状态是「快速」，采信。
    defaultEffort: '快速',
    effortControl: {
      kind: 'popup',
      triggerSelectors: ['[data-testid="chat_input_action_model"]'],
      triggerText: '豆包',
      allowEmptyTrigger: true,
      // ## 0.19.77：`aria-checked` → `effort-text`（含一次**我自己改法的证伪**，请读完）
      //
      // 真机实证（2026-10-14，有头冷启页，只读探针 + 生产函数复现）：
      //   `probe-think-effort-live.mjs doubao` → `FAIL（0/2）`；Lead 回归同形（0/2）。
      //
      // **第一版改法（`menuitem-svg`：读弹层里带对勾 svg 的那条）经实测证伪**：
      //   豆包的 radix 菜单**点完条目后立刻关闭**，回读那一刻 `role="menuitem"` 的条目
      //   **已不在 DOM**（Lead trace：`afterClick_*` 各采样点 menuitem 数 = 0）。
      //   ⇒「读弹层选中项」这一类口径（`aria-checked` / `menuitem-svg`）对豆包
      //   **结构性不可用**：不是判据不对，是**读的时机窗口不存在**。
      //   教训：**口径对不对，必须连「读的时机」一起证**；只证「判据能区分选中/未选中」
      //   是不够的——那正是第一版的错。
      //
      // 真机读数（**菜单开着时**，供核对）：条目 `豆包 快速` svgCount=1（对勾 M20.2246…）、
      //   `豆包 专家` svgCount=0；两条 `aria-checked` / `data-state` 均为 **null**。
      //   注意 svg 那条**不能**用作回读：菜单那时已关。
      //
      // **改为 `effort-text`（读触发钮文本）**：真机 trace 显示点完之后触发钮
      //   `[data-testid="chat_input_action_model"]` 的文本**从 `豆包 快速` 变成 `豆包 专家`**
      //   —— 那是用户眼睛看到的读数，也是本模块一贯的回读口径。本段已声明
      //   `triggerText:'豆包'`，`effortFromTriggerLabel` 剥掉锚点后得到 `快速` / `专家`，
      //   与 `knownIds` 逐字可比 ⇒ 无需新增页面侧函数。
      //
      // ⚠ 与 kimi 同族的坑这里**不存在**：kimi 触发钮文本是「快速 进阶」（模型名 + 档位），
      //   必须靠 `readbackSelector` 指到只持档位的节点；豆包触发钮文本**只有**「豆包 + 档位」，
      //   无模型名干扰，故 `effort-text` 直接可用。
      readback: 'effort-text',
    },
  },
});

/**
 * 取某站点的思考等级声明（未声明返回 null）。
 *
 * 返回的是**冻结前的引用**：调用方只读消费（providers.js 直接挂在站点对象上），
 * 不做深拷贝——一份数据两处引用是刻意的，拷贝会制造第二份真相。
 *
 * @param {string} siteId 站点 id（`deepseek` / `kimi` / …）
 * @returns {{efforts: Array<{id:string,name:string,ordinal:number}>, defaultEffort?:string, effortControl?:object}|null}
 */
export function thinkEffortFor(siteId) {
  return THINK_EFFORT[siteId] ?? null;
}

/**
 * 宿主 `resolveModel().reasoning` 的载荷（没声明等级时返回 null）。
 *
 * 形状对齐 `LlmModelReasoningInfo`：`{ efforts: [{ id, name }], defaultEffort? }`。
 * `ordinal` 不外发（它是桥内部的排序/兜底读数，宿主不认识）。
 *
 * @param {string} siteId 站点 id
 * @returns {{efforts: Array<{id:string,name:string}>, defaultEffort?:string}|null} 无等级时为 null
 */
export function reasoningEffortsFor(siteId) {
  const def = thinkEffortFor(siteId);
  if (!def || !Array.isArray(def.efforts) || def.efforts.length === 0) return null;
  return {
    efforts: def.efforts.map((e) => ({ id: e.id, name: e.name })),
    ...(def.defaultEffort ? { defaultEffort: def.defaultEffort } : {}),
  };
}

/**
 * 反查等级定义（点错档位时要把「可选项有哪些」写进报错，靠它）。
 *
 * @param {string} siteId 站点 id
 * @param {string} effortId 等级 id
 * @returns {{id:string,name:string,ordinal:number}|null} 未声明时为 null
 */
export function effortById(siteId, effortId) {
  const def = thinkEffortFor(siteId);
  if (!def) return null;
  return def.efforts.find((e) => e.id === effortId) ?? null;
}

/**
 * 页面侧：在**输入框附近**找承载思考档位的控件。
 *
 * ⚠ 这个函数会被 `page.evaluate` **序列化后在浏览器里单独执行**，因此它（以及本文件里
 * 其它几个导出的页面函数）**不得引用模块作用域的任何东西**——包括本文件里的辅助函数。
 * 0.19.48 真机实测：早先版本调用了模块级的 `insideOpenOverlay`，在 Node 单测里全绿
 * （同一进程、同一作用域），到真机上直接 `ReferenceError: insideOpenOverlay is not defined`。
 * 因此下面用的是内联副本；「只在浏览器里跑的函数必须自包含」是本文件的一条硬约束。
 *
 * 为什么不用 Playwright 的 `getByText`：它按「元素自身文本」匹配，而这里的控件文本是
 * **拼接**出来的（z.ai「深度思考 最高」、kimi「快速 进阶」、豆包「豆包 2.1 Turbo专家」），
 * 且各站点的容器层级完全不同。页面内一次扫描「就近 + 最短文本」两条件同时成立的那个节点，
 * 比在 Node 侧拼 locator 稳，也把「就近」这条判据写在唯一一处。
 *
 * @param {object} cfg `{ selector, text, tokens, known }`
 * @returns {{found:{text:string,x:number,y:number,w:number,h:number,how:string}|null, candidates:string[], menuOpen:boolean}}
 */
export const FIND_EFFORT_CONTROL = (cfg) => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const txt = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  // 内联副本（见函数头注：页面函数必须自包含，不得引用模块作用域）
  const inOverlay = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const role = p.getAttribute('role');
      if (role === 'menu' || role === 'listbox' || role === 'dialog') return true;
      try {
        const cs = getComputedStyle(p);
        if ((cs.position === 'absolute' || cs.position === 'fixed') && Number(cs.zIndex) >= 10) return true;
      } catch { /* 读不到样式就当不是浮层 */ }
    }
    return false;
  };
  // 输入框 = 「附近」的锚点。没有它就退化成全页（调用方报错时会说明候选来自哪里）。
  const input = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .filter((e) => vis(e) && e.getBoundingClientRect().width > 40)
    .pop() || null;
  const ir = input?.getBoundingClientRect() || null;
  const near = (el) => {
    if (!ir) return true;
    const r = el.getBoundingClientRect();
    const dx = Math.max(0, Math.max(ir.left - r.right, r.left - ir.right));
    const dy = Math.max(0, Math.max(ir.top - r.bottom, r.top - ir.bottom));
    return Math.hypot(dx, dy) <= 300;
  };
  const CLICKABLE = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [data-state], [aria-haspopup]';
  const all = [...document.querySelectorAll(CLICKABLE)].filter(vis);

  // ① 显式选择器（有 testid 的站点走这条）
  if (cfg.selector) {
    try {
      const hit = [...document.querySelectorAll(cfg.selector)].filter(vis);
      if (hit.length) {
        const r = hit[0].getBoundingClientRect();
        return {
          found: { text: txt(hit[0]), x: r.x, y: r.y, w: r.width, h: r.height, how: 'selector' },
          candidates: all.map(txt).filter(Boolean).slice(0, 12),
          menuOpen: false,
        };
      }
    } catch { /* 非法选择器：落到文本形态 */ }
  }

  // ② 文本形态：token 全含 + 就近（+ 有则用它：**开合状态属性**）。
  //
  // ## 为什么「文本最短」不够（2026-09-28 真机教训）
  //
  // z.ai 的思考控件是一枚 pill（`<div data-state="closed">深度思考 最高</div>`），而它的档位
  // 菜单里**还有一条同名的常驻行**「深度思考」（那个是总开关）。两者都能被 `depth思考` 这个
  // token 命中，而菜单行文本更短（4 字 < 7 字）⇒ 旧判据（就近 + 最短）会选中菜单行，
  // 于是回读永远读到菜单行、报「读不到档位」，而截图里 pill 明明写着「深度思考 最高」。
  //
  // 修法是把「可点控件」的**结构证据**提到文本之前：
  //   ① 带 `data-state` / `aria-expanded` / `aria-haspopup` 的候选优先（那是「能开合的控件」，
  //      菜单里的条目也带 data-state，但它在浮层里 ⇒ 下一步排除）；
  //   ② 排除**位于已打开浮层内**的候选（那条菜单行就在浮层里）；
  //   ③ 剩下的按文本最短取（多层容器时取最内那一层，与旧行为一致）。
  const want = cfg.tokens?.length ? cfg.tokens : (cfg.text ? [cfg.text] : []);
  if (want.length) {
    const hasToggleMark = (el) => el.getAttribute('data-state') !== null
      || el.getAttribute('aria-expanded') !== null
      || el.getAttribute('aria-haspopup') !== null;
    const pool = all.filter((el) => near(el) && want.every((t) => txt(el).includes(t)))
      .filter((el) => txt(el).length <= 80);
    const marked = pool.filter(hasToggleMark);
    // 判据顺序（每一层都对应一个真机事实，别调换）：
    //   ① **不在浮层里** —— z.ai 的档位菜单里有一条与触发控件**同名**的常驻行「深度思考」
    //      （那是总开关）。菜单一开，同 token 的候选就从 1 个变 2 个；不排除浮层内的候选，
    //      回读会读到那条菜单行（文本更短），于是「pill 明明显示 深度思考 最高」却被判成
    //      「读不到档位」。真机实测：这条让 z.ai 三次下发全部失败（菜单开了、档也改了）。
    //   ② 带开合状态属性（`data-state` / `aria-expanded` / `aria-haspopup`）的优先——那是
    //      「能开合的控件」的结构证据，比文本形状稳。
    //   ③ 文本形状：先按「文本里的词有多少属于**本控件该有的词**」打分（该有的词 = 触发文本
    //      的 token + 本站点声明的档位），分高者胜；同分取文本**最短**（多层容器嵌套时取最内
    //      那一层，与既有行为一致）。
    //      为什么不单独按文本长度判：z.ai 的菜单里有一条与触发控件同名的常驻行（「深度思考」，
    //      比 pill 的「深度思考 最高」短）⇒ 取最短会选中它；而外层容器更长
    //      （「深度思考 最高 智能搜索 联网」，含别的功能名）⇒ 取最长会选中容器。两个方向都
    //      错，所以判据必须是**词的构成**，不是长度。两侧各有一条护栏：
    //      真机（z.ai 实测）与 `test/think-effort.test.mjs` ④g / ④j。
    const allowed = new Set([...want]);
    for (const k of (cfg.known || [])) allowed.add(k);
    const score = (t) => t.split(' ').filter(Boolean).filter((p) => allowed.has(p)).length;
    const outside = marked.filter((el) => !inOverlay(el));
    const inside = marked.filter((el) => inOverlay(el));
    const hits = (outside.length ? outside : (inside.length ? inside : pool))
      .slice()
      .sort((a, b) => (score(txt(b)) - score(txt(a))) || (txt(a).length - txt(b).length));
    if (hits.length) {
      const el = hits[0];
      const r = el.getBoundingClientRect();
      return {
        found: { text: txt(el), x: r.x, y: r.y, w: r.width, h: r.height, how: 'text' },
        candidates: hits.slice(0, 6).map(txt),
        menuOpen: false,
      };
    }
  }

  // ③ 触发控件按 token 匹配不到：看档位弹层是不是**已经开着**（豆包的前提，见 doubao 条目）。
  const known = cfg.known || [];
  const openItem = all.find((el) => {
    const st = el.getAttribute('data-state');
    const t = txt(el);
    if (st !== 'checked' && el.getAttribute('aria-checked') !== 'true') return false;
    // 必须**同时**满足「在一个打开的浮层里」：单看选中态会把页面上任何一处带
    // checked/data-state 的常驻控件（kimi 的模型下拉触发钮就是）误判成「菜单已打开」。
    if (!inOverlay(el)) return false;
    return known.some((k) => t.includes(k));
  });
  return { found: null, candidates: all.map(txt).filter(Boolean).slice(0, 12), menuOpen: Boolean(openItem) };
};

/**
 * 页面侧：按**档位文本**找那条可点的档位条目。
 *
 * 为什么不能用 Playwright 的 `getByText`：它取「包含该文本的**最内层**元素」——真机读数里
 * 那是条目里的 `<span>`（z.ai 的档位行是 `<button><span>高</span></button>`），
 * 而 span 不是可点元素：`isVisible()` 为假、`click()` 报 not visible。0.19.48 首版正是
 * 这样写的，真机症状是「菜单明明开着（截图可见 低/高/最高），却报档位菜单里没有这一档」，
 * 报错还带着「当前读数：深度思考」这种自相矛盾的现场。
 *
 * 这里的判据：在候选池里取文本**恰好**是档位（或末尾是档位、或**以档位开头**）的那个，
 * 且文本最短——父容器（如整个 menu）文本更长，因此不会被选中。
 *
 * ## 0.19.77：新增「前缀形态」与「候选池限定」（GLM 真机修出）
 *
 * GLM 真机菜单（2026-10-14 trace）三级文本形态，**必须支持前缀**：
 *   · 子菜单入口行：`思考强度极致快速深度处理复杂任务极致全力推理，耗时更长`（聚合了全部档位）
 *   · 真实档位条目：`快速` / `深度处理复杂任务` / `极致全力推理，耗时更长`
 *     —— 档位 id 是这些文本的**前缀**，不是结尾（旧的 `endsWith` 判据恒 false
 *     ⇒ 真机症状「菜单明明开着，却报档位菜单里没有这一档」）。
 * 同时那些条目的 class 是裸 `div.think-mode-item`：**无 `role`、无 `data-state`**，
 * 因此不在 `CLICKABLE` 白名单里（候选池为空 ⇒ 恒 false）。⇒ 需要 `selector` 参数
 * 把候选池换成站点声明的形状（GLM 传 `.think-mode-item`）。
 *
 * @param {string|{want:string, selector?:string|null}} arg 档位文本，或 `{want, selector}`
 * @returns {boolean} 是否点到了一次（false = 没找到那条，调用方据此报 UNAVAILABLE）
 */
export const CLICK_EFFORT_OPTION = (arg) => {
  const spec = typeof arg === 'string' || arg == null ? { want: arg } : arg;
  const want = String(spec.want ?? '');
  const pool = spec.selector ? String(spec.selector) : null;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const txt = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const CLICKABLE = 'button, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="radio"], [role="listitem"], [data-state]';
  const inOverlay = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const role = p.getAttribute('role');
      if (role === 'menu' || role === 'listbox' || role === 'dialog') return true;
      try {
        const cs = getComputedStyle(p);
        if ((cs.position === 'absolute' || cs.position === 'fixed') && Number(cs.zIndex) >= 10) return true;
      } catch { /* 读不到样式就不算浮层 */ }
    }
    return false;
  };
  // 候选池：站点声明了 `selector` 就用它（GLM 的裸 `div.think-mode-item` 不在 CLICKABLE 里），
  // 否则退回 CLICKABLE + 浮层判据（kimi / zai / qwen 等有 role/data-state 的站点走这条）。
  const base = pool
    ? [...document.querySelectorAll(pool)]
    : [...document.querySelectorAll(CLICKABLE)].filter((el) => inOverlay(el));
  const cands = base
    .filter((el) => vis(el))
    .map((el) => ({ el, t: txt(el) }))
    .filter((c) => {
      if (!c.t) return false;
      // 前缀形态（GLM 的 `深度处理复杂任务` 对应 id `深度`）：只在 `selector` 限定过候选池时
      // 启用——不限池时前缀会误命中父容器（它的文本以第一个档位开头）。
      if (pool && c.t.startsWith(want)) return true;
      if (c.t === want || c.t.endsWith(want)) return true;
      // 条目文本可能带**选中标记**（真机 kimi 的 `进阶 已选`）或状态徽章，所以还要按词判。
      // 它同时覆盖豆包那种拼接文本（`豆包 2.1 Turbo专家` ⇒ 词 `2.1 Turbo专家` 以「专家」结尾）。
      return c.t.split(' ').filter(Boolean).some((w) => w.endsWith(want));
    })
    // 最短优先：父行聚合了全部档位、文本最长，因此永远排在真实条目之后。
    .sort((a, b) => a.t.length - b.t.length);
  if (!cands.length) return false;
  cands[0].el.click();
  return true;
};

/**
 * 页面侧：读弹层里**被选中**的那条文本（回读口径 `aria-checked`）。
 *
 * 它同时承担两条职责：① 确认刚点的档位生效；② 兜底读「网页当前档位」（豆包用——
 * 它的触发按钮文本拼了模型名，读不出干净档位）。
 *
 * @returns {string|null} 选中项文本，读不到返回 null
 */
export const READ_CHECKED_EFFORT = () => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const txt = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const SEL = '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], [data-state]';
  // ① 权威态：aria-checked / data-state（真机里 kimi 的 `checked` 类与 data-state=checked 并存）
  for (const el of document.querySelectorAll(SEL)) {
    if (!vis(el)) continue;
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('data-state') === 'checked') return txt(el);
  }
  // ② 兜底：选中态只写在 class 上的站点（真机 qwen 用 `…-item-select`）
  for (const el of document.querySelectorAll('[class*="item-select"], [class*="checked"]')) {
    if (!vis(el)) continue;
    const t = txt(el);
    if (t) return t;
  }
  return null;
};

/**
 * 页面侧：读**声明式回读节点**的文本（0.19.49）。
 *
 * 与 `FIND_EFFORT_CONTROL` 的分工（两条路各有明确适用面，不要互相替代）：
 *   · 本函数用于站点**明确知道**「哪个节点只持有档位」的情况（kimi 的 `span.current-effort`、
 *     qwen 的 `.qwen-thinking-selector`、glm 的 `.think-mode-trigger`）——它直接、无启发式、
 *     与模型名无关；真机读数见 `THINK_EFFORT` 各条目的 `readbackSelector` 注释。
 *   · `FIND_EFFORT_CONTROL` 用于**没有**这种稳定节点的站点（z.ai 的 pill、豆包的空触发），
 *     靠「就近 + token + 最短文本」定位。
 *
 * ⚠ 与 `FIND_EFFORT_CONTROL` 同一约束：本函数被 `page.evaluate` 序列化后单独执行，
 * **不得引用模块作用域**（0.19.48 真机 `ReferenceError` 的教训）。
 *
 * 返回**第一个可见命中**的文本；节点不存在或不可见时返回 null——「读不到」必须与
 * 「读到空文本」可区分，前者要回落另一条路，后者是页面的真实读数。
 *
 * @param {string} sel CSS 选择器
 * @returns {{text:string, cls:string|null}|null}
 */
export const READ_SELECTOR_TEXT = (sel) => {
  if (!sel) return null;
  let els = [];
  try { els = [...document.querySelectorAll(sel)]; } catch { return null; }
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (t) return { text: t, cls: el.getAttribute('class') };
  }
  return null;
};

/**
 * 把「思考等级」落到网页控件上（唯一的执行器；驱动与真机探针共用它）。
 *
 * ## 为什么执行器在这里、而驱动只是调用方
 *
 * 等级是**网页控件**上的状态，而「哪一档在哪个控件里」这件事按纪律只能定义一次。
 * 若执行器写在驱动里，真机探针就得抄一份才能验它——而抄一份的探针验的是抄件，不是驱动。
 * 因此本函数收在声明旁边，`page` 从参数进来（驱动传自己那一页，探针传探针那一页）。
 *
 * ## 绝不静默降级（本仓库三条不可越界约束的思考等级版本）
 *
 * `target` 为 null（用户没选 / 选择器停在 Default）时**立即返回**：不点、不改、不读，
 * 网页当前档位原样保留——与本次改动前逐字相同。`target` 非 null 时只有两种收场：
 * 设好并回读确认，或**抛错**。没有「点了但没生效就照常发送」——用户选了「深度」而网页
 * 停在「快速」，那是一次静默降级，界面上完全看不出来。
 *
 * @param {object} page Playwright Page（或其等价替身：测试用的假 page 走同一条路径）
 * @param {object} o
 * @param {string} o.siteId 站点 id
 * @param {string|null} o.target 目标等级 id（网页菜单里的逐字文本）；null = 不动网页
 * @returns {Promise<{applied:boolean, target:string|null, readback:string|null, reason:string|null, state?:string}>}
 * @throws {Error} `THINK_EFFORT_UNKNOWN` / `THINK_EFFORT_UI_CHANGED` / `THINK_EFFORT_UNAVAILABLE`
 */
export async function applyEffort(page, { siteId, target } = {}) {
  if (target === null || target === undefined) {
    return { applied: false, target: null, readback: null, reason: 'not-selected' };
  }
  const plan = planEffort({ siteId, target });
  if (plan.kind === 'noop') return { applied: false, target: null, readback: null, reason: plan.reason };
  const ctl = plan.control;
  const findCfg = {
    selector: (ctl.triggerSelectors || [])[0] ?? null,
    text: ctl.triggerText ?? null,
    tokens: ctl.triggerText ? [ctl.triggerText] : null,
    known: plan.knownIds,
  };
  const fail = (code, msg, extra = {}) => {
    const err = new Error(code + ': ' + msg);
    // 码走真源（`code` 是运行期变量，故用 withWebcodeCode 而非字面量构造器）。
    withWebcodeCode(err, code);
    err.siteId = siteId;
    err.target = target;
    Object.assign(err, extra);
    throw err;
  };
  /**
   * 回读「网页现在是什么档」。
   *
   * 口径由站点声明决定，**两条路互不混用**：
   *   · `aria-checked`（豆包）：读弹层里被 checked 的那条 —— 它的触发钮文本拼的是模型名，
   *     档位只是后缀，读不出干净档位；
   *   · `effort-text`（其余）：读触发控件本身的文本 —— 这正是**用户眼睛看到的那个读数**，
   *     也就是「界面显示高档」这句承诺的判据；顺手读 checked 会让一次没生效的改档
   *     被菜单里的旧选中态掩盖。
   */
  const readBack = async () => {
    if (ctl.readback === 'aria-checked') {
      return { checked: await page.evaluate(READ_CHECKED_EFFORT).catch(() => null), label: null };
    }
    // `readbackSelector`（0.19.49）：**优先**读那个「只持有档位」的节点。
    //
    // 为什么必须优先于 `FIND_EFFORT_CONTROL` 的启发式：那条启发式是「输入框附近 + 含声明
    // token + 最短文本」，而 token 一旦是**模型名**（kimi 旧声明的 `快速`），模型一换
    // 匹配池就为空 ⇒ 回读 `label:null` ⇒ 恒 `no-readback`。声明式选择器与模型无关，
    // 也不受「菜单开着时同 token 候选变多」的影响。读不到就如实回落启发式，
    // 两条路都读不到才算 `no-readback`（不把「选择器过期」伪装成「网页没档位」）。
    if (ctl.readbackSelector) {
      const sel = await page.evaluate(READ_SELECTOR_TEXT, String(ctl.readbackSelector)).catch(() => null);
      if (sel) return { checked: null, label: sel.text ?? null, from: 'readbackSelector' };
    }
    const snap = await page.evaluate(FIND_EFFORT_CONTROL, findCfg).catch(() => ({ found: null }));
    return { checked: null, label: snap?.found?.text ?? null, from: 'find-control' };
  };
  const visible = async (loc) => {
    try { return Boolean(await loc.count()) && await loc.isVisible().catch(() => false); } catch { return false; }
  };
  // 下发**之前**触发控件上读到的文本（空串 = 没读到）。回读用它排除「菜单关掉后又读回原样」的假成功。
  let baselineLabel = '';
  // glm 是唯一「控件本身在**别的**弹层里」的站点：它没有独立触发钮，档位子菜单靠
  // `itemLabel`（「思考强度」）从模型弹层里点开。因此「触发控件是否声明过」必须单独判，
  // 否则会先去 DOM 里找一个根本不存在的 token 控件，再报一句误导的「找不到控件」。
  const hasTrigger = Boolean(ctl.triggerText || (ctl.triggerSelectors || []).length);

  /**
   * 这一步要不要走「先点开子菜单入口」？
   *
   * 两个判据缺一不可：
   *   ① 声明了 `itemLabel`（否则没有入口可点）；
   *   ② 屏幕上那个「触发控件」**不是**档位控件本身 —— 判据是它的文本里一个已知档位都
   *      读不到（glm 的 `.think-mode-trigger` 文本是「GLM-5.3 极致」，读得到 ⇒ 它是
   *      档位控件，走坐标点击；kimi 同族）。反过来，kimi 这种「触发钮只显示模型名
   *      + 当前档」的站点读到档位 ⇒ 不进子菜单，直接点它开菜单。
   *
   * 这一条判据是**修出来的**，不是设计出来的：0.19.48 首版只看 `itemLabel`，于是 kimi
   * 每轮都去点「思考强度」那一步、档位菜单永远不开，最后死在回读上（报错还指向「没有
   * 生效」，与真因「菜单根本没打开」不符）。
   *
   * ## 0.19.77：GLM 的入口在**尚未打开的弹层里**（真机修出）
   *
   * 真机实证（2026-10-14，`glm` 冷启页 trace）：`page.getByText('思考强度')` 在弹层
   * **没打开**时命中 0；先点一次 `.think-mode-trigger` 打开模型弹层后，同一个
   * `getByText` 立刻 `count=1 / visible=true`（该行是
   * `<span class="item-think think-mode-item has-submenu …">`）。
   * ⇒ 旧实现在本分支直接 `fail`，而 GLM 每次都是「弹层未开就去找入口」⇒ 恒失败。
   * 修法：入口不可见时**先点触发控件打开那一层**，再重新评估（不改本判据的语义）。
   */
  const useSubmenu = (snap) => Boolean(ctl.itemLabel)
    && !plan.knownIds.some((id) => String(snap?.found?.text ?? '').split(' ').filter(Boolean).includes(id));

  for (const step of plan.steps) {
    if (step.op === 'click' && step.how === 'selector-any') {
      for (const s of step.selectors || []) {
        const loc = page.locator(s).first();
        if (await visible(loc)) { await loc.click({ timeout: 4000 }); break; }
      }
      await page.waitForTimeout(400);
      continue;
    }
    if (step.op === 'find-trigger') {
      if (!hasTrigger && ctl.itemLabel) {
        // 没有触发钮、只有弹层里那一行（真机里 glm 之外的站点不该走到这里）
        const item = page.getByText(ctl.itemLabel, { exact: false }).first();
        if (await visible(item)) { await item.click({ timeout: 4000 }); await page.waitForTimeout(700); continue; }
        fail('THINK_EFFORT_UI_CHANGED', `站点 ${siteId} 的思考档位子菜单入口「${ctl.itemLabel}」不可点`);
      }
      const snap = await page.evaluate(FIND_EFFORT_CONTROL, findCfg);
      // **幂等快路**：网页现在就已经是目标档 ⇒ 一眼判定成功，任何控件都不动。
      // 它同时修掉一个真机坑：重复下发时如果硬走「点开触发」，菜单里那条与触发控件同名的
      // 常驻行会顶掉触发控件的位置，后续回读与点击全部失准（z.ai 实测三次全挂）。
      //
      // 0.19.49：**这里的读数必须来自与回读步同一个源**（`readBack()`）。
      // 旧实现直接取 `snap.found.text`（= 触发控件），而回读步可能读的是另一个节点
      // （kimi 的 `span.current-effort` 只有 `标准`，触发控件是 `K3 标准`）。两个源不同
      // 会让「这里说已经生效」与「回读说没生效/读不到」互相矛盾——而这条快路的整个价值
      // 就是「快路与回读永远同判」。`baselineLabel` 也一并取同一个源，否则
      // 「下发前后同一读数」那条防假成功判据会拿两个不同节点的文本比对（恒不等 ⇒ 假阴性）。
      const preRb = await readBack();
      baselineLabel = preRb.label ?? '';
      const pre = confirmEffort({ target, label: baselineLabel, triggerText: ctl.triggerText ?? null, knownIds: plan.knownIds });
      if (pre.state === 'match') {
        return { applied: true, target, readback: pre.seen, reason: 'already:' + pre.reason, state: pre.state };
      }
      if (!snap?.found && !snap?.menuOpen && plan.openIfClosed) {
        // 触发控件按 token 匹配不到（豆包：按钮文本拼了模型名）⇒ 用站点声明过的选择器直接
        // 点开，随后靠弹层里的选中态确认。这一步**只**对显式声明 allowEmptyTrigger 的站点发生。
        let opened = false;
        for (const s of ctl.triggerSelectors || []) {
          const loc = page.locator(s).first();
          if (await visible(loc)) { await loc.click({ timeout: 4000 }); await page.waitForTimeout(900); opened = true; break; }
        }
        if (!opened) {
          fail('THINK_EFFORT_UI_CHANGED',
            `站点 ${siteId} 上找不到思考等级控件（目标「${target}」）`
            + ` — 就近可点节点：${(snap?.candidates || []).join('、') || '（一个都没有）'}`);
        }
        continue;
      }
      if (!snap?.found && !snap?.menuOpen) {
        fail('THINK_EFFORT_UI_CHANGED',
          `站点 ${siteId} 上找不到思考等级控件（目标「${target}」）`
          + ` — 就近可点节点：${(snap?.candidates || []).join('、') || '（一个都没有）'}`);
      }
      // 弹层已经开着（上一轮留下的）就别再点触发——点它会把菜单关掉（真机教训，见 model-picker）。
      if (useSubmenu(snap)) {
        // 触发控件是弹层里的**父条目**（glm「思考强度」）：先点它展开子菜单。
        const item = page.getByText(ctl.itemLabel, { exact: false }).first();
        if (await visible(item)) { await item.click({ timeout: 4000 }); await page.waitForTimeout(700); continue; }
        // ## 0.19.77：入口在**尚未打开的**弹层里 ⇒ 先开那一层，再重新评估（真机修出）
        //
        // 真机实证（2026-10-14，`glm` 冷启页 trace）：
        //   · 弹层未开时 `page.getByText('思考强度')` 命中 **0**，旧实现在这里直接 `fail`
        //     ⇒ GLM 的非默认档位**每次**都失败（`快速`/`深度` 恒抛 UI_CHANGED，
        //     而 `极致` 因走幂等快路恰好通过——所以这个缺陷能长期躲过真机复跑）。
        //   · 先点一次 `.think-mode-trigger` 打开模型弹层后，同一 `getByText` 立刻
        //     `count=1 / visible=true`（该行是
        //     `<span class="item-think think-mode-item has-submenu …">`，文本「思考强度」）。
        //
        // 修法：入口不可见时**先点触发控件打开承载它的那一层**，然后 `continue` 重走本轮
        // 计划（下一轮进来时 `snap.menuOpen` 为真、入口可见 ⇒ 走上面那条分支点开子菜单）。
        // 这里刻意**不改** `useSubmenu` 的语义：它的判据是「触发控件是不是档位控件本身」，
        // 与本缺陷无关（我曾误改它、并因此引入新行为，已回退——见下方 note）。
        const opener = page.locator((ctl.triggerSelectors || [])[0] || '').first();
        if (await visible(opener)) {
          await opener.click({ timeout: 4000 });
          await page.waitForTimeout(900);
          continue;
        }
        fail('THINK_EFFORT_UI_CHANGED', `站点 ${siteId} 的思考档位子菜单入口「${ctl.itemLabel}」不可点`);
      }
      await page.mouse.click(snap.found.x + (snap.found.w || 0) / 2, snap.found.y + (snap.found.h || 0) / 2);
      await page.waitForTimeout(1100);
      continue;
    }
    if (step.op === 'click-option') {
      // 档位条目必须按**可点元素**找：有声明选择器就用它（kimi 的 testid），否则用页面侧的
      // CLICK_EFFORT_OPTION（它只认浮层里的可点元素，见其注释——`getByText` 会命中 span）。
      //
      // 只对「**没找到条目**」重试：真机上弹层是异步渲染的，点开触发后菜单可能还差一两帧
      // 才挂上；第一次点击也可能被页面吞掉（z.ai 2026-09-28 实测：三轮里「最高/高」成功而
      // 「低」报菜单里没有这一条，两次的页面结构完全一样——就是时序）。重试之间按需**重新点开
      // 触发钮**：菜单被关掉时，光等是等不回来的。
      // **绝不**因为「点了没生效」重试：那是回读步的判据，在这里重试会把「改档失败」掩盖成
      // 「多点了一次」。
      let clicked = false;
      for (let attempt = 0; attempt < 3 && !clicked; attempt += 1) {
        if (attempt) {
          await page.waitForTimeout(700);
          const again = await page.evaluate(FIND_EFFORT_CONTROL, findCfg).catch(() => null);
          if (again?.found) {
            await page.mouse.click(again.found.x + (again.found.w || 0) / 2, again.found.y + (again.found.h || 0) / 2);
            await page.waitForTimeout(900);
          }
          // ## 0.19.77：有子菜单入口的站点（GLM）必须**重新展开子菜单**
          //
          // 真机读数（2026-10-14，GLM 回归）：`快速` 通过后紧接着 `深度` 失败，报
          // `UNAVAILABLE`；而回读显示网页上一个档位是 `GLM-Flash快速`——说明上一轮**生效了**，
          // 只是这一轮点开模型弹层后**子菜单没有随之展开**（档位列未挂载），
          // 于是候选池里没有条目。
          //
          // 修法：重试时若站点声明了 `itemLabel`，在重开模型弹层之后再点一次子菜单入口。
          // 这与上面的主路径同一判据（`getByText(itemLabel)`），失败不抛错——下一轮循环
          // 还会再试，最终由 `!clicked` 那条出口如实报 UNAVAILABLE。
          if (ctl.itemLabel) {
            const sub = page.getByText(ctl.itemLabel, { exact: false }).first();
            if (await visible(sub)) { await sub.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(700); }
          }
        }
        if (ctl.optionSelector) {
          // ① 站点给了**精确**选择器（kimi 的 `[data-testid="model-effort-option"]`）时，
          //    Playwright locator 这条最直接：它按 testid 命中唯一元素，语义清晰。
          //    护栏 `test/think-effort.test.mjs` ④ 钉住「kimi 只在点档位那一步用 locator」。
          const cand = page.locator(ctl.optionSelector).filter({ hasText: target });
          if (await visible(cand)) { await cand.first().click({ timeout: 4000 }); clicked = true; }
        }
        if (!clicked) {
          // ② 兜底走页面侧实现（0.19.77，GLM 真机修出）。
          //
          // 为什么 GLM 走不到 ①（真机 2026-10-14 trace）：`.think-mode-item` 同时命中
          // **左列模型行**（`GLM-Flashnew5.3-Flash，回复速度快` —— 含子串「快」）与
          // **右列档位条目**（`快速`）。`filter({hasText:'快速'})` 因此匹配 **2 个**元素，
          // Playwright 的 `isVisible()` 在严格模式下**抛错**，被 `visible()` 的 catch
          // 吞成 `false` ⇒ ① 永远不成立 ⇒ 旧代码直接误报 `THINK_EFFORT_UNAVAILABLE`
          // （菜单其实开着、条目就在那儿）。
          //
          // 页面侧实现按「精确相等 / 后缀 / 限池后的前缀 + 最短优先」判，不会被
          // 「左列模型行含子串」骗到：`GLM-Flashnew5.3-Flash，回复速度快` 不以 `快速` 开头、
          // 也不以它结尾，而真实条目 `快速` 恰好相等且最短。
          // `optionSelector` 在这里作为**候选池**传入（限定范围），语义不变。
          clicked = await page.evaluate(
            CLICK_EFFORT_OPTION,
            ctl.optionSelector ? { want: target, selector: ctl.optionSelector } : target,
          ).catch(() => false);
        }
      }
      if (!clicked) {
        const rb = await readBack();
        fail('THINK_EFFORT_UNAVAILABLE',
          `站点 ${siteId} 的档位菜单里没有「${target}」`
          + `（可选项：${plan.knownIds.join(' / ')}；当前读数：${rb.checked ?? rb.label ?? '读不到'}）`);
      }
      await page.waitForTimeout(600);
      continue;
    }
    if (step.op === 'readback') {
      // 轮询到匹配或超时：站点改档是异步的（z.ai / qwen 会重渲染触发控件）。
      let conf = { state: 'unknown', reason: 'no-readback', seen: null };
      for (let i = 0; i < 6; i++) {
        const rb = await readBack();
        conf = confirmEffort({ target, label: rb.label ?? '', checkedLabel: rb.checked ?? '', triggerText: ctl.triggerText ?? null, knownIds: plan.knownIds });
        // 「与下发前是**同一个**读数」不算生效：菜单关闭后触发钮文本会回到原样，那一读若被
        // 当成成功，就等于把没生效的改档记成生效（一次静默降级）。
        if (conf.state === 'match' && baselineLabel && normalizeLabel(rb.label ?? '') === normalizeLabel(baselineLabel)) {
          conf = { state: 'unknown', reason: 'readback-unchanged-from-baseline', seen: conf.seen };
        }
        if (conf.state === 'match') break;
        await page.waitForTimeout(250);
      }
      if (conf.state !== 'match') {
        fail('THINK_EFFORT_UI_CHANGED',
          `思考等级「${target}」没有生效（站点 ${siteId}）— 回读：${conf.seen ?? '读不到档位'}`
          + `（判定 ${conf.reason}）。本轮已中止，避免把「用户选了高档、网页仍是低档」当成成功。`,
          { state: conf.state, reason: conf.reason, readback: conf.seen });
      }
      return { applied: true, target, readback: conf.seen, reason: conf.reason, state: conf.state };
    }
  }
  // 计划跑完却没有 readback 步：这是**声明缺项**（配置错），不是运行期状态——如实报。
  fail('THINK_EFFORT_UNKNOWN', `站点 ${siteId} 的思考等级计划缺少回读步骤（目标「${target}」）`);
}

/**
 * 剥离触发控件的**固定文本部分**，剩下的才可能是当前档位（读不出来返回 null）。
 *
 * 为什么必须剥离（0.19.48 真机教训，两端各一次）：
 *   · 不剥离，「网页当前是什么档」就没法从触发控件文本里读出来 —— 而它正是回读判据；
 *   · 剥得太松就会把**模型名**当成档位：kimi 的触发钮文本是「快速 进阶」（「快速」是模型档、
 *     「进阶」才是思考档）。上游若把「进阶」当成「网页已经是这个档」，就会跳过下发、
 *     把指令当成已完成 —— 那是一次静默降级，正是本模块存在的理由要拦的东西。
 *
 * 判据（逐字文本，不用模糊匹配）：固定部分 = 站点声明的 `triggerText`，没声明则取
 * 那一段固定文本（z.ai「深度思考」、kimi「快速」）。
 * 触发文本必须以固定部分**开头**；后缀剥掉常见分隔符后就是附加部分。剥不出来返回 null——
 * 读不出来就说读不出来，由 applyEffort 去弹层里拿权威读数（那一步有一次真实点击保底）。
 *
 * @param {string} label 触发控件的文本
 * @param {string|null} triggerText 站点声明的固定文本部分（z.ai「深度思考」/ kimi「快速」/ 豆包「豆包」）
 * @returns {string|null} 附加部分（可能还含别的词，如豆包「2.1 Turbo专家」），无法剥离返回 null
 */
export function effortFromTriggerLabel(label, triggerText) {
  const seen = normalizeLabel(label);
  const base = normalizeLabel(triggerText);
  if (!seen || !base) return null;
  // 锚点出现在**词首**才算数（`'快速 标准'` 以 `'快速'` 开头 ⇒ 通过；
  // `'K3 进阶'` 不以 `'快速'` 开头 ⇒ 不通过，返回 null 交给调用方走词级兜底）。
  const at = seen.indexOf(base);
  if (at < 0) return null;
  const before = seen.slice(0, at).trim();
  if (before && !/^[\s·|/\\,，、]+$/.test(before)) return null;
  const extra = seen.slice(at + base.length).replace(/^[\s·|/\\,，,、:：\-–—>»›]+/, '').trim();
  if (extra) return extra;
  // ## 锚点**就是**整个文本时返回 null（0.19.49 定案）
  //
  // 真机现场（qwen，2026-09-28 只读 CDP）：触发控件 `.qwen-thinking-selector` 的文本
  // 就是一个档位 id（`自动` / `思考`），而声明的 `triggerText` 也是 `自动`。此时
  // `extra` 为空串，旧实现返回 null ⇒ `confirmEffort` 走 `triggerText ? null : 词级兜底`
  // ⇒ 直接 `unknown` ⇒ **每轮抛 THINK_EFFORT_UI_CHANGED**（用户报障的同一句话）。
  //
  // 为什么这里仍然返回 null、而把「文本本身就是档位」交给 `confirmEffort` 判：
  //   · 本函数的契约是「剥出**固定部分之后**的附加部分」，空附加部分就是「没有附加部分」，
  //     返回空串会与「剥不出」混淆，两个调用点（confirmEffort / 测试）都会各自再判一次；
  //   · 而「整段文本恰好是一个档位 id」是一条**需要 knownIds 才能判**的命题——本函数
  //     签名里没有 knownIds，硬塞进来会让它越权。
  // 因此分工写死：**剥离归这里，判定归 confirmEffort**（那里有 knownIds，且要处理
  // 「锚点本身就是档位」与「无空格拼接」两种真机形态）。
  return null;
}

/**
 * 归一化回读文本：去空白、压重复。
 *
 * 为什么必须归一化：真机里触发控件的 `textContent` 是「深度思考\n最高」（换行）或
 * 「深度思考 最高」（空格，z.ai 的 innerText 读法），而 dump 工具读出来是单空格一份。
 * 判定若按原始文本比对，同一控件会因读法不同得到两种结论——本仓库记过多次「同一事实
 * 两种读数」的账，故在唯一入口压平。
 *
 * @param {unknown} text 原始文本
 * @returns {string} 去首尾空白、内部空白压成单空格、去掉空格的比较用串
 */
export function normalizeLabel(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 判定「网页当前档位」是否就是目标档（**只认锚点之后的部分**）。
 *
 * 三种肯定证据（任一成立即算命中，顺序即优先级）：
 *   ① `checkedLabel` 逐字等于目标（弹层里被 checked 的那条 —— 权威态）；
 *   ② 触发文本剥掉固定部分后，剩余恰好是目标（z.ai 的「深度思考 最高」+ triggerText
 *      「深度思考」⇒ 剩余「最高」；`triggerText` 由站点声明，见 effortFromTriggerLabel）；
 *   ③ `target` 为 null（用户选了 Default）：**永远算命中**——Default 的语义就是「不动网页」。
 *
 * ## 为什么必须要求锚点（而不是「文本里含目标」）
 *
 * 真机教训（kimi，2026-09-28）：kimi 的触发钮文本是「快速 进阶」——「快速」是**模型档**、
 * 「进阶」才是思考档。旧版用「文本里出现目标片段」判定，于是「目标 = 进阶」被直接判成
 * 「网页已经是进阶」，下发被跳过。这与本模块存在的理由（绝不静默降级）正好相反，
 * 因此判据收紧成「固定部分之后的附加部分才是档位」：没有 `triggerText` 声明的站点
 * 从触发文本里读不出档位（返回 unknown），由 `applyEffort` 去弹层里拿权威读数。
 *
 * @param {object} o
 * @param {string|null} o.target 目标等级 id（null = Default，不动网页）
 * @param {string} [o.label] 触发控件回读文本
 * @param {string} [o.checkedLabel] 弹层里被 checked 的那条的文本（有则优先于 label）
 * @param {string|null} [o.triggerText] 站点声明的固定文本部分（无声明则传 null）
 * @param {Array} [o.knownIds] 本站点已知等级 id 列表（用于「读到了**别的**档位」判定）
 * @returns {{state:'match'|'mismatch'|'unknown', reason:string, seen:string|null}}
 */
export function confirmEffort({ target, label = '', checkedLabel = '', triggerText = null, knownIds = [] } = {}) {
  if (target === null || target === undefined) {
    return { state: 'match', reason: 'default-does-not-touch-page', seen: null };
  }
  const checked = normalizeLabel(checkedLabel);
  if (checked) {
    // 权威态：弹层里被 checked 的那条。它的文本可能是**拼接**的（豆包「豆包 2.1 Turbo专家」
    // 里档位只是后缀徽章），所以判据是「这条里有没有已知档位、是不是目标那个」，而不是逐字相等。
    const checkedEfforts = knownIds.filter((id) => checked.includes(id));
    if (checked === target || checked.includes(target)) {
      // 命中的同时**还**含别的档位：那是歧义读数，不许当成命中（宁可去点一次、拿干净读数）。
      if (!checkedEfforts.some((id) => id !== target)) {
        return { state: 'match', reason: checked === target ? 'checked-exact' : 'checked-includes', seen: checked };
      }
    }
    const otherChecked = checkedEfforts.find((id) => id !== target);
    if (otherChecked) return { state: 'mismatch', reason: 'checked-other:' + otherChecked, seen: checked };
  }
  const seen = normalizeLabel(label);
  if (!seen) return { state: 'unknown', reason: 'no-readback', seen: null };
  /**
   * 从回读文本里取「当前档位」。
   *
   * 三种真机形态都要认得（每一形态都有站点实测，别再收窄）：
   *   ① **锚点 + 后缀**（z.ai `深度思考 最高`、豆包 `豆包 2.1 Turbo专家`）——
   *      剥掉声明锚点后剩下的就是档位。走 `effortFromTriggerLabel`。
   *   ② **整段文本就是一个档位 id**（qwen `自动` / `思考`，其 `triggerText` 也是 `自动`）——
   *      剥离函数按契约返回 null（没有「附加部分」），但这里必须认出「它本身即档位」。
   *      0.19.48 漏了这一形态：qwen 每次选档都抛 THINK_EFFORT_UI_CHANGED。
   *   ③ **无分隔符拼接**（glm `GLM-Flash极致`、`GLM-5.3 极致`）——
   *      模型名与档位黏在一起，`split(' ')` 切不出 `极致`，词级判据失效。必须按
   *      「已知档位是不是这个文本的**后缀**」判。
   *
   * 顺序即优先级：先按词/后缀找**已知档位**（那是最具体的证据），再退回剥离结果。
   * 反过来会先命中剥离结果里的杂字（豆包 `2.1 Turbo专家` 里的 `2.1`）。
   *
   * @returns {string|null} 当前档位文本；读不出返回 null
   */
  const currentEffort = () => {
    // 无空格拼接 / 整段即档位：按「文本以某已知档位结尾」或「恰好等于」判定。
    // 为什么按**后缀**而不是 includes：档位集合里存在互为子串的成员（低 ⊂ 最高），
    // `includes` 会把「最高」在目标「低」时也判成含「低」。后缀只在词尾匹配，不会误伤。
    const bySuffix = knownIds
      .filter((id) => seen === id || seen.endsWith(id))
      .sort((a, b) => b.length - a.length);   // 长者优先：`最高` 胜过 `高`
    if (bySuffix.length) return bySuffix[0];
    // 词级：`豆包 2.1 Turbo专家` 这类空格分隔的拼接
    const words = seen.split(' ').filter(Boolean);
    const byWord = knownIds.filter((id) => words.includes(id));
    if (byWord.length) return byWord[0];
    const stripped = effortFromTriggerLabel(seen, triggerText);
    if (stripped !== null) return stripped;
    // 声明了锚点却对不上、且后缀/词级都没命中 ⇒ 读不出来。
    // ⚠ 这里**不许**放宽成「文本里含目标片段」：kimi 的「快速」既是模型档又是档位词，
    // 按子串判会把「模型名恰好是某个档位」误读成「网页已经是这个档」（0.19.48 的原始教训）。
    return null;
  };
  const extra = currentEffort();
  if (extra !== null) {
    const parts = extra.split(' ').filter(Boolean);
    // 档位命中：**先按词**、再退回子串——中文档位常与别的字黏在一起（豆包「2.1 Turbo专家」、
    // kimi 选中标记「进阶 已选」），只按词会漏。
    //
    // ⚠ 「有没有别的档位」反过来必须**只**按词：档位集合里存在互为子串的成员（低 ⊂ 最高、
    // 高 ⊂ 最高）。按子串判会把「最高」误读成「读到了别的档：高」⇒ z.ai 选「最高」永远
    // 报 mismatch。真机与 `test/think-effort.test.mjs` ③ 各钉一次。
    const hitTarget = parts.includes(target) || extra.includes(target);
    const others = knownIds.filter((id) => id !== target).filter((id) => parts.includes(id));
    if (extra === target || (hitTarget && others.length === 0)) {
      return { state: 'match', reason: extra === target ? 'trigger-extra-exact' : 'trigger-extra-includes', seen };
    }
    if (others.length) return { state: 'mismatch', reason: 'other-effort:' + others[0], seen };
  }
  return { state: 'unknown', reason: 'readback-has-no-known-effort', seen };
}

/**
 * 生成「把网页设成 target 档」的应用计划（纯函数，不碰 DOM）。
 *
 * 计划里每一步都是「要做的事」，不是「怎么做」：驱动按 `kind` 翻译成点击/读属性。
 * 这样「同一档位在哪个控件里」这件事只在本文件里定义一次，驱动只是执行器。
 *
 * @param {object} o
 * @param {string} o.siteId 站点 id
 * @param {string|null} o.target 目标等级 id；null = Default（不动网页，返回 noop 计划）
 * @returns {{kind:'noop',reason:string}|{kind:'popup',steps:Array<object>,target:string,knownIds:string[]}}
 * @throws {Error} 站点未声明等级、或目标 id 不在声明里（都挂 `code = 'THINK_EFFORT_UNKNOWN'`）
 */
export function planEffort({ siteId, target } = {}) {
  const def = thinkEffortFor(siteId);
  // 错误文案一律带 `THINK_EFFORT_UNKNOWN:` 前缀——与 applyEffort 抛出的三个码同形，
  // 运行期可以直接按前缀分类（本仓库的报错纪律：码要能被机读，不能只在 message 里讲故事）。
  const fail = (msg) => {
    const err = new Error('THINK_EFFORT_UNKNOWN: ' + msg);
    withWebcodeCode(err, 'THINK_EFFORT_UNKNOWN');
    throw err;
  };
  if (!def) fail(`站点 ${siteId} 未声明思考等级（think-effort.js 没有它的读数）`);
  if (target === null || target === undefined) {
    return { kind: 'noop', reason: 'default-effort-leaves-web-untouched' };
  }
  const hit = def.efforts.find((e) => e.id === target);
  if (!hit) {
    fail(`站点 ${siteId} 没有思考等级「${target}」（可选项：${def.efforts.map((e) => e.id).join(' / ')}）`);
  }
  const ctl = def.effortControl;
  if (!ctl) fail(`站点 ${siteId} 声明了思考等级但没有控件契约（${target} 无法下发）`);
  const knownIds = def.efforts.map((e) => e.id);
  // `openVia` 与 `triggerSelectors` 的关系（0.19.49 理顺）：
  //   · `openVia` 是「承载档位的弹层在**另一个**弹层里时，先点开那一层」——glm 曾经是
  //     唯一的例子，它下面只有模型弹层这一层，光点触发控件不够。
  //   · `triggerSelectors` 是「触发控件本身」。**有它就不需要 openVia**：直接点它就把
  //     弹层打开了（kimi / qwen / glm 现在都走这条）。
  // 因此当站点只声明了 `triggerSelectors` 时，`openVia` 步骤**不再重复生成**——
  // 否则会「先点开、再找触发、又点一次」把刚打开的菜单关掉（真机症状：menuOpen 恒 false、
  // 档位条目永远取不到）。
  const openVia = ctl.openVia ?? null;
  return {
    kind: 'popup',
    target,
    knownIds,
    control: ctl,
    // openIfClosed：容器上读不到档位文本时，这一步是「打开弹层」而不是「定位控件」。
    // 它同时是豆包那种「触发文本拼了模型名、档位只是后缀」的站点唯一可走的路
    //（见 THINK_EFFORT.doubao 的注释）。
    openIfClosed: ctl.allowEmptyTrigger === true,
    steps: [
      ...(openVia ? [{ op: 'click', how: 'selector-any', selectors: openVia, why: '先打开承载档位的弹层' }] : []),
      {
        op: 'find-trigger',
        how: 'composer-token',
        text: ctl.triggerText ?? null,
        tokens: ctl.triggerText ? [ctl.triggerText] : null,
        selectors: ctl.triggerSelectors ?? null,
        itemLabel: ctl.itemLabel ?? null,
        why: ctl.allowEmptyTrigger === true
          ? '容器上读不到档位文本（触发按钮拼的是模型名）；先看弹层是否已开着'
          : '定位承载档位的控件（或它在弹层里的那一行）',
      },
      { op: 'click', how: 'found-trigger', why: '展开档位菜单' },
      { op: 'click-option', text: target, selector: ctl.optionSelector ?? null, near: 'trigger', why: '选中目标档位' },
      {
        op: 'readback',
        mode: ctl.readback ?? 'effort-text',
        expect: target,
        knownIds,
        // 回读节点随计划一起下发：applyEffort 据此优先读「只持有档位」的那个节点
        // （见 readBack 的注释与各条目的 readbackSelector 依据）。
        ...(ctl.readbackSelector ? { selector: ctl.readbackSelector } : {}),
        why: '回读确认',
      },
    ],
  };
}
