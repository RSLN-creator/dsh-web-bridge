// providers.js — 多站点内容服务注册表。
//
// 受 AgentDock（github.com/agentdock/agentdock）“provider 无关适配器”启发：
// 站点差异全部收口于本文件 + lib/decoder.js；驱动/中继/OpenAI 前端只面向
// {site, model} 二元组，新增一个内容服务 = 在 SITES 里加一个条目。
//
// 未知模型必须拒绝（resolveWebModel throw），绝不允许静默回退默认模型。
// 网页改版核对入口：`pnpm doctor`（test-mock/real-verify.mjs）。

import { DEFAULT_SLOT, normalizeSlot, parseModelId, formatModelId, accountLabel } from './accounts.js';
import { thinkEffortFor } from './think-effort.js';
// 已迁移站点的声明表（0.19.50 起）：`lib/sites/<siteId>.js` 是站点知识的落点，
// 本模块保留**组装职责**（withEffort 摊平 + 冻结）。迁移是渐进的——
// 未迁移的站点仍内联在本文件里，见 lib/sites/index.js 的文件头。
import { siteModuleFor } from './sites/index.js';

const site = (s) => Object.freeze(s);

/**
 * 把 think-effort.js 的站点声明摊进站点对象（`efforts` / `effortControl` 两个字段）。
 *
 * 为什么要有这个包装、而不是直接在站点里抄一份等级表：等级 id 是**网页菜单里的逐字文本**
 * （驱动按文本点），抄第二份必然在下次网页改版时漂移——本仓库的「工具协议只有一处定义」
 * 是同一类约束。因此声明只有 think-effort.js 一份，这里只做摊平。
 *
 * 摊平而不是嵌套 `effort: {...}`：驱动与控制面读 `site.effortControl` 时不必知道本模块的
 * 内部形状（与 `st.captchaSelector` / `st.answerSelector` 这些声明位保持一致）。
 *
 * @param {object} s 站点声明（`models` 之后调用）
 * @returns {object} 冻结后的站点对象（含 efforts / effortControl，未声明等级的站点两者都无）
 */
const withEffort = (s) => {
  const def = thinkEffortFor(s.id);
  return site({
    ...s,
    ...(def ? { efforts: def.efforts, ...(def.effortControl ? { effortControl: def.effortControl } : {}) } : {}),
  });
};

/**
 * 网页会话 URL 契约的三态（C-2）。
 *
 * 背景（真机 2026-09-14 取证）：驱动旧实现把「会话 id ↔ 地址」的知识硬编码成
 * DeepSeek 的两种形状（`?chat_session_id=<id>` 与 `/a/chat/s/<id>`），于是
 * **GLM 永远拿不到会话 id**：探针实录
 *   page.url() = https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77
 *   result.sessionId = null → rememberConversation 从不执行 →
 *   webcode-sessions-glm.json 恒为 "{}"（deepseek 那份 6058 字节）
 * → 每一轮都 WEB_SESSION_LOST → 上层 fresh 重开 → 用户看到「同一会话却每轮新开对话」。
 *
 * 而 GLM 的 SSE 首帧里 `conversation_id` 与 URL 的 `cid` 是**同一个 24 位十六进制
 * 串**（6aa6f08454b3a5a4e4f64a77），即身份一直在，只是没人去读。
 *
 * 三态语义（驱动据此决定导航动作，**不允许静默降级**）：
 *   'fresh'       —— 开新会话（首轮，或上层明确要求重开）
 *   'resume'      —— 该站点声明了地址形状，可以直接导航回既有会话
 *   'unsupported' —— 站点没有可用的地址形状：**必须报错交给上层整段重建**，
 *                    绝不能默默开一个新会话并把增量发进去（那正是历史上
 *                    「跑着跑着变傻」的根因，见 browser-driver 的 WEB_SESSION_LOST）
 */
export const NAVIGATION_STATES = Object.freeze(['fresh', 'resume', 'unsupported']);

/**
 * 从**地址**解析既有网页会话（'resume' 那一态的地址形状），解析不到返回 null。
 *
 * 每个站点只声明**自己的**形状，驱动不再写死 DeepSeek 的两种。新增站点若地址栏
 * 里带会话 id，就在这里加一条；不带（例如只把 id 放在 SSE 帧里）就声明
 * `conversationIdFromStream: true` 并**不**在这里编一个形状出来——
 * 编形状的代价是导航到一个不存在的地址，比不支持更糟。
 */
const CONVERSATION_URL_SHAPES = Object.freeze({
  // DeepSeek：`?chat_session_id=<id>` 与 `/a/chat/s/<id>` 两种（历史形态，勿动）
  deepseek: [
    (u) => u.searchParams.get('chat_session_id'),
    (u) => u.pathname.match(/\/a\/chat\/s\/([0-9a-zA-Z-]{8,64})/)?.[1],
  ],
  // 智谱清言 / Z.ai：`?cid=<24 位十六进制>`。真机 2026-09-14 实录
  //   https://chatglm.cn/main/alltoolsdetail?lang=zh&cid=6aa6f08454b3a5a4e4f64a77
  // 且该 cid 与 SSE 首帧的 conversation_id 逐字相同（见 decoder.js 的 GlmDecoder）。
  // 注意**不能用 `chatglm.cn/main/alltoolsdetail` 这个无 cid 的形态当会话地址**：
  // 那是游客落地页，导航过去等于开新会话。
  glm: [(u) => u.searchParams.get('cid')],
  // kimi：`https://www.kimi.com/chat/<uuid>`（真机 2026-09-27 两轮实录）。
  //
  // ## 为什么必须补这一条（真机读数，不是「顺手加一个」）
  //
  // 补之前 kimi **没有任何地址形状**，于是 `sessionIdFromUrl()` 恒 null ⇒
  // `rememberConversation` 只在流里给 id 时才执行，而真机两轮的 `status().sessionSlot`
  // 与 `conversations` 证明：**这一格是空的**——
  //   `WEB_SESSION_LOST: 会话槽为空（site=kimi，no-stored-session） — 需要整段重建`
  // 后果链与 providers.js 头注里 GLM 那一笔**逐字同构**：每轮都「整段重建」，
  // 用户看到的是「同一会话却每轮新开对话」。
  //
  // ## 为什么这次敢写形状（与 zai 的取舍对照）
  //
  // 判据是「有没有拿到**可导航**的真机证据」，而不是「看起来像」：
  //   · 一轮跑完后 `page.url()` = `https://www.kimi.com/chat/1a0e26b2-8e72-8a5a-8000-09c279d31e8d?chat_enter_method=home`；
  //   · 按该形状 `page.goto('/chat/<同一 uuid>')` 之后，地址**逐字不变**
  //     （`sameId: true`）、页面上读回了只存在于那一轮正文里的标记（`hasOne: true`）
  //     ⇒ 这个形状**真的能导航回既有会话**，不是猜的。
  //   · 反面参照：z.ai 的 `/c/<uuid>` 同样**观察到**了，但 `goto` 被打回根地址、
  //     标记 0 次命中 ⇒ 那条继续维持「不声明」。两条读数的差别就在这里。
  kimi: [(u) => u.pathname.match(/^\/chat\/([0-9a-fA-F-]{8,64})/)?.[1]],
  // zai **故意不在这里**：真机探针（real-probe-25-zai-url.mjs，2026-09-14）在
  // chat.z.ai 上拿到的地址是裸根 `https://chat.z.ai/`（query 键为空、页面里没有
  // 会话链接），而 real-probe-23 在 zai 上跑一轮直接 120s 超时（captureAlive=true、
  // replyChars=0）——**没有取到任何会话地址形状的证据**。
  // 按本项目一贯立场（宁可不切，也不猜着切）：编一个形状出来会让驱动导航到一个
  // 不存在的地址，比「声明不支持 + 让上层整段重建」更糟。zai 因此落在
  // 'unsupported' 态，并由 sessionLostCount / lastSessionLost 如实透出（C-3），
  // 而不是像旧实现那样每轮静默新开对话。取证后续见 doc/long-term-issues.md 第 14 条。
});

/** 由地址构造「导航回既有会话」的地址（'resume' 那一态的逆运算）。 */
const CONVERSATION_URL_BUILDERS = Object.freeze({
  deepseek: (origin, id) => origin + '/a/chat/s/' + encodeURIComponent(id),
  // GLM/Z.ai：`/main/alltoolsdetail?cid=<id>`；lang 交给站点自己补默认值。
  glm: (origin, id) => origin + '/main/alltoolsdetail?cid=' + encodeURIComponent(id),
  // kimi：真机验证过「导航回去仍在同一会话」（依据见 CONVERSATION_URL_SHAPES 的 kimi 条）。
  kimi: (origin, id) => origin + '/chat/' + encodeURIComponent(id),
});

/** 站点是否只从流里拿会话 id（地址栏不给形状）。GLM 两者都有，这里留作扩展点。 */
export function conversationIdFromUrl(siteId, url) {
  const shapes = CONVERSATION_URL_SHAPES[siteId];
  if (!shapes) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const pick of shapes) {
    try { const v = pick(u); if (v) return String(v); } catch { /* 试下一种形状 */ }
  }
  return null;
}

/** 能否直接导航回既有会话：能则返回地址，不能则返回 null（→ 'unsupported'）。 */
export function conversationUrlFor(siteId, origin, sessionId) {
  const build = CONVERSATION_URL_BUILDERS[siteId];
  if (!build || !sessionId) return null;
  try { return build(String(origin).replace(/\/$/, ''), String(sessionId)); } catch { return null; }
}

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

