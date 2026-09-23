// image-pricing.js — webcode 路由的「请求图片计价」契约（LlmImageRequestPricing）。
//
// ## 这个文件为什么存在：一个每次都炸的必现故障
//
// DSH 的 LLM 运行时用**可选链取方法再接调用**：
//
//     imageRequestPricing(provider, model) {
//       return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
//     }                                                   // dsh-llm/lib/index.js:1964
//
// `?.` 只护住 `adapters.get(provider)` 与 `.adapter` 两个**取值**，护不住
// `.imageRequestPricing` 这个方法本身。桥注册的 adapter 是对象字面量
// （lib/index.js 的 `const adapter = { … }`），在本模块出现之前没有实现它——
// 于是 `adapter` 存在、`adapter.imageRequestPricing` 是 undefined，调用即抛
// `TypeError: this.adapters.get(...)?.adapter.imageRequestPricing is not a function`。
//
// 谁会走到那一行：token meter 的 `_routeImagePricing`
// （dsh-token-meter/lib/index.js:689 → `ctx.get('llm')?.imageRequestPricing(provider, model)`），
// 而它被 `measure()` 每次测量都调（:644）。手动 `/compact` 的入口是
// `dsh-compaction-basic`，它拿的就是 `ctx.tokenMeter.measure(...)`——
// 所以「压缩功能在 webcode 上做不到」是**误判**：压缩实现与装配都在，是桥缺一个
// 契约方法，让整条测量路径在第一步就抛错。补上这个方法，压缩路径即恢复。
//
// ## 为什么不是「返回 undefined 交差」
//
// `LlmAdapter.imageRequestPricing` 的文档允许返回 undefined，调用方会回落到自己的
// 中性启发式（dsh-llm/lib/types/index.d.ts:150）。但那个启发式对图片只是
// 「引用 JSON 的字符数」（dsh-token-meter/lib/types/estimate.js:22-28，注释明写
// 「image references … request price is route-owned rather than fixed」）——
// 它数的是 `{attachment, offloaded}` 这个对象的 JSON 长度，不是任何视觉计价。
// 也就是说：返回 undefined 只是让表不乱跳，图片在压力读数里仍然等于「一小段 JSON」。
//
// 因此这里给出**真计价**：逐出现位置回答 DSH 实际送进模型的那段文字，
// `visualTokens` 恒为 0（webcode 的各站点没有公开任何视觉 token 计量规则，
// 桥不编造一个数出来）。调用方收到后按自己的文本估算器计价
// （dsh-token-meter/lib/index.js:566-573：`price.visualTokens + estimateContent([{text}])`），
// 于是「图片被换成的那句话」第一次真的进了压力读数。
//
// ## 三条占位文本与 DSH 逐字同源，但不 import
//
// 三条文案的唯一真相在 DSH 自己：
//
//   · `textOnlyImageText(ref)`        —— 文本路由下图片被换成的那句（dsh-llm/lib/index.js:556）
//   · `offloadedImageText(ref, access)` —— image/offload 决策省略图片后的那句（:579）
//   · `requestImageHandleText(ref, version, access)` —— 带图路由上「图片 + 身份文本」（:569）
//
// 这里**复刻**而不是 import，理由是可验证的：桥的 profile 里没有 `@deepseek-ai/dsh-llm`
// （`~/.dsh/profiles/web/node_modules/@deepseek-ai/` 下没有这个包，本机 2026-09-23 核对），
// 而 `imageRequestPricing` 契约要求**同步、无 I/O**返回（types/index.d.ts:142-148），
// 动态 import 用不了。复刻的漂移风险由 `test/image-pricing.test.mjs` 兜住：那个测试
// 直接从 DSH 安装目录 import 三个真函数，对同一批合成 ref 做逐字比对，任一文案改动即变红。
// 这就是本仓库的「单一真相 + 护栏」：不是两份真相，是一份真相加一道机器闸门。
//
// ## 已知边界（不要当成精确计价）
//
// · `access` 参数（图片可读路径）解析需要 attachment 服务，本契约在计量阶段拿不到，
//   因此三条文案都走 **无 access** 分支（DSH 对应的 `access === undefined` 分支）。
//   只有带 access 时才会多出的那句 `Normalized copy (read-only; …)` 不计入。
// · 带图路由的保留图片，DSH 送的是**请求投影后**的尺寸（`version`），这里只有源尺寸，
//   所以文案里的 `request preview WxH` 用的是源尺寸——同量级、非逐字相同的近似。
//   方向明确：宁可少算，不编造视觉 token。

