// sites/glm.js — GLM site declaration.
// Keep site facts here; shared browser, transport and decoding behavior belongs to the common engine.

/**
 * GLM 系站点（智谱清言 / Z.ai）向 DSH 声明的上下文窗口（token）。
 *
 * 为什么是 1_000_000 而不是别的数：**这是真机实测出来的下界，不是抄来的规格**。
 * 探针 `test-mock/real-probe-23-glm-budget.mjs` + `real-probe-24-glm-ceiling.mjs`
 *（2026-09-14，有头 Edge + 真实登录态）把 composer 逐档灌满并回读，得到：
 *
 *   1000 → 1000 · 4000 → 4000 · 16000 → 16000 · 32000 → 32000 · 64000 → 64000
 *   128000 → 128000 · 200000 → 200000 · 250000 · 400000 · 600000 · 800000
 *   1000000 → 1000000 · 1200000 → 1200000      ← 全部逐字回读，**没有一档被截断**
 *
 * 即：**网页输入框在 120 万字符处仍未触顶**，所以「输入框容量」从来不是这些站点的
 * 瓶颈（旧注释里把它当成未知数、随手写 1_000_000 当占位，方向就错了）。
 * 按本仓库的估算口径折算，120 万字符 ≈ 92 万 token（旧单价）／≈ 99 万 token
 *（0.19.4 起的三类实测单价 + 10% 余量，中文主体约 0.825 tok/字符）——**两种口径下
 * 1_000_000 都落在或紧贴这个下界**，因此它是「有实测支撑的下界」，不是乐观估计；
 * 但也正因为如此，它**没有余量**：口径一收紧就顶到线。要不要往上调属用户决策。
 *
 * 仍然要说清它不是什么：它**不是模型注意力窗口的规格**——那个数探针测不到（要看
 * 站点服务端的截断行为），并且会随网页改版变化。真实语义是「本桥愿意让 transcript
 * 长到多大」，配合 B-2 的发送前预算闸（`CONTEXT_WINDOW_EXCEEDED`）使用：越界在
 * **发出之前**就是一条可读的报错，而不是发出去被网页静默截半截。
 */
const GLM_CONTEXT_WINDOW = 1_000_000;

