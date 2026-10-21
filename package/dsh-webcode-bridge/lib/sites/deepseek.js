// sites/deepseek.js — DeepSeek 网页版的**站点声明**（`lib/sites/` 迁移的第一个站点）。
//
// ## 这个目录是什么
//
// `lib/sites/<siteId>.js` 的目标形态：**每站点一个文件、导出同一形状的对象**，
// 公共引擎（驱动、解码器、协议）留在各自的模块里。
//
// 它解决的是一个实测过的结构问题（`doc/CODE-STRUCTURE.md` §七 第 1 笔）：
// **站点知识散落在 4 个文件**（`providers.js` / `contract.js` / `decoder.js` /
// `browser-driver.js`），于是「新增一个站点要改 4 处」、「改一处影响所有人」。
//
// ## 为什么是「一个文件一份声明」，而不是「按站点复制代码」
//
// 三条实测理由（完整论证见 `doc/research/2026-09-26-dwb-site-modularity-audit.md` §五）：
//
// 1. **复制在本仓库产生过漂移，而不是隔离。** `ANSWER_SELECTOR` 曾有三份**逐字相同**
//    的字面量，「修一处、忘两处」，判据用的节点与兜底交出去的节点不是同一个。
// 2. **复制会让公共缺陷的修复成本乘以站点数。** 0.19.16 一次修了 4 个解码器族
//    （它们共用基类）；按站点复制会让那一次变成 4 次，且必然漏修。
// 3. **真正提供隔离的是「文件边界」，不是代码副本。**
//
// ## 迁移纪律（写在文件里，因为下一个搬家的人会需要）
//
// · **逐站点迁移，DeepSeek 先行**（它特例最多、收益最大）；其余 9 站继续走
//   `providers.js` 的既有路径，**一行不动**；
// · **行为必须逐字不变**：`test/provider-surface.test.mjs` 钉住对外面
//   （站点表 / provider id / 模型目录 / 分组名），每一次搬家都要跑它；
// · 本文件只放**声明**（数据）。行为仍在 `browser-driver.js` 等公共引擎里——
//   「声明与行为分家」正是要修的那个问题，不要在新文件里把它重建一遍。

