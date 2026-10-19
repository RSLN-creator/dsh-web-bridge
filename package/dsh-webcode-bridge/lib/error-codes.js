/**
 * 错误码真源：让本插件抛出的错误码**活着穿过 harness 边界**。
 *
 * ## 为什么需要这个模块（真实缺陷，2026-10-02）
 *
 * DSH 的 `HarnessError.code` 是**唯一**的机器路由判据
 *（`dsh-llm/lib/types/error.d.ts:13` 逐字：*route on this, never by parsing
 * `message`*），而它的归一化**只认自己那一份类身份**：
 *
 * ```js
 * // dsh-llm/lib/types/adapter-failure.js:104-107
 * function harnessErrorCode(error) {
 *     return error instanceof HarnessError ? error.code : 'UNKNOWN';
 * }
 * ```
 *
 * 本插件此前给普通 `Error` 挂 `.code`（24 处），于是**全部退化成 `UNKNOWN`**。
 * 284 份真实会话全量实测：归因本插件的 137 条 error finishes
 * **137/137 全是 `UNKNOWN`**，而官方 provider 丢码 **0** 条。
 *
 * 后果是官方的两个自动修复动作**对本插件从未生效，且不报错**：
 *
 * 1. **自动重试**（`dsh-llm-retry`）：`DEFAULT_RETRYABLE_CODES` 里没有任何一个
 *    本插件的码 ⇒ `retryableCodes.includes(failure.code)` 恒为假 ⇒ 直接放弃。
 * 2. **超限自动压缩修复**（`dsh-compaction-basic:862`）：判据是
 *    `failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE`。本插件 `lib/index.js`
 *    确实设了这个码，但到那里已经变成 `UNKNOWN` ⇒ 不匹配 ⇒ 不压缩。
 *
 * 完整机制、官方对位与证据见
 * `doc/research/2026-10-02-dsh-official-error-and-repair.md` §6。
 * 基线可复现：`node scripts/scan-error-codes.mjs`（本插件存活率 0.0%）。
 *
 * ## 为什么用「自洽 `failure` 快照」而不是 `new LlmError(...)`
 *
 * 官方推荐抛 `LlmError`，但本插件**不能**静态 import `@deepseek-ai/dsh-llm`：
 *
 * - **解析不到**：它只存在于 profile / 宿主安装目录，不在本仓库工作区
 *   （实测 `import('@deepseek-ai/dsh-llm')` 在 `package/dsh-webcode-bridge/`
 *   下 `ERR_MODULE_NOT_FOUND`）。静态 import 会让**全部 120 个测试文件**
 *   连带加载失败。
 * - **类身份跨副本不成立**：桌面版把宿主打进 `app.asar`，插件解析到的
 *   `dsh-llm` 与宿主内部那一份**可能不是同一个模块实例** ⇒ 即便抛真
 *   `LlmError`，宿主侧 `instanceof HarnessError` 仍可能为假。
 *
 * 官方实现**自己就是为这件事留了口子**（`adapter-failure.js:17-21` 逐字注释
 * *Cross-package copies preserve own data but not class identity*）：只要抛出的
 * 对象自带一个**合法且与自身 `code` 一致**的 `failure` 快照，就采信它：
 *
 * ```js
 * const carried = ownFailureSnapshot(error);
 * if (carried !== undefined && carried.code === ownErrorCode(error)) return carried;
 * ```
 *
 * ⇒ 这条路**零新依赖、同步可用、且在 asar 跨副本下比 `LlmError` 更稳**。
 * 已实测：普通 `Error` + 自洽快照 ⇒ `code` 保留；两者不一致 ⇒ 仍退化成
 * `UNKNOWN`（故本模块把一致性做成构造函数的硬约束）。
 *
 * ## 与 `RATE_LIMITED` 等自定码的关系（**不要为了「进重试集」乱映射**）
 *
 * 修好异常类型之后，官方默认策略只重试
 * `[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`。本插件的自定码
 * **一个都不在其中**——这是**刻意保留**的，不是遗漏：
 *
 * - `RATE_LIMITED`：官方退避是 `500ms` 起指数退避，而本站点限流滑窗以**十秒**计
 *   （见 `lib/index.js` 的 `rateLimitBackoffMinMs` 注释）。改名成官方的
 *   `RATE_LIMIT` 会让官方用 500ms 重试——**每次重试都是一次真实的浏览器投递**，
 *   代价远高于 HTTP 重试。故保留自定名 + 本插件自己的 10s 下限退避。
 * - `NEED_LOGIN`：映射到 `AUTH` 会让 UI 显示「API 密钥无效」，而用户真正要做的是
 *   「打开网页登录一次」——**误导方向**（官方 UI 只对 `AUTH` 做特殊文案替换）。
 * - `MODEL_UI_CHANGED`：语义是「网页改版」，不是「请求非法」，故不映射到
 *   `INVALID_REQUEST`。
 *
 * **唯一对齐的是**：`CONTEXT_WINDOW_EXCEEDED`（官方同名，修好后自动压缩即生效）
 * 与 `EMPTY_RESPONSE`（官方专为空回复定义，且其文档明示「没有产出任何耐久内容，
 * 重试安全」）。详见 {@link WEBCODE_CODES}。
 *
 * @module error-codes
 */