export const glmSite = {
  // 站点显示名 = **网站原名**（2026-10-03 用户指令：「全部统一成网站原名」，例：豆包 → Doubao）。
  // 括号里的译名/厂商名是注解不是名字，一律去掉。**只改展示**：模型 id、分组名
  // （`providerGroupName` 走 shortKey/覆盖表）、短键、选择器契约都不受影响。
  id: 'glm', name: 'GLM', origin: 'https://chatglm.cn',
  // sdata.chatglm.cn 是埋点上报域：跨域被拒不影响功能，但会在控制台刷
  // 一片 CORS 错误（真机 52 条）。纳入同源转发后干净且仍能上报。
  staticOrigins: ['https://sdata.chatglm.cn', 'https://at.alicdn.com', 'https://o.alicdn.com', 'https://lf3-data.volccdn.com', 'https://res.wx.qq.com'],
  completionPaths: ['/chatglm/backend-api/assistant/stream'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // ## 0.19.79（用户操作轨迹取证修出）：`attachSelector` 本来就对，**错的是 `attachPreview`**
  //
  // ### 我第一次修错了（留档）
  // 我曾把 `attachSelector` 改成 `input[type='file']:not(.img-input)`，理由是
  // 「0 号 input 上传后没有 blob、1 号有（2 个）」。**那个推理是错的**：1 号的父容器是
  // `head-icon head-icon-isBeta` → 它是**「修改头像」入口**。用户截图铁证
  // （`.tmp/image-verify/glm-input1-*.png`）：上传后弹出「**修改头像**」对话框，
  // 我传的图**变成了用户的账号头像**，根本没进对话框。
  // 已撤回。**教训**：`img[src^='blob:']` 只证明「某个 input 的图被渲染了」，
  // 不证明「它渲染进了 composer」——判据必须落在 **composer 作用域内**（`scoped`）。
  //
  // ### 真机读数（用户亲手操作 + Lead 只读记录，2026-10-15 01:04）
  // 方法：用户按平时习惯在对话框里传图并发送，Lead 用
  // `.tmp/human-trace/human-trace-recorder.mjs` 附着 CDP **只读**记录（不点击/不代操作）。
  // 你传图并正在打字那一刻的快照（`snap`，17:04:42）：
  //
  //   INPUT #0  cls='img-input'  accept='.wbmp,.gif,.jpeg,.png,.jpg,.webp'
  //             inComposer=True   parent='upload-container'      ← **就是它**
  //   INPUT #1  cls=''           parent='head-icon head-icon-isBeta' inComposer=False（头像）
  //   INPUT #2  cls='el-upload__input' parent='el-upload el-upload--text' inComposer=False
  //
  //   IMG cls='limitSize' src='https://t1.chatglm.cn/file/6acfb624869ee90d3c668c8…' 49x49@595,609
  //   ↑ **上传成功后的预览节点**（同一位置先出现 `data:image/png;base64,…`，再换成 CDN 直链）
  //
  // ⇒ **`attachSelector` 的通用回退本来就能选中 `.img-input`（`.first()` 命中它、
  //   `inComposer=True`）——这里是好的，不需要改。**
  //   真正错的是 `attachPreview`：原串 `[class*='file'], [class*='attachment'], [data-file]`
  //   在 GLM 上**一个都不匹配预览节点**（预览是 `img.limitSize`）；
  //   更糟的是 `[class*='file']` 会命中那 **3 个隐藏 `<input type=file>`**（class 含 "file"）
  //   ⇒ 候选计数非 0 却全是不可见 ⇒ `waitForAttachment` 找不到 `visible>0` ⇒
  //   抛 `ATTACH_NOT_CONFIRMED` ⇒ 按 0.19.5 设计**静默降级成纯文本** ⇒
  //   模型回「我没有收到任何图片」（用户和 Lead 都实测到过这句话）。
  //
  // 修法：把真机预览类名 `limitSize` 加进声明（**只加不换**，保留原有条目兼容其它形态）。
  //   `img.limitSize` 落在 composer 作用域内 ⇒ 同时满足 `scoped` 判据，不会重现
  //   「全页 blob 当证据」那类假阳性。
  //
  // ⚠ 注：`.limitSize` 是**阿里系上传组件的通用类名**，但它是本站在 composer 作用域内
  //   的实测命中项；若 GLM 改版后失效，正确做法是**重取轨迹读数**（同一条命令），
  //   不是换个猜的选择器。
  attachSelector: "input[type='file']",
  attachPreview: "img.limitSize, [class*='file'], [class*='attachment'], [data-file]",
  // 助手回复节点选择器（0.19.19，审计 §三 C1 的收口）。
  //
  // 为什么必须有这个字段：在此之前全站共用一个写死 DeepSeek 类名的串
  //（browser-driver 的 ANSWER_SELECTOR），而 chatglm.cn 对它**一个都不命中**
  // ⇒ WIP 巡检的 domFound 恒为 false ⇒ 收束器只能凭「流静默 2.5s」动手，
  // 真机上出现过「正文还没写完就被腰斩」。
  //
  // ⚠️ 诚实标注：下面这串**尚未取得真机命中读数**。2026-09-26 想复采时，
  // 裸 playwright 深链导航会被 chatglm.cn 的阿里云滑块拦（页面变成「滑动验证
  // 页面」，DOM 里只有 capture-container / aliyunCaptcha-*），那批 count=0 的
  // 读数因此**不能**用来判定选择器好坏（取证条件不成立，见 doc/session-2026-09-26
  // §4.3）。
  //
  // 但这条声明**不会比现状更差**，原因是判据三态：命中 → domFound=true（更好）；
  // 不命中 → domFound=false → 走 DOM_BLIND_MS 宽窗（与今天逐字相同）。
  // 也就是说它只有上行空间。`main` 放最后是保底：GLM 的对话容器就是 main。
  answerSelector: 'div.markdown-body, .markdown-body, [class*="answer-content"], [class*="chatglm"], main',
  decoder: 'glm', stream: true,
  // 未登录特征（2026-09-13 真机）：GLM 游客页**自带完整输入框**，旧判定必然把
  // 未登录记成已登录（空 profile 上实测 verify-login 回 true）。它的登录入口
  // 不是 button/a，而是侧栏里的一个叶子节点
  // `<p class="sidebar-user-name">登录</p>`（同层还有 `sidebar-user-desc`
  // 「登录送积分好礼」）——因此只限定 button/a 会漏掉（实测 count=0）。
  // 限定到 p 既命中该节点，又避开「不限定的 :has-text 会命中祖先 div」的老坑；
  // 已登录页此处显示用户名，误判方向也只是「提示去检测」，不会谎报已登录。
  loginProbe: {
    // bad —— 未登录特征（2026-09-13 真机）：GLM 游客页自带完整输入框，旧判定必然把
    // 未登录记成已登录；游客页侧栏叶子节点 `<p class="sidebar-user-name">登录</p>`
    // 是登录入口（同层 `sidebar-user-desc`「登录送积分好礼」）。
    // ok  —— 已登录特征（2026-09-21 真机 probe-glm-ok-feature）：同一节点登录后
    // 变为用户名文本（如 `<p class="sidebar-user-name">RSYHN</p>`），且已登录页
    // 常驻 `.userInfoBar`（用户名 + 积分）。bad 优先命中「登录」文本，ok 命中
    // 「已有用户名」——两向都不再依赖输入框兜底。
    //
    // ⚠ 2026-10-19 曾怀疑第二条裸 `p:has-text("登录")` 过宽（会把含「登录」的
    //   广告 <p> 误判成未登录），一度收窄；随后 **live profile 直读否证**：
    //   已登录页 `bad` 命中 **count=1 / visible=0**（只命中不可见的「退出登录」
    //   p.action-text），judgeLoggedIn 的 bad 分支要求 isVisible ⇒ 不会误判。
    //   那份「4 个可见误命中」来自残缺 profile 副本（拿到的其实是游客页），
    //   证据作废 ⇒ **撤回收窄，保持原值**（仓库纪律：无真机证据不改选择器）。
    bad: 'p.sidebar-user-name:has-text("登录"), p:has-text("登录"), button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    ok: '.userInfoBar, p.sidebar-user-name',
  },
  // 真实昵称/头像（0.19.4）：只声明**已有真机证据**的站点。依据就是上面 loginProbe
  // 的取证原文——「同一节点登录后变为用户名文本（如 `<p class="sidebar-user-name">RSYHN</p>`），
  // 且已登录页常驻 `.userInfoBar`（用户名 + 积分）」。未取证的站点留空，
  // 由 browser-driver 的通用猜测兜底，读不到就回落槽名。
  accountProbe: {
    name: ['p.sidebar-user-name', '.userInfoBar p', '.userInfoBar span'],
    avatar: ['.userInfoBar img', '[class*="avatar"] img', 'img[class*="avatar"]'],
  },
  // 模型选择契约 —— 真机 dump（2026-09-13，test-mock/out/model-dropdown-glm-*.json）：
  //   触发  <div class="think-mode-trigger mode-button …"><span class="think-label">GLM-5.3</span>极致</div>
  //   弹层  <div class="think-mode-item …"> <span class="item-model-box">GLM-5.3</span> …
  //   实测选项：GLM-5.3（selected）/ GLM-Flash（desc「5.3-Flash，回复速度快」）
  //
  // 别拿 `.model-select-container` 当模型入口（probe 首跑点开的就是它）：那是
  // **工具选择器**（联网模式 / Agent / 研究报告 / PPT制作 / 数据分析 / 创意海报 /
  // 网页应用），点它会把会话切进某个 Agent 工具，而不是切换模型版本。
  modelPicker: {
    trigger: ['.think-mode-trigger', '.mode-button'],
    option: '.think-mode-item',
    // 名字节点优先用 .item-name：Flash 条目的结构是
    //   <span class="item-model-box">GLM-Flash<span class="item-new">new</span></span>
    //   <span class="item-name">GLM-Flash</span>
    // —— .item-model-box 的 textContent 被徽章污染成「GLM-Flashnew」，而
    // .item-name 是干净的名字。GLM-5.3 条目没有 .item-name，回退到
    // .item-model-box（它本身就是干净的「GLM-5.3」）。
    // 注意不能用 `.item-model-box:not(.item-new)`：.item-new 是它的**子节点**，
    // 不是同一元素上的类，:not() 排除不掉（真机实测仍然读到 GLM-Flashnew）。
    optionName: ['.item-name', '.item-model-box'],
    // 回读用 .think-label：它同时含模型名与思考档位（如「GLM-5.3极致」），
    // 判定按「包含」即可（见 verify-model-switch 的比较口径）。
    selected: ['.think-label'],
  },
  // 任务模式选择契约（真机读数：`.tmp/live-2026-10-19/glm-mode-calibration.md` + raw3，
  // 以及初盘 `.tmp/live-2026-10-19/mode-inventory.md` §1）：
  //   · chip `.selected-model-info`：当前模式名；**点它展开工具行**（本契约的 trigger）；
  //   · 条目 `.model-select-item`（class 逐字 `model-select-item flex flex-x-between
  //     flex-y-center el-tooltip__trigger`）：展开时可见 5/共 12，文本逐字
  //     `任务 / 研究报告 / PPT制作 / 数据分析 / 更多`；
  //   · 点中后工具行立刻淡出隐藏：`div.model-select-item.selected` 文本=模式名但**不可见**；
  //     条目**无 aria-selected/aria-checked** ⇒ 回读只能靠 `.selected` 文本或 chip 文本
  //     （判据在 browser-driver 的 siteModeVerdict）。
  // 默认空设置 = 不动网页（零位移）；只有 fresh 轮才应用，见 browser-driver 的 planSiteMode。
  // ⚠ 只声明**一个**条目选择器（`option`，驱动唯一读取口径），不再另造 `item` 副本。
  modePicker: {
    trigger: '.selected-model-info',      // 点它展开工具行
    selectedInfo: '.selected-model-info', // 当前模式 chip（回读证据②）
    option: '.model-select-item',         // 模式条目（回读证据①：`.selected` 子集）
  },
  // 未真机校准的站点只给「网页当前模型」入口:桥不宣称具体版本号(网页
  // 模型更新极快,硬编码清单必然过时——2026-09-08 用户实测 GLM 网页已到
  // 5.x,旧目录还在 4.5/4.6)。在右侧网页里手动选模型,桥按当前网页状态对话。
  models: [
    // labels 用网页逐字文本（model-picker 的精确匹配按它比对）：网页上
    // 版本条目显示 GLM-5.3，Flash 条目显示 GLM-Flash。
    { id: 'glm-5.3', name: 'GLM-5.3', labels: ['GLM-5.3'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', labels: ['GLM-Flash'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    // ⚠ 0.19.43 起**真删** auto（原显示名「智谱清言」）。
    //
    // 用户 2026-09-28 判据：「不需要这个自动吧？这个除了网站给的自动，一般都是没有
    // 这个模型档位吧？……这里不是已经让选择了吗？提供网站提供的模型列表就行」。
    // 对这个站点用户是对的：`modelPicker` 契约已声明（见上），网页真实档位就是
    // GLM-5.3 / GLM-Flash 两条，auto 是桥自己发明的「不切换」档，不是网页档位。
    //
    // 历史 id `glm:auto` 仍可解析（ALIASES 里的兼容别名，落到本站点旗舰档），
    // 因为真机 settings.yaml 的 `subagent-model-selection.allowedModels` 里就有
    // 它——从**模型表**里删掉（下拉不再出现）与「旧值仍解析得开」必须同时成立，
    // 与兼容空壳 `webcode` 是同一条纪律。
  ],
,
  navigation: {
    fromUrl: (url) => url.searchParams.get('cid') || null,
    toUrl: (origin, id) => origin + '/main/alltoolsdetail?cid=' + encodeURIComponent(id),
  },
};