/** DeepSeek 的站点声明（`providers.js` 会经 `withEffort` 摊平思考等级后冻结）。 */
export const deepseekSite = {
  // 站点显示名 = **网站自己的原名**（2026-10-03 用户指令：「全部统一成网站原名」）。
  // 它曾被写成「DeepSeek 网页版」——那是「这是一个网页版」的说明，不是站点的名字；
  // 用户看到的就是这一处（`displayName` 也由它派生，于是账户行会显示
  // 「DeepSeek 网页版 (账户2)」）。**只改展示，模型 id / 分组名 / 短键一律不动**。
  id: 'deepseek', name: 'DeepSeek', origin: 'https://chat.deepseek.com',
  // **必须挂在中继根上，不能用自己的子域**（真机 2026-09-13）：DeepSeek 前端
  // 会校验宿主名，`http://deepseek.localhost:8931/` 触发
  // `Unknown hostname: deepseek.localhost`，`#root` 永远 0 个子节点——右栏整页
  // 空白，而它正是唯一端到端可用的基线，回归代价最大。中继根本来就是它
  //（relay 默认站点），根相对资源/SPA 路由天然正确，不需要子域那层隔离。
  mountAtRelayRoot: true,
  // 静态资源域：站点 HTML 用绝对 URL + crossorigin 引用，而该域返回的
  // Access-Control-Allow-Origin 是字面量通配（https://*.deepseek.com，非法值），
  // 浏览器据此硬性拒绝执行脚本，整页退化成「页面资源加载异常」。
  // 这些域改由 lib/mirror.js 同源转发（/__static/<host>/…）。
  staticOrigins: ['https://fe-static.deepseek.com'],
  completionPaths: ['/api/v0/chat/completion'],
  input: 'textarea.ds-scroll-area',
  // 这里**故意不声明 loginProbe**，理由是真机事实（2026-09-13）：
  // DeepSeek 的游客落地页就是登录页本身（镜像里实测停在 `/sign_in`，正文
  // 「+86 发送验证码 / 登录 / 密码登录 …」，`document.querySelectorAll('textarea')`
  // 为 0），而已登录的会话页有 `textarea.ds-scroll-area`。因此「回退输入框判定」
  // 在它身上恰好是准的；再叠一条含「登录」字样的 bad 特征反而容易误伤。
  sendButton: "div[role='button']:has(path[d^='M8.3125'])",
  stopButton: "div[role='button']:has(path[d^='M2 4.88'])",
  attachSelector: "input[type='file']",
  // 附件上传后的可见证据（2026-09-18 补充）。DeepSeek 用构建期哈希类名，
  // 通用类名列表必然零命中。改为宽松选择器：含 webcode/context/markdown 的节点。
  // 主证据仍是文件名本身（filenameEvidence），这只是提速副证据。
  attachPreview: "[class*='file'], [class*='attachment'], [data-file], [data-attachment]",
  decoder: 'deepseek', stream: true,
  // 单一模型入口：桥只暴露一个 DeepSeek（0.19.43 起显示名去掉「（深度思考）」
  // 后缀——组标题已写着站点，能力注记由模型元数据 thinking 表达，不该占名字）。
  // 旧版三 pill（快速/专家/识图）已随 2026-09-10 新版 UI 取消——真机实测
  // model_type 恒为 default，模式差异只剩「深度思考」开关；带图发送同样是
  // default + ref_file_ids，由网页自行路由。因此不再拆成三个模型 id，
  // 带图能力对本模型自动生效（有图就传，无图不受限）。
  models: [
    { id: 'deepseek', name: 'DeepSeek', labels: ['专家模式', 'DeepSeek'], thinking: true, context: 1_000_000, budget: 1_000_000, acceptsImages: true },
  ],

  // ── 能力声明（0.22.0 续：DeepSeek 试点的第 2 步）───────────────────────────
  //
  // ## 为什么要有这一块
  //
  // 此前 `browser-driver.js` 里有 **6 处 `siteId === 'deepseek'` 硬编码**，把它们
  // 读成一句话就是：**DeepSeek 是唯一拥有完整网页 API 能力的站点，其余 9 站全靠 DOM 抓取**。
  // 那 6 处是行为差异，不是形状差异，所以它们搬不进上面那些选择器字段里。
  //
  // 现在把它们降为**声明**：驱动只问「这个站点声明了什么能力」，不再点名站点。
  // 新增站点要补的是一行数据，而不是去改驱动里的 if。
  //
  // ## 边界（不要把这层说大）
  //
  // 这里是**声明式路由**，不是插件系统：值仍然是「用哪条已有代码路径」，
  // 不引入注册表、不加载外部模块、不允许站点自带逻辑。判据是
  // 「同一个判断在驱动里出现两次以上，就该变成声明」。
  capabilities: {
    // 模型选择走哪条实现：`pill` = DeepSeek 专用的三 pill/深度思考开关路径，
    // `picker` = 通用 modelPicker 契约（精确匹配 + 回读确认）。
    // 真机背景：旧三 pill UI 已随 2026-09-10 新版取消，`selectModelDeepSeek`
    // 现在实际只操作「深度思考」开关 + 回读；保留独立实现是因为它的判据
    // 按 UI 代际分叉（见 uiGenerations）。
    modelSelect: 'pill',

    // UI 代际侦测：只有声明了这项的站点才会去跑 `detectDeepSeekUi`。
    // classic = 输入框上方三 pill（≤0.7.2）；unified = 2026-09-10 新版（只有深度思考开关）。
    uiGenerations: true,

    // 网页 API 鉴权令牌在 localStorage 里的键名。null = 该站点没有这套 API。
    // DeepSeek 是 `userToken`（真机 2026-09-13 实测）；其余站点一律走 DOM 抓取。
    tokenKey: 'userToken',

    // 网页 API 能力（会话目录 / 历史消息）。**只有 DeepSeek 声明**。
    // 驱动侧对未声明的站点抛可读错误，而不是静默回空数组——
    // 「读不到」与「确实没有」必须能分辨（本仓库一贯纪律）。
    sessionApi: true,
    historyApi: true,

    // 上下文窗口的**兜底值**（token），只在「模型自己没声明 context/budget」时用到。
    //
    // ⚠ 必须与 `models[0].budget` 相等：同一个数写两处就会漂移，而漂移是静默的
    //（预算闸用一个数、界面显示另一个数）。`test/capabilities.test.mjs` ⑧ 钉住这条相等。
    //
    // 如实边界：11 个站点的模型当前**全部**声明了 context，所以这个兜底在现有站点上
    // 从不执行——它是防御性声明，不是活路径。
    fallbackContext: 1_000_000,
  },
};
