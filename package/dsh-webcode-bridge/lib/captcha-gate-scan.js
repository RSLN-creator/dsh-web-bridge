// captcha-gate-scan.js — 人机验证「跨 frame 扫描」的**纯判定层**（0.19.87 抽出）。
//
// ## 为什么必须抽出来（#75 的直接教训）
//
// 0.19.83 给「doubao 图片式验证」加了逐 frame 扫描，但它写在 `runTurn` 的
// 超时回调里、依赖真实的 `page`，**离线驱动不了** ⇒ 当时只能写**源码级**护栏
// （`test/captcha-gate.test.mjs` ④b：`assert.match(seg, /page\.frames\?\.\(\)/)`)。
// 而源码级护栏**只证明「字符串在场」，不证明「那段代码跑得起来」**——
// 于是 #75（`evaluate` 传 4 个实参 → Playwright 同步抛 → 被 `.catch` 吞）全程没被发现：
// **护栏全绿，而那段判据从未运行**。
//
// 这正是 `attach-scope.js` 头注记过的同一形状（「护栏逃逸」/「判据是装饰品」），
// 该模块的解法是把判定抽成**纯函数**再用小适配器直接驱动。
// 本模块照抄那个解法：把「给定一组 frame，逐个查、命中即停、没命中就汇总 probe」
// 的**编排逻辑**抽到这里，让它能被**假 frame** 离线驱动。
//
// ## 分工（谁负责什么）
//
//   · 本模块：**编排**（遍历顺序、命中即停、probe 汇总、frameError 如实记录）；
//   · 浏览器侧：真正的 DOM 读取（`challenge-heuristics.js` 的词表 + 站点 `captchaSelector`），
//     以**单对象实参**注入（⚠ `evaluate` 只接受一个 arg —— #75 的根因）。
//
// ⚠ **本模块不自己读 DOM**：页面侧判据的唯一真源仍是 `challenge-heuristics.js`。

/**
 * 逐 frame 扫描「页面是否在要人机验证」。
 *
 * @param {Array} frames frame 列表（真实调用传 `page.frames()`；测试传假 frame）
 * @param {(frame:any)=>Promise<object|null>} probeFrame
 *   单 frame 探测函数：返回 `{ basis, head, probe }`（命中）或 `{ basis:null, probe }`（未命中），
 *   抛错由本函数如实记为 `frameError`。
 * @param {(frame:any)=>string} [urlOf] 取 frame 地址（默认 `f.url?.() || ''`），用于读数与归因
 * @returns {{basis:string|null, head?:string, frameUrl?:string, probe?:object}}
 *   命中 ⇒ 命中信息 + `frameUrl`；未命中 ⇒ `{ basis:null, probe:{ frames:[…] } }`
 */
export async function scanFramesForChallenge(frames, probeFrame, urlOf = (f) => String(f?.url?.() || '')) {
  const probes = [];
  let hit = null;
  for (const f of frames || []) {
    let r = null;
    try {
      r = await probeFrame(f);
    } catch (e) {
      // ⚠ 抛错**如实记**，不静默跳过：跨域 frame 的 evaluate 会抛，
      //   把它记成 `frameError` 才能在下一次排障时分清「这个 frame 查不了」
      //   与「这个 frame 查了、没有验证码」。静默吞掉就是把两种现场印成同一件事。
      r = { basis: null, frameError: String(e?.message || e).slice(0, 80) };
    }
    probes.push({ url: String(urlOf(f)).slice(0, 120), ...(r || {}) });
    if (r && r.basis) { hit = { ...r, frameUrl: String(urlOf(f)).slice(0, 160) }; break; }
  }
  return hit || { basis: null, probe: { frames: probes } };
}