/**
 * DeepSeek 的站点常量（0.19.50 起声明已外移到 `lib/sites/deepseek.js`）。
 *
 * ## 为什么这里只剩一行
 *
 * `lib/sites/<siteId>.js` 迁移的第一站：**站点声明**搬去独立文件，
 * `providers.js` 保留**组装职责**（`withEffort` 摊平思考等级 + 冻结）。
 *
 * 这条分工不是形式主义，它是本目录要修的那个问题本身：原先「站点长什么样」
 * 与「站点怎么被组装进注册表」混在一个 1035 行的文件里、还与 `contract.js` /
 * `decoder.js` / `browser-driver.js` 三处分摊，于是「改一个站点要动 4 个文件」。
 *
 * **行为必须逐字不变**：`test/provider-surface.test.mjs` 钉住对外面
 * （站点表 / provider id / 模型目录 / 分组名），本行搬家前后它都必须是绿的。
 *
 * 未迁移的 9 个站点**刻意保持内联**——迁移是渐进的，见 `lib/sites/index.js`。
 */
export const DEEPSEEK = withEffort(siteModuleFor('deepseek'));

export const GLM = withEffort({
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
});

export const CHATGPT = withEffort({
  id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com',
  completionPaths: ['/backend-api/conversation'],
  input: '#prompt-textarea, textarea[data-id], textarea',
  attachSelector: "input[type='file']",
  decoder: 'chatgpt', stream: true,
  // 未登录特征：游客页可见的 Log in / Sign up 入口。本机网络层对 chatgpt.com
  // 返回 403（WAF），这条判定目前更多是「别谎报已登录」的兜底。
  loginProbe: {
    bad: 'button:has-text("Log in"), a:has-text("Log in"), button:has-text("Sign up"), a:has-text("Sign up"), button:has-text("登录"), a:has-text("登录")',
  },
  models: [
    { id: 'auto', name: 'ChatGPT', labels: ['ChatGPT'], context: 196_000 },
  ],
});

// kimi 的账号身份选择器（**单一真源**，#65）：`loginProbe.ok` 与 `accountProbe`
// 读同一份**证据**，但登录判定只能取其中的**精确子集**。
//
// ## 缺陷现场
//
// `loginProbe` 原先只有 `bad`、没有 `ok` ⇒ 已登录的 kimi 只能落到
// `probe-fallback`（按 #53 三态 = uncertain），面板显示不出「已登录」。
// 同文件 `accountProbe` 早有真机证据：昵称 `span.user-name` = "TYZ0712"、
// 头像 `img.user-avatar`（src 落在 `avatar.moonshot.cn`）。
//
// ## 为什么两处**不**逐字共用同一组（2026-10-19 live 真机读数）
//
//   · `span.user-name`       —— 登录判定 ok 用（live c1v1 命中）；
//   · `img.user-avatar`      —— 登录判定 ok 用（live c1v1 命中）；
//   · `img[src*="avatar.moonshot.cn"]` —— **不得**进 loginProbe.ok：live 读数
//     c3v3，会命中侧栏的插件图标 ⇒ 用它判登录会误报。它只用于**身份打分**
//     （accountProbe.avatar，读不到昵称时靠它找头像）。
//
// 因此常量分层：精确子集（登录判定）与宽集合（身份打分）各一份，宽集合显式
// 引用精确子集，杜绝同一字面量写两遍。
const KIMI_ACCOUNT_NAME_SELECTORS = Object.freeze(['span.user-name']);
// 登录判定用的精确头像选择器（live 真机 c1v1）。
const KIMI_LOGIN_AVATAR_SELECTORS = Object.freeze(['img.user-avatar']);
// 身份打分用的宽集合：精确子集 +头像 CDN 的 src 包含匹配（live c3v3，含插件图标）。
const KIMI_ACCOUNT_AVATAR_SELECTORS = Object.freeze([
  ...KIMI_LOGIN_AVATAR_SELECTORS,
  'img[src*="avatar.moonshot.cn"]',
]);

export const KIMI = withEffort({
  // 2026-09-11 实测：kimi.moonshot.cn 已只剩 302 → https://www.kimi.com/，
  // 镜像按旧域名取页会拿到空跳转壳，右侧栏打不开。改用真实站点。
  id: 'kimi', name: 'Kimi', origin: 'https://www.kimi.com',
  staticOrigins: ['https://statics.moonshot.cn'],
  // 真实流端点带动态会话 id：/api/chat/{id}/completion/stream（Kimi-Free-API 同构），子串匹配。
  // 2026-09-21 真机 CDP 确证：kimi 网页已从旧 SSE **全面迁移到 Connect-RPC**——
  // 发送/回复走 `POST /apiv2/kimi.gateway.chat.v1.ChatService/Chat`（application/connect+json），
  // 响应为二进制帧流 [flags(1)][len(4BE)][json]。旧 /api/chat 端点不再被网页使用，
  // 必须命中新端点并走 connect 二进制帧切分，否则捕获链零回传（页面有回复却超时）。
  completionPaths: ['/apiv2/kimi.gateway.chat.v1.ChatService/Chat', '/api/chat/', '/completion/stream'],
  streamTransport: 'connect',
  // 2026-09-13 真机校准：kimi 网页**没有 textarea**，输入框是 contenteditable
  // 的富文本编辑器（div.chat-input-editor）。旧选择器只有 textarea，输入框
  // 计数恒为 0 → 已登录的 profile 被判成「未登录」，设置页/右栏徽标永远显示
  // 「未登录」，点「检测」也没用（检测走的就是同一个输入框判定）。
  input: 'div.chat-input-editor, div[contenteditable="true"], textarea.chat-input, textarea[placeholder], textarea',
  // 发送控件（2026-09-27 真机取证补上；此前 kimi 走「按 Enter」的默认路径）。
  //
  // ## 为什么必须声明它（带附件的轮次此前发不出去）
  //
  // 真机现场（`.tmp-probe/kimi/lead-send-out.json`，sentinel 探针逐拍读数）：
  //   · 附件上传**完成前**，控件是 `<div class="send-button-container disabled">`；
  //     那一刻按 <kbd>Enter</kbd>，网页**完全不响应**——Enter 后 0.4s / 2.0s 两次采样，
  //     输入框长度恒为 81、地址栏恒为 `https://www.kimi.com/`、附件 chip 恒在；
  //   · `disabled` 类消失后**点它**：输入框立刻变成 1（只剩换行）、chip 清 0、
  //     地址栏切到 `/chat/<uuid>` ⇒ **发送成功**。
  //
  // 也就是说「按 Enter」这条路在 kimi 上从一开始就不可靠，而附件让它**必然**失败
  // （上传窗口内 Enter 无效，旧实现的「点按钮 → 回车 → 再点按钮」全落在窗口内）。
  // 驱动侧配套改动：发送前先等这个控件的 `disabled` 类消失（判据见
  // browser-driver 的 sendReady），而不是等一个固定时长——上传耗时随文件大小变化。
  sendButton: '.send-button-container',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'kimi-connect', stream: true,
  // 未登录特征：游客页有可见的「登录」入口（真机实测未登录镜像页文案为
  // 「登录以同步历史会话」+「登录」）。已登录页这两个入口都消失。
  // 注意必须限定 button/a——不限定的 :has-text 会命中包含该文案的祖先 div，
  // 已登录页的其它节点一旦出现「登录」二字就会误判。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    // ok（#65）：取 `accountProbe` 证据里的**精确子集**——昵称 `span.user-name`
    // 与头像 `img.user-avatar`（live 真机两者均 c1v1 命中）。**不含**
    // `img[src*="avatar.moonshot.cn"]`：该宽串 live c3v3，会命中侧栏插件图标
    // ⇒ 放进登录判定会误报已登录（宽集合只用于身份打分，见上方常量注释）。
    ok: [...KIMI_ACCOUNT_NAME_SELECTORS, ...KIMI_LOGIN_AVATAR_SELECTORS].join(', '),
  },
  // 真实昵称/头像（2026-10-03 真机取证，证据
  // `test-mock/out/account-identity-live-kimi-2026-10-03T17-17-55.json`）：
  //   · 昵称 `span.user-name` = "TYZ0712"（此前靠通用 `[class*="user-name"]` 恰好命中，
  //     现在**显式声明**，不再依赖「类名里恰好含 user-name」这个巧合）；
  //   · 头像 `img.user-avatar`，src 落在 `avatar.moonshot.cn`（score 18，全页最高）。
  accountProbe: {
    name: KIMI_ACCOUNT_NAME_SELECTORS,
    avatar: KIMI_ACCOUNT_AVATAR_SELECTORS,
  },
  // 模型选择契约 —— 真机 dump（2026-09-13，test-mock/out/model-dropdown-kimi-*.json）：
  //   触发  <div class="model-name"><span class="current-effort">进阶</span></div>
  //   弹层  <button role="menuitemradio" class="model-item[ checked]">
  //           <span class="header">K3</span><span class="desc">擅长对话与 Agent 任务，全能旗舰</span>
  //   实测选项（逐字）：快速 / K3 / K3 集群
  //
  // ⚠️ 触发节点的文本是**当前思考强度**（「快速」或「进阶」），不是模型名 ——
  // 触发只能按 class 定位，绝不能按文本「快速」定位（那会随强度档位变化，
  // 也是 probe-model-picker 首跑用 getByText 没抓到模型触发的原因）。
  modelPicker: {
    trigger: ['.model-name', '.current-effort'],
    option: 'button[role="menuitemradio"].model-item',
    optionName: ['.header'],
    // 回读口径②：kimi 的触发按钮只显示「思考强度」（快速/进阶），模型名只在
    // **展开的菜单**里以选中态出现。readbackInMenu 让 picker 重新开菜单读
    // checkedOption 的 .header（即当前选中的模型名）。
    // 真机 verify-model-switch 首跑读到「进阶」，无法判断模型是否真的换了。
    readbackInMenu: true,
    checkedOption: 'button.model-item.checked',
    scopedToComposer: true,
  },
  models: [
    { id: 'k3', name: 'K3', labels: ['K3'], context: 1_000_000, acceptsImages: true },
    // 2026-09-28 真机：菜单第三行是 **K2.8 Preview**（它的模型行读作「快速」是因为
    // 当前档位徽章与名字同字，见 think-effort.js 的 kimi 条目注释）。
    // 同一次读数里 **K3 集群 已从菜单消失**——网页侧把它挪进了「+ 号面板」
    //（菜单顶部横幅原文：「集群功能已移动至+号面板中」），因此模型表**真删**
    // `k3-cluster`：留着它就是一行点了会 option-not-in-list 的死条目。
    // 历史 id `kimi:k3-cluster` / `k3-cluster` 仍由 ALIASES 收敛到 K3（旧会话不断链）。
    { id: 'k2.8-preview', name: 'K2.8 Preview', labels: ['K2.8 Preview'], context: 1_000_000, acceptsImages: true },
    { id: 'quick', name: '快速', labels: ['快速'], context: 1_000_000 },
    // ⚠ 0.19.43 起**真删** auto（原显示名「Kimi」）。理由与 GLM 逐字同构：
    // `modelPicker` 已声明，网页真实档位是 快速 / K3 / K3 集群 三条，auto 是桥自己
    // 发明的「不切换」档。历史 id `kimi:auto` 仍由 ALIASES 解析（见那里）。
  ],
});