/**
 * 本插件**全部**错误码的登记表（单一真源）。
 *
 * ## 为什么要有这张表
 *
 * 一是让「本插件到底会抛哪些码」**可机检**：`test/error-codes.test.mjs` 会断言
 * 抛出的码都在表里，避免新增抛点忘了登记。
 * 二是把「哪些码刻意**不**对齐官方」的理由钉在这里——否则下一个人看到
 * `RATE_LIMITED` 与官方 `RATE_LIMIT` 只差一个字母，很容易「顺手改成一致的」
 * 而引入一次行为变更。
 *
 * `official` 字段的含义是「与官方 `dsh-llm` 词汇表同名同义」，
 * 不是「必须改成官方名」。
 *
 * @type {Readonly<Record<string, {official: boolean, note: string}>>}
 */
export const WEBCODE_CODES = Object.freeze({
  // ---- 与官方词汇表对齐的两个（修好异常类型后即被官方机制接住）----
  CONTEXT_WINDOW_EXCEEDED: {
    official: true,
    note: '官方同名。修好后 `compaction-basic` 的超限自动压缩修复即生效（此前是死的）。',
  },
  EMPTY_RESPONSE: {
    official: true,
    note: '官方专为空回复定义（error.d.ts:23-32），且明示「没有产出任何耐久内容，重试安全」。'
      + '本插件此前抛裸 Error 无码 ⇒ 这一轮直接判死；现在会走官方退避重试。'
      + '抛点两处：lib/index.js 的 assertNonEmpty、lib/zero-progress.js 的 emptyWebResponseError。',
  },

  // ---- 刻意保留自定名的（理由见模块头，别顺手改）----
  RATE_LIMITED: {
    official: false,
    note: '刻意不叫官方的 `RATE_LIMIT`：官方退避 500ms 起，而本站限流滑窗以十秒计，'
      + '改过去会让每次重试都变成一次真实浏览器投递。保留本插件自己的 10s 下限退避。',
  },
  NEED_LOGIN: {
    official: false,
    note: '刻意不映射到 `AUTH`：官方 UI 会把 `AUTH` 替换成「API 密钥无效」，'
      + '而这里该做的是「打开网页登录一次」——映射会把人引向错误的排查方向。',
  },
  MODEL_UI_CHANGED: {
    official: false,
    note: '刻意不映射到 `INVALID_REQUEST`：语义是「网页改版」，不是「请求非法」。',
  },

  // ---- 驱动/页面契约族 ----
  WEB_SESSION_LOST: { official: false, note: '网页会话已删/过期/被风控拦：前文确实没了，需整段重建。' },
  WEB_NO_PROGRESS: { official: false, note: '网页侧长时间无任何新内容（看门狗）。语义接近 `TIMEOUT`，但重试代价是一次完整投递，故不并入官方重试集。' },
  WEB_CAPTCHA_REQUIRED: { official: false, note: '站点风控闸门：验证通过前不发请求，需人工过滑块。' },
  WEB_UI_OVERLAY_BLOCKED: { official: false, note: '页面级 UI 遮罩（产品导览 driver-overlay / 地区弹窗 _modal-overlay）盖住发送目标：点击不会命中，需人工关闭或折叠后重试。' },
  SEND_NOT_CONFIRMED: { official: false, note: '点了发送但网页未确认收到。' },
  SEARCH_TOGGLE_UNCONFIRMED: { official: false, note: '已点击联网搜索开关但回读 aria-pressed 未确认（不重试：重试=再点一次网页控件）；用户选了 on、网页却没开，必须让他知道，不许静默当成功。' },

  SITE_MODE_UNAVAILABLE: { official: false, note: '任务模式（GLM 工具选择器）点击/回读未确认：网页可能改版或条目不可用。不重试（重试=再点一次网页控件）；本轮不假装模式已生效。' },  PROMPT_TRUNCATED: { official: false, note: '网页输入框只接收了部分字符（回读校验）。本插件自己有一次性压缩重试。' },
  PROMPT_WRITE_STALLED: { official: false, note: '写入输入框后长度不再增长（分块写入卡死）。' },
  DRIVER_BUSY: { official: false, note: '同一驱动正在跑另一轮。' },
  BRIDGE_ACCOUNT_BUSY: { official: false, note: '同一账号的跨进程单实例锁被占。' },
  MODEL_UNAVAILABLE: { official: false, note: '所选模型在当前页面不可用。' },
  VISION_REQUIRES_IMAGE: { official: false, note: '识图轮没有任何可用图片。' },
  STREAM_REWRITE: { official: false, note: '网页重写了已经输出过的内容（协议护栏）。' },
  TOOL_PROTOCOL_INVALID: { official: false, note: '工具参数不完整或调用顺序不一致。' },

  // ---- 附件族 ----
  ATTACH_UNAVAILABLE: { official: false, note: '页面没有可用的文件上传入口。' },
  ATTACH_NOT_CONFIRMED: { official: false, note: '已选文件但页面上没出现附件。' },

  // ---- 其他内部族（一般不会作为模型轮失败冒到 harness）----
  THINK_EFFORT_UNKNOWN: { official: false, note: '无法识别网页的思考档位控件。' },
  COOKIE_IMPORT_UNDECRYPTABLE: { official: false, note: '导入的浏览器 cookie 解不开。' },
  ZSTD_UNSUPPORTED: { official: false, note: '当前 Node 不支持 zstd（会话日志解码用）。' },
  ENCODING_UNSUPPORTED: { official: false, note: '不支持的响应编码。' },
  SSRF_REDIRECT_BLOCKED: { official: false, note: '重定向指向了内网/环回地址，已拦截。' },
});

