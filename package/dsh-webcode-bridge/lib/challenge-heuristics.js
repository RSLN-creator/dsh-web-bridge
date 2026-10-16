// challenge-heuristics.js — 「页面自己说了什么」的**特征词判据**（纯函数，唯一一处定义）。
//
// ## 为什么单独成模块
//
// 风控/人机验证的文案指纹原先**内联在 `browser-driver.js` 的 `page.evaluate` 里**
// （发送后采样、导航期 `detectChallenge`、超时点归因三处各写一份近似词表）。
// 那样有三个代价：
//   ① **不可离线验证**——词表在页面上下文里，测试读不到，改错了没人知道；
//   ② **三处容易漂移**——同一个形态在 A 处认得出、在 B 处认不出（#63 的 doubao
//      图片选择式验证正是「导航期认不出 + 发送后不采样」两个缺口叠出来的）；
//   ③ 词表是**站点无关的自然语言事实**（「请完成下方验证」这类措辞是通用的），
//      而「哪个选择器属于哪个站点」是**站点知识**——后者必须收口在 `providers.js`，
//      前者放这里，两类事实不再混在一个函数体里。
//
// ## 本模块只做「归因」，不做「拦截」
//
// 命中只意味着「页面看起来在要人机验证」，**不**等于「一定需要人去过」。
// 因此调用方（driver）把它当**归因依据**（把「超时」说成「大概是验证」），
// 真正的**拦截判据**仍是站点声明位 `captchaSelector`（站点知识收口在 providers.js）。
// 这个区分是 #63 修复的立场：doubao 没有声明选择器，所以只靠声明会继续漏；
// 但也不能反过来用通用词表代替站点知识。
//
// ## 词表的依据（每条都有真机出处，不凭想象加）
//
//   · doubao 图片选择式（2026-10-14 真机截图，`doc/long-term-issues.md` #63 逐字）：
//     「常见于森林的生态元素 / **请选择所有符合**上文描述的图片，**并拖拽到下方**」；
//   · 阿里/滑块系（`#29`、z.ai 深链第二轮、GLM 深链第二轮）：**请按住滑块**、
//     **拖动滑块完成验证**、访问验证；
//   · 点选式（真机截图与探针记录）：**请依次点击**、**请点击下方图形**；
//   · 收束语：**完成验证后继续**、**请完成下方验证**。

/** 人机验证/风控的**可见文案**指纹。
 *
 * ⚠ **改动本词表前必须先读这里**：它是导航期 `detectChallenge`、超时点归因、
 *   以及 `looksLikeChallengeText` 三处**共用**的唯一一份。合并前原有两条清单，
 *   合并时逐条核对过——**不许在别处再写一份近似词表**（那正是 #63 的成因之一）。
 *
 * 逐条出处：
 *   · 图片选择式（doubao，2026-10-14 真机截图，#63 逐字）：
 *     「常见于森林的生态元素 / **请选择所有符合**上文描述的图片，**并拖拽到下方**」；
 *   · 点选式（真机截图与探针记录）：**请依次点击**、**请点击下方图形**、**请按顺序点击**；
 *   · 滑块式（z.ai 深链第二轮、GLM 深链第二轮、`#29`）：**请按住滑块**、
 *     **拖动到最右边**、**向右拖动滑块**、**拖动滑块完成验证**；
 *   · 通用验证页：**访问验证**、**请完成下方验证**、**完成验证后继续**；
 *   · 风控/限流文案（原先也在这一条正则里，合并时**原样保留**）：
 *     **操作过于频繁**、**系统繁忙，请稍后再试**、**访问受限**、**请求过于频繁**、**验证码错误**。
 */
export const CHALLENGE_BODY_PATTERN = /请选择所有符合|请选择符合|并拖拽到下方|请按顺序点击|请依次点击|请点击下方图形|请完成下方验证|请按住滑块|拖动到最右边|向右拖动滑块|拖动滑块完成验证|完成验证后继续|访问验证|操作过于频繁|系统繁忙，请稍后再试|访问受限|请求过于频繁|验证码错误/;

/**
 * 标题指纹（导航期 `detectChallenge` 用；与 body 指纹分开是因为两者证据强度不同：
 * 标题几乎不会误报，正文要防着正文里恰好引用了这些词）。
 *
 * 依据：2026-09-14 真机滑块页 title「滑动验证页面」；以及各站点的
 * 「访问验证 / 安全验证 / 人机验证」标题形态。
 */
export const CHALLENGE_TITLE_PATTERN = /滑动验证|访问验证|安全验证|验证页面|人机验证|人机身份验证|系统安全验证/;

/**
 * WAF / 验证码脚本或容器指纹（HTML 源码里出现即算；这些标识不会出现在正常正文中）。
 *
 * 依据：阿里云 WAF（`CF_APP_WAF` / `aliyun_waf` / `_waf_<hex>`）、腾讯（`TencentCaptcha`）、
 * 阿里 baxia（`baxia-punish` / `baxia-dialog`）、极验（`geetest`）、
 * 安全脚本（`sec_def_pc` / `sec_def_h5`）、Cloudflare Turnstile（`cf-turnstile`）。
 */
export const CHALLENGE_HTML_PATTERN = /CF_APP_WAF|aliyun_waf|_waf_[0-9a-f]+|baxia-punish|baxia-dialog|geetest|TencentCaptcha|sec_def_pc|sec_def_h5|cf-turnstile/;

/**
 * 「这段可见正文看起来是在要人机验证吗」——**纯函数**。
 *
 * @param {string} text 页面的可见正文（`document.body.innerText` 或标题）
 * @returns {boolean}
 */
export function looksLikeChallengeText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return CHALLENGE_BODY_PATTERN.test(s) || CHALLENGE_TITLE_PATTERN.test(s);
}

/**
 * 浏览器侧注入用的**模式源码**（`source` 而非字面量）。
 *
 * 与 `attach-scope.js` 的 `ATTACH_PICK_SRC` 同一条纪律：**判据只写一份**。
 * 驱动侧把这两个 `source` 当 `page.evaluate` 的**参数**传进去，在页面上下文里
 * `new RegExp(...)` 重建——于是浏览器里跑的就是本模块这一份词表，
 * 不存在「实现一份、测试判一份」的漂移面。
 *
 * ⚠ 这两个正则**不得加 `g` 或 `y` 标志**：`page.evaluate` 里同一对象会被多次
 *   `test()`，带 `g` 会因 `lastIndex` 递进而交替返回真假（本仓库记过同型缺陷）。
 *   本模块的两个模式都没有该标志，改动时必须保持。
 */
export const CHALLENGE_PATTERN_SOURCES = Object.freeze({
  body: CHALLENGE_BODY_PATTERN.source,
  title: CHALLENGE_TITLE_PATTERN.source,
  html: CHALLENGE_HTML_PATTERN.source,
});