export const QWEN = withEffort({
  id: 'qwen', name: 'Qwen', origin: 'https://chat.qwen.ai',
  staticOrigins: ['https://g.alicdn.com', 'https://img.alicdn.com', 'https://assets.alicdn.com'],
  // 浏览器端为 OpenAI 兼容 SSE。2026-09-12 真机：流端点已迁到
  // /api/v2/chat/completions（v2 + completions，含 /api/chat 的旧串不再命中），
  // 子串匹配同时覆盖新旧端点。
  completionPaths: ['/api/chat', '/chat/completions'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // Qwen Studio（2026-09-12 真机）：程序化 Enter 不触发发送（消息停在框里），
  // 发送按钮是稳定特征 class .send-button（aria=发送）——与 z.ai 同类问题。
  sendButton: '.send-button',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'openai-sse', stream: true, experimental: true,
  // 未登录特征（2026-09-13 真机）：qwen 游客页**自带完整输入框**
  // （textarea.message-input-textarea 可见），旧判定「有输入框=已登录」于是把
  // 未登录记成已登录——用户看到的正是「qwen 没有登录却直接显示登录了」。
  // 游客页右上角有可见的「登录 / 注册」按钮，命中即判未登录。
  //
  // ## 0.19.78：`ok` 补 `img.user-img`（真机读数，与 doubao 同型缺陷）
  //
  // 旧 `ok` 是 `.user-avatar, [class*="user-avatar"], [class*="userAvatar"],
  // .header-user-avatar` —— **四条在真机上全部命中 0**（2026-10-14 有头窗口实测）：
  // qwen 登录后的头像元素是 **`<img class="user-img" src="data:image/png;base64,…">`**
  // （在侧栏左下角 `.user-menu-btn-content-left` 里，30x30）。
  // ⇒ 已登录的 qwen 拿不到 `probe-ok`，只能落到 `probe-fallback`（按 #53 三态 = `uncertain`），
  //   面板显示不出「已登录」——**与 doubao 的 #59 是同一条缺陷**（声明与真机元素名不符）。
  //
  // 判据来自同一页面两次对照：**游客壳 `img.user-img` = 0，水合后 = 1**
  // （见 `doc/long-term-issues.md` #62 的时间线表），因此它是可靠的**正向**特征。
  // ⚠ 保留原有四条（别的版本/布局可能仍用 `.user-avatar` 一族），只**追加**不替换：
  //   多一条真机命中的候选只会让判定更准，不会把未登录判成已登录
  //   （`bad` 仍在**前面**先判，且未登录时这些头像元素本就不存在）。
  loginProbe: {
    bad: 'button:has-text("登录"), button:has-text("注册"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    ok: 'img.user-img, .user-avatar, [class*="user-avatar"], [class*="userAvatar"], .header-user-avatar',
  },
  models: [
    { id: 'auto', name: 'Qwen', labels: ['Qwen'], context: 1_000_000 },
  ],
});

// 豆包的账号头像选择器（**单一真源**，#59）：`loginProbe.ok` 与
// `accountProbe.avatar` 必须读同一组字符串。
//
// 缺陷现场（0.19.92 真机读数）：旧 `loginProbe.ok` 是
// `[class*="avatar"], .user-avatar, img[class*="avatar"]` —— **真机命中 0**
// （豆包真实头像的 class 是 `rounded-full object-cover select-none …`，不含
// "avatar" 语义），于是已登录的豆包只能落到 `probe-fallback`（= uncertain）。
// 同文件 `accountProbe.avatar` 早已有真机证据：头像 `<img src="…passport.byteacctimg.com/img/user-avatar/…">`
// 命中 1（36x36 @17,850）。以它为唯一真源，两个字段引用同一个数组，杜绝
// 「两处手写、迟早漂移」。
const DOUBAO_AVATAR_SELECTORS = Object.freeze([
  'img[src*="passport.byteacctimg.com/img/user-avatar"]',
  'img.rounded-full.object-cover.select-none',
]);

export const DOUBAO = withEffort({
  id: 'doubao', name: 'Doubao', origin: 'https://www.doubao.com',
  completionPaths: ['/samantha/chat/completion'],
  // 2026-09-13 真机校准：豆包输入框是 tiptap/ProseMirror 的 contenteditable
  // （div.tiptap.ProseMirror），不是 textarea。旧选择器只有 textarea，驱动侧
  // 定位输入框必然失败。
  input: 'div.tiptap.ProseMirror, div[contenteditable="true"], textarea[data-testid="chat_input_input"], textarea',
  attachSelector: "input[type='file']",
  attachPreview: "[class*='file'], [class*='attachment'], [data-file]",
  decoder: 'doubao', stream: true, experimental: true,
  // 助手回复节点（0.19.89 补声明；真机读数见 long-term-issues #76）。
  //
  // ## 为什么必须声明（补之前它落在 DeepSeek 兜底串上 ⇒ **恒假读数**）
  //
  // 未声明时驱动用 `answerSelectorFor` 的兜底串
  // `.markdown, [data-message-author-role="assistant"], .ds-markdown`
  // ——那是 **DeepSeek 形状**，在 doubao 会话页命中 **0 个节点** ⇒
  //   `replyChars:0` / `selectorHit:false` 是**与页面实际内容无关的恒假读数**。
  // 真机现场（2026-10-17，**只读**导航 + DOM 双证据，零发送）：
  //   页面上**确有一段完整模型回复**（截图可见），而驱动报 `replyChars:0`。
  //   ⇒ 后果不只是日志难看：`browser-driver.js` 的看门狗与「捕获停摆兜底」
  //     都拿这个读数当「页面有没有说话」，于是**网页正常回复也会等到超时**。
  //
  // ## 选择器的依据（逐条只读实测，`test-mock/doubao-answer-precise.mjs` / `-pop-check.mjs`）
  //
  //   · doubao 用 **两个类名族**区分轮次：助手 = `receiveMessage`，用户 = `sendMessage`；
  //     ⇒ 该选择器**只命中助手轮**（实测 3 个可见），**不会**把用户提问读成回复；
  //   · 驱动用 `[...querySelectorAll(sel)].pop()` 取**最后一个**匹配 ⇒
  //     实测读到的是**最后一条助手消息**（150 字，正是那段回复），
  //     且该节点内**不含** `sendMessage` 结构（`hasSendInside:0`）⇒ 判定为助手成立；
  //   · 刻意用 **`[class*="…"]` 属性包含匹配**而不是 `.receiveMessage`：
  //     实测后者命中 **0**（类名是 `receiveMessage` 与一串 Tailwind 工具类**空格分隔**，
  //     `querySelector('.receiveMessage')` 应当也能命中，但真机上确实为 0
  //     ⇒ 以**实测**为准，取包含匹配）。这是「选择器必须来自真机读数」那条纪律的一次应用。
  //
  // ⚠ 与 zai / glm 的答案不同是**正常的**：那两家的容器类名完全不同
  //（zai=`div.chat-assistant`；glm=`div.markdown-body` 一族）。本条**只**服务 doubao。
  answerSelector: '[class*="receiveMessage"]',
  // 未登录特征：游客页有可见的「登录」按钮；登录后该按钮消失。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    // ok（#59）：与 `accountProbe.avatar` **同源**（见上方 DOUBAO_AVATAR_SELECTORS）。
    // 旧值三条在真机上全部命中 0 ⇒ 已登录豆包恒为 probe-fallback（不确定）。
    ok: DOUBAO_AVATAR_SELECTORS.join(', '),
  },
  // 真实昵称/头像（2026-10-03 真机取证，证据
  // `test-mock/out/account-identity-live-doubao-2026-10-03T17-17-55.json`）。
  //
  // 豆包的用户区在**侧栏左下角**，是一行「36×36 圆头像 + 昵称」：
  //   · 头像 `<img class="rounded-full object-cover select-none mr-8 h-36 w-36"
  //           src="https://p26-passport.byteacctimg.com/img/user-avatar/…">`
  //           —— 落点是**账号头像 CDN**（`passport.byteacctimg.com/img/user-avatar`），
  //           不是站点自己的素材域，因此这条既能锚定账号头像、又不会误抓站点图标；
  //   · 昵称是头像**右侧那个兄弟** `<span class="min-w-0 overflow-hidden text-left …">`
  //     （真机读数里它的文本就是该账号的昵称）。
  //
  // ⚠ 两个都**不含**「user / avatar / nickname」任何语义词，所以通用猜测一律读不到
  //（这正是用户报的「豆包没用上真实账户名」的真因）；必须显式声明。
  // ⚠ 昵称那条用的是 Tailwind 工具类组合，属于「次优但有真机读数」的选择器——
  // 若豆包改版后读不到，先重跑 `node test-mock/probe-account-identity-live.mjs doubao`
  // 取新读数再改，**不要凭印象换一个**（本项目纪律：选择器必须来自真机读数）。
  accountProbe: {
    name: ['span.min-w-0.overflow-hidden.text-left'],
    avatar: DOUBAO_AVATAR_SELECTORS,
  },
  // 模式选择契约 —— 真机 dump（2026-09-13，test-mock/out/doubao-mode-*.json）：
  //   豆包的「对话 / 工作」是常驻在输入框附近的**分段控件**（不是弹层）：
  //     容器 <div class="relative flex h-54 items-center justify-center rounded-full p-[3px] bg-dbx-fill-trans-20 mt-20">
  //       选项 <button class="… w-160 … text-dbx-text-primary">  <span class="truncate">对话</span>
  //            <button class="… w-160 … text-dbx-text-secondary"><span class="truncate">工作</span>
  //
  // ⚠ 2026-09-28 更正一条**曾经写错的事实**：本注释原先写着「豆包没有下拉式模型选择器」。
  // 真机读数（`test-mock/out/think-control-doubao-2026-09-28T10-36-23.json`）证明它有，
  // 而且是**两个独立的控件**：
  //   · 分段控件 「对话 / 工作」                     —— 本 modelPicker 契约管它；
  //   · 模型下拉 `[data-testid="chat_input_action_model"]` 显示「豆包 快速」/ 点开是
  //     「豆包 快速」「豆包 2.1 Turbo专家」两条      —— 用户原话里的「左下角有模型和
  //     思考等级选择」，走 think-effort.js 的 doubao 条目（档位 = 徽章 快速/专家）。
  // 两者是**两个契约、两条链**，不共用选择器，也不互相覆盖。
  modelPicker: {
    segmented: true,
    option: 'div.bg-dbx-fill-trans-20.rounded-full > button, button.w-160',
    optionName: ['span.truncate'],
    selectedStateClass: 'text-dbx-text-primary',
    unselectedStateClass: 'text-dbx-text-secondary',
  },
  models: [
    // 本地默认：**对话**（豆包标准对话模式）。放在最前即首选。
    // 具体用到哪一档模型/档位由 think-effort.js 的 doubao 条目下发（快速 / 专家）。
    { id: 'chat', name: '对话', labels: ['对话'], context: 256_000, acceptsImages: true },
    { id: 'work', name: '工作', labels: ['工作'], context: 256_000, acceptsImages: true },
    // ⚠ 0.19.43 起**真删** auto（原显示名「豆包」）。理由与 GLM/Kimi 同构：
    // modelPicker 的 segmented 契约已声明，网页真实档位是 对话 / 工作 两个模式。
    // 历史 id `doubao:auto` 仍由 ALIASES 解析。
  ],
});