/**
 * 本插件的 `providerRetryPolicy` 返回值（**显式声明，不继承官方 HTTP 默认**）。
 *
 * ## 为什么必须显式声明，而不是 `return undefined`
 *
 * `return undefined` 会让宿主用官方默认（`dsh-llm/lib/index.js:1867`）：
 * `maxRetries: 5`、`initialDelayMs: 500`。那套常数是为 **HTTP 请求**调的——
 * 重试一次只是再发一个包。而本插件**重试一次 = 再驱动一次浏览器、再等网页吐一轮**
 * （实测单轮几十秒到 240s 量级）。照搬 5 次 / 500ms 会变成「一个空回复换来 5 次
 * 真实网页投递」。
 *
 * 官方把 `providerRetryPolicy` 留给 provider，正是为了让这种差异能被表达出来。
 *
 * ## 取值理由
 *
 * | 字段 | 值 | 为什么 |
 * | --- | --- | --- |
 * | `mode` | `normal` | 不用 `always`：那是「无限重试直到成功」，对浏览器驱动等于死循环。 |
 * | `maxRetries` | `1` | 一次重试是合理的赌注（空回复常是页面瞬时状态），5 次不是。 |
 * | `initialDelayMs` | `2000` | 官方默认 500ms 对「让页面缓一下」太短。 |
 * | `maxDelayMs` | `10000` | 与本站点限流退避的 10s 下限同量级，保持等待语义一致。 |
 * | `retryableCodes` | 官方默认集 | 见下「为什么原样保留官方集合」。 |
 *
 * ## ⚠⚠ 为什么 `retryableCodes` **原样**保留官方集合、绝不加 `CONTEXT_WINDOW_EXCEEDED`
 *
 * 这是一处**会静默毁掉官方修复**的陷阱，写在这里免得下一个人「顺手加进去」：
 *
 * `dsh-base/cordis.patch.yml` 里 **`llm-retry`（:91）注册在 `compaction-basic`（:341）
 * 之前**，而 cordis 的 waterfall 按注册顺序调用 ⇒ **`llm-retry` 先拿到 `agent/request-error`**。
 * 它一旦发现 `retryableCodes.includes(failure.code)` 为真，就**直接重试并结束瀑布**
 * （`dsh-llm-retry/lib/index.js:160` 之后不再 `next()`）——`compaction-basic` 的
 * 订阅者**根本不会被调用**。
 *
 * 所以若把 `CONTEXT_WINDOW_EXCEEDED` 放进 `retryableCodes`：
 * 超限的请求会被**原样重发** `maxRetries` 次（每次都是一次注定失败的浏览器投递），
 * 而**官方那套「压缩上下文后重试」永远不会跑**。
 * 官方默认集里没有它，正是这个道理——**保持原样**。
 *
 * 同理，`RATE_LIMITED` 等自定码也不加入：它们不在官方集里，且本插件有自己的退避。
 *
 * @type {Readonly<{mode: 'normal', maxRetries: number, retryableCodes: readonly string[], initialDelayMs: number, maxDelayMs: number, jitterRatio: number}>}
 */