/**
 * 文本路由下图片被替换成的占位句（与 DSH `textOnlyImageText` 逐字同源）。
 *
 * 为什么单独导出：护栏要拿它跟 DSH 的真函数逐字比对，写死在这里的文案必须可被断言。
 * @param ref - 图片块的 durable 附件引用（`{ attachmentId, name?, … }`）。
 * @returns 送进模型的确定性占位文本。
 */
export function textOnlyImagePlaceholder(ref) {
  return `[image omitted because this model accepts text only; attachment sha256:${String(ref?.attachmentId).slice(7, 15)}]`;
}

/**
 * 图片身份在文案里的写法（与 DSH 私有 `imageIdentity` 逐字同源）。
 * @param ref - 图片块的 durable 附件引用。
 * @returns 有名字时是 `"名字" (attachmentId)`，否则是裸 attachmentId。
 */
function imageIdentity(ref) {
  return ref?.name === undefined ? String(ref?.attachmentId) : `${JSON.stringify(ref.name)} (${ref.attachmentId})`;
}

/**
 * 被 image/offload 省略的图片的占位句（与 DSH `offloadedImageText` 无 access 分支逐字同源）。
 * @param ref - 被省略的图片块的 durable 附件引用。
 * @returns 送进模型的确定性占位文本。
 */
export function offloadedImagePlaceholder(ref) {
  return `[image omitted to fit request image limits; ${imageIdentity(ref)}. No local normalized image path is available; ask the user to attach it again if needed.]`;
}

/**
 * 带图路由上保留图片的身份文本（与 DSH `requestImageHandleText` 无 access 分支同形）。
 *
 * 尺寸口径见文件头「已知边界」：`version` 在计量阶段不可得，这里用 ref 自带的源尺寸。
 * @param ref - 保留图片块的 durable 附件引用。
 * @returns 送进模型的图片身份文本。
 */
export function retainedImagePlaceholder(ref) {
  return `Image ${imageIdentity(ref)}; request preview ${ref?.width}x${ref?.height}px. It may be resized or re-encoded; source dimensions, format, and byte size may differ.`;
}

/**
 * 构造 webcode 路由的 `LlmImageRequestPricing`（同步、无 I/O，逐出现位置对齐）。
 *
 * 契约的三条硬约束（违反了就会在计量路径上制造新故障，所以这里全部防御性处理）：
 *   ① 返回的 `priceImages` **不许抛**——它每次测量都被调，抛一次就等于整条测量链断；
 *   ② 返回的数组长度**必须等于**入参数组长度，否则调用方主动抛
 *      `route image pricing answered N prices for M occurrences`（dsh-token-meter/lib/index.js:551），
 *      这个抛错是刻意的（错位会静默错计价），所以本函数严格 `map`，一个不多一个不少；
 *   ③ 必须**同步**返回对象（不是 Promise）。
 *
 * @param options - `acceptsImages` 为该路由的网页端是否真能收下图片附件（providers.js 的
 *   `acceptsImages`，与 DSH 的 `inputModalities` 同源判定）。
 * @returns 实现了 `priceImages(images)` 的计价对象。
 */
export function webcodeImageRequestPricing({ acceptsImages = false } = {}) {
  return {
    priceImages(images) {
      if (!Array.isArray(images)) return [];
      return images.map((block) => ({
        visualTokens: 0,
        text: block?.offloaded === true
          ? offloadedImagePlaceholder(block?.attachment)
          : acceptsImages === true
            ? retainedImagePlaceholder(block?.attachment)
            : textOnlyImagePlaceholder(block?.attachment),
      }));
    },
  };
}