export const GROK = withEffort({
  id: 'grok', name: 'Grok', origin: 'https://grok.com',
  completionPaths: ['/rest/app-chat/conversations/new'],
  input: 'textarea[aria-label], textarea',
  attachSelector: "input[type='file']",
  decoder: 'grok', stream: true,
  // 未登录特征（2026-09-13 真机）：游客页有可见的「登录 / 注册」，且自带输入框
  // （空 profile 上实测 verify-login 回 true）。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Sign up"), a:has-text("Sign up")',
  },
  models: [
    { id: 'auto', name: 'Grok', labels: ['Grok'], context: 256_000 },
  ],
});

export const CLAUDE = withEffort({
  id: 'claude', name: 'Claude', origin: 'https://claude.ai',
  completionPaths: ['/api/append_message'],
  input: 'div[contenteditable="true"], textarea',
  attachSelector: "input[type='file']",
  decoder: 'claude', stream: true,
  // 未登录特征：游客页可见的 Sign in / Log in。claude.ai 对本机返回 403
  //（地区受限），这条同样是「别谎报已登录」的兜底。
  loginProbe: {
    bad: 'button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in"), button:has-text("登录"), a:has-text("登录")',
  },
  models: [
    { id: 'auto', name: 'Claude', labels: ['Claude'], context: 200_000 },
  ],
});