export const WEBCODE_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 1,
  // 官方 `DEFAULT_RETRYABLE_CODES`（retry-policy.js:16-22）逐字复制。
  // 本插件目前只有 `EMPTY_RESPONSE` 落在其中（其余四个是 HTTP 语义的码，我们不抛）；
  // 保留全集是为了「将来若真抛出这些码，行为与官方一致」，且它是**唯一**被验证过的
  // 安全集合（`CONTEXT_WINDOW_EXCEEDED` 的危险见上文）。
  retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
  initialDelayMs: 2000,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
});

/**
 * 造一个**错误码能活着穿过 harness 边界**的 `Error`。
 *
 * ## 关键约束（改这里之前先读）
 *
 * 官方 `normalizeLlmFailure` 采信快照的前提是**两个 own 属性一致**：
 * `error.failure.code === error.code`。任一处不一致就整体退化成 `UNKNOWN`
 * （已实测）。因此本函数把「同时写 `code` 与 `failure`、且两者同源」做成
 * **不可分割的一步**——调用方不再有机会只改一半。
 *
 * `failure` 被 `Object.freeze`：官方读的是 own **data** 属性
 * （`Object.getOwnPropertyDescriptor`，`'value' in descriptor`），
 * 冻结不影响读取，但能防止后续有人往快照里塞不可序列化的东西。
 *
 * @param {string} message 人读的失败摘要（非空）。
 * @param {string} code 稳定的机器码，应当是 {@link WEBCODE_CODES} 的键。
 * @param {Record<string, unknown>} [extra] 额外挂到 Error 上的现场字段
 *   （如 `scene` / `attachDiag` / `accepted`）。**不参与** `failure` 快照——
 *   官方只读 `message` / `code` / `status` / `providerRetryAfterMs` /
 *   `requestId` / `offloadImages` 六个字段，多塞的会被它丢掉。
 * @returns {Error & {code: string, failure: Readonly<{message: string, code: string}>}}
 */
export function webcodeError(message, code, extra) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError('webcodeError: code 必须是非空字符串');
  }
  const err = new Error(String(message));
  // 顺序无关，但**必须成对**：官方要求 failure.code === error.code。
  err.code = code;
  err.failure = Object.freeze({ message: err.message, code });
  if (extra !== undefined && extra !== null) Object.assign(err, extra);
  return err;
}

/**
 * 给一个**已经造好**的 `Error` 补上可存活的错误码。
 *
 * ## 为什么还要这个（而不是全用 {@link webcodeError}）
 *
 * 仓库里有一批抛点是「先 `new Error(...)` 拿到对象、中途还要挂现场、
 * 最后才决定码」的形状（如 `browser-driver.js` 的附件族：错误对象在
 * 超时分支外先建好）。把那些整体改写成构造器调用会动到控制流；
 * 本函数只做**同一个不可分割的赋值对**，语义与构造器完全一致。
 *
 * ⚠ **不要**在别处手写 `err.code = 'X'`：那样不会带 `failure` 快照，
 * 码会在 harness 边界被丢掉（这正是本次要修的缺陷）。
 *
 * @template {Error} T
 * @param {T} err 目标错误（会被就地修改并返回）。
 * @param {string} code 稳定的机器码。
 * @returns {T & {code: string, failure: Readonly<{message: string, code: string}>}} 同一个对象。
 */
export function withWebcodeCode(err, code) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new TypeError('withWebcodeCode: code 必须是非空字符串');
  }
  if (!(err instanceof Error)) {
    throw new TypeError('withWebcodeCode: 第一个参数必须是 Error');
  }
  err.code = code;
  err.failure = Object.freeze({ message: err.message, code });
  return err;
}