// z.ai（智谱 GLM 的**国内站 zchat.z.ai**）：与 chatglm.cn 同源模型、不同前端。
//
// ⚠ 2026-10-19 用户明令 + 真机证据：国内访问 chat.z.ai 会被地区弹窗拦截
//（「请切换至中国站点 zchat.z.ai」，0.19.96 E2E 逐字读数），且该弹窗在 effort
// 控件之前就把页面挡住——继续拿 chat.z.ai 当 origin 等于让 z.ai 永远不可用。
// 因此 origin 改为 **https://zchat.z.ai**（中国站，用户要求用这个）；`id` 仍是
// `zai`（模型 id / 会话 / 账户槽 / profile 全部不变，登录态沿用同一份 profile）。
// 浏览器端为 OpenAI 兼容 SSE（/api/chat/completions），故复用 'openai-sse'
// 解码器；选择器用「特征选择器」而不是站点版本 class（改版频繁，特征更稳）。
export const ZAI = withEffort({
  id: 'zai', name: 'Z.ai', origin: 'https://zchat.z.ai',
  // 选择器里显示的站点键。默认等于 id，只有这里不同：站点的真实身份就是
  // 「z.ai」这个域名（用户要的正是「一眼看出是哪个网站」），而 `zai` 只是
  // 我们内部的路由 id。二者不同不影响解析——解析只认 id（见 resolveWebModel）。
  shortKey: 'z.ai',
  // 静态资源域：z.ai 的前端包/字体放在独立域上，跨域 + 非法 ACAO 会被浏览器
  // 拒绝执行（与 DeepSeek 同一类问题）。纳入同源转发（lib/mirror.js）。
  // api.z.ai 是前端调后端的绝对域（真机 probe-net 实测），不代理则页面提示
  // 「无法连接到服务」。
  staticOrigins: ['https://z-cdn.chatglm.cn', 'https://api.z.ai'],
  // 镜像页需要看到根路径（真机证据 2026-09-13）：
  // z.ai 的前端 router 只认根路径。同一个镜像挂在 /__webcode/site/zai/ 下时，
  // 它的错误边界会渲染「200: An unexpected error has occurred.」——接口全部
  // 200 + 正确 JSON，纯粹是路由基线不匹配；把 pathname 改写成 '/'（其余资源
  // 已由镜像改写成带前缀的绝对路径，运行时根相对请求由 bootstrap 钩子补前缀）
  // 后立刻恢复成正常界面（输入框出现）。GLM 不需要这个开关。
  rootPathForSpa: true,
  // ⚠ 2026-10-14 真机更正：真机 completion 打到 **`/api/v2/chat/completions`**，
  //   而原声明只有 v1 与无版本两条 ⇒ **缺 v2**。逐字读数（那一轮 summary.network）：
  //     `RES 200 text/event-stream; charset=utf-8
  //      https://chat.z.ai/api/v2/chat/completions?timestamp=…&requestId=…`
  //   这条漏声明是**静默**的：捕获层按声明匹配 ⇒ 一个块都接不到，而页面正常渲染。
  completionPaths: ['/api/v2/chat/completions', '/api/v1/chat/completions', '/api/chat/completions'],
  input: 'textarea#chat-input, textarea[placeholder], textarea',
  // z.ai 对程序化 Enter 不响应，必须点发送按钮（真机 2026-09-12：轮次静默挂死正因如此）。
  sendButton: '#send-message-button',
  attachSelector: "input[type='file']",
  // 附件落到页面上的可见证据（上传确认用，见 browser-driver 的 waitForAttachment）
  attachPreview: "img[src^='blob:'], [class*='attachment'], [class*='file-card']",
  // 助手回复节点选择器（0.19.19 的契约位；2026-09-27 真机实测改写）。
  //
  // ## 旧值为什么必须换掉（真机读数，不是推断）
  //
  // 夹具 `test/fixtures/zai-real-dom/zai-chat-dom-inventory.json` 是真机会话页面的
  // 293 个元素的逐字清单（tag/class/id/父索引/innerText 长度，消息 uuid 已脱敏）。
  // 在它上面复算旧值的命中集合是**逐条可核**的（下表每行只写标签名与命中数，
  // 完整选择器见上一行）：`div.markdown-body` 与 `.markdown-body` 各 **0** 次
  // （z.ai 页面上没有这个 class），`[class*="prose"]` **2** 次（#151 用户消息
  // 53509 字、#172 助手轮容器 0 字），`[class*="message"]` **4** 次
  // （#148 用户轮外壳、#160 编辑按钮、#168 助手轮外壳，以及
  // **#184 div.w-full.messageInputContainer.font-primary（输入框容器）**），
  // `main` **0** 次（页面上根本没有 main 元素）。
  // 驱动的读取语义是 `[...querySelectorAll(sel)].pop()` = **文档序最后一个**命中节点。
  // #184 是输入框容器，且它排在 #172 之后 ⇒ 旧值的最后一次命中恒为它，innerText 恒为
  // 「深度思考\n最高」= **7 字**。三处独立读数逐字吻合：
  //   · 夹具复算：`.pop()` = #184，chars=7；
  //   · 落地页（无会话）实测：命中 1 个节点，就是它，7 字；
  //   · 事故轮次 240s 超时现场：驱动报 `replyChars: 7`。
  // 也就是说 `WEB_NO_PROGRESS … 页面已有 7 字回复未回传` 里的「7 字回复」**从来不是回复**，
  // 是输入框容器的 innerText。按本项目纪律（报错必须指向真因），这条假读数比没有读数更贵：
  // 它把排查方向引向「解码器对不上」，而真因在别处（见下一条 decoder 注释）。
  // 危害不止于日志：它让 `answerSelector` **恒定命中**且文本恒定 7 字 ⇒
  // ① `domFound` 恒真、`lastDomGrowthAt` 永不刷新（「页面还在长 → 绝不动」这道保护对 zai 是死的）；
  // ② 捕获停摆兜底（captureStallRescueMs）拿到的「页面正文」就是这个输入框容器文本，
  //    一旦 `domTextChanged` 成立，桥会把「深度思考\n最高」当成本轮回答交给上层。
  //
  // ## 新值的依据（同一夹具的真机读数）
  //
  // #151 是用户消息节点（`div.chat-user … markdown-prose`，chars=53509）；
  // #172 是助手轮容器（`div.chat-assistant … markdown-prose`，chars=0）；
  // #174 是它的子节点响应正文区（`div#response-content-container`，chars=0）。
  // 新值命中 2 个（#172、#174），`.pop()` = #174，chars=0 —— 即「页面确实什么都没说」，
  // 如实报 0，而不是 7。
  // `div.chat-assistant` 与 `#response-content-container` 都是**语义特征**（前端用来标记
  // 「这一轮是谁说的 / 响应正文放哪」），不是 `.svelte-xxxx` 那种编译期哈希——与
  // `div.chat-user` 同族，改版时更稳。两个都留：`#response-content-container` 更靠内
  // （读到纯正文，不带助手轮外壳文案），`div.chat-assistant` 是它的父级兜底，
  // 于是「外壳在、正文区还没挂上」时也不会退化成读不到任何节点。
  //
  // ## ⚠ 这一改**不会**让 z.ai 变成可用——真正的拦路虎不在选择器
  //
  // 2026-09-27 真机四轮复现（headless×3、headed×1，全部 0 帧）：**completion 请求根本没发出去**。
  // 站点自带前端（z-cdn.chatglm.cn/z-ai/frontend/prod-fe-1.1.96/assets/index-p_7VciLU.js）
  // 逐字写着这条闸门：站点特性里 `enable_captcha` 为真时，前端会先 await 一次
  // 阿里云验证（`HN()`）拿到 `lc`，再把它传给发请求的 `bhe()`；`bhe` 内部才是
  // fetch `…/api/chat/completions`。自动化环境下那次 await **停在页面上不返回**，
  // 于是 `bhe` 永不执行；同页 `#chat-captcha-element`、`#chat-captcha-trigger` 可见，
  // 滑块窗口在 headless 轮次里带 `window-show` 全显。
  // ⇒ 本文件的 decoder/completionPaths **都不是**本轮失败的原因，别在这里找。
  answerSelector: 'div.chat-assistant, #response-content-container',
  // 风控闸的**可见证据**（声明位；读取与判定的接线在 lib/browser-driver.js，见下）。
  //
  // 为什么需要它：本轮失败的报告是 `WEB_NO_PROGRESS: 网页侧超过 120s 没有任何新内容
  // （… 页面已有 7 字回复未回传）`——用户等满 240s，读到的却是一句由假读数拼出来的
  // 归因（见 answerSelector 的长注释）。而真因在页面上一眼可见。驱动应当在**发送后**
  // 周期性检查这个选择器；命中且可见时立刻抛一条可读错误（建议 code
  // `WEB_CAPTCHA_REQUIRED`，文案里带上「站点弹出了滑块/人机验证，请在弹出的窗口里
  // 手动通过后重试」），**不要**继续等 120s/240s 的看门狗。
  //
  // 真机读数（本轮，`shown` = offsetWidth||offsetHeight||getClientRects().length）：
  //   · 发送前（落地页，probe-zai-resume-shape.mjs）：`[id*=captcha],[class*=captcha]`
  //     查询命中 **0 个节点** —— 即这些节点不是常驻的，可以做触发器；
  //   · 发送后 headless（probe-zai-chat-frames.mjs）：`#chat-captcha-element`、
  //     `#chat-captcha-trigger` 可见，且 `#aliyunCaptcha-window-popup.window-show` 整窗可见；
  //   · 事故页面（live-cdp/dom-inventory.json #269/#270/#272）：同上，`window-show`。
  // ⚠ 如实标注两处局限：
  //   ① 「发送前不存在」只有**落地页**那一条读数；一次**成功**轮次里这些节点长什么样
  //      **没有读数**（本轮没有任何一次成功轮次）。所以判定必须带**可见性**，
  //      且失败方向上宁可漏报也不能把正常轮次判死——建议只在**发送后**检查，
  //      并在命中时如实写进 navTrace/诊断，而不是当唯一判据。
  //   ② 有头轮次里滑块窗口未显（只有 `#chat-captcha-element`/`#chat-captcha-trigger` 可见），
  //      所以**不能**只认 `#aliyunCaptcha-window-popup`，否则会漏掉那一种形态。
  captchaSelector: '#chat-captcha-element, #aliyunCaptcha-window-popup.window-show',
  // ✅ decoder 已落地（2026-10-14）：**真机帧已取得**，`decoder: 'zai'`（`lib/decoder.js` 的
  // `ZaiDecoder`）。此前长期挂「没有 wire 证据 ⇒ 刻意不改」，理由是「已知解不出好过猜着解不出」。
  //
  // 真机帧逐字夹具：`test/fixtures/zai-real-frames/zai-chat-2026-10-14.txt`（护栏
  // `test/zai-decoder.test.mjs`）。线上形状（每个事件一行，**不是** OpenAI 的 choices）：
  //   data: {"type":"chat:completion","data":{"delta_content":"…","phase":"thinking"}}
  //   data: {"type":"chat:completion","data":{"phase":"other","usage":{…}}}
  //   data: {"type":"chat:completion","data":{"delta_content":"你好呀","phase":"answer"}}
  //   data: {"type":"chat:completion","data":{"phase":"done","done":true}}
  //
  // 先前**只有**站点 bundle 的代码证据（帧处理器 di 的解构 `{id, done, content, delta_content,
  // …phase…}`），当时据此推断的形状**方向正确**：正文/思考都在 `delta_content`、靠 `phase` 分流、
  // 收尾看 `done`；`choices` / `parts` / `reasoning_content` 在该 bundle 里均为 0 次
  // ⇒ 既不是 `choices[].delta.content`（OpenAISseDecoder）也不是 `parts[].content[].type`
  // （GlmDecoder）——「z.ai 用 GLM 帧」这条假设**被推翻**（现由真机帧确认）。
  //
  // 真机帧还改正了本条目**另一处**声明缺陷：`completionPaths` 原缺 `/api/v2/…`（见上方注释）。
  //
  // ⚠ 取证步骤的落点（2026-10-14 改正）：本条原先把读者指向 `.tmp-probe/zai/RESULT.md`，
  // 而 `.tmp-probe/` 被 `.gitignore:61` 覆盖 ⇒ **对克隆仓库的人不存在**。而那句话说的不只是
  // 「读数在那里」，是「**确切步骤**在那里」——即离开它就无法重跑，正是 `wiki/protocol.md` §5
  // 禁止的形态。步骤与探针已入库：
  //   · 步骤 → `doc/runbooks/zai-capture-frames.md`
  //   · 探针 → `test-mock/zai-capture-frames.mjs`（`PROBE_HEADED=1`，需人工过一次滑块）
  // 另：本条原先写「见 doc/long-term-issues.md 第 14 条」，**条号是错的**——第 14 条是
  // 「Z.ai 没有会话地址形状」（0.19.52 已收口）；帧格式的登记条目是 **§30**。
  decoder: 'zai', stream: true, experimental: true,
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("登录"), button:has-text("Sign in"), a:has-text("Sign in")',
    ok: '.user-avatar, [class*="avatar"], button[aria-label*="User"]',
  },
  // 模型选择契约 —— 全部来自 probe-model-dropdown.mjs 的真机 dump
  //（2026-09-13，证据 test-mock/out/model-dropdown-zai-*.json）：
  //   触发  <button class="modelSelectorButton" aria-label="选择一个模型">GLM-5.3-Flash</button>
  //   弹层  <button aria-label="model-item"> … <div class="line-clamp-1">GLM-5.3</div> …
  // 实测选项（逐字）：GLM-5.3-Flash / GLM-5.3 / GLM-5.2
  //
  // 注意 "GLM-5.3" 是 "GLM-5.3-Flash" 的**前缀** —— 这正是 model-picker 必须做
  // 精确名匹配、不能做前缀匹配的原因（0.12.9 的 getByText 启发式会选错模型）。
  modelPicker: {
    trigger: ['button.modelSelectorButton', '[aria-label="选择一个模型"]'],
    option: "button[aria-label='model-item']",
    optionName: ['.line-clamp-1'],
    selected: ['button.modelSelectorButton'],
  },
  models: [
    { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', labels: ['GLM-5.3-Flash'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.3', name: 'GLM-5.3', labels: ['GLM-5.3'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    { id: 'glm-5.2', name: 'GLM-5.2', labels: ['GLM-5.2'], context: GLM_CONTEXT_WINDOW, budget: GLM_CONTEXT_WINDOW, acceptsImages: true },
    // ⚠ 0.19.43 起**真删** auto（原显示名「Z.ai」）。理由与 glm 逐字同构：
    // modelPicker 已声明，网页真实档位就是 GLM-5.3-Flash / GLM-5.3 / GLM-5.2 三条。
    // 历史 id `zai:auto` 仍由 ALIASES 解析（它与 `glm:auto` 是两条不同的别名，
    // 各自收敛到**本站点**的档位，不许互相串站点）。
  ],
});

// Gemini 的 RPC 流不是稳定契约 — 用 DOM 终态抓取兜底（decoder: 'dom'）。
export const GEMINI = withEffort({
  id: 'gemini', name: 'Gemini', origin: 'https://gemini.google.com',
  completionPaths: [],
  input: 'div.ql-editor[contenteditable="true"], div.ql-editor, rich-textarea textarea, textarea, div[contenteditable="true"]',
  attachSelector: "input[type='file']",
  decoder: 'dom', stream: false, experimental: true,
  // 未登录特征：gemini 游客页有可见的「登录」按钮（.signed-out-buttons 内），
  // 登录后换成账号头像。旧判定只看输入框，游客页的 ql-editor 让未登录被记成
  // 已登录（真机 2026-09-13：verify-login 报 true，页面却明写「登录」）。
  loginProbe: {
    bad: 'button:has-text("登录"), a:has-text("Sign in"), button:has-text("Sign in"), button:has-text("Log in"), a:has-text("Log in")',
  },
  models: [
    { id: 'auto', name: 'Gemini', labels: ['Gemini'], context: 1_000_000 },
  ],
});

/** 全部内容服务（顺序即 OpenAI /models 列表顺序）。 */
export const SITES = Object.freeze([DEEPSEEK, GLM, CHATGPT, KIMI, QWEN, DOUBAO, GROK, CLAUDE, GEMINI, ZAI]);

/**
 * 选择器里显示的模型名 = `站点短键/模型 id`（0.14.0）。
 *
 * 为什么不是只写模型名：DSH 的模型选择器**只渲染 model.name**，不拼 provider
 * （见 dsh-client-ui-model-selection 的 option 渲染）。旧目录里 8 个站点都叫
 * `auto`，选择器上就是一串分不清出处的「ChatGPT / Qwen / Grok」；而 `glm-5.3`
 * 这种名字同样看不出是 chatglm.cn 还是 z.ai。带上站点短键后，每一行都自带
 * 出处，且与 id 一一对应（`z.ai/glm-5.3` ↔ id `zai:glm-5.3`）。
 *
 * 注意这**只是显示名**：id 仍是 `site:model`，别名表、历史设置值、会话游标、
 * 路由全部不动。
 *
 * 0.14.7（同站多账户）追加一条：显示名后面可能跟 `(账户N)`。
 * **默认槽不跟** —— 见 accounts.accountLabel 的注释，默认槽的显示名必须与 0.14.6
 * 逐字相同，否则既有用户的下拉里会凭空多出他们没配置过的东西。
 */
export function modelDisplayName(st, m, slot) {
  return accountLabel(st.shortKey || st.id, slot) + '/' + m.id;
}

/**
 * 兼容别名 id 集合（0.14.0）。
 *
 * `deepseek-web` 是不带站点前缀的历史 id（旧版 OpenAI 前端与旧会话用它），
 * 它与 `deepseek:deepseek` 指向**同一个**模型，因此显示名逐字相同。若把它照
 * 单渲染，选择器上会出现两行一模一样的 `deepseek/deepseek`——用户看到的就是
 * 「下拉里有重复项」。
 *
 * 因此：**列表接口仍返回它**（历史会话、`agent-default-model` 的旧值、OpenAI
 * 前端的 `model: 'deepseek-web'` 都依赖它解析），但**选择器下拉过滤掉它**。
 * 这份集合是「哪些是别名」的唯一定义处：UI（client.cjs）、适配器
 * （index.js listModels）与测试都必须从这里取，不许各自再写一份字面量。
 */
export const MODEL_ALIAS_IDS = Object.freeze(new Set(['deepseek-web']));

/**
 * **唯一注册的 provider id = `webcode`**（0.19.53，用户指令：「放一起、不要按站点隔开」）。
 *
 * ## 为什么是「一个 provider 装全部站点」
 *
 * DSH 模型选择器的分组**唯一来源**是 `ctx.llm.listProviders()`：**一个 provider
 * 就是一组**（实读 `dsh-api-session-controller/lib/types/catalog.js:38`
 * `{ id: provider.id, name: provider.name, models: entries }`）。
 *
 * 0.19.28 曾反其道而行——给每个站点注册一个 `webcode-<siteId>`，让下拉里出现
 * 「一个网站一层」。2026-10-02 用户明确要求反转：站点不再各占一层，全部模型
 * 归到**一个组**下。
 *
 * ## ⚠ 目录契约**不支持**「组内再分子组」——这一条决定了行名必须带站点
 *
 * 宿主模型行只有 `{ id, name, description?, inputModalities? }` 五个字段
 *（`dsh-llm/lib/types/types.d.ts:304` 的 `LlmModelInfo`），运行时还过一道
 * 白名单重建（`dsh-llm/lib/index.js:2076-2087`）。**没有** `group` / `category`
 * / `family` / `tag` 任何一项（宿主全树检索均无消费方）；「思考等级」是模型行
 * 上**自带的** `reasoning`，渲染成另一条独立 pane 而非子组
 *（`dsh-client-ui-model-selection/lib/client.js:899`、:1031）。
 *
 * 因此合并成一组后，区分「这行属于哪个网站」**只能靠行名本身**。这不只是美观
 * 问题：glm 与 z.ai **有同名模型**（`glm-5.3`），同组平铺下裸名 `GLM-5.3` 会
 * 出现两次且无法分辨——那正是 `modelDisplayName` 当初把站点短键塞进名字里的
 * 原因（见其注释）。所以组内行名回退到带站点的形态，见 `modelGroupEntryName`。
 *
 * ## 站点 id 不再注册（用户明确接受代价）
 *
 * `webcode-<siteId>` 这 10 个 id **不再注册**。它们曾经写进过每个会话的
 * `subagentModelSelectionPolicy`（真机读数：`~/.dsh/storages/session_projcache/`
 * 里 kimi 94 / zai 90 / glm 67 / doubao 60 次…）。
 *
 * ⚠ **代价必须说清，且与旧注释口径不同**：宿主里**没有** `routeServed` 这个函数
 *（全树 0 命中）。发消息前的真判据是 `requireModel` → `modelAvailable`
 *（`dsh-api-session-controller/lib/index.js:900` + `lib/types/catalog.js:67`），
 * 它要求 `listProviders().some(id)` **且** `listModels().some(model)`。
 * 所以「注册了但 listModels 为空」只保证**不抛 NO_ADAPTER**，**不能**保证继续
 * 发消息——旧注释里「旧会话照旧可跑」那句是错的，本次一并修正。
 *
 * 不注册站点 id ⇒ 存量里那批 `webcode-kimi` 等值**会**失效。这是用户明确接受的
 *（「我不需要旧，我只要新版的」），配套动作是把 profile 配置里的白名单改写为
 * `webcode`，让源头不再写回旧值。解析侧仍保留 `siteIdForProvider()`：它是
 * **纯函数**，用于诊断与模型归属判定——不注册不等于不认识。
 */
export const MODEL_PROVIDER_COMPAT_ID = 'webcode';

/**
 * 站点 id → 历史 provider id（`webcode-glm` 这类）。
 *
 * ⚠ **这些 id 已不再注册**（见 MODEL_PROVIDER_COMPAT_ID 的说明）。本函数仅供
 * 诊断、报错文案与存量识别使用——它回答「这个字符串指的是哪个站点」，
 * **不**承诺该 provider 仍被服务。
 */
export function providerIdForSite(siteId) {
  return MODEL_PROVIDER_COMPAT_ID + '-' + String(siteId);
}

/** provider id → 站点 id；不属于本站点的 provider 一律 null（不猜、不回落）。 */
export function siteIdForProvider(providerId) {
  const prefix = MODEL_PROVIDER_COMPAT_ID + '-';
  const id = String(providerId ?? '');
  if (!id.startsWith(prefix)) return null;
  const siteId = id.slice(prefix.length);
  return SITES.some((s) => s.id === siteId) ? siteId : null;
}

/** 组名覆盖表（见 providerGroupName 注释）。值必须是用户可读的真实站点域名。 */
const PROVIDER_GROUP_NAME_OVERRIDES = Object.freeze({ glm: 'chatglm' });

/**
 * 站点在其**唯一组**里的可读键（`glm` / `z.ai` / `chatglm`…）。
 *
 * 与旧 `providerGroupName` 的唯一区别是**不再带 `webcode-` 前缀**：那个前缀的
 * 作用是「在多组并列时标明这些组都来自网页桥」，而现在只有一组，前缀就是噪音。
 *
 * GLM 走覆盖表给 `chatglm`：它的站点 id 是 `glm`，而真实域名是 chatglm.cn；
 * z.ai 的 shortKey 本来就是域名，直接可用。
 *
 * ⚠ **为什么不动 shortKey**：那个字段同时决定模型 id 前缀、历史设置值、
 * 设置页站点名与 `test/model-labels.test.mjs` 的一批断言。只有「组标题/
 * 组键」这一处需要覆盖，改 shortKey 会让上面几样一起漂移。
 */
export function providerGroupName(siteId) {
  const st = SITES.find((s) => s.id === siteId);
  if (!st) return String(siteId);
  const override = PROVIDER_GROUP_NAME_OVERRIDES[siteId];
  return override || st.shortKey || st.id;
}

/** 注册给 `llm.registerAdapter` 的 provider id —— **只有一个真路由**。 */
export function providerIdsForRegistration() {
  return [MODEL_PROVIDER_COMPAT_ID];
}

/**
 * 模型在**选择器组内**的显示名：`站点键/裸模型名`（`glm/GLM-5.3` / `z.ai/glm-5.3`）。
 *
 * ## 0.19.53：为什么从「裸模型名」改回带站点键
 *
 * 裸名（`GLM-5.3`）是 0.19.28 的产物——那时**每站点一个 provider = 一组**，
 * 组标题已经写明站点，行内再带一次确实是重复。
 *
 * 2026-10-02 合并成**唯一一组**后，组标题不再区分站点，而宿主模型行
 * **没有任何子组字段**（见 MODEL_PROVIDER_COMPAT_ID 的说明）。于是裸名会
 * 直接撞车：**glm 与 z.ai 都有 `glm-5.3`**，同组平铺下会出现两行逐字相同的
 * `GLM-5.3`，用户无法分辨、也无法选中想要的那一个。
 *
 * 所以行名退回带站点键的形态——这与 `modelDisplayName` 当初把站点键塞进名字
 * 里的**原因完全相同**（见其注释：分不清 glm-5.3 是 chatglm.cn 还是 z.ai），
 * 只是现在站点键用的是 `providerGroupName` 的口径（`glm` / `z.ai` / `chatglm`）。
 *
 * 注意这**只是显示名**：模型 id 仍是 `glm:glm-5.3`，别名表、历史设置值、
 * 会话游标、路由全部不动。
 */
export function modelGroupEntryName(m, siteId) {
  const bare = String(m?.name ?? m?.id ?? '');
  if (!siteId) return bare;
  return providerGroupName(siteId) + '/' + bare;
}

/**
 * 全站点模型目录（限定 id + 能力元数据）——DSH 模型选择器与
 * OpenAI /v1/models 共用这一份，保证两边模型列表一致。
 *
 * `accounts`（0.14.7，可选）：设置里的账户槽数组。传了就把每个启用槽展开成一组条目：
 *
 *   不传 / 传空             → 与 0.14.6 **逐字节相同**的输出（默认槽）
 *   [{siteId:'glm',slot:'2'}] → glm 的默认槽与 `glm@2` 各出一组
 *
 * **兼容性硬约束**：不传参数时，本函数必须与 0.14.6 的输出完全一致。
 * `test/model-labels.test.mjs` 与 `test/multi-site-decoder.test.mjs` 的既有断言
 * 就是这条约束的执行者——它们**不传参数**，因此任何默认槽形状的漂移都会立刻失败。
 */
export function listAllModels(accounts) {
  const out = [];
  const slotsBySite = new Map();
  for (const a of normalizeAccountsList(accounts)) {
    if (!slotsBySite.has(a.siteId)) slotsBySite.set(a.siteId, []);
    slotsBySite.get(a.siteId).push(a.slot);
  }
  for (const st of SITES) {
    // 默认槽永远在第一位：不传 accounts 时它就是唯一的一项，输出因此与 0.14.6 相同。
    const slots = [DEFAULT_SLOT, ...(slotsBySite.get(st.id) || [])];
    for (const slot of slots) {
      for (const m of st.models) {
        out.push({
          id: formatModelId(st.id, slot, m.id),
          siteId: st.id,
          slot,
          siteName: st.name,
          name: modelDisplayName(st, m, slot),
          labels: m.labels,
          context: m.context || null,
          budget: m.budget || m.context || null,
          thinking: m.thinking === true,
          vision: m.vision === true,
          // acceptsImages = 该模型的**网页端**能收下图片附件（与 vision 不同：
          // vision 是 DeepSeek 那种必须带图的独立「识图模式」；这里只是「可以
          // 带图发」，不带图也能正常用）。宿主据此声明 inputModalities。
          acceptsImages: m.acceptsImages === true,
          imageOut: m.imageOut === true,
          experimental: st.experimental === true,
        });
      }
    }
  }
  // 兼容别名条目：它指向默认槽（历史值语义），槽信息不参与。
  // 显示名刻意写死为「无槽后缀」——它与 `deepseek:deepseek` 同名是**过滤的前提**
  // （见 MODEL_ALIAS_IDS 注释），一旦带上槽后缀这个前提就没了。
  //
  // ⚠ 0.19.86 修缺陷：**别名条目漏了 `acceptsImages`**（本条原为 `vision: false` 起、
  //   **没有** `acceptsImages` 字段）。而 `deepseek-web` 是 `DEFAULT_MODEL_ID`
  //   （`providers.js:1024`），并且被**消费**：`web-control.js` 的
  //   `GET models`（`:968`）与 `GET context-windows`（`:999`）都原样返回
  //   `listAllModels()` 的条目 ⇒ 界面上这个 id 的 `acceptsImages` 是 `undefined`
  //   （= 假），而 `resolveWebModel('deepseek-web')` 解析到的**同一个模型**是 `true`
  //   ⇒ **同一个模型的两条路径给出相反答案**。
  //   修法：别名条目与真条目**同源取值**，不手写第二份（照抄 `DEEPSEEK.models[0]`
  //   的字段，包含 `acceptsImages`）。新增字段时不会再漏——两者从此同一处投影。
  //   护栏：`test/provider-surface.test.mjs` 的「别名与真条目字段同源」一条。
  const dsMain = DEEPSEEK.models[0];
  out.push({
    id: 'deepseek-web', siteId: 'deepseek', slot: DEFAULT_SLOT, siteName: DEEPSEEK.name,
    name: modelDisplayName(DEEPSEEK, dsMain), labels: [],
    context: dsMain.context || null, budget: dsMain.budget || dsMain.context || null,
    thinking: true, vision: false, imageOut: false,
    // 与真条目同源（0.19.86）：漏了这一格就是「别名说不能带图、真 id 说能带图」。
    acceptsImages: dsMain.acceptsImages === true,
    experimental: false,
  });
  return out;
}

/** 内部：只取合法的 `{ siteId, slot }` 对，非法条目静默丢弃（设置文件可手改）。 */
function normalizeAccountsList(accounts) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(accounts) ? accounts : []) {
    if (!entry || typeof entry !== 'object' || entry.enabled === false) continue;
    const siteId = String(entry.siteId ?? '').trim();
    if (!SITES.some((s) => s.id === siteId)) continue;
    const slot = normalizeSlot(entry.slot);
    if (!slot || slot === DEFAULT_SLOT) continue;   // 默认槽已无条件包含，不重复
    const key = siteId + '#' + slot;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ siteId, slot });
  }
  return out;
}

/** 兼容别名 → 'site:model' 限定 id。 */
const ALIASES = Object.freeze({
  // 历史 id / 兼容别名 → 唯一 DeepSeek 模型（升级后旧设置值仍可用）。
  'deepseek-web': 'deepseek:deepseek',
  'deepseek-reasoner': 'deepseek:deepseek',
  flash: 'deepseek:deepseek',
  vision: 'deepseek:deepseek',
  'gpt-4o': 'chatgpt:auto', chatgpt: 'chatgpt:auto',
  // ⚠ 0.19.43：glm / kimi / doubao / zai 四个站点的 auto 已从模型表里**真删**
  //（用户判据：网页给了真实档位，就不该再有一个桥自己发明的「不切换」档）。
  // 但历史值必须仍解析得开——真机 `~/.dsh/settings.yaml` 的
  // `subagent-model-selection.allowedModels` 里就写着 `glm:auto` / `kimi:auto` /
  // `doubao:auto`；只删模型表不改别名，这些白名单会当场变成不可解析值。
  // 因此下面的别名**同时**覆盖两种写法：裸站点名（`glm`）与已限定的历史 id
  //（`glm:auto`）。落点各自收敛到**本站点**的档位，绝不互相串站点。
  glm: 'glm:glm-5.3', 'glm:auto': 'glm:glm-5.3',
  'glm-4.5': 'glm:glm-5.3', 'glm-4.6': 'glm:glm-5.3',
  // GLM 版本别名（0.13.0 起 glm 站点有真实版本条目；旧设置值必须仍解析得开）
  'glm-5.3': 'glm:glm-5.3', 'glm-5.3-flash': 'glm:glm-5.3-flash',
  // 用户口头/历史写法（点号、连字符、大小写混用）统一收敛到 z.ai 的真实条目
  'z.ai-glm5.3': 'zai:glm-5.3', 'z.ai-glm5.3-flash': 'zai:glm-5.3-flash',
  'zai-glm-5.3': 'zai:glm-5.3', 'zai-glm-5.3-flash': 'zai:glm-5.3-flash',
  'glm-zai-5.3': 'zai:glm-5.3',
  kimi: 'kimi:k3', 'kimi:auto': 'kimi:k3', 'kimi-k3': 'kimi:k3', k3: 'kimi:k3',
  // K3 集群（2026-09-28 起从模型表真删，见 KIMI.models 注释）：历史值必须仍解析得开，
  // 收敛到同一站点的旗舰档 K3——留着它们指向一个不存在的 modelId 会让旧会话直接
  // 「不支持的网页模型」而断链（与 `glm:auto` 那条同一条纪律）。
  'k3-cluster': 'kimi:k3', 'kimi:k3-cluster': 'kimi:k3',
  'kimi-k2.8-preview': 'kimi:k2.8-preview', 'k2.8-preview': 'kimi:k2.8-preview',
  // qwen / doubao / grok / claude / gemini 的 auto **保持不动**：桥没有它们的
  // modelPicker 契约，切不动网页模型，auto 是那里唯一可用的条目（用户 2026-09-28：
  //「如果你不知道的话，就先空着不用改」）。doubao 是例外的一半：它有 segmented
  // 契约，模型表里的 auto 已真删，所以这里额外把历史 id 收敛到「对话」。
  qwen: 'qwen:auto', doubao: 'doubao:chat', 'doubao:auto': 'doubao:chat',
  grok: 'grok:auto', claude: 'claude:auto', gemini: 'gemini:auto',
  zai: 'zai:glm-5.3', 'zai:auto': 'zai:glm-5.3',
  'z-ai': 'zai:glm-5.3', 'chat.z.ai': 'zai:glm-5.3', 'glm-zai': 'zai:glm-5.3',
});

export const DEFAULT_MODEL_ID = 'deepseek-web';

function resolved(st, m, slot = DEFAULT_SLOT) {
  const s = normalizeSlot(slot) || DEFAULT_SLOT;
  return Object.freeze({
    site: st, siteId: st.id, siteName: st.name, origin: st.origin,
    // 账户槽（0.14.7）：默认槽恒为 DEFAULT_SLOT，调用方据此决定 profile 目录。
    slot: s, accountKey: s === DEFAULT_SLOT ? st.id : st.id + '#' + s,
    decoder: st.decoder, stream: st.stream !== false, experimental: Boolean(st.experimental),
    id: m.id, name: modelDisplayName(st, m, s), labels: m.labels,
    // 网页上的原始名字（不含站点短键）。model-picker 的兜底目标名用它——
    // 网页上从来不会写 `z.ai/glm-5.3`，拿显示名去比对必然 option-not-in-list。
    webName: m.name,
    thinking: m.thinking === true, vision: m.vision === true, imageOut: m.imageOut === true,
    acceptsImages: m.acceptsImages === true,
    // 展示口径（声明窗口）与预算口径（发送前预算闸 B-2 比对的数）字段级分开：
    // context = 站点声明 / 实测的窗口，展示给用户看的数；
    // budget  = 预算闸真正对比的数，无声明时回落 context（值一致，语义可选）。
    context: m.context ?? null,
    budget: m.budget ?? m.context ?? null,
  });
}

/**
 * 解析任意模型 id（裸 id / `site:model` / `site@slot:model` / 别名 / `{id}`）
 * → 站点 + 模型 + 账户槽。未知必须 throw。
 *
 * 0.14.7 的解析顺序刻意是**别名优先于槽解析**：
 *
 *   别名表里的值（`flash`、`glm-4.6`、`zai`…）全部指向**默认槽**——
 *   它们代表历史设置值，历史值是在「一个站点一份登录态」的年代写下的，
 *   指到默认槽才是它们的原意。所以先查别名，再解析 `@slot`。
 *   若顺序反过来，一个恰好含 `:` 的别名会被误当成槽限定 id。
 */
export function resolveWebModel(value = DEFAULT_MODEL_ID) {
  const id = typeof value === 'object' ? value?.id : value;
  const raw = String(id ?? '').trim();
  if (!raw) throw new Error('不支持的网页模型：' + id);
  const qualified = ALIASES[raw] || raw;
  // 限定形状：`site:model` 与 `site@slot:model` 都由 parseModelId 统一解析。
  //
  // **必须连同默认槽一起处理**（这是 0.14.7 首版的一个真 bug）：
  // `glm@1:glm-5.3` 里的 `1` 是默认槽的别名，parseModelId 会把它归一成
  // `slot: 'default'`；首版只处理「slot !== default」的分支，于是这个 id 掉进
  // 下面的 `split(':')` 兜底，被切成站点 `glm@1` → 查不到 → 抛「不支持的网页模型」。
  // 用户看到的是「填了账户1 反而报错」，而账户1 本该与默认槽完全等价。
  const withSlot = parseModelId(qualified);
  if (withSlot) {
    const st = SITES.find((s) => s.id === withSlot.siteId);
    const m = st?.models.find((m) => m.id === withSlot.modelId);
    if (st && m) return resolved(st, m, withSlot.slot);
    // ## 带槽的**兼容别名**（0.19.49 修的真 bug）
    //
    // `ALIASES` 的键是「站点:模型」形状（`'zai:auto'`、`'kimi:auto'`…），而上面那次查表
    // 发生在**槽解析之前**、用的是整串原文：原文是 `zai@work:auto` 时表里当然没有这个键，
    // 于是走到这里、`models.find(id === 'auto')` 也找不到（auto 已从模型表真删）⇒ 抛错。
    //
    // 真机症状：单账户用户写 `zai:auto` 正常（原文直接命中 ALIASES），
    // **一旦启用第二个账户**（id 变成 `zai@work:auto`）就报「不支持的网页模型」——
    // 而这两者本该等价。历史 settings 与 `subagent-model-selection.allowedModels` 里
    // 写的都是不带槽的形式，用户在面板上给模型挑一个账户后就撞上它。
    //
    // 修法：把「站点:模型」这一段单独再查一次别名表，命中后按**原本的槽**解析
    //（槽信息绝不能因为别名而丢失，否则「账户2」会静默写回默认槽的登录态）。
    const viaAlias = ALIASES[withSlot.siteId + ':' + withSlot.modelId];
    if (viaAlias) {
      const q2 = parseModelId(viaAlias);
      if (q2) {
        const st2 = SITES.find((s) => s.id === q2.siteId);
        const m2 = st2?.models.find((m) => m.id === q2.modelId);
        if (st2 && m2) return resolved(st2, m2, withSlot.slot);
      }
    }
    throw new Error('不支持的网页模型：' + id);
  }
  if (qualified.includes(':')) {
    const [sid, mid] = qualified.split(':', 2);
    const st = SITES.find((s) => s.id === sid);
    const m = st?.models.find((m) => m.id === mid);
    if (st && m) return resolved(st, m);
    throw new Error('不支持的网页模型：' + id);
  }
  // 裸 id：DeepSeek 的历史 id 保持原语义；其余要求全站点唯一
  const ds = DEEPSEEK.models.find((m) => m.id === raw);
  if (ds) return resolved(DEEPSEEK, ds);
  const hits = [];
  for (const st of SITES) for (const m of st.models) if (m.id === raw) hits.push([st, m]);
  if (hits.length === 1) return resolved(hits[0][0], hits[0][1]);
  throw new Error('不支持的网页模型：' + id);
}

/**
 * 按站点 id 取站点定义（模型目录、源站、静态域、契约）。
 *
 * 返回 `null` 而不是抛错或回落默认站点：调用方几乎都处在一个「用户给了个
 * 拼错的 siteId」的路径上，抛错会让整个面板 500，回落默认站点则会**静默操作
 * 另一个站点**（比报错危险得多）。所以这里如实说「没有这个站点」，让调用方
 * 决定是报错还是给默认值。
 *
 * @param {string} siteId 站点 id
 * @returns {object|null} 站点定义，未登记时为 null
 */
export function getSite(siteId) {
  return SITES.find((s) => s.id === siteId) ?? null;
}

/** 归一化模型 id：裸 id 补站点前缀（'glm-4.6' + 'glm' → 'glm:glm-4.6'），
 *  已限定或空值原样返回。executor / OpenAI 前端共用，保证路由唯一。
 *
 *  0.14.7：`glm@2:glm-5.3` 这类**已带槽**的限定 id 原样返回——它有 `:`，
 *  天然满足下面的短路条件；槽信息因此不会在这一层被剥掉。 */
export function qualifyModelId(model, siteId) {
  if (model === undefined || model === null) return model;
  const s = String(model);
  if (siteId && !s.includes(':')) return siteId + ':' + s;
  return s;
}
